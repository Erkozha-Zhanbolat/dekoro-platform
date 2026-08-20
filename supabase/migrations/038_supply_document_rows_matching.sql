-- ============================================================
-- 038_supply_document_rows_matching.sql
-- Stage 39 follow-up — persistent parsed document rows + matching
--
-- Extends 037. Does NOT modify 001–037 files.
-- Does NOT drop products.sku UNIQUE.
-- Does NOT write inventory / stock_receipts.
-- Does NOT change landed-cost formula (still staff_recalculate_product_supply).
-- Access: active admin only (staff_assert_product_supply_admin).
-- ============================================================

do $$
begin
  if to_regclass('public.product_supply_documents') is null then
    raise exception 'public.product_supply_documents missing — run 037 first.';
  end if;
  if to_regprocedure('public.staff_assert_product_supply_admin()') is null then
    raise exception 'staff_assert_product_supply_admin missing — run 036 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Child table: mutable working copy of parsed rows
--    parser_metadata keeps parse envelope (profile, ignored, totals).
--    Original Excel in Storage is immutable.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_document_row_match_status') then
    create type public.product_supply_document_row_match_status as enum (
      'auto_match',
      'needs_selection',
      'unmatched',
      'manual_match',
      'skipped'
    );
  end if;
end
$$;

create table if not exists public.product_supply_document_rows (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.product_supply_documents (id) on delete cascade,
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  source_row_number integer not null,
  sort_order integer not null,
  source_own_code text,
  source_supplier_code text,
  source_name text,
  source_spec text,
  source_unit text,
  source_quantity numeric(14, 3),
  source_price numeric(18, 6),
  source_amount numeric(18, 6),
  source_notes text,
  source_issues jsonb not null default '[]'::jsonb,
  own_code text,
  supplier_code text,
  product_name text,
  specification text,
  unit text,
  quantity numeric(14, 3),
  price numeric(18, 6),
  amount numeric(18, 6),
  matched_product_id uuid references public.products (id) on delete set null,
  match_status public.product_supply_document_row_match_status not null default 'unmatched',
  match_method text,
  match_candidates jsonb not null default '[]'::jsonb,
  linked_supply_item_id uuid references public.product_supply_items (id) on delete set null,
  constraint product_supply_document_rows_doc_row_unique unique (document_id, source_row_number),
  constraint product_supply_document_rows_sort_non_negative check (sort_order >= 0),
  constraint product_supply_document_rows_source_row_positive check (source_row_number > 0),
  constraint product_supply_document_rows_issues_array check (jsonb_typeof(source_issues) = 'array'),
  constraint product_supply_document_rows_candidates_array check (jsonb_typeof(match_candidates) = 'array'),
  constraint product_supply_document_rows_qty_positive check (
    quantity is null or quantity > 0
  ),
  constraint product_supply_document_rows_price_non_negative check (
    price is null or price >= 0
  )
);

comment on table public.product_supply_document_rows is
  'Persistent parsed rows of a factory order/shipment Excel. Source_* is immutable parse; working columns may be edited by admin. Original file is never rewritten.';

create index if not exists product_supply_document_rows_document_idx
  on public.product_supply_document_rows (document_id, sort_order, id);

create index if not exists product_supply_document_rows_product_idx
  on public.product_supply_document_rows (matched_product_id)
  where matched_product_id is not null;

alter table public.product_supply_document_rows enable row level security;

revoke all on table public.product_supply_document_rows from public, anon, authenticated;

-- ============================================================
-- 2. Spec normalize + product candidate JSON
-- ============================================================

create or replace function public.staff_normalize_supply_spec(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        lower(replace(replace(trim(coalesce(p_value, '')), '×', '*'), 'х', '*')),
        '\s+', '', 'g'
      ),
      '[x*]+', '*', 'g'
    ),
    ''
  );
$$;

revoke all on function public.staff_normalize_supply_spec(text)
  from public, anon, authenticated;

create or replace function public.staff_trim_numeric_text(p_n numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_n is null then null
    else nullif(trim(trailing '.' from trim(trailing '0' from p_n::text)), '')
  end;
$$;

revoke all on function public.staff_trim_numeric_text(numeric)
  from public, anon, authenticated;

create or replace function public.staff_product_supply_spec_key(
  p_dimensions text,
  p_length_mm numeric,
  p_width_mm numeric,
  p_thickness_mm numeric
)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    public.staff_normalize_supply_spec(p_dimensions),
    public.staff_normalize_supply_spec(
      concat_ws(
        '*',
        public.staff_trim_numeric_text(p_length_mm),
        public.staff_trim_numeric_text(p_width_mm),
        public.staff_trim_numeric_text(p_thickness_mm)
      )
    )
  );
$$;

revoke all on function public.staff_product_supply_spec_key(text, numeric, numeric, numeric)
  from public, anon, authenticated;

create or replace function public.staff_supply_import_candidate_json(p_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'product_id', p.id,
    'sku', p.sku,
    'name', p.name,
    'original_sku', p.original_sku,
    'unit', p.unit,
    'status', p.status,
    'dimensions', p.dimensions,
    'category_id', p.category_id,
    'category_name', cat.name,
    'subcategory_id', p.subcategory_id,
    'subcategory_name', sub.name
  )
  from public.products as p
  left join public.categories as cat on cat.id = p.category_id
  left join public.categories as sub on sub.id = p.subcategory_id
  where p.id = p_product_id;
$$;

revoke all on function public.staff_supply_import_candidate_json(uuid)
  from public, anon, authenticated;

