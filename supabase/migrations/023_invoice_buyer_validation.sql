-- ============================================================
-- 023_invoice_buyer_validation.sql
-- Fix invoice buyer validation: separate individual vs company required fields.
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–022 files.
--
-- individual: display_name (ФИО), phone, email
-- company: legal_name, bin, legal_address, contact_person, phone, email
-- ============================================================

create or replace function public.staff_assert_invoice_ready(
  p_customer public.customers,
  p_order public.orders
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text := nullif(trim(coalesce(p_customer.customer_type, '')), '');
  v_missing text[] := array[]::text[];
  v_full_name text;
  v_legal_name text;
  v_bin text;
  v_legal_address text;
  v_contact_person text;
  v_phone text;
  v_email text;
begin
  if v_type is null or v_type not in ('individual', 'company') then
    raise exception
      'Неизвестный тип покупателя: %',
      coalesce(p_customer.customer_type, 'null');
  end if;

  v_phone := nullif(
    trim(coalesce(p_customer.phone, p_order.contact_phone, '')),
    ''
  );
  v_email := nullif(
    trim(coalesce(p_customer.email, p_order.contact_email, '')),
    ''
  );

  if v_type = 'individual' then
    -- ФИО = customers.display_name (profiles.full_name mapped at ensure time)
    v_full_name := nullif(trim(coalesce(p_customer.display_name, '')), '');

    if v_full_name is null then
      v_missing := array_append(v_missing, 'ФИО');
    end if;
    if v_phone is null then
      v_missing := array_append(v_missing, 'телефон');
    end if;
    if v_email is null then
      v_missing := array_append(v_missing, 'email');
    end if;

    -- Do NOT require: iin, bin, legal_name, legal_address, contact_person.

    if coalesce(array_length(v_missing, 1), 0) > 0 then
      raise exception
        'Для физического лица не заполнены обязательные поля: %',
        array_to_string(v_missing, ', ');
    end if;

    return;
  end if;

  -- company
  v_legal_name := nullif(
    trim(coalesce(p_customer.legal_name, p_customer.display_name, '')),
    ''
  );
  v_bin := nullif(trim(coalesce(p_customer.iin_bin, '')), '');
  v_legal_address := nullif(trim(coalesce(p_customer.address, '')), '');
  v_contact_person := nullif(
    trim(coalesce(p_customer.contact_person, p_order.contact_name, '')),
    ''
  );

  if v_legal_name is null then
    v_missing := array_append(v_missing, 'юридическое название');
  end if;
  if v_bin is null then
    v_missing := array_append(v_missing, 'БИН');
  end if;
  if v_legal_address is null then
    v_missing := array_append(v_missing, 'юридический адрес');
  end if;
  if v_contact_person is null then
    v_missing := array_append(v_missing, 'контактное лицо');
  end if;
  if v_phone is null then
    v_missing := array_append(v_missing, 'телефон');
  end if;
  if v_email is null then
    v_missing := array_append(v_missing, 'email');
  end if;

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception
      'Для юридического лица не заполнены обязательные поля: %',
      array_to_string(v_missing, ', ');
  end if;
end;
$$;

revoke all on function public.staff_assert_invoice_ready(
  public.customers,
  public.orders
) from public, anon, authenticated;

-- ============================================================
-- Rebuild metadata builder: call unified buyer assert + typed snapshot
-- ============================================================

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

    -- Single buyer readiness check (type-specific required fields).
    perform public.staff_assert_invoice_ready(v_customer, v_order);
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

  -- Buyer snapshot shaped by customer_type (omit fields that do not apply).
  if v_customer.customer_type = 'individual' then
    v_buyer := jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_type', v_customer.customer_type,
      'display_name', v_customer.display_name,
      'legal_name', null,
      'iin', null,
      'iin_bin', null,
      'bin', null,
      'phone', coalesce(v_customer.phone, v_order.contact_phone),
      'email', coalesce(v_customer.email, v_order.contact_email),
      'contact_person', null,
      'address', null,
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
      'address', nullif(trim(coalesce(v_customer.address, '')), ''),
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
