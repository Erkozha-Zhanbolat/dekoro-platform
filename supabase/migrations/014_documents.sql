-- DEKORO Platform V2 — Staff Platform
-- Migration: order documents foundation (Stage 4)
--
-- Depends on:
--   001_companies_and_profiles.sql (public.set_updated_at, public.profiles)
--   002_catalog_inventory_pricing.sql (public.products.unit)
--   005_orders.sql (public.orders, public.order_items, DK-###### numbers)
--   007_checkout_order_details.sql (contact / delivery columns)
--   010_staff_role_access.sql (public.has_staff_role)
--   012_staff_order_workflow.sql (workflow — untouched)
--   013_customers_foundation.sql (public.customers, orders.customer_id)
--
-- Run this file once in the Supabase SQL Editor after 013.
-- NOT applied by this change — apply by hand when ready.
--
-- Purpose: manager/admin generate invoice + delivery-note *data* rows
-- with immutable metadata snapshots. No PDF yet. Documents are Russian-only
-- (no language field / selector).
--
-- Organization legal requisites live in public.organization_settings
-- (singleton). Document status cannot become 'generated' until required
-- supplier fields are filled with real values — no fictional BIN/bank.
--
-- Tax: manager chooses without_vat | with_vat at generate time.
-- VAT rate is stored in organization_settings.vat_rate (not hardcoded).
-- Kazakhstan standard rate is typically 12% — set via admin upsert.
-- Order line prices are treated as NET (ex-VAT); with_vat adds VAT on top.
--
-- Explicitly NOT done:
--   - PDF generation;
--   - document language / translations;
--   - renaming order numbers (DK-###### stays);
--   - changing reservation / workflow / stock write-off;
--   - service_role;
--   - direct table grants on order_documents / organization_settings.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run 005_orders.sql first.';
  end if;

  if to_regclass('public.products') is null then
    raise exception
      'public.products is missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.customers') is null then
    raise exception
      'public.customers is missing — run 013_customers_foundation.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'public.set_updated_at() is missing — run 001_companies_and_profiles.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception
      'public.has_staff_role(...) missing — run 010_staff_role_access.sql first.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'customer_id'
  ) then
    raise exception
      'public.orders.customer_id is missing — run 013_customers_foundation.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. public.organization_settings (singleton — DEKORO as seller)
--
-- Empty row inserted. Fill real requisites in SQL Editor / later admin UI
-- before generating documents. No fictional legal values.
-- ============================================================

create table if not exists public.organization_settings (
  id uuid primary key default gen_random_uuid(),
  singleton_key text not null default 'default',
  legal_name text,
  bin text,
  address text,
  city text,
  phone text,
  email text,
  bank_name text,
  bank_bik text,
  bank_iik text,
  bank_kbe text,
  director_name text,
  warehouse_name text,
  warehouse_code text,
  -- Tax defaults for document UI / with_vat validation.
  -- vat_rate is NOT hardcoded in SQL (KZ typical = 12.00 — set by admin).
  default_tax_mode text not null default 'without_vat',
  vat_rate numeric(5, 2),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_settings_singleton_key_check check (singleton_key = 'default'),
  constraint organization_settings_singleton_unique unique (singleton_key),
  constraint organization_settings_bin_format check (
    bin is null or bin ~ '^\d{12}$'
  ),
  constraint organization_settings_default_tax_mode_check check (
    default_tax_mode in ('without_vat', 'with_vat')
  ),
  constraint organization_settings_vat_rate_range check (
    vat_rate is null or (vat_rate >= 0 and vat_rate <= 100)
  )
);

drop trigger if exists set_organization_settings_updated_at on public.organization_settings;
create trigger set_organization_settings_updated_at
  before update on public.organization_settings
  for each row
  execute function public.set_updated_at();

alter table public.organization_settings enable row level security;

revoke all on table public.organization_settings from public;
revoke all on table public.organization_settings from anon;
revoke all on table public.organization_settings from authenticated;

-- Empty singleton — generation blocked until required fields are set.
insert into public.organization_settings (singleton_key)
values ('default')
on conflict (singleton_key) do nothing;

comment on table public.organization_settings is
  'Singleton DEKORO seller requisites for invoices / delivery notes. Fill before generating documents.';

