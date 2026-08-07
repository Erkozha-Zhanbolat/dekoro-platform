-- ============================================================
-- Diagnostic SQL for Stage 27 RPC / schema state
-- Run in Supabase SQL Editor AFTER applying 027b patch (or full 027).
-- Does not modify data.
-- ============================================================

-- 1) Stage 27-related admin / lifecycle functions + signatures
select
  p.oid::regprocedure as signature,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_result(p.oid) as result,
  p.prosecdef as security_definer
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    p.proname like 'admin_%data%'
    or p.proname like 'admin_%archive%'
    or p.proname like 'admin_%retention%'
    or p.proname like 'admin_cleanup_raw_analytics%'
    or p.proname like 'admin_build_analytics%'
    or p.proname like 'admin_%test_order%'
    or p.proname like 'admin_expire_snapshot%'
    or p.proname like 'admin_get_export%'
    or p.proname like 'admin_get_storage%'
    or p.proname like 'admin_prepare_%'
    or p.proname like 'admin_execute_test%'
    or p.proname like 'admin_mark_archive%'
    or p.proname like 'admin_list_lifecycle%'
    or p.proname like 'admin_compute_period%'
    or p.proname like 'admin_get_period_export%'
    or p.proname like 'admin_get_test_archive%'
    or p.proname like 'data_lifecycle_%'
  )
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 2) Exact lookup for the failing RPC
select
  p.oid::regprocedure as signature,
  pg_get_function_result(p.oid) as result
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'admin_list_data_archives';

-- 3) EXECUTE privileges for authenticated
select
  p.oid::regprocedure as signature,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'admin_get_data_usage',
    'admin_get_dashboard_data_usage',
    'admin_get_data_retention_settings',
    'admin_upsert_data_retention_settings',
    'admin_build_analytics_aggregates',
    'admin_cleanup_raw_analytics',
    'admin_create_period_archive',
    'admin_list_data_archives',
    'admin_get_data_archive',
    'admin_get_export_dataset',
    'admin_set_order_test_flag',
    'admin_list_test_orders',
    'admin_prepare_test_orders_archive',
    'admin_execute_test_order_cleanup',
    'admin_get_storage_references',
    'admin_expire_snapshot_intents',
    'admin_list_archive_schedules',
    'admin_prepare_scheduled_weekly_archive',
    'admin_list_lifecycle_activity',
    'admin_mark_archive_exported',
    'admin_mark_archive_storage_cleaned',
    'admin_get_period_export_dataset',
    'admin_get_test_archive_export_dataset'
  )
order by p.proname;

-- 4) Helpers must NOT be granted to authenticated
select
  p.oid::regprocedure as signature,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'data_lifecycle_assert_admin',
    'data_lifecycle_log',
    'data_lifecycle_resolve_period',
    'data_lifecycle_manifest_checksum'
  );

-- 5) data_archives shape (compact vs old payload draft)
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'data_archives'
order by ordinal_position;

-- 6) Checksum helper body (must use md5, not extensions.digest)
select pg_get_functiondef(p.oid) as def
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'data_lifecycle_manifest_checksum';
