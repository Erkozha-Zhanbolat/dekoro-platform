-- DEKORO Platform V2 — Staff Platform
-- Migration: Stage 42 — retire legacy price groups from runtime pricing
--
-- Depends on 001–041 (especially 002_catalog_inventory_pricing.sql
-- public.price_groups/product_prices/company_product_prices,
-- 013_customers_foundation.sql public.customers,
-- 028_customer_pricing.sql public.customer_product_prices /
-- resolve_product_price() / get_product_price(),
-- 041_order_pricing_engine.sql public.product_quantity_prices /
-- resolve_order_item_price() / get_cart_pricing()).
--
-- NOT applied automatically — run once in Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–041.
--
-- Purpose (ТЗ Stage 42): the pricing model is simplified to
--   base/retail price -> quantity tier -> customer individual price -> manager override
-- "Price groups" (public.price_groups / public.product_prices) and the legacy
-- per-company price list (public.company_product_prices) are removed from the
-- RUNTIME price resolution path. They are NOT dropped from the database —
-- see section 8 below for why.
--
-- Safe to re-run: DDL uses ADD COLUMN IF NOT EXISTS; the data migration
-- inserts use ON CONFLICT DO NOTHING (idempotent, never overwrites an
-- existing customer_product_prices row); function rewrites are
-- DROP FUNCTION IF EXISTS + CREATE (needed because resolve_product_price's
-- OUTPUT column list shrinks — see section 4) or plain CREATE OR REPLACE
-- (signature unchanged). No destructive rollback of any pricing data.
--
-- Explicitly NOT touched by this migration:
--   - customer_product_prices rows that already existed before this run
--     (never overwritten — "не перезаписывать уже существующую explicit
--     individual customer price");
--   - historical order_items (unit_price, price_source, snapshots) — old
--     orders with price_source = 'price_group' / 'legacy_company' are left
--     exactly as they are, forever a valid historical record;
--   - order_items check constraint on price_source (still allows the old
--     values so historical rows remain valid — see 041 section 4);
--   - VAT (migration 040), supplies/landed cost (migrations 038–040),
--     order workflow, manager override, pricing guard (all 041) — unchanged;
--   - resolve_order_item_price / get_cart_pricing / create_order /
--     staff_add_order_item / staff_update_order_item_quantity /
--     staff_resolve_price / staff_search_products — none of these reference
--     price_groups/product_prices/company_product_prices directly, they all
--     go through resolve_product_price(), so simplifying that one function
--     (section 4) is sufficient to remove price groups from every one of
--     them without editing their bodies.
--
-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.price_groups') is null
     or to_regclass('public.product_prices') is null
     or to_regclass('public.company_product_prices') is null
  then
    raise exception
      'public.price_groups / product_prices / company_product_prices missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.customer_product_prices') is null then
    raise exception
      'public.customer_product_prices missing — run 028_customer_pricing.sql first.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customers' and column_name = 'price_group_id'
  ) then
    raise exception 'public.customers.price_group_id missing — run 028_customer_pricing.sql first.';
  end if;

  if to_regprocedure('public.resolve_product_price(uuid, uuid)') is null then
    raise exception 'public.resolve_product_price(uuid, uuid) missing — run 028_customer_pricing.sql first.';
  end if;

  if to_regprocedure('public.get_product_price(uuid)') is null then
    raise exception 'public.get_product_price(uuid) missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regprocedure('public.resolve_order_item_price(uuid, uuid, integer)') is null
     or to_regclass('public.product_quantity_prices') is null
  then
    raise exception
      'public.resolve_order_item_price(...) / product_quantity_prices missing — run 041_order_pricing_engine.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role(...) missing — run 010 first.';
  end if;

  if to_regprocedure('public.staff_escape_ilike_term(text)') is null then
    raise exception 'public.staff_escape_ilike_term(text) missing — run an earlier migration first.';
  end if;
end
$$;

-- ============================================================
-- 1. Audit trail columns on customer_product_prices
--
-- Rows materialized below from a price group / legacy company price are
-- tagged so it stays visible, forever, which individual prices were
-- auto-created by this migration versus explicitly set by a manager. Both
-- columns are nullable and never touched for pre-existing rows.
-- ============================================================

