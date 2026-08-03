-- DEKORO Platform V2 — Staff Platform
-- Migration: universal customers foundation (Stage 3)
--
-- Depends on:
--   001_companies_and_profiles.sql (public.profiles, public.companies,
--     public.set_updated_at(), public.user_role)
--   004_customer_types.sql (public.profiles.customer_type)
--   005_orders.sql (public.orders)
--   007_checkout_order_details.sql (orders contact/delivery columns)
--   008_reserve_inventory_on_order.sql (current public.create_order)
--   010_staff_role_access.sql (public.has_staff_role / get_my_role)
--   011_staff_manual_orders.sql (public.staff_create_order, helpers)
--   012_staff_order_workflow.sql (order workflow — untouched here)
--
-- Run this file once in the Supabase SQL Editor after 012.
-- NOT applied by this change — apply by hand when ready.
--
-- Purpose: introduce public.customers as the universal customer entity for
-- registered and unregistered individuals/companies, backfill
-- orders.customer_id, expose staff RPCs, and keep create_order() /
-- staff_create_order() working via an ensure-customer helper + trigger.
--
-- Explicitly NOT done:
--   - dropping orders.user_id / profile_id / company_id;
--   - changing inventory reservation, workflow, or stock write-off;
--   - service_role usage;
--   - direct staff INSERT/UPDATE/DELETE grants on customers.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null or to_regclass('public.companies') is null then
    raise exception
      'public.profiles / public.companies missing — run 001_companies_and_profiles.sql first.';
  end if;

  if to_regclass('public.orders') is null then
    raise exception
      'public.orders is missing — run 005_orders.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'public.set_updated_at() is missing — run 001_companies_and_profiles.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception
      'public.has_staff_role(...) missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_create_order(uuid)') is null then
    raise exception
      'public.staff_create_order(uuid) missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.staff_escape_ilike_term(text)') is null then
    raise exception
      'public.staff_escape_ilike_term(text) missing — run 011_staff_manual_orders.sql first.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'customer_type'
  ) then
    raise exception
      'public.profiles.customer_type is missing — run 004_customer_types.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. public.customers
-- ============================================================

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_type text not null,
  profile_id uuid references public.profiles (id) on delete set null,
  company_id uuid references public.companies (id) on delete set null,
  display_name text not null,
  legal_name text,
  phone text,
  email text,
  iin_bin text,
  contact_person text,
  address text,
  city text,
  source text,
  notes text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_type_check check (
    customer_type in ('individual', 'company')
  ),
  constraint customers_source_check check (
    source is null
    or source in (
      'website',
      'staff',
      'phone',
      'whatsapp',
      'instagram',
      'referral',
      'other'
    )
  ),
  constraint customers_display_name_not_blank check (
    length(trim(display_name)) > 0
  ),
  constraint customers_individual_no_company check (
    customer_type <> 'individual' or company_id is null
  ),
  constraint customers_contact_required check (
    (
      customer_type = 'individual'
      and (
        phone is not null
        or email is not null
        or profile_id is not null
      )
    )
    or (
      customer_type = 'company'
      and (
        phone is not null
        or email is not null
        or company_id is not null
        or contact_person is not null
        or profile_id is not null
      )
    )
  )
);

create unique index if not exists customers_profile_id_unique
  on public.customers (profile_id)
  where profile_id is not null;

create unique index if not exists customers_company_id_unique
  on public.customers (company_id)
  where company_id is not null;

create index if not exists customers_display_name_idx
  on public.customers (display_name);

create index if not exists customers_phone_idx
  on public.customers (phone)
  where phone is not null;

create index if not exists customers_email_idx
  on public.customers (email)
  where email is not null;

create index if not exists customers_iin_bin_idx
  on public.customers (iin_bin)
  where iin_bin is not null;

create index if not exists customers_created_at_idx
  on public.customers (created_at desc);

create index if not exists customers_customer_type_idx
  on public.customers (customer_type);

drop trigger if exists set_customers_updated_at on public.customers;
create trigger set_customers_updated_at
  before update on public.customers
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- 2. RLS — customers
-- ============================================================

alter table public.customers enable row level security;

revoke all on public.customers from anon, authenticated;
grant select on public.customers to authenticated;

