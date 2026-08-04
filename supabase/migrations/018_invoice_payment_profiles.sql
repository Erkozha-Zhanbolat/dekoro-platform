-- ============================================================
-- 018_invoice_payment_profiles.sql
-- Stage 18 — Dual invoice templates (individual / company)
--          + organization payment profiles (DEKORO bank accounts)
--
-- Depends on:
--   010_staff_role_access.sql (has_staff_role)
--   013_customers_foundation.sql (customers.customer_type)
--   014_documents.sql (order_documents, organization_settings)
--   016_organization_assets.sql (staff_build_document_metadata,
--     staff_generate_order_document, asset snapshots)
--
-- Apply by hand in the Supabase SQL Editor after 017. NOT auto-applied.
-- Does NOT modify migration files 001–017.
--
-- Design notes:
--   - Payment profiles are DEKORO beneficiary bank accounts by buyer type,
--     NOT customer bank data.
--   - Versioned profiles: many rows per customer_type; at most ONE active
--     (partial unique index WHERE is_active). Replace = deactivate + insert.
--   - New invoices resolve the active profile; old PDFs use immutable snapshot.
--   - Invoice template is chosen automatically from customers.customer_type.
--   - Manager never picks a template manually.
--   - Delivery note generation / PDF layout are unchanged.
--   - Amount-in-words is NOT computed in SQL — PDF/preview derive it in TS
--     from immutable metadata.totals.total.
--   - Legacy invoices without invoice_template: buyer.customer_type, else
--     legacy InvoicePdfDocument renderer (never live customers).
-- ============================================================

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.organization_settings') is null then
    raise exception
      'public.organization_settings missing — run 014/016 first.';
  end if;

  if to_regclass('public.order_documents') is null then
    raise exception
      'public.order_documents missing — run 014 first.';
  end if;

  if to_regclass('public.customers') is null then
    raise exception
      'public.customers missing — run 013 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception
      'public.has_staff_role(...) missing — run 010 first.';
  end if;

  if to_regprocedure(
    'public.staff_build_document_metadata(uuid, text, text, text, text, text, text)'
  ) is null then
    raise exception
      'public.staff_build_document_metadata(...) missing — run 016 first.';
  end if;

  if to_regprocedure(
    'public.staff_generate_order_document(uuid, text, text, uuid)'
  ) is null then
    raise exception
      'public.staff_generate_order_document(...) missing — run 016 first.';
  end if;
end
$$;

-- ============================================================
-- 1. organization_payment_profiles
-- ============================================================

create table if not exists public.organization_payment_profiles (
  id uuid primary key default gen_random_uuid(),
  customer_type text not null,
  beneficiary_name text not null,
  bin_iin text not null,
  bank_name text not null,
  bank_bik text not null,
  bank_iik text not null,
  bank_kbe text not null,
  payment_purpose_code text,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_payment_profiles_customer_type_check
    check (customer_type in ('individual', 'company')),
  constraint organization_payment_profiles_beneficiary_name_not_blank
    check (length(trim(beneficiary_name)) > 0),
  constraint organization_payment_profiles_bin_iin_not_blank
    check (length(trim(bin_iin)) > 0),
  constraint organization_payment_profiles_bank_name_not_blank
    check (length(trim(bank_name)) > 0),
  constraint organization_payment_profiles_bank_bik_not_blank
    check (length(trim(bank_bik)) > 0),
  constraint organization_payment_profiles_bank_iik_not_blank
    check (length(trim(bank_iik)) > 0),
  constraint organization_payment_profiles_bank_kbe_not_blank
    check (length(trim(bank_kbe)) > 0)
);

comment on table public.organization_payment_profiles is
  'Versioned DEKORO beneficiary bank accounts for invoices by buyer customer_type. At most one active row per type.';

-- Exactly one ACTIVE profile per customer_type; inactive history retained.
create unique index if not exists organization_payment_profiles_one_active_per_type_idx
  on public.organization_payment_profiles (customer_type)
  where (is_active = true);

create index if not exists organization_payment_profiles_type_created_idx
  on public.organization_payment_profiles (customer_type, created_at desc);

alter table public.organization_payment_profiles enable row level security;

revoke all on table public.organization_payment_profiles
  from public, anon, authenticated;

-- No direct table policies for authenticated — access only via SECURITY DEFINER RPCs.

