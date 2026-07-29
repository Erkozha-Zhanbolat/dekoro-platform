-- DEKORO Platform V2 — Staff Platform
-- Migration: manual order creation + item/reservation management for staff
--
-- Depends on:
--   001_companies_and_profiles.sql (public.user_role, public.profiles, public.companies)
--   002_catalog_inventory_pricing.sql (public.products, public.warehouses,
--     public.inventory, public.categories, public.price_groups,
--     public.product_prices, public.company_product_prices)
--   005_orders.sql (public.orders, public.order_items)
--   008_reserve_inventory_on_order.sql (public.inventory_reservations)
--   010_staff_role_access.sql (public.get_my_role(), public.has_staff_role())
--
-- Run this file once in the Supabase SQL Editor after 010
-- (see supabase/README.md). NOT applied by this change — apply by hand
-- when ready.
--
-- Purpose: let manager/admin manually create an order for an EXISTING,
-- already-registered client and manage its line items (add / change
-- quantity / remove) with the same inventory-reservation guarantees
-- create_order() already provides to the client checkout — without
-- touching create_order()/cancel_order() or opening any direct
-- staff SELECT/INSERT/UPDATE/DELETE access to inventory, orders,
-- order_items, profiles or companies. Every read of those tables for
-- staff, and every write, goes through a SECURITY DEFINER RPC below.
--
-- Explicitly NOT done here (future steps, see chat for the full list):
--   - creating a brand-new client from the staff UI;
--   - editing a client's profile/company;
--   - manager-controlled price override on a line item;
--   - order_status changes beyond what already exists ('new' only here);
--   - order confirmation, payment, invoicing, picking, shipping;
--   - stock receiving/write-off, warehouse transfer, Excel import;
--   - any service_role usage;
--   - any new RLS SELECT/INSERT/UPDATE/DELETE policy for staff on
--     inventory / inventory_reservations / profiles / companies / orders /
--     order_items — staff access to all of those stays RPC-only.
--
-- No service_role. RLS stays enabled everywhere; no new table grant or
-- policy is added for authenticated in this migration — every new
-- capability is exposed exclusively through EXECUTE on the functions
-- below, each of which re-checks the caller's role internally via
-- public.has_staff_role().
--
-- --- Revision: security & consistency review (post-authoring pass) ------
-- This file was revised after an additional review, before ever being
-- applied, to fix: (1) staff_update_order_item_quantity() and the
-- "already on the order" branch of staff_add_order_item() re-resolving
-- price instead of reusing the existing order_items.unit_price snapshot;
-- (2) the reservation ON CONFLICT unconditionally summing quantity even
-- when reactivating a previously-released reservation; (3) missing
-- explicit reservation/order_item consistency checks before
-- update/remove; (4) EXECUTE privileges not being revoked from every role
-- explicitly (relying on the absence of a grant instead); (5)
-- staff_search_clients() falling back to "list every client" for an
-- empty/short query; (6) staff_search_products() being able to return a
-- negative available_quantity without raising; (7)
-- staff_resolve_warehouse_id() using a bare LIMIT 1 instead of asserting
-- uniqueness; (8) a missing integer-overflow guard on quantity summation
-- (create_order() already has this). See each section below for details.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.companies') is null then
    raise exception
      'public.profiles / public.companies missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if to_regclass('public.products') is null
     or to_regclass('public.warehouses') is null
     or to_regclass('public.inventory') is null
     or to_regclass('public.categories') is null
     or to_regclass('public.price_groups') is null
     or to_regclass('public.product_prices') is null
     or to_regclass('public.company_product_prices') is null
  then
    raise exception
      'Catalog/inventory/pricing tables missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run supabase/migrations/005_orders.sql first.';
  end if;

  if to_regclass('public.inventory_reservations') is null then
    raise exception
      'public.inventory_reservations is missing — run supabase/migrations/008_reserve_inventory_on_order.sql first.';
  end if;

  if to_regprocedure('public.get_my_role()') is null
     or to_regprocedure('public.has_staff_role(public.user_role[])') is null
  then
    raise exception
      'public.get_my_role() / public.has_staff_role(...) missing — run supabase/migrations/010_staff_role_access.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Internal helpers (not part of the staff-facing RPC surface)
--
-- These are never granted EXECUTE to public/anon/authenticated — every one
-- of the 5 helpers below ends with an explicit
-- `revoke all ... from public, anon, authenticated`, never relying on the
-- absence of a GRANT (PostgreSQL grants EXECUTE to PUBLIC by default on
-- newly created functions, so an explicit REVOKE is required, not
-- optional). They are only ever invoked from inside the SECURITY DEFINER
-- functions below, which call them while already running as the
-- functions' owner — an object owner always retains implicit EXECUTE on
-- objects it owns, regardless of REVOKE, so no grant is needed for these
-- to work from that context. They exist purely to avoid duplicating logic
-- across the 6 public RPCs below.
-- ============================================================