drop policy if exists customers_select_own on public.customers;
create policy customers_select_own
  on public.customers
  for select
  to authenticated
  using (profile_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy: clients cannot mutate customers
-- directly. Staff writes go through SECURITY DEFINER RPCs below.

-- ============================================================
-- 3. orders.customer_id (nullable first) + nullable legacy owner columns
--
-- user_id / profile_id stay for registered checkout compatibility, but
-- become nullable so staff can create orders for unregistered customers.
-- ============================================================

alter table public.orders
  add column if not exists customer_id uuid references public.customers (id) on delete restrict;

create index if not exists orders_customer_id_idx on public.orders (customer_id);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'user_id'
      and is_nullable = 'NO'
  ) then
    alter table public.orders alter column user_id drop not null;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'profile_id'
      and is_nullable = 'NO'
  ) then
    alter table public.orders alter column profile_id drop not null;
  end if;
end
$$;

-- ============================================================
-- 4. Internal helpers — ensure customer rows for profile / company
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
begin
  if p_company_id is null then
    raise exception 'company_id обязателен';
  end if;

  select c.id into v_customer_id
  from public.customers as c
  where c.company_id = p_company_id;

  if found then
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
    source
  )
  select
    'company',
    v_company.id,
    v_company.name,
    v_company.name,
    nullif(trim(v_company.phone), ''),
    nullif(trim(v_company.email), ''),
    nullif(trim(v_company.bin), ''),
    'website'
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
begin
  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

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
    source
  )
  select
    'individual',
    v_profile.id,
    v_display_name,
    nullif(trim(v_profile.phone), ''),
    nullif(trim(v_email), ''),
    'website'
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

-- Auto-fill + consistency checks for orders.customer_id / legacy owner cols.
-- Rules:
--   1. user_id and profile_id must match each other when both are set
--      (profiles.id = auth.users.id invariant).
--   2. If customer_id is null: derive from company_id, else profile_id.
--   3. If customer_id is set: customer must exist.
--   4. customer.profile_id set → order.user_id/profile_id must match it when set.
--   5. customer.company_id set → order.company_id must match (auto-filled if null).
--      order.profile_id may point at an employee of that company.
--   6. Truly unregistered walk-in (no profile_id, no company_id on customer):
--      order.user_id and order.profile_id must be null.
create or replace function public.orders_ensure_customer_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_order_profile public.profiles;
begin
  -- Legacy owner invariant: profiles.id == auth.users.id
  if new.user_id is not null
     and new.profile_id is not null
     and new.user_id is distinct from new.profile_id
  then
    raise exception 'orders.user_id и orders.profile_id должны совпадать';
  end if;

  if new.user_id is not null and new.profile_id is null then
    new.profile_id := new.user_id;
  elsif new.profile_id is not null and new.user_id is null then
    new.user_id := new.profile_id;
  end if;

  if new.customer_id is null then
    if new.company_id is not null then
      new.customer_id := public.ensure_customer_for_company(new.company_id);
    elsif new.profile_id is not null then
      new.customer_id := public.ensure_customer_for_profile(new.profile_id);
    else
      raise exception 'customer_id обязателен для заказа без profile_id/company_id';
    end if;
  end if;

  select * into v_customer
  from public.customers as c
  where c.id = new.customer_id;

  if not found then
    raise exception 'Клиент заказа не найден';
  end if;

  -- Direct profile link on the customer card
  if v_customer.profile_id is not null then
    if new.profile_id is not null
       and new.profile_id is distinct from v_customer.profile_id
    then
      raise exception 'profile_id заказа не совпадает с customer.profile_id';
    end if;
    if new.user_id is not null
       and new.user_id is distinct from v_customer.profile_id
    then
      raise exception 'user_id заказа не совпадает с customer.profile_id';
    end if;
  end if;

  -- Company linkage
  if v_customer.company_id is not null then
    if new.company_id is null then
      new.company_id := v_customer.company_id;
    elsif new.company_id is distinct from v_customer.company_id then
      raise exception 'company_id заказа не совпадает с customer.company_id';
    end if;

    -- If an employee profile is attached, it must belong to this company.
    if new.profile_id is not null then
      select * into v_order_profile
      from public.profiles as p
      where p.id = new.profile_id;

      if not found then
        raise exception 'Профиль заказа не найден';
      end if;

      if v_order_profile.company_id is distinct from v_customer.company_id then
        raise exception
          'profile_id заказа не принадлежит компании customer.company_id';
      end if;
    end if;
  elsif new.company_id is not null then
    raise exception 'customer без company_id не может иметь company_id в заказе';
  end if;

  -- Walk-in unregistered customer: no profile, no company on the card
  if v_customer.profile_id is null
     and v_customer.company_id is null
     and (new.profile_id is not null or new.user_id is not null)
  then
    raise exception
      'Нельзя указать user_id/profile_id для незарегистрированного customer';
  end if;

  return new;