-- ============================================================
-- 2. public.order_documents
-- ============================================================

create table if not exists public.order_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  document_type text not null,
  number text not null,
  status text not null default 'generated',
  file_path text,
  generated_by uuid not null references public.profiles (id) on delete restrict,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint order_documents_type_check check (
    document_type in ('invoice', 'delivery_note')
  ),
  -- 'generated' = immutable data snapshot ready for future PDF.
  -- 'cancelled' reserved for a future cancel-document flow (no RPC yet).
  -- 'draft' intentionally NOT used: generate creates 'generated' directly.
  constraint order_documents_status_check check (
    status in ('generated', 'cancelled')
  ),
  constraint order_documents_number_not_blank check (
    length(trim(number)) > 0
  ),
  constraint order_documents_number_format check (
    number ~ '^(INV|OUT)-[0-9]{6}$'
  ),
  constraint order_documents_number_unique unique (number),
  constraint order_documents_order_type_unique unique (order_id, document_type)
);

create index if not exists order_documents_order_id_idx
  on public.order_documents (order_id);

create index if not exists order_documents_type_idx
  on public.order_documents (document_type);

create index if not exists order_documents_generated_at_idx
  on public.order_documents (generated_at desc);

drop trigger if exists set_order_documents_updated_at on public.order_documents;
create trigger set_order_documents_updated_at
  before update on public.order_documents
  for each row
  execute function public.set_updated_at();

-- Defense in depth: metadata must not change after insert (immutable snapshot).
create or replace function public.order_documents_forbid_metadata_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.metadata is distinct from old.metadata then
    raise exception 'metadata документа неизменяема после создания';
  end if;
  if new.number is distinct from old.number then
    raise exception 'number документа неизменяем после создания';
  end if;
  if new.document_type is distinct from old.document_type then
    raise exception 'document_type неизменяем после создания';
  end if;
  if new.order_id is distinct from old.order_id then
    raise exception 'order_id документа неизменяем после создания';
  end if;
  if new.generated_by is distinct from old.generated_by then
    raise exception 'generated_by неизменяем после создания';
  end if;
  return new;
end;
$$;

drop trigger if exists order_documents_forbid_metadata_mutation_trg on public.order_documents;
create trigger order_documents_forbid_metadata_mutation_trg
  before update on public.order_documents
  for each row
  execute function public.order_documents_forbid_metadata_mutation();

revoke all on function public.order_documents_forbid_metadata_mutation()
  from public, anon, authenticated;

comment on table public.order_documents is
  'Staff-generated order documents. metadata is an immutable snapshot for future PDF.';

alter table public.order_documents enable row level security;

revoke all on table public.order_documents from public;
revoke all on table public.order_documents from anon;
revoke all on table public.order_documents from authenticated;

-- ============================================================
-- 3. Internal helpers
-- ============================================================