-- --- 1a. Resolve the single current warehouse (mirrors create_order()) ---
--
-- DEKORO currently operates a single physical warehouse, resolved by its
-- known code exactly like create_order() (008_reserve_inventory_on_order.sql)
-- does. If it's missing/inactive, that's an operational/config problem to
-- fix in the warehouses table, not something to silently work around here.
--
-- Uses SELECT ... INTO STRICT (not a bare LIMIT 1): warehouses.code already
-- carries a UNIQUE constraint (002_catalog_inventory_pricing.sql), so more
-- than one active row for 'ALMATY-01' should be impossible — but this
-- function asserts that instead of assuming it. STRICT makes Postgres
-- raise NO_DATA_FOUND for zero rows and TOO_MANY_ROWS for more than one,
-- both caught below and turned into a clear, specific message rather than
-- silently picking an arbitrary row.

create or replace function public.staff_resolve_warehouse_id()
returns uuid
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_warehouse_id uuid;
begin
  begin
    select w.id into strict v_warehouse_id
    from public.warehouses as w
    where w.code = 'ALMATY-01' and w.is_active;
  exception
    when no_data_found then
      raise exception 'Основной склад (ALMATY-01) не найден или неактивен';
    when too_many_rows then
      raise exception
        'Обнаружено несколько активных складов с кодом ALMATY-01 — требуется ручная проверка данных';
  end;

  return v_warehouse_id;
end;
$$;

revoke all on function public.staff_resolve_warehouse_id() from public, anon, authenticated;

-- --- 1b. Resolve a product's price for a given company (or none) --------
--
-- Mirrors public.get_product_price()'s exact priority order (personal
-- company price > price list for the company's price group, falling back
-- to the default price group > products.base_price), but takes the
-- target company_id as an explicit argument instead of deriving it from
-- auth.uid(): a manual staff order must be priced for the CLIENT the order
-- belongs to, never for the staff member creating it. get_product_price()
-- itself is left completely untouched — this is a separate, additive
-- function.
--
-- p_company_id = null resolves the individual-customer / "no personal
-- price" path (price group default / base_price only), matching how
-- get_product_price() behaves for an individual customer profile.

create or replace function public.staff_resolve_price(p_product_id uuid, p_company_id uuid)
returns numeric
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_price_group_id uuid;
  v_price numeric;
begin
  if p_company_id is not null then
    select cpp.price into v_price
    from public.company_product_prices as cpp
    where cpp.company_id = p_company_id
      and cpp.product_id = p_product_id
      and (cpp.valid_from is null or cpp.valid_from <= now())
      and (cpp.valid_to is null or cpp.valid_to >= now())
    limit 1;

    if v_price is not null then
      return v_price;
    end if;

    select c.price_group_id into v_price_group_id
    from public.companies as c
    where c.id = p_company_id;
  end if;

  if v_price_group_id is null then
    select pg.id into v_price_group_id from public.price_groups as pg where pg.is_default limit 1;
  end if;

  if v_price_group_id is not null then
    select pp.price into v_price
    from public.product_prices as pp
    where pp.product_id = p_product_id
      and pp.price_group_id = v_price_group_id
      and (pp.valid_from is null or pp.valid_from <= now())
      and (pp.valid_to is null or pp.valid_to >= now())
    limit 1;

    if v_price is not null then
      return v_price;
    end if;
  end if;

  return (select p.base_price from public.products as p where p.id = p_product_id);
end;
$$;

revoke all on function public.staff_resolve_price(uuid, uuid) from public, anon, authenticated;

-- --- 1c. Recompute an order's subtotal/total from its current items -----
--
-- discount is left untouched (staff cannot set a discount at this stage —
-- out of scope); total = subtotal - discount, matching create_order()'s
-- own formula. Before writing, discount is validated against the fresh
-- subtotal: null is treated as 0, a negative discount or a discount that
-- exceeds subtotal raises instead of being silently clamped with
-- greatest(..., 0). Returns the fresh public.orders row so callers can
-- hand it straight back to the client instead of re-selecting it.
-- Column types match orders.subtotal / discount / total: numeric(14, 2).

