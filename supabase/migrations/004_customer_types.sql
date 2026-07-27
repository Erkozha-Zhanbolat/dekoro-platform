-- DEKORO Platform V1
-- Migration: individual and company customer types
--
-- Depends on 001_companies_and_profiles.sql (public.companies, public.profiles,
-- public.handle_new_user()). Run this file once in the Supabase SQL Editor,
-- after 001 (see supabase/README.md). Not executed automatically.
--
-- Architectural decision for this step: public.companies and public.profiles
-- are kept as-is. There is no new customer_profiles table. One account is
-- one customer:
--   - individual  -> profiles row with company_id = null
--   - company/IP  -> profiles row with company_id pointing at companies
-- No employees, roles, invitations, or multiple users per company are
-- introduced here. companies.bin is not renamed; for a company/IP it is
-- used as a 12-digit BIN or IIN.

-- ============================================================
-- 0. Guard: make sure 001_companies_and_profiles.sql already ran
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception
      'public.profiles is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if to_regprocedure('public.handle_new_user()') is null then
    raise exception
      'public.handle_new_user() is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. profiles.customer_type column
--
-- Added nullable first so existing rows can be backfilled safely, then
-- switched to NOT NULL with a CHECK constraint. Safe to re-run: the column
-- add is guarded, the backfill only touches rows that still need it, and
-- the constraint is only added if it doesn't already exist.
-- ============================================================

alter table public.profiles
  add column if not exists customer_type text;

update public.profiles
set customer_type = case
  when company_id is not null then 'company'
  else 'individual'
end
where customer_type is null;

alter table public.profiles
  alter column customer_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_customer_type_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_customer_type_check
      check (customer_type in ('individual', 'company'));
  end if;
end
$$;

-- ============================================================
-- 2. Update handle_new_user() to support both customer types
--
-- SECURITY DEFINER with the same locked-down search_path as before, so it
-- always resolves public.companies / public.profiles regardless of the
-- caller's search_path.
--
-- Resolution order for the customer type:
--   1. raw_user_meta_data->>'customer_type' if it is exactly 'individual'
--      or 'company'.
--   2. Backward-compatible fallback for the current registration form,
--      which never sends customer_type: if company_name and bin are both
--      present, treat the signup as a company; otherwise as an individual.
--      This keeps the existing registration flow working unchanged after
--      this migration.
--
-- Individual: no companies row is created; profiles.company_id = null;
-- full_name comes from raw_user_meta_data->>'name'.
--
-- Company/IP: existing company lookup/creation logic is unchanged
-- (guarded by the 12-digit bin/iin format check); full_name comes from
-- raw_user_meta_data->>'contact_person', matching the current behavior.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_type text;
  v_company_id uuid;
  v_company_name text;
  v_bin text;
  v_contact_person text;
  v_individual_name text;
  v_phone text;
  v_full_name text;
begin
  v_company_name := nullif(trim(new.raw_user_meta_data ->> 'company_name'), '');
  v_bin := nullif(trim(new.raw_user_meta_data ->> 'bin'), '');
  v_contact_person := nullif(trim(new.raw_user_meta_data ->> 'contact_person'), '');
  v_individual_name := nullif(trim(new.raw_user_meta_data ->> 'name'), '');
  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');

  v_customer_type := nullif(trim(new.raw_user_meta_data ->> 'customer_type'), '');
  if v_customer_type is null or v_customer_type not in ('individual', 'company') then
    v_customer_type := case
      when v_company_name is not null and v_bin is not null then 'company'
      else 'individual'
    end;
  end if;

  if v_customer_type = 'company' then
    v_company_id := null;

    if v_bin is not null and v_bin ~ '^\d{12}$' then
      insert into public.companies (name, bin, phone, email)
      values (coalesce(v_company_name, 'Компания без названия'), v_bin, v_phone, new.email)
      on conflict (bin) do nothing
      returning id into v_company_id;

      if v_company_id is null then
        select id into v_company_id from public.companies where bin = v_bin;
      end if;
    end if;

    v_full_name := coalesce(v_contact_person, split_part(new.email, '@', 1), 'Новый пользователь');
  else
    v_customer_type := 'individual';
    v_company_id := null;
    v_full_name := coalesce(v_individual_name, split_part(new.email, '@', 1), 'Новый пользователь');
  end if;

  insert into public.profiles (id, company_id, full_name, phone, role, customer_type)
  values (
    new.id,
    v_company_id,
    v_full_name,
    v_phone,
    'client',
    v_customer_type
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- The trigger definition itself is unchanged (still points at
-- public.handle_new_user()), but it is dropped and recreated here to match
-- the idempotent style used across every migration in this project.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ============================================================
-- 3. Row Level Security / grants / update_my_profile()
--
-- No changes needed:
--   - profiles_select_own (select own row) already covers the new column,
--     since it selects the whole row and is not column-scoped.
--   - No INSERT/UPDATE/DELETE policy is added for customer_type (or
--     anything else) — writes still only happen through
--     handle_new_user() (SECURITY DEFINER trigger, updated above) and
--     update_my_profile() (SECURITY DEFINER RPC, unchanged).
--   - update_my_profile(p_full_name, p_phone) does not need to change: it
--     never touched company_id/role/is_active and has no reason to ever
--     touch customer_type either — a customer's type is fixed at signup
--     time and is not user-editable self-service data.
--   - No service_role usage introduced anywhere in this migration.
-- ============================================================