-- Strict: only DK-###### → INV-/OUT-######
create or replace function public.staff_document_number_from_order(
  p_order_number text,
  p_document_type text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_suffix text;
  v_prefix text;
begin
  if p_order_number is null or p_order_number !~ '^DK-[0-9]{6}$' then
    raise exception
      'Некорректный номер заказа (ожидается DK-######): %', p_order_number;
  end if;

  if p_document_type = 'invoice' then
    v_prefix := 'INV';
  elsif p_document_type = 'delivery_note' then
    v_prefix := 'OUT';
  else
    raise exception 'Неизвестный тип документа: %', p_document_type;
  end if;

  v_suffix := substring(p_order_number from 4); -- after 'DK-'

  return v_prefix || '-' || v_suffix;
end;
$$;

revoke all on function public.staff_document_number_from_order(text, text)
  from public, anon, authenticated;

-- Required supplier fields for legal documents. Raises if incomplete.
create or replace function public.staff_require_organization_settings()
returns public.organization_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org public.organization_settings;
  v_missing text[] := array[]::text[];
begin
  select * into v_org
  from public.organization_settings as s
  where s.singleton_key = 'default';

  if not found then
    raise exception
      'organization_settings не настроена — заполните реквизиты DEKORO перед формированием документов';
  end if;

  if nullif(trim(v_org.legal_name), '') is null then
    v_missing := array_append(v_missing, 'legal_name');
  end if;
  if nullif(trim(v_org.bin), '') is null then
    v_missing := array_append(v_missing, 'bin (12 цифр)');
  end if;
  if nullif(trim(v_org.address), '') is null then
    v_missing := array_append(v_missing, 'address');
  end if;
  if nullif(trim(v_org.phone), '') is null then
    v_missing := array_append(v_missing, 'phone');
  end if;
  if nullif(trim(v_org.bank_name), '') is null then
    v_missing := array_append(v_missing, 'bank_name');
  end if;
  if nullif(trim(v_org.bank_bik), '') is null then
    v_missing := array_append(v_missing, 'bank_bik');
  end if;
  if nullif(trim(v_org.bank_iik), '') is null then
    v_missing := array_append(v_missing, 'bank_iik');
  end if;
  if nullif(trim(v_org.bank_kbe), '') is null then
    v_missing := array_append(v_missing, 'bank_kbe');
  end if;
  if nullif(trim(v_org.director_name), '') is null then
    v_missing := array_append(v_missing, 'director_name');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception
      'Нельзя сформировать документ: не заполнены реквизиты организации (%). Обновите public.organization_settings.',
      array_to_string(v_missing, ', ');
  end if;

  return v_org;
end;
$$;

revoke all on function public.staff_require_organization_settings()
  from public, anon, authenticated;

create or replace function public.staff_document_supplier_snapshot()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_org public.organization_settings;
begin
  v_org := public.staff_require_organization_settings();

  return jsonb_build_object(
    'legal_name', trim(v_org.legal_name),
    'bin', trim(v_org.bin),
    'address', trim(v_org.address),
    'city', nullif(trim(v_org.city), ''),
    'phone', trim(v_org.phone),
    'email', nullif(trim(v_org.email), ''),
    'bank_name', trim(v_org.bank_name),
    'bank_bik', trim(v_org.bank_bik),
    'bank_iik', trim(v_org.bank_iik),
    'bank_kbe', trim(v_org.bank_kbe),
    'director_name', trim(v_org.director_name),
    'warehouse_name', nullif(trim(v_org.warehouse_name), ''),
    'warehouse_code', nullif(trim(v_org.warehouse_code), '')
  );
end;
$$;

revoke all on function public.staff_document_supplier_snapshot()
  from public, anon, authenticated;

-- Immutable metadata snapshot for future PDF (Russian-only, no language field).
-- Order amounts are treated as NET (ex-VAT): platform has no VAT on orders.
-- Tax math (KZT, round half away / numeric scale 2):
--   amount_without_vat = orders.total
--   without_vat: vat_rate=0, vat_amount=0, total=orders.total, tax_label='Без НДС'
--   with_vat:    vat_rate = organization_settings.vat_rate (required, not hardcoded)
--                vat_amount = round(amount_without_vat * vat_rate / 100, 2)
--                total = amount_without_vat + vat_amount
drop function if exists public.staff_build_document_metadata(uuid, text, text);

create or replace function public.staff_build_document_metadata(
  p_order_id uuid,
  p_document_type text,
  p_document_number text,
  p_tax_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_customer public.customers;
  v_org public.organization_settings;
  v_items jsonb;
  v_items_count integer;
  v_total_quantity numeric;
  v_form_hint text;
  v_missing_unit_count integer;
  v_tax_mode text := nullif(trim(p_tax_mode), '');
  v_vat_rate numeric(5, 2);
  v_vat_amount numeric(14, 2);
  v_amount_without_vat numeric(14, 2);
  v_document_total numeric(14, 2);
  v_tax_label text;
  v_formula text;
begin
  select * into v_order
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  select * into v_customer
  from public.customers as c
  where c.id = v_order.customer_id;

  if not found then
    raise exception 'Клиент заказа не найден';
  end if;

  if v_tax_mode is null or v_tax_mode not in ('without_vat', 'with_vat') then
    raise exception 'tax_mode должен быть without_vat или with_vat';
  end if;

  if p_document_type = 'invoice' then
    v_form_hint := 'kz_invoice';
  else
    v_form_hint := 'kz_form_3_2';
  end if;

  select count(*) into v_missing_unit_count
  from public.order_items as oi
  left join public.products as p on p.id = oi.product_id
  where oi.order_id = p_order_id
    and (p.id is null or nullif(trim(p.unit), '') is null);

  if v_missing_unit_count > 0 then
    raise exception
      'У одной или нескольких позиций отсутствует единица измерения товара (products.unit)';
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'line_no', sub.line_no,
          'order_item_id', sub.id,
          'product_id', sub.product_id,
          'product_name', sub.product_name,
          'product_sku', sub.product_sku,
          'unit', sub.unit,
          'quantity', sub.quantity,
          'unit_price', sub.unit_price,
          'line_total', sub.line_total
        )
        order by sub.line_no
      ),
      '[]'::jsonb
    ),
    coalesce(count(*), 0),
    coalesce(sum(sub.quantity), 0)
  into v_items, v_items_count, v_total_quantity
  from (
    select
      oi.id,
      oi.product_id,
      oi.product_name,
      oi.product_sku,
      trim(p.unit) as unit,
      oi.quantity,
      oi.unit_price,
      oi.line_total,
      row_number() over (order by oi.created_at, oi.id) as line_no
    from public.order_items as oi
    inner join public.products as p on p.id = oi.product_id
    where oi.order_id = p_order_id
  ) as sub;

  if v_items_count = 0 then
    raise exception 'Нельзя сформировать документ для заказа без позиций';
  end if;

  -- Order total is the document base (NET / сумма заказа).
  v_amount_without_vat := v_order.total;

  if v_tax_mode = 'without_vat' then
    v_vat_rate := 0;
    v_vat_amount := 0;
    v_document_total := v_order.total;
    v_tax_label := 'Без НДС';
    v_formula :=
      'without_vat: vat_rate=0; vat_amount=0; total=orders.total';
  else
    select * into v_org
    from public.organization_settings as s
    where s.singleton_key = 'default';

    if not found or v_org.vat_rate is null then
      raise exception
        'Для режима «С НДС» необходимо задать organization_settings.vat_rate (например 12.00 для РК)';
    end if;

    v_vat_rate := v_org.vat_rate;
    v_vat_amount := round(v_amount_without_vat * v_vat_rate / 100, 2);
    v_document_total := v_amount_without_vat + v_vat_amount;
    v_tax_label := 'С НДС';
    v_formula :=
      'with_vat: amount_without_vat=orders.total; '
      || 'vat_amount=round(amount_without_vat*vat_rate/100,2); '
      || 'total=amount_without_vat+vat_amount; '
      || 'vat_rate from organization_settings.vat_rate';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'document_type', p_document_type,
    'document_number', p_document_number,
    'form_hint', v_form_hint,
    'generated_at', now(),
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'status', v_order.status,
      'created_at', v_order.created_at,
      'customer_id', v_order.customer_id,
      'company_id', v_order.company_id,
      'comment', v_order.comment,
      'delivery_type', v_order.delivery_type,
      'delivery_address', v_order.delivery_address,
      'delivery_comment', v_order.delivery_comment,
      'contact_name', v_order.contact_name,
      'contact_phone', v_order.contact_phone,
      'contact_email', v_order.contact_email
    ),
    'supplier', public.staff_document_supplier_snapshot(),
    'buyer', jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_type', v_customer.customer_type,
      'display_name', v_customer.display_name,
      'legal_name', v_customer.legal_name,
      'iin_bin', v_customer.iin_bin,
      'phone', coalesce(v_customer.phone, v_order.contact_phone),
      'email', coalesce(v_customer.email, v_order.contact_email),
      'contact_person', coalesce(v_customer.contact_person, v_order.contact_name),
      'address', coalesce(v_customer.address, v_order.delivery_address),
      'city', v_customer.city,
      'profile_id', v_customer.profile_id,
      'company_id', v_customer.company_id
    ),
    'items', v_items,
    'totals', jsonb_build_object(
      'subtotal', v_order.subtotal,
      'discount', v_order.discount,
      'order_total', v_order.total,
      'amount_without_vat', v_amount_without_vat,
      'vat_rate', v_vat_rate,
      'vat_amount', v_vat_amount,
      'total', v_document_total,
      'items_count', v_items_count,
      'total_quantity', v_total_quantity,
      'currency', 'KZT',
      'tax_mode', v_tax_mode,
      'tax_label', v_tax_label,
      'formula', v_formula
    ),
    'basis', jsonb_build_object(
      'label', 'Заказ ' || v_order.order_number,
      'order_number', v_order.order_number,
      'order_date', v_order.created_at
    ),
    'form_3_2', jsonb_build_object(
      'organization_stamp', null,
      'released_by_name', null,
      'released_by_position', null,
      'received_by_name', null,
      'received_by_position', null,
      'transport', null,
      'power_of_attorney', null,
      'notes', null
    )
  );
