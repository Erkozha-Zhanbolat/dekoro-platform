-- ============================================================
-- Diagnostic SQL for Stage 35 — registration / CRM customer sync
-- Read-only. Does not modify data.
-- Run in Supabase SQL Editor AFTER applying 035 (or to inspect before).
-- ============================================================

-- 0) Function signatures
select
  p.oid::regprocedure as signature,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_result(p.oid) as result,
  p.prosecdef as security_definer
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'handle_new_user',
    'ensure_customer_for_profile',
    'ensure_customer_for_company',
    'staff_create_customer',
    'staff_update_customer',
    'staff_get_customer',
    'staff_search_customers',
    'staff_assert_customer_card_ready',
    'staff_assert_invoice_ready',
    'client_get_my_customer_details',
    'client_update_my_customer_details',
    'client_resolve_my_customer_id',
    'sync_linked_identity_from_customer',
    'apply_identity_defaults_to_customer',
    'try_link_customer_profile_unambiguous',
    'customer_is_registered'
  )
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 1) Client profiles without a canonical customer
select
  p.id as profile_id,
  p.customer_type,
  p.company_id,
  p.full_name,
  p.phone,
  p.created_at
from public.profiles as p
where p.role = 'client'
  and not exists (
    select 1
    from public.customers as c
    where c.profile_id = p.id
       or (p.company_id is not null and c.company_id = p.company_id)
  )
order by p.created_at desc;

-- 2) Companies without a customer
select
  co.id as company_id,
  co.name,
  co.bin,
  co.email,
  co.created_at
from public.companies as co
where not exists (
  select 1 from public.customers as c where c.company_id = co.id
)
order by co.created_at desc;

-- 3) Customers without profile/company linkage (walk-in / incomplete)
select
  c.id as customer_id,
  c.customer_type,
  c.display_name,
  c.source,
  c.profile_id,
  c.company_id,
  c.created_at
from public.customers as c
where c.profile_id is null
  and c.company_id is null
order by c.created_at desc;

-- 4) Duplicate-candidate relationships (do NOT auto-merge)
-- 4a) Multiple client profiles sharing one company (same BIN registration)
select
  p.company_id,
  co.name,
  co.bin,
  count(*)::bigint as client_profiles
from public.profiles as p
join public.companies as co on co.id = p.company_id
where p.role = 'client'
  and p.company_id is not null
group by p.company_id, co.name, co.bin
having count(*) > 1
order by count(*) desc;

-- 4b) Company customer whose profile_id is still null despite client profiles
select
  c.id as customer_id,
  c.company_id,
  c.display_name,
  c.profile_id,
  (
    select count(*)
    from public.profiles as p
    where p.company_id = c.company_id
      and p.role = 'client'
  ) as client_profiles
from public.customers as c
where c.customer_type = 'company'
  and c.company_id is not null
  and c.profile_id is null
order by c.created_at desc;

-- 4c) Profile already linked to a different customer than its company customer
select
  p.id as profile_id,
  p.company_id,
  c_profile.id as customer_by_profile,
  c_company.id as customer_by_company
from public.profiles as p
left join public.customers as c_profile on c_profile.profile_id = p.id
left join public.customers as c_company
  on c_company.company_id = p.company_id
where p.role = 'client'
  and p.company_id is not null
  and c_profile.id is not null
  and c_company.id is not null
  and c_profile.id is distinct from c_company.id;

-- 5) Missing city (all types)
select
  c.id,
  c.customer_type,
  c.display_name,
  c.city,
  c.source
from public.customers as c
where nullif(trim(c.city), '') is null
order by c.created_at desc;

-- 6) Company customer missing legal address
select
  c.id,
  c.display_name,
  c.legal_name,
  c.address
from public.customers as c
where c.customer_type = 'company'
  and nullif(trim(c.address), '') is null
order by c.created_at desc;

-- 7) Company customer missing BIN/IIN
select
  c.id,
  c.display_name,
  c.iin_bin
from public.customers as c
where c.customer_type = 'company'
  and nullif(trim(c.iin_bin), '') is null
order by c.created_at desc;

-- 8) Company customer missing contact person
select
  c.id,
  c.display_name,
  c.contact_person
from public.customers as c
where c.customer_type = 'company'
  and nullif(trim(c.contact_person), '') is null
order by c.created_at desc;

-- 9) EXECUTE grants (client RPCs must be authenticated-only)
select
  p.oid::regprocedure as signature,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'client_get_my_customer_details',
    'client_update_my_customer_details',
    'client_resolve_my_customer_id',
    'ensure_customer_for_profile',
    'ensure_customer_for_company',
    'sync_linked_identity_from_customer',
    'staff_search_customers',
    'staff_update_customer'
  )
order by p.proname;
