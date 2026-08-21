-- DEKORO Platform — Stage 41: order pricing engine
-- Migration: quantity tiers, manager price override, price snapshots, cost guard
--
-- NOT applied automatically — run once in Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–040 files. Safe to re-run (IDL uses
-- IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS before CREATE).
--
-- Builds on the existing pricing architecture instead of a parallel module:
--   - public.products.base_price            → "base/list price" (unchanged)
--   - public.price_groups / product_prices   → price groups (unchanged)
--   - public.customer_product_prices         → individual customer price (unchanged)
--   - public.resolve_product_price()         → customer/group/base resolution (unchanged,
--                                               still the single source of "customer condition" price)
--   - public.order_items                     → extended with price snapshot columns
--   - public.order_activity_log              → reused for manager-override audit trail
--
-- New in this migration:
--   - public.product_quantity_prices         → quantity tiers (min_quantity → price)
--   - public.pricing_guard_settings          → singleton: max manager discount %, min margin % over cost
--   - public.resolve_order_item_price()      → quantity+customer aware resolution, "most favorable" rule
--   - public.get_cart_pricing()              → batch client-facing preview (cart/product page)
--   - public.staff_set_order_item_price() / staff_reset_order_item_price() → manager override + reset
--   - public.staff_get_customer_product_price_history() → "last price for this customer" helper
--   - Tier + guard-settings CRUD RPCs (admin write, manager+admin read)
--   - create_order() / staff_add_order_item() / staff_update_order_item_quantity() rewritten
--     internally to use the new resolution — signatures unchanged, no frontend break
--   - get_catalog() extended with list_price (base_price) for the strikethrough/badge UX
--
-- VAT (040) is untouched: order_items.unit_price / line_total remain the final,
-- VAT-inclusive selling price; VAT is still extracted (not added) at document time.
-- Landed cost (036) is untouched: pricing_latest_landed_cost() only *reads* it,
-- never writes, and is never returned by any RPC granted to manager/client.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null
     or to_regclass('public.price_groups') is null
     or to_regclass('public.product_prices') is null
  then
    raise exception 'Base pricing tables missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.customers') is null
     or to_regclass('public.customer_product_prices') is null
     or to_regprocedure('public.resolve_product_price(uuid, uuid)') is null
  then
    raise exception 'Customer pricing missing — run 028_customer_pricing.sql first.';
  end if;

  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception 'public.orders / public.order_items missing — run 005_orders.sql first.';
  end if;

  if to_regclass('public.order_activity_log') is null
     or to_regprocedure('public.staff_recalculate_order_totals(uuid)') is null
  then
    raise exception 'Staff order workflow missing — run 011/012_staff_order_workflow.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null
     or to_regprocedure('public.get_my_role()') is null
  then
    raise exception 'has_staff_role/get_my_role missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regclass('public.product_supply_items') is null
     or to_regclass('public.product_supplies') is null
  then
    raise exception 'public.product_supply_items/product_supplies missing — run 036_product_supplies.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'set_updated_at missing — run 001 first.';
  end if;
end
$$;

-- ============================================================
-- 1. product_quantity_prices — minimal normalized quantity-tier model
--
-- One row per (product, min_quantity threshold). Rule: pick the row with
-- the largest min_quantity <= requested quantity (see
-- pricing_resolve_quantity_tier() below) — no overlapping ranges needed.
-- ============================================================

create table if not exists public.product_quantity_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  min_quantity integer not null,
  price numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_quantity_prices_unique unique (product_id, min_quantity),
  constraint product_quantity_prices_min_quantity_positive check (min_quantity > 0),
  constraint product_quantity_prices_price_non_negative check (price >= 0)
);

create index if not exists product_quantity_prices_product_idx
  on public.product_quantity_prices (product_id, min_quantity);

drop trigger if exists set_product_quantity_prices_updated_at on public.product_quantity_prices;
create trigger set_product_quantity_prices_updated_at
  before update on public.product_quantity_prices
  for each row
  execute function public.set_updated_at();

-- RPC-only access — same treatment as product_prices/customer_product_prices.
alter table public.product_quantity_prices enable row level security;
revoke all on public.product_quantity_prices from anon, authenticated;

-- ============================================================
-- 2. pricing_guard_settings — singleton cost/discount guard configuration
--
-- Minimal boundary, not a full approval workflow (see ТЗ §22):
--   max_manager_discount_percent — manager may discount up to this % below
--     the automatically resolved price (base/group/customer/tier) for a
--     single order item; a lower price requires admin.
--   min_margin_over_cost_percent — if the product's latest known landed
--     cost is known, manager's price must stay at least this % above it;
--     a lower price requires admin. NULL disables that half of the guard
--     (e.g. no landed cost data yet).
-- Defaults are a conservative starting point — admin should review them.
-- ============================================================

create table if not exists public.pricing_guard_settings (
  singleton_key text primary key default 'default',
  max_manager_discount_percent numeric(5, 2),
  min_margin_over_cost_percent numeric(5, 2),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint pricing_guard_settings_singleton_check check (singleton_key = 'default'),
  constraint pricing_guard_settings_discount_range check (
    max_manager_discount_percent is null
    or (max_manager_discount_percent >= 0 and max_manager_discount_percent <= 100)
  ),
  constraint pricing_guard_settings_margin_range check (
    min_margin_over_cost_percent is null or min_margin_over_cost_percent >= 0
  )
);

insert into public.pricing_guard_settings (singleton_key, max_manager_discount_percent, min_margin_over_cost_percent)
values ('default', 20, 10)
on conflict (singleton_key) do nothing;