-- ============================================================
-- 2. Resolve / list / upsert payment profiles
-- ============================================================

create or replace function public.staff_resolve_payment_profile(p_customer_type text)
returns public.organization_payment_profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text := nullif(trim(p_customer_type), '');
  v_row public.organization_payment_profiles;
begin
  if v_type is null or v_type not in ('individual', 'company') then
    raise exception 'Неизвестный тип покупателя: %', coalesce(p_customer_type, 'null');
  end if;

  select *
  into v_row
  from public.organization_payment_profiles as p
  where p.customer_type = v_type
    and p.is_active = true;

  if not found then
    if v_type = 'company' then
      raise exception
        'Не настроены банковские реквизиты для юридических лиц';
    else
      raise exception
        'Не настроены банковские реквизиты для физических лиц';
    end if;
  end if;

  return v_row;
end;
$$;

revoke all on function public.staff_resolve_payment_profile(text)
  from public, anon, authenticated;

create or replace function public.staff_list_organization_payment_profiles()
returns setof public.organization_payment_profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра платёжных реквизитов';
  end if;

  return query
  select p.*
  from public.organization_payment_profiles as p
  order by
    case p.customer_type
      when 'individual' then 1
      when 'company' then 2
      else 3
    end,
    p.is_active desc,
    p.created_at desc;
end;
$$;

revoke all on function public.staff_list_organization_payment_profiles()
  from public, anon, authenticated;
grant execute on function public.staff_list_organization_payment_profiles()
  to authenticated;

create or replace function public.staff_upsert_organization_payment_profile(
  p_customer_type text,
  p_beneficiary_name text,
  p_bin_iin text,
  p_bank_name text,
  p_bank_bik text,
  p_bank_iik text,
  p_bank_kbe text,
  p_payment_purpose_code text default null,
  p_is_active boolean default true
)
returns public.organization_payment_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_type text;
  v_beneficiary text;
  v_bin_iin text;
  v_bank_name text;
  v_bank_bik text;
  v_bank_iik text;
  v_bank_kbe text;
  v_knp text;
  v_active boolean := coalesce(p_is_active, true);
  v_row public.organization_payment_profiles;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Только администратор может изменять платёжные реквизиты';
  end if;

  v_type := nullif(trim(p_customer_type), '');
  if v_type is null or v_type not in ('individual', 'company') then
    raise exception 'customer_type должен быть individual или company';
  end if;

  v_beneficiary := nullif(trim(p_beneficiary_name), '');
  v_bin_iin := nullif(trim(p_bin_iin), '');
  v_bank_name := nullif(trim(p_bank_name), '');
  v_bank_bik := nullif(trim(p_bank_bik), '');
  v_bank_iik := nullif(trim(p_bank_iik), '');
  v_bank_kbe := nullif(trim(p_bank_kbe), '');
  v_knp := nullif(trim(p_payment_purpose_code), '');

  if v_beneficiary is null
     or v_bin_iin is null
     or v_bank_name is null
     or v_bank_bik is null
     or v_bank_iik is null
     or v_bank_kbe is null
  then
    raise exception
      'Обязательны: получатель, ИИН/БИН, банк, БИК, ИИК, КБе';
  end if;

  -- Transaction-scoped advisory lock: serialize replace even when no rows yet.
  perform pg_advisory_xact_lock(hashtext('dekoro:payment_profile:' || v_type));

  -- Lock current active row (if any) before deactivate + insert.
  perform 1
  from public.organization_payment_profiles as p
  where p.customer_type = v_type
    and p.is_active = true
  for update;

  update public.organization_payment_profiles as p
  set
    is_active = false,
    updated_by = v_uid,
    updated_at = now()
  where p.customer_type = v_type
    and p.is_active = true;

  begin
    insert into public.organization_payment_profiles (
      customer_type,
      beneficiary_name,
      bin_iin,
      bank_name,
      bank_bik,
      bank_iik,
      bank_kbe,
      payment_purpose_code,
      is_active,
      created_by,
      updated_by
    ) values (
      v_type,
      v_beneficiary,
      v_bin_iin,
      v_bank_name,
      v_bank_bik,
      v_bank_iik,
      v_bank_kbe,
      v_knp,
      v_active,
      v_uid,
      v_uid
    )
    returning * into v_row;
  exception
    when unique_violation then
      raise exception
        'Конфликт: для типа «%» уже есть активный платёжный профиль. Повторите сохранение.',
        v_type;
  end;

  return v_row;
