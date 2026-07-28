-- DEKORO Platform V1
-- Migration: explicit inventory reservation registry + create_order() reservation
--
-- Depends on:
--   002_catalog_inventory_pricing.sql (public.warehouses, public.inventory,
--     public.product_availability, public.products, public.get_product_price)
--   005_orders.sql (public.orders, public.order_items)
--   006_create_order_rpc.sql / 007_checkout_order_details.sql
--     (public.create_order(jsonb, text, text, text, text, text, text, text))
--
-- Run this file once in the Supabase SQL Editor after 007
-- (see supabase/README.md). Not executed automatically, not applied by
-- this change — apply by hand when ready.
--
-- Purpose: create_order() currently creates an order without checking or
-- reserving any stock. This migration adds:
--   1. public.inventory_reservations — an explicit, auditable record of
--      which order reserved how much of which product at which
--      warehouse. This is what makes cancellation
--      (009_cancel_order_release_reservation.sql) safe: releasing a
--      reservation only ever touches quantity that a specific order is
--      provably responsible for, never inventory.reserved_quantity as an
--      undifferentiated pool.
--   2. create_order() checking available inventory
--      (quantity - reserved_quantity) for every ordered product at the
--      single current warehouse ('ALMATY-01'), increasing
--      inventory.reserved_quantity, and recording one
--      inventory_reservations row per line — or raising and rolling back
--      the whole order (and any partial reservation) if any line is
--      short.
--
-- Explicitly NOT done here (future steps):
--   - releasing a reservation on cancellation (that's 009, built on the
--     inventory_reservations table added here);
--   - decrementing quantity on shipment;
--   - partial shipment;
--   - reservation across multiple warehouses;
--   - a reservation expiry/TTL;
--   - any manager/warehouse UI or RPC to adjust stock;
--   - any frontend change — create_order()'s signature and returned shape
--     are unchanged, so the client needs no changes.
--
-- No structural changes to warehouses/inventory/product_availability. No
-- service_role. RLS/grants on those tables, and on the new
-- inventory_reservations table, are as restrictive as the rest of this
-- project — clients still cannot read or write inventory (or
-- reservations) directly; create_order() (SECURITY DEFINER) remains the
-- only path that touches either.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run supabase/migrations/005_orders.sql first.';
  end if;

  if to_regclass('public.warehouses') is null
     or to_regclass('public.inventory') is null
     or to_regclass('public.product_availability') is null
     or to_regclass('public.products') is null
  then
    raise exception
      'public.warehouses / public.inventory / public.product_availability / public.products missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regprocedure('public.create_order(jsonb, text, text, text, text, text, text, text)') is null then
    raise exception
      'public.create_order(jsonb, text, text, text, text, text, text, text) is missing — run supabase/migrations/007_checkout_order_details.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. public.inventory_reservations
--
-- One row per (order, product): the durable, queryable proof of exactly
-- how much a specific order reserved of a specific product at a specific
-- warehouse. Never aggregated away — cancel_order() (009) reads these
-- rows instead of guessing from inventory.reserved_quantity alone, which
-- cannot by itself tell which order a unit of reservation belongs to.
--
-- status: 'active' while the reservation still holds stock;  'released'
-- once cancel_order() has given it back. released_at is set exactly when
-- status flips to 'released', never before and never for 'active' rows —
-- enforced by a CHECK, not just application logic.
--
-- unique(order_id, product_id) matches create_order()'s own
-- one-row-per-product aggregation (tmp_create_order_lines) — a single
-- order can never hold two separate reservation rows for the same
-- product.
--
-- ON DELETE RESTRICT everywhere: a reservation must never be silently
-- orphaned by deleting the order, warehouse, or product it refers to
-- (none of those are hard-deleted by any current code path anyway).
-- ============================================================

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  quantity numeric(14, 3) not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint inventory_reservations_order_product_unique unique (order_id, product_id),
  constraint inventory_reservations_quantity_positive check (quantity > 0),
  constraint inventory_reservations_status_check check (status in ('active', 'released')),
  constraint inventory_reservations_released_at_matches_status check (
    (status = 'released' and released_at is not null)
    or (status = 'active' and released_at is null)
  )
);