drop trigger if exists set_pricing_guard_settings_updated_at on public.pricing_guard_settings;
create trigger set_pricing_guard_settings_updated_at
  before update on public.pricing_guard_settings
  for each row
  execute function public.set_updated_at();

alter table public.pricing_guard_settings enable row level security;
revoke all on public.pricing_guard_settings from anon, authenticated;

-- ============================================================
-- 3. order_items — price snapshot columns (nullable / safe for existing rows)
--
-- Existing rows keep is_manual_price = false and every new column NULL —
-- their unit_price/line_total (already historical, immutable snapshots
-- since 005_orders.sql) are untouched and remain the authoritative final
-- price for those orders. Nothing here recomputes or rewrites old rows.
-- ============================================================

alter table public.order_items
  add column if not exists list_price numeric(14, 2),
  add column if not exists auto_price numeric(14, 2),
  add column if not exists price_source text,
  add column if not exists quantity_tier_min_quantity integer,
  add column if not exists is_manual_price boolean not null default false,
  add column if not exists manual_price_reason text,
  add column if not exists manual_price_comment text,
  add column if not exists price_overridden_by uuid references public.profiles (id) on delete set null,
  add column if not exists price_overridden_at timestamptz;

comment on column public.order_items.list_price is
  'Snapshot of base/list price (products.base_price) at the time this line was priced.';
comment on column public.order_items.auto_price is
  'Snapshot of the automatically resolved price (before any manager override) — '
  'the more favorable of quantity tier / customer condition.';
comment on column public.order_items.price_source is
  'base | price_group | individual | legacy_company | quantity_tier | manager_override.';

alter table public.order_items drop constraint if exists order_items_price_source_check;
alter table public.order_items
  add constraint order_items_price_source_check check (
    price_source is null or price_source in (
      'base', 'price_group', 'individual', 'legacy_company', 'quantity_tier', 'manager_override'
    )
  );

alter table public.order_items drop constraint if exists order_items_manual_price_reason_check;
alter table public.order_items
  add constraint order_items_manual_price_reason_check check (
    manual_price_reason is null or manual_price_reason in (
      'regular_customer', 'object_top_up', 'approved_by_management', 'compensation', 'other'
    )
  );

alter table public.order_items drop constraint if exists order_items_manual_price_other_requires_comment;
alter table public.order_items
  add constraint order_items_manual_price_other_requires_comment check (
    manual_price_reason is distinct from 'other'
    or (manual_price_comment is not null and length(trim(manual_price_comment)) > 0)
  );

alter table public.order_items drop constraint if exists order_items_manual_price_requires_reason;
alter table public.order_items
  add constraint order_items_manual_price_requires_reason check (
    not is_manual_price or manual_price_reason is not null
  );

alter table public.order_items drop constraint if exists order_items_manual_price_meta_consistency;
alter table public.order_items
  add constraint order_items_manual_price_meta_consistency check (
    (is_manual_price and price_overridden_by is not null and price_overridden_at is not null)
    or (not is_manual_price and price_overridden_by is null and price_overridden_at is null)
  );

alter table public.order_items drop constraint if exists order_items_tier_min_quantity_positive;
alter table public.order_items
  add constraint order_items_tier_min_quantity_positive check (
    quantity_tier_min_quantity is null or quantity_tier_min_quantity > 0
  );

-- ============================================================
-- 4. order_activity_log — extend event_type for price override / reset
-- ============================================================

alter table public.order_activity_log
  drop constraint if exists order_activity_log_event_type_check;

alter table public.order_activity_log
  add constraint order_activity_log_event_type_check check (
    event_type in (
      'manager_assigned',
      'manager_unassigned',
      'deadlines_updated',
      'payment_recorded',
      'payment_reversed',
      'payment_completed',
      'payment_shortfall_after_reversal',
      'payment_claimed',
      'invoice_generation_failed',
      'item_price_overridden',
      'item_price_reset'
    )
  );

create or replace function public.staff_record_order_activity(
  p_order_id uuid,
  p_event_type text,
  p_description text default null,
  p_metadata jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_event_type is null
     or p_event_type not in (
       'manager_assigned',
       'manager_unassigned',
       'deadlines_updated',
       'payment_recorded',
       'payment_reversed',
       'payment_completed',
       'payment_shortfall_after_reversal',
       'payment_claimed',
       'invoice_generation_failed',
       'item_price_overridden',
       'item_price_reset'
     )
  then
    raise exception 'Недопустимый event_type: %', p_event_type;
  end if;

  insert into public.order_activity_log (
    order_id, event_type, description, metadata, created_by
  ) values (
    p_order_id,
    p_event_type,
    nullif(trim(coalesce(p_description, '')), ''),
    p_metadata,
    v_uid
  );
end;
$$;

revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb)
  from public, anon, authenticated;

