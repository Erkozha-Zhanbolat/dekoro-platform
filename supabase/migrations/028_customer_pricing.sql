-- DEKORO Platform V2 — Staff Platform
-- Migration: Stage 28 — customer-centric pricing
--
-- Depends on 001–027 (especially 002_catalog_inventory_pricing.sql,
-- 013_customers_foundation.sql, 011/012 staff order RPCs,
-- 019_product_management.sql staff_slugify_label,
-- 027_data_lifecycle.sql admin_get_data_usage).
--
-- NOT applied automatically — run once in Supabase SQL Editor when ready.
-- Does NOT modify files 001–027.
--
-- Safe to RE-RUN after a partial failure at staff_resolve_price (42P13):
-- DDL uses IF NOT EXISTS; backfills are null-only / ON CONFLICT DO NOTHING;
-- incompatible functions are DROP FUNCTION IF EXISTS (exact types, no CASCADE)
-- before CREATE. No destructive rollback of pricing data.
--
-- Guest pricing unchanged from 002: get_product_price returns null for anon/null uid.
--
-- Client surface lockdown: products.base_price is NOT granted to anon/authenticated
-- (column-level SELECT). Pricing tables remain RPC-only. Catalog via get_catalog().
--
-- Evolves existing price_groups / product_prices / company_product_prices;
-- does NOT create parallel customer_price_groups tables.
--
-- Archive semantics: archived price groups still resolve prices for
-- customers already assigned; cannot newly assign an archived group;
-- cannot archive the default group.
--
-- BREAKING (documented): staff_resolve_price(uuid, uuid) second argument
-- is now customer_id semantics (with backward-compatible company_id lookup).
-- staff_add_order_item now passes order.customer_id for price resolution.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.price_groups') is null then
    raise exception 'public.price_groups missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.customers') is null then
    raise exception 'public.customers missing — run 013_customers_foundation.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'public.set_updated_at() missing — run 001 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role(...) missing — run 010 first.';
  end if;

  if to_regprocedure('public.staff_slugify_label(text)') is null then
    raise exception 'public.staff_slugify_label(text) missing — run 019 first.';
  end if;

  if to_regprocedure('public.get_product_price(uuid)') is null then
    raise exception 'public.get_product_price(uuid) missing — run 002 first.';
  end if;

  if to_regprocedure('public.staff_resolve_price(uuid, uuid)') is null then
    raise exception 'public.staff_resolve_price(uuid, uuid) missing — run 011 first.';
  end if;

  if to_regprocedure('public.staff_add_order_item(uuid, uuid, integer)') is null then
    raise exception 'public.staff_add_order_item(...) missing — run 012 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Extend public.price_groups
-- ============================================================

alter table public.price_groups
  add column if not exists code text,
  add column if not exists sort_order integer not null default 0,
  add column if not exists is_active boolean not null default true;

-- Ensure exactly one default group exists
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.price_groups;

  if v_count = 0 then
    insert into public.price_groups (name, code, description, is_default, sort_order, is_active)
    values ('Розница', 'roznica', null, true, 0, true);
  elsif not exists (select 1 from public.price_groups where is_default) then
    update public.price_groups as pg
    set is_default = true
    where pg.id = (
      select pg2.id
      from public.price_groups as pg2
      order by pg2.sort_order, pg2.created_at
      limit 1
    );
  end if;
end
$$;

-- Backfill code from slugified name (unique)
do $$
declare
  r record;
  v_base text;
  v_code text;
  v_n integer;
begin
  for r in
    select pg.id, pg.name
    from public.price_groups as pg
    where pg.code is null
    order by pg.created_at
  loop
    v_base := public.staff_slugify_label(r.name);
    v_code := v_base;
    v_n := 1;

    while exists (
      select 1
      from public.price_groups as pg2
      where pg2.code = v_code
        and pg2.id <> r.id
    ) loop
      v_n := v_n + 1;
      v_code := left(v_base, 70) || '-' || v_n::text;
    end loop;

    update public.price_groups as pg
    set code = v_code
    where pg.id = r.id;
  end loop;
end
$$;

alter table public.price_groups
  alter column code set not null;

-- Re-run safe: constraint may already exist from a partial 028 apply
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'price_groups_code_not_blank'
      and conrelid = 'public.price_groups'::regclass
  ) then
    alter table public.price_groups
      add constraint price_groups_code_not_blank check (length(trim(code)) > 0);
  end if;
end
$$;

create unique index if not exists price_groups_code_unique_idx
  on public.price_groups (code);

-- ============================================================
-- 2. customers.price_group_id
-- ============================================================

alter table public.customers
  add column if not exists price_group_id uuid
    references public.price_groups (id) on delete set null;

-- Backfill: company group → default group → set all nulls to default
update public.customers as c
set price_group_id = co.price_group_id
from public.companies as co
where c.company_id = co.id
  and co.price_group_id is not null
  and c.price_group_id is null;

update public.customers as c
set price_group_id = (
  select pg.id from public.price_groups as pg where pg.is_default limit 1
)
where c.price_group_id is null;

create index if not exists customers_price_group_id_idx
  on public.customers (price_group_id);

-- ============================================================
-- 3. public.customer_product_prices
-- ============================================================

create table if not exists public.customer_product_prices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  price numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  constraint customer_product_prices_customer_product_unique unique (customer_id, product_id),
  constraint customer_product_prices_price_non_negative check (price >= 0)
);

create index if not exists customer_product_prices_customer_id_idx
  on public.customer_product_prices (customer_id);

create index if not exists customer_product_prices_product_id_idx
  on public.customer_product_prices (product_id);

drop trigger if exists set_customer_product_prices_updated_at on public.customer_product_prices;
create trigger set_customer_product_prices_updated_at
  before update on public.customer_product_prices
  for each row
  execute function public.set_updated_at();

alter table public.customer_product_prices enable row level security;
revoke all on public.customer_product_prices from public, anon, authenticated;

-- ============================================================
-- 4. Migrate company_product_prices → customer_product_prices
-- ============================================================

insert into public.customer_product_prices (customer_id, product_id, price)
select c.id, cpp.product_id, cpp.price
from public.company_product_prices as cpp
join public.customers as c on c.company_id = cpp.company_id
on conflict (customer_id, product_id) do nothing;

-- ============================================================
-- 5. Core price resolution (internal only — no client GRANT)
-- ============================================================