create or replace function public.staff_recalculate_order_totals(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subtotal numeric(14, 2);
  v_discount numeric(14, 2);
  v_total numeric(14, 2);
  v_order public.orders;
begin
  select coalesce(sum(oi.line_total), 0)::numeric(14, 2) into v_subtotal
  from public.order_items as oi
  where oi.order_id = p_order_id;

  select o.discount into v_discount
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    raise exception 'Заказ не найден при пересчёте суммы';
  end if;

  v_discount := coalesce(v_discount, 0);

  if v_discount < 0 then
    raise exception 'Скидка заказа не может быть отрицательной (discount = %)', v_discount;
  end if;

  if v_discount > v_subtotal then
    raise exception
      'Скидка заказа (%) превышает сумму позиций (%)', v_discount, v_subtotal;
  end if;

  v_total := v_subtotal - v_discount;

  update public.orders as o
  set subtotal = v_subtotal,
      total = v_total
  where o.id = p_order_id
  returning * into v_order;

  if v_order.id is null then
    raise exception 'Заказ не найден при пересчёте суммы';
  end if;

  return v_order;
end;
$$;

revoke all on function public.staff_recalculate_order_totals(uuid) from public, anon, authenticated;

-- --- 1d. Escape a free-text search term for safe use inside ILIKE -------
--
-- Without this, a search term containing literal '%' or '_' would be
-- interpreted as SQL wildcards instead of literal characters. Backslash is
-- escaped first so the later escapes aren't themselves re-escaped.

create or replace function public.staff_escape_ilike_term(p_term text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_');
$$;

revoke all on function public.staff_escape_ilike_term(text) from public, anon, authenticated;

-- --- 1e. Assert a computed stock quantity is not negative ----------------
--
-- quantity - reserved_quantity should never be negative given inventory's
-- own CHECK constraints (inventory_reserved_not_over_quantity,
-- 002_catalog_inventory_pricing.sql), enforced on every write. If it ever
-- is anyway (pre-existing data corruption, a bug elsewhere), every call
-- site below must fail loudly with a clear message instead of silently
-- returning or acting on a negative number.

create or replace function public.staff_assert_non_negative_stock(p_value numeric, p_context text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value < 0 then
    raise exception 'Повреждены складские данные (%): отрицательный доступный остаток %', p_context, p_value;
  end if;

  return p_value;
end;
$$;

revoke all on function public.staff_assert_non_negative_stock(numeric, text) from public, anon, authenticated;

-- ============================================================
-- 2. READ RPC — public.staff_search_clients(p_query, p_limit)
--
-- Access: manager, admin (checked internally — no RLS/grant covers this).
--
-- Returns only the minimum needed to pick an existing, ALREADY REGISTERED
-- client for a manual order: no other profiles/companies columns are
-- exposed. Only role = 'client' profiles are returned (staff accounts are
-- never valid order recipients here) and only is_active profiles (a
-- deactivated client account is not a safe target for a new manual order).
--
-- profiles has no email column in this schema (audit finding — see chat
-- report). The only place an email is available for an arbitrary client is
-- auth.users.email. This function reads it directly: SECURITY DEFINER runs
-- as the function owner, which already has table-level access to auth.users
-- (the same trust boundary public.handle_new_user() already relies on for
-- new.email) — this does not use service_role and does not expose any
-- other auth.users column. Only manager/admin can call this function at
-- all, and only the single `email` column is ever returned.
--
-- A null, empty, or shorter-than-2-character query returns an EMPTY result
-- set (not "list every client"): without this, an empty search box would
-- let manager/admin page through the entire customer base client-side,
-- which is a much broader read than "search for a specific existing
-- client" was ever meant to allow.
-- ============================================================

create or replace function public.staff_search_clients(p_query text default null, p_limit integer default 20)
returns table (
  profile_id uuid,
  company_id uuid,
  full_name text,
  company_name text,
  phone text,
  email text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer;
  v_raw_term text;
  v_term text;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для поиска клиентов';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 50);

  -- Length check on the RAW trimmed term (before ILIKE-escaping, which can
  -- only ever lengthen it) — 2 is the shortest term that still narrows the
  -- result meaningfully instead of matching almost everything.
  v_raw_term := nullif(trim(p_query), '');
  if v_raw_term is null or length(v_raw_term) < 2 then
    return;
  end if;

  v_term := public.staff_escape_ilike_term(v_raw_term);

  return query
  select
    p.id as profile_id,
    p.company_id,
    p.full_name,
    c.name as company_name,
    p.phone,
    au.email::text as email
  from public.profiles as p
  left join public.companies as c on c.id = p.company_id
  left join auth.users as au on au.id = p.id
  where p.role = 'client'
    and p.is_active
    and (
      p.full_name ilike ('%' || v_term || '%') escape '\'
      or p.phone ilike ('%' || v_term || '%') escape '\'
      or c.name ilike ('%' || v_term || '%') escape '\'
      or au.email ilike ('%' || v_term || '%') escape '\'
    )
  order by p.full_name
  limit v_limit;
end;
$$;

revoke all on function public.staff_search_clients(text, integer) from public, anon, authenticated;
grant execute on function public.staff_search_clients(text, integer) to authenticated;

-- ============================================================
-- 3. READ RPC — public.staff_search_products(p_query, p_limit)
--
-- Access: manager, admin, accountant, warehouse.
--
-- Returns catalog + stock fields for the single current warehouse (see
-- staff_resolve_warehouse_id() above) — the same warehouse create_order()
-- reserves against, so "available_quantity" here means exactly the same
-- thing it will mean when staff_add_order_item() checks it. This does NOT
-- open a new SELECT policy on public.inventory: the raw table stays
-- inaccessible to authenticated, this function is the only path.
--
-- Warehouse resolution is NOT soft-failed: if ALMATY-01 is missing,
-- inactive, or duplicated, staff_resolve_warehouse_id() raises and this
-- RPC fails with that same clear error. A missing warehouse is never
-- disguised as zero stock for every product.
--
-- Price is resolved WITHOUT a specific client's personal price (p_company_id
-- = null passed to staff_resolve_price — price-group-default / base_price
-- only), because this general-purpose search endpoint (also used by
-- accountant/warehouse, who are never adding items to an order) is not
-- given an order/client context by its signature. staff_add_order_item()
-- below always resolves and snapshots the ACTUAL client-specific price at
-- the moment an item is added, independently of whatever this function
-- displayed — see the "Известные риски" section of the chat report.
-- ============================================================

create or replace function public.staff_search_products(p_query text default null, p_limit integer default 50)
returns table (
  product_id uuid,
  name text,
  sku text,
  category text,
  unit text,
  price numeric,
  warehouse_id uuid,
  warehouse_name text,
  physical_quantity numeric,
  reserved_quantity numeric,
  available_quantity numeric
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer;
  v_term text;
  v_warehouse_id uuid;
begin
  if not public.has_staff_role(array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для поиска товаров';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  -- Same hard requirement as the write RPCs: a missing/inactive/duplicate
  -- ALMATY-01 is a config problem that must surface as an error, not as
  -- fake zero stock for the entire catalog.
  v_warehouse_id := public.staff_resolve_warehouse_id();

  return query
  select
    p.id as product_id,
    p.name,
    p.sku,
    cat.name as category,
    p.unit,
    public.staff_resolve_price(p.id, null::uuid) as price,
    v_warehouse_id as warehouse_id,
    w.name as warehouse_name,
    coalesce(i.quantity, 0) as physical_quantity,
    coalesce(i.reserved_quantity, 0) as reserved_quantity,
    -- Raises instead of returning a negative number if this product's
    -- inventory row is ever corrupted (reserved_quantity > quantity) —
    -- see staff_assert_non_negative_stock() above.
    public.staff_assert_non_negative_stock(
      coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0),
      p.name
    ) as available_quantity
  from public.products as p
  left join public.categories as cat on cat.id = p.category_id
  left join public.inventory as i on i.product_id = p.id and i.warehouse_id = v_warehouse_id
  left join public.warehouses as w on w.id = v_warehouse_id
  where p.status = 'active'
    and (
      v_term is null
      or p.name ilike ('%' || v_term || '%') escape '\'
      or p.sku ilike ('%' || v_term || '%') escape '\'
      or p.original_sku ilike ('%' || v_term || '%') escape '\'
    )
  order by p.name
  limit v_limit;
end;
$$;

revoke all on function public.staff_search_products(text, integer) from public, anon, authenticated;
grant execute on function public.staff_search_products(text, integer) to authenticated;

-- ============================================================
-- 4. WRITE RPC — public.staff_create_order(p_client_profile_id)
--
-- Access: manager, admin.
--
-- Creates an EMPTY order (no items, no reservation) with status 'new' for
-- an existing, already-registered client profile. Never uses auth.uid() as
-- the order's customer — user_id/profile_id/company_id all come from the
-- looked-up client row. No created_by/creator column exists on
-- public.orders and none is added here (per spec: don't add a new column
-- unless the schema already needs it) — which staff member created a
-- manual order is therefore not recorded in this step.
--
-- orders.contact_name / contact_phone are NOT NULL + non-blank
-- (007_checkout_order_details.sql); they are seeded from the client's own
-- profile (full_name/phone) since there is no separate contact-entry step
-- in this manual-order UI yet. If the client profile has no phone on file,
-- this raises a clear error instead of inserting a placeholder value —
-- see "Известные риски" in the chat report for why this can legitimately
-- block a manual order today.
--
-- delivery_type is NOT NULL with no UI field yet to choose it in this
-- step, so it defaults to 'pickup' (same value used for the vast majority
-- of today's client checkouts) — a documented assumption, not a business
-- rule; changing it later is a one-line change once the UI grows a
-- delivery-method selector for manual orders.
-- ============================================================

create or replace function public.staff_create_order(p_client_profile_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.profiles;
  v_company_id uuid;
  v_contact_name text;
  v_contact_phone text;
  v_contact_email text;
  v_order_id uuid;
  v_order_number text;
  v_order_status text;
  v_order_created_at timestamptz;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для создания заказа';
  end if;

  if p_client_profile_id is null then
    raise exception 'Не указан клиент';
  end if;

  select * into v_client
  from public.profiles as p
  where p.id = p_client_profile_id;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  if v_client.role <> 'client' then
    raise exception 'Указанный профиль не является клиентом';
  end if;

  if not v_client.is_active then
    raise exception 'Клиент неактивен, создание заказа невозможно';
  end if;

  if v_client.customer_type = 'individual' then
    v_company_id := null;
  elsif v_client.customer_type = 'company' then
    if v_client.company_id is null then
      raise exception 'У профиля компании отсутствует company_id';
    end if;

    if not exists (select 1 from public.companies as c where c.id = v_client.company_id) then
      raise exception 'Компания клиента не найдена';
    end if;

    v_company_id := v_client.company_id;
  else
    raise exception 'Неизвестный тип покупателя: %', v_client.customer_type;
  end if;

  v_contact_name := nullif(trim(v_client.full_name), '');
  v_contact_phone := nullif(trim(v_client.phone), '');

  if v_contact_name is null then
    raise exception 'У клиента не указано имя в профиле — создание заказа невозможно';
  end if;

  if v_contact_phone is null then
    raise exception 'У клиента не указан телефон в профиле — создание заказа невозможно';
  end if;

  select au.email into v_contact_email from auth.users as au where au.id = v_client.id;

  insert into public.orders as o (
    user_id,
    profile_id,
    company_id,
    status,
    subtotal,
    discount,
    total,
    delivery_type,
    contact_name,
    contact_phone,
    contact_email
  ) values (
    v_client.id,
    v_client.id, -- profiles.id == auth.users.id, matches create_order()'s own invariant
    v_company_id,
    'new',
    0,
    0,
    0,
    'pickup',
    v_contact_name,
    v_contact_phone,
    v_contact_email
  )
  returning o.id, o.order_number, o.status, o.created_at
  into v_order_id, v_order_number, v_order_status, v_order_created_at;

  return query select v_order_id, v_order_number, v_order_status, v_order_created_at;
end;
$$;

revoke all on function public.staff_create_order(uuid) from public, anon, authenticated;
grant execute on function public.staff_create_order(uuid) to authenticated;

-- ============================================================
-- 5. WRITE RPC — public.staff_add_order_item(p_order_id, p_product_id, p_quantity)
--
-- Access: manager, admin.
--
-- Locking order: the order row is locked FOR UPDATE FIRST, before any
-- product/inventory/order_item row. Every write RPC in this migration
-- follows this exact same rule (order row first, always) specifically so
-- that two concurrent calls touching the same order can never deadlock —
-- once one call holds the order's lock, any other call against that same
-- order blocks entirely on that single lock before acquiring anything
-- else, so the relative order of subsequent locks can never matter.
--
-- Price snapshot rule: staff_resolve_price() is called ONLY when a brand
-- new order_items row is being inserted for this product. If the product
-- is already on the order, the EXISTING row's unit_price is reused as-is
-- — never re-resolved — so a later company_product_prices/product_prices
-- change can never silently alter what an already-added line charges.
-- Only quantity and line_total (= unchanged unit_price * new quantity)
-- change on that branch.
--
-- Duplicate-row safety: order_items has no UNIQUE(order_id, product_id)
-- constraint in the current schema (verified against 005_orders.sql — the
-- table has no such constraint, and no migration since has added one).
-- A DB constraint was deliberately NOT added blindly here (see the chat
-- report for the full reasoning); instead this function is safe against
-- concurrently creating two rows for the same product because:
--   1. It locks the ORDER row FOR UPDATE first, before ever touching
--      order_items — so two concurrent staff_add_order_item() calls for
--      the SAME order fully serialize on that single lock. The second
--      call cannot even begin looking at order_items until the first
--      call's transaction has committed (or rolled back).
--   2. Once the first call commits its insert and releases the order
--      lock, the second call (blocked on the same "select ... for
--      update" statement) proceeds under Postgres's default READ
--      COMMITTED isolation, which takes a fresh snapshot for each new
--      statement — so it is guaranteed to see the first call's
--      already-committed row and take the "existing item" branch below,
--      never the "insert" branch.
--   3. As a defense-in-depth check against any PRE-EXISTING duplicate
--      (e.g. from data imported outside this RPC), the exact-count check
--      below raises a clear error instead of silently locking/using just
--      one of several duplicate rows (which SELECT ... INTO would
--      otherwise do without any warning).
-- ============================================================

create or replace function public.staff_add_order_item(
  p_order_id uuid,
  p_product_id uuid,
  p_quantity integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_product public.products;
  v_warehouse_id uuid;
  v_inv_quantity numeric(14, 3);
  v_inv_reserved numeric(14, 3);
  v_available numeric(14, 3);
  v_unit_price numeric(14, 2);
  v_line_total numeric(14, 2);
  v_existing_item public.order_items;
  v_existing_count integer;
  v_new_quantity integer;
  v_affected_rows integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения заказа';
  end if;

  if p_order_id is null or p_product_id is null then
    raise exception 'order_id и product_id обязательны';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество должно быть положительным целым числом';
  end if;

  -- --- lock the order first (see note above) -----------------------------
  select * into v_order from public.orders as o where o.id = p_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status <> 'new' then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" (текущий статус: %)', v_order.status;
  end if;

  select * into v_product from public.products as p where p.id = p_product_id;

  if not found then
    raise exception 'Товар не найден';
  end if;

  if v_product.status <> 'active' then
    raise exception 'Товар недоступен для заказа';
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  -- --- lock + check inventory ---------------------------------------------
  select i.quantity, i.reserved_quantity into v_inv_quantity, v_inv_reserved
  from public.inventory as i
  where i.warehouse_id = v_warehouse_id and i.product_id = p_product_id
  for update;

  if not found then
    -- No inventory row for this product at this warehouse: available is 0.
    -- Nothing to lock — nothing else can reserve against a row that
    -- doesn't exist — and this always fails the check just below.
    v_inv_quantity := 0;
    v_inv_reserved := 0;
  end if;

  v_available := public.staff_assert_non_negative_stock(v_inv_quantity - v_inv_reserved, v_product.name);

  if v_available < p_quantity::numeric(14, 3) then
    raise exception 'Недостаточно товара на складе: % (доступно %, требуется %)',
      v_product.name, v_available, p_quantity;
  end if;

  -- --- defense-in-depth: this product must appear at most once ------------
  -- See the "Duplicate-row safety" note above for why concurrent calls
  -- cannot create a second row; this only guards against a pre-existing
  -- duplicate slipping through unnoticed.
  select count(*) into v_existing_count
  from public.order_items as oi
  where oi.order_id = p_order_id and oi.product_id = p_product_id;

  if v_existing_count > 1 then
    raise exception
      'Обнаружено несколько позиций товара % в заказе — требуется ручная проверка данных', v_product.name;
  end if;

  -- --- add to an existing line, or insert a new one -----------------------
  select * into v_existing_item
  from public.order_items as oi
  where oi.order_id = p_order_id and oi.product_id = p_product_id
  for update;

  if found then
    -- Integer-overflow guard mirrors create_order()'s own check
    -- (006_create_order_rpc.sql) for the same reason: quantity is a plain
    -- `integer` column/parameter.
    if v_existing_item.quantity > (2147483647 - p_quantity) then
      raise exception 'Слишком большое количество для товара %', v_product.name;
    end if;

    -- Price snapshot rule: reuse the EXISTING unit_price, never
    -- re-resolve it — see the function-level note above.
    v_new_quantity := v_existing_item.quantity + p_quantity;
    v_line_total := round(v_existing_item.unit_price * v_new_quantity, 2);

    update public.order_items as oi
    set quantity = v_new_quantity,
        line_total = v_line_total
    where oi.id = v_existing_item.id;
  else
    -- Client-specific price snapshot, resolved for the ORDER's customer
    -- (v_order.company_id), never for the calling staff member — and only
    -- ever resolved here, at the moment a NEW line is first created.
    v_unit_price := public.staff_resolve_price(p_product_id, v_order.company_id);

    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'Цена недоступна для товара: %', v_product.name;
    end if;

    v_line_total := round(v_unit_price * p_quantity, 2);

    insert into public.order_items (
      order_id, product_id, product_name, product_sku, quantity, unit_price, line_total
    ) values (
      p_order_id, p_product_id, v_product.name, v_product.sku, p_quantity, v_unit_price, v_line_total
    );
  end if;

  -- --- reserve the stock ---------------------------------------------------
  update public.inventory as i
  set reserved_quantity = i.reserved_quantity + p_quantity::numeric(14, 3),
      updated_at = now()
  where i.warehouse_id = v_warehouse_id and i.product_id = p_product_id;

  get diagnostics v_affected_rows = row_count;
  if v_affected_rows <> 1 then
    raise exception 'Не удалось зарезервировать товар: %', v_product.name;
  end if;

  -- Reactivating a previously RELEASED reservation must RESET its quantity
  -- to exactly p_quantity, never add to the stale released amount (e.g.
  -- add 10 -> remove -> add 4 must end at quantity = 4, not 14). Only when
  -- the existing conflicting row is still 'active' (this product's
  -- quantity was just increased above, in the `if found` branch) does the
  -- reservation grow by the same delta that was just added to
  -- order_items.
  insert into public.inventory_reservations (order_id, warehouse_id, product_id, quantity, status)
  values (p_order_id, v_warehouse_id, p_product_id, p_quantity::numeric(14, 3), 'active')
  on conflict (order_id, product_id)
  do update set
    quantity = case
      when public.inventory_reservations.status = 'active'
        then public.inventory_reservations.quantity + excluded.quantity
      else excluded.quantity
    end,
    status = 'active',
    released_at = null;

  return public.staff_recalculate_order_totals(p_order_id);
end;
$$;

revoke all on function public.staff_add_order_item(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.staff_add_order_item(uuid, uuid, integer) to authenticated;

-- ============================================================
-- 6. WRITE RPC — public.staff_update_order_item_quantity(p_order_item_id, p_quantity)
--
-- Access: manager, admin. Locks the order FIRST (see note in section 5),
-- looked up from the item's order_id via a plain (non-locking) select,
-- then locks the order, then re-selects + locks the item itself.
--
-- Price snapshot rule: this function NEVER calls staff_resolve_price().
-- It reuses order_items.unit_price exactly as it already is and only
-- recomputes line_total = unit_price * new_quantity — a quantity change
-- must never silently re-price an already-added line.
--
-- Consistency rule: before touching inventory/inventory_reservations, the
-- order's own active reservation for this product is verified to belong
-- to this exact order/product and to carry the same quantity as the item
-- being changed. Any mismatch raises a clear exception instead of
-- silently "fixing" the reservation to match — see the chat report.
-- ============================================================

create or replace function public.staff_update_order_item_quantity(
  p_order_item_id uuid,
  p_quantity integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_order public.orders;
  v_item public.order_items;
  v_warehouse_id uuid;
  v_inv_quantity numeric(14, 3);
  v_inv_reserved numeric(14, 3);
  v_available numeric(14, 3);
  v_diff integer;
  v_new_line_total numeric(14, 2);
  v_reservation public.inventory_reservations;
  v_affected_rows integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения заказа';
  end if;

  if p_order_item_id is null then
    raise exception 'order_item_id обязателен';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество должно быть положительным целым числом';
  end if;

  select oi.order_id into v_order_id from public.order_items as oi where oi.id = p_order_item_id;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  -- --- lock the order first (see note in section 5) -----------------------
  select * into v_order from public.orders as o where o.id = v_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status <> 'new' then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" (текущий статус: %)', v_order.status;
  end if;

  select * into v_item
  from public.order_items as oi
  where oi.id = p_order_item_id and oi.order_id = v_order.id
  for update;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  v_diff := p_quantity - v_item.quantity;

  if v_diff = 0 then
    return v_order;
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select i.quantity, i.reserved_quantity into v_inv_quantity, v_inv_reserved
  from public.inventory as i
  where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id
  for update;

  if not found then
    raise exception 'Складская запись для товара % не найдена', v_item.product_name;
  end if;

  if v_diff > 0 then
    v_available := public.staff_assert_non_negative_stock(v_inv_quantity - v_inv_reserved, v_item.product_name);

    if v_available < v_diff::numeric(14, 3) then
      raise exception 'Недостаточно товара на складе: % (доступно %, требуется дополнительно %)',
        v_item.product_name, v_available, v_diff;
    end if;
  end if;

  -- --- lock + verify the reservation this item owns -----------------------
  select * into v_reservation
  from public.inventory_reservations as r
  where r.order_id = v_order.id and r.product_id = v_item.product_id and r.status = 'active'
  for update;

  if not found then
    raise exception 'Активный резерв для товара % не найден', v_item.product_name;
  end if;

  -- Consistency checks: the reservation found above is already filtered by
  -- order_id/product_id, so a mismatch there would mean the query itself
  -- is broken — asserted anyway, as cheap, explicit defense-in-depth.
  -- quantity is the one field that can genuinely drift if some other code
  -- path ever touched either row without going through this RPC, so this
  -- check is the one that actually matters in practice.
  if v_reservation.order_id <> v_order.id or v_reservation.product_id <> v_item.product_id then
    raise exception
      'Резерв не соответствует позиции заказа (резерв: заказ %, товар %; позиция: заказ %, товар %)',
      v_reservation.order_id, v_reservation.product_id, v_order.id, v_item.product_id;
  end if;

  if v_reservation.quantity <> v_item.quantity::numeric(14, 3) then
    raise exception
      'Резерв рассинхронизирован с позицией заказа для товара %: резерв %, позиция %',
      v_item.product_name, v_reservation.quantity, v_item.quantity;
  end if;

  -- Price snapshot rule: unit_price is intentionally left untouched — only
  -- quantity and line_total change (see function-level note above).
  v_new_line_total := round(v_item.unit_price * p_quantity, 2);

  update public.order_items as oi
  set quantity = p_quantity,
      line_total = v_new_line_total
  where oi.id = p_order_item_id;

  update public.inventory as i
  set reserved_quantity = i.reserved_quantity + v_diff::numeric(14, 3),
      updated_at = now()
  where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id;

  get diagnostics v_affected_rows = row_count;
  if v_affected_rows <> 1 then
    raise exception 'Не удалось обновить резерв товара: %', v_item.product_name;
  end if;

  update public.inventory_reservations as r
  set quantity = v_reservation.quantity + v_diff::numeric(14, 3)
  where r.id = v_reservation.id;

  return public.staff_recalculate_order_totals(v_order.id);
end;
$$;

revoke all on function public.staff_update_order_item_quantity(uuid, integer) from public, anon, authenticated;
grant execute on function public.staff_update_order_item_quantity(uuid, integer) to authenticated;

-- ============================================================
-- 7. WRITE RPC — public.staff_remove_order_item(p_order_item_id)
--
-- Access: manager, admin. Same "lock the order first" rule as sections
-- 5/6. Fully releases the item's reservation (mirrors cancel_order()'s
-- strict, no-floor release check — never silently clamps at 0), then hard
-- deletes the order_items row: there is no existing soft-delete mechanism
-- on order_items to reuse (audit finding — the table has no
-- deleted_at/is_deleted column), so per spec ("либо использовать
-- существующий механизм soft-delete, если он уже есть") a real DELETE is
-- used.
--
-- Consistency rule: same as staff_update_order_item_quantity() — the
-- active reservation being released must belong to this exact
-- order/product and carry the same quantity as the item being removed.
-- Any mismatch raises instead of silently releasing a possibly-wrong
-- amount.
-- ============================================================

create or replace function public.staff_remove_order_item(p_order_item_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_order public.orders;
  v_item public.order_items;
  v_warehouse_id uuid;
  v_reservation public.inventory_reservations;
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения заказа';
  end if;

  if p_order_item_id is null then
    raise exception 'order_item_id обязателен';
  end if;

  select oi.order_id into v_order_id from public.order_items as oi where oi.id = p_order_item_id;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  -- --- lock the order first (see note in section 5) -----------------------
  select * into v_order from public.orders as o where o.id = v_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status <> 'new' then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" (текущий статус: %)', v_order.status;
  end if;

  select * into v_item
  from public.order_items as oi
  where oi.id = p_order_item_id and oi.order_id = v_order.id
  for update;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select * into v_reservation
  from public.inventory_reservations as r
  where r.order_id = v_order.id and r.product_id = v_item.product_id and r.status = 'active'
  for update;

  if found then
    -- Consistency checks — see staff_update_order_item_quantity() for why
    -- these matter in practice (quantity drift) even though order_id/
    -- product_id are already implied by the WHERE clause above.
    if v_reservation.order_id <> v_order.id or v_reservation.product_id <> v_item.product_id then
      raise exception
        'Резерв не соответствует позиции заказа (резерв: заказ %, товар %; позиция: заказ %, товар %)',
        v_reservation.order_id, v_reservation.product_id, v_order.id, v_item.product_id;
    end if;

    if v_reservation.quantity <> v_item.quantity::numeric(14, 3) then
      raise exception
        'Резерв рассинхронизирован с позицией заказа для товара %: резерв %, позиция %',
        v_item.product_name, v_reservation.quantity, v_item.quantity;
    end if;

    select i.reserved_quantity into v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id
    for update;

    if not found then
      raise exception 'Складская запись для товара % не найдена, удаление невозможно', v_item.product_name;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара %: зарезервировано % меньше, чем требуется освободить (%)',
        v_item.product_name, v_inv_reserved, v_reservation.quantity;
    end if;

    update public.inventory as i
    set reserved_quantity = i.reserved_quantity - v_reservation.quantity,
        updated_at = now()
    where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id;

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось освободить резерв товара: %', v_item.product_name;
    end if;

    update public.inventory_reservations as r
    set status = 'released', released_at = now()
    where r.id = v_reservation.id;
  end if;

  delete from public.order_items as oi where oi.id = p_order_item_id;

  return public.staff_recalculate_order_totals(v_order.id);
end;
$$;

revoke all on function public.staff_remove_order_item(uuid) from public, anon, authenticated;
grant execute on function public.staff_remove_order_item(uuid) to authenticated;

-- ============================================================
-- 8. Notes
--
-- - create_order() and cancel_order() are completely untouched by this
--   migration.
-- - No new RLS policy and no new table grant (SELECT/INSERT/UPDATE/DELETE)
--   is added anywhere in this migration for authenticated/anon — every
--   capability above is exposed exclusively via EXECUTE on these 11
--   functions: 5 internal helpers (staff_resolve_warehouse_id,
--   staff_resolve_price, staff_recalculate_order_totals,
--   staff_escape_ilike_term, staff_assert_non_negative_stock — every one
--   with an explicit `revoke all ... from public, anon, authenticated`
--   and no grant to anyone) plus 6 public RPCs (staff_search_clients,
--   staff_search_products, staff_create_order, staff_add_order_item,
--   staff_update_order_item_quantity, staff_remove_order_item — every one
--   with an explicit `revoke all ... from public, anon, authenticated`
--   followed by `grant execute ... to authenticated` only, and its own
--   internal has_staff_role(...) check).
-- - No REVOKE anywhere in this migration relies on the absence of a
--   GRANT: PostgreSQL grants EXECUTE to PUBLIC by default on newly
--   created functions, so every function above is explicitly revoked from
--   public, anon AND authenticated before the 6 public RPCs are
--   individually re-granted to authenticated only.
-- - A client account (role = 'client') calling any of the 6 public RPCs
--   gets a clear "Недостаточно прав ..." exception from
--   has_staff_role(...) — it never reaches any table. accountant/
--   warehouse get the same exception from the 4 manager/admin-only RPCs
--   (everything except staff_search_products, which they are allowed to
--   call, read-only).
-- - Every write RPC locks the target order row FOR UPDATE before locking
--   anything else, specifically to make concurrent calls against the same
--   order block cleanly on that one lock instead of ever deadlocking
--   against each other — this same serialization is also what prevents
--   two concurrent staff_add_order_item() calls from ever creating two
--   order_items rows for the same product (see section 5's own note).
-- - No service_role used anywhere in this migration.
-- ============================================================