-- ============================================================
-- 5. resolve_current_customer_id() — shared helper
--
-- Mirrors get_product_price()'s own profile_id → customers.id lookup
-- (028_customer_pricing.sql) so every caller resolves "my customer row"
-- identically. Returns null if unauthenticated or no customers row yet
-- (ensure_customer_for_profile() normally guarantees one from
-- 035's on-signup trigger — this is only a defensive fallback).
-- ============================================================

create or replace function public.resolve_current_customer_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.customers as c
  where c.profile_id = auth.uid()
  limit 1;
$$;

revoke all on function public.resolve_current_customer_id() from public;
grant execute on function public.resolve_current_customer_id() to authenticated;

-- ============================================================
-- 6. pricing_resolve_quantity_tier() / pricing_next_quantity_tier()
--
-- Rule (ТЗ §4): pick the tier with the largest min_quantity <= requested
-- quantity. No overlapping ranges — a plain min_quantity model is enough.
-- ============================================================

create or replace function public.pricing_resolve_quantity_tier(
  p_product_id uuid,
  p_quantity integer
)
returns table (price numeric, min_quantity integer)
language sql
stable
security definer
set search_path = ''
as $$
  select t.price, t.min_quantity
  from public.product_quantity_prices as t
  where t.product_id = p_product_id
    and t.min_quantity <= greatest(coalesce(p_quantity, 1), 1)
  order by t.min_quantity desc
  limit 1;
$$;

revoke all on function public.pricing_resolve_quantity_tier(uuid, integer) from public, anon, authenticated;

-- Next not-yet-reached threshold — used for the "От 100 шт. цена снизится
-- до 8 600" nudge (ТЗ §16). Only surfaces a tier that is strictly cheaper
-- than the tier currently in effect (or list price, if none applies yet).
create or replace function public.pricing_next_quantity_tier(
  p_product_id uuid,
  p_current_quantity integer
)
returns table (min_quantity integer, price numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select t.min_quantity, t.price
  from public.product_quantity_prices as t
  where t.product_id = p_product_id
    and t.min_quantity > greatest(coalesce(p_current_quantity, 1), 1)
    and t.price < coalesce(
      (
        select c.price
        from public.pricing_resolve_quantity_tier(p_product_id, p_current_quantity) as c
      ),
      (select p.base_price from public.products as p where p.id = p_product_id)
    )
  order by t.min_quantity asc
  limit 1;
$$;

revoke all on function public.pricing_next_quantity_tier(uuid, integer) from public, anon, authenticated;

-- ============================================================
-- 7. pricing_latest_landed_cost() — internal-only cost guard input
--
-- Reads Stage 38 landed cost history (036_product_supplies.sql) but is
-- never granted to anyone and never returned by any RPC output — it is
-- only ever used inside staff_set_order_item_price() below to compare
-- against a proposed price and answer yes/no, never to reveal the number
-- itself to a manager (landed cost stays admin-only, per Stage 38).
-- ============================================================

create or replace function public.pricing_latest_landed_cost(p_product_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select i.landed_cost_per_unit_kzt
  from public.product_supply_items as i
  join public.product_supplies as s on s.id = i.supply_id
  where i.product_id = p_product_id
    and i.landed_cost_per_unit_kzt is not null
  order by coalesce(s.closed_at, s.supply_date::timestamptz) desc, s.sequence_number desc
  limit 1;
$$;

revoke all on function public.pricing_latest_landed_cost(uuid) from public, anon, authenticated;

-- ============================================================
-- 8. resolve_order_item_price() — the priority algorithm (ТЗ §7)
--
--   1. list/base price — public.products.base_price (informational only,
--      always returned so callers can show it struck through).
--   2. customer condition — resolve_product_price() (individual > legacy
--      company > price group > base), unchanged from 028.
--   3. quantity tier — pricing_resolve_quantity_tier().
--   4. "most favorable allowed price": if both a tier and a customer
--      condition apply, the customer gets whichever is strictly cheaper.
--      Manager override is layered on top, later, by the caller — this
--      function only ever returns the *automatic* price.
-- ============================================================

create or replace function public.resolve_order_item_price(
  p_product_id uuid,
  p_customer_id uuid,
  p_quantity integer
)
returns table (
  list_price numeric,
  resolved_price numeric,
  resolved_source text,
  tier_min_quantity integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_base_price numeric(14, 2);
  v_customer_price numeric(14, 2);
  v_customer_source text;
  v_tier_price numeric(14, 2);
  v_tier_min integer;
  v_quantity integer := greatest(coalesce(p_quantity, 1), 1);
begin
  select p.base_price into v_base_price
  from public.products as p
  where p.id = p_product_id;

  select r.price, r.price_source into v_customer_price, v_customer_source
  from public.resolve_product_price(p_product_id, p_customer_id) as r
  limit 1;

  select t.price, t.min_quantity into v_tier_price, v_tier_min
  from public.pricing_resolve_quantity_tier(p_product_id, v_quantity) as t;

  list_price := v_base_price;

  if v_tier_price is not null and v_customer_price is not null and v_tier_price < v_customer_price then
    resolved_price := v_tier_price;
    resolved_source := 'quantity_tier';
    tier_min_quantity := v_tier_min;
  elsif v_customer_price is not null then
    resolved_price := v_customer_price;
    resolved_source := v_customer_source;
    tier_min_quantity := null;
  elsif v_tier_price is not null then
    resolved_price := v_tier_price;
    resolved_source := 'quantity_tier';
    tier_min_quantity := v_tier_min;
  else
    resolved_price := null;
    resolved_source := null;
    tier_min_quantity := null;
  end if;

  return next;
end;
$$;

comment on function public.resolve_order_item_price(uuid, uuid, integer) is
  'Automatic (non-manual) price for one order line: base <-> customer condition '
  '<-> quantity tier, picking whichever of customer/tier is more favorable. '
  'No client GRANT — called only from other SECURITY DEFINER RPCs.';

revoke all on function public.resolve_order_item_price(uuid, uuid, integer) from public, anon, authenticated;

-- ============================================================
-- 9. get_cart_pricing() — batch client-facing preview (cart / product page)
--
-- Anonymous callers get null pricing fields for every line (server-side
-- resolution is still mandatory at checkout; this just avoids exposing
-- guest pricing here, unchanged from get_product_price()'s own guest
-- behaviour). Never trusts any price the client might have cached —
-- always re-resolves from product_id + quantity only.
-- ============================================================

create or replace function public.get_cart_pricing(p_items jsonb)
returns table (
  product_id uuid,
  quantity integer,
  list_price numeric,
  resolved_price numeric,
  price_source text,
  quantity_tier_min_quantity integer,
  next_tier_min_quantity integer,
  next_tier_price numeric
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_quantity integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items должен быть JSON-массивом';
  end if;

  if jsonb_array_length(p_items) = 0 then
    return;
  end if;

  if jsonb_array_length(p_items) > 200 then
    raise exception 'Слишком много позиций за один запрос';
  end if;

  if auth.uid() is not null then
    v_customer_id := public.resolve_current_customer_id();
  end if;

  for v_item in
    select value from jsonb_array_elements(p_items) as t(value)
  loop
    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception
      when others then
        raise exception 'Некорректный product_id';
    end;

    if v_product_id is null then
      continue;
    end if;

    v_quantity := greatest(coalesce((v_item ->> 'quantity')::integer, 1), 1);

    product_id := v_product_id;
    quantity := v_quantity;

    if auth.uid() is null then
      list_price := (select p.base_price from public.products as p where p.id = v_product_id);
      resolved_price := null;
      price_source := null;
      quantity_tier_min_quantity := null;
      next_tier_min_quantity := null;
      next_tier_price := null;
    else
      select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
      into list_price, resolved_price, price_source, quantity_tier_min_quantity
      from public.resolve_order_item_price(v_product_id, v_customer_id, v_quantity) as r;

      select n.min_quantity, n.price
      into next_tier_min_quantity, next_tier_price
      from public.pricing_next_quantity_tier(v_product_id, v_quantity) as n;
    end if;

    return next;
  end loop;
end;
$$;

revoke all on function public.get_cart_pricing(jsonb) from public;
grant execute on function public.get_cart_pricing(jsonb) to anon, authenticated;

-- ============================================================
-- 10. Quantity tier admin CRUD (list: manager+admin; write: admin)
-- ============================================================

create or replace function public.staff_list_product_quantity_prices(p_product_id uuid)
returns table (
  id uuid,
  product_id uuid,
  min_quantity integer,
  price numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_id is null then
    raise exception 'product_id обязателен';
  end if;

  return query
  select t.id, t.product_id, t.min_quantity, t.price, t.created_at, t.updated_at
  from public.product_quantity_prices as t
  where t.product_id = p_product_id
  order by t.min_quantity asc;
end;
$$;

revoke all on function public.staff_list_product_quantity_prices(uuid) from public;
grant execute on function public.staff_list_product_quantity_prices(uuid) to authenticated;

create or replace function public.admin_upsert_product_quantity_price(
  p_product_id uuid,
  p_min_quantity integer,
  p_price numeric
)
returns public.product_quantity_prices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_quantity_prices;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_id is null then
    raise exception 'product_id обязателен';
  end if;

  if p_min_quantity is null or p_min_quantity <= 0 then
    raise exception 'Количество «от» должно быть положительным целым числом';
  end if;

  if p_price is null or p_price < 0 then
    raise exception 'Цена должна быть неотрицательным числом';
  end if;

  if not exists (select 1 from public.products as p where p.id = p_product_id) then
    raise exception 'Товар не найден';
  end if;

  insert into public.product_quantity_prices (product_id, min_quantity, price)
  values (p_product_id, p_min_quantity, round(p_price, 2))
  on conflict (product_id, min_quantity)
  do update set price = excluded.price
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_upsert_product_quantity_price(uuid, integer, numeric) from public;
grant execute on function public.admin_upsert_product_quantity_price(uuid, integer, numeric) to authenticated;

create or replace function public.admin_delete_product_quantity_price(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_id is null then
    raise exception 'id обязателен';
  end if;

  delete from public.product_quantity_prices where id = p_id;
end;
$$;

revoke all on function public.admin_delete_product_quantity_price(uuid) from public;
grant execute on function public.admin_delete_product_quantity_price(uuid) to authenticated;

-- ============================================================
-- 11. Pricing guard settings — read (manager+admin), write (admin)
-- ============================================================

create or replace function public.staff_get_pricing_guard_settings()
returns public.pricing_guard_settings
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_row public.pricing_guard_settings;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  select * into v_row from public.pricing_guard_settings where singleton_key = 'default';
  return v_row;
end;
$$;

revoke all on function public.staff_get_pricing_guard_settings() from public;
grant execute on function public.staff_get_pricing_guard_settings() to authenticated;

create or replace function public.admin_update_pricing_guard_settings(
  p_max_manager_discount_percent numeric,
  p_min_margin_over_cost_percent numeric
)
returns public.pricing_guard_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.pricing_guard_settings;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_max_manager_discount_percent is not null
     and (p_max_manager_discount_percent < 0 or p_max_manager_discount_percent > 100)
  then
    raise exception 'Максимальная скидка менеджера должна быть от 0 до 100%%';
  end if;

  if p_min_margin_over_cost_percent is not null and p_min_margin_over_cost_percent < 0 then
    raise exception 'Минимальная наценка над себестоимостью не может быть отрицательной';
  end if;

  update public.pricing_guard_settings
  set max_manager_discount_percent = p_max_manager_discount_percent,
      min_margin_over_cost_percent = p_min_margin_over_cost_percent,
      updated_by = auth.uid()
  where singleton_key = 'default'
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_update_pricing_guard_settings(numeric, numeric) from public;
grant execute on function public.admin_update_pricing_guard_settings(numeric, numeric) to authenticated;

-- ============================================================
-- 12. Customer price history helper (ТЗ §26) — manager+admin, a hint only
--
-- Excludes cancelled orders; no automatic rule is derived from it.
-- ============================================================

create or replace function public.staff_get_customer_product_price_history(
  p_customer_id uuid,
  p_product_id uuid,
  p_limit integer default 3
)
returns table (
  order_id uuid,
  order_number text,
  unit_price numeric,
  quantity integer,
  status text,
  ordered_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_customer_id is null or p_product_id is null then
    raise exception 'customer_id и product_id обязательны';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 3), 1), 10);

  return query
  select o.id, o.order_number, oi.unit_price, oi.quantity, o.status, o.created_at
  from public.order_items as oi
  join public.orders as o on o.id = oi.order_id
  where o.customer_id = p_customer_id
    and oi.product_id = p_product_id
    and o.status <> 'cancelled'
  order by o.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_get_customer_product_price_history(uuid, uuid, integer) from public;
grant execute on function public.staff_get_customer_product_price_history(uuid, uuid, integer) to authenticated;

-- ============================================================
-- 13. Staff price preview (ТЗ §25 / add-item modal) — no writes
-- ============================================================

create or replace function public.staff_preview_item_price(
  p_product_id uuid,
  p_customer_id uuid,
  p_quantity integer
)
returns table (
  list_price numeric,
  resolved_price numeric,
  resolved_source text,
  tier_min_quantity integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not public.has_staff_role(
    array['manager', 'admin', 'accountant', 'warehouse']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав';
  end if;

  if p_product_id is null then
    raise exception 'product_id обязателен';
  end if;

  return query
  select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
  from public.resolve_order_item_price(p_product_id, p_customer_id, p_quantity) as r;
end;
$$;

revoke all on function public.staff_preview_item_price(uuid, uuid, integer) from public;
grant execute on function public.staff_preview_item_price(uuid, uuid, integer) to authenticated;

-- ============================================================
-- 14. staff_set_order_item_price() — manager override (ТЗ §9–12)
--
-- Order-item scoped, single order only (never touches customer_product_prices
-- or product_quantity_prices — a manual override never silently becomes a
-- permanent customer price; that remains a separate, explicit admin action
-- via admin_upsert_customer_product_price(), unchanged from 028).
--
-- Guard (ТЗ §21–22): a manager (not admin) may not go below whichever is
-- higher of:
--   - auto_price * (1 - max_manager_discount_percent/100)
--   - latest known landed cost * (1 + min_margin_over_cost_percent/100)
-- Admin may always override past the guard (still fully audited). The
-- guard message never reveals the landed cost number itself.
-- ============================================================

create or replace function public.staff_set_order_item_price(
  p_order_item_id uuid,
  p_new_price numeric,
  p_reason text,
  p_comment text default null
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
  v_role public.user_role;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
  v_new_price numeric(14, 2);
  v_new_line_total numeric(14, 2);
  v_base_for_discount numeric(14, 2);
  v_discount_amount numeric(14, 2);
  v_discount_percent numeric(7, 2);
  v_max_discount_percent numeric(5, 2);
  v_min_margin_percent numeric(5, 2);
  v_cost numeric(18, 6);
  v_floor_by_discount numeric(14, 2);
  v_floor_by_cost numeric(14, 2);
  v_floor numeric(14, 2);
  v_old_price numeric(14, 2);
  v_guard_bypassed boolean := false;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения цены';
  end if;

  if p_order_item_id is null then
    raise exception 'order_item_id обязателен';
  end if;

  if p_new_price is null or p_new_price < 0 then
    raise exception 'Цена должна быть неотрицательным числом';
  end if;
  v_new_price := round(p_new_price, 2);

  if v_reason is null or v_reason not in (
    'regular_customer', 'object_top_up', 'approved_by_management', 'compensation', 'other'
  ) then
    raise exception 'Укажите причину изменения цены';
  end if;

  if v_reason = 'other' and v_comment is null then
    raise exception 'Для причины «Другое» укажите комментарий';
  end if;

  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'Комментарий слишком длинный (максимум 1000 символов)';
  end if;

  select oi.order_id into v_order_id from public.order_items as oi where oi.id = p_order_item_id;
  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  -- Lock the order first (matches every other order-mutating RPC's lock order).
  select * into v_order from public.orders as o where o.id = v_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception
      'Изменение цены возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)',
      v_order.status;
  end if;

  select * into v_item
  from public.order_items as oi
  where oi.id = p_order_item_id and oi.order_id = v_order.id
  for update;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  v_role := public.get_my_role();
  v_old_price := v_item.unit_price;
  v_base_for_discount := coalesce(v_item.auto_price, v_item.unit_price);

  select s.max_manager_discount_percent, s.min_margin_over_cost_percent
  into v_max_discount_percent, v_min_margin_percent
  from public.pricing_guard_settings as s
  where s.singleton_key = 'default';

  if v_max_discount_percent is not null then
    v_floor_by_discount := round(v_base_for_discount * (1 - v_max_discount_percent / 100.0), 2);
  end if;

  v_cost := public.pricing_latest_landed_cost(v_item.product_id);
  if v_cost is not null and v_min_margin_percent is not null then
    v_floor_by_cost := round(v_cost * (1 + v_min_margin_percent / 100.0), 2);
  end if;

  v_floor := greatest(coalesce(v_floor_by_discount, 0), coalesce(v_floor_by_cost, 0));

  if v_role <> 'admin' and v_floor > 0 and v_new_price < v_floor then
    raise exception 'Эта цена ниже допустимого уровня. Требуется подтверждение администратора.';
  end if;

  v_guard_bypassed := (v_role = 'admin' and v_floor > 0 and v_new_price < v_floor);

  v_new_line_total := round(v_new_price * v_item.quantity, 2);
  v_discount_amount := round(v_base_for_discount - v_new_price, 2);
  v_discount_percent := case
    when v_base_for_discount > 0 then round((v_base_for_discount - v_new_price) / v_base_for_discount * 100, 2)
    else 0
  end;

  update public.order_items as oi
  set unit_price = v_new_price,
      line_total = v_new_line_total,
      is_manual_price = true,
      price_source = 'manager_override',
      manual_price_reason = v_reason,
      manual_price_comment = v_comment,
      price_overridden_by = auth.uid(),
      price_overridden_at = now()
  where oi.id = p_order_item_id;

  perform public.staff_record_order_activity(
    v_order.id,
    'item_price_overridden',
    format('Цена изменена менеджером: %s → %s', v_old_price, v_new_price),
    jsonb_build_object(
      'order_item_id', p_order_item_id,
      'product_id', v_item.product_id,
      'product_name', v_item.product_name,
      'old_price', v_old_price,
      'new_price', v_new_price,
      'discount_amount', v_discount_amount,
      'discount_percent', v_discount_percent,
      'reason', v_reason,
      'comment', v_comment,
      'guard_bypassed_by_admin', v_guard_bypassed
    )
  );

  return public.staff_recalculate_order_totals(v_order.id);
end;
$$;

revoke all on function public.staff_set_order_item_price(uuid, numeric, text, text) from public;
grant execute on function public.staff_set_order_item_price(uuid, numeric, text, text) to authenticated;

-- ============================================================
-- 15. staff_reset_order_item_price() — undo a manual override (ТЗ §14)
--
-- Re-resolves the automatic price at the item's CURRENT quantity and
-- clears the manual-price flag/metadata. Never touches other items.
-- ============================================================

create or replace function public.staff_reset_order_item_price(p_order_item_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_order public.orders;
  v_item public.order_items;
  v_list_price numeric(14, 2);
  v_resolved_price numeric(14, 2);
  v_resolved_source text;
  v_tier_min integer;
  v_old_price numeric(14, 2);
  v_new_line_total numeric(14, 2);
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  if p_order_item_id is null then
    raise exception 'order_item_id обязателен';
  end if;

  select oi.order_id into v_order_id from public.order_items as oi where oi.id = p_order_item_id;
  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  select * into v_order from public.orders as o where o.id = v_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception
      'Изменение цены возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)',
      v_order.status;
  end if;

  select * into v_item
  from public.order_items as oi
  where oi.id = p_order_item_id and oi.order_id = v_order.id
  for update;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
  into v_list_price, v_resolved_price, v_resolved_source, v_tier_min
  from public.resolve_order_item_price(v_item.product_id, v_order.customer_id, v_item.quantity) as r;

  if v_resolved_price is null then
    raise exception 'Цена недоступна для товара: %', v_item.product_name;
  end if;

  v_old_price := v_item.unit_price;
  v_new_line_total := round(v_resolved_price * v_item.quantity, 2);

  update public.order_items as oi
  set unit_price = v_resolved_price,
      line_total = v_new_line_total,
      list_price = v_list_price,
      auto_price = v_resolved_price,
      price_source = v_resolved_source,
      quantity_tier_min_quantity = v_tier_min,
      is_manual_price = false,
      manual_price_reason = null,
      manual_price_comment = null,
      price_overridden_by = null,
      price_overridden_at = null
  where oi.id = p_order_item_id;

  perform public.staff_record_order_activity(
    v_order.id,
    'item_price_reset',
    format('Ручная цена сброшена, применена автоматическая: %s → %s', v_old_price, v_resolved_price),
    jsonb_build_object(
      'order_item_id', p_order_item_id,
      'product_id', v_item.product_id,
      'product_name', v_item.product_name,
      'old_price', v_old_price,
      'new_price', v_resolved_price,
      'price_source', v_resolved_source
    )
  );

  return public.staff_recalculate_order_totals(v_order.id);
end;
$$;

revoke all on function public.staff_reset_order_item_price(uuid) from public;
grant execute on function public.staff_reset_order_item_price(uuid) to authenticated;

-- ============================================================
-- 16. create_order() — client checkout, now quantity+customer aware
--
-- Same 8-parameter signature and returned shape as 007/008 — no frontend
-- change required. Only the per-line price resolution and order_items
-- insert are extended (snapshot columns populated); inventory
-- check/reservation logic is byte-for-byte unchanged from 008.
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
  v_customer_id uuid;
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
  v_list_price numeric(14, 2);
  v_unit_price numeric(14, 2);
  v_price_source text;
  v_tier_min integer;
  v_line_total numeric(14, 2);
  v_line record;
  -- Inventory check/reservation (unchanged from 008).
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

  -- Resolve caller's customer_id ONCE, same lookup as get_product_price()
  -- (028) — never trust a customer_id from the client. In the extremely
  -- rare case a profile has no customers row yet (normally guaranteed by
  -- ensure_customer_for_profile() on signup, 035), resolve_order_item_price
  -- below simply falls back to base price for that line, same net effect
  -- as get_product_price()'s own defensive fallback.
  v_customer_id := public.resolve_current_customer_id();

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

  -- Price + snapshot enrichment on the normalized set only. Quantity is
  -- read AFTER aggregation, so a product split across two p_items rows is
  -- priced once, by its combined quantity (never per raw line) — same
  -- aggregation contract as 006/007/008.
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

    if v_product.status is distinct from 'active' then
      raise exception 'Товар недоступен для заказа: %', v_line.product_id;
    end if;

    -- Never read money fields from p_items — server resolves independently.
    select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
    into v_list_price, v_unit_price, v_price_source, v_tier_min
    from public.resolve_order_item_price(v_line.product_id, v_customer_id, v_line.quantity) as r;

    if v_unit_price is null then
      raise exception 'Цена недоступна для товара: %', v_line.product_id;
    end if;

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

  -- --- warehouse resolution (unchanged from 008) -------------------------
  select w.id into v_warehouse_id
  from public.warehouses as w
  where w.code = 'ALMATY-01' and w.is_active
  limit 1;

  if v_warehouse_id is null then
    raise exception 'Основной склад недоступен, оформление заказа временно невозможно';
  end if;

  -- --- inventory check: lock + validate every line (unchanged from 008) --
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

  -- --- persist the order --------------------------------------------------
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
    v_user_id,
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
    line_total,
    list_price,
    auto_price,
    price_source,
    quantity_tier_min_quantity
  )
  select
    v_order_id,
    l.product_id,
    l.product_name,
    l.product_sku,
    l.quantity,
    l.unit_price,
    l.line_total,
    r.list_price,
    r.resolved_price,
    r.resolved_source,
    r.tier_min_quantity
  from tmp_create_order_lines as l
  cross join lateral public.resolve_order_item_price(l.product_id, v_customer_id, l.quantity) as r;

  -- --- inventory reservation + explicit reservation record (unchanged) ----
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
-- 17. staff_add_order_item() — manual staff order, quantity+customer aware
--
-- Same 3-parameter signature/returns as 011/028 — no frontend break.
-- Existing-line quantity increase now RE-RESOLVES the automatic price at
-- the new combined quantity (ТЗ §14) UNLESS the line already carries a
-- manual override, in which case the manual unit_price is preserved
-- untouched (only quantity/line_total change) — never a silent change.
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
  v_list_price numeric(14, 2);
  v_unit_price numeric(14, 2);
  v_price_source text;
  v_tier_min integer;
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

  select i.quantity, i.reserved_quantity into v_inv_quantity, v_inv_reserved
  from public.inventory as i
  where i.warehouse_id = v_warehouse_id and i.product_id = p_product_id
  for update;

  if not found then
    v_inv_quantity := 0;
    v_inv_reserved := 0;
  end if;

  v_available := public.staff_assert_non_negative_stock(v_inv_quantity - v_inv_reserved, v_product.name);

  if v_available < p_quantity::numeric(14, 3) then
    raise exception 'Недостаточно товара на складе: % (доступно %, требуется %)',
      v_product.name, v_available, p_quantity;
  end if;

  select count(*) into v_existing_count
  from public.order_items as oi
  where oi.order_id = p_order_id and oi.product_id = p_product_id;

  if v_existing_count > 1 then
    raise exception
      'Обнаружено несколько позиций товара % в заказе — требуется ручная проверка данных', v_product.name;
  end if;

  select * into v_existing_item
  from public.order_items as oi
  where oi.order_id = p_order_id and oi.product_id = p_product_id
  for update;

  if found then
    if v_existing_item.quantity > (2147483647 - p_quantity) then
      raise exception 'Слишком большое количество для товара %', v_product.name;
    end if;

    v_new_quantity := v_existing_item.quantity + p_quantity;

    if v_existing_item.is_manual_price then
      -- Manual override in effect — never silently re-priced (ТЗ §14).
      v_line_total := round(v_existing_item.unit_price * v_new_quantity, 2);

      update public.order_items as oi
      set quantity = v_new_quantity,
          line_total = v_line_total
      where oi.id = v_existing_item.id;
    else
      select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
      into v_list_price, v_unit_price, v_price_source, v_tier_min
      from public.resolve_order_item_price(p_product_id, v_order.customer_id, v_new_quantity) as r;

      if v_unit_price is null or v_unit_price < 0 then
        raise exception 'Цена недоступна для товара: %', v_product.name;
      end if;

      v_line_total := round(v_unit_price * v_new_quantity, 2);

      update public.order_items as oi
      set quantity = v_new_quantity,
          unit_price = v_unit_price,
          line_total = v_line_total,
          list_price = v_list_price,
          auto_price = v_unit_price,
          price_source = v_price_source,
          quantity_tier_min_quantity = v_tier_min
      where oi.id = v_existing_item.id;
    end if;
  else
    select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
    into v_list_price, v_unit_price, v_price_source, v_tier_min
    from public.resolve_order_item_price(p_product_id, v_order.customer_id, p_quantity) as r;

    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'Цена недоступна для товара: %', v_product.name;
    end if;

    v_line_total := round(v_unit_price * p_quantity, 2);

    insert into public.order_items (
      order_id, product_id, product_name, product_sku, quantity, unit_price, line_total,
      list_price, auto_price, price_source, quantity_tier_min_quantity
    ) values (
      p_order_id, p_product_id, v_product.name, v_product.sku, p_quantity, v_unit_price, v_line_total,
      v_list_price, v_unit_price, v_price_source, v_tier_min
    );
  end if;

  update public.inventory as i
  set reserved_quantity = i.reserved_quantity + p_quantity::numeric(14, 3),
      updated_at = now()
  where i.warehouse_id = v_warehouse_id and i.product_id = p_product_id;

  get diagnostics v_affected_rows = row_count;
  if v_affected_rows <> 1 then
    raise exception 'Не удалось зарезервировать товар: %', v_product.name;
  end if;

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
-- 18. staff_update_order_item_quantity() — re-resolve price unless manual
--
-- Same 2-parameter signature/returns as 012. Quantity change on a line
-- WITHOUT a manual override now re-resolves the automatic price at the
-- new quantity (ТЗ §14: 99 → 100 recalculates 9000 → 8600 automatically).
-- A manual override's unit_price is left untouched — never silently
-- reset; the frontend surfaces this explicitly (see modal / banner).
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
  v_list_price numeric(14, 2);
  v_unit_price numeric(14, 2);
  v_price_source text;
  v_tier_min integer;
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

  select * into v_order from public.orders as o where o.id = v_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)', v_order.status;
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

  select * into v_reservation
  from public.inventory_reservations as r
  where r.order_id = v_order.id and r.product_id = v_item.product_id and r.status = 'active'
  for update;

  if not found then
    raise exception 'Активный резерв для товара % не найден', v_item.product_name;
  end if;

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

  if v_item.is_manual_price then
    -- Manual override in effect — quantity changes, price does not
    -- (ТЗ §14: never a silent re-price; frontend surfaces the choice).
    v_new_line_total := round(v_item.unit_price * p_quantity, 2);

    update public.order_items as oi
    set quantity = p_quantity,
        line_total = v_new_line_total
    where oi.id = p_order_item_id;
  else
    select r.list_price, r.resolved_price, r.resolved_source, r.tier_min_quantity
    into v_list_price, v_unit_price, v_price_source, v_tier_min
    from public.resolve_order_item_price(v_item.product_id, v_order.customer_id, p_quantity) as r;

    if v_unit_price is null then
      raise exception 'Цена недоступна для товара: %', v_item.product_name;
    end if;

    v_new_line_total := round(v_unit_price * p_quantity, 2);

    update public.order_items as oi
    set quantity = p_quantity,
        unit_price = v_unit_price,
        line_total = v_new_line_total,
        list_price = v_list_price,
        auto_price = v_unit_price,
        price_source = v_price_source,
        quantity_tier_min_quantity = v_tier_min
    where oi.id = p_order_item_id;
  end if;

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

revoke all on function public.staff_update_order_item_quantity(uuid, integer) from public;
revoke all on function public.staff_update_order_item_quantity(uuid, integer) from anon;
revoke all on function public.staff_update_order_item_quantity(uuid, integer) from authenticated;
grant execute on function public.staff_update_order_item_quantity(uuid, integer) to authenticated;

-- ============================================================
-- 19. get_catalog() — add list_price (base_price) for strikethrough/badge UX
--
-- CREATE OR REPLACE cannot change RETURNS TABLE (42P13) — drop the 020
-- zero-arg signature first, no CASCADE. sale_price behaviour (null for
-- guests, personalized for authenticated) is completely unchanged;
-- list_price is public/base information shown to everyone, same as any
-- retail price tag.
-- ============================================================

drop function if exists public.get_catalog();

create function public.get_catalog()
returns table (
  product_id uuid,
  name text,
  sku text,
  original_sku text,
  category text,
  dimensions text,
  unit text,
  available_stock numeric,
  sale_price numeric,
  list_price numeric,
  image text,
  is_promotion boolean,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  return query
  select
    p.id as product_id,
    p.name,
    p.sku,
    p.original_sku,
    c.name as category,
    p.dimensions,
    p.unit,
    coalesce(stock.available_stock, 0) as available_stock,
    public.get_product_price(p.id) as sale_price,
    p.base_price as list_price,
    coalesce(
      nullif(trim(p.main_photo_path), ''),
      img.image_url
    ) as image,
    p.is_promotion,
    p.updated_at
  from public.products as p
  left join public.categories as c
    on c.id = p.category_id and c.is_active
  left join lateral (
    select sum(pa.available_quantity) as available_stock
    from public.product_availability as pa
    join public.warehouses as w
      on w.id = pa.warehouse_id and w.is_active
    where pa.product_id = p.id
  ) stock on true
  left join lateral (
    select pi.image_url
    from public.product_images as pi
    where pi.product_id = p.id and pi.is_primary
    order by pi.sort_order
    limit 1
  ) img on true
  where p.status = 'active'
  order by p.created_at;
end;
$$;

revoke all on function public.get_catalog() from public;
revoke all on function public.get_catalog() from anon;
revoke all on function public.get_catalog() from authenticated;
grant execute on function public.get_catalog() to anon, authenticated;

-- ============================================================
-- 20. Notes
--
-- - Backward compatibility: every new order_items column is nullable (or
--   defaults to false/is_manual_price), so every pre-041 row is untouched
--   and its unit_price/line_total (already historical) remain the final
--   price for that order — this migration performs NO backfill/UPDATE of
--   existing order_items or orders rows.
-- - Snapshots: order_items.unit_price/line_total (set once, at
--   create_order()/staff_add_order_item() time, or explicitly by
--   staff_set_order_item_price()/staff_reset_order_item_price()) are
--   never recomputed by a later change to base_price, product_prices,
--   customer_product_prices, or product_quantity_prices — those tables
--   are only ever read at the moment a line is priced.
-- - Invoice/delivery-note PDFs (014/018) already snapshot order_items
--   into order_documents.metadata at generation time — untouched by this
--   migration, and unaffected by later price changes for the same reason.
-- - VAT (040_vat_inclusive_extract.sql) is untouched: order_items.unit_price
--   remains the final VAT-inclusive selling price; staff_build_document_metadata
--   still extracts VAT via total * rate / (100 + rate), never adds it on top.
-- - Security: create_order() still ignores any money field the client
--   might send in p_items (only product_id/quantity are read); manager
--   override is reachable only via staff_set_order_item_price(), gated by
--   has_staff_role(['manager','admin']) plus the order-status and
--   discount/margin guard checks above; customer-specific prices
--   (customer_product_prices, resolved via resolve_product_price) are
--   never returned for any customer_id other than the caller's own
--   (get_product_price) or the order's own customer_id (staff RPCs,
--   already gated by has_staff_role).
-- ============================================================