alter table public.customer_product_prices
  add column if not exists migrated_from_price_group_id uuid references public.price_groups (id) on delete set null,
  add column if not exists migrated_from_company_id uuid references public.companies (id) on delete set null,
  add column if not exists migration_note text;

comment on column public.customer_product_prices.migrated_from_price_group_id is
  'Stage 42: set when this row was auto-materialized from public.product_prices for the '
  'customer''s price group at migration time. Null for manager-entered individual prices.';
comment on column public.customer_product_prices.migrated_from_company_id is
  'Stage 42: set when this row was auto-materialized from public.company_product_prices '
  '(legacy per-company pricing) at migration time. Null otherwise.';
comment on column public.customer_product_prices.migration_note is
  'Stage 42: human-readable provenance note for auto-materialized rows (042_remove_legacy_price_groups.sql).';

-- ============================================================
-- 2. Pre-migration audit (read-only, logged via RAISE NOTICE)
-- ============================================================

do $$
declare
  v_customers_with_group integer;
  v_price_groups_count integer;
  v_product_prices_count integer;
  v_company_product_prices_count integer;
  v_customer_product_prices_before integer;
begin
  select count(*) into v_customers_with_group
  from public.customers where price_group_id is not null;

  select count(*) into v_price_groups_count from public.price_groups;
  select count(*) into v_product_prices_count from public.product_prices;
  select count(*) into v_company_product_prices_count from public.company_product_prices;
  select count(*) into v_customer_product_prices_before from public.customer_product_prices;

  raise notice 'Stage 42 pre-migration audit: % price_groups, % customers with price_group_id, '
    '% product_prices rows, % company_product_prices rows, % customer_product_prices rows (before).',
    v_price_groups_count, v_customers_with_group, v_product_prices_count,
    v_company_product_prices_count, v_customer_product_prices_before;
end
$$;

-- ============================================================
-- 3. Materialize legacy_company effective prices into
--    customer_product_prices (2nd priority in the OLD resolve_product_price,
--    right after individual — inserted BEFORE price-group prices below so
--    ON CONFLICT DO NOTHING lets it win over a price-group price on the
--    same product, exactly like the old priority order did).
--
-- Only customers whose company currently has an ACTIVE (valid_from/valid_to)
-- company_product_prices row for that product get a row here, and only if
-- they do not already have an explicit individual price.
-- ============================================================

do $$
declare
  v_inserted integer;