create index if not exists inventory_reservations_order_id_idx
  on public.inventory_reservations (order_id);
create index if not exists inventory_reservations_warehouse_product_idx
  on public.inventory_reservations (warehouse_id, product_id);
create index if not exists inventory_reservations_status_idx
  on public.inventory_reservations (status);

-- --- RLS: no direct client access at all --------------------------------
-- Same treatment as public.inventory itself (002): RLS enabled, no grant,
-- no policy. Reservations are only ever written by create_order() /
-- cancel_order() (both SECURITY DEFINER); there is no client-facing read
-- surface for them yet either.

alter table public.inventory_reservations enable row level security;
revoke all on public.inventory_reservations from anon, authenticated;

-- ============================================================
-- 2. create_order(): same signature as 007, now also checks and reserves
--    inventory, recording each reservation in inventory_reservations.
--
-- The signature is unchanged from 007 (same 8 parameters, same order,
-- same defaults), so this is a plain CREATE OR REPLACE — no new overload
-- is added and no old overload needs dropping. Re-running this file just
-- replaces the function body again (idempotent).
-- ============================================================

create or replace function public.create_order(
  p_items jsonb,
  p_delivery_type text,
  p_contact_name text,
  p_contact_phone text,
  p_comment text default null,
  p_contact_email text default null,
  p_delivery_address text default null,
  p_delivery_comment text default null
)
returns table (
  id uuid,
  order_number text,
  total numeric,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_company_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_order_created_at timestamptz;
  v_subtotal numeric(14, 2) := 0;
  v_discount numeric(14, 2) := 0;
  v_total numeric(14, 2) := 0;
  v_comment text := nullif(trim(p_comment), '');
  v_contact_name text := nullif(trim(p_contact_name), '');
  v_contact_phone text := nullif(trim(p_contact_phone), '');
  v_contact_email text := nullif(trim(p_contact_email), '');
  v_delivery_address text := nullif(trim(p_delivery_address), '');
  v_delivery_comment text := nullif(trim(p_delivery_comment), '');
  v_item jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_quantity_raw text;
  v_existing_quantity integer;
  v_product public.products%rowtype;
  v_unit_price numeric(14, 2);
  v_line_total numeric(14, 2);
  v_line record;
  -- Inventory check/reservation (new in this migration).
  v_warehouse_id uuid;
  v_inv_quantity numeric(14, 3);
  v_inv_reserved numeric(14, 3);
  v_available numeric(14, 3);
  v_affected_rows integer;
begin
  -- --- auth + profile -------------------------------------------------
  if v_user_id is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_user_id;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if not v_profile.is_active then
    raise exception 'Профиль неактивен';
  end if;

  if v_profile.customer_type = 'individual' then
    v_company_id := null;
  elsif v_profile.customer_type = 'company' then
    if v_profile.company_id is null then
      raise exception 'У профиля компании отсутствует company_id';
    end if;

    if not exists (
      select 1 from public.companies as c where c.id = v_profile.company_id
    ) then
      raise exception 'Компания не найдена';
    end if;

    v_company_id := v_profile.company_id;
  else
    raise exception 'Неизвестный тип покупателя: %', v_profile.customer_type;
  end if;

  if v_comment is not null and char_length(v_comment) > 2000 then
    raise exception 'Комментарий слишком длинный (максимум 2000 символов)';
  end if;

  -- --- delivery + contact validation -----------------------------------
  -- delivery_type covers today's checkout ('pickup', 'customer_transport')
  -- plus 'delivery', reserved for a future courier-delivery UI.
  if p_delivery_type is null or p_delivery_type not in ('pickup', 'customer_transport', 'delivery') then
    raise exception 'Некорректный способ получения заказа';
  end if;

  if v_contact_name is null then
    raise exception 'Укажите контактное лицо';
  end if;

  if char_length(v_contact_name) > 200 then
    raise exception 'Имя контактного лица слишком длинное (максимум 200 символов)';
  end if;

  if v_contact_phone is null then
    raise exception 'Укажите телефон для связи';
  end if;

  if char_length(v_contact_phone) > 50 then
    raise exception 'Телефон слишком длинный (максимум 50 символов)';
  end if;

  if v_contact_email is not null and char_length(v_contact_email) > 254 then
    raise exception 'Email слишком длинный (максимум 254 символа)';
  end if;

  if p_delivery_type = 'delivery' and v_delivery_address is null then
    raise exception 'Укажите адрес доставки';
  end if;

  if v_delivery_address is not null and char_length(v_delivery_address) > 1000 then
    raise exception 'Адрес доставки слишком длинный (максимум 1000 символов)';
  end if;

  if v_delivery_comment is not null and char_length(v_delivery_comment) > 2000 then
    raise exception 'Комментарий к доставке слишком длинный (максимум 2000 символов)';
  end if;

  -- --- items payload --------------------------------------------------
  if p_items is null then
    raise exception 'Список товаров пуст';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Список товаров должен быть JSON-массивом';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'Список товаров пуст';
  end if;

  -- Normalized lines: one row per product_id (quantities aggregated).
  -- This is also what makes the inventory check/reservation below safe
  -- from double-counting: each product_id appears at most once here, so
  -- it is checked and reserved exactly once, for its full combined
  -- quantity — never once per raw p_items element. It's also why
  -- inventory_reservations' unique(order_id, product_id) constraint can
  -- never be violated by a legitimate call.
  drop table if exists tmp_create_order_lines;
  create temporary table tmp_create_order_lines (
    product_id uuid primary key,
    product_name text,
    product_sku text,
    quantity integer not null check (quantity > 0),
    unit_price numeric(14, 2),
    line_total numeric(14, 2)
  ) on commit drop;

  for v_item in
    select value from jsonb_array_elements(p_items) as t(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Некорректный элемент заказа';
    end if;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception
      when others then
        raise exception 'Некорректный product_id';
    end;

    if v_product_id is null then
      raise exception 'product_id обязателен';
    end if;

    -- Accept only positive whole integers (reject null, 0, negatives, strings).
    v_quantity_raw := v_item ->> 'quantity';
    if v_quantity_raw is null or v_quantity_raw !~ '^[1-9][0-9]*$' then
      raise exception 'quantity должно быть положительным целым для товара %', v_product_id;
    end if;

    begin
      v_quantity := v_quantity_raw::integer;
    exception
      when others then
        raise exception 'Некорректное quantity для товара %', v_product_id;
    end;

    select l.quantity into v_existing_quantity
    from tmp_create_order_lines as l
    where l.product_id = v_product_id;

    if found then
      if v_existing_quantity > (2147483647 - v_quantity) then
        raise exception 'Слишком большое quantity для товара %', v_product_id;
      end if;

      update tmp_create_order_lines as l
      set quantity = l.quantity + v_quantity
      where l.product_id = v_product_id;
    else
      insert into tmp_create_order_lines (product_id, quantity)
      values (v_product_id, v_quantity);
    end if;
  end loop;

  if not exists (select 1 from tmp_create_order_lines) then
    raise exception 'Список товаров пуст';
  end if;

  -- Price + snapshot enrichment on the normalized set only.
  for v_line in
    select l.product_id, l.quantity
    from tmp_create_order_lines as l
  loop
    select * into v_product
    from public.products as p
    where p.id = v_line.product_id;

    if not found then
      raise exception 'Товар не найден: %', v_line.product_id;
    end if;

    -- products.status is the availability flag (draft | active | archived).
    if v_product.status is distinct from 'active' then
      raise exception 'Товар недоступен для заказа: %', v_line.product_id;
    end if;

    -- Resolved caller price (personal / price group / base_price).
    -- Never read money fields from p_items.
    v_unit_price := public.get_product_price(v_line.product_id);

    if v_unit_price is null then
      raise exception 'Цена недоступна для товара: %', v_line.product_id;
    end if;

    -- Existing catalog constraints allow price >= 0 (including 0).
    -- Reject only negative values (should not occur under those CHECKs).
    if v_unit_price < 0 then
      raise exception 'Некорректная цена для товара: %', v_line.product_id;
    end if;

    v_line_total := round(v_unit_price * v_line.quantity, 2);

    update tmp_create_order_lines as l
    set
      product_name = v_product.name,
      product_sku = v_product.sku,
      unit_price = v_unit_price,
      line_total = v_line_total
    where l.product_id = v_line.product_id;

    v_subtotal := v_subtotal + v_line_total;
  end loop;

  v_discount := 0;
  v_total := v_subtotal - v_discount;

  -- --- warehouse resolution (new) ---------------------------------------
  -- Single current warehouse, resolved by its known code. Not created
  -- here: if it's missing or inactive, that is an operational/config
  -- problem to fix in the warehouses table directly, not something
  -- create_order() should silently work around.
  select w.id into v_warehouse_id
  from public.warehouses as w
  where w.code = 'ALMATY-01' and w.is_active
  limit 1;

  if v_warehouse_id is null then
    raise exception 'Основной склад недоступен, оформление заказа временно невозможно';
  end if;

  -- --- inventory check: lock + validate every line (new) ----------------
  -- Locks and validates each ordered product's inventory row in
  -- deterministic product_id order (tmp_create_order_lines.product_id is
  -- its primary key, already deduplicated/aggregated above). Two
  -- concurrent create_order() calls that share products then always
  -- request their row locks in the same relative order, which avoids
  -- deadlocks instead of merely detecting them.
  --
  -- No write happens in this loop — only SELECT ... FOR UPDATE and a
  -- check. If any line is short, this RAISEs immediately, before the
  -- order/order_items/reservation rows below are ever written, and rolls
  -- back every lock taken so far along with the rest of the transaction.
  -- The locks acquired here are held until the end of this function call
  -- (this transaction), so nothing else can change these rows before the
  -- reservation loop further below runs.
  for v_line in
    select l.product_id, l.quantity, l.product_name
    from tmp_create_order_lines as l
    order by l.product_id
  loop
    select i.quantity, i.reserved_quantity
    into v_inv_quantity, v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_warehouse_id
      and i.product_id = v_line.product_id
    for update;

    if not found then
      -- No inventory row for this product at this warehouse: it has never
      -- been stocked there, so the available quantity is 0. There is no
      -- row to lock in this case — nothing else can reserve against a row
      -- that does not exist — and quantity > 0 is already guaranteed by
      -- the p_items validation above, so this always fails just below.
      v_inv_quantity := 0;
      v_inv_reserved := 0;
    end if;

    v_available := v_inv_quantity - v_inv_reserved;

    if v_available < v_line.quantity::numeric(14, 3) then
      raise exception
        'Недостаточно товара на складе: % (доступно %, требуется %)',
        v_line.product_name, v_available, v_line.quantity;
    end if;
  end loop;

  -- --- persist the order (single function call = single transaction) ---
  insert into public.orders as o (
    user_id,
    profile_id,
    company_id,
    status,
    subtotal,
    discount,
    total,
    comment,
    delivery_type,
    contact_name,
    contact_phone,
    contact_email,
    delivery_address,
    delivery_comment
  ) values (
    v_user_id,
    v_user_id, -- profiles.id == auth.users.id
    v_company_id,
    'new',
    v_subtotal,
    v_discount,
    v_total,
    v_comment,
    p_delivery_type,
    v_contact_name,
    v_contact_phone,
    v_contact_email,
    v_delivery_address,
    v_delivery_comment
  )
  returning
    o.id,
    o.order_number,
    o.created_at
  into
    v_order_id,
    v_order_number,
    v_order_created_at;

  insert into public.order_items (
    order_id,
    product_id,
    product_name,
    product_sku,
    quantity,
    unit_price,
    line_total
  )
  select
    v_order_id,
    l.product_id,
    l.product_name,
    l.product_sku,
    l.quantity,
    l.unit_price,
    l.line_total
  from tmp_create_order_lines as l;

  -- --- inventory reservation + explicit reservation record (new) --------
  -- Only reached once every line above passed its check while holding its
  -- row lock, so this can never over-reserve: two concurrent orders
  -- competing for the same product serialize on that product's
  -- FOR UPDATE lock (acquired above), and whichever one runs second sees
  -- the first one's already-incremented reserved_quantity before it
  -- reaches this point. quantity itself is untouched — it only changes on
  -- a future physical shipment step, not at order/reservation time.
  --
  -- Every UPDATE here is expected to affect exactly one row (its target
  -- row was already found and locked above); GET DIAGNOSTICS confirms
  -- that explicitly instead of assuming it, so a violated assumption
  -- raises instead of silently reserving nothing.
  for v_line in
    select l.product_id, l.quantity
    from tmp_create_order_lines as l
    order by l.product_id
  loop
    update public.inventory as i
    set
      reserved_quantity = i.reserved_quantity + v_line.quantity::numeric(14, 3),
      updated_at = now()
    where i.warehouse_id = v_warehouse_id
      and i.product_id = v_line.product_id;

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось зарезервировать товар: %', v_line.product_id;
    end if;

    insert into public.inventory_reservations (
      order_id,
      warehouse_id,
      product_id,
      quantity,
      status
    ) values (
      v_order_id,
      v_warehouse_id,
      v_line.product_id,
      v_line.quantity::numeric(14, 3),
      'active'
    );
  end loop;

  return query
  select
    v_order_id,
    v_order_number,
    v_total,
    v_order_created_at;
end;
$$;

revoke all on function public.create_order(jsonb, text, text, text, text, text, text, text) from public;
grant execute on function public.create_order(jsonb, text, text, text, text, text, text, text) to authenticated;

-- ============================================================
-- 3. Notes
--
-- - Any RAISE inside this function aborts the whole transaction: neither
--   the orders row, nor any order_items rows, nor any
--   inventory/inventory_reservations change are committed. There is no
--   manual BEGIN/COMMIT anywhere in this function — it relies entirely on
--   PostgreSQL's implicit "one function call = one transaction" semantics
--   (when called directly via RPC, as the frontend does).
-- - Duplicate product_id values in p_items are still aggregated before
--   the inventory check/reservation and before insert (unchanged from
--   006/007) — each product is checked and reserved exactly once, for its
--   combined quantity, and gets exactly one inventory_reservations row
--   (enforced by unique(order_id, product_id)).
-- - Stock is now checked and reserved (reserved_quantity increases, one
--   inventory_reservations row per line is inserted with status
--   'active'); quantity (physical stock) is intentionally left untouched
--   — it will only decrease at a future "shipment" step, not at order
--   time.
-- - inventory_reservations is what makes cancellation
--   (009_cancel_order_release_reservation.sql) safe: it lets cancel_order()
--   release exactly the quantity this specific order reserved, instead of
--   subtracting from inventory.reserved_quantity as an undifferentiated
--   pool that cannot prove which order it belongs to.
-- - Releasing a reservation on cancellation, partial shipment,
--   multi-warehouse reservation, a reservation TTL, and any
--   manager/warehouse UI are explicitly out of scope for this migration.
-- - Clients still cannot INSERT into orders/order_items, and still cannot
--   read or write warehouses/inventory/product_availability/
--   inventory_reservations directly — no RLS policy or grant is added for
--   that; create_order() remains the only entry point that writes any of
--   them (unchanged from 006/007, extended here to cover the new table).
-- - No service_role used anywhere in this migration.
-- - create_order()'s parameters, defaults and returned columns
--   (id, order_number, total, created_at) are byte-for-byte the same as
--   in 007 — no frontend change is required.
-- ============================================================
