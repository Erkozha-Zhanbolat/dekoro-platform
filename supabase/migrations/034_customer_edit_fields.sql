-- ============================================================
-- 034_customer_edit_fields.sql
-- Hotfix — staff customer edit + company legal address
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–033 files.
--
-- Purpose:
--   1. Keep legal address on public.customers.address (no new column).
--      Stage 23 staff_assert_invoice_ready / staff_build_document_metadata
--      already read customers.address as «юридический адрес».
--   2. Strengthen staff_update_customer (same signature) so saved company
--      cards satisfy invoice buyer validation.
--   3. Align staff_create_customer required fields with the same rules
--      so new ЮЛ are invoice-ready.
--
-- Explicitly NOT done here:
--   - new legal_address column;
--   - customer_type switch individual ↔ company;
--   - client self-profile edit;
--   - warehouse / client write access.
-- ============================================================

do $$
begin
  if to_regclass('public.customers') is null then
    raise exception 'public.customers missing — run 013 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010 first.';
  end if;
  if to_regprocedure(
    'public.staff_update_customer(uuid, text, text, text, text, text, text, text, text, text, text)'
  ) is null then
    raise exception 'staff_update_customer missing — run 013 first.';
  end if;
  if to_regprocedure(
    'public.staff_create_customer(text, text, text, text, text, text, text, text, text, text, text)'
  ) is null then
    raise exception 'staff_create_customer missing — run 013/028 first.';
  end if;
end
$$;

comment on column public.customers.address is
  'For customer_type=company this is the legal address (юридический адрес) used by staff_assert_invoice_ready and invoice buyer.address. Not delivery or warehouse address.';

-- ============================================================
-- Shared card validation (same required fields as Stage 23 invoice)
-- ============================================================

create or replace function public.staff_assert_customer_card_ready(
  p_customer_type text,
  p_display_name text,
  p_legal_name text,
  p_phone text,
  p_email text,
  p_iin_bin text,
  p_contact_person text,
  p_address text
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
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;

comment on function public.staff_assert_customer_card_ready(
  text, text, text, text, text, text, text, text
) is
  'Internal. Required customer-card fields aligned with staff_assert_invoice_ready (023). company legal address = customers.address.';

-- ============================================================
-- staff_update_customer — same signature, invoice-aligned validation
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

  -- customer_type is immutable after create.
  -- NULL = keep existing; '' (after trim) = clear to null; non-empty = set.

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
    v_address
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
    -- customer_type / profile_id / company_id intentionally untouched
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

comment on function public.staff_update_customer(
  uuid, text, text, text, text, text, text, text, text, text, text
) is
  'Manager/admin customer card update. customer_type immutable. company.address is legal address for Stage 23 invoice.';

-- ============================================================
-- staff_create_customer — same signature, invoice-aligned required fields
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
    v_address
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

comment on function public.staff_create_customer(
  text, text, text, text, text, text, text, text, text, text, text
) is
  'Manager/admin create customer. Required fields match Stage 23 invoice buyer validation. company.address = legal address.';