begin
  insert into public.customer_product_prices (
    customer_id, product_id, price, migrated_from_company_id, migration_note
  )
  select
    c.id,
    cpp.product_id,
    cpp.price,
    cpp.company_id,
    'Stage 42: materialized from company_product_prices (legacy per-company price) on ' || now()::text
  from public.company_product_prices as cpp
  join public.customers as c on c.company_id = cpp.company_id
  where (cpp.valid_from is null or cpp.valid_from <= now())
    and (cpp.valid_to is null or cpp.valid_to >= now())
  on conflict (customer_id, product_id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'Stage 42 migration: % customer_product_prices rows materialized from company_product_prices.',
    v_inserted;
end
$$;

-- ============================================================
-- 4. Materialize price-group effective prices into
--    customer_product_prices (3rd priority in the OLD resolve_product_price).
--
-- Effective group = customer.price_group_id, falling back to the default
-- group exactly like the old resolve_product_price() did for a customer
-- with no group assigned. Only product_prices rows that are currently
-- ACTIVE (valid_from/valid_to) are considered "really in effect" — an
-- expired/future override is not materialized. Never overwrites a row
-- already present (pre-existing individual price OR just-inserted
-- legacy_company price from step 3 above).
-- ============================================================

do $$
declare
  v_default_group_id uuid;
  v_inserted integer;
begin
  select id into v_default_group_id from public.price_groups where is_default limit 1;

  insert into public.customer_product_prices (
    customer_id, product_id, price, migrated_from_price_group_id, migration_note
  )
  select
    c.id,
    pp.product_id,
    pp.price,
    pp.price_group_id,
    'Stage 42: materialized from product_prices (price group "' ||
      coalesce(pg.name, '?') || '") on ' || now()::text
  from public.customers as c
  join public.product_prices as pp
    on pp.price_group_id = coalesce(c.price_group_id, v_default_group_id)
  join public.price_groups as pg on pg.id = pp.price_group_id
  where (pp.valid_from is null or pp.valid_from <= now())
    and (pp.valid_to is null or pp.valid_to >= now())
  on conflict (customer_id, product_id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'Stage 42 migration: % customer_product_prices rows materialized from product_prices (price groups).',
    v_inserted;
end
$$;

-- ============================================================
-- 5. Simplify resolve_product_price() — individual customer price, else base.
--
-- PostgreSQL cannot CREATE OR REPLACE a function with a different OUTPUT
-- column list (same 42P13 family of error as renamed args — see 028
-- section 7): the old signature returned
-- (price, price_source, price_group_id, price_group_name).
-- No caller ever read price_group_id/price_group_name from this function —
-- every caller does `select r.price, r.price_source into ...` (verified
-- across resolve_order_item_price, get_product_price, staff_resolve_price,
-- staff_search_products, staff_list_customer_product_prices) — so dropping
-- those two columns is safe. DROP without CASCADE is safe: every caller is
-- plpgsql and resolves the function by name at call time (no hard pg_depend
-- for a plain function-call expression), same reasoning 028 documented for
-- staff_resolve_price.
-- ============================================================

drop function if exists public.resolve_product_price(uuid, uuid);

create function public.resolve_product_price(
  p_product_id uuid,
  p_customer_id uuid
)
returns table (
  price numeric,
  price_source text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_base_price numeric(14, 2);
  v_individual_price numeric(14, 2);
begin
  select p.base_price into v_base_price
  from public.products as p
  where p.id = p_product_id;

  if p_customer_id is not null then
    select cpp.price into v_individual_price
    from public.customer_product_prices as cpp
    where cpp.customer_id = p_customer_id
      and cpp.product_id = p_product_id;

    if v_individual_price is not null then
      price := v_individual_price;
      price_source := 'individual';
      return next;
      return;
    end if;
  end if;

  price := v_base_price;
  price_source := 'base';
  return next;
end;
$$;

comment on function public.resolve_product_price(uuid, uuid) is
  'Stage 42: internal price resolution: individual (customer_product_prices) > base. '
  'Price groups / legacy company pricing no longer participate — see '
  '042_remove_legacy_price_groups.sql. Null customer_id returns base price. '
  'No client GRANT — prevents cross-customer price probing.';

revoke all on function public.resolve_product_price(uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- 6. Simplify get_product_price() — same signature, drop the price-group
--    fallback branch for an authenticated user with no customers row yet.
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

  -- Authenticated but no customers row yet (ensure_customer_* runs on order
  -- creation): base price only — Stage 42 removes the default-price-group
  -- fallback that used to sit here.
  return (select p.base_price from public.products as p where p.id = p_product_id);
end;
$$;

comment on function public.get_product_price(uuid) is
  'Stage 42: storefront price: guests (anon/null uid) see null — unchanged since migration 002; '
  'authenticated users resolved via profile→customer→resolve_product_price (individual > base). '
  'Never accepts client-supplied customer_id.';

revoke all on function public.get_product_price(uuid) from public;
grant execute on function public.get_product_price(uuid) to anon, authenticated;

-- ============================================================
-- 7. New admin RPC — product pricing overview for the simplified
--    /staff/settings/pricing UI (retail price + quantity tiers per
--    product, no price-group columns). Read-only, admin-only, mirrors the
--    auth/search pattern of admin_list_pricing_matrix (028).
-- ============================================================

create or replace function public.admin_list_product_pricing_overview(
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
  quantity_tiers jsonb
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
        select jsonb_agg(
          jsonb_build_object('min_quantity', t.min_quantity, 'price', t.price)
          order by t.min_quantity
        )
        from public.product_quantity_prices as t
        where t.product_id = p.id
      ),
      '[]'::jsonb
    ) as quantity_tiers
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

comment on function public.admin_list_product_pricing_overview(text, uuid, integer, integer) is
  'Stage 42: admin-only product list for /staff/settings/pricing — retail price + quantity '
  'tiers, no price groups. Replaces admin_list_pricing_matrix() for the UI (that function is '
  'left in place, unused, per the legacy-schema decision in 042_remove_legacy_price_groups.sql).';

revoke all on function public.admin_list_product_pricing_overview(text, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_product_pricing_overview(text, uuid, integer, integer)
  to authenticated;

-- ============================================================
-- 8. Database cleanup decision — documented, not executed
--
-- NOT dropped (left physically in place, deliberately, as inert legacy
-- schema — see final report in chat for the full reasoning):
--   - public.price_groups, public.product_prices, public.company_product_prices
--     (tables + data): still referenced by admin_get_data_usage() (data
--     lifecycle dashboard row counts, 027/033) and by historical
--     order_items.price_source values ('price_group', 'legacy_company');
--   - public.customers.price_group_id (column): still populated by
--     ensure_customer_for_company / ensure_customer_for_profile /
--     handle_new_user (035) and read by staff_get_customer /
--     staff_search_customers (035) — harmless once nothing resolves prices
--     from it; changing those functions is out of scope and adds risk for
--     no runtime benefit;
--   - RPCs staff_list_price_groups, admin_list_price_groups,
--     admin_create_price_group, admin_update_price_group,
--     admin_set_default_price_group, admin_archive_price_group,
--     admin_restore_price_group, admin_reorder_price_groups,
--     staff_get_product_prices, admin_upsert_product_group_price,
--     admin_delete_product_group_price, admin_batch_upsert_product_group_prices,
--     admin_list_pricing_matrix, admin_set_customer_price_group: no longer
--     called by any frontend code after this stage (removed from
--     src/lib/staff/pricing.ts and every UI that used them) but left
--     defined — DROP FUNCTION carries real risk (must get every exact
--     signature right, no automated dependency check available from this
--     migration) for zero runtime benefit now that nothing calls them;
--   - staff_resolve_price(uuid, uuid): still actively used by
--     staff_search_products() for the staff "add item to order" price
--     preview — NOT dead code. Needs no change: it already delegates to
--     resolve_product_price(), so it automatically stops returning
--     price_group/legacy_company sources once section 5 above is applied;
--   - admin_bulk_update_product_prices(uuid[], jsonb): its "groups" branch
--     is simply never exercised any more — the frontend (StaffBulkSetPricesModal)
--     now always sends payload.groups = [] and the function's own
--     `for ... in select * from jsonb_array_elements('[]'::jsonb)` loop is a
--     no-op, so the base-price bulk-set path keeps working unchanged;
--   - order_items.price_source CHECK constraint (041): still allows
--     'price_group' / 'legacy_company' so historical rows stay valid.
--
-- If a future stage confirms (via a fresh audit at that time) that
-- price_groups/product_prices/company_product_prices/price_group_id are
-- truly unused end-to-end, they can be dropped then. Not done here.
-- ============================================================

-- ============================================================
-- 9. Post-migration summary
-- ============================================================

do $$
declare
  v_customer_product_prices_after integer;
  v_migrated_from_group integer;
  v_migrated_from_company integer;
begin
  select count(*) into v_customer_product_prices_after from public.customer_product_prices;
  select count(*) into v_migrated_from_group
    from public.customer_product_prices where migrated_from_price_group_id is not null;
  select count(*) into v_migrated_from_company
    from public.customer_product_prices where migrated_from_company_id is not null;

  raise notice 'Stage 42 done: % customer_product_prices rows total (% from price groups, % from legacy company pricing, rest pre-existing manager-entered).',
    v_customer_product_prices_after, v_migrated_from_group, v_migrated_from_company;
end
$$;

select
  (select count(*) from public.customer_product_prices) as customer_product_prices_total,
  (select count(*) from public.customer_product_prices where migrated_from_price_group_id is not null)
    as materialized_from_price_groups,
  (select count(*) from public.customer_product_prices where migrated_from_company_id is not null)
    as materialized_from_legacy_company,
  (select count(*) from public.customers where price_group_id is not null)
    as customers_with_legacy_price_group_id,
  (select count(*) from public.price_groups) as price_groups_kept_legacy,
  (select count(*) from public.product_prices) as product_prices_kept_legacy,
  (select count(*) from public.company_product_prices) as company_product_prices_kept_legacy;
