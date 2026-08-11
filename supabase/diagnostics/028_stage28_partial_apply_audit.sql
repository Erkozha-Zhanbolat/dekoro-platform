-- ============================================================
-- Diagnostic SQL for Stage 28 partial-apply / signature audit
-- Run in Supabase SQL Editor (read-only). Does not modify data.
--
-- Use AFTER a failed 028 apply (e.g. 42P13 on staff_resolve_price)
-- or BEFORE re-running the fixed 028.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Schema objects Stage 28 may have created before the failure
-- ------------------------------------------------------------

select
  to_regclass('public.customer_product_prices') is not null as customer_product_prices_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'customers'
      and column_name = 'price_group_id'
  ) as customers_price_group_id_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'price_groups'
      and column_name = 'code'
  ) as price_groups_code_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'price_groups'
      and column_name = 'sort_order'
  ) as price_groups_sort_order_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'price_groups'
      and column_name = 'is_active'
  ) as price_groups_is_active_exists;

-- Row counts (safe; no secrets)
select
  (select count(*) from public.price_groups) as price_groups_count,
  (select count(*) from public.price_groups where is_default) as default_groups_count,
  (
    select count(*)
    from public.customers
    where price_group_id is not null
  ) as customers_with_price_group,
  (
    select count(*)
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'customer_product_prices'
  ) as customer_product_prices_table_present,
  case
    when to_regclass('public.customer_product_prices') is not null
      then (select count(*) from public.customer_product_prices)
    else null
  end as customer_product_prices_count,
  (select count(*) from public.product_prices) as product_prices_count,
  (select count(*) from public.company_product_prices) as company_product_prices_count;

-- ------------------------------------------------------------
-- 2) Critical function signatures (args + result)
-- ------------------------------------------------------------

select
  p.proname,
  p.oid::regprocedure as signature,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_arguments(p.oid) as full_args,
  pg_get_function_result(p.oid) as result,
  p.prosecdef as security_definer
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_product_price',
    'get_catalog',
    'staff_resolve_price',
    'staff_search_products',
    'staff_add_order_item',
    'resolve_product_price',
    'staff_get_customer',
    'staff_create_customer',
    'ensure_customer_for_company',
    'ensure_customer_for_profile',
    'admin_get_data_usage',
    'admin_bulk_update_product_prices',
    'admin_list_price_groups',
    'staff_list_price_groups',
    'staff_get_product_prices',
    'staff_list_customer_product_prices',
    'admin_set_customer_price_group'
  )
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- ------------------------------------------------------------
-- 3) Focus: staff_resolve_price parameter names (42P13 root cause)
-- Expected BEFORE fix: p_product_id uuid, p_company_id uuid
-- Expected AFTER fixed 028: p_product_id uuid, p_ref_id uuid
-- ------------------------------------------------------------

select
  p.oid::regprocedure as signature,
  pg_get_function_arguments(p.oid) as full_args,
  pg_get_function_arguments(p.oid) like '%p_company_id%' as still_legacy_company_param,
  pg_get_function_arguments(p.oid) like '%p_ref_id%' as has_stage28_ref_param,
  pg_get_function_arguments(p.oid) like '%p_customer_id%' as has_customer_id_param
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'staff_resolve_price';

-- ------------------------------------------------------------
-- 4) staff_search_products overloads (1 or 2 expected during transition)
-- ------------------------------------------------------------

select
  p.oid::regprocedure as signature,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_arguments(p.oid) as full_args
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'staff_search_products'
order by pg_get_function_identity_arguments(p.oid);

-- ------------------------------------------------------------
-- 5) EXECUTE grants for key RPCs
-- ------------------------------------------------------------

select
  p.oid::regprocedure as signature,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_product_price',
    'get_catalog',
    'staff_resolve_price',
    'staff_search_products',
    'resolve_product_price',
    'admin_bulk_update_product_prices',
    'staff_list_price_groups',
    'admin_list_price_groups'
  )
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- ------------------------------------------------------------
-- 6) Table privileges: products.base_price + pricing tables
-- ------------------------------------------------------------

select
  table_name,
  privilege_type,
  grantee
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in (
    'products',
    'price_groups',
    'product_prices',
    'company_product_prices',
    'customer_product_prices'
  )
  and grantee in ('anon', 'authenticated', 'PUBLIC')
order by table_name, grantee, privilege_type;

-- Column privilege on products.base_price (empty = not granted)
select
  grantee,
  privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'products'
  and column_name = 'base_price'
  and grantee in ('anon', 'authenticated', 'PUBLIC');

-- ------------------------------------------------------------
-- 7) Quick interpretation helper
-- ------------------------------------------------------------
-- If staff_resolve_price still shows p_company_id → failed apply stopped at §7;
--   re-run FULL fixed 028 (option A).
-- If resolve_product_price / customers.price_group_id / customer_product_prices
--   already exist → expected partial state; fixed 028 is idempotent.
-- If staff_search_products is still (text, integer) only → §8 not reached yet.
-- If admin_bulk_update_product_prices missing → later sections not applied.
