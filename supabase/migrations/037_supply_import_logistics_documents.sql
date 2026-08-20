-- ============================================================
-- 037_supply_import_logistics_documents.sql
-- Stage 39 — Supply import, logistics timeline, document archive
--
-- Extends Stage 38 (036). Does NOT modify 001–036 files.
-- Does NOT write inventory / stock_receipts.
-- Access: active admin only (staff_assert_product_supply_admin).
-- ============================================================

do $$
begin
  if to_regclass('public.product_supplies') is null then
    raise exception 'public.product_supplies missing — run 036_product_supplies.sql first.';
  end if;
  if to_regprocedure('public.staff_assert_product_supply_admin()') is null then
    raise exception 'staff_assert_product_supply_admin missing — run 036 first.';
  end if;
  if to_regprocedure('public.staff_recalculate_product_supply(uuid)') is null then
    raise exception 'staff_recalculate_product_supply missing — run 036 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Enums
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_logistics_status') then
    create type public.product_supply_logistics_status as enum (
      'draft',
      'ordered',
      'in_production',
      'ready_at_factory',
      'to_khorgos',
      'khorgos_queue',
      'khorgos_customs',
      'to_almaty',
      'arrived_almaty',
      'completed'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_document_type') then
    create type public.product_supply_document_type as enum (
      'factory_order',
      'factory_shipment',
      'commercial_invoice',
      'packing_list',
      'china_export_declaration',
      'transit_declaration',
      'kazakhstan_customs_declaration',
      'cmr',
      'transport_document',
      'certificate',
      'broker_document',
      'expense_invoice',
      'payment_document',
      'other'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_parser_status') then
    create type public.product_supply_parser_status as enum (
      'uploaded',
      'preview',
      'committed',
      'error',
      'skipped'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_qty_source') then
    create type public.product_supply_qty_source as enum (
      'manual',
      'ordered',
      'shipped'
    );
  end if;
end
$$;

-- ============================================================
-- 2. Header columns
-- ============================================================

alter table public.product_supplies
  add column if not exists logistics_status public.product_supply_logistics_status
    not null default 'draft';

alter table public.product_supplies
  add column if not exists inventory_receipt_id uuid;

comment on column public.product_supplies.inventory_receipt_id is
  'Future warehouse receipt link. Stage 39 never writes inventory.';

comment on column public.product_supplies.logistics_status is
  'Physical route status. Independent of financial draft/closed.';

create index if not exists product_supplies_logistics_idx
  on public.product_supplies (logistics_status, supply_date desc);

-- ============================================================
-- 3. Documents + logistics history
-- ============================================================

create table if not exists public.product_supply_documents (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  document_type public.product_supply_document_type not null,
  title text not null,
  original_filename text not null,
  storage_path text not null,
  mime_type text,
  file_size bigint,
  content_sha256 text,
  uploaded_by uuid not null references public.profiles (id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  document_date date,
  notes text,
  source_kind text not null default 'upload',
  metadata jsonb not null default '{}'::jsonb,
  linked_expense_id uuid references public.product_supply_expenses (id) on delete set null,
  parser_status public.product_supply_parser_status,
  parser_metadata jsonb not null default '{}'::jsonb,
  imported_at timestamptz,
  imported_by uuid references public.profiles (id) on delete restrict,
  constraint product_supply_documents_title_not_blank check (length(trim(title)) > 0),
  constraint product_supply_documents_title_len check (char_length(title) <= 200),
  constraint product_supply_documents_filename_not_blank check (length(trim(original_filename)) > 0),
  constraint product_supply_documents_filename_len check (char_length(original_filename) <= 255),
  constraint product_supply_documents_path_not_blank check (length(trim(storage_path)) > 0),
  constraint product_supply_documents_path_unique unique (storage_path),
  constraint product_supply_documents_notes_len check (
    notes is null or char_length(notes) <= 4000
  ),
  constraint product_supply_documents_size_non_negative check (
    file_size is null or file_size >= 0
  ),
  constraint product_supply_documents_source_kind_check check (
    source_kind in ('upload', 'import')
  ),
  constraint product_supply_documents_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint product_supply_documents_parser_metadata_object check (
    jsonb_typeof(parser_metadata) = 'object'
  )
);

comment on table public.product_supply_documents is
  'Long-term private archive of supply documents. Original files are never replaced by JSON.';

create index if not exists product_supply_documents_supply_idx
  on public.product_supply_documents (supply_id, uploaded_at desc, id);

create index if not exists product_supply_documents_hash_idx
  on public.product_supply_documents (supply_id, content_sha256);

create index if not exists product_supply_documents_expense_idx
  on public.product_supply_documents (linked_expense_id)
  where linked_expense_id is not null;

create table if not exists public.product_supply_status_history (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  from_status public.product_supply_logistics_status,
  to_status public.product_supply_logistics_status not null,
  changed_by uuid not null references public.profiles (id) on delete restrict,
  changed_at timestamptz not null default now(),
  note text,
  location text,
  constraint product_supply_status_history_note_len check (
    note is null or char_length(note) <= 2000
  ),
  constraint product_supply_status_history_location_len check (
    location is null or char_length(location) <= 200
  )
);

create index if not exists product_supply_status_history_supply_idx
  on public.product_supply_status_history (supply_id, changed_at, id);

alter table public.product_supply_documents enable row level security;
alter table public.product_supply_status_history enable row level security;

revoke all on table public.product_supply_documents from public, anon, authenticated;
revoke all on table public.product_supply_status_history from public, anon, authenticated;

-- ============================================================
-- 4. Ordered vs shipped snapshots on items
-- ============================================================

alter table public.product_supply_items
  add column if not exists qty_source public.product_supply_qty_source not null default 'manual';

alter table public.product_supply_items
  add column if not exists ordered_quantity numeric(14, 3);

alter table public.product_supply_items
  add column if not exists ordered_unit text;

alter table public.product_supply_items
  add column if not exists ordered_purchase_currency public.product_supply_currency;

alter table public.product_supply_items
  add column if not exists ordered_price_per_unit numeric(18, 6);

alter table public.product_supply_items
  add column if not exists ordered_amount numeric(18, 6);

alter table public.product_supply_items
  add column if not exists ordered_spec text;

alter table public.product_supply_items
  add column if not exists ordered_name text;

alter table public.product_supply_items
  add column if not exists ordered_source_document_id uuid
    references public.product_supply_documents (id) on delete restrict;

alter table public.product_supply_items
  add column if not exists shipped_quantity numeric(14, 3);

alter table public.product_supply_items
  add column if not exists shipped_unit text;

alter table public.product_supply_items
  add column if not exists shipped_purchase_currency public.product_supply_currency;

alter table public.product_supply_items
  add column if not exists shipped_price_per_unit numeric(18, 6);

alter table public.product_supply_items
  add column if not exists shipped_amount numeric(18, 6);

alter table public.product_supply_items
  add column if not exists shipped_spec text;

alter table public.product_supply_items
  add column if not exists shipped_name text;

alter table public.product_supply_items
  add column if not exists shipped_source_document_id uuid
    references public.product_supply_documents (id) on delete restrict;

alter table public.product_supply_items
  add column if not exists import_row_metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_ordered_qty_positive'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_ordered_qty_positive
      check (ordered_quantity is null or ordered_quantity > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_shipped_qty_positive'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_shipped_qty_positive
      check (shipped_quantity is null or shipped_quantity > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_import_metadata_object'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_import_metadata_object
      check (jsonb_typeof(import_row_metadata) = 'object');
  end if;
end
$$;

-- ============================================================
-- 5. Private Storage bucket (same pattern as data-archives)
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supply-documents',
  'supply-documents',
  false,
  20971520,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists supply_documents_storage_select on storage.objects;
drop policy if exists supply_documents_storage_insert on storage.objects;
drop policy if exists supply_documents_storage_update on storage.objects;
drop policy if exists supply_documents_storage_delete on storage.objects;

-- ============================================================
-- 6. Helpers
-- ============================================================

create or replace function public.staff_touch_product_supply(p_supply_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.product_supplies
  set updated_at = now()
  where id = p_supply_id;
end;
$$;

revoke all on function public.staff_touch_product_supply(uuid)
  from public, anon, authenticated;

create or replace function public.product_supply_parse_document_type(p_type text)
returns public.product_supply_document_type
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type public.product_supply_document_type;
begin
  begin
    v_type := trim(p_type)::public.product_supply_document_type;
  exception
    when invalid_text_representation then
      raise exception 'Неизвестный тип документа';
  end;
  return v_type;
end;
$$;

revoke all on function public.product_supply_parse_document_type(text)
  from public, anon, authenticated;

create or replace function public.product_supply_parse_logistics_status(p_status text)
returns public.product_supply_logistics_status
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_status public.product_supply_logistics_status;
begin
  begin
    v_status := trim(p_status)::public.product_supply_logistics_status;
  exception
    when invalid_text_representation then
      raise exception 'Неизвестный логистический статус';
  end;
  return v_status;
end;
$$;

revoke all on function public.product_supply_parse_logistics_status(text)
  from public, anon, authenticated;

create or replace function public.staff_assert_supply_document_path(
  p_supply_id uuid,
  p_document_id uuid,
  p_path text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_path text := nullif(trim(p_path), '');
  v_prefix text;
begin
  if v_path is null then
    raise exception 'storage_path обязателен';
  end if;
  if v_path ~ '[\\]' or position('..' in v_path) > 0 then
    raise exception 'Некорректный storage path';
  end if;
  v_prefix := 'supplies/' || p_supply_id::text || '/' || p_document_id::text || '/';
  if left(v_path, char_length(v_prefix)) is distinct from v_prefix then
    raise exception 'storage_path должен быть supplies/{supply_id}/{document_id}/…';
  end if;
  return v_path;
end;
$$;

revoke all on function public.staff_assert_supply_document_path(uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.staff_match_product_for_supply_import(
  p_own_code text,
  p_supplier_code text
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
  v_product public.products;
  v_count integer;
begin
  if v_own is not null then
    select * into v_product
    from public.products as p
    where p.sku = v_own
      and p.status is distinct from 'archived';

    if found then
      return jsonb_build_object(
        'product_id', v_product.id,
        'sku', v_product.sku,
        'name', v_product.name,
        'original_sku', v_product.original_sku,
        'unit', v_product.unit,
        'status', v_product.status,
        'weight_kg', v_product.weight_kg,
        'match_status', 'sku',
        'ambiguous', false
      );
    end if;
  end if;

  if v_supplier is not null then
    select count(*)::integer into v_count
    from public.products as p
    where p.original_sku = v_supplier
      and p.status is distinct from 'archived';

    if v_count = 1 then
      select * into v_product
      from public.products as p
      where p.original_sku = v_supplier
        and p.status is distinct from 'archived';
      return jsonb_build_object(
        'product_id', v_product.id,
        'sku', v_product.sku,
        'name', v_product.name,
        'original_sku', v_product.original_sku,
        'unit', v_product.unit,
        'status', v_product.status,
        'weight_kg', v_product.weight_kg,
        'match_status', 'original_sku',
        'ambiguous', false
      );
    elsif v_count > 1 then
      select * into v_product
      from public.products as p
      where p.original_sku = v_supplier
        and p.status is distinct from 'archived'
      order by p.updated_at desc, p.id
      limit 1;
      return jsonb_build_object(
        'product_id', v_product.id,
        'sku', v_product.sku,
        'name', v_product.name,
        'original_sku', v_product.original_sku,
        'unit', v_product.unit,
        'status', v_product.status,
        'weight_kg', v_product.weight_kg,
        'match_status', 'original_sku',
        'ambiguous', true
      );
    end if;
  end if;

  return jsonb_build_object(
    'product_id', null,
    'match_status', 'unmatched',
    'ambiguous', false
  );
end;
$$;

revoke all on function public.staff_match_product_for_supply_import(text, text)
  from public, anon, authenticated;

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
    'already_imported', d.parser_status = 'committed'
  )
  from public.product_supply_documents as d
  left join public.profiles as pr on pr.id = d.uploaded_by
  left join public.product_supply_expenses as e on e.id = d.linked_expense_id
  where d.id = p_id;
$$;

revoke all on function public.staff_product_supply_document_json(uuid)
  from public, anon, authenticated;

create or replace function public.staff_product_supply_comparison(p_supply_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(row_json order by sort_order, id),
    '[]'::jsonb
  )
  from (
    select
      i.sort_order,
      i.id,
      jsonb_build_object(
        'item_id', i.id,
        'product_id', i.product_id,
        'sku', p.sku,
        'name', p.name,
        'unit', i.unit,
        'ordered_quantity', i.ordered_quantity,
        'shipped_quantity', i.shipped_quantity,
        'quantity_diff', case
          when i.ordered_quantity is null or i.shipped_quantity is null then null
          else i.shipped_quantity - i.ordered_quantity
        end,
        'ordered_price_per_unit', i.ordered_price_per_unit,
        'shipped_price_per_unit', i.shipped_price_per_unit,
        'price_diff', case
          when i.ordered_price_per_unit is null or i.shipped_price_per_unit is null then null
          else i.shipped_price_per_unit - i.ordered_price_per_unit
        end,
        'ordered_source_document_id', i.ordered_source_document_id,
        'shipped_source_document_id', i.shipped_source_document_id,
        'qty_source', i.qty_source,
        'status', case
          when i.ordered_quantity is null and i.shipped_quantity is not null then 'new_in_shipment'
          when i.ordered_quantity is not null and i.shipped_quantity is null then 'missing_in_shipment'
          when i.ordered_quantity is null and i.shipped_quantity is null then 'manual'
          when i.shipped_quantity < i.ordered_quantity then 'under_shipped'
          when i.shipped_quantity > i.ordered_quantity then 'over_shipped'
          else 'match'
        end,
        'flags', (
          select coalesce(jsonb_agg(flag), '[]'::jsonb)
          from (
            select 'new_in_shipment' as flag
            where i.ordered_quantity is null and i.shipped_quantity is not null
            union all
            select 'missing_in_shipment'
            where i.ordered_quantity is not null and i.shipped_quantity is null
            union all
            select 'under_shipped'
            where i.ordered_quantity is not null
              and i.shipped_quantity is not null
              and i.shipped_quantity < i.ordered_quantity
            union all
            select 'over_shipped'
            where i.ordered_quantity is not null
              and i.shipped_quantity is not null
              and i.shipped_quantity > i.ordered_quantity
            union all
            select 'price_changed'
            where i.ordered_price_per_unit is not null
              and i.shipped_price_per_unit is not null
              and i.ordered_price_per_unit is distinct from i.shipped_price_per_unit
            union all
            select 'match'
            where i.ordered_quantity is not null
              and i.shipped_quantity is not null
              and i.ordered_quantity = i.shipped_quantity
              and i.ordered_price_per_unit is not distinct from i.shipped_price_per_unit
          ) as flags
        )
      ) as row_json
    from public.product_supply_items as i
    join public.products as p on p.id = i.product_id
    where i.supply_id = p_supply_id
  ) as cmp;
$$;

revoke all on function public.staff_product_supply_comparison(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 7. Extended JSON payload (Stage 38 + documents/history/comparison)
-- ============================================================

create or replace function public.staff_product_supply_item_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id,
    'supply_id', i.supply_id,
    'product_id', i.product_id,
    'sku', p.sku,
    'name', p.name,
    'original_sku', p.original_sku,
    'product_status', p.status,
    'sort_order', i.sort_order,
    'quantity', i.quantity,
    'unit', i.unit,
    'purchase_currency', i.purchase_currency,
    'purchase_price_per_unit', i.purchase_price_per_unit,
    'exchange_rate_to_kzt', i.exchange_rate_to_kzt,
    'purchase_price_per_unit_kzt', i.purchase_price_per_unit_kzt,
    'unit_net_weight_kg', i.unit_net_weight_kg,
    'total_net_weight_kg', i.total_net_weight_kg,
    'item_weight_share', i.item_weight_share,
    'allocated_gross_weight_kg', i.allocated_gross_weight_kg,
    'gross_weight_per_unit_kg', i.gross_weight_per_unit_kg,
    'allocated_expenses_kzt', i.allocated_expenses_kzt,
    'expense_per_unit_kzt', i.expense_per_unit_kzt,
    'purchase_total_kzt', i.purchase_total_kzt,
    'landed_cost_per_unit_kzt', i.landed_cost_per_unit_kzt,
    'landed_cost_total_kzt', i.landed_cost_total_kzt,
    'qty_source', i.qty_source,
    'ordered_quantity', i.ordered_quantity,
    'ordered_unit', i.ordered_unit,
    'ordered_purchase_currency', i.ordered_purchase_currency,
    'ordered_price_per_unit', i.ordered_price_per_unit,
    'ordered_amount', i.ordered_amount,
    'ordered_spec', i.ordered_spec,
    'ordered_name', i.ordered_name,
    'ordered_source_document_id', i.ordered_source_document_id,
    'shipped_quantity', i.shipped_quantity,
    'shipped_unit', i.shipped_unit,
    'shipped_purchase_currency', i.shipped_purchase_currency,
    'shipped_price_per_unit', i.shipped_price_per_unit,
    'shipped_amount', i.shipped_amount,
    'shipped_spec', i.shipped_spec,
    'shipped_name', i.shipped_name,
    'shipped_source_document_id', i.shipped_source_document_id
  )
  from public.product_supply_items as i
  join public.products as p on p.id = i.product_id
  where i.id = p_id;
$$;

revoke all on function public.staff_product_supply_item_json(uuid)
  from public, anon, authenticated;

create or replace function public.staff_product_supply_payload(p_supply_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_supply public.product_supplies;
  v_items jsonb;
  v_expenses jsonb;
  v_documents jsonb;
  v_history jsonb;
  v_gross_lt_net boolean;
begin
  select * into v_supply
  from public.product_supplies as s
  where s.id = p_supply_id;

  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(public.staff_product_supply_item_json(i.id) order by i.sort_order, i.id), '[]'::jsonb)
  into v_items
  from public.product_supply_items as i
  where i.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'supply_id', e.supply_id,
        'category_key', e.category_key,
        'name', e.name,
        'amount', e.amount,
        'currency', e.currency,
        'exchange_rate_to_kzt', e.exchange_rate_to_kzt,
        'amount_kzt', e.amount_kzt,
        'expense_date', e.expense_date,
        'notes', e.notes,
        'sort_order', e.sort_order,
        'linked_documents', (
          select coalesce(
            jsonb_agg(jsonb_build_object(
              'id', d.id,
              'title', d.title,
              'document_type', d.document_type,
              'original_filename', d.original_filename
            ) order by d.uploaded_at, d.id),
            '[]'::jsonb
          )
          from public.product_supply_documents as d
          where d.linked_expense_id = e.id
        )
      )
      order by e.sort_order, e.created_at, e.id
    ),
    '[]'::jsonb
  )
  into v_expenses
  from public.product_supply_expenses as e
  where e.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(public.staff_product_supply_document_json(d.id) order by d.uploaded_at desc, d.id),
    '[]'::jsonb
  )
  into v_documents
  from public.product_supply_documents as d
  where d.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', h.id,
        'supply_id', h.supply_id,
        'from_status', h.from_status,
        'to_status', h.to_status,
        'changed_by', h.changed_by,
        'changed_by_name', pr.full_name,
        'changed_at', h.changed_at,
        'note', h.note,
        'location', h.location
      )
      order by h.changed_at, h.id
    ),
    '[]'::jsonb
  )
  into v_history
  from public.product_supply_status_history as h
  left join public.profiles as pr on pr.id = h.changed_by
  where h.supply_id = p_supply_id;

  v_gross_lt_net :=
    v_supply.gross_weight_kg is not null
    and v_supply.total_net_weight_kg is not null
    and v_supply.gross_weight_kg < v_supply.total_net_weight_kg;

  return jsonb_build_object(
    'supply', jsonb_build_object(
      'id', v_supply.id,
      'sequence_number', v_supply.sequence_number,
      'supply_number', v_supply.supply_number,
      'title', v_supply.title,
      'supplier_name', v_supply.supplier_name,
      'supply_date', v_supply.supply_date,
      'default_currency', v_supply.default_currency,
      'default_exchange_rate_to_kzt', v_supply.default_exchange_rate_to_kzt,
      'gross_weight_kg', v_supply.gross_weight_kg,
      'notes', v_supply.notes,
      'status', v_supply.status,
      'logistics_status', v_supply.logistics_status,
      'source_kind', v_supply.source_kind,
      'created_by', v_supply.created_by,
      'created_at', v_supply.created_at,
      'updated_at', v_supply.updated_at,
      'closed_at', v_supply.closed_at,
      'closed_by', v_supply.closed_by,
      'is_preliminary', v_supply.status = 'draft',
      'inventory_receipt_id', v_supply.inventory_receipt_id
    ),
    'items', v_items,
    'expenses', v_expenses,
    'documents', coalesce(v_documents, '[]'::jsonb),
    'logistics_history', coalesce(v_history, '[]'::jsonb),
    'comparison', public.staff_product_supply_comparison(p_supply_id),
    'totals', jsonb_build_object(
      'total_net_weight_kg', v_supply.total_net_weight_kg,
      'gross_weight_kg', v_supply.gross_weight_kg,
      'packaging_weight_kg', v_supply.packaging_weight_kg,
      'packaging_weight_pct', v_supply.packaging_weight_pct,
      'total_purchase_kzt', v_supply.total_purchase_kzt,
      'total_expenses_kzt', v_supply.total_expenses_kzt,
      'expense_per_kg', v_supply.expense_per_kg,
      'total_landed_cost_kzt', v_supply.total_landed_cost_kzt,
      'gross_lt_net', v_gross_lt_net
    )
  );
end;
$$;

revoke all on function public.staff_product_supply_payload(uuid)
  from public, anon, authenticated;

drop function if exists public.staff_list_product_supplies(text, integer);
drop function if exists public.staff_list_product_supplies(text, integer, text, date, date, text);

create or replace function public.staff_list_product_supplies(
  p_status text default null,
  p_limit integer default 50,
  p_logistics_status text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_status public.product_supply_status;
  v_logistics public.product_supply_logistics_status;
  v_term text;
  v_rows jsonb;
begin
  perform public.staff_assert_product_supply_admin();

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  if nullif(trim(p_status), '') is not null then
    begin
      v_status := trim(p_status)::public.product_supply_status;
    exception
      when invalid_text_representation then
        raise exception 'Статус поставки: draft или closed';
    end;
  end if;

  if nullif(trim(p_logistics_status), '') is not null then
    v_logistics := public.product_supply_parse_logistics_status(p_logistics_status);
  end if;

  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  select coalesce(
    jsonb_agg(row_json order by sort_updated desc, sequence_number desc),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      s.updated_at as sort_updated,
      s.sequence_number,
      jsonb_build_object(
        'id', s.id,
        'sequence_number', s.sequence_number,
        'supply_number', s.supply_number,
        'title', s.title,
        'supplier_name', s.supplier_name,
        'supply_date', s.supply_date,
        'status', s.status,
        'logistics_status', s.logistics_status,
        'gross_weight_kg', s.gross_weight_kg,
        'total_expenses_kzt', s.total_expenses_kzt,
        'expense_per_kg', s.expense_per_kg,
        'total_landed_cost_kzt', s.total_landed_cost_kzt,
        'items_count', (
          select count(*)::integer
          from public.product_supply_items as i
          where i.supply_id = s.id
        ),
        'created_at', s.created_at,
        'updated_at', s.updated_at,
        'closed_at', s.closed_at
      ) as row_json
    from public.product_supplies as s
    where (v_status is null or s.status = v_status)
      and (v_logistics is null or s.logistics_status = v_logistics)
      and (p_date_from is null or s.supply_date >= p_date_from)
      and (p_date_to is null or s.supply_date <= p_date_to)
      and (
        v_term is null
        or s.supply_number ilike ('%' || v_term || '%') escape '\'
        or s.title ilike ('%' || v_term || '%') escape '\'
        or coalesce(s.supplier_name, '') ilike ('%' || v_term || '%') escape '\'
      )
    order by s.updated_at desc, s.sequence_number desc
    limit v_limit
  ) as listed;

  return v_rows;
end;
$$;

revoke all on function public.staff_list_product_supplies(text, integer, text, date, date, text)
  from public, anon, authenticated;
grant execute on function public.staff_list_product_supplies(text, integer, text, date, date, text)
  to authenticated;

-- Seed logistics history for existing supplies and new creates
insert into public.product_supply_status_history (
  supply_id, from_status, to_status, changed_by, changed_at, note
)
select
  s.id,
  null,
  s.logistics_status,
  s.created_by,
  s.created_at,
  'Начальный статус'
from public.product_supplies as s
where not exists (
  select 1
  from public.product_supply_status_history as h
  where h.supply_id = s.id
);

create or replace function public.staff_create_product_supply(
  p_title text,
  p_supplier_name text default null,
  p_supply_date date default null,
  p_default_currency text default 'CNY',
  p_default_exchange_rate_to_kzt numeric default null,
  p_gross_weight_kg numeric default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_title text := nullif(trim(p_title), '');
  v_supplier text := nullif(trim(p_supplier_name), '');
  v_notes text := nullif(trim(p_notes), '');
  v_currency public.product_supply_currency;
  v_n bigint;
  v_id uuid := gen_random_uuid();
  v_rate numeric;
begin
  v_uid := public.staff_assert_product_supply_admin();

  if v_title is null then
    raise exception 'Название поставки обязательно';
  end if;

  v_currency := public.product_supply_parse_currency(
    coalesce(p_default_currency, 'CNY')
  );
  v_rate := public.product_supply_resolved_rate(
    v_currency, p_default_exchange_rate_to_kzt
  );

  if v_currency <> 'KZT' and v_rate is not null and v_rate <= 0 then
    raise exception 'Курс валюты должен быть больше 0';
  end if;

  if p_gross_weight_kg is not null and p_gross_weight_kg < 0 then
    raise exception 'Брутто-вес не может быть отрицательным';
  end if;

  v_n := nextval('public.product_supplies_number_seq');

  insert into public.product_supplies (
    id,
    sequence_number,
    supply_number,
    title,
    supplier_name,
    supply_date,
    default_currency,
    default_exchange_rate_to_kzt,
    gross_weight_kg,
    notes,
    created_by,
    logistics_status
  ) values (
    v_id,
    v_n,
    public.generate_product_supply_number(v_n),
    v_title,
    v_supplier,
    coalesce(p_supply_date, current_date),
    v_currency,
    v_rate,
    p_gross_weight_kg,
    v_notes,
    v_uid,
    'draft'
  );

  insert into public.product_supply_status_history (
    supply_id, from_status, to_status, changed_by, note
  ) values (
    v_id, null, 'draft', v_uid, 'Поставка создана'
  );

  perform public.staff_recalculate_product_supply(v_id);
  return public.staff_product_supply_payload(v_id);
end;
$$;

revoke all on function public.staff_create_product_supply(
  text, text, date, text, numeric, numeric, text
) from public, anon, authenticated;
grant execute on function public.staff_create_product_supply(
  text, text, date, text, numeric, numeric, text
) to authenticated;

-- ============================================================
-- 8. Logistics status
-- ============================================================

create or replace function public.staff_set_product_supply_logistics_status(
  p_supply_id uuid,
  p_to_status text,
  p_note text default null,
  p_location text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_to public.product_supply_logistics_status;
  v_note text := nullif(trim(p_note), '');
  v_location text := nullif(trim(p_location), '');
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  v_to := public.product_supply_parse_logistics_status(p_to_status);

  if v_to = v_row.logistics_status then
    return public.staff_product_supply_payload(p_supply_id);
  end if;

  update public.product_supplies
  set logistics_status = v_to
  where id = p_supply_id;

  insert into public.product_supply_status_history (
    supply_id, from_status, to_status, changed_by, note, location
  ) values (
    p_supply_id, v_row.logistics_status, v_to, v_uid, v_note, v_location
  );

  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_set_product_supply_logistics_status(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.staff_set_product_supply_logistics_status(uuid, text, text, text)
  to authenticated;

-- ============================================================
-- 9. Documents archive
-- ============================================================

create or replace function public.staff_register_product_supply_document(
  p_supply_id uuid,
  p_document_id uuid,
  p_document_type text,
  p_title text,
  p_original_filename text,
  p_storage_path text,
  p_mime_type text default null,
  p_file_size bigint default null,
  p_document_date date default null,
  p_notes text default null,
  p_linked_expense_id uuid default null,
  p_content_sha256 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_type public.product_supply_document_type;
  v_title text := nullif(trim(p_title), '');
  v_filename text := nullif(trim(p_original_filename), '');
  v_notes text := nullif(trim(p_notes), '');
  v_path text;
  v_hash text := nullif(trim(p_content_sha256), '');
  v_duplicate boolean := false;
  v_already boolean := false;
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);

  if p_document_id is null then
    raise exception 'id документа обязателен';
  end if;

  v_type := public.product_supply_parse_document_type(p_document_type);
  if v_filename is null then
    raise exception 'Имя файла обязательно';
  end if;
  if v_title is null then
    v_title := v_filename;
  end if;

  v_path := public.staff_assert_supply_document_path(
    p_supply_id, p_document_id, p_storage_path
  );

  if p_linked_expense_id is not null then
    if not exists (
      select 1
      from public.product_supply_expenses as e
      where e.id = p_linked_expense_id
        and e.supply_id = p_supply_id
    ) then
      raise exception 'Расход не принадлежит этой поставке';
    end if;
  end if;

  if v_hash is not null then
    select exists (
      select 1
      from public.product_supply_documents as d
      where d.supply_id = p_supply_id
        and d.content_sha256 = v_hash
    ) into v_duplicate;

    select exists (
      select 1
      from public.product_supply_documents as d
      where d.supply_id = p_supply_id
        and d.content_sha256 = v_hash
        and d.parser_status = 'committed'
    ) into v_already;
  end if;

  insert into public.product_supply_documents (
    id,
    supply_id,
    document_type,
    title,
    original_filename,
    storage_path,
    mime_type,
    file_size,
    content_sha256,
    uploaded_by,
    document_date,
    notes,
    linked_expense_id,
    parser_status,
    source_kind
  ) values (
    p_document_id,
    p_supply_id,
    v_type,
    v_title,
    v_filename,
    v_path,
    nullif(trim(p_mime_type), ''),
    p_file_size,
    v_hash,
    v_uid,
    p_document_date,
    v_notes,
    p_linked_expense_id,
    'uploaded',
    'upload'
  );

  perform public.staff_touch_product_supply(p_supply_id);

  return jsonb_build_object(
    'document', public.staff_product_supply_document_json(p_document_id),
    'duplicate_file', v_duplicate,
    'already_imported', v_already,
    'supply_status', v_row.status
  );
end;
$$;

revoke all on function public.staff_register_product_supply_document(
  uuid, uuid, text, text, text, text, text, bigint, date, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.staff_register_product_supply_document(
  uuid, uuid, text, text, text, text, text, bigint, date, text, uuid, text
) to authenticated;

create or replace function public.staff_get_product_supply_document(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_json jsonb;
begin
  perform public.staff_assert_product_supply_admin();
  if p_document_id is null then
    raise exception 'id документа обязателен';
  end if;
  v_json := public.staff_product_supply_document_json(p_document_id);
  if v_json is null then
    raise exception 'Документ не найден';
  end if;
  return v_json;
end;
$$;

revoke all on function public.staff_get_product_supply_document(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_product_supply_document(uuid)
  to authenticated;

create or replace function public.staff_update_product_supply_document(
  p_document_id uuid,
  p_title text default null,
  p_notes text default null,
  p_document_date date default null,
  p_linked_expense_id uuid default null,
  p_clear_notes boolean default false,
  p_clear_date boolean default false,
  p_clear_expense boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.product_supply_documents;
  v_title text;
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

  perform public.staff_lock_product_supply(v_doc.supply_id);

  v_title := coalesce(nullif(trim(p_title), ''), v_doc.title);

  if p_linked_expense_id is not null then
    if not exists (
      select 1
      from public.product_supply_expenses as e
      where e.id = p_linked_expense_id
        and e.supply_id = v_doc.supply_id
    ) then
      raise exception 'Расход не принадлежит этой поставке';
    end if;
  end if;

  update public.product_supply_documents as d
  set
    title = v_title,
    notes = case
      when p_clear_notes then null
      when p_notes is not null then nullif(trim(p_notes), '')
      else d.notes
    end,
    document_date = case
      when p_clear_date then null
      else coalesce(p_document_date, d.document_date)
    end,
    linked_expense_id = case
      when p_clear_expense then null
      else coalesce(p_linked_expense_id, d.linked_expense_id)
    end
  where d.id = p_document_id;

  perform public.staff_touch_product_supply(v_doc.supply_id);
  return public.staff_product_supply_payload(v_doc.supply_id);
end;
$$;

revoke all on function public.staff_update_product_supply_document(
  uuid, text, text, date, uuid, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.staff_update_product_supply_document(
  uuid, text, text, date, uuid, boolean, boolean, boolean
) to authenticated;

create or replace function public.staff_delete_product_supply_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.product_supply_documents;
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

  perform public.staff_lock_product_supply(v_doc.supply_id);

  if v_doc.parser_status = 'committed' then
    raise exception 'Нельзя удалить документ, из которого уже импортированы данные';
  end if;

  delete from public.product_supply_documents where id = p_document_id;
  perform public.staff_touch_product_supply(v_doc.supply_id);

  return jsonb_build_object(
    'deleted', true,
    'id', p_document_id,
    'storage_path', v_doc.storage_path,
    'supply_id', v_doc.supply_id
  );
end;
$$;

revoke all on function public.staff_delete_product_supply_document(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_delete_product_supply_document(uuid)
  to authenticated;

-- ============================================================
-- 10. Import preview + commit
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
  v_out jsonb := '[]'::jsonb;
  v_unmatched integer := 0;
  v_matched integer := 0;
  v_invalid integer := 0;
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

  for v_row in
    select value from jsonb_array_elements(v_rows)
  loop
    v_match := public.staff_match_product_for_supply_import(
      v_row ->> 'ownCode',
      v_row ->> 'supplierCode'
    );

    if coalesce(v_row ->> 'quantity', '') = '' or (v_row -> 'quantity') is null then
      v_invalid := v_invalid + 1;
    elsif (v_match ->> 'match_status') = 'unmatched' then
      v_unmatched := v_unmatched + 1;
    else
      v_matched := v_matched + 1;
    end if;

    v_out := v_out || jsonb_build_array(
      v_row || jsonb_build_object(
        'match_status', v_match ->> 'match_status',
        'matched_product_id', v_match -> 'product_id',
        'matched_sku', v_match -> 'sku',
        'matched_name', v_match -> 'name',
        'matched_original_sku', v_match -> 'original_sku',
        'matched_unit', v_match -> 'unit',
        'matched_product_status', v_match -> 'status',
        'ambiguous', coalesce((v_match ->> 'ambiguous')::boolean, false)
      )
    );
  end loop;

  update public.product_supply_documents as d
  set
    parser_status = 'preview',
    parser_metadata = coalesce(p_parse, '{}'::jsonb)
      || jsonb_build_object(
        'rows', v_out,
        'match_summary', jsonb_build_object(
          'matched', v_matched,
          'unmatched', v_unmatched,
          'invalid', v_invalid
        )
      ),
    source_kind = 'import'
  where d.id = p_document_id;

  perform public.staff_touch_product_supply(v_doc.supply_id);

  return jsonb_build_object(
    'document', public.staff_product_supply_document_json(p_document_id),
    'preview', (
      select parser_metadata
      from public.product_supply_documents
      where id = p_document_id
    ),
    'supply_status', (
      select s.status from public.product_supplies as s where s.id = v_doc.supply_id
    )
  );
end;
$$;

revoke all on function public.staff_prepare_product_supply_import(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_prepare_product_supply_import(uuid, jsonb)
  to authenticated;

create or replace function public.staff_mark_product_supply_document_parser(
  p_document_id uuid,
  p_status text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.product_supply_documents;
  v_status public.product_supply_parser_status;
begin
  perform public.staff_assert_product_supply_admin();

  select * into v_doc
  from public.product_supply_documents as d
  where d.id = p_document_id
  for update;

  if not found then
    raise exception 'Документ не найден';
  end if;

  begin
    v_status := trim(p_status)::public.product_supply_parser_status;
  exception
    when invalid_text_representation then
      raise exception 'Некорректный статус парсера';
  end;

  update public.product_supply_documents
  set
    parser_status = v_status,
    parser_metadata = case
      when jsonb_typeof(p_metadata) = 'object' then coalesce(p_metadata, '{}'::jsonb)
      else parser_metadata
    end
  where id = p_document_id;

  return public.staff_product_supply_document_json(p_document_id);
end;
$$;

revoke all on function public.staff_mark_product_supply_document_parser(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_mark_product_supply_document_parser(uuid, text, jsonb)
  to authenticated;

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
  v_rows jsonb;
  v_row jsonb;
  v_res jsonb;
  v_action text;
  v_product_id uuid;
  v_product public.products;
  v_item public.product_supply_items;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_unit text;
  v_sku text;
  v_name text;
  v_original text;
  v_sort integer;
  v_seen uuid[] := '{}';
  v_keep uuid[] := '{}';
  v_is_order boolean;
  v_draft jsonb;
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
    raise exception 'Этот документ уже импортирован. Повтор — только явной заменой.';
  end if;

  if v_doc.parser_status is distinct from 'preview'
     and not (v_doc.parser_status = 'committed' and coalesce(p_replace, false)) then
    raise exception 'Сначала разберите файл и подтвердите preview';
  end if;

  v_is_order := v_doc.document_type = 'factory_order';
  v_rows := coalesce(v_doc.parser_metadata -> 'rows', '[]'::jsonb);
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) = 0 then
    raise exception 'Нет строк для импорта';
  end if;

  if jsonb_typeof(coalesce(p_resolutions, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'resolutions должны быть массивом';
  end if;

  for v_row in select value from jsonb_array_elements(v_rows)
  loop
    v_res := null;
    select value into v_res
    from jsonb_array_elements(coalesce(p_resolutions, '[]'::jsonb)) as r(value)
    where (r.value ->> 'row_number')::integer = (v_row ->> 'rowNumber')::integer
    limit 1;

    v_action := coalesce(nullif(trim(v_res ->> 'action'), ''), 'use_match');
    if v_action = 'skip' then
      continue;
    end if;

    v_qty := nullif(v_row ->> 'quantity', '')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Строка %: некорректное количество', v_row ->> 'rowNumber';
    end if;

    v_price := nullif(v_row ->> 'price', '')::numeric;
    v_amount := nullif(v_row ->> 'amount', '')::numeric;
    v_unit := coalesce(nullif(trim(v_row ->> 'unit'), ''), 'шт.');
    v_name := nullif(trim(v_row ->> 'name'), '');
    v_original := nullif(trim(v_row ->> 'supplierCode'), '');
    v_sku := nullif(trim(v_row ->> 'ownCode'), '');

    if v_action = 'create_draft' then
      v_draft := coalesce(v_res -> 'create', '{}'::jsonb);
      v_sku := coalesce(nullif(trim(v_draft ->> 'sku'), ''), v_sku);
      v_name := coalesce(nullif(trim(v_draft ->> 'name'), ''), v_name);
      v_unit := coalesce(nullif(trim(v_draft ->> 'unit'), ''), v_unit);
      v_original := coalesce(nullif(trim(v_draft ->> 'original_sku'), ''), v_original);
      if v_sku is null then
        raise exception 'Строка %: для нового товара нужен артикул (OWN CODE)', v_row ->> 'rowNumber';
      end if;
      if v_name is null then
        raise exception 'Строка %: для нового товара нужно название', v_row ->> 'rowNumber';
      end if;
      if exists (select 1 from public.products as p where p.sku = v_sku) then
        raise exception 'Товар с артикулом «%» уже существует', v_sku;
      end if;

      insert into public.products (
        id, name, slug, sku, original_sku, unit, min_order_qty, status
      ) values (
        gen_random_uuid(),
        v_name,
        public.staff_unique_product_slug(v_sku, null),
        v_sku,
        v_original,
        v_unit,
        1,
        'draft'
      )
      returning id into v_product_id;
    elsif v_action = 'use_existing' then
      v_product_id := nullif(v_res ->> 'product_id', '')::uuid;
      if v_product_id is null then
        raise exception 'Строка %: выберите существующий товар', v_row ->> 'rowNumber';
      end if;
    else
      v_product_id := nullif(v_row ->> 'matched_product_id', '')::uuid;
      if v_product_id is null then
        raise exception 'Строка %: товар не сопоставлен', v_row ->> 'rowNumber';
      end if;
    end if;

    if v_product_id = any (v_seen) then
      raise exception
        'Две строки файла попали в один товар. Сопоставьте их с разными карточками (строка %).',
        v_row ->> 'rowNumber';
    end if;
    v_seen := v_seen || v_product_id;
    v_keep := v_keep || v_product_id;

    select * into v_product from public.products as p where p.id = v_product_id;
    if not found then
      raise exception 'Товар не найден';
    end if;

    select * into v_item
    from public.product_supply_items as i
    where i.supply_id = v_doc.supply_id
      and i.product_id = v_product_id
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
        v_product_id,
        v_sort,
        v_qty,
        coalesce(v_product.unit, v_unit, 'шт.'),
        v_supply.default_currency,
        v_price,
        v_supply.default_exchange_rate_to_kzt,
        v_product.weight_kg,
        case when v_is_order then 'ordered' else 'shipped' end
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
        ordered_spec = nullif(trim(v_row ->> 'spec'), ''),
        ordered_name = v_name,
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
          else 'ordered'
        end,
        import_row_metadata = coalesce(i.import_row_metadata, '{}'::jsonb)
          || jsonb_build_object('ordered_row', v_row)
      where i.id = v_item.id;
    else
      update public.product_supply_items as i
      set
        shipped_quantity = v_qty,
        shipped_unit = v_unit,
        shipped_purchase_currency = v_supply.default_currency,
        shipped_price_per_unit = v_price,
        shipped_amount = v_amount,
        shipped_spec = nullif(trim(v_row ->> 'spec'), ''),
        shipped_name = v_name,
        shipped_source_document_id = v_doc.id,
        quantity = v_qty,
        purchase_price_per_unit = coalesce(v_price, i.purchase_price_per_unit),
        purchase_currency = v_supply.default_currency,
        qty_source = 'shipped',
        import_row_metadata = coalesce(i.import_row_metadata, '{}'::jsonb)
          || jsonb_build_object('shipped_row', v_row)
      where i.id = v_item.id;
    end if;
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
          when i.ordered_quantity is not null then 'ordered'
          else 'manual'
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

revoke all on function public.staff_commit_product_supply_import(uuid, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_commit_product_supply_import(uuid, jsonb, boolean)
  to authenticated;

create or replace function public.staff_get_product_supply_import_preview(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc public.product_supply_documents;
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

  return jsonb_build_object(
    'document', public.staff_product_supply_document_json(p_document_id),
    'preview', v_doc.parser_metadata,
    'parser_status', v_doc.parser_status,
    'supply_id', v_doc.supply_id
  );
end;
$$;

revoke all on function public.staff_get_product_supply_import_preview(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_product_supply_import_preview(uuid)
  to authenticated;

-- ============================================================
-- 11. Storage references (Data Center orphan scan)
-- ============================================================

create or replace function public.admin_get_storage_references()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product_images jsonb;
  v_documents jsonb;
  v_snapshots jsonb;
  v_org jsonb;
  v_archives jsonb;
  v_supply_docs jsonb;
begin
  perform public.data_lifecycle_assert_admin();

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_product_images from (
    select distinct 'product-images'::text as bucket, p.main_photo_path as path, p.id as product_id
    from public.products p where p.main_photo_path is not null
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_documents from (
    select 'organization-assets'::text as bucket, d.file_path as path, d.id as document_id, d.order_id
    from public.order_documents d where d.file_path is not null
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb) into v_snapshots from (
    select i.id, i.status, i.order_id, i.document_type,
           i.source_logo_path, i.source_stamp_path, i.source_signature_path,
           i.logo_path, i.stamp_path, i.signature_path, i.expires_at, i.created_at
    from public.document_asset_snapshot_intents i
    order by i.created_at desc limit 500
  ) r;

  select jsonb_build_object(
    'logo_path', s.logo_path,
    'stamp_path', s.stamp_path,
    'signature_path', s.signature_path,
    'kaspi_qr_path', s.kaspi_qr_path
  ) into v_org from public.organization_settings s where s.singleton_key='default';

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_archives from (
    select a.id, a.archive_number, a.export_file_path, a.status, a.export_bytes
    from public.data_archives a where a.export_file_path is not null
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_supply_docs from (
    select
      'supply-documents'::text as bucket,
      d.storage_path as path,
      d.id as document_id,
      d.supply_id
    from public.product_supply_documents d
    where d.storage_path is not null
  ) r;

  return jsonb_build_object(
    'product_images', coalesce(v_product_images,'[]'::jsonb),
    'documents', coalesce(v_documents,'[]'::jsonb),
    'snapshots', coalesce(v_snapshots,'[]'::jsonb),
    'organization_assets', coalesce(v_org,'{}'::jsonb),
    'data_archives', coalesce(v_archives,'[]'::jsonb),
    'supply_documents', coalesce(v_supply_docs,'[]'::jsonb),
    'note', 'Physical orphan scan/delete — server API only (service_role after admin JWT).'
  );
end;
$$;

revoke all on function public.admin_get_storage_references() from public, anon, authenticated;
grant execute on function public.admin_get_storage_references() to authenticated;

comment on table public.product_supply_status_history is
  'Logistics timeline. Independent of financial close snapshot.';

comment on column public.product_supply_items.qty_source is
  'manual | ordered (preliminary) | shipped (Stage 38 landed cost basis).';

comment on column public.product_supply_items.ordered_source_document_id is
  'Original factory_order file this ordered qty/price came from.';

comment on column public.product_supply_items.shipped_source_document_id is
  'Original factory_shipment file this actual qty/price came from.';
