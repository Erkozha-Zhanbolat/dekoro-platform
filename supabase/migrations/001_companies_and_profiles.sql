-- DEKORO Platform V1
-- Migration: companies and profiles foundation
--
-- Run this file once in the Supabase SQL Editor (see supabase/README.md).
-- The migration is written to be safe to re-run: types/tables use guards,
-- functions use CREATE OR REPLACE, and triggers/policies are dropped and
-- recreated.

-- ============================================================
-- 0. Extensions
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 1. user_role enum
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum (
      'client',
      'manager',
      'accountant',
      'warehouse',
      'admin'
    );
  end if;
end
$$;

-- ============================================================
-- 2. companies table
-- ============================================================

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  bin text not null unique,
  phone text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_bin_format check (bin ~ '^\d{12}$')
);

-- ============================================================
-- 3. profiles table
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  full_name text not null,
  phone text,
  role public.user_role not null default 'client',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_company_id_idx on public.profiles (company_id);

-- ============================================================
-- 4. updated_at maintenance
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_companies_updated_at on public.companies;
create trigger set_companies_updated_at
  before update on public.companies
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- 5. Auto-create company + profile on new auth.users row
--
-- SECURITY DEFINER with a locked-down search_path so the function
-- always resolves public.companies / public.profiles regardless of
-- the caller's search_path (protects against search_path hijacking).
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_company_name text;
  v_bin text;
  v_contact_person text;
  v_phone text;
begin
  v_company_name := nullif(trim(new.raw_user_meta_data ->> 'company_name'), '');
  v_bin := nullif(trim(new.raw_user_meta_data ->> 'bin'), '');
  v_contact_person := nullif(trim(new.raw_user_meta_data ->> 'contact_person'), '');
  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');

  if v_bin is not null and v_bin ~ '^\d{12}$' then
    insert into public.companies (name, bin, phone, email)
    values (coalesce(v_company_name, 'Компания без названия'), v_bin, v_phone, new.email)
    on conflict (bin) do nothing
    returning id into v_company_id;

    if v_company_id is null then
      select id into v_company_id from public.companies where bin = v_bin;
    end if;
  end if;

  insert into public.profiles (id, company_id, full_name, phone, role)
  values (
    new.id,
    v_company_id,
    coalesce(v_contact_person, split_part(new.email, '@', 1), 'Новый пользователь'),
    v_phone,
    'client'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ============================================================
-- 6. Row Level Security
-- ============================================================

alter table public.companies enable row level security;
alter table public.profiles enable row level security;

-- Table-level grants: only SELECT is granted directly. There are no
-- INSERT/UPDATE/DELETE grants for anon/authenticated on either table —
-- writes only happen through SECURITY DEFINER functions (the trigger
-- above and update_my_profile below), which run as the function owner
-- and bypass RLS on the tables they own.
revoke all on public.companies from anon, authenticated;
revoke all on public.profiles from anon, authenticated;

grant select on public.companies to authenticated;
grant select on public.profiles to authenticated;

-- --- profiles policies -------------------------------------------------

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- Intentionally no INSERT/UPDATE/DELETE policy on profiles: a regular
-- update policy cannot reliably stop a client from also changing
-- role / company_id / is_active in the same statement, so direct writes
-- are denied entirely. Use the update_my_profile() RPC below instead.

-- --- companies policies --------------------------------------------------

drop policy if exists companies_select_own on public.companies;
create policy companies_select_own
  on public.companies
  for select
  to authenticated
  using (
    id in (
      select company_id from public.profiles where id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policy on companies: clients can never modify
-- company records directly.

-- ============================================================
-- 7. Safe self-service profile update RPC
--
-- Only full_name and phone can be changed, and only for the caller's
-- own row. role / company_id / is_active are never touched here.
-- ============================================================

create or replace function public.update_my_profile(p_full_name text, p_phone text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  update public.profiles
  set
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone = nullif(trim(p_phone), '')
  where id = auth.uid()
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'Профиль не найден';
  end if;

  return v_profile;
end;
$$;

revoke all on function public.update_my_profile(text, text) from public;
grant execute on function public.update_my_profile(text, text) to authenticated;

-- ============================================================
-- 8. Backfill for users created before this migration
--
-- Safe to re-run: only processes auth.users rows that don't have a
-- matching profiles row yet. Existing users are never removed or
-- altered by this block.
-- ============================================================

do $$
declare
  v_user record;
  v_company_id uuid;
  v_company_name text;
  v_bin text;
  v_contact_person text;
  v_phone text;
begin
  for v_user in
    select u.id, u.email, u.raw_user_meta_data
    from auth.users u
    left join public.profiles p on p.id = u.id
    where p.id is null
  loop
    v_company_name := nullif(trim(v_user.raw_user_meta_data ->> 'company_name'), '');
    v_bin := nullif(trim(v_user.raw_user_meta_data ->> 'bin'), '');
    v_contact_person := nullif(trim(v_user.raw_user_meta_data ->> 'contact_person'), '');
    v_phone := nullif(trim(v_user.raw_user_meta_data ->> 'phone'), '');
    v_company_id := null;

    if v_bin is not null and v_bin ~ '^\d{12}$' then
      insert into public.companies (name, bin, phone, email)
      values (coalesce(v_company_name, 'Компания без названия'), v_bin, v_phone, v_user.email)
      on conflict (bin) do nothing
      returning id into v_company_id;

      if v_company_id is null then
        select id into v_company_id from public.companies where bin = v_bin;
      end if;
    end if;

    insert into public.profiles (id, company_id, full_name, phone, role)
    values (
      v_user.id,
      v_company_id,
      coalesce(v_contact_person, split_part(v_user.email, '@', 1), 'Новый пользователь'),
      v_phone,
      'client'
    )
    on conflict (id) do nothing;
  end loop;
end
$$;