create or replace function public.staff_supply_import_candidates_json(p_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(public.staff_supply_import_candidate_json(x.id) order by x.ordinality),
    '[]'::jsonb
  )
  from unnest(coalesce(p_ids, '{}'::uuid[])) with ordinality as x(id, ordinality)
  where x.id is not null;
$$;

revoke all on function public.staff_supply_import_candidates_json(uuid[])
  from public, anon, authenticated;

-- ============================================================
-- 3. Matching: SKU is a business article, not unique identity.
--    products.sku remains UNIQUE in catalog; this still refuses
--    auto-pick when spec/name do not confirm or OWN CODE repeats.
-- ============================================================

drop function if exists public.staff_match_product_for_supply_import(text, text);

create or replace function public.staff_match_product_for_supply_import(
  p_own_code text,
  p_supplier_code text,
  p_name text default null,
  p_spec text default null,
  p_duplicate_own_code boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_own text := nullif(trim(p_own_code), '');
  v_supplier text := nullif(trim(p_supplier_code), '');
  v_name text := nullif(trim(p_name), '');
  v_spec text := public.staff_normalize_supply_spec(p_spec);
  v_sku_ids uuid[] := '{}';
  v_orig_ids uuid[] := '{}';
  v_confirmed uuid[] := '{}';
  v_id uuid;
  v_prod public.products;
  v_prod_spec text;
  v_name_ok boolean;
begin
  if v_own is not null then
    select coalesce(array_agg(p.id order by p.updated_at desc, p.id), '{}'::uuid[])
    into v_sku_ids
    from public.products as p
    where p.sku = v_own
      and p.status is distinct from 'archived';
  end if;

  if v_supplier is not null then
    select coalesce(array_agg(p.id order by p.updated_at desc, p.id), '{}'::uuid[])
    into v_orig_ids
    from public.products as p
    where p.original_sku = v_supplier
      and p.status is distinct from 'archived';
  end if;

  -- Level 1: OWN CODE / SKU + spec or exact name, exactly one
  if coalesce(array_length(v_sku_ids, 1), 0) > 0 then
    v_confirmed := '{}';
    foreach v_id in array v_sku_ids
    loop
      select * into v_prod from public.products as p where p.id = v_id;
      v_prod_spec := public.staff_product_supply_spec_key(
        v_prod.dimensions, v_prod.length_mm, v_prod.width_mm, v_prod.thickness_mm
      );
      v_name_ok := v_name is not null and lower(v_name) = lower(trim(v_prod.name));
      if (v_spec is not null and v_prod_spec is not null and v_spec = v_prod_spec)
         or v_name_ok then
        v_confirmed := v_confirmed || v_id;
      end if;
    end loop;

    if coalesce(array_length(v_confirmed, 1), 0) = 1 then
      return public.staff_match_product_for_supply_import_hit(
        v_confirmed[1], 'auto_match',
        case
          when v_spec is not null then 'sku_spec'
          else 'sku_name'
        end,
        v_sku_ids
      );
    end if;

    if coalesce(array_length(v_confirmed, 1), 0) > 1 then
      return public.staff_match_product_for_supply_import_miss(
        'needs_selection', v_confirmed
      );
    end if;

    -- SKU exists but spec/name did not confirm a single product.
    -- Auto-match only when catalog has exactly one SKU, the file does not
    -- repeat this OWN CODE, and the document row has no spec/name to contradict.
    if coalesce(array_length(v_sku_ids, 1), 0) = 1
       and not coalesce(p_duplicate_own_code, false)
       and v_spec is null
       and v_name is null then
      return public.staff_match_product_for_supply_import_hit(
        v_sku_ids[1], 'auto_match', 'sku', v_sku_ids
      );
    end if;

    return public.staff_match_product_for_supply_import_miss(
      'needs_selection', v_sku_ids
    );
  end if;

  -- Level 2: original_sku / supplier code + spec/name, exactly one
  if coalesce(array_length(v_orig_ids, 1), 0) > 0 then
    v_confirmed := '{}';
    foreach v_id in array v_orig_ids
    loop
      select * into v_prod from public.products as p where p.id = v_id;
      v_prod_spec := public.staff_product_supply_spec_key(
        v_prod.dimensions, v_prod.length_mm, v_prod.width_mm, v_prod.thickness_mm
      );
      v_name_ok := v_name is not null and lower(v_name) = lower(trim(v_prod.name));
      if (v_spec is not null and v_prod_spec is not null and v_spec = v_prod_spec)
         or v_name_ok then
        v_confirmed := v_confirmed || v_id;
      end if;
    end loop;

    if coalesce(array_length(v_confirmed, 1), 0) = 1 then
      return public.staff_match_product_for_supply_import_hit(
        v_confirmed[1], 'auto_match',
        case
          when v_spec is not null then 'original_sku_spec'
          else 'original_sku_name'
        end,
        v_orig_ids
      );
    end if;

    if coalesce(array_length(v_orig_ids, 1), 0) = 1
       and not coalesce(p_duplicate_own_code, false)
       and v_spec is null
       and v_name is null then
      return public.staff_match_product_for_supply_import_hit(
        v_orig_ids[1], 'auto_match', 'original_sku', v_orig_ids
      );
    end if;

    return public.staff_match_product_for_supply_import_miss(
      'needs_selection', v_orig_ids
    );
  end if;

  -- Level 4: nothing
  return public.staff_match_product_for_supply_import_miss('unmatched', '{}'::uuid[]);
end;
$$;

revoke all on function public.staff_match_product_for_supply_import(text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_match_product_for_supply_import(text, text, text, text, boolean)
  to authenticated;

create or replace function public.staff_match_product_for_supply_import_hit(
  p_product_id uuid,
  p_status text,
  p_method text,
  p_candidate_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_json jsonb;
begin
  v_json := public.staff_supply_import_candidate_json(p_product_id);
  if v_json is null then
    return public.staff_match_product_for_supply_import_miss('unmatched', '{}'::uuid[]);
  end if;
  return v_json || jsonb_build_object(
    'match_status', p_status,
    'match_method', p_method,
    'ambiguous', false,
    'candidates', public.staff_supply_import_candidates_json(p_candidate_ids)
  );
end;
$$;

revoke all on function public.staff_match_product_for_supply_import_hit(uuid, text, text, uuid[])
  from public, anon, authenticated;

create or replace function public.staff_match_product_for_supply_import_miss(
  p_status text,
  p_candidate_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'product_id', null,
    'match_status', p_status,
    'match_method', null,
    'ambiguous', p_status = 'needs_selection',
    'candidates', public.staff_supply_import_candidates_json(p_candidate_ids)
  );
$$;

revoke all on function public.staff_match_product_for_supply_import_miss(text, uuid[])
  from public, anon, authenticated;

-- ============================================================
-- 4. Document JSON: parsed_row_count for Open vs download
-- ============================================================

create or replace function public.staff_product_supply_document_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'supply_id', d.supply_id,
    'document_type', d.document_type,
    'title', d.title,
    'original_filename', d.original_filename,
    'storage_path', d.storage_path,
    'mime_type', d.mime_type,
    'file_size', d.file_size,
    'content_sha256', d.content_sha256,
    'uploaded_by', d.uploaded_by,
    'uploaded_by_name', pr.full_name,
    'uploaded_at', d.uploaded_at,
    'document_date', d.document_date,
    'notes', d.notes,
    'source_kind', d.source_kind,
    'linked_expense_id', d.linked_expense_id,
    'linked_expense_name', e.name,
    'parser_status', d.parser_status,
    'imported_at', d.imported_at,
    'imported_by', d.imported_by,
    'already_imported', d.parser_status = 'committed',
    'parsed_row_count', (
      select count(*)::integer
      from public.product_supply_document_rows as r
      where r.document_id = d.id
    )
  )
  from public.product_supply_documents as d
  left join public.profiles as pr on pr.id = d.uploaded_by
  left join public.product_supply_expenses as e on e.id = d.linked_expense_id
  where d.id = p_id;
$$;

revoke all on function public.staff_product_supply_document_json(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 5. Row JSON + document detail
-- ============================================================

create or replace function public.staff_product_supply_document_row_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'document_id', r.document_id,
    'supply_id', r.supply_id,
    'source_row_number', r.source_row_number,
    'sort_order', r.sort_order,
    'source_own_code', r.source_own_code,
    'source_supplier_code', r.source_supplier_code,
    'source_name', r.source_name,
    'source_spec', r.source_spec,
    'source_unit', r.source_unit,
    'source_quantity', r.source_quantity,
    'source_price', r.source_price,
    'source_amount', r.source_amount,
    'source_notes', r.source_notes,
    'source_issues', r.source_issues,
    'own_code', r.own_code,
    'supplier_code', r.supplier_code,
    'product_name', r.product_name,
    'specification', r.specification,
    'unit', r.unit,
    'quantity', r.quantity,
    'price', r.price,
    'amount', r.amount,
    'matched_product_id', r.matched_product_id,
    'matched_sku', p.sku,
    'matched_name', p.name,
    'matched_original_sku', p.original_sku,
    'matched_unit', p.unit,
    'matched_status', p.status,
    'matched_category_name', cat.name,
    'matched_subcategory_name', sub.name,
    'matched_dimensions', p.dimensions,
    'match_status', r.match_status,
    'match_method', r.match_method,
    'match_candidates', r.match_candidates,
    'linked_supply_item_id', r.linked_supply_item_id,
    'linked_item_quantity', i.quantity,
    'linked_item_sku', ip.sku,
    'linked_item_name', ip.name
  )
  from public.product_supply_document_rows as r
  left join public.products as p on p.id = r.matched_product_id
  left join public.categories as cat on cat.id = p.category_id
  left join public.categories as sub on sub.id = p.subcategory_id
  left join public.product_supply_items as i on i.id = r.linked_supply_item_id
  left join public.products as ip on ip.id = i.product_id
  where r.id = p_id;
$$;

revoke all on function public.staff_product_supply_document_row_json(uuid)
  from public, anon, authenticated;

create or replace function public.staff_get_product_supply_document_detail(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc public.product_supply_documents;
  v_supply public.product_supplies;
  v_rows jsonb;
begin
  perform public.staff_assert_product_supply_admin();
  if p_document_id is null then
    raise exception 'id документа обязателен';
  end if;

  select * into v_doc
  from public.product_supply_documents as d
  where d.id = p_document_id;

  if not found then
    raise exception 'Документ не найден';
  end if;

  select * into v_supply
  from public.product_supplies as s
  where s.id = v_doc.supply_id;

  select coalesce(
    jsonb_agg(public.staff_product_supply_document_row_json(r.id) order by r.sort_order, r.source_row_number, r.id),
    '[]'::jsonb
  )
  into v_rows
  from public.product_supply_document_rows as r
  where r.document_id = p_document_id;

  return jsonb_build_object(
    'document', public.staff_product_supply_document_json(p_document_id),
    'supply_id', v_doc.supply_id,
    'supply_status', v_supply.status,
    'supply_number', v_supply.supply_number,
    'supply_title', v_supply.title,
    'parser_status', v_doc.parser_status,
    'parser_metadata', v_doc.parser_metadata,
    'rows', v_rows,
    'match_summary', jsonb_build_object(
      'matched', (
        select count(*)::integer from public.product_supply_document_rows r
        where r.document_id = p_document_id
          and r.match_status in ('auto_match', 'manual_match')
      ),
      'needs_selection', (
        select count(*)::integer from public.product_supply_document_rows r
        where r.document_id = p_document_id and r.match_status = 'needs_selection'
      ),
      'unmatched', (
        select count(*)::integer from public.product_supply_document_rows r
        where r.document_id = p_document_id and r.match_status = 'unmatched'
      ),
      'skipped', (
        select count(*)::integer from public.product_supply_document_rows r
        where r.document_id = p_document_id and r.match_status = 'skipped'
      ),
      'invalid', (
        select count(*)::integer from public.product_supply_document_rows r
        where r.document_id = p_document_id
          and r.match_status is distinct from 'skipped'
          and (r.quantity is null or r.quantity <= 0)
      )
    )
  );
end;
$$;

revoke all on function public.staff_get_product_supply_document_detail(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_product_supply_document_detail(uuid)
  to authenticated;

-- Keep old preview RPC, now sourced from the child table.
create or replace function public.staff_get_product_supply_import_preview(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return public.staff_get_product_supply_document_detail(p_document_id);
end;
$$;

-- ============================================================
-- 6. Prepare: persist rows (not only JSON preview)
-- ============================================================

create or replace function public.staff_prepare_product_supply_import(
  p_document_id uuid,
  p_parse jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.product_supply_documents;
  v_rows jsonb := '[]'::jsonb;
  v_row jsonb;
  v_match jsonb;
  v_dupes text[] := '{}';
  v_own text;
  v_sort integer := 0;
  v_status public.product_supply_document_row_match_status;
  v_product_id uuid;
  v_unmatched integer := 0;
  v_matched integer := 0;
  v_needs integer := 0;
  v_invalid integer := 0;
  v_envelope jsonb;
begin
  perform public.staff_assert_product_supply_admin();

  if p_document_id is null then
    raise exception 'id документа обязателен';
  end if;

  select * into v_doc
  from public.product_supply_documents as d
  where d.id = p_document_id
  for update;

  if not found then
    raise exception 'Документ не найден';
  end if;

  if v_doc.parser_status = 'committed' then
    raise exception 'Документ уже импортирован — повторный разбор запрещён';
  end if;

  if v_doc.document_type not in ('factory_order', 'factory_shipment') then
    raise exception 'Импорт доступен только для заказа заводу и накладной завода';
  end if;

  if jsonb_typeof(p_parse) is distinct from 'object' then
    raise exception 'Результат разбора файла повреждён';
  end if;

  v_rows := coalesce(p_parse -> 'rows', '[]'::jsonb);
  if jsonb_typeof(v_rows) is distinct from 'array' then
    raise exception 'Строки импорта должны быть массивом';
  end if;

  select coalesce(array_agg(code), '{}'::text[])
  into v_dupes
  from (
    select nullif(trim(value ->> 'ownCode'), '') as code
    from jsonb_array_elements(v_rows)
    group by 1
    having count(*) > 1
  ) as d(code)
  where d.code is not null;

  delete from public.product_supply_document_rows
  where document_id = p_document_id;

  for v_row in
    select value from jsonb_array_elements(v_rows)
  loop
    v_sort := v_sort + 1;
    v_own := nullif(trim(v_row ->> 'ownCode'), '');
    v_match := public.staff_match_product_for_supply_import(
      v_row ->> 'ownCode',
      v_row ->> 'supplierCode',
      v_row ->> 'name',
      v_row ->> 'spec',
      v_own is not null and v_own = any (v_dupes)
    );

    v_status := coalesce(nullif(v_match ->> 'match_status', ''), 'unmatched')
      ::public.product_supply_document_row_match_status;
    v_product_id := nullif(v_match ->> 'product_id', '')::uuid;
    if v_status is distinct from 'auto_match' then
      v_product_id := null;
    end if;

    if nullif(v_row ->> 'quantity', '') is null then
      v_invalid := v_invalid + 1;
    elsif v_status = 'unmatched' then
      v_unmatched := v_unmatched + 1;
    elsif v_status = 'needs_selection' then
      v_needs := v_needs + 1;
    else
      v_matched := v_matched + 1;
    end if;

    insert into public.product_supply_document_rows (
      document_id,
      supply_id,
      source_row_number,
      sort_order,
      source_own_code,
      source_supplier_code,
      source_name,
      source_spec,
      source_unit,
      source_quantity,
      source_price,
      source_amount,
      source_notes,
      source_issues,
      own_code,
      supplier_code,
      product_name,
      specification,
      unit,
      quantity,
      price,
      amount,
      matched_product_id,
      match_status,
      match_method,
      match_candidates
    ) values (
      p_document_id,
      v_doc.supply_id,
      coalesce(nullif(v_row ->> 'rowNumber', '')::integer, v_sort),
      v_sort,
      v_own,
      nullif(trim(v_row ->> 'supplierCode'), ''),
      nullif(trim(v_row ->> 'name'), ''),
      nullif(trim(v_row ->> 'spec'), ''),
      nullif(trim(v_row ->> 'unit'), ''),
      nullif(v_row ->> 'quantity', '')::numeric,
      nullif(v_row ->> 'price', '')::numeric,
      nullif(v_row ->> 'amount', '')::numeric,
      nullif(trim(v_row ->> 'notes'), ''),
      coalesce(v_row -> 'issues', '[]'::jsonb),
      v_own,
      nullif(trim(v_row ->> 'supplierCode'), ''),
      nullif(trim(v_row ->> 'name'), ''),
      nullif(trim(v_row ->> 'spec'), ''),
      coalesce(nullif(trim(v_row ->> 'unit'), ''), 'шт.'),
      nullif(v_row ->> 'quantity', '')::numeric,
      nullif(v_row ->> 'price', '')::numeric,
      nullif(v_row ->> 'amount', '')::numeric,
      v_product_id,
      v_status,
      v_match ->> 'match_method',
      coalesce(v_match -> 'candidates', '[]'::jsonb)
    );
  end loop;

  v_envelope := (coalesce(p_parse, '{}'::jsonb) - 'rows')
    || jsonb_build_object(
      'match_summary', jsonb_build_object(
        'matched', v_matched,
        'unmatched', v_unmatched,
        'needs_selection', v_needs,
        'invalid', v_invalid
      ),
      'duplicate_own_codes', to_jsonb(v_dupes),
      'rows_stored_in', 'product_supply_document_rows'
    );

  update public.product_supply_documents as d
  set
    parser_status = 'preview',
    parser_metadata = v_envelope,
    source_kind = 'import'
  where d.id = p_document_id;

  perform public.staff_touch_product_supply(v_doc.supply_id);

  return public.staff_get_product_supply_document_detail(p_document_id)
    || jsonb_build_object(
      'supply_status', (
        select s.status from public.product_supplies as s where s.id = v_doc.supply_id
      )
    );
end;
$$;

-- ============================================================
-- 7. Patch a parsed row (manual match + working values)
-- ============================================================

create or replace function public.staff_patch_product_supply_document_row(
  p_row_id uuid,
  p_matched_product_id uuid default null,
  p_clear_match boolean default false,
  p_skip boolean default null,
  p_quantity numeric default null,
  p_price numeric default null,
  p_unit text default null,
  p_specification text default null,
  p_clear_specification boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supply_document_rows;
  v_doc public.product_supply_documents;
  v_supply public.product_supplies;
  v_product public.products;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_match jsonb;
  v_dup boolean := false;
begin
  perform public.staff_assert_product_supply_admin();
  if p_row_id is null then
    raise exception 'id строки обязателен';
  end if;

  select * into v_row
  from public.product_supply_document_rows as r
  where r.id = p_row_id
  for update;

  if not found then
    raise exception 'Строка документа не найдена';
  end if;

  select * into v_doc
  from public.product_supply_documents as d
  where d.id = v_row.document_id
  for update;

  if not found then
    raise exception 'Документ не найден';
  end if;

  v_supply := public.staff_lock_product_supply(v_row.supply_id);
  if v_supply.status = 'closed' then
    raise exception 'После закрытия себестоимости строки документа только для чтения';
  end if;

  if coalesce(p_skip, false) then
    update public.product_supply_document_rows
    set
      match_status = 'skipped',
      matched_product_id = null,
      match_method = 'skip'
    where id = p_row_id;
    perform public.staff_touch_product_supply(v_row.supply_id);
    return public.staff_get_product_supply_document_detail(v_row.document_id);
  end if;

  if p_matched_product_id is not null then
    p_clear_match := false;
  elsif p_skip is false and v_row.match_status = 'skipped' then
    p_clear_match := true;
  end if;

  if p_clear_match then
    select exists (
      select 1
      from public.product_supply_document_rows as o
      where o.document_id = v_row.document_id
        and o.id is distinct from v_row.id
        and o.own_code is not null
        and o.own_code = v_row.own_code
    ) into v_dup;
    v_match := public.staff_match_product_for_supply_import(
      v_row.own_code,
      v_row.supplier_code,
      v_row.product_name,
      v_row.specification,
      v_dup
    );
    update public.product_supply_document_rows
    set
      matched_product_id = case
        when (v_match ->> 'match_status') = 'auto_match'
          then nullif(v_match ->> 'product_id', '')::uuid
        else null
      end,
      match_status = coalesce(nullif(v_match ->> 'match_status', ''), 'unmatched')
        ::public.product_supply_document_row_match_status,
      match_method = v_match ->> 'match_method',
      match_candidates = coalesce(v_match -> 'candidates', '[]'::jsonb)
    where id = p_row_id;
  elsif p_matched_product_id is not null then
    select * into v_product
    from public.products as p
    where p.id = p_matched_product_id;
    if not found or v_product.status = 'archived' then
      raise exception 'Товар не найден';
    end if;
    update public.product_supply_document_rows
    set
      matched_product_id = p_matched_product_id,
      match_status = 'manual_match',
      match_method = 'manual'
    where id = p_row_id;
  end if;

  v_qty := coalesce(p_quantity, v_row.quantity);
  v_price := coalesce(p_price, v_row.price);
  if p_quantity is not null and p_quantity <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;
  if p_price is not null and p_price < 0 then
    raise exception 'Цена не может быть отрицательной';
  end if;
  if v_qty is not null and v_price is not null then
    v_amount := round(v_qty * v_price, 6);
  else
    v_amount := v_row.amount;
  end if;

  update public.product_supply_document_rows
  set
    quantity = case when p_quantity is not null then p_quantity else quantity end,
    price = case when p_price is not null then p_price else price end,
    amount = case
      when p_quantity is not null or p_price is not null then v_amount
      else amount
    end,
    unit = case
      when p_unit is not null then coalesce(nullif(trim(p_unit), ''), unit)
      else unit
    end,
    specification = case
      when p_clear_specification then null
      when p_specification is not null then nullif(trim(p_specification), '')
      else specification
    end
  where id = p_row_id;

  perform public.staff_touch_product_supply(v_row.supply_id);
  return public.staff_get_product_supply_document_detail(v_row.document_id);
end;
$$;

revoke all on function public.staff_patch_product_supply_document_row(
  uuid, uuid, boolean, boolean, numeric, numeric, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.staff_patch_product_supply_document_row(
  uuid, uuid, boolean, boolean, numeric, numeric, text, text, boolean
) to authenticated;

create or replace function public.staff_create_draft_for_supply_document_row(
  p_row_id uuid,
  p_sku text default null,
  p_name text default null,
  p_unit text default null,
  p_original_sku text default null,
  p_category_id uuid default null,
  p_subcategory_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supply_document_rows;
  v_supply public.product_supplies;
  v_created jsonb;
  v_product_id uuid;
begin
  perform public.staff_assert_product_supply_admin();
  if p_row_id is null then
    raise exception 'id строки обязателен';
  end if;

  select * into v_row
  from public.product_supply_document_rows as r
  where r.id = p_row_id
  for update;

  if not found then
    raise exception 'Строка документа не найдена';
  end if;

  v_supply := public.staff_lock_product_supply(v_row.supply_id);
  if v_supply.status = 'closed' then
    raise exception 'После закрытия себестоимости нельзя создавать товары из документа';
  end if;

  v_created := public.staff_create_draft_product_for_supply(
    coalesce(nullif(trim(p_sku), ''), v_row.own_code),
    coalesce(nullif(trim(p_name), ''), v_row.product_name),
    coalesce(nullif(trim(p_unit), ''), v_row.unit, 'шт.'),
    coalesce(nullif(trim(p_original_sku), ''), v_row.supplier_code),
    p_category_id,
    p_subcategory_id,
    null
  );
  v_product_id := nullif(v_created ->> 'id', '')::uuid;
  if v_product_id is null then
    raise exception 'Не удалось создать товар';
  end if;

  return public.staff_patch_product_supply_document_row(
    p_row_id,
    v_product_id,
    false,
    false,
    null,
    null,
    null,
    null,
    false
  );
end;
$$;

revoke all on function public.staff_create_draft_for_supply_document_row(
  uuid, text, text, text, text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.staff_create_draft_for_supply_document_row(
  uuid, text, text, text, text, uuid, uuid
) to authenticated;

-- ============================================================
-- 8. Search: show category / spec so admin can tell panel from louver
-- ============================================================

create or replace function public.staff_search_products_for_supply(
  p_query text default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_term text;
  v_rows jsonb;
begin
  perform public.staff_assert_product_supply_admin();

  v_limit := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  select coalesce(
    jsonb_agg(row_json order by updated_at desc, name),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      p.updated_at,
      p.name,
      jsonb_build_object(
        'id', p.id,
        'sku', p.sku,
        'name', p.name,
        'original_sku', p.original_sku,
        'unit', p.unit,
        'status', p.status,
        'weight_kg', p.weight_kg,
        'dimensions', p.dimensions,
        'category_id', p.category_id,
        'category_name', cat.name,
        'subcategory_id', p.subcategory_id,
        'subcategory_name', sub.name
      ) as row_json
    from public.products as p
    left join public.categories as cat on cat.id = p.category_id
    left join public.categories as sub on sub.id = p.subcategory_id
    where p.status is distinct from 'archived'
      and (
        v_term is null
        or p.sku ilike ('%' || v_term || '%') escape '\'
        or p.name ilike ('%' || v_term || '%') escape '\'
        or coalesce(p.original_sku, '') ilike ('%' || v_term || '%') escape '\'
      )
    order by p.updated_at desc, p.name
    limit v_limit
  ) as found;

  return v_rows;
end;
$$;

-- ============================================================
-- 9. Commit from persistent rows (idempotent without replace)
-- ============================================================

create or replace function public.staff_commit_product_supply_import(
  p_document_id uuid,
  p_resolutions jsonb default '[]'::jsonb,
  p_replace boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_doc public.product_supply_documents;
  v_supply public.product_supplies;
  v_row public.product_supply_document_rows;
  v_product public.products;
  v_item public.product_supply_items;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_unit text;
  v_sort integer;
  v_seen uuid[] := '{}';
  v_keep uuid[] := '{}';
  v_is_order boolean;
  v_pending integer;
begin
  v_uid := public.staff_assert_product_supply_admin();

  if p_document_id is null then
    raise exception 'id документа обязателен';
  end if;

  select * into v_doc
  from public.product_supply_documents as d
  where d.id = p_document_id
  for update;

  if not found then
    raise exception 'Документ не найден';
  end if;

  v_supply := public.staff_lock_product_supply(v_doc.supply_id);
  perform public.staff_assert_product_supply_draft(v_supply);

  if v_doc.document_type not in ('factory_order', 'factory_shipment') then
    raise exception 'Импорт доступен только для заказа заводу и накладной завода';
  end if;

  if v_doc.parser_status = 'committed' and not coalesce(p_replace, false) then
    raise exception 'Этот документ уже импортирован. Повтор — только явным обновлением.';
  end if;

  if v_doc.parser_status is distinct from 'preview'
     and not (v_doc.parser_status = 'committed' and coalesce(p_replace, false)) then
    raise exception 'Сначала разберите файл и подтвердите строки';
  end if;

  v_is_order := v_doc.document_type = 'factory_order';

  if jsonb_typeof(coalesce(p_resolutions, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'resolutions должны быть массивом';
  end if;

  select count(*)::integer into v_pending
  from public.product_supply_document_rows as r
  where r.document_id = p_document_id
    and r.match_status is distinct from 'skipped'
    and (
      r.matched_product_id is null
      or r.match_status in ('unmatched', 'needs_selection')
    );

  if v_pending > 0 then
    raise exception 'Сопоставьте все строки документа или пропустите их';
  end if;

  if not exists (
    select 1
    from public.product_supply_document_rows as r
    where r.document_id = p_document_id
      and r.match_status is distinct from 'skipped'
  ) then
    raise exception 'Нет строк для импорта';
  end if;

  for v_row in
    select *
    from public.product_supply_document_rows as r
    where r.document_id = p_document_id
      and r.match_status is distinct from 'skipped'
    order by r.sort_order, r.source_row_number, r.id
  loop
    v_qty := v_row.quantity;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Строка %: некорректное количество', v_row.source_row_number;
    end if;

    if v_row.matched_product_id is null then
      raise exception 'Строка %: товар не сопоставлен', v_row.source_row_number;
    end if;

    if v_row.matched_product_id = any (v_seen) then
      raise exception
        'Две строки документа сопоставлены с одним товаром (строка %). Выберите разные карточки или пропустите дубль.',
        v_row.source_row_number;
    end if;
    v_seen := v_seen || v_row.matched_product_id;
    v_keep := v_keep || v_row.matched_product_id;

    select * into v_product from public.products as p where p.id = v_row.matched_product_id;
    if not found then
      raise exception 'Товар не найден';
    end if;

    v_price := v_row.price;
    v_amount := v_row.amount;
    v_unit := coalesce(nullif(trim(v_row.unit), ''), v_product.unit, 'шт.');

    select * into v_item
    from public.product_supply_items as i
    where i.supply_id = v_doc.supply_id
      and i.product_id = v_row.matched_product_id
    for update;

    if not found then
      select coalesce(max(i.sort_order), 0) + 1
      into v_sort
      from public.product_supply_items as i
      where i.supply_id = v_doc.supply_id;

      insert into public.product_supply_items (
        supply_id,
        product_id,
        sort_order,
        quantity,
        unit,
        purchase_currency,
        purchase_price_per_unit,
        exchange_rate_to_kzt,
        unit_net_weight_kg,
        qty_source
      ) values (
        v_doc.supply_id,
        v_row.matched_product_id,
        v_sort,
        v_qty,
        coalesce(v_product.unit, v_unit, 'шт.'),
        v_supply.default_currency,
        v_price,
        v_supply.default_exchange_rate_to_kzt,
        v_product.weight_kg,
        case
          when v_is_order then 'ordered'::public.product_supply_qty_source
          else 'shipped'::public.product_supply_qty_source
        end
      )
      returning * into v_item;
    end if;

    if v_is_order then
      update public.product_supply_items as i
      set
        ordered_quantity = v_qty,
        ordered_unit = v_unit,
        ordered_purchase_currency = v_supply.default_currency,
        ordered_price_per_unit = v_price,
        ordered_amount = v_amount,
        ordered_spec = v_row.specification,
        ordered_name = v_row.product_name,
        ordered_source_document_id = v_doc.id,
        quantity = case
          when i.qty_source = 'shipped' then i.quantity
          else v_qty
        end,
        purchase_price_per_unit = case
          when i.qty_source = 'shipped' then i.purchase_price_per_unit
          else coalesce(v_price, i.purchase_price_per_unit)
        end,
        purchase_currency = case
          when i.qty_source = 'shipped' then i.purchase_currency
          else v_supply.default_currency
        end,
        qty_source = case
          when i.qty_source = 'shipped' then i.qty_source
          else 'ordered'::public.product_supply_qty_source
        end,
        import_row_metadata = coalesce(i.import_row_metadata, '{}'::jsonb)
          || jsonb_build_object(
            'ordered_row_id', v_row.id,
            'ordered_source_row_number', v_row.source_row_number
          )
      where i.id = v_item.id;
    else
      update public.product_supply_items as i
      set
        shipped_quantity = v_qty,
        shipped_unit = v_unit,
        shipped_purchase_currency = v_supply.default_currency,
        shipped_price_per_unit = v_price,
        shipped_amount = v_amount,
        shipped_spec = v_row.specification,
        shipped_name = v_row.product_name,
        shipped_source_document_id = v_doc.id,
        quantity = v_qty,
        purchase_price_per_unit = coalesce(v_price, i.purchase_price_per_unit),
        purchase_currency = v_supply.default_currency,
        qty_source = 'shipped',
        import_row_metadata = coalesce(i.import_row_metadata, '{}'::jsonb)
          || jsonb_build_object(
            'shipped_row_id', v_row.id,
            'shipped_source_row_number', v_row.source_row_number
          )
      where i.id = v_item.id;
    end if;

    update public.product_supply_document_rows
    set linked_supply_item_id = v_item.id
    where id = v_row.id;
  end loop;

  if coalesce(p_replace, false) then
    if v_is_order then
      update public.product_supply_items as i
      set
        ordered_quantity = null,
        ordered_unit = null,
        ordered_purchase_currency = null,
        ordered_price_per_unit = null,
        ordered_amount = null,
        ordered_spec = null,
        ordered_name = null,
        ordered_source_document_id = null
      where i.supply_id = v_doc.supply_id
        and i.ordered_source_document_id = v_doc.id
        and not (i.product_id = any (v_keep));
    else
      update public.product_supply_items as i
      set
        shipped_quantity = null,
        shipped_unit = null,
        shipped_purchase_currency = null,
        shipped_price_per_unit = null,
        shipped_amount = null,
        shipped_spec = null,
        shipped_name = null,
        shipped_source_document_id = null,
        qty_source = case
          when i.ordered_quantity is not null then 'ordered'::public.product_supply_qty_source
          else 'manual'::public.product_supply_qty_source
        end,
        quantity = case
          when i.ordered_quantity is not null then i.ordered_quantity
          else i.quantity
        end,
        purchase_price_per_unit = case
          when i.ordered_price_per_unit is not null then i.ordered_price_per_unit
          else i.purchase_price_per_unit
        end
      where i.supply_id = v_doc.supply_id
        and i.shipped_source_document_id = v_doc.id
        and not (i.product_id = any (v_keep));
    end if;

    update public.product_supply_document_rows
    set linked_supply_item_id = null
    where document_id = p_document_id
      and match_status = 'skipped';
  end if;

  update public.product_supply_documents
  set
    parser_status = 'committed',
    imported_at = now(),
    imported_by = v_uid,
    source_kind = 'import'
  where id = p_document_id;

  update public.product_supplies
  set
    source_kind = 'import',
    source_metadata = coalesce(source_metadata, '{}'::jsonb) || jsonb_build_object(
      'last_import_document_id', p_document_id,
      'last_import_kind', v_doc.document_type
    )
  where id = v_doc.supply_id;

  perform public.staff_recalculate_product_supply(v_doc.supply_id);
  return public.staff_product_supply_payload(v_doc.supply_id);
end;
$$;

-- ============================================================
-- 10. Backfill rows from 037 parser_metadata JSON (if any)
-- ============================================================

insert into public.product_supply_document_rows (
  document_id,
  supply_id,
  source_row_number,
  sort_order,
  source_own_code,
  source_supplier_code,
  source_name,
  source_spec,
  source_unit,
  source_quantity,
  source_price,
  source_amount,
  source_notes,
  source_issues,
  own_code,
  supplier_code,
  product_name,
  specification,
  unit,
  quantity,
  price,
  amount,
  matched_product_id,
  match_status,
  match_method,
  match_candidates
)
select
  d.id,
  d.supply_id,
  coalesce(nullif(r.value ->> 'rowNumber', '')::integer, r.ordinality::integer),
  r.ordinality::integer,
  nullif(trim(r.value ->> 'ownCode'), ''),
  nullif(trim(r.value ->> 'supplierCode'), ''),
  nullif(trim(r.value ->> 'name'), ''),
  nullif(trim(r.value ->> 'spec'), ''),
  nullif(trim(r.value ->> 'unit'), ''),
  nullif(r.value ->> 'quantity', '')::numeric,
  nullif(r.value ->> 'price', '')::numeric,
  nullif(r.value ->> 'amount', '')::numeric,
  nullif(trim(r.value ->> 'notes'), ''),
  coalesce(r.value -> 'issues', '[]'::jsonb),
  nullif(trim(r.value ->> 'ownCode'), ''),
  nullif(trim(r.value ->> 'supplierCode'), ''),
  nullif(trim(r.value ->> 'name'), ''),
  nullif(trim(r.value ->> 'spec'), ''),
  coalesce(nullif(trim(r.value ->> 'unit'), ''), 'шт.'),
  nullif(r.value ->> 'quantity', '')::numeric,
  nullif(r.value ->> 'price', '')::numeric,
  nullif(r.value ->> 'amount', '')::numeric,
  case
    when coalesce((r.value ->> 'ambiguous')::boolean, false) then null
    when coalesce(r.value ->> 'match_status', '') in ('sku', 'original_sku', 'auto_match')
      then nullif(r.value ->> 'matched_product_id', '')::uuid
    else null
  end,
  case
    when coalesce((r.value ->> 'ambiguous')::boolean, false) then 'needs_selection'::public.product_supply_document_row_match_status
    when coalesce(r.value ->> 'match_status', '') in ('sku', 'original_sku', 'auto_match') then 'auto_match'::public.product_supply_document_row_match_status
    when coalesce(r.value ->> 'match_status', '') = 'needs_selection' then 'needs_selection'::public.product_supply_document_row_match_status
    when coalesce(r.value ->> 'match_status', '') = 'manual_match' then 'manual_match'::public.product_supply_document_row_match_status
    when coalesce(r.value ->> 'match_status', '') = 'skipped' then 'skipped'::public.product_supply_document_row_match_status
    else 'unmatched'::public.product_supply_document_row_match_status
  end,
  case
    when coalesce(r.value ->> 'match_status', '') = 'sku' then 'sku'
    when coalesce(r.value ->> 'match_status', '') = 'original_sku' then 'original_sku'
    else r.value ->> 'match_method'
  end,
  coalesce(r.value -> 'match_candidates', '[]'::jsonb)
from public.product_supply_documents as d
cross join lateral jsonb_array_elements(coalesce(d.parser_metadata -> 'rows', '[]'::jsonb))
  with ordinality as r(value, ordinality)
where jsonb_typeof(d.parser_metadata -> 'rows') = 'array'
  and jsonb_array_length(d.parser_metadata -> 'rows') > 0
  and not exists (
    select 1
    from public.product_supply_document_rows as x
    where x.document_id = d.id
  )
on conflict (document_id, source_row_number) do nothing;