end;
$$;

revoke all on function public.orders_ensure_customer_id() from public, anon, authenticated;

drop trigger if exists orders_ensure_customer_id_trg on public.orders;
create trigger orders_ensure_customer_id_trg
  before insert or update of customer_id, user_id, profile_id, company_id
  on public.orders
  for each row
  execute function public.orders_ensure_customer_id();

-- ============================================================
-- 5. Backfill existing orders → customers
-- ============================================================

do $$
declare
  v_company_ids integer;
  v_profile_ids integer;
  v_linked integer;
  v_missing integer;
  v_dup_profiles integer;
  v_dup_companies integer;
begin
  -- Diagnostics before backfill
  raise notice '013 diagnostics: orders total = %', (select count(*) from public.orders);
  raise notice '013 diagnostics: orders without customer_id = %',
    (select count(*) from public.orders where customer_id is null);

  -- Company customers (one per company_id present on orders)
  select count(distinct o.company_id) into v_company_ids
  from public.orders as o
  where o.company_id is not null;

  perform public.ensure_customer_for_company(c.company_id)
  from (
    select distinct o.company_id
    from public.orders as o
    where o.company_id is not null
  ) as c;

  raise notice '013 backfill: ensured customers for % distinct company_id values', v_company_ids;

  -- Individual customers (orders without company_id, keyed by profile)
  select count(distinct o.profile_id) into v_profile_ids
  from public.orders as o
  where o.company_id is null
    and o.profile_id is not null;

  perform public.ensure_customer_for_profile(p.profile_id)
  from (
    select distinct o.profile_id
    from public.orders as o
    where o.company_id is null
      and o.profile_id is not null
  ) as p;

  raise notice '013 backfill: ensured customers for % distinct individual profile_id values', v_profile_ids;

  -- Link company orders
  update public.orders as o
  set customer_id = c.id
  from public.customers as c
  where o.customer_id is null
    and o.company_id is not null
    and c.company_id = o.company_id;

  -- Link individual orders
  update public.orders as o
  set customer_id = c.id
  from public.customers as c
  where o.customer_id is null
    and o.company_id is null
    and o.profile_id is not null
    and c.profile_id = o.profile_id;

  get diagnostics v_linked = row_count;
  raise notice '013 backfill: individual link update row_count (last statement) = %', v_linked;

  select count(*) into v_missing
  from public.orders
  where customer_id is null;

  select count(*) into v_dup_profiles
  from (
    select profile_id
    from public.customers
    where profile_id is not null
    group by profile_id
    having count(*) > 1
  ) as d;

  select count(*) into v_dup_companies
  from (
    select company_id
    from public.customers
    where company_id is not null
    group by company_id
    having count(*) > 1
  ) as d;

  raise notice '013 diagnostics after backfill: orders without customer_id = %', v_missing;
  raise notice '013 diagnostics after backfill: duplicate profile_id customers = %', v_dup_profiles;
  raise notice '013 diagnostics after backfill: duplicate company_id customers = %', v_dup_companies;

  if v_dup_profiles > 0 then
    raise exception
      '013 aborted: found % duplicate customers by profile_id after backfill', v_dup_profiles;
  end if;

  if v_dup_companies > 0 then
    raise exception
      '013 aborted: found % duplicate customers by company_id after backfill', v_dup_companies;
  end if;

  if v_missing > 0 then
    raise exception
      '013 aborted: % orders still missing customer_id after backfill — refusing NOT NULL',
      v_missing;
  end if;

  -- Orphan customer_id references should be impossible via FK, asserted anyway
  if exists (
    select 1
    from public.orders as o
    left join public.customers as c on c.id = o.customer_id
    where o.customer_id is not null
      and c.id is null
  ) then
    raise exception '013 aborted: orders.customer_id references missing customers';
  end if;
end
$$;

alter table public.orders
  alter column customer_id set not null;

-- ============================================================
-- 6. Staff RPC — search / get / create / update / link / list orders
-- ============================================================