create or replace function public.resolve_product_price(
  p_product_id uuid,
  p_customer_id uuid
)
returns table (
  price numeric,
  price_source text,
  price_group_id uuid,
  price_group_name text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_price_group_id uuid;
  v_individual_price numeric(14, 2);
  v_legacy_price numeric(14, 2);
  v_group_price numeric(14, 2);
  v_base_price numeric(14, 2);
  v_pg_name text;
begin
  select p.base_price into v_base_price
  from public.products as p
  where p.id = p_product_id;

  if p_customer_id is null then
    price := v_base_price;
    price_source := 'base';
    price_group_id := null;
    price_group_name := null;
    return next;
    return;
  end if;

  select * into v_customer
  from public.customers as c
  where c.id = p_customer_id;

  if not found then
    price := v_base_price;
    price_source := 'base';
    price_group_id := null;
    price_group_name := null;
    return next;
    return;
  end if;

  select cpp.price into v_individual_price
  from public.customer_product_prices as cpp
  where cpp.customer_id = p_customer_id
    and cpp.product_id = p_product_id;

  if v_individual_price is not null then
    price := v_individual_price;
    price_source := 'individual';
    price_group_id := v_customer.price_group_id;
    select pg.name into v_pg_name
    from public.price_groups as pg
    where pg.id = v_customer.price_group_id;
    price_group_name := v_pg_name;
    return next;
    return;
  end if;

  if v_customer.company_id is not null then
    select cpp.price into v_legacy_price
    from public.company_product_prices as cpp
    where cpp.company_id = v_customer.company_id
      and cpp.product_id = p_product_id
      and (cpp.valid_from is null or cpp.valid_from <= now())
      and (cpp.valid_to is null or cpp.valid_to >= now())
    limit 1;

    if v_legacy_price is not null then
      price := v_legacy_price;
      price_source := 'legacy_company';
      price_group_id := v_customer.price_group_id;
      select pg.name into v_pg_name
      from public.price_groups as pg
      where pg.id = v_customer.price_group_id;
      price_group_name := v_pg_name;
      return next;
      return;
    end if;
  end if;

  v_price_group_id := v_customer.price_group_id;

  if v_price_group_id is null then
    select pg.id into v_price_group_id
    from public.price_groups as pg
    where pg.is_default
    limit 1;
  end if;

  if v_price_group_id is not null then
    select pp.price into v_group_price
    from public.product_prices as pp
    where pp.product_id = p_product_id
      and pp.price_group_id = v_price_group_id
      and (pp.valid_from is null or pp.valid_from <= now())
      and (pp.valid_to is null or pp.valid_to >= now())
    limit 1;

    if v_group_price is not null then
      select pg.name into v_pg_name
      from public.price_groups as pg
      where pg.id = v_price_group_id;

      price := v_group_price;
      price_source := 'price_group';
      price_group_id := v_price_group_id;
      price_group_name := v_pg_name;
      return next;
      return;
    end if;
  end if;

  price := v_base_price;
  price_source := 'base';
  price_group_id := v_price_group_id;
  select pg.name into v_pg_name
  from public.price_groups as pg
  where pg.id = v_price_group_id;
  price_group_name := v_pg_name;
  return next;
end;
$$;

comment on function public.resolve_product_price(uuid, uuid) is
  'Internal price resolution: individual > legacy_company > price group (assigned or default, including archived) > base. '
  'Null customer_id returns base price. No client GRANT — prevents cross-customer price probing.';

revoke all on function public.resolve_product_price(uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 6. Rewrite get_product_price — guest unchanged (null)
-- ============================================================

create or replace function public.get_product_price(p_product_id uuid)
returns numeric
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_customer_id uuid;
  v_price_group_id uuid;
  v_price numeric;
begin
  if v_user_id is null then
    return null;
  end if;

  select c.id into v_customer_id
  from public.customers as c
  where c.profile_id = v_user_id;

  if v_customer_id is not null then
    return (
      select r.price
      from public.resolve_product_price(p_product_id, v_customer_id) as r
      limit 1
    );
  end if;

  -- Authenticated but no customers row yet: default group → base (no INSERT here;
  -- keep function STABLE). ensure_customer_* still runs on order creation.
  select pg.id into v_price_group_id
  from public.price_groups as pg
  where pg.is_default
  limit 1;

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

comment on function public.get_product_price(uuid) is
  'Storefront price: guests (anon/null uid) see null — same as migration 002; '
  'authenticated users resolved via profile→customer. Never accepts client-supplied customer_id.';

revoke all on function public.get_product_price(uuid) from public;
grant execute on function public.get_product_price(uuid) to anon, authenticated;

-- ============================================================
-- 7. Rewrite staff_resolve_price — dual customer/company lookup
--
-- PostgreSQL 42P13: CREATE OR REPLACE cannot rename input parameters.
-- Existing 011 signature uses p_company_id; Stage 28 uses p_ref_id.
-- Must DROP (exact types, no CASCADE) before CREATE.
-- Callers (staff_search_products / staff_add_order_item) are plpgsql and
-- resolve the name at runtime — no hard pg_depend; DROP without CASCADE OK.
-- ============================================================

drop function if exists public.staff_resolve_price(uuid, uuid);

create or replace function public.staff_resolve_price(p_product_id uuid, p_ref_id uuid)
returns numeric
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  -- BREAKING SEMANTIC CHANGE (011): second argument was company_id, now customer_id.
  -- Compatibility shim: also accepts company_id — resolves via customers.company_id.
  -- Prefer customers.id = p_ref_id; else customers.company_id = p_ref_id.

  if p_ref_id is null then
    return (
      select r.price
      from public.resolve_product_price(p_product_id, null::uuid) as r
      limit 1
    );
  end if;

  select c.id into v_customer_id
  from public.customers as c
  where c.id = p_ref_id;

  if not found then
    select c.id into v_customer_id
    from public.customers as c
    where c.company_id = p_ref_id
    limit 1;
  end if;

  return (
    select r.price
    from public.resolve_product_price(p_product_id, v_customer_id) as r
    limit 1
  );
end;
$$;

comment on function public.staff_resolve_price(uuid, uuid) is
  'Staff/internal price for a product. Second arg: customer_id (preferred) or legacy company_id. '
  'No client GRANT — called only from other SECURITY DEFINER RPCs.';

revoke all on function public.staff_resolve_price(uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 8. staff_search_products — optional p_customer_id
-- ============================================================

-- Drop both legacy (011) and Stage-28 3-arg forms for safe re-runs.
drop function if exists public.staff_search_products(text, integer);
drop function if exists public.staff_search_products(text, integer, uuid);

create or replace function public.staff_search_products(
  p_query text default null,
  p_limit integer default 50,
  p_customer_id uuid default null
)
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

  v_warehouse_id := public.staff_resolve_warehouse_id();

  return query
  select
    p.id as product_id,
    p.name,
    p.sku,
    cat.name as category,
    p.unit,
    public.staff_resolve_price(p.id, p_customer_id) as price,
    v_warehouse_id as warehouse_id,
    w.name as warehouse_name,
    coalesce(i.quantity, 0) as physical_quantity,
    coalesce(i.reserved_quantity, 0) as reserved_quantity,
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

revoke all on function public.staff_search_products(text, integer, uuid) from public, anon, authenticated;
grant execute on function public.staff_search_products(text, integer, uuid) to authenticated;

-- ============================================================
-- 9. staff_add_order_item — full recreate from 012; price via order.customer_id
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

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)', v_order.status;
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
    -- (v_order.customer_id), never for the calling staff member — and only
    -- ever resolved here, at the moment a NEW line is first created.
    v_unit_price := public.staff_resolve_price(p_product_id, v_order.customer_id);

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

revoke all on function public.staff_add_order_item(uuid, uuid, integer) from public;
revoke all on function public.staff_add_order_item(uuid, uuid, integer) from anon;
revoke all on function public.staff_add_order_item(uuid, uuid, integer) from authenticated;
grant execute on function public.staff_add_order_item(uuid, uuid, integer) to authenticated;

-- ============================================================
-- 10. ensure_customer helpers — default price_group_id on insert
-- ============================================================

create or replace function public.ensure_customer_for_company(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company public.companies;
  v_customer_id uuid;
  v_default_group_id uuid;
begin
  if p_company_id is null then
    raise exception 'company_id обязателен';
  end if;

  select pg.id into v_default_group_id
  from public.price_groups as pg
  where pg.is_default
  limit 1;

  select c.id into v_customer_id
  from public.customers as c
  where c.company_id = p_company_id;

  if found then
    if (select c.price_group_id from public.customers as c where c.id = v_customer_id) is null then
      update public.customers as c
      set price_group_id = coalesce(
        (select co.price_group_id from public.companies as co where co.id = p_company_id),
        v_default_group_id
      )
      where c.id = v_customer_id;
    end if;
    return v_customer_id;
  end if;

  select * into v_company
  from public.companies as c
  where c.id = p_company_id;

  if not found then
    raise exception 'Компания не найдена';
  end if;

  insert into public.customers (
    customer_type,
    company_id,
    display_name,
    legal_name,
    phone,
    email,
    iin_bin,
    source,
    price_group_id
  )
  select
    'company',
    v_company.id,
    v_company.name,
    v_company.name,
    nullif(trim(v_company.phone), ''),
    nullif(trim(v_company.email), ''),
    nullif(trim(v_company.bin), ''),
    'website',
    coalesce(v_company.price_group_id, v_default_group_id)
  where not exists (
    select 1 from public.customers as c where c.company_id = p_company_id
  )
  returning id into v_customer_id;

  if v_customer_id is null then
    select c.id into v_customer_id
    from public.customers as c
    where c.company_id = p_company_id;
  end if;

  if v_customer_id is null then
    raise exception 'Не удалось создать customer для компании %', p_company_id;
  end if;

  return v_customer_id;
end;
$$;

revoke all on function public.ensure_customer_for_company(uuid) from public, anon, authenticated;

create or replace function public.ensure_customer_for_profile(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
  v_email text;
  v_customer_id uuid;
  v_display_name text;
  v_default_group_id uuid;
begin
  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

  select pg.id into v_default_group_id
  from public.price_groups as pg
  where pg.is_default
  limit 1;

  select * into v_profile
  from public.profiles as p
  where p.id = p_profile_id;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_profile.customer_type = 'company' and v_profile.company_id is not null then
    return public.ensure_customer_for_company(v_profile.company_id);
  end if;

  select c.id into v_customer_id
  from public.customers as c
  where c.profile_id = p_profile_id;

  if found then
    if (select c.price_group_id from public.customers as c where c.id = v_customer_id) is null then
      update public.customers as c
      set price_group_id = v_default_group_id
      where c.id = v_customer_id;
    end if;
    return v_customer_id;
  end if;

  select au.email::text into v_email
  from auth.users as au
  where au.id = p_profile_id;

  v_display_name := nullif(trim(v_profile.full_name), '');
  if v_display_name is null then
    v_display_name := coalesce(nullif(trim(v_email), ''), 'Клиент');
  end if;

  insert into public.customers (
    customer_type,
    profile_id,
    display_name,
    phone,
    email,
    source,
    price_group_id
  )
  select
    'individual',
    v_profile.id,
    v_display_name,
    nullif(trim(v_profile.phone), ''),
    nullif(trim(v_email), ''),
    'website',
    v_default_group_id
  where not exists (
    select 1 from public.customers as c where c.profile_id = p_profile_id
  )
  returning id into v_customer_id;

  if v_customer_id is null then
    select c.id into v_customer_id
    from public.customers as c
    where c.profile_id = p_profile_id;
  end if;

  if v_customer_id is null then
    raise exception 'Не удалось создать customer для профиля %', p_profile_id;
  end if;

  return v_customer_id;
end;
$$;

revoke all on function public.ensure_customer_for_profile(uuid) from public, anon, authenticated;

-- ============================================================
-- 11. staff_get_customer — add price group fields
-- ============================================================

drop function if exists public.staff_get_customer(uuid);

create or replace function public.staff_get_customer(p_customer_id uuid)
returns table (
  id uuid,
  customer_type text,
  profile_id uuid,
  company_id uuid,
  display_name text,
  legal_name text,
  phone text,
  email text,
  iin_bin text,
  contact_person text,
  address text,
  city text,
  source text,
  notes text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  is_registered boolean,
  orders_count bigint,
  last_order_at timestamptz,
  price_group_id uuid,
  price_group_name text,
  price_group_is_default boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['manager', 'accountant', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для просмотра клиента';
  end if;

  if p_customer_id is null then
    raise exception 'Не указан клиент';
  end if;

  return query
  select
    c.id,
    c.customer_type,
    c.profile_id,
    c.company_id,
    c.display_name,
    c.legal_name,
    c.phone,
    c.email,
    c.iin_bin,
    c.contact_person,
    c.address,
    c.city,
    c.source,
    c.notes,
    c.created_by,
    c.created_at,
    c.updated_at,
    (c.profile_id is not null) as is_registered,
    coalesce(stats.orders_count, 0) as orders_count,
    stats.last_order_at,
    pg.id as price_group_id,
    pg.name as price_group_name,
    coalesce(pg.is_default, false) as price_group_is_default
  from public.customers as c
  left join public.price_groups as pg on pg.id = c.price_group_id
  left join lateral (
    select
      count(*)::bigint as orders_count,
      max(o.created_at) as last_order_at
    from public.orders as o
    where o.customer_id = c.id
  ) as stats on true
  where c.id = p_customer_id;
end;
$$;

revoke all on function public.staff_get_customer(uuid) from public, anon, authenticated;
grant execute on function public.staff_get_customer(uuid) to authenticated;

-- ============================================================
-- 12. staff_create_customer — default price group on insert
-- ============================================================

create or replace function public.staff_create_customer(
  p_customer_type text,
  p_display_name text,
  p_legal_name text default null,
  p_phone text default null,
  p_email text default null,
  p_iin_bin text default null,
  p_contact_person text default null,
  p_address text default null,
  p_city text default null,
  p_source text default 'staff',
  p_notes text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text;
  v_display_name text;
  v_legal_name text;
  v_phone text;
  v_email text;
  v_iin_bin text;
  v_contact_person text;
  v_address text;
  v_city text;
  v_source text;
  v_notes text;
  v_customer public.customers;
  v_default_group_id uuid;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для создания клиента';
  end if;

  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  v_type := nullif(trim(p_customer_type), '');
  if v_type is null or v_type not in ('individual', 'company') then
    raise exception 'Некорректный тип клиента';
  end if;

  v_display_name := nullif(trim(p_display_name), '');
  if v_display_name is null then
    raise exception 'Имя клиента обязательно';
  end if;

  v_legal_name := nullif(trim(p_legal_name), '');
  v_phone := nullif(trim(p_phone), '');
  v_email := nullif(trim(p_email), '');
  v_iin_bin := nullif(trim(p_iin_bin), '');
  v_contact_person := nullif(trim(p_contact_person), '');
  v_address := nullif(trim(p_address), '');
  v_city := nullif(trim(p_city), '');
  v_source := coalesce(nullif(trim(p_source), ''), 'staff');
  v_notes := nullif(trim(p_notes), '');

  if v_source not in ('website', 'staff', 'phone', 'whatsapp', 'instagram', 'referral', 'other') then
    raise exception 'Некорректный источник клиента';
  end if;

  if v_type = 'individual' then
    if v_phone is null and v_email is null then
      raise exception 'Укажите телефон или email';
    end if;
  else
    if v_phone is null and v_email is null and v_contact_person is null then
      raise exception 'Укажите телефон, email или контактное лицо';
    end if;
  end if;

  select pg.id into v_default_group_id
  from public.price_groups as pg
  where pg.is_default
  limit 1;

  insert into public.customers (
    customer_type,
    display_name,
    legal_name,
    phone,
    email,
    iin_bin,
    contact_person,
    address,
    city,
    source,
    notes,
    created_by,
    price_group_id
  ) values (
    v_type,
    v_display_name,
    v_legal_name,
    v_phone,
    v_email,
    v_iin_bin,
    v_contact_person,
    v_address,
    v_city,
    v_source,
    v_notes,
    auth.uid(),
    v_default_group_id
  )
  returning * into v_customer;

  return v_customer;
end;
$$;

revoke all on function public.staff_create_customer(
  text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.staff_create_customer(
  text, text, text, text, text, text, text, text, text, text, text
) to authenticated;

-- ============================================================
-- 13. Price group listing — staff read + admin mutations
-- ============================================================

create or replace function public.staff_list_price_groups(p_include_inactive boolean default false)
returns table (
  id uuid,
  name text,
  code text,
  description text,
  sort_order integer,
  is_default boolean,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  return query
  select
    pg.id,
    pg.name,
    pg.code,
    pg.description,
    pg.sort_order,
    pg.is_default,
    pg.is_active,
    pg.created_at,
    pg.updated_at
  from public.price_groups as pg
  where p_include_inactive or pg.is_active
  order by pg.sort_order, pg.name;
end;
$$;

revoke all on function public.staff_list_price_groups(boolean) from public, anon, authenticated;
grant execute on function public.staff_list_price_groups(boolean) to authenticated;

create or replace function public.admin_list_price_groups(p_include_inactive boolean default true)
returns table (
  id uuid,
  name text,
  code text,
  description text,
  sort_order integer,
  is_default boolean,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  return query
  select
    pg.id,
    pg.name,
    pg.code,
    pg.description,
    pg.sort_order,
    pg.is_default,
    pg.is_active,
    pg.created_at,
    pg.updated_at
  from public.price_groups as pg
  where p_include_inactive or pg.is_active
  order by pg.sort_order, pg.name;
end;
$$;

revoke all on function public.admin_list_price_groups(boolean) from public, anon, authenticated;
grant execute on function public.admin_list_price_groups(boolean) to authenticated;

create or replace function public.admin_create_price_group(
  p_name text,
  p_code text,
  p_sort_order integer default 0
)
returns public.price_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_code text;
  v_row public.price_groups;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  v_name := nullif(trim(p_name), '');
  v_code := nullif(trim(p_code), '');

  if v_name is null then
    raise exception 'Название ценовой группы обязательно';
  end if;

  if v_code is null then
    raise exception 'Код ценовой группы обязателен';
  end if;

  if exists (select 1 from public.price_groups as pg where pg.name = v_name) then
    raise exception 'Ценовая группа с таким названием уже существует';
  end if;

  if exists (select 1 from public.price_groups as pg where pg.code = v_code) then
    raise exception 'Ценовая группа с таким кодом уже существует';
  end if;

  insert into public.price_groups (name, code, sort_order, is_default, is_active)
  values (v_name, v_code, coalesce(p_sort_order, 0), false, true)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_create_price_group(text, text, integer) from public, anon, authenticated;
grant execute on function public.admin_create_price_group(text, text, integer) to authenticated;

create or replace function public.admin_update_price_group(
  p_id uuid,
  p_name text default null,
  p_code text default null,
  p_sort_order integer default null
)
returns public.price_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.price_groups;
  v_name text;
  v_code text;
  v_sort_order integer;
  v_row public.price_groups;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_id is null then
    raise exception 'Не указана ценовая группа';
  end if;

  select * into v_existing
  from public.price_groups as pg
  where pg.id = p_id
  for update;

  if not found then
    raise exception 'Ценовая группа не найдена';
  end if;

  v_name := coalesce(nullif(trim(p_name), ''), v_existing.name);
  v_code := coalesce(nullif(trim(p_code), ''), v_existing.code);
  v_sort_order := coalesce(p_sort_order, v_existing.sort_order);

  if exists (
    select 1 from public.price_groups as pg
    where pg.name = v_name and pg.id <> p_id
  ) then
    raise exception 'Ценовая группа с таким названием уже существует';
  end if;

  if exists (
    select 1 from public.price_groups as pg
    where pg.code = v_code and pg.id <> p_id
  ) then
    raise exception 'Ценовая группа с таким кодом уже существует';
  end if;

  update public.price_groups as pg
  set name = v_name,
      code = v_code,
      sort_order = v_sort_order
  where pg.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_update_price_group(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.admin_update_price_group(uuid, text, text, integer) to authenticated;

create or replace function public.admin_set_default_price_group(p_id uuid)
returns public.price_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.price_groups;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_id is null then
    raise exception 'Не указана ценовая группа';
  end if;

  lock table public.price_groups in exclusive mode;

  select * into v_row
  from public.price_groups as pg
  where pg.id = p_id
  for update;

  if not found then
    raise exception 'Ценовая группа не найдена';
  end if;

  if not v_row.is_active then
    raise exception 'Нельзя назначить группу по умолчанию для архивной ценовой группы';
  end if;

  update public.price_groups as pg
  set is_default = false
  where pg.is_default;

  update public.price_groups as pg
  set is_default = true
  where pg.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_set_default_price_group(uuid) from public, anon, authenticated;
grant execute on function public.admin_set_default_price_group(uuid) to authenticated;

create or replace function public.admin_archive_price_group(p_id uuid)
returns public.price_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.price_groups;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_id is null then
    raise exception 'Не указана ценовая группа';
  end if;

  select * into v_row
  from public.price_groups as pg
  where pg.id = p_id
  for update;

  if not found then
    raise exception 'Ценовая группа не найдена';
  end if;

  if v_row.is_default then
    raise exception 'Нельзя архивировать ценовую группу по умолчанию';
  end if;

  update public.price_groups as pg
  set is_active = false
  where pg.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.admin_archive_price_group(uuid) is
  'Archives a price group. Customers already assigned keep resolving prices from this group.';

revoke all on function public.admin_archive_price_group(uuid) from public, anon, authenticated;
grant execute on function public.admin_archive_price_group(uuid) to authenticated;

create or replace function public.admin_restore_price_group(p_id uuid)
returns public.price_groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.price_groups;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_id is null then
    raise exception 'Не указана ценовая группа';
  end if;

  update public.price_groups as pg
  set is_active = true
  where pg.id = p_id
  returning * into v_row;

  if not found then
    raise exception 'Ценовая группа не найдена';
  end if;

  return v_row;
end;
$$;

revoke all on function public.admin_restore_price_group(uuid) from public, anon, authenticated;
grant execute on function public.admin_restore_price_group(uuid) to authenticated;

create or replace function public.admin_reorder_price_groups(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_id uuid;
  v_sort integer;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Ожидается JSON-массив [{id, sort_order}, ...]';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_id := (v_item->>'id')::uuid;
    v_sort := (v_item->>'sort_order')::integer;

    if v_id is null or v_sort is null then
      raise exception 'Каждый элемент должен содержать id и sort_order';
    end if;

    if not exists (select 1 from public.price_groups as pg where pg.id = v_id) then
      raise exception 'Ценовая группа не найдена: %', v_id;
    end if;

    update public.price_groups as pg
    set sort_order = v_sort
    where pg.id = v_id;
  end loop;
end;
$$;

revoke all on function public.admin_reorder_price_groups(jsonb) from public, anon, authenticated;
grant execute on function public.admin_reorder_price_groups(jsonb) to authenticated;

-- ============================================================
-- 14. Product group prices
-- ============================================================

create or replace function public.staff_get_product_prices(p_product_id uuid)
returns table (
  price_group_id uuid,
  price_group_name text,
  price_group_code text,
  sort_order integer,
  is_active boolean,
  is_default boolean,
  price numeric,
  has_explicit_price boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_id is null then
    raise exception 'Не указан товар';
  end if;

  if not exists (select 1 from public.products as p where p.id = p_product_id) then
    raise exception 'Товар не найден';
  end if;

  return query
  select
    pg.id as price_group_id,
    pg.name as price_group_name,
    pg.code as price_group_code,
    pg.sort_order,
    pg.is_active,
    pg.is_default,
    pp.price,
    (pp.id is not null) as has_explicit_price
  from public.price_groups as pg
  left join public.product_prices as pp
    on pp.price_group_id = pg.id
   and pp.product_id = p_product_id
  order by pg.sort_order, pg.name;
end;
$$;

revoke all on function public.staff_get_product_prices(uuid) from public, anon, authenticated;
grant execute on function public.staff_get_product_prices(uuid) to authenticated;

create or replace function public.admin_upsert_product_group_price(
  p_product_id uuid,
  p_price_group_id uuid,
  p_price numeric
)
returns public.product_prices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.product_prices;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_id is null or p_price_group_id is null then
    raise exception 'product_id и price_group_id обязательны';
  end if;

  if p_price is null or p_price < 0 then
    raise exception 'Цена должна быть неотрицательным числом';
  end if;

  if not exists (select 1 from public.products as p where p.id = p_product_id) then
    raise exception 'Товар не найден';
  end if;

  if not exists (select 1 from public.price_groups as pg where pg.id = p_price_group_id) then
    raise exception 'Ценовая группа не найдена';
  end if;

  insert into public.product_prices (product_id, price_group_id, price)
  values (p_product_id, p_price_group_id, p_price)
  on conflict (product_id, price_group_id)
  do update set price = excluded.price
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_upsert_product_group_price(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.admin_upsert_product_group_price(uuid, uuid, numeric) to authenticated;

create or replace function public.admin_delete_product_group_price(
  p_product_id uuid,
  p_price_group_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_id is null or p_price_group_id is null then
    raise exception 'product_id и price_group_id обязательны';
  end if;

  delete from public.product_prices as pp
  where pp.product_id = p_product_id
    and pp.price_group_id = p_price_group_id;

  if not found then
    raise exception 'Переопределение цены для этой группы не найдено';
  end if;
end;
$$;

revoke all on function public.admin_delete_product_group_price(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_product_group_price(uuid, uuid) to authenticated;

create or replace function public.admin_batch_upsert_product_group_prices(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_product_id uuid;
  v_price_group_id uuid;
  v_price numeric;
  v_count integer := 0;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Ожидается JSON-массив [{product_id, price_group_id, price}, ...]';
  end if;

  for v_item in select * from jsonb_array_elements(p_rows)
  loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_price_group_id := (v_item->>'price_group_id')::uuid;
    v_price := (v_item->>'price')::numeric;

    if v_product_id is null or v_price_group_id is null then
      raise exception 'Каждый элемент должен содержать product_id и price_group_id';
    end if;

    if v_price is null then
      delete from public.product_prices as pp
      where pp.product_id = v_product_id
        and pp.price_group_id = v_price_group_id;
    else
      if v_price < 0 then
        raise exception 'Цена должна быть неотрицательным числом';
      end if;

      insert into public.product_prices (product_id, price_group_id, price)
      values (v_product_id, v_price_group_id, v_price)
      on conflict (product_id, price_group_id)
      do update set price = excluded.price;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.admin_batch_upsert_product_group_prices(jsonb) is
  'Matrix page batch upsert. null price in a row = explicit DELETE of that product_prices override '
  '(matrix explicit clear). Non-null price upserts. Distinct from admin_bulk_update_product_prices reset semantics.';

revoke all on function public.admin_batch_upsert_product_group_prices(jsonb) from public, anon, authenticated;
grant execute on function public.admin_batch_upsert_product_group_prices(jsonb) to authenticated;

create or replace function public.admin_list_pricing_matrix(
  p_query text default null,
  p_category_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  product_id uuid,
  sku text,
  name text,
  category_name text,
  base_price numeric,
  group_prices jsonb
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_offset integer;
  v_term text;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  return query
  select
    p.id as product_id,
    p.sku,
    p.name,
    c.name as category_name,
    p.base_price,
    coalesce(
      (
        select jsonb_object_agg(pp.price_group_id::text, pp.price)
        from public.product_prices as pp
        where pp.product_id = p.id
      ),
      '{}'::jsonb
    ) as group_prices
  from public.products as p
  left join public.categories as c on c.id = p.category_id
  where (p_category_id is null or p.category_id = p_category_id)
    and (
      v_term is null
      or p.name ilike ('%' || v_term || '%') escape '\'
      or p.sku ilike ('%' || v_term || '%') escape '\'
    )
  order by p.name
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.admin_list_pricing_matrix(text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_list_pricing_matrix(text, uuid, integer, integer) to authenticated;

create or replace function public.admin_bulk_update_product_prices(
  p_product_ids uuid[],
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_ids uuid[];
  v_base_action text := 'keep';
  v_base_price numeric(14, 2);
  v_groups jsonb := '[]'::jsonb;
  v_group_item jsonb;
  v_group_id uuid;
  v_group_action text;
  v_group_price numeric(14, 2);
  v_updated_products integer := 0;
  v_base_updates integer := 0;
  v_group_sets integer := 0;
  v_group_resets integer := 0;
  v_missing integer;
  v_deleted integer;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_ids is null or cardinality(p_product_ids) = 0 then
    raise exception 'Не указаны товары';
  end if;

  select coalesce(array_agg(distinct pid), array[]::uuid[])
  into v_product_ids
  from unnest(p_product_ids) as pid;

  if cardinality(v_product_ids) = 0 then
    raise exception 'Не указаны товары';
  end if;

  if cardinality(v_product_ids) > 500 then
    raise exception 'Слишком много товаров (максимум 500 за один запрос)';
  end if;

  select count(*) into v_missing
  from unnest(v_product_ids) as pid
  where not exists (select 1 from public.products as p where p.id = pid);

  if v_missing > 0 then
    raise exception 'Один или несколько товаров не найдены';
  end if;

  if p_payload is not null
     and p_payload ? 'base'
     and jsonb_typeof(p_payload->'base') = 'object'
  then
    v_base_action := coalesce(nullif(trim(p_payload->'base'->>'action'), ''), 'keep');

    if v_base_action = 'set' then
      v_base_price := (p_payload->'base'->>'price')::numeric;
      if v_base_price is null or v_base_price < 0 then
        raise exception 'Базовая цена должна быть неотрицательным числом';
      end if;
    elsif v_base_action <> 'keep' then
      raise exception 'Некорректное действие для base: %', v_base_action;
    end if;
  end if;

  if p_payload is not null and p_payload ? 'groups' and p_payload->'groups' is not null then
    v_groups := p_payload->'groups';
    if jsonb_typeof(v_groups) <> 'array' then
      raise exception 'groups должен быть JSON-массивом';
    end if;
  end if;

  for v_group_item in select * from jsonb_array_elements(v_groups)
  loop
    v_group_id := (v_group_item->>'price_group_id')::uuid;
    v_group_action := coalesce(nullif(trim(v_group_item->>'action'), ''), 'keep');

    if v_group_id is null then
      raise exception 'Каждый элемент groups должен содержать price_group_id';
    end if;

    if v_group_action not in ('keep', 'set', 'reset') then
      raise exception 'Некорректное действие для группы: %', v_group_action;
    end if;

    if v_group_action in ('set', 'reset') then
      if not exists (
        select 1 from public.price_groups as pg
        where pg.id = v_group_id and pg.is_active
      ) then
        raise exception 'Ценовая группа не найдена или архивирована: %', v_group_id;
      end if;
    end if;

    if v_group_action = 'set' then
      v_group_price := (v_group_item->>'price')::numeric;
      if v_group_price is null or v_group_price < 0 then
        raise exception 'Цена группы должна быть неотрицательным числом';
      end if;
    end if;
  end loop;

  if v_base_action = 'set' then
    update public.products as p
    set base_price = v_base_price
    where p.id = any(v_product_ids);
    get diagnostics v_base_updates = row_count;
  end if;

  for v_group_item in select * from jsonb_array_elements(v_groups)
  loop
    v_group_id := (v_group_item->>'price_group_id')::uuid;
    v_group_action := coalesce(nullif(trim(v_group_item->>'action'), ''), 'keep');

    if v_group_action = 'keep' then
      continue;
    end if;

    if v_group_action = 'set' then
      v_group_price := (v_group_item->>'price')::numeric;
      insert into public.product_prices (product_id, price_group_id, price)
      select pid, v_group_id, v_group_price
      from unnest(v_product_ids) as pid
      on conflict (product_id, price_group_id)
      do update set price = excluded.price;
      v_group_sets := v_group_sets + cardinality(v_product_ids);
    elsif v_group_action = 'reset' then
      delete from public.product_prices as pp
      where pp.price_group_id = v_group_id
        and pp.product_id = any(v_product_ids);
      get diagnostics v_deleted = row_count;
      v_group_resets := v_group_resets + v_deleted;
    end if;
  end loop;

  v_updated_products := cardinality(v_product_ids);

  return jsonb_build_object(
    'updated_products', v_updated_products,
    'base_updates', v_base_updates,
    'group_sets', v_group_sets,
    'group_resets', v_group_resets
  );
end;
$$;

comment on function public.admin_bulk_update_product_prices(uuid[], jsonb) is
  'Bulk price update for multiple products in one transaction. '
  'Payload: { base: {action: keep|set, price?}, groups: [{price_group_id, action: keep|set|reset, price?}] }. '
  'reset deletes product_prices row (fallback to base). Missing/null sections treated as keep.';

revoke all on function public.admin_bulk_update_product_prices(uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.admin_bulk_update_product_prices(uuid[], jsonb) to authenticated;

-- ============================================================
-- 15. Customer pricing
-- ============================================================

create or replace function public.admin_set_customer_price_group(
  p_customer_id uuid,
  p_price_group_id uuid
)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_customer_id is null or p_price_group_id is null then
    raise exception 'customer_id и price_group_id обязательны';
  end if;

  select * into v_customer
  from public.customers as c
  where c.id = p_customer_id
  for update;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  if not exists (select 1 from public.price_groups as pg where pg.id = p_price_group_id) then
    raise exception 'Ценовая группа не найдена';
  end if;

  if p_price_group_id is distinct from v_customer.price_group_id then
    if not exists (
      select 1 from public.price_groups as pg
      where pg.id = p_price_group_id and pg.is_active
    ) then
      raise exception 'Нельзя назначить архивную ценовую группу новому клиенту';
    end if;
  end if;

  update public.customers as c
  set price_group_id = p_price_group_id
  where c.id = p_customer_id
  returning * into v_customer;

  return v_customer;
end;
$$;

comment on function public.admin_set_customer_price_group(uuid, uuid) is
  'Assigns price group to customer. New assignments require an active group; '
  'existing archived assignments remain valid for price resolution.';

revoke all on function public.admin_set_customer_price_group(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_customer_price_group(uuid, uuid) to authenticated;

create or replace function public.staff_list_customer_product_prices(p_customer_id uuid)
returns table (
  product_id uuid,
  sku text,
  name text,
  base_price numeric,
  group_price numeric,
  individual_price numeric,
  effective_price numeric,
  price_source text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_price_group_id uuid;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_customer_id is null then
    raise exception 'Не указан клиент';
  end if;

  select * into v_customer
  from public.customers as c
  where c.id = p_customer_id;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  v_price_group_id := v_customer.price_group_id;
  if v_price_group_id is null then
    select pg.id into v_price_group_id
    from public.price_groups as pg
    where pg.is_default
    limit 1;
  end if;

  return query
  select
    p.id as product_id,
    p.sku,
    p.name,
    p.base_price,
    pp.price as group_price,
    cpp.price as individual_price,
    r.price as effective_price,
    r.price_source
  from public.customer_product_prices as cpp
  join public.products as p on p.id = cpp.product_id
  left join public.product_prices as pp
    on pp.product_id = p.id
   and pp.price_group_id = v_price_group_id
   and (pp.valid_from is null or pp.valid_from <= now())
   and (pp.valid_to is null or pp.valid_to >= now())
  left join lateral (
    select rp.price, rp.price_source
    from public.resolve_product_price(p.id, p_customer_id) as rp
  ) as r on true
  where cpp.customer_id = p_customer_id
  order by p.name;
end;
$$;

revoke all on function public.staff_list_customer_product_prices(uuid) from public, anon, authenticated;
grant execute on function public.staff_list_customer_product_prices(uuid) to authenticated;

create or replace function public.admin_upsert_customer_product_price(
  p_customer_id uuid,
  p_product_id uuid,
  p_price numeric
)
returns public.customer_product_prices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.customer_product_prices;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_customer_id is null or p_product_id is null then
    raise exception 'customer_id и product_id обязательны';
  end if;

  if p_price is null or p_price < 0 then
    raise exception 'Цена должна быть неотрицательным числом';
  end if;

  if not exists (select 1 from public.customers as c where c.id = p_customer_id) then
    raise exception 'Клиент не найден';
  end if;

  if not exists (select 1 from public.products as p where p.id = p_product_id) then
    raise exception 'Товар не найден';
  end if;

  insert into public.customer_product_prices (
    customer_id, product_id, price, created_by
  ) values (
    p_customer_id, p_product_id, p_price, auth.uid()
  )
  on conflict (customer_id, product_id)
  do update set
    price = excluded.price,
    created_by = coalesce(excluded.created_by, public.customer_product_prices.created_by)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_upsert_customer_product_price(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.admin_upsert_customer_product_price(uuid, uuid, numeric) to authenticated;

create or replace function public.admin_delete_customer_product_price(
  p_customer_id uuid,
  p_product_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_customer_id is null or p_product_id is null then
    raise exception 'customer_id и product_id обязательны';
  end if;

  delete from public.customer_product_prices as cpp
  where cpp.customer_id = p_customer_id
    and cpp.product_id = p_product_id;

  if not found then
    raise exception 'Индивидуальная цена не найдена';
  end if;
end;
$$;

revoke all on function public.admin_delete_customer_product_price(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_customer_product_price(uuid, uuid) to authenticated;

-- ============================================================
-- 16. admin_get_data_usage — include pricing tables
-- ============================================================

create or replace function public.admin_get_data_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_db_bytes bigint := 0;
  v_week_ago timestamptz := now() - interval '7 days';
  v_month_ago timestamptz := now() - interval '30 days';
  v_retention integer;
  v_raw_expired integer := 0;
  v_growth jsonb;
  v_settings public.data_retention_settings;
begin
  perform public.data_lifecycle_assert_admin();

  select coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'table_name', t.relname,
        'row_estimate', greatest(t.n_live_tup, 0),
        'total_bytes', pg_total_relation_size(t.relid),
        'bytes_is_estimate', true
      )
      order by pg_total_relation_size(t.relid) desc
    )
    from pg_catalog.pg_stat_user_tables as t
    where t.schemaname = 'public'
      and t.relname in (
        'orders','order_items','order_payments','order_documents',
        'products','categories','customers','profiles',
        'analytics_events','analytics_sessions',
        'analytics_aggregates_daily','analytics_aggregates_weekly','analytics_aggregates_monthly',
        'inventory','data_archives','document_asset_snapshot_intents','product_images',
        'price_groups','product_prices','customer_product_prices','company_product_prices'
      )
  ), '[]'::jsonb) into v_tables;

  select coalesce(sum(pg_total_relation_size(c.oid)), 0) into v_db_bytes
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','i','t','m');

  select jsonb_build_object(
    'products', (select count(*)::integer from public.products),
    'categories', (select count(*)::integer from public.categories),
    'customers', (select count(*)::integer from public.customers),
    'orders', (select count(*)::integer from public.orders where coalesce(is_test,false)=false),
    'test_orders', (select count(*)::integer from public.orders where is_test = true),
    'order_items', (
      select count(*)::integer from public.order_items oi
      join public.orders o on o.id = oi.order_id where coalesce(o.is_test,false)=false
    ),
    'payments', (
      select count(*)::integer from public.order_payments p
      join public.orders o on o.id = p.order_id where coalesce(o.is_test,false)=false
    ),
    'documents', (select count(*)::integer from public.order_documents),
    'analytics_sessions', (select count(*)::integer from public.analytics_sessions),
    'analytics_events', (select count(*)::integer from public.analytics_events),
    'storage_snapshots', (
      select count(*)::integer from public.document_asset_snapshot_intents
      where status in ('consumed','pending')
    ),
    'data_archives', (select count(*)::integer from public.data_archives),
    'aggregates_daily', (select count(*)::integer from public.analytics_aggregates_daily),
    'aggregates_weekly', (select count(*)::integer from public.analytics_aggregates_weekly),
    'aggregates_monthly', (select count(*)::integer from public.analytics_aggregates_monthly),
    'product_image_refs', (
      select count(*)::integer from public.products where main_photo_path is not null
    ),
    'price_groups', (select count(*)::integer from public.price_groups),
    'product_prices', (select count(*)::integer from public.product_prices),
    'customer_product_prices', (select count(*)::integer from public.customer_product_prices),
    'company_product_prices', (select count(*)::integer from public.company_product_prices)
  ) into v_counts;

  select jsonb_build_object(
    'orders_week', (select count(*)::integer from public.orders where created_at >= v_week_ago and coalesce(is_test,false)=false),
    'orders_month', (select count(*)::integer from public.orders where created_at >= v_month_ago and coalesce(is_test,false)=false),
    'analytics_events_week', (select count(*)::integer from public.analytics_events where created_at >= v_week_ago),
    'analytics_events_month', (select count(*)::integer from public.analytics_events where created_at >= v_month_ago),
    'documents_week', (select count(*)::integer from public.order_documents where created_at >= v_week_ago),
    'documents_month', (select count(*)::integer from public.order_documents where created_at >= v_month_ago),
    'customers_week', (select count(*)::integer from public.customers where created_at >= v_week_ago),
    'customers_month', (select count(*)::integer from public.customers where created_at >= v_month_ago)
  ) into v_growth;

  select * into v_settings from public.data_retention_settings where singleton_key = 'default';
  v_retention := coalesce(v_settings.raw_analytics_days, 90);

  select count(*)::integer into v_raw_expired
  from public.analytics_events
  where created_at < now() - make_interval(days => v_retention);

  return jsonb_build_object(
    'timezone', 'Asia/Almaty',
    'counts', v_counts,
    'growth', v_growth,
    'largest_tables', v_tables,
    'database', jsonb_build_object(
      'approx_bytes', v_db_bytes,
      'approx_mb', round((v_db_bytes::numeric / (1024*1024)), 2),
      'bytes_is_estimate', true,
      'label', 'оценка (pg_total_relation_size)'
    ),
    'storage', jsonb_build_object(
      'note', 'Точный объём Storage — через server API (object count / listed size). Не смешивать с DB estimate.',
      'buckets', jsonb_build_array('product-images','organization-assets','data-archives'),
      'bytes_is_estimate', true
    ),
    'retention', jsonb_build_object(
      'raw_analytics_days', v_retention,
      'raw_analytics_expired_events', v_raw_expired,
      'last_aggregated_at', v_settings.last_aggregated_at,
      'last_cleanup_at', v_settings.last_cleanup_at,
      'last_cleanup_cutoff', v_settings.last_cleanup_cutoff
    )
  );
end;
$$;

revoke all on function public.admin_get_data_usage() from public, anon, authenticated;
grant execute on function public.admin_get_data_usage() to authenticated;

-- ============================================================
-- 17. Client pricing surface lockdown (Stage 28 security fix)
--
-- Problem (002): GRANT SELECT ON products to anon/authenticated exposed
-- products.base_price via PostgREST. Price list tables already had no
-- SELECT policy; reinforce revokes and strip base_price from client grants.
--
-- Architecture:
--   - Client catalog: get_catalog() / get_product_price() only (sale_price)
--   - Guest sale_price = null (unchanged)
--   - Staff/admin: SECURITY DEFINER RPCs (unchanged)
--   - No security-by-UI
-- ============================================================

-- Reinstate: pricing tables — no direct client access
revoke all on public.price_groups from anon, authenticated;
revoke all on public.product_prices from anon, authenticated;
revoke all on public.company_product_prices from anon, authenticated;
revoke all on public.customer_product_prices from anon, authenticated;

-- products: replace table-level SELECT with column-level grant EXCLUDING base_price.
-- Table-level GRANT SELECT cannot hide a column; must revoke then grant columns.
revoke select on public.products from anon, authenticated;

-- RLS policy products_select_active (status = 'active') remains — applies to
-- any remaining column grants for anon/authenticated.
grant select (
  id,
  category_id,
  subcategory_id,
  name,
  slug,
  sku,
  original_sku,
  description,
  dimensions,
  unit,
  status,
  is_promotion,
  min_order_qty,
  length_mm,
  width_mm,
  thickness_mm,
  weight_kg,
  main_photo_path,
  created_at,
  updated_at
) on public.products to anon, authenticated;

comment on column public.products.base_price is
  'Internal catalog fallback price. Not granted to anon/authenticated — '
  'resolved only via get_product_price / get_catalog / staff SECURITY DEFINER RPCs.';

-- Verification notes (run manually after apply; not executed here):
--   set role anon;  select base_price from products limit 1;  -- must ERROR
--   set role authenticated; select base_price from products limit 1; -- must ERROR
--   select * from product_prices limit 1; -- must fail / empty under RLS
--   select * from customer_product_prices limit 1; -- must fail
--   select * from company_product_prices limit 1; -- must fail
--   select sale_price from get_catalog() limit 1; -- works; guest null