end;
$$;

revoke all on function public.staff_upsert_organization_payment_profile(
  text, text, text, text, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.staff_upsert_organization_payment_profile(
  text, text, text, text, text, text, text, text, boolean
) to authenticated;

-- ============================================================
-- 3. Rebuild metadata builder (invoice templates + payment profile)
-- ============================================================

drop function if exists public.staff_build_document_metadata(uuid, text, text, text);
drop function if exists public.staff_build_document_metadata(uuid, text, text, text, text, text, text);

create or replace function public.staff_build_document_metadata(
  p_order_id uuid,
  p_document_type text,
  p_document_number text,
  p_tax_mode text,
  p_logo_path text default null,
  p_stamp_path text default null,
  p_signature_path text default null,
  p_contract_number text default null,
  p_contract_date date default null
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
  v_payment public.organization_payment_profiles;
  v_items jsonb;
  v_items_count integer;
  v_total_quantity numeric;
  v_form_hint text;
  v_invoice_template text;
  v_missing_unit_count integer;
  v_tax_mode text := nullif(trim(p_tax_mode), '');
  v_vat_rate numeric(5, 2);
  v_vat_amount numeric(14, 2);
  v_tax_subtotal numeric(14, 2);
  v_amount_without_vat numeric(14, 2);
  v_document_total numeric(14, 2);
  v_tax_label text;
  v_formula text;
  v_contract_number text := nullif(trim(p_contract_number), '');
  v_contract_date date := p_contract_date;
  v_contract_label text;
  v_buyer jsonb;
  v_payment_snap jsonb;
  v_warning text;
  v_meta jsonb;
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

  if p_document_type is null or p_document_type not in ('invoice', 'delivery_note') then
    raise exception 'Некорректный тип документа';
  end if;

  -- Contract: trim already applied; length + control chars.
  if v_contract_number is not null then
    if char_length(v_contract_number) > 120 then
      raise exception 'Номер договора слишком длинный (макс. 120 символов)';
    end if;
    if v_contract_number ~ '[[:cntrl:]]' then
      raise exception 'Номер договора содержит недопустимые символы';
    end if;
  end if;

  if v_contract_date is not null and v_contract_number is null then
    raise exception 'Укажите номер договора вместе с датой';
  end if;
  -- Number without date is allowed → label «Договор № X».

  if p_document_type = 'invoice' then
    if v_customer.customer_type is null
       or v_customer.customer_type not in ('individual', 'company')
    then
      raise exception
        'Неизвестный тип покупателя: %',
        coalesce(v_customer.customer_type, 'null');
    end if;

    v_invoice_template := v_customer.customer_type;
    v_form_hint := case v_invoice_template
      when 'individual' then 'kz_invoice_individual'
      when 'company' then 'kz_invoice_company'
    end;

    v_payment := public.staff_resolve_payment_profile(v_customer.customer_type);

    if v_invoice_template = 'company' then
      if nullif(trim(coalesce(v_customer.legal_name, v_customer.display_name, '')), '') is null then
        raise exception 'У юридического лица отсутствует юридическое название';
      end if;
      if nullif(trim(coalesce(v_customer.iin_bin, '')), '') is null then
        raise exception 'У юридического лица отсутствует БИН';
      end if;
      if nullif(trim(coalesce(v_customer.address, '')), '') is null then
        raise exception 'У юридического лица отсутствует юридический адрес';
      end if;
      -- contact_person / phone / email not required for company invoice.
    elsif v_invoice_template = 'individual' then
      if nullif(trim(coalesce(v_customer.display_name, '')), '') is null then
        raise exception 'У физического лица отсутствует ФИО (display_name)';
      end if;
      if v_customer.phone is null
         and v_customer.email is null
         and v_customer.profile_id is null
      then
        raise exception
          'У физического лица должен быть телефон, email или связанный профиль';
      end if;
      -- IIN optional for individuals.
    end if;
  else
    v_invoice_template := null;
    v_form_hint := 'kz_form_3_2';
    v_payment := null;
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

  v_org := public.staff_require_organization_settings();
  -- Catalog/order prices are BASE prices WITHOUT VAT.
  -- with_vat adds VAT on top of orders.total.
  v_tax_subtotal := v_order.total;

  if v_tax_mode = 'without_vat' then
    v_vat_rate := 0;
    v_vat_amount := 0;
    v_amount_without_vat := v_tax_subtotal;
    v_document_total := v_tax_subtotal;
    v_tax_label := 'Без НДС';
    v_formula :=
      'prices are BASE without VAT. '
      || 'without_vat: subtotal=orders.total; vat_amount=0; final_total=subtotal; '
      || 'prices_include_vat=false';
  else
    if v_org.vat_rate is null then
      raise exception
        'Для режима with_vat необходимо указать vat_rate в настройках организации';
    end if;
    v_vat_rate := v_org.vat_rate;
    v_vat_amount := round(v_tax_subtotal * v_vat_rate / 100, 2);
    v_amount_without_vat := v_tax_subtotal;
    v_document_total := v_tax_subtotal + v_vat_amount;
    v_tax_label := 'С учетом НДС';
    v_formula :=
      'prices are BASE without VAT. '
      || 'with_vat: subtotal=orders.total; '
      || 'vat_amount=round(subtotal*vat_rate/100,2); '
      || 'final_total=subtotal+vat_amount; '
      || 'prices_include_vat=false; '
      || 'vat_rate from organization_settings.vat_rate';
  end if;

  if v_contract_number is not null and v_contract_date is not null then
    v_contract_label :=
      'Договор № ' || v_contract_number
      || ' от ' || to_char(v_contract_date, 'DD.MM.YYYY');
  elsif v_contract_number is not null then
    v_contract_label := 'Договор № ' || v_contract_number;
  else
    v_contract_label := 'Без договора';
  end if;

  -- Buyer snapshot shaped by customer_type (keep legacy keys for PDF compat).
  if v_customer.customer_type = 'individual' then
    v_buyer := jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_type', v_customer.customer_type,
      'display_name', v_customer.display_name,
      'legal_name', v_customer.legal_name,
      'iin', nullif(trim(coalesce(v_customer.iin_bin, '')), ''),
      'iin_bin', v_customer.iin_bin,
      'bin', null,
      'phone', coalesce(v_customer.phone, v_order.contact_phone),
      'email', coalesce(v_customer.email, v_order.contact_email),
      'contact_person', coalesce(v_customer.contact_person, v_order.contact_name),
      'address', coalesce(v_customer.address, v_order.delivery_address),
      'city', v_customer.city,
      'profile_id', v_customer.profile_id,
      'company_id', v_customer.company_id
    );
  else
    v_buyer := jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_type', v_customer.customer_type,
      'display_name', v_customer.display_name,
      'legal_name', coalesce(
        nullif(trim(coalesce(v_customer.legal_name, '')), ''),
        v_customer.display_name
      ),
      'iin', null,
      'bin', nullif(trim(coalesce(v_customer.iin_bin, '')), ''),
      'iin_bin', v_customer.iin_bin,
      'phone', coalesce(v_customer.phone, v_order.contact_phone),
      'email', coalesce(v_customer.email, v_order.contact_email),
      'contact_person', coalesce(v_customer.contact_person, v_order.contact_name),
      'address', coalesce(v_customer.address, v_order.delivery_address),
      'city', v_customer.city,
      'profile_id', v_customer.profile_id,
      'company_id', v_customer.company_id
    );
  end if;

  if v_payment is not null then
    v_payment_snap := jsonb_build_object(
      'id', v_payment.id,
      'customer_type', v_payment.customer_type,
      'beneficiary_name', v_payment.beneficiary_name,
      'bin_iin', v_payment.bin_iin,
      'bank_name', v_payment.bank_name,
      'bank_bik', v_payment.bank_bik,
      'bank_iik', v_payment.bank_iik,
      'bank_kbe', v_payment.bank_kbe,
      'payment_purpose_code', v_payment.payment_purpose_code,
      'is_active', v_payment.is_active,
      'created_at', v_payment.created_at
    );
  else
    v_payment_snap := null;
  end if;

  if p_document_type = 'invoice' and v_invoice_template = 'company' then
    v_warning :=
      'Внимание! Оплата данного счёта означает согласие с условиями поставки товара. '
      || 'Уведомление об оплате обязательно, в противном случае не гарантируется наличие '
      || 'товара на складе. Товар отпускается по факту прихода денег на р/с Поставщика, '
      || 'самовывозом, при наличии доверенности и документов, удостоверяющих личность.';
  else
    v_warning := null;
  end if;

  v_meta := jsonb_build_object(
    'schema_version', 3,
    'document_type', p_document_type,
    'document_number', p_document_number,
    'form_hint', v_form_hint,
    'invoice_template', v_invoice_template,
    'generated_at', now(),
    'warning_text', v_warning,
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
    'supplier', public.staff_document_supplier_snapshot(
      p_logo_path,
      p_stamp_path,
      p_signature_path
    ),
    'payment_profile', v_payment_snap,
    'buyer', v_buyer,
    'items', v_items,
    'totals', jsonb_build_object(
      -- Tax base = orders.total (after discount). Catalog prices are without VAT.
      'subtotal', v_tax_subtotal,
      'items_subtotal', v_order.subtotal,
      'discount', v_order.discount,
      'order_total', v_order.total,
      'amount_without_vat', v_amount_without_vat,
      'vat_rate', v_vat_rate,
      'vat_amount', v_vat_amount,
      'final_total', v_document_total,
      -- Alias for PDF/preview compat (equals final_total).
      'total', v_document_total,
      'items_count', v_items_count,
      'item_count', v_items_count,
      'total_quantity', v_total_quantity,
      'currency', 'KZT',
      'tax_mode', v_tax_mode,
      'tax_label', v_tax_label,
      'formula', v_formula,
      'prices_include_vat', false,
      -- amount_in_words is derived in TypeScript from final_total at print/preview.
      'amount_in_words', null
    ),
    'basis', jsonb_build_object(
      'label', 'Заказ ' || v_order.order_number,
      'order_number', v_order.order_number,
      'order_date', v_order.created_at,
      'contract_number', v_contract_number,
      'contract_date', v_contract_date,
      'contract_label', v_contract_label
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

  return v_meta;
end;
$$;

revoke all on function public.staff_build_document_metadata(
  uuid, text, text, text, text, text, text, text, date
) from public, anon, authenticated;

-- ============================================================
-- 5. Generate order document — pass contract snapshot params
-- ============================================================

drop function if exists public.staff_generate_order_document(uuid, text, text, uuid);

create or replace function public.staff_generate_order_document(
  p_order_id uuid,
  p_document_type text,
  p_tax_mode text,
  p_snapshot_intent_id uuid,
  p_contract_number text default null,
  p_contract_date date default null
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
  v_intent public.document_asset_snapshot_intents;
  v_contract_number text := nullif(trim(p_contract_number), '');
  v_contract_date date := p_contract_date;
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

  if p_snapshot_intent_id is null then
    raise exception 'snapshot_intent_id обязателен';
  end if;

  -- Contract fields are invoice-only snapshot params (no live order columns).
  if p_document_type = 'delivery_note'
     and (v_contract_number is not null or v_contract_date is not null)
  then
    raise exception 'Параметры договора применимы только к счёту';
  end if;

  if v_contract_number is not null then
    if char_length(v_contract_number) > 120 then
      raise exception 'Номер договора слишком длинный (макс. 120 символов)';
    end if;
    if v_contract_number ~ '[[:cntrl:]]' then
      raise exception 'Номер договора содержит недопустимые символы';
    end if;
  end if;

  if v_contract_date is not null and v_contract_number is null then
    raise exception 'Укажите номер договора вместе с датой';
  end if;
  -- Number without date is allowed.

  select * into v_intent
  from public.document_asset_snapshot_intents as i
  where i.id = p_snapshot_intent_id
  for update;

  if not found then
    raise exception 'Снимок изображений не найден';
  end if;

  if v_intent.created_by is distinct from v_uid then
    raise exception 'Снимок изображений принадлежит другому пользователю';
  end if;

  if v_intent.order_id is distinct from p_order_id then
    raise exception 'Снимок изображений не принадлежит этому заказу';
  end if;

  if v_intent.document_type is distinct from p_document_type then
    raise exception 'Снимок изображений не соответствует типу документа';
  end if;

  if v_intent.status = 'pending' and v_intent.expires_at <= now() then
    update public.document_asset_snapshot_intents
    set status = 'expired'
    where id = v_intent.id;
    raise exception 'Срок действия снимка изображений истёк — начните генерацию заново';
  end if;

  if v_intent.status is distinct from 'pending' then
    raise exception 'Снимок изображений уже использован или недействителен (%)', v_intent.status;
  end if;

  if v_intent.logo_path is not null
     and not public.staff_storage_object_exists(v_intent.logo_path) then
    raise exception 'Файл logo snapshot не найден в Storage';
  end if;
  if v_intent.stamp_path is not null
     and not public.staff_storage_object_exists(v_intent.stamp_path) then
    raise exception 'Файл stamp snapshot не найден в Storage';
  end if;
  if v_intent.signature_path is not null
     and not public.staff_storage_object_exists(v_intent.signature_path) then
    raise exception 'Файл signature snapshot не найден в Storage';
  end if;

  if v_intent.logo_path is not null
     and not public.staff_is_org_snapshot_asset_path(v_intent.logo_path, 'logo') then
    raise exception 'logo snapshot path некорректен';
  end if;
  if v_intent.stamp_path is not null
     and not public.staff_is_org_snapshot_asset_path(v_intent.stamp_path, 'stamp') then
    raise exception 'stamp snapshot path некорректен';
  end if;
  if v_intent.signature_path is not null
     and not public.staff_is_org_snapshot_asset_path(v_intent.signature_path, 'signature') then
    raise exception 'signature snapshot path некорректен';
  end if;

  if v_intent.logo_path is not null
     and v_intent.logo_path not like ('organization/doc-snapshots/' || v_intent.id::text || '/%') then
    raise exception 'logo snapshot path не принадлежит intent';
  end if;
  if v_intent.stamp_path is not null
     and v_intent.stamp_path not like ('organization/doc-snapshots/' || v_intent.id::text || '/%') then
    raise exception 'stamp snapshot path не принадлежит intent';
  end if;
  if v_intent.signature_path is not null
     and v_intent.signature_path not like ('organization/doc-snapshots/' || v_intent.id::text || '/%') then
    raise exception 'signature snapshot path не принадлежит intent';
  end if;

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
    v_tax_mode,
    v_intent.logo_path,
    v_intent.stamp_path,
    v_intent.signature_path,
    v_contract_number,
    v_contract_date
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

  update public.document_asset_snapshot_intents as i
  set
    status = 'consumed',
    consumed_at = now(),
    consumed_document_id = v_doc.id
  where i.id = v_intent.id;

  return v_doc;
end;
$$;

revoke all on function public.staff_generate_order_document(
  uuid, text, text, uuid, text, date
) from public, anon, authenticated;

-- ============================================================
-- 6. Public invoice / delivery_note wrappers
-- ============================================================

drop function if exists public.staff_generate_invoice(uuid, text, uuid);
drop function if exists public.staff_generate_delivery_note(uuid, text, uuid);

create or replace function public.staff_generate_invoice(
  p_order_id uuid,
  p_tax_mode text,
  p_snapshot_intent_id uuid,
  p_contract_number text default null,
  p_contract_date date default null
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.staff_generate_order_document(
    p_order_id,
    'invoice',
    p_tax_mode,
    p_snapshot_intent_id,
    p_contract_number,
    p_contract_date
  );
end;
$$;

revoke all on function public.staff_generate_invoice(uuid, text, uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.staff_generate_invoice(uuid, text, uuid, text, date)
  to authenticated;

-- Delivery note signature unchanged (3 args) — contract params not exposed.
create or replace function public.staff_generate_delivery_note(
  p_order_id uuid,
  p_tax_mode text,
  p_snapshot_intent_id uuid
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.staff_generate_order_document(
    p_order_id,
    'delivery_note',
    p_tax_mode,
    p_snapshot_intent_id,
    null,
    null
  );
end;
$$;

revoke all on function public.staff_generate_delivery_note(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_generate_delivery_note(uuid, text, uuid)
  to authenticated;

-- ============================================================
-- Notes
-- - organization_settings.bank_* remain for supplier snapshot / delivery note.
-- - Invoice payment block uses organization_payment_profiles only.
-- - Frontend must not pass payment_profile_id — RPC resolves active by customer_type.
-- - Profile replace: deactivate previous active + insert new row (history kept).
-- - Partial unique: one active profile per customer_type.
-- - Amount-in-words: TypeScript from immutable totals.final_total (not SQL).
-- - VAT: catalog/order prices are BASE without VAT. with_vat ADDS VAT on top:
--   vat_amount=round(subtotal*vat_rate/100,2); final_total=subtotal+vat_amount.
-- - Legacy invoices: invoice_template → buyer.customer_type → legacy PDF renderer.
-- ============================================================