end;
$$;

revoke all on function public.staff_build_document_metadata(uuid, text, text, text)
  from public, anon, authenticated;

drop function if exists public.staff_generate_order_document(uuid, text);

create or replace function public.staff_generate_order_document(
  p_order_id uuid,
  p_document_type text,
  p_tax_mode text
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_order public.orders;
  v_number text;
  v_metadata jsonb;
  v_doc public.order_documents;
  v_existing_id uuid;
  v_items_count integer;
  v_lines_subtotal numeric(14, 2);
  v_tax_mode text := nullif(trim(p_tax_mode), '');
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для формирования документов';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_uid;

  if not found then
    raise exception 'Профиль сотрудника не найден';
  end if;

  if v_profile.role not in ('manager', 'admin') or not v_profile.is_active then
    raise exception 'Недостаточно прав для формирования документов';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_document_type is null or p_document_type not in ('invoice', 'delivery_note') then
    raise exception 'Некорректный тип документа';
  end if;

  if v_tax_mode is null or v_tax_mode not in ('without_vat', 'with_vat') then
    raise exception 'tax_mode должен быть without_vat или with_vat';
  end if;

  -- Block generation until real organization requisites exist.
  perform public.staff_require_organization_settings();

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Нельзя сформировать документ для отменённого заказа';
  end if;

  if p_document_type = 'delivery_note'
     and v_order.status not in (
       'paid',
       'picking',
       'ready_for_shipment',
       'shipped',
       'completed'
     )
  then
    raise exception
      'Накладную можно создать только после оплаты (статусы: paid, picking, ready_for_shipment, shipped, completed). Текущий статус: %',
      v_order.status;
  end if;

  select count(*), coalesce(sum(oi.line_total), 0)::numeric(14, 2)
  into v_items_count, v_lines_subtotal
  from public.order_items as oi
  where oi.order_id = p_order_id;

  if v_items_count = 0 then
    raise exception 'Нельзя сформировать документ для заказа без позиций';
  end if;

  if v_order.subtotal < 0 or v_order.discount < 0 or v_order.total < 0 then
    raise exception 'Некорректные суммы заказа';
  end if;

  if v_order.discount > v_order.subtotal then
    raise exception 'Скидка превышает подытог заказа';
  end if;

  if v_order.total is distinct from (v_order.subtotal - v_order.discount) then
    raise exception
      'Несогласованность сумм заказа: total (%) != subtotal (%) - discount (%)',
      v_order.total, v_order.subtotal, v_order.discount;
  end if;

  -- Soft consistency check vs line sum (allow 0.01 rounding drift).
  if abs(v_order.subtotal - v_lines_subtotal) > 0.01 then
    raise exception
      'Подытог заказа (%) не совпадает с суммой позиций (%)',
      v_order.subtotal, v_lines_subtotal;
  end if;

  select d.id into v_existing_id
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = p_document_type;

  if found then
    raise exception 'Документ этого типа для заказа уже существует';
  end if;

  v_number := public.staff_document_number_from_order(v_order.order_number, p_document_type);
  v_metadata := public.staff_build_document_metadata(
    p_order_id,
    p_document_type,
    v_number,
    v_tax_mode
  );

  begin
    insert into public.order_documents (
      order_id,
      document_type,
      number,
      status,
      file_path,
      generated_by,
      generated_at,
      metadata
    ) values (
      p_order_id,
      p_document_type,
      v_number,
      'generated',
      null,
      v_uid,
      now(),
      v_metadata
    )
    returning * into v_doc;
  exception
    when unique_violation then
      raise exception 'Документ этого типа для заказа уже существует (параллельный запрос)';
  end;

  return v_doc;
end;
$$;

revoke all on function public.staff_generate_order_document(uuid, text, text)
  from public, anon, authenticated;

-- ============================================================
-- 4. Public staff RPCs
-- ============================================================

drop function if exists public.staff_generate_invoice(uuid);
drop function if exists public.staff_generate_delivery_note(uuid);

create or replace function public.staff_generate_invoice(
  p_order_id uuid,
  p_tax_mode text
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.staff_generate_order_document(p_order_id, 'invoice', p_tax_mode);
end;
$$;

revoke all on function public.staff_generate_invoice(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_generate_invoice(uuid, text) to authenticated;

create or replace function public.staff_generate_delivery_note(
  p_order_id uuid,
  p_tax_mode text
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.staff_generate_order_document(p_order_id, 'delivery_note', p_tax_mode);
end;
$$;

revoke all on function public.staff_generate_delivery_note(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_generate_delivery_note(uuid, text) to authenticated;

create or replace function public.staff_list_order_documents(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  document_type text,
  number text,
  status text,
  file_path text,
  generated_by uuid,
  generated_by_name text,
  generated_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра документов';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  -- Summary only — no metadata (bank details) in list payload.
  return query
  select
    d.id,
    d.order_id,
    d.document_type,
    d.number,
    d.status,
    d.file_path,
    d.generated_by,
    p.full_name as generated_by_name,
    d.generated_at,
    d.created_at,
    d.updated_at
  from public.order_documents as d
  left join public.profiles as p on p.id = d.generated_by
  where d.order_id = p_order_id
  order by d.generated_at asc;
end;
$$;

revoke all on function public.staff_list_order_documents(uuid) from public, anon, authenticated;
grant execute on function public.staff_list_order_documents(uuid) to authenticated;

create or replace function public.staff_get_document(p_document_id uuid)
returns table (
  id uuid,
  order_id uuid,
  document_type text,
  number text,
  status text,
  file_path text,
  generated_by uuid,
  generated_by_name text,
  generated_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  metadata jsonb
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра документа';
  end if;

  if p_document_id is null then
    raise exception 'document_id обязателен';
  end if;

  return query
  select
    d.id,
    d.order_id,
    d.document_type,
    d.number,
    d.status,
    d.file_path,
    d.generated_by,
    p.full_name as generated_by_name,
    d.generated_at,
    d.created_at,
    d.updated_at,
    d.metadata
  from public.order_documents as d
  left join public.profiles as p on p.id = d.generated_by
  where d.id = p_document_id;
end;
$$;

revoke all on function public.staff_get_document(uuid) from public, anon, authenticated;
grant execute on function public.staff_get_document(uuid) to authenticated;

-- Admin-only write path for real organization requisites (no fictional defaults).
-- Tax: default_tax_mode + vat_rate (nullable; required at generate when with_vat).
-- Typical KZ rate is 12.00 — not hardcoded; admin must set vat_rate explicitly.
drop function if exists public.staff_upsert_organization_settings(
  text, text, text, text, text, text, text, text, text, text, text, text, text
);

create or replace function public.staff_upsert_organization_settings(
  p_legal_name text,
  p_bin text,
  p_address text,
  p_phone text,
  p_bank_name text,
  p_bank_bik text,
  p_bank_iik text,
  p_bank_kbe text,
  p_director_name text,
  p_city text default null,
  p_email text default null,
  p_warehouse_name text default null,
  p_warehouse_code text default null,
  p_default_tax_mode text default 'without_vat',
  p_vat_rate numeric default null
)
returns public.organization_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organization_settings;
  v_legal_name text := nullif(trim(p_legal_name), '');
  v_bin text := nullif(trim(p_bin), '');
  v_address text := nullif(trim(p_address), '');
  v_phone text := nullif(trim(p_phone), '');
  v_bank_name text := nullif(trim(p_bank_name), '');
  v_bank_bik text := nullif(trim(p_bank_bik), '');
  v_bank_iik text := nullif(trim(p_bank_iik), '');
  v_bank_kbe text := nullif(trim(p_bank_kbe), '');
  v_director_name text := nullif(trim(p_director_name), '');
  v_tax_mode text := coalesce(nullif(trim(p_default_tax_mode), ''), 'without_vat');
  v_vat_rate numeric(5, 2) := p_vat_rate;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения реквизитов организации';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if v_legal_name is null
     or v_bin is null
     or v_address is null
     or v_phone is null
     or v_bank_name is null
     or v_bank_bik is null
     or v_bank_iik is null
     or v_bank_kbe is null
     or v_director_name is null
  then
    raise exception
      'Обязательны: legal_name, bin, address, phone, bank_name, bank_bik, bank_iik, bank_kbe, director_name';
  end if;

  if v_bin !~ '^\d{12}$' then
    raise exception 'БИН должен состоять из 12 цифр';
  end if;

  if v_tax_mode not in ('without_vat', 'with_vat') then
    raise exception 'default_tax_mode должен быть without_vat или with_vat';
  end if;

  if v_vat_rate is not null and (v_vat_rate < 0 or v_vat_rate > 100) then
    raise exception 'vat_rate должен быть в диапазоне 0..100';
  end if;

  if v_tax_mode = 'with_vat' and v_vat_rate is null then
    raise exception 'При default_tax_mode=with_vat необходимо указать vat_rate';
  end if;

  insert into public.organization_settings as s (
    singleton_key,
    legal_name,
    bin,
    address,
    city,
    phone,
    email,
    bank_name,
    bank_bik,
    bank_iik,
    bank_kbe,
    director_name,
    warehouse_name,
    warehouse_code,
    default_tax_mode,
    vat_rate,
    updated_by
  ) values (
    'default',
    v_legal_name,
    v_bin,
    v_address,
    nullif(trim(p_city), ''),
    v_phone,
    nullif(trim(p_email), ''),
    v_bank_name,
    v_bank_bik,
    v_bank_iik,
    v_bank_kbe,
    v_director_name,
    nullif(trim(p_warehouse_name), ''),
    nullif(trim(p_warehouse_code), ''),
    v_tax_mode,
    v_vat_rate,
    v_uid
  )
  on conflict (singleton_key) do update set
    legal_name = excluded.legal_name,
    bin = excluded.bin,
    address = excluded.address,
    city = excluded.city,
    phone = excluded.phone,
    email = excluded.email,
    bank_name = excluded.bank_name,
    bank_bik = excluded.bank_bik,
    bank_iik = excluded.bank_iik,
    bank_kbe = excluded.bank_kbe,
    director_name = excluded.director_name,
    warehouse_name = excluded.warehouse_name,
    warehouse_code = excluded.warehouse_code,
    default_tax_mode = excluded.default_tax_mode,
    vat_rate = excluded.vat_rate,
    updated_by = excluded.updated_by
  returning * into v_org;

  return v_org;
end;
$$;

revoke all on function public.staff_upsert_organization_settings(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric
) from public, anon, authenticated;
grant execute on function public.staff_upsert_organization_settings(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric
) to authenticated;

create or replace function public.staff_get_organization_settings()
returns public.organization_settings
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_org public.organization_settings;
begin
  if not public.has_staff_role(array['manager', 'accountant', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для просмотра реквизитов организации';
  end if;

  select * into v_org
  from public.organization_settings as s
  where s.singleton_key = 'default';

  if not found then
    raise exception 'organization_settings не найдена';
  end if;

  return v_org;
end;
$$;

revoke all on function public.staff_get_organization_settings() from public, anon, authenticated;
grant execute on function public.staff_get_organization_settings() to authenticated;

-- ============================================================
-- 5. Notes
--
-- - Required before generate: fill organization_settings via
--   staff_upsert_organization_settings (admin) with REAL requisites.
-- - Order DK-###### → INV-/OUT-######; basis label = «Заказ DK-######».
-- - Delivery note only for paid|picking|ready_for_shipment|shipped|completed.
-- - Documents are Russian-only (no language field).
-- - tax_mode chosen at generate: without_vat | with_vat.
-- - VAT rate from organization_settings.vat_rate (not hardcoded; KZ typical 12%).
-- - Unit from products.unit only — no fictional fallback.
-- - metadata immutable (trigger); no authenticated table UPDATE.
-- - List RPC omits metadata; get RPC returns full snapshot for staff only.
-- ============================================================
