-- ============================================================
-- 035_customer_registration_crm_sync.sql
-- Stage 35 — Registration → canonical customer → CRM / profile / invoice
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–034 files.
--
-- Exact root cause (audit):
--   public.handle_new_user() creates auth.users + profiles + optional
--   companies, but NEVER public.customers. /staff/customers reads only
--   public.customers (staff_search_customers). Customers were created
--   lazily on first order via ensure_customer_* (013/028).
--   For ИП/ТОО, ensure_customer_for_company also left profile_id NULL,
--   so is_registered = false and clients could not see their own row
--   (RLS: profile_id = auth.uid()).
--   Registration never collected city / legal address.
--   /profile was read-only (profiles + companies, not customers).
--
-- DB mapping (no new legal-form column):
--   Физическое лицо → customer_type = individual
--   ИП             → customer_type = company
--   ТОО            → customer_type = company
--
-- Canonical fields:
--   customers.city    = город (all types)
--   customers.address = юридический адрес (ИП/ТОО only; Stage 23 buyer.address)
--
-- Source of truth after this migration: public.customers for CRM, orders,
-- invoice buyer snapshot, pricing assignment. Profile/company are identity
-- mirrors updated one-way from customer RPCs (no bidirectional triggers).
-- ============================================================

do $$
begin
  if to_regclass('public.customers') is null then
    raise exception 'public.customers missing — run 013 first.';
  end if;
  if to_regprocedure('public.handle_new_user()') is null then
    raise exception 'handle_new_user() missing — run 001/004/024 first.';
  end if;
  if to_regprocedure('public.ensure_customer_for_profile(uuid)') is null then
    raise exception 'ensure_customer_for_profile missing — run 013/028 first.';
  end if;
  if to_regprocedure('public.ensure_customer_for_company(uuid)') is null then
    raise exception 'ensure_customer_for_company missing — run 013/028 first.';
  end if;
  if to_regprocedure(
    'public.staff_update_customer(uuid, text, text, text, text, text, text, text, text, text, text)'
  ) is null then
    raise exception 'staff_update_customer missing — run 013/034 first.';
  end if;
  if to_regprocedure(
    'public.staff_create_customer(text, text, text, text, text, text, text, text, text, text, text)'
  ) is null then
    raise exception 'staff_create_customer missing — run 013/028/034 first.';
  end if;
  if to_regprocedure(
    'public.staff_assert_customer_card_ready(text, text, text, text, text, text, text, text)'
  ) is null then
    raise exception 'staff_assert_customer_card_ready missing — run 034 first.';
  end if;
  if to_regprocedure('public.staff_search_customers(text, integer)') is null then
    raise exception 'staff_search_customers missing — run 013 first.';
  end if;
  if to_regprocedure('public.staff_get_customer(uuid)') is null then
    raise exception 'staff_get_customer missing — run 013/028 first.';
  end if;
end
$$;

comment on column public.customers.city is
  'City only (e.g. Алматы). Required for new registration and card edits. Not the legal address.';

comment on column public.customers.address is
  'For customer_type=company this is the legal address (юридический адрес) used by staff_assert_invoice_ready and invoice buyer.address. Not city and not delivery/warehouse address.';

-- Unique guards already exist from 013:
--   customers_profile_id_unique (profile_id) where profile_id is not null
--   customers_company_id_unique (company_id) where company_id is not null
-- Recreate IF NOT EXISTS so a partial apply cannot skip them.

create unique index if not exists customers_profile_id_unique
  on public.customers (profile_id)
  where profile_id is not null;

create unique index if not exists customers_company_id_unique
  on public.customers (company_id)
  where company_id is not null;

-- ============================================================
-- Registered flag: profile link OR a client profile on the same company
-- ============================================================

create or replace function public.customer_is_registered(p_customer public.customers)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select
    p_customer.profile_id is not null
    or (
      p_customer.company_id is not null
      and exists (
        select 1
        from public.profiles as p
        where p.role = 'client'
          and p.company_id is not null
          and p.company_id = p_customer.company_id
      )
    );
$$;

revoke all on function public.customer_is_registered(public.customers)
  from public, anon, authenticated;

-- ============================================================
-- One-way identity mirror: customers → profiles / companies
-- No reverse trigger (avoids loops).
-- ============================================================

