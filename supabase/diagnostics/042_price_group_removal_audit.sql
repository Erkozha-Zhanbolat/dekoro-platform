-- ============================================================
-- Diagnostic SQL for Stage 42 — legacy price group removal
-- Run in Supabase SQL Editor (read-only). Does not modify data.
--
-- Run BEFORE 042_remove_legacy_price_groups.sql to see exactly what
-- production data would be affected. Safe to re-run after 042 too — the
-- "already migrated" section confirms nothing was lost.
-- ============================================================

-- ------------------------------------------------------------
-- 1) How many customers are on a NON-default price group, and how many of
--    those actually have an active product_prices override (i.e. would
--    really see a different price than base_price today)?
-- ------------------------------------------------------------

select
  (select count(*) from public.customers) as customers_total,
  (select count(*) from public.customers where price_group_id is not null) as customers_with_price_group,
  (
    select count(*)
    from public.customers as c
    join public.price_groups as pg on pg.id = c.price_group_id
    where not pg.is_default
  ) as customers_on_non_default_group,
  (
    select count(distinct c.id)
    from public.customers as c
    join public.product_prices as pp
      on pp.price_group_id = coalesce(
        c.price_group_id,
        (select id from public.price_groups where is_default limit 1)
      )
    where (pp.valid_from is null or pp.valid_from <= now())
      and (pp.valid_to is null or pp.valid_to >= now())
  ) as customers_with_active_group_override,
  (
    select count(*)
    from public.product_prices as pp
    where (pp.valid_from is null or pp.valid_from <= now())
      and (pp.valid_to is null or pp.valid_to >= now())
  ) as active_product_prices_rows;

-- ------------------------------------------------------------
-- 2) Legacy per-company pricing (company_product_prices) — is it used at all?
-- ------------------------------------------------------------

select
  (select count(*) from public.company_product_prices) as company_product_prices_total,
  (
    select count(*)
    from public.company_product_prices as cpp
    where (cpp.valid_from is null or cpp.valid_from <= now())
      and (cpp.valid_to is null or cpp.valid_to >= now())
  ) as company_product_prices_active,
  (
    select count(distinct c.id)
    from public.customers as c
    join public.company_product_prices as cpp on cpp.company_id = c.company_id
    where (cpp.valid_from is null or cpp.valid_from <= now())
      and (cpp.valid_to is null or cpp.valid_to >= now())
  ) as customers_affected_by_legacy_company_pricing;

-- ------------------------------------------------------------
-- 3) Existing explicit individual prices (customer_product_prices) —
--    these are NEVER touched/overwritten by 042, shown here for context.
-- ------------------------------------------------------------

select
  count(*) as customer_product_prices_total,
  count(*) filter (where migrated_from_price_group_id is not null) as already_migrated_from_group,
  count(*) filter (where migrated_from_company_id is not null) as already_migrated_from_company,
  count(*) filter (
    where migrated_from_price_group_id is null and migrated_from_company_id is null
  ) as pre_existing_manager_entered
from public.customer_product_prices;
-- Note: the migrated_from_* columns only exist after 042 has been applied
-- once; this query will error with "column does not exist" if run before
-- 042 — that itself confirms 042 has not run yet.

-- ------------------------------------------------------------
-- 4) Per-customer preview: what would each affected customer's product
--    price change from (base_price) to (materialized individual price) —
--    run BEFORE 042 to sanity-check a handful of real customers by hand.
-- ------------------------------------------------------------

select
  c.id as customer_id,
  c.display_name,
  pg.name as current_price_group,
  p.id as product_id,
  p.sku,
  p.base_price,
  pp.price as group_price_would_become_individual,
  cpp.price as already_has_individual_price
from public.customers as c
join public.price_groups as pg
  on pg.id = coalesce(c.price_group_id, (select id from public.price_groups where is_default limit 1))
join public.product_prices as pp
  on pp.price_group_id = pg.id
  and (pp.valid_from is null or pp.valid_from <= now())
  and (pp.valid_to is null or pp.valid_to >= now())
join public.products as p on p.id = pp.product_id
left join public.customer_product_prices as cpp
  on cpp.customer_id = c.id and cpp.product_id = p.id
order by c.display_name, p.name
limit 100;

-- ------------------------------------------------------------
-- 5) Historical orders that used price_group / legacy_company sources —
--    confirm these exist and will be left untouched (not recalculated).
-- ------------------------------------------------------------

select
  price_source,
  count(*) as order_items_count,
  min(created_at) as earliest,
  max(created_at) as latest
from public.order_items
where price_source in ('price_group', 'legacy_company')
group by price_source;

-- ------------------------------------------------------------
-- 6) Function signature check — confirm resolve_product_price's shape
--    before/after 042 (2 output columns after, 4 before).
-- ------------------------------------------------------------

select
  p.oid::regprocedure as signature,
  pg_get_function_result(p.oid) as result
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('resolve_product_price', 'get_product_price', 'admin_list_product_pricing_overview');