create or replace function public.staff_search_customers(
  p_query text default null,
  p_limit integer default 30
)
returns table (
  id uuid,
  customer_type text,
  display_name text,
  legal_name text,
  phone text,
  email text,
  city text,
  source text,
  profile_id uuid,
  company_id uuid,
  orders_count bigint,
  last_order_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_raw_term text;
  v_term text;
begin
  if not public.has_staff_role(array['manager', 'accountant', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для поиска клиентов';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_raw_term := nullif(trim(p_query), '');

  if v_raw_term is null then
    return query
    select
      c.id,
      c.customer_type,
      c.display_name,
      c.legal_name,
      c.phone,
      c.email,
      c.city,
      c.source,
      c.profile_id,
      c.company_id,
      coalesce(stats.orders_count, 0) as orders_count,
      stats.last_order_at
    from public.customers as c
    left join lateral (
      select
        count(*)::bigint as orders_count,
        max(o.created_at) as last_order_at
      from public.orders as o
      where o.customer_id = c.id
    ) as stats on true
    order by c.created_at desc
    limit v_limit;
    return;
  end if;

  v_term := public.staff_escape_ilike_term(v_raw_term);

  return query
  select
    c.id,
    c.customer_type,
    c.display_name,
    c.legal_name,
    c.phone,
    c.email,
    c.city,
    c.source,
    c.profile_id,
    c.company_id,
    coalesce(stats.orders_count, 0) as orders_count,
    stats.last_order_at
  from public.customers as c
  left join lateral (
    select
      count(*)::bigint as orders_count,
      max(o.created_at) as last_order_at
    from public.orders as o
    where o.customer_id = c.id
  ) as stats on true
  where c.display_name ilike ('%' || v_term || '%') escape '\'
     or coalesce(c.legal_name, '') ilike ('%' || v_term || '%') escape '\'
     or coalesce(c.phone, '') ilike ('%' || v_term || '%') escape '\'
     or coalesce(c.email, '') ilike ('%' || v_term || '%') escape '\'
     or coalesce(c.iin_bin, '') ilike ('%' || v_term || '%') escape '\'
     or coalesce(c.contact_person, '') ilike ('%' || v_term || '%') escape '\'
  order by c.display_name
  limit v_limit;
end;
$$;

revoke all on function public.staff_search_customers(text, integer) from public, anon, authenticated;
grant execute on function public.staff_search_customers(text, integer) to authenticated;

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
  last_order_at timestamptz
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
    stats.last_order_at
  from public.customers as c
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
    created_by
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
    auth.uid()
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

create or replace function public.staff_update_customer(
  p_customer_id uuid,
  p_display_name text default null,
  p_legal_name text default null,
  p_phone text default null,
  p_email text default null,
  p_iin_bin text default null,
  p_contact_person text default null,
  p_address text default null,
  p_city text default null,
  p_source text default null,
  p_notes text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.customers;
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
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения клиента';
  end if;

  if p_customer_id is null then
    raise exception 'Не указан клиент';
  end if;

  select * into v_existing
  from public.customers as c
  where c.id = p_customer_id
  for update;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  -- NULL = keep existing; '' (after trim) = clear to null; non-empty = set.
  -- display_name cannot be cleared.
  if p_display_name is null then
    v_display_name := v_existing.display_name;
  else
    v_display_name := nullif(trim(p_display_name), '');
  end if;

  if v_display_name is null then
    raise exception 'Имя клиента обязательно';
  end if;

  v_legal_name := case
    when p_legal_name is null then v_existing.legal_name
    else nullif(trim(p_legal_name), '')
  end;
  v_phone := case
    when p_phone is null then v_existing.phone
    else nullif(trim(p_phone), '')
  end;
  v_email := case
    when p_email is null then v_existing.email
    else nullif(trim(p_email), '')
  end;
  v_iin_bin := case
    when p_iin_bin is null then v_existing.iin_bin
    else nullif(trim(p_iin_bin), '')
  end;
  v_contact_person := case
    when p_contact_person is null then v_existing.contact_person
    else nullif(trim(p_contact_person), '')
  end;
  v_address := case
    when p_address is null then v_existing.address
    else nullif(trim(p_address), '')
  end;
  v_city := case
    when p_city is null then v_existing.city
    else nullif(trim(p_city), '')
  end;
  v_source := case
    when p_source is null then v_existing.source
    else nullif(trim(p_source), '')
  end;
  v_notes := case
    when p_notes is null then v_existing.notes
    else nullif(trim(p_notes), '')
  end;

  if v_source is not null
     and v_source not in ('website', 'staff', 'phone', 'whatsapp', 'instagram', 'referral', 'other')
  then
    raise exception 'Некорректный источник клиента';
  end if;

  if v_existing.customer_type = 'individual' then
    if v_phone is null and v_email is null and v_existing.profile_id is null then
      raise exception 'Укажите телефон или email';
    end if;
  else
    if v_phone is null
       and v_email is null
       and v_contact_person is null
       and v_existing.company_id is null
       and v_existing.profile_id is null
    then
      raise exception 'Укажите телефон, email или контактное лицо';
    end if;
  end if;

  update public.customers as c
  set
    display_name = v_display_name,
    legal_name = v_legal_name,
    phone = v_phone,
    email = v_email,
    iin_bin = v_iin_bin,
    contact_person = v_contact_person,
    address = v_address,
    city = v_city,
    source = v_source,
    notes = v_notes
    -- profile_id / company_id intentionally untouched
  where c.id = p_customer_id
  returning * into v_customer;

  return v_customer;
end;
$$;

revoke all on function public.staff_update_customer(
  uuid, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.staff_update_customer(
  uuid, text, text, text, text, text, text, text, text, text, text
) to authenticated;

create or replace function public.staff_link_customer_profile(
  p_customer_id uuid,
  p_profile_id uuid
)
returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.customers;
  v_profile public.profiles;
  v_other uuid;
  v_customer public.customers;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для связывания аккаунта клиента';
  end if;

  if p_customer_id is null or p_profile_id is null then
    raise exception 'customer_id и profile_id обязательны';
  end if;

  select * into v_existing
  from public.customers as c
  where c.id = p_customer_id
  for update;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  if v_existing.profile_id is not null then
    if v_existing.profile_id = p_profile_id then
      return v_existing;
    end if;
    raise exception 'Клиент уже связан с другим аккаунтом';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = p_profile_id;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_profile.role <> 'client' then
    raise exception 'Связывать можно только клиентский профиль';
  end if;

  select c.id into v_other
  from public.customers as c
  where c.profile_id = p_profile_id
    and c.id <> p_customer_id;

  if found then
    raise exception 'Этот профиль уже связан с другим клиентом';
  end if;

  if v_existing.customer_type = 'individual' and v_existing.company_id is not null then
    raise exception 'Некорректные данные клиента: individual с company_id';
  end if;

  update public.customers as c
  set profile_id = p_profile_id
  where c.id = p_customer_id
  returning * into v_customer;

  return v_customer;
end;
$$;

revoke all on function public.staff_link_customer_profile(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staff_link_customer_profile(uuid, uuid) to authenticated;

create or replace function public.staff_list_customer_orders(p_customer_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  total numeric,
  created_at timestamptz,
  contact_name text,
  contact_phone text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['manager', 'accountant', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для просмотра заказов клиента';
  end if;

  if p_customer_id is null then
    raise exception 'Не указан клиент';
  end if;

  if not exists (select 1 from public.customers as c where c.id = p_customer_id) then
    raise exception 'Клиент не найден';
  end if;

  return query
  select
    o.id,
    o.order_number,
    o.status,
    o.total,
    o.created_at,
    o.contact_name,
    o.contact_phone
  from public.orders as o
  where o.customer_id = p_customer_id
  order by o.created_at desc;
end;
$$;

revoke all on function public.staff_list_customer_orders(uuid) from public, anon, authenticated;
grant execute on function public.staff_list_customer_orders(uuid) to authenticated;

-- ============================================================
-- 7. Adapt staff_create_order + add staff_create_order_for_customer
-- ============================================================

create or replace function public.staff_create_order(p_client_profile_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client public.profiles;
  v_company_id uuid;
  v_customer_id uuid;
  v_contact_name text;
  v_contact_phone text;
  v_contact_email text;
  v_order_id uuid;
  v_order_number text;
  v_order_status text;
  v_order_created_at timestamptz;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для создания заказа';
  end if;

  if p_client_profile_id is null then
    raise exception 'Не указан клиент';
  end if;

  select * into v_client
  from public.profiles as p
  where p.id = p_client_profile_id;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  if v_client.role <> 'client' then
    raise exception 'Указанный профиль не является клиентом';
  end if;

  if not v_client.is_active then
    raise exception 'Клиент неактивен, создание заказа невозможно';
  end if;

  if v_client.customer_type = 'individual' then
    v_company_id := null;
  elsif v_client.customer_type = 'company' then
    if v_client.company_id is null then
      raise exception 'У профиля компании отсутствует company_id';
    end if;

    if not exists (select 1 from public.companies as c where c.id = v_client.company_id) then
      raise exception 'Компания клиента не найдена';
    end if;

    v_company_id := v_client.company_id;
  else
    raise exception 'Неизвестный тип покупателя: %', v_client.customer_type;
  end if;

  v_customer_id := public.ensure_customer_for_profile(v_client.id);

  v_contact_name := nullif(trim(v_client.full_name), '');
  v_contact_phone := nullif(trim(v_client.phone), '');

  if v_contact_name is null then
    raise exception 'У клиента не указано имя в профиле — создание заказа невозможно';
  end if;

  if v_contact_phone is null then
    raise exception 'У клиента не указан телефон в профиле — создание заказа невозможно';
  end if;

  select au.email into v_contact_email from auth.users as au where au.id = v_client.id;

  insert into public.orders as o (
    user_id,
    profile_id,
    company_id,
    customer_id,
    status,
    subtotal,
    discount,
    total,
    delivery_type,
    contact_name,
    contact_phone,
    contact_email
  ) values (
    v_client.id,
    v_client.id,
    v_company_id,
    v_customer_id,
    'new',
    0,
    0,
    0,
    'pickup',
    v_contact_name,
    v_contact_phone,
    v_contact_email
  )
  returning o.id, o.order_number, o.status, o.created_at
  into v_order_id, v_order_number, v_order_status, v_order_created_at;

  return query select v_order_id, v_order_number, v_order_status, v_order_created_at;
end;
$$;

revoke all on function public.staff_create_order(uuid) from public, anon, authenticated;
grant execute on function public.staff_create_order(uuid) to authenticated;

-- New unambiguous entry point for universal customers (registered or not).
create or replace function public.staff_create_order_for_customer(p_customer_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_profile public.profiles;
  v_user_id uuid;
  v_profile_id uuid;
  v_company_id uuid;
  v_contact_name text;
  v_contact_phone text;
  v_contact_email text;
  v_order_id uuid;
  v_order_number text;
  v_order_status text;
  v_order_created_at timestamptz;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для создания заказа';
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

  v_company_id := v_customer.company_id;
  v_profile_id := v_customer.profile_id;
  v_user_id := v_customer.profile_id;

  if v_customer.profile_id is not null then
    select * into v_profile
    from public.profiles as p
    where p.id = v_customer.profile_id;

    if not found then
      raise exception 'Связанный профиль клиента не найден';
    end if;

    if v_profile.role <> 'client' then
      raise exception 'Связанный профиль не является клиентом';
    end if;

    if not v_profile.is_active then
      raise exception 'Клиент неактивен, создание заказа невозможно';
    end if;

    if v_customer.customer_type = 'individual' then
      v_company_id := null;
    elsif v_customer.customer_type = 'company' then
      v_company_id := coalesce(v_customer.company_id, v_profile.company_id);
    end if;
  end if;

  v_contact_name := coalesce(
    nullif(trim(v_customer.display_name), ''),
    nullif(trim(v_customer.contact_person), ''),
    nullif(trim(coalesce(v_profile.full_name, '')), '')
  );
  v_contact_phone := coalesce(
    nullif(trim(v_customer.phone), ''),
    nullif(trim(coalesce(v_profile.phone, '')), '')
  );
  v_contact_email := nullif(trim(v_customer.email), '');

  if v_contact_email is null and v_customer.profile_id is not null then
    select au.email into v_contact_email
    from auth.users as au
    where au.id = v_customer.profile_id;
  end if;

  if v_contact_name is null then
    raise exception 'У клиента не указано имя — создание заказа невозможно';
  end if;

  if v_contact_phone is null then
    raise exception 'У клиента не указан телефон — создание заказа невозможно';
  end if;

  insert into public.orders as o (
    user_id,
    profile_id,
    company_id,
    customer_id,
    status,
    subtotal,
    discount,
    total,
    delivery_type,
    contact_name,
    contact_phone,
    contact_email
  ) values (
    v_user_id,
    v_profile_id,
    v_company_id,
    v_customer.id,
    'new',
    0,
    0,
    0,
    'pickup',
    v_contact_name,
    v_contact_phone,
    v_contact_email
  )
  returning o.id, o.order_number, o.status, o.created_at
  into v_order_id, v_order_number, v_order_status, v_order_created_at;

  return query select v_order_id, v_order_number, v_order_status, v_order_created_at;
end;
$$;

revoke all on function public.staff_create_order_for_customer(uuid) from public, anon, authenticated;
grant execute on function public.staff_create_order_for_customer(uuid) to authenticated;

-- ============================================================
-- 7b. Harden cancel_order() ownership for nullable orders.user_id
--
-- Making user_id nullable for walk-in staff orders makes the old check
-- `IF v_order.user_id <> v_user_id` fail-open: NULL <> uuid is NULL, so
-- PL/pgSQL skips the raise and any authenticated caller who knows an
-- order id could cancel a staff walk-in order. Use IS DISTINCT FROM.
-- Body otherwise matches 009_cancel_order_release_reservation.sql.
-- ============================================================

create or replace function public.cancel_order(p_order_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_has_active_reservation boolean;
  v_reservation record;
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
  v_result_id uuid;
  v_result_order_number text;
  v_result_status text;
  v_result_updated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  -- Fail-closed for NULL user_id (staff walk-in orders are not client-cancellable).
  if v_order.user_id is distinct from v_user_id then
    raise exception 'Недостаточно прав для отмены этого заказа';
  end if;

  if v_order.status <> 'new' then
    raise exception
      'Отменить можно только заказ со статусом "new" (текущий статус: %)', v_order.status;
  end if;

  select exists (
    select 1
    from public.inventory_reservations as r
    where r.order_id = v_order.id and r.status = 'active'
  ) into v_has_active_reservation;

  if not v_has_active_reservation then
    raise exception
      'У заказа нет активного резерва склада — отмена с освобождением остатка невозможна';
  end if;

  for v_reservation in
    select r.id, r.warehouse_id, r.product_id, r.quantity
    from public.inventory_reservations as r
    where r.order_id = v_order.id and r.status = 'active'
    order by r.product_id
    for update
  loop
    select i.reserved_quantity into v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id
    for update;

    if not found then
      raise exception
        'Складская запись для товара % не найдена, отмена невозможна', v_reservation.product_id;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара %: зарезервировано % меньше, чем требуется освободить (%)',
        v_reservation.product_id, v_inv_reserved, v_reservation.quantity;
    end if;

    update public.inventory as i
    set
      reserved_quantity = i.reserved_quantity - v_reservation.quantity,
      updated_at = now()
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id;

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось снять резерв товара %', v_reservation.product_id;
    end if;

    update public.inventory_reservations as r
    set status = 'released',
        released_at = now()
    where r.id = v_reservation.id
      and r.status = 'active';

    get diagnostics v_affected_rows = row_count;

    if v_affected_rows <> 1 then
      raise exception
        'Не удалось освободить резерв товара % для заказа %',
        v_reservation.product_id,
        v_order.order_number;
    end if;
  end loop;

  update public.orders as o
  set status = 'cancelled'
  where o.id = v_order.id
  returning o.id, o.order_number, o.status, o.updated_at
  into v_result_id, v_result_order_number, v_result_status, v_result_updated_at;

  return query
  select v_result_id, v_result_order_number, v_result_status, v_result_updated_at;
end;
$$;

revoke all on function public.cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;

-- ============================================================
-- 8. Notes
--
-- - create_order() body is intentionally not rewritten: BEFORE INSERT
--   trigger orders_ensure_customer_id_trg resolves customer_id from
--   company_id / profile_id so website checkout keeps working after
--   customer_id NOT NULL, and validates provided customer_id combos.
-- - staff_create_order(p_client_profile_id) keeps its signature and now
--   also writes customer_id via ensure_customer_for_profile().
-- - New staff_create_order_for_customer(p_customer_id) is the universal
--   path for registered and unregistered customers (no ambiguous overload).
-- - cancel_order() ownership uses IS DISTINCT FROM so NULL user_id
--   (walk-in) cannot be cancelled by arbitrary authenticated clients.
-- - Inventory reservation, order workflow RPCs, and stock write-off are
--   otherwise untouched.
-- - No service_role. customers has SELECT-only for authenticated (own
--   profile_id), writes only via staff SECURITY DEFINER RPCs.
-- ============================================================