create or replace function public.sync_linked_identity_from_customer(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.customers;
begin
  if p_customer_id is null then
    return;
  end if;

  select * into v_c
  from public.customers as c
  where c.id = p_customer_id;

  if not found then
    return;
  end if;

  if v_c.profile_id is not null then
    update public.profiles as p
    set
      full_name = case
        when v_c.customer_type = 'individual' then
          coalesce(nullif(trim(v_c.display_name), ''), p.full_name)
        else
          coalesce(nullif(trim(v_c.contact_person), ''), p.full_name)
      end,
      phone = v_c.phone
    where p.id = v_c.profile_id;
  end if;

  if v_c.company_id is not null then
    update public.companies as co
    set
      name = coalesce(
        nullif(trim(v_c.legal_name), ''),
        nullif(trim(v_c.display_name), ''),
        co.name
      ),
      phone = v_c.phone,
      email = v_c.email,
      bin = case
        when v_c.iin_bin ~ '^\d{12}$' then v_c.iin_bin
        else co.bin
      end
    where co.id = v_c.company_id;
  end if;
exception
  when unique_violation then
    raise exception 'Этот БИН / ИИН уже используется';
end;
$$;

revoke all on function public.sync_linked_identity_from_customer(uuid)
  from public, anon, authenticated;

-- ============================================================
-- Fill only blank customer fields from linked identity + optional city/address.
-- Never invent city/address. Never copy city into address.
-- ============================================================

create or replace function public.apply_identity_defaults_to_customer(
  p_customer_id uuid,
  p_city text default null,
  p_address text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.customers;
  v_profile_id uuid;
  v_profile_full_name text;
  v_profile_phone text;
  v_company_name text;
  v_company_phone text;
  v_company_email text;
  v_company_bin text;
  v_email text;
  v_client_count integer;
  v_city text := nullif(trim(coalesce(p_city, '')), '');
  v_address text := nullif(trim(coalesce(p_address, '')), '');
begin
  if p_customer_id is null then
    raise exception 'customer_id обязателен';
  end if;

  select * into v_c
  from public.customers as c
  where c.id = p_customer_id
  for update;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  if v_c.profile_id is not null then
    select p.id, p.full_name, p.phone
    into v_profile_id, v_profile_full_name, v_profile_phone
    from public.profiles as p
    where p.id = v_c.profile_id;
  elsif v_c.company_id is not null then
    select count(*) into v_client_count
    from public.profiles as p2
    where p2.company_id = v_c.company_id
      and p2.role = 'client';
    if v_client_count = 1 then
      select p.id, p.full_name, p.phone
      into v_profile_id, v_profile_full_name, v_profile_phone
      from public.profiles as p
      where p.company_id = v_c.company_id
        and p.role = 'client';
    end if;
  end if;

  if v_c.company_id is not null then
    select co.name, co.phone, co.email, co.bin
    into v_company_name, v_company_phone, v_company_email, v_company_bin
    from public.companies as co
    where co.id = v_c.company_id;
  end if;

  if v_profile_id is not null then
    select au.email::text into v_email from auth.users as au where au.id = v_profile_id;
  end if;

  update public.customers as c
  set
    display_name = coalesce(
      nullif(trim(c.display_name), ''),
      case
        when c.customer_type = 'company' then
          coalesce(nullif(trim(c.legal_name), ''), nullif(trim(v_company_name), ''), nullif(trim(v_profile_full_name), ''))
        else
          nullif(trim(v_profile_full_name), '')
      end,
      c.display_name
    ),
    legal_name = case
      when c.customer_type = 'company' then
        coalesce(
          nullif(trim(c.legal_name), ''),
          nullif(trim(v_company_name), ''),
          nullif(trim(c.display_name), '')
        )
      else c.legal_name
    end,
    phone = coalesce(
      nullif(trim(c.phone), ''),
      nullif(trim(v_profile_phone), ''),
      nullif(trim(v_company_phone), '')
    ),
    email = coalesce(
      nullif(trim(c.email), ''),
      nullif(trim(v_company_email), ''),
      nullif(trim(v_email), '')
    ),
    iin_bin = case
      when c.customer_type = 'company' then
        coalesce(nullif(trim(c.iin_bin), ''), nullif(trim(v_company_bin), ''))
      else c.iin_bin
    end,
    contact_person = case
      when c.customer_type = 'company' then
        coalesce(nullif(trim(c.contact_person), ''), nullif(trim(v_profile_full_name), ''))
      else c.contact_person
    end,
    city = coalesce(nullif(trim(c.city), ''), v_city),
    address = case
      when c.customer_type = 'company' then
        coalesce(nullif(trim(c.address), ''), v_address)
      else c.address
    end
  where c.id = p_customer_id;

  return p_customer_id;
end;
$$;

revoke all on function public.apply_identity_defaults_to_customer(uuid, text, text)
  from public, anon, authenticated;

-- ============================================================
-- Safe profile_id attach on an existing company customer
-- ============================================================

create or replace function public.try_link_customer_profile_unambiguous(
  p_customer_id uuid,
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.customers;
  v_profile public.profiles;
  v_client_count integer;
begin
  if p_customer_id is null or p_profile_id is null then
    return;
  end if;

  select * into v_c
  from public.customers as c
  where c.id = p_customer_id
  for update;

  if not found then
    return;
  end if;

  if v_c.profile_id is not null then
    return;
  end if;

  if exists (
    select 1 from public.customers as x
    where x.profile_id = p_profile_id
      and x.id <> p_customer_id
  ) then
    return;
  end if;

  select * into v_profile from public.profiles as p where p.id = p_profile_id;
  if not found or v_profile.role <> 'client' then
    return;
  end if;

  if v_c.company_id is not null then
    if v_profile.company_id is distinct from v_c.company_id then
      return;
    end if;
    select count(*) into v_client_count
    from public.profiles as p
    where p.company_id = v_c.company_id
      and p.role = 'client';
    if v_client_count <> 1 then
      return;
    end if;
  elsif v_c.customer_type = 'individual' then
    if v_profile.customer_type <> 'individual' then
      return;
    end if;
  end if;

  update public.customers as c
  set profile_id = p_profile_id
  where c.id = p_customer_id
    and c.profile_id is null;
end;
$$;

revoke all on function public.try_link_customer_profile_unambiguous(uuid, uuid)
  from public, anon, authenticated;

-- ============================================================
-- ensure_customer_for_company — keep uuid signature; attach profile if safe
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
  v_profile_id uuid;
  v_profile_full_name text;
  v_profile_phone text;
  v_profile_email text;
  v_client_count integer;
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
    perform public.apply_identity_defaults_to_customer(v_customer_id, null, null);
    return v_customer_id;
  end if;

  select * into v_company
  from public.companies as c
  where c.id = p_company_id;

  if not found then
    raise exception 'Компания не найдена';
  end if;

  select count(*) into v_client_count
  from public.profiles as p
  where p.company_id = p_company_id
    and p.role = 'client';

  if v_client_count = 1 then
    select p.id, p.full_name, p.phone
    into v_profile_id, v_profile_full_name, v_profile_phone
    from public.profiles as p
    where p.company_id = p_company_id
      and p.role = 'client';

    if v_profile_id is not null
       and exists (
         select 1 from public.customers as x where x.profile_id = v_profile_id
       )
    then
      v_profile_id := null;
    end if;

    if v_profile_id is not null then
      select au.email::text into v_profile_email
      from auth.users as au
      where au.id = v_profile_id;
    end if;
  end if;

  insert into public.customers (
    customer_type,
    company_id,
    profile_id,
    display_name,
    legal_name,
    phone,
    email,
    iin_bin,
    contact_person,
    source,
    price_group_id
  )
  select
    'company',
    v_company.id,
    v_profile_id,
    v_company.name,
    v_company.name,
    coalesce(nullif(trim(v_company.phone), ''), nullif(trim(v_profile_phone), '')),
    coalesce(nullif(trim(v_company.email), ''), nullif(trim(v_profile_email), '')),
    nullif(trim(v_company.bin), ''),
    nullif(trim(v_profile_full_name), ''),
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

  perform public.apply_identity_defaults_to_customer(v_customer_id, null, null);
  return v_customer_id;
end;
$$;

revoke all on function public.ensure_customer_for_company(uuid)
  from public, anon, authenticated;

-- ============================================================
-- ensure_customer_for_profile — same uuid signature; company keeps type=company
-- ============================================================

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

  select c.id into v_customer_id
  from public.customers as c
  where c.profile_id = p_profile_id;

  if found then
    if (select c.price_group_id from public.customers as c where c.id = v_customer_id) is null then
      update public.customers as c
      set price_group_id = v_default_group_id
      where c.id = v_customer_id
        and c.price_group_id is null;
    end if;
    perform public.apply_identity_defaults_to_customer(v_customer_id, null, null);
    return v_customer_id;
  end if;

  if v_profile.customer_type = 'company' and v_profile.company_id is not null then
    v_customer_id := public.ensure_customer_for_company(v_profile.company_id);
    perform public.try_link_customer_profile_unambiguous(v_customer_id, p_profile_id);
    perform public.apply_identity_defaults_to_customer(v_customer_id, null, null);
    return v_customer_id;
  end if;

  select au.email::text into v_email
  from auth.users as au
  where au.id = p_profile_id;

  v_display_name := nullif(trim(v_profile.full_name), '');
  if v_display_name is null then
    v_display_name := coalesce(nullif(trim(v_email), ''), 'Клиент');
  end if;

  if v_profile.customer_type = 'company' then
    insert into public.customers (
      customer_type,
      profile_id,
      display_name,
      legal_name,
      phone,
      email,
      contact_person,
      source,
      price_group_id
    )
    select
      'company',
      v_profile.id,
      v_display_name,
      v_display_name,
      nullif(trim(v_profile.phone), ''),
      nullif(trim(v_email), ''),
      v_display_name,
      'website',
      v_default_group_id
    where not exists (
      select 1 from public.customers as c where c.profile_id = p_profile_id
    )
    returning id into v_customer_id;
  else
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
  end if;

  if v_customer_id is null then
    select c.id into v_customer_id
    from public.customers as c
    where c.profile_id = p_profile_id;
  end if;

  if v_customer_id is null then
    raise exception 'Не удалось создать customer для профиля %', p_profile_id;
  end if;

  perform public.apply_identity_defaults_to_customer(v_customer_id, null, null);
  return v_customer_id;
end;
$$;

revoke all on function public.ensure_customer_for_profile(uuid)
  from public, anon, authenticated;

-- ============================================================
-- handle_new_user — create canonical customer at registration
-- Same trigger signature (returns trigger). Staff invite still skips CRM.
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
  v_city text;
  v_address text;
  v_full_name text;
  v_staff_invite boolean;
  v_staff_role text;
  v_role public.user_role := 'client';
  v_customer_id uuid;
begin
  v_company_name := nullif(trim(new.raw_user_meta_data ->> 'company_name'), '');
  v_bin := nullif(trim(new.raw_user_meta_data ->> 'bin'), '');
  v_contact_person := nullif(trim(new.raw_user_meta_data ->> 'contact_person'), '');
  v_individual_name := nullif(trim(new.raw_user_meta_data ->> 'name'), '');
  v_phone := nullif(trim(regexp_replace(coalesce(new.raw_user_meta_data ->> 'phone', ''), '\s+', ' ', 'g')), '');
  v_city := nullif(trim(new.raw_user_meta_data ->> 'city'), '');
  v_address := nullif(trim(new.raw_user_meta_data ->> 'address'), '');

  v_staff_invite := coalesce(new.raw_user_meta_data ->> 'dekoro_staff_invite', '') in ('true', '1');
  v_staff_role := nullif(trim(new.raw_user_meta_data ->> 'staff_role'), '');

  if v_staff_invite
     and v_staff_role in ('admin', 'manager', 'accountant', 'warehouse') then
    v_role := v_staff_role::public.user_role;
    v_full_name := coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      v_individual_name,
      v_contact_person,
      split_part(new.email, '@', 1),
      'Новый сотрудник'
    );

    insert into public.profiles (id, company_id, full_name, phone, role, customer_type)
    values (
      new.id,
      null,
      v_full_name,
      v_phone,
      v_role,
      'individual'
    )
    on conflict (id) do nothing;

    return new;
  end if;

  v_customer_type := nullif(trim(new.raw_user_meta_data ->> 'customer_type'), '');
  if v_customer_type is null or v_customer_type not in ('individual', 'company') then
    v_customer_type := case
      when v_company_name is not null and v_bin is not null then 'company'
      else 'individual'
    end;
  end if;

  if v_phone is null then
    raise exception 'Укажите телефон';
  end if;
  if v_city is null then
    raise exception 'Укажите город';
  end if;

  if v_customer_type = 'company' then
    if v_company_name is null then
      raise exception 'Укажите юридическое название';
    end if;
    if v_bin is null or v_bin !~ '^\d{12}$' then
      raise exception 'БИН / ИИН должен содержать ровно 12 цифр';
    end if;
    if v_address is null then
      raise exception 'Укажите юридический адрес';
    end if;
    if v_contact_person is null then
      raise exception 'Укажите контактное лицо';
    end if;

    insert into public.companies (name, bin, phone, email)
    values (v_company_name, v_bin, v_phone, new.email)
    on conflict (bin) do nothing
    returning id into v_company_id;

    if v_company_id is null then
      select id into v_company_id from public.companies where bin = v_bin;
    end if;

    if v_company_id is null then
      raise exception 'Не удалось создать компанию';
    end if;

    v_full_name := v_contact_person;
  else
    v_customer_type := 'individual';
    v_company_id := null;
    v_full_name := v_individual_name;
    if v_full_name is null then
      raise exception 'Укажите ФИО';
    end if;
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

  v_customer_id := public.ensure_customer_for_profile(new.id);
  perform public.apply_identity_defaults_to_customer(v_customer_id, v_city, v_address);

  return new;
end;
$$;

-- ============================================================
-- Client ownership RPCs — server resolves customer from auth.uid()
-- Browser never sends trusted customer_id.
-- ============================================================

create or replace function public.client_resolve_my_customer_id()
returns uuid
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_customer_id uuid;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_uid;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  select c.id into v_customer_id
  from public.customers as c
  where c.profile_id = v_uid;

  if found then
    return v_customer_id;
  end if;

  if v_profile.company_id is not null then
    select c.id into v_customer_id
    from public.customers as c
    where c.company_id = v_profile.company_id;

    if found then
      return v_customer_id;
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.client_resolve_my_customer_id()
  from public, anon, authenticated;

create or replace function public.client_get_my_customer_details()
returns table (
  id uuid,
  customer_type text,
  display_name text,
  legal_name text,
  phone text,
  email text,
  iin_bin text,
  contact_person text,
  address text,
  city text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_customer_id uuid;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_uid;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_profile.role <> 'client' then
    return;
  end if;

  v_customer_id := public.client_resolve_my_customer_id();

  if v_customer_id is null then
    v_customer_id := public.ensure_customer_for_profile(v_uid);
  end if;

  return query
  select
    c.id,
    c.customer_type,
    c.display_name,
    c.legal_name,
    c.phone,
    c.email,
    c.iin_bin,
    c.contact_person,
    c.address,
    c.city
  from public.customers as c
  where c.id = v_customer_id;
end;
$$;

revoke all on function public.client_get_my_customer_details()
  from public, anon, authenticated;
grant execute on function public.client_get_my_customer_details() to authenticated;

comment on function public.client_get_my_customer_details() is
  'Client-safe canonical customer card. Resolves customer from auth.uid(); no customer_id argument.';

create or replace function public.client_update_my_customer_details(
  p_display_name text default null,
  p_legal_name text default null,
  p_iin_bin text default null,
  p_city text default null,
  p_address text default null,
  p_contact_person text default null,
  p_phone text default null,
  p_email text default null
)
returns table (
  id uuid,
  customer_type text,
  display_name text,
  legal_name text,
  phone text,
  email text,
  iin_bin text,
  contact_person text,
  address text,
  city text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_existing public.customers;
  v_customer_id uuid;
  v_display_name text;
  v_legal_name text;
  v_iin_bin text;
  v_city text;
  v_address text;
  v_contact_person text;
  v_phone text;
  v_email text;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_uid;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_profile.role <> 'client' then
    raise exception 'Недостаточно прав для изменения карточки клиента';
  end if;

  if not v_profile.is_active then
    raise exception 'Профиль неактивен';
  end if;

  v_customer_id := public.client_resolve_my_customer_id();
  if v_customer_id is null then
    v_customer_id := public.ensure_customer_for_profile(v_uid);
  end if;

  select * into v_existing
  from public.customers as c
  where c.id = v_customer_id
  for update;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  -- Ownership: must be this user's profile or their unambiguous company card.
  if v_existing.profile_id is distinct from v_uid
     and (
       v_profile.company_id is null
       or v_existing.company_id is distinct from v_profile.company_id
     )
  then
    raise exception 'Недостаточно прав для изменения карточки клиента';
  end if;

  v_phone := nullif(trim(regexp_replace(coalesce(p_phone, ''), '\s+', ' ', 'g')), '');
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_city := nullif(trim(coalesce(p_city, '')), '');

  if v_existing.customer_type = 'individual' then
    v_display_name := nullif(trim(coalesce(p_display_name, '')), '');
    if v_display_name is null then
      raise exception 'Укажите ФИО';
    end if;
    if v_city is null then
      raise exception 'Укажите город';
    end if;
    if v_phone is null then
      raise exception 'Укажите телефон';
    end if;
    if v_email is null then
      raise exception 'Укажите email';
    end if;

    update public.customers as c
    set
      display_name = v_display_name,
      phone = v_phone,
      email = v_email,
      city = v_city
      -- customer_type / price_group / links / address / iin_bin untouched
    where c.id = v_customer_id;
  else
    v_legal_name := nullif(trim(coalesce(p_legal_name, '')), '');
    v_iin_bin := nullif(trim(coalesce(p_iin_bin, '')), '');
    v_address := nullif(trim(coalesce(p_address, '')), '');
    v_contact_person := nullif(trim(coalesce(p_contact_person, '')), '');

    if v_legal_name is null then
      raise exception 'Укажите юридическое название';
    end if;
    if v_iin_bin is null or v_iin_bin !~ '^\d{12}$' then
      raise exception 'БИН / ИИН должен содержать ровно 12 цифр';
    end if;
    if v_city is null then
      raise exception 'Укажите город';
    end if;
    if v_address is null then
      raise exception 'Укажите юридический адрес';
    end if;
    if v_contact_person is null then
      raise exception 'Укажите контактное лицо';
    end if;
    if v_phone is null then
      raise exception 'Укажите телефон';
    end if;
    if v_email is null then
      raise exception 'Укажите email';
    end if;

    update public.customers as c
    set
      display_name = v_legal_name,
      legal_name = v_legal_name,
      iin_bin = v_iin_bin,
      city = v_city,
      address = v_address,
      contact_person = v_contact_person,
      phone = v_phone,
      email = v_email
      -- customer_type / price_group / profile_id / company_id untouched
    where c.id = v_customer_id;
  end if;

  perform public.sync_linked_identity_from_customer(v_customer_id);

  return query
  select
    c.id,
    c.customer_type,
    c.display_name,
    c.legal_name,
    c.phone,
    c.email,
    c.iin_bin,
    c.contact_person,
    c.address,
    c.city
  from public.customers as c
  where c.id = v_customer_id;
end;
$$;

revoke all on function public.client_update_my_customer_details(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.client_update_my_customer_details(
  text, text, text, text, text, text, text, text
) to authenticated;

comment on function public.client_update_my_customer_details(
  text, text, text, text, text, text, text, text
) is
  'Ownership-based client self-edit. Customer is resolved from auth.uid(); client cannot pass a foreign customer_id or change pricing/type/links.';

-- ============================================================
-- RLS: company clients can SELECT their company customer even if
-- profile_id was not attached (ambiguous BIN share).
-- Still no INSERT/UPDATE/DELETE policy — writes go through RPCs.
-- ============================================================

drop policy if exists customers_select_own on public.customers;
create policy customers_select_own
  on public.customers
  for select
  to authenticated
  using (
    profile_id = auth.uid()
    or (
      company_id is not null
      and company_id in (
        select p.company_id
        from public.profiles as p
        where p.id = auth.uid()
          and p.company_id is not null
          and p.role = 'client'
      )
    )
  );

-- ============================================================
-- staff_assert_customer_card_ready — add required city
-- Signature change → exact DROP of 034 8-arg version (no CASCADE).
-- Callers staff_create/update are replaced below in this file.
-- plpgsql has no hard dependency on the old signature.
-- ============================================================

drop function if exists public.staff_assert_customer_card_ready(
  text, text, text, text, text, text, text, text
);

create or replace function public.staff_assert_customer_card_ready(
  p_customer_type text,
  p_display_name text,
  p_legal_name text,
  p_phone text,
  p_email text,
  p_iin_bin text,
  p_contact_person text,
  p_address text,
  p_city text
)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_type text := nullif(trim(coalesce(p_customer_type, '')), '');
  v_missing text[] := array[]::text[];
begin
  if v_type is null or v_type not in ('individual', 'company') then
    raise exception 'Некорректный тип клиента: %', coalesce(p_customer_type, 'null');
  end if;

  if nullif(trim(coalesce(p_city, '')), '') is null then
    v_missing := array_append(v_missing, 'город');
  end if;

  if v_type = 'individual' then
    if nullif(trim(coalesce(p_display_name, '')), '') is null then
      v_missing := array_append(v_missing, 'ФИО');
    end if;
    if nullif(trim(coalesce(p_phone, '')), '') is null then
      v_missing := array_append(v_missing, 'телефон');
    end if;
    if nullif(trim(coalesce(p_email, '')), '') is null then
      v_missing := array_append(v_missing, 'email');
    end if;

    if coalesce(array_length(v_missing, 1), 0) > 0 then
      raise exception
        'Для физического лица не заполнены обязательные поля: %',
        array_to_string(v_missing, ', ');
    end if;

    return;
  end if;

  if nullif(trim(coalesce(p_legal_name, p_display_name, '')), '') is null then
    v_missing := array_append(v_missing, 'юридическое название');
  end if;
  if nullif(trim(coalesce(p_iin_bin, '')), '') is null then
    v_missing := array_append(v_missing, 'БИН');
  end if;
  if nullif(trim(coalesce(p_address, '')), '') is null then
    v_missing := array_append(v_missing, 'юридический адрес');
  end if;
  if nullif(trim(coalesce(p_contact_person, '')), '') is null then
    v_missing := array_append(v_missing, 'контактное лицо');
  end if;
  if nullif(trim(coalesce(p_phone, '')), '') is null then
    v_missing := array_append(v_missing, 'телефон');
  end if;
  if nullif(trim(coalesce(p_email, '')), '') is null then
    v_missing := array_append(v_missing, 'email');
  end if;

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception
      'Для юридического лица не заполнены обязательные поля: %',
      array_to_string(v_missing, ', ');
  end if;
end;
$$;

revoke all on function public.staff_assert_customer_card_ready(
  text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;

comment on function public.staff_assert_customer_card_ready(
  text, text, text, text, text, text, text, text, text
) is
  'Internal. Required customer-card fields. city required for all types. company legal address = customers.address.';

-- ============================================================
-- staff_update_customer — same 11-arg signature + city assert + identity sync
-- ============================================================

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

  if auth.uid() is null then
    raise exception 'Требуется авторизация';
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

  if p_display_name is null then
    v_display_name := v_existing.display_name;
  else
    v_display_name := nullif(trim(p_display_name), '');
  end if;

  v_legal_name := case
    when p_legal_name is null then v_existing.legal_name
    else nullif(trim(p_legal_name), '')
  end;
  v_phone := case
    when p_phone is null then v_existing.phone
    else nullif(trim(regexp_replace(p_phone, '\s+', ' ', 'g')), '')
  end;
  v_email := case
    when p_email is null then v_existing.email
    else nullif(lower(trim(p_email)), '')
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

  if v_existing.customer_type = 'company' and v_display_name is null then
    v_display_name := v_legal_name;
  end if;

  if v_display_name is null then
    raise exception 'Имя клиента обязательно';
  end if;

  if v_source is not null
     and v_source not in ('website', 'staff', 'phone', 'whatsapp', 'instagram', 'referral', 'other')
  then
    raise exception 'Некорректный источник клиента';
  end if;

  perform public.staff_assert_customer_card_ready(
    v_existing.customer_type,
    v_display_name,
    v_legal_name,
    v_phone,
    v_email,
    v_iin_bin,
    v_contact_person,
    v_address,
    v_city
  );

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
    -- customer_type / profile_id / company_id / price_group_id untouched
  where c.id = p_customer_id
  returning * into v_customer;

  perform public.sync_linked_identity_from_customer(v_customer.id);

  return v_customer;
end;
$$;

revoke all on function public.staff_update_customer(
  uuid, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.staff_update_customer(
  uuid, text, text, text, text, text, text, text, text, text, text
) to authenticated;

-- ============================================================
-- staff_create_customer — same signature + required city
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

  v_legal_name := nullif(trim(p_legal_name), '');
  v_display_name := nullif(trim(p_display_name), '');
  if v_display_name is null then
    v_display_name := v_legal_name;
  end if;

  v_phone := nullif(trim(regexp_replace(coalesce(p_phone, ''), '\s+', ' ', 'g')), '');
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_iin_bin := nullif(trim(p_iin_bin), '');
  v_contact_person := nullif(trim(p_contact_person), '');
  v_address := nullif(trim(p_address), '');
  v_city := nullif(trim(p_city), '');
  v_source := coalesce(nullif(trim(p_source), ''), 'staff');
  v_notes := nullif(trim(p_notes), '');

  if v_source not in ('website', 'staff', 'phone', 'whatsapp', 'instagram', 'referral', 'other') then
    raise exception 'Некорректный источник клиента';
  end if;

  perform public.staff_assert_customer_card_ready(
    v_type,
    v_display_name,
    v_legal_name,
    v_phone,
    v_email,
    v_iin_bin,
    v_contact_person,
    v_address,
    v_city
  );

  if v_display_name is null then
    raise exception 'Имя клиента обязательно';
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
-- staff_get_customer — is_registered via customer_is_registered()
-- Same OUT columns as 028 (no DROP).
-- ============================================================

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
    public.customer_is_registered(c) as is_registered,
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
-- staff_search_customers — add list columns (iin_bin, contact, price group)
-- OUT change → exact DROP of 013 signature (no CASCADE).
-- ============================================================

drop function if exists public.staff_search_customers(text, integer);

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
  last_order_at timestamptz,
  iin_bin text,
  contact_person text,
  is_registered boolean,
  price_group_id uuid,
  price_group_name text
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
      stats.last_order_at,
      c.iin_bin,
      c.contact_person,
      public.customer_is_registered(c) as is_registered,
      pg.id as price_group_id,
      pg.name as price_group_name
    from public.customers as c
    left join public.price_groups as pg on pg.id = c.price_group_id
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
    stats.last_order_at,
    c.iin_bin,
    c.contact_person,
    public.customer_is_registered(c) as is_registered,
    pg.id as price_group_id,
    pg.name as price_group_name
  from public.customers as c
  left join public.price_groups as pg on pg.id = c.price_group_id
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
     or coalesce(c.city, '') ilike ('%' || v_term || '%') escape '\'
  order by c.display_name
  limit v_limit;
end;
$$;

revoke all on function public.staff_search_customers(text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_search_customers(text, integer)
  to authenticated;

-- ============================================================
-- Backfill existing client users → canonical customer
-- No fuzzy merge. No invented city/address. No order rewrites.
-- ============================================================

do $$
declare
  v_profile record;
  v_ensured integer := 0;
  v_skipped integer := 0;
  v_linked integer := 0;
begin
  for v_profile in
    select p.*
    from public.profiles as p
    where p.role = 'client'
      and not exists (
        select 1
        from public.customers as c
        where c.profile_id = p.id
           or (
             p.company_id is not null
             and c.company_id = p.company_id
           )
      )
  loop
    begin
      perform public.ensure_customer_for_profile(v_profile.id);
      v_ensured := v_ensured + 1;
    exception
      when others then
        v_skipped := v_skipped + 1;
        raise notice '035 backfill skip profile %: %', v_profile.id, sqlerrm;
    end;
  end loop;

  update public.customers as c
  set profile_id = p.id
  from public.profiles as p
  where c.profile_id is null
    and c.company_id is not null
    and p.company_id = c.company_id
    and p.role = 'client'
    and not exists (
      select 1 from public.customers as x
      where x.profile_id = p.id
        and x.id <> c.id
    )
    and (
      select count(*)
      from public.profiles as p2
      where p2.company_id = c.company_id
        and p2.role = 'client'
    ) = 1;

  get diagnostics v_linked = row_count;

  for v_profile in
    select c.id as id
    from public.customers as c
    where c.profile_id is not null
       or c.company_id is not null
  loop
    begin
      perform public.apply_identity_defaults_to_customer(v_profile.id, null, null);
    exception
      when others then
        raise notice '035 identity fill skip customer %: %', v_profile.id, sqlerrm;
    end;
  end loop;

  raise notice
    '035 backfill: ensured_missing=% linked_profile_id=% skipped=%',
    v_ensured, v_linked, v_skipped;
end
$$;
