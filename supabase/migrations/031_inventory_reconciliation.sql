-- ============================================================
-- 031_inventory_reconciliation.sql
-- Stage 31 — Inventory reconciliation with 1C Excel
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–030 files.
-- Does NOT write stock_receipts or send stock_received.
-- Excel upload never changes inventory by itself — only
-- staff_apply_inventory_reconciliation after explicit confirm.
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null
     or to_regclass('public.inventory') is null
     or to_regclass('public.warehouses') is null
  then
    raise exception
      'Catalog/inventory tables missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.inventory_adjustments') is null then
    raise exception
      'public.inventory_adjustments missing — run 020_product_inventory_and_catalog_images.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception
      'staff_resolve_warehouse_id missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.data_lifecycle_assert_admin()') is null then
    raise exception
      'data_lifecycle_assert_admin missing — run 027_data_lifecycle.sql first.';
  end if;

  if to_regclass('public.stock_receipts') is null then
    raise exception
      'public.stock_receipts missing — run 030_workflow_notifications.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Sequence / number
-- ============================================================

create sequence if not exists public.inventory_reconciliations_number_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1
  no maxvalue
  cache 1;

revoke all on sequence public.inventory_reconciliations_number_seq
  from public, anon, authenticated;

create or replace function public.generate_inventory_reconciliation_number()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select 'REC-' || lpad(
    nextval('public.inventory_reconciliations_number_seq')::text,
    6,
    '0'
  );
$$;

revoke all on function public.generate_inventory_reconciliation_number()
  from public, anon, authenticated;

-- ============================================================
-- 2. inventory_reconciliations
-- ============================================================

create table if not exists public.inventory_reconciliations (
  id uuid primary key default gen_random_uuid(),
  reconciliation_number text not null unique
    default public.generate_inventory_reconciliation_number(),
  source_type text not null default '1c_excel',
  source_file_name text not null,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  status text not null default 'reviewed',
  total_rows integer not null default 0,
  matched_rows integer not null default 0,
  equal_rows integer not null default 0,
  different_rows integer not null default 0,
  missing_in_dekoro_rows integer not null default 0,
  missing_in_source_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  invalid_rows integer not null default 0,
  applied_rows integer not null default 0,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  applied_by uuid references public.profiles (id) on delete restrict,
  applied_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete restrict,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint inventory_reconciliations_source_type_check
    check (source_type = '1c_excel'),
  constraint inventory_reconciliations_status_check
    check (status in (
      'draft',
      'reviewed',
      'partially_applied',
      'applied',
      'cancelled'
    )),
  constraint inventory_reconciliations_file_name_not_blank
    check (length(trim(source_file_name)) > 0),
  constraint inventory_reconciliations_file_name_len
    check (char_length(source_file_name) <= 255),
  constraint inventory_reconciliations_counts_non_negative
    check (
      total_rows >= 0
      and matched_rows >= 0
      and equal_rows >= 0
      and different_rows >= 0
      and missing_in_dekoro_rows >= 0
      and missing_in_source_rows >= 0
      and duplicate_rows >= 0
      and invalid_rows >= 0
      and applied_rows >= 0
    ),
  constraint inventory_reconciliations_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

comment on table public.inventory_reconciliations is
  '1C Excel stock reconciliation sessions. File binary is never stored. Apply is explicit and separate from upload.';

comment on column public.inventory_reconciliations.warehouse_id is
  'Warehouse whose physical stock is compared. Currently always ALMATY-01 via staff_resolve_warehouse_id().';

create index if not exists inventory_reconciliations_created_at_idx
  on public.inventory_reconciliations (created_at desc);

create index if not exists inventory_reconciliations_status_idx
  on public.inventory_reconciliations (status);

create index if not exists inventory_reconciliations_warehouse_id_idx
  on public.inventory_reconciliations (warehouse_id);

alter table public.inventory_reconciliations enable row level security;

revoke all on table public.inventory_reconciliations
  from public, anon, authenticated;

-- ============================================================
-- 3. inventory_reconciliation_items
-- ============================================================

create table if not exists public.inventory_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null
    references public.inventory_reconciliations (id) on delete cascade,
  product_id uuid references public.products (id) on delete restrict,
  source_sku text,
  source_name text,
  source_quantity numeric(14, 3),
  platform_quantity numeric(14, 3),
  reserved_quantity numeric(14, 3),
  available_quantity numeric(14, 3),
  difference numeric(14, 3),
  match_status text not null,
  apply_status text not null default 'pending',
  conflict_code text,
  conflict_message text,
  applied_quantity numeric(14, 3),
  applied_adjustment_id uuid
    references public.inventory_adjustments (id) on delete set null,
  source_row_number integer,
  duplicate_count integer,
  error_message text,
  created_at timestamptz not null default now(),
  constraint inventory_reconciliation_items_match_status_check
    check (match_status in (
      'matched_equal',
      'matched_difference',
      'missing_in_dekoro',
      'missing_in_source',
      'duplicate_source',
      'invalid'
    )),
  constraint inventory_reconciliation_items_apply_status_check
    check (apply_status in ('pending', 'applied', 'conflict', 'skipped')),
  constraint inventory_reconciliation_items_conflict_code_check
    check (
      conflict_code is null
      or conflict_code in ('reservation_conflict', 'stale')
    ),
  constraint inventory_reconciliation_items_quantities_finite
    check (
      (source_quantity is null or source_quantity = source_quantity)
      and (platform_quantity is null or platform_quantity >= 0)
      and (reserved_quantity is null or reserved_quantity >= 0)
      and (available_quantity is null or available_quantity >= 0)
      and (applied_quantity is null or applied_quantity >= 0)
    )
);

comment on table public.inventory_reconciliation_items is
  'Per-SKU comparison snapshot. difference/platform_quantity are server-computed; browser values are not trusted at apply.';

comment on column public.inventory_reconciliation_items.platform_quantity is
  'Physical inventory.quantity snapshot at compare time. Apply refuses if current quantity differs (stale).';

comment on column public.inventory_reconciliation_items.reserved_quantity is
  'Authoritative reserved snapshot: greatest(inventory.reserved_quantity, sum of active inventory_reservations). Excel/apply never write reserved_quantity except initializing a missing inventory row to that floor.';

create index if not exists inventory_reconciliation_items_rec_idx
  on public.inventory_reconciliation_items (reconciliation_id, match_status);

create index if not exists inventory_reconciliation_items_apply_idx
  on public.inventory_reconciliation_items (reconciliation_id, apply_status);

create index if not exists inventory_reconciliation_items_product_idx
  on public.inventory_reconciliation_items (product_id)
  where product_id is not null;

alter table public.inventory_reconciliation_items enable row level security;

revoke all on table public.inventory_reconciliation_items
  from public, anon, authenticated;

-- ============================================================
-- 4. Role helper
-- ============================================================

create or replace function public.staff_assert_inventory_reconciliation_role()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  -- Manager / accountant / client intentionally excluded.
  if not public.has_staff_role(
    array['warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для сверки остатков с 1С';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.staff_assert_inventory_reconciliation_role()
  from public, anon, authenticated;

-- Authoritative reserved floor: denormalized inventory.reserved_quantity
-- can theoretically drift from inventory_reservations. Apply/compare use
-- the greater of the two so a stale-low denormalized value cannot allow
-- physical < real active reserve. Does not lock reservation rows
-- (cancel_order locks reservations then inventory — locking both here
-- after inventory would deadlock). Inventory FOR UPDATE already serializes
-- reserve/release writers.
create or replace function public.staff_inventory_authoritative_reserved(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_denormalized numeric
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    coalesce(p_denormalized, 0),
    coalesce((
      select sum(r.quantity)
      from public.inventory_reservations as r
      where r.product_id = p_product_id
        and r.warehouse_id = p_warehouse_id
        and r.status = 'active'
    ), 0)
  )::numeric(14, 3);
$$;

revoke all on function public.staff_inventory_authoritative_reserved(uuid, uuid, numeric)
  from public, anon, authenticated;

-- ============================================================
-- 5. Filename sanitizer (basename only, no path)
-- ============================================================

create or replace function public.staff_safe_reconciliation_filename(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    raise exception 'Имя файла обязательно';
  end if;

  v_name := regexp_replace(v_name, E'.*[/\\\\]', '');
  v_name := regexp_replace(v_name, E'[\\u0000]', '', 'g');
  v_name := btrim(v_name);

  if v_name = '' or v_name in ('.', '..') then
    raise exception 'Некорректное имя файла';
  end if;

  if char_length(v_name) > 255 then
    v_name := left(v_name, 255);
  end if;

  return v_name;
end;
$$;

revoke all on function public.staff_safe_reconciliation_filename(text)
  from public, anon, authenticated;

-- ============================================================
-- 6. JSON payload helper (internal)
-- ============================================================

create or replace function public.staff_inventory_reconciliation_json(
  p_reconciliation_id uuid,
  p_include_items boolean default true
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_header jsonb;
  v_items jsonb := '[]'::jsonb;
begin
  select jsonb_build_object(
    'id', r.id,
    'reconciliation_number', r.reconciliation_number,
    'source_type', r.source_type,
    'source_file_name', r.source_file_name,
    'warehouse_id', r.warehouse_id,
    'status', r.status,
    'total_rows', r.total_rows,
    'matched_rows', r.matched_rows,
    'equal_rows', r.equal_rows,
    'different_rows', r.different_rows,
    'missing_in_dekoro_rows', r.missing_in_dekoro_rows,
    'missing_in_source_rows', r.missing_in_source_rows,
    'duplicate_rows', r.duplicate_rows,
    'invalid_rows', r.invalid_rows,
    'applied_rows', r.applied_rows,
    'created_by', r.created_by,
    'created_by_name', cr.full_name,
    'created_at', r.created_at,
    'applied_by', r.applied_by,
    'applied_by_name', ap.full_name,
    'applied_at', r.applied_at,
    'cancelled_by', r.cancelled_by,
    'cancelled_at', r.cancelled_at,
    'metadata', r.metadata
  )
  into v_header
  from public.inventory_reconciliations as r
  left join public.profiles as cr on cr.id = r.created_by
  left join public.profiles as ap on ap.id = r.applied_by
  where r.id = p_reconciliation_id;

  if v_header is null then
    raise exception 'Сверка не найдена';
  end if;

  if p_include_items then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_rank, x.source_sku, x.source_row_number), '[]'::jsonb)
    into v_items
    from (
      select
        i.id,
        i.reconciliation_id,
        i.product_id,
        p.name as product_name,
        p.sku as product_sku,
        i.source_sku,
        i.source_name,
        i.source_quantity,
        i.platform_quantity,
        i.reserved_quantity,
        i.available_quantity,
        i.difference,
        i.match_status,
        i.apply_status,
        i.conflict_code,
        i.conflict_message,
        i.applied_quantity,
        i.applied_adjustment_id,
        i.source_row_number,
        i.duplicate_count,
        i.error_message,
        i.created_at,
        case i.match_status
          when 'matched_difference' then 1
          when 'missing_in_dekoro' then 2
          when 'missing_in_source' then 3
          when 'duplicate_source' then 4
          when 'invalid' then 5
          else 6
        end as sort_rank
      from public.inventory_reconciliation_items as i
      left join public.products as p on p.id = i.product_id
      where i.reconciliation_id = p_reconciliation_id
    ) as x;
  end if;

  return jsonb_build_object(
    'reconciliation', v_header,
    'items', v_items
  );
end;
$$;

revoke all on function public.staff_inventory_reconciliation_json(uuid, boolean)
  from public, anon, authenticated;

-- ============================================================
-- 7. Refresh header counts
-- ============================================================

create or replace function public.staff_refresh_inventory_reconciliation_counts(
  p_reconciliation_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.inventory_reconciliations as r
  set
    total_rows = s.total_rows,
    matched_rows = s.matched_rows,
    equal_rows = s.equal_rows,
    different_rows = s.different_rows,
    missing_in_dekoro_rows = s.missing_in_dekoro_rows,
    missing_in_source_rows = s.missing_in_source_rows,
    duplicate_rows = s.duplicate_rows,
    invalid_rows = s.invalid_rows,
    applied_rows = s.applied_rows,
    status = case
      when r.status = 'cancelled' then r.status
      when s.applied_rows > 0
           and (s.pending_diff_rows > 0 or s.conflict_diff_rows > 0)
        then 'partially_applied'
      when s.applied_rows > 0 and s.pending_diff_rows = 0 then 'applied'
      else r.status
    end
  from (
    select
      count(*) filter (
        where i.match_status <> 'missing_in_source'
      )::integer as total_rows,
      count(*) filter (
        where i.match_status in ('matched_equal', 'matched_difference')
      )::integer as matched_rows,
      count(*) filter (
        where i.match_status = 'matched_equal'
      )::integer as equal_rows,
      count(*) filter (
        where i.match_status = 'matched_difference'
      )::integer as different_rows,
      count(*) filter (
        where i.match_status = 'missing_in_dekoro'
      )::integer as missing_in_dekoro_rows,
      count(*) filter (
        where i.match_status = 'missing_in_source'
      )::integer as missing_in_source_rows,
      count(*) filter (
        where i.match_status = 'duplicate_source'
      )::integer as duplicate_rows,
      count(*) filter (
        where i.match_status = 'invalid'
      )::integer as invalid_rows,
      count(*) filter (
        where i.apply_status = 'applied'
      )::integer as applied_rows,
      count(*) filter (
        where i.match_status = 'matched_difference'
          and i.apply_status = 'pending'
      )::integer as pending_diff_rows,
      count(*) filter (
        where i.match_status = 'matched_difference'
          and i.apply_status = 'conflict'
      )::integer as conflict_diff_rows
    from public.inventory_reconciliation_items as i
    where i.reconciliation_id = p_reconciliation_id
  ) as s
  where r.id = p_reconciliation_id;
end;
$$;

revoke all on function public.staff_refresh_inventory_reconciliation_counts(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 8. Create + compare (single RPC, no inventory writes)
-- ============================================================

create or replace function public.staff_create_inventory_reconciliation(
  p_source_file_name text,
  p_rows jsonb,
  p_column_mapping jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_warehouse_id uuid;
  v_file_name text;
  v_mapping jsonb;
  v_id uuid;
  v_rec public.inventory_reconciliations%rowtype;
  v_elem jsonb;
  v_ord integer;
  v_src record;
  v_sku text;
  v_name text;
  v_qty_raw text;
  v_qty numeric(14, 3);
  v_row_no integer;
  v_error text;
  v_qty_kind text;
  v_max numeric := 1000000000;
begin
  v_uid := public.staff_assert_inventory_reconciliation_role();
  v_warehouse_id := public.staff_resolve_warehouse_id();
  v_file_name := public.staff_safe_reconciliation_filename(p_source_file_name);

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Строки сверки должны быть JSON-массивом';
  end if;

  if jsonb_array_length(p_rows) = 0 then
    raise exception 'Файл не содержит строк с данными';
  end if;

  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'Слишком много строк (максимум 10 000)';
  end if;

  if p_column_mapping is null or jsonb_typeof(p_column_mapping) <> 'object' then
    v_mapping := '{}'::jsonb;
  else
    v_mapping := jsonb_build_object(
      'sku_column', left(btrim(coalesce(p_column_mapping->>'sku_column', '')), 200),
      'name_column', left(btrim(coalesce(p_column_mapping->>'name_column', '')), 200),
      'quantity_column', left(btrim(coalesce(p_column_mapping->>'quantity_column', '')), 200),
      'sheet_name', left(btrim(coalesce(p_column_mapping->>'sheet_name', '')), 80)
    );
  end if;

  drop table if exists tmp_rec_src;
  create temporary table tmp_rec_src (
    source_row_number integer,
    source_sku text,
    source_name text,
    source_quantity numeric(14, 3),
    normalized_sku text,
    error_message text
  ) on commit drop;

  for v_src in
    select t.value, t.ordinality
    from jsonb_array_elements(p_rows) with ordinality as t(value, ordinality)
  loop
    v_elem := v_src.value;
    v_ord := v_src.ordinality;
    v_error := null;
    v_qty := null;
    v_sku := null;
    v_name := null;
    v_qty_raw := null;

    if jsonb_typeof(v_elem) <> 'object' then
      v_error := 'Некорректная строка';
      insert into tmp_rec_src (
        source_row_number, source_sku, source_name, source_quantity, normalized_sku, error_message
      ) values (
        v_ord, null, null, null, null, v_error
      );
      continue;
    end if;

    begin
      v_row_no := coalesce((v_elem->>'row_number')::integer, v_ord);
    exception
      when others then
        v_row_no := v_ord;
    end;

    v_sku := nullif(btrim(coalesce(v_elem->>'sku', '')), '');
    v_name := nullif(left(btrim(coalesce(v_elem->>'name', '')), 500), '');

    v_qty_kind := jsonb_typeof(v_elem->'quantity');
    if v_qty_kind is null or v_qty_kind = 'null' then
      v_qty_raw := null;
    elsif v_qty_kind in ('number', 'string') then
      v_qty_raw := btrim(v_elem->>'quantity');
    else
      v_error := 'Некорректное количество';
    end if;

    if v_error is null then
      if v_sku is null then
        v_error := 'Пустой артикул';
      elsif v_qty_raw is null or v_qty_raw = '' then
        v_error := 'Пустое количество';
      else
        v_qty_raw := replace(v_qty_raw, ',', '.');
        v_qty_raw := replace(v_qty_raw, ' ', '');
        if lower(v_qty_raw) in ('nan', 'infinity', '+infinity', '-infinity', 'inf', '+inf', '-inf') then
          v_error := 'Некорректное количество';
        elsif v_qty_raw ~ '^-' then
          v_error := 'Отрицательный остаток';
        elsif v_qty_raw !~ '^\+?[0-9]+(\.[0-9]+)?$' then
          v_error := 'Некорректное количество';
        else
          begin
            v_qty := replace(v_qty_raw, '+', '')::numeric(14, 3);
          exception
            when others then
              v_error := 'Некорректное количество';
              v_qty := null;
          end;
          if v_error is null and v_qty is not null then
            if v_qty <> v_qty then
              v_error := 'Некорректное количество';
            elsif v_qty > v_max then
              v_error := 'Слишком большое количество';
            end if;
          end if;
        end if;
      end if;
    end if;

    insert into tmp_rec_src (
      source_row_number,
      source_sku,
      source_name,
      source_quantity,
      normalized_sku,
      error_message
    ) values (
      v_row_no,
      coalesce(v_sku, nullif(btrim(coalesce(v_elem->>'sku', '')), '')),
      v_name,
      v_qty,
      v_sku,
      v_error
    );
  end loop;

  insert into public.inventory_reconciliations (
    source_type,
    source_file_name,
    warehouse_id,
    status,
    created_by,
    metadata
  ) values (
    '1c_excel',
    v_file_name,
    v_warehouse_id,
    'reviewed',
    v_uid,
    jsonb_build_object(
      'column_mapping', v_mapping,
      'source_row_count', jsonb_array_length(p_rows)
    )
  )
  returning * into v_rec;

  v_id := v_rec.id;

  -- Source rows: invalid / duplicate / matched / missing_in_dekoro
  insert into public.inventory_reconciliation_items (
    reconciliation_id,
    product_id,
    source_sku,
    source_name,
    source_quantity,
    platform_quantity,
    reserved_quantity,
    available_quantity,
    difference,
    match_status,
    apply_status,
    conflict_code,
    conflict_message,
    source_row_number,
    duplicate_count,
    error_message
  )
  select
    v_id,
    p.id,
    s.source_sku,
    s.source_name,
    s.source_quantity,
    case when p.id is null then null else coalesce(inv.quantity, 0) end,
    case
      when p.id is null then null
      else greatest(coalesce(inv.reserved_quantity, 0), coalesce(res.active_reserved, 0))
    end,
    case
      when p.id is null then null
      else greatest(
        coalesce(inv.quantity, 0)
        - greatest(coalesce(inv.reserved_quantity, 0), coalesce(res.active_reserved, 0)),
        0
      )
    end,
    case
      when p.id is null or s.source_quantity is null then null
      else s.source_quantity - coalesce(inv.quantity, 0)
    end,
    case
      when s.normalized_sku is not null and occ.cnt > 1 then 'duplicate_source'
      when s.error_message is not null then 'invalid'
      when p.id is null then 'missing_in_dekoro'
      when s.source_quantity is not distinct from coalesce(inv.quantity, 0) then 'matched_equal'
      else 'matched_difference'
    end,
    'pending',
    case
      when s.normalized_sku is not null and occ.cnt > 1 then null
      when s.error_message is not null then null
      when p.id is not null
           and s.source_quantity is not null
           and s.source_quantity < greatest(
             coalesce(inv.reserved_quantity, 0),
             coalesce(res.active_reserved, 0)
           )
        then 'reservation_conflict'
      else null
    end,
    case
      when p.id is not null
           and s.source_quantity is not null
           and s.source_quantity < greatest(
             coalesce(inv.reserved_quantity, 0),
             coalesce(res.active_reserved, 0)
           )
           and not (s.normalized_sku is not null and occ.cnt > 1)
           and s.error_message is null
        then 'Остаток 1С ниже зарезервированного количества.'
      else null
    end,
    s.source_row_number,
    case when s.normalized_sku is not null then occ.cnt else null end,
    case
      when s.normalized_sku is not null and occ.cnt > 1 then
        coalesce(s.error_message, 'Артикул встречается в файле несколько раз')
      else s.error_message
    end
  from tmp_rec_src as s
  left join public.products as p
    on p.sku = s.normalized_sku
  left join public.inventory as inv
    on inv.product_id = p.id
   and inv.warehouse_id = v_warehouse_id
  left join (
    select r.product_id, coalesce(sum(r.quantity), 0)::numeric(14, 3) as active_reserved
    from public.inventory_reservations as r
    where r.warehouse_id = v_warehouse_id
      and r.status = 'active'
    group by r.product_id
  ) as res on res.product_id = p.id
  left join (
    select normalized_sku, count(*)::integer as cnt
    from tmp_rec_src
    where normalized_sku is not null
    group by normalized_sku
  ) as occ on occ.normalized_sku = s.normalized_sku;

  -- DEKORO products absent from the file — never zeroed.
  insert into public.inventory_reconciliation_items (
    reconciliation_id,
    product_id,
    source_sku,
    source_name,
    source_quantity,
    platform_quantity,
    reserved_quantity,
    available_quantity,
    difference,
    match_status,
    apply_status
  )
  select
    v_id,
    p.id,
    p.sku,
    p.name,
    null,
    coalesce(inv.quantity, 0),
    greatest(coalesce(inv.reserved_quantity, 0), coalesce(res.active_reserved, 0)),
    greatest(
      coalesce(inv.quantity, 0)
      - greatest(coalesce(inv.reserved_quantity, 0), coalesce(res.active_reserved, 0)),
      0
    ),
    null,
    'missing_in_source',
    'pending'
  from public.products as p
  left join public.inventory as inv
    on inv.product_id = p.id
   and inv.warehouse_id = v_warehouse_id
  left join (
    select r.product_id, coalesce(sum(r.quantity), 0)::numeric(14, 3) as active_reserved
    from public.inventory_reservations as r
    where r.warehouse_id = v_warehouse_id
      and r.status = 'active'
    group by r.product_id
  ) as res on res.product_id = p.id
  where not exists (
    select 1
    from public.inventory_reconciliation_items as i
    where i.reconciliation_id = v_id
      and i.product_id = p.id
  );

  perform public.staff_refresh_inventory_reconciliation_counts(v_id);

  return public.staff_inventory_reconciliation_json(v_id, true);
end;
$$;

revoke all on function public.staff_create_inventory_reconciliation(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_create_inventory_reconciliation(text, jsonb, jsonb)
  to authenticated;

comment on function public.staff_create_inventory_reconciliation(text, jsonb, jsonb) is
  'Warehouse/admin: parse-validated 1C rows → comparison session. Does not change inventory.quantity or reserved_quantity.';

-- ============================================================
-- 9. Get / list
-- ============================================================

create or replace function public.staff_get_inventory_reconciliation(
  p_reconciliation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.staff_assert_inventory_reconciliation_role();

  if p_reconciliation_id is null then
    raise exception 'id сверки обязателен';
  end if;

  return public.staff_inventory_reconciliation_json(p_reconciliation_id, true);
end;
$$;

revoke all on function public.staff_get_inventory_reconciliation(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_inventory_reconciliation(uuid)
  to authenticated;

create or replace function public.staff_list_inventory_reconciliations(
  p_limit integer default 50
)
returns table (
  id uuid,
  reconciliation_number text,
  source_file_name text,
  status text,
  total_rows integer,
  matched_rows integer,
  equal_rows integer,
  different_rows integer,
  missing_in_dekoro_rows integer,
  missing_in_source_rows integer,
  duplicate_rows integer,
  invalid_rows integer,
  applied_rows integer,
  created_by uuid,
  created_by_name text,
  created_at timestamptz,
  applied_by uuid,
  applied_by_name text,
  applied_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  perform public.staff_assert_inventory_reconciliation_role();
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  return query
  select
    r.id,
    r.reconciliation_number,
    r.source_file_name,
    r.status,
    r.total_rows,
    r.matched_rows,
    r.equal_rows,
    r.different_rows,
    r.missing_in_dekoro_rows,
    r.missing_in_source_rows,
    r.duplicate_rows,
    r.invalid_rows,
    r.applied_rows,
    r.created_by,
    cr.full_name,
    r.created_at,
    r.applied_by,
    ap.full_name,
    r.applied_at
  from public.inventory_reconciliations as r
  left join public.profiles as cr on cr.id = r.created_by
  left join public.profiles as ap on ap.id = r.applied_by
  order by r.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_inventory_reconciliations(integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_inventory_reconciliations(integer)
  to authenticated;

-- ============================================================
-- 10. Apply selected items (locks, stale + reservation checks)
-- ============================================================

create or replace function public.staff_apply_inventory_reconciliation(
  p_reconciliation_id uuid,
  p_item_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_rec public.inventory_reconciliations%rowtype;
  v_warehouse_id uuid;
  v_item public.inventory_reconciliation_items%rowtype;
  v_inv public.inventory%rowtype;
  v_prev numeric(14, 3);
  v_new numeric(14, 3);
  v_reserved_auth numeric(14, 3);
  v_reason text;
  v_adj_id uuid;
  v_applied integer := 0;
  v_stale integer := 0;
  v_res integer := 0;
  v_already integer := 0;
  v_skipped integer := 0;
  v_increased integer := 0;
  v_decreased integer := 0;
begin
  v_uid := public.staff_assert_inventory_reconciliation_role();

  if p_reconciliation_id is null then
    raise exception 'id сверки обязателен';
  end if;

  if p_item_ids is null or coalesce(array_length(p_item_ids, 1), 0) = 0 then
    raise exception 'Выберите позиции для применения';
  end if;

  if coalesce(array_length(p_item_ids, 1), 0) > 10000 then
    raise exception 'Слишком много позиций для применения';
  end if;

  select * into v_rec
  from public.inventory_reconciliations as r
  where r.id = p_reconciliation_id
  for update;

  if not found then
    raise exception 'Сверка не найдена';
  end if;

  if v_rec.source_type is distinct from '1c_excel' then
    raise exception 'Этот тип сверки нельзя применить';
  end if;

  if v_rec.status = 'cancelled' then
    raise exception 'Сверка отменена';
  end if;

  v_warehouse_id := v_rec.warehouse_id;

  -- Lock selected items in stable id order (concurrency / idempotency).
  perform i.id
  from public.inventory_reconciliation_items as i
  where i.reconciliation_id = p_reconciliation_id
    and i.id = any(p_item_ids)
  order by i.id
  for update;

  -- Lock related products, then inventory, in id order.
  perform p.id
  from public.products as p
  where p.id in (
    select i.product_id
    from public.inventory_reconciliation_items as i
    where i.reconciliation_id = p_reconciliation_id
      and i.id = any(p_item_ids)
      and i.product_id is not null
  )
  order by p.id
  for update;

  perform inv.id
  from public.inventory as inv
  where inv.warehouse_id = v_warehouse_id
    and inv.product_id in (
      select i.product_id
      from public.inventory_reconciliation_items as i
      where i.reconciliation_id = p_reconciliation_id
        and i.id = any(p_item_ids)
        and i.product_id is not null
    )
  order by inv.product_id
  for update;

  for v_item in
    select *
    from public.inventory_reconciliation_items as i
    where i.reconciliation_id = p_reconciliation_id
      and i.id = any(p_item_ids)
    order by i.id
  loop
    if v_item.apply_status = 'applied' then
      v_already := v_already + 1;
      continue;
    end if;

    if v_item.apply_status = 'skipped' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_item.match_status is distinct from 'matched_difference' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_item.product_id is null or v_item.source_quantity is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_new := v_item.source_quantity;

    select * into v_inv
    from public.inventory as inv
    where inv.product_id = v_item.product_id
      and inv.warehouse_id = v_warehouse_id
    for update;

    -- Missing ALMATY-01 row: same production pattern as
    -- staff_adjust_product_inventory / staff_record_stock_receipt
    -- (physical 0). Do NOT insert before stale/reservation checks —
    -- a business conflict must not leave a leftover 0/0 row.
    if not found then
      v_inv := null;
      v_prev := 0;
      v_reserved_auth := public.staff_inventory_authoritative_reserved(
        v_item.product_id,
        v_warehouse_id,
        0
      );

      if 0 is distinct from coalesce(v_item.platform_quantity, 0) then
        update public.inventory_reconciliation_items as i
        set
          apply_status = 'conflict',
          conflict_code = 'stale',
          conflict_message = 'Остаток изменился после загрузки файла. Выполните повторную сверку.'
        where i.id = v_item.id
          and i.apply_status is distinct from 'applied';
        v_stale := v_stale + 1;
        continue;
      end if;

      if v_new < v_reserved_auth then
        update public.inventory_reconciliation_items as i
        set
          apply_status = 'conflict',
          conflict_code = 'reservation_conflict',
          conflict_message = 'Остаток 1С ниже зарезервированного количества.'
        where i.id = v_item.id
          and i.apply_status is distinct from 'applied';
        v_res := v_res + 1;
        continue;
      end if;

      if v_new is not distinct from v_prev then
        update public.inventory_reconciliation_items as i
        set
          apply_status = 'applied',
          applied_quantity = v_prev,
          conflict_code = null,
          conflict_message = null
        where i.id = v_item.id;
        v_applied := v_applied + 1;
        continue;
      end if;

      insert into public.inventory (
        product_id,
        warehouse_id,
        quantity,
        reserved_quantity
      ) values (
        v_item.product_id,
        v_warehouse_id,
        v_new,
        v_reserved_auth
      )
      on conflict (product_id, warehouse_id) do nothing
      returning * into v_inv;

      if v_inv.id is null then
        select * into v_inv
        from public.inventory as inv
        where inv.product_id = v_item.product_id
          and inv.warehouse_id = v_warehouse_id
        for update;

        if v_inv.quantity is distinct from 0 then
          update public.inventory_reconciliation_items as i
          set
            apply_status = 'conflict',
            conflict_code = 'stale',
            conflict_message = 'Остаток изменился после загрузки файла. Выполните повторную сверку.'
          where i.id = v_item.id
            and i.apply_status is distinct from 'applied';
          v_stale := v_stale + 1;
          continue;
        end if;

        v_reserved_auth := public.staff_inventory_authoritative_reserved(
          v_item.product_id,
          v_warehouse_id,
          v_inv.reserved_quantity
        );

        if v_new < v_reserved_auth then
          update public.inventory_reconciliation_items as i
          set
            apply_status = 'conflict',
            conflict_code = 'reservation_conflict',
            conflict_message = 'Остаток 1С ниже зарезервированного количества.'
          where i.id = v_item.id
            and i.apply_status is distinct from 'applied';
          v_res := v_res + 1;
          continue;
        end if;

        update public.inventory as inv
        set
          quantity = v_new,
          updated_at = now()
        where inv.id = v_inv.id
        returning * into v_inv;
      end if;
    else
      v_prev := v_inv.quantity;
      v_reserved_auth := public.staff_inventory_authoritative_reserved(
        v_item.product_id,
        v_warehouse_id,
        v_inv.reserved_quantity
      );

      if v_inv.quantity is distinct from coalesce(v_item.platform_quantity, 0) then
        update public.inventory_reconciliation_items as i
        set
          apply_status = 'conflict',
          conflict_code = 'stale',
          conflict_message = 'Остаток изменился после загрузки файла. Выполните повторную сверку.'
        where i.id = v_item.id
          and i.apply_status is distinct from 'applied';
        v_stale := v_stale + 1;
        continue;
      end if;

      if v_new < v_reserved_auth then
        update public.inventory_reconciliation_items as i
        set
          apply_status = 'conflict',
          conflict_code = 'reservation_conflict',
          conflict_message = 'Остаток 1С ниже зарезервированного количества.'
        where i.id = v_item.id
          and i.apply_status is distinct from 'applied';
        v_res := v_res + 1;
        continue;
      end if;

      if v_new is not distinct from v_prev then
        update public.inventory_reconciliation_items as i
        set
          apply_status = 'applied',
          applied_quantity = v_prev,
          conflict_code = null,
          conflict_message = null
        where i.id = v_item.id;
        v_applied := v_applied + 1;
        continue;
      end if;

      -- Physical only. reserved_quantity is never written on the update path.
      update public.inventory as inv
      set
        quantity = v_new,
        updated_at = now()
      where inv.id = v_inv.id
      returning * into v_inv;
    end if;

    v_reason := left(
      'Сверка с 1С ' || v_rec.reconciliation_number,
      500
    );

    insert into public.inventory_adjustments (
      inventory_id,
      product_id,
      warehouse_id,
      previous_quantity,
      new_quantity,
      difference,
      reason,
      created_by
    ) values (
      v_inv.id,
      v_inv.product_id,
      v_inv.warehouse_id,
      v_prev,
      v_new,
      v_new - v_prev,
      v_reason,
      v_uid
    )
    returning id into v_adj_id;

    update public.inventory_reconciliation_items as i
    set
      apply_status = 'applied',
      applied_quantity = v_new,
      applied_adjustment_id = v_adj_id,
      conflict_code = null,
      conflict_message = null
    where i.id = v_item.id;

    v_applied := v_applied + 1;
    if v_new > v_prev then
      v_increased := v_increased + 1;
    else
      v_decreased := v_decreased + 1;
    end if;
  end loop;

  if v_applied > 0 then
    update public.inventory_reconciliations as r
    set
      applied_by = coalesce(r.applied_by, v_uid),
      applied_at = now()
    where r.id = p_reconciliation_id;
  end if;

  perform public.staff_refresh_inventory_reconciliation_counts(p_reconciliation_id);

  return public.staff_inventory_reconciliation_json(p_reconciliation_id, true)
    || jsonb_build_object(
      'apply_result', jsonb_build_object(
        'applied_count', v_applied,
        'stale_count', v_stale,
        'reservation_conflict_count', v_res,
        'already_applied_count', v_already,
        'skipped_count', v_skipped,
        'increased_count', v_increased,
        'decreased_count', v_decreased
      )
    );
end;
$$;

revoke all on function public.staff_apply_inventory_reconciliation(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.staff_apply_inventory_reconciliation(uuid, uuid[])
  to authenticated;

comment on function public.staff_apply_inventory_reconciliation(uuid, uuid[]) is
  'Warehouse/admin: SET inventory.quantity from stored 1C snapshot, then journal inventory_adjustments. Adjustments table has no quantity trigger. Business conflicts (stale/reserve) skip the item; SQL exceptions roll back the batch. Idempotent per item under FOR UPDATE.';

-- ============================================================
-- 11. Cancel (does not un-apply)
-- ============================================================

create or replace function public.staff_cancel_inventory_reconciliation(
  p_reconciliation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_rec public.inventory_reconciliations%rowtype;
begin
  v_uid := public.staff_assert_inventory_reconciliation_role();

  if p_reconciliation_id is null then
    raise exception 'id сверки обязателен';
  end if;

  select * into v_rec
  from public.inventory_reconciliations as r
  where r.id = p_reconciliation_id
  for update;

  if not found then
    raise exception 'Сверка не найдена';
  end if;

  if v_rec.status = 'cancelled' then
    return public.staff_inventory_reconciliation_json(p_reconciliation_id, true);
  end if;

  if v_rec.status = 'applied' then
    raise exception 'Применённую сверку нельзя отменить';
  end if;

  update public.inventory_reconciliation_items as i
  set apply_status = 'skipped'
  where i.reconciliation_id = p_reconciliation_id
    and i.apply_status = 'pending';

  update public.inventory_reconciliations as r
  set
    status = 'cancelled',
    cancelled_by = v_uid,
    cancelled_at = now()
  where r.id = p_reconciliation_id;

  return public.staff_inventory_reconciliation_json(p_reconciliation_id, true);
end;
$$;

revoke all on function public.staff_cancel_inventory_reconciliation(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_cancel_inventory_reconciliation(uuid)
  to authenticated;

-- ============================================================
-- 12. admin_get_data_usage — + reconciliation tables
-- ============================================================

create or replace function public.admin_get_data_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_db_bytes bigint := 0;
  v_week_ago timestamptz := now() - interval '7 days';
  v_month_ago timestamptz := now() - interval '30 days';
  v_retention integer;
  v_raw_expired integer := 0;
  v_growth jsonb;
  v_settings public.data_retention_settings;
begin
  perform public.data_lifecycle_assert_admin();

  select coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'table_name', t.relname,
        'row_estimate', greatest(t.n_live_tup, 0),
        'total_bytes', pg_total_relation_size(t.relid),
        'bytes_is_estimate', true
      )
      order by pg_total_relation_size(t.relid) desc
    )
    from pg_catalog.pg_stat_user_tables as t
    where t.schemaname = 'public'
      and t.relname in (
        'orders','order_items','order_payments','order_documents',
        'products','categories','customers','profiles',
        'analytics_events','analytics_sessions',
        'analytics_aggregates_daily','analytics_aggregates_weekly','analytics_aggregates_monthly',
        'inventory','data_archives','document_asset_snapshot_intents','product_images',
        'price_groups','product_prices','customer_product_prices','company_product_prices',
        'staff_notifications','client_notifications','stock_receipts',
        'inventory_reconciliations','inventory_reconciliation_items'
      )
  ), '[]'::jsonb) into v_tables;

  select coalesce(sum(pg_total_relation_size(c.oid)), 0) into v_db_bytes
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','i','t','m');

  select jsonb_build_object(
    'products', (select count(*)::integer from public.products),
    'categories', (select count(*)::integer from public.categories),
    'customers', (select count(*)::integer from public.customers),
    'orders', (select count(*)::integer from public.orders where coalesce(is_test,false)=false),
    'test_orders', (select count(*)::integer from public.orders where is_test = true),
    'order_items', (
      select count(*)::integer from public.order_items oi
      join public.orders o on o.id = oi.order_id where coalesce(o.is_test,false)=false
    ),
    'payments', (
      select count(*)::integer from public.order_payments p
      join public.orders o on o.id = p.order_id where coalesce(o.is_test,false)=false
    ),
    'documents', (select count(*)::integer from public.order_documents),
    'analytics_sessions', (select count(*)::integer from public.analytics_sessions),
    'analytics_events', (select count(*)::integer from public.analytics_events),
    'storage_snapshots', (
      select count(*)::integer from public.document_asset_snapshot_intents
      where status in ('consumed','pending')
    ),
    'data_archives', (select count(*)::integer from public.data_archives),
    'aggregates_daily', (select count(*)::integer from public.analytics_aggregates_daily),
    'aggregates_weekly', (select count(*)::integer from public.analytics_aggregates_weekly),
    'aggregates_monthly', (select count(*)::integer from public.analytics_aggregates_monthly),
    'product_image_refs', (
      select count(*)::integer from public.products where main_photo_path is not null
    ),
    'price_groups', (select count(*)::integer from public.price_groups),
    'product_prices', (select count(*)::integer from public.product_prices),
    'customer_product_prices', (select count(*)::integer from public.customer_product_prices),
    'company_product_prices', (select count(*)::integer from public.company_product_prices),
    'staff_notifications', (select count(*)::integer from public.staff_notifications),
    'client_notifications', (select count(*)::integer from public.client_notifications),
    'stock_receipts', (select count(*)::integer from public.stock_receipts),
    'inventory_reconciliations', (select count(*)::integer from public.inventory_reconciliations),
    'inventory_reconciliation_items', (select count(*)::integer from public.inventory_reconciliation_items)
  ) into v_counts;

  select jsonb_build_object(
    'orders_week', (select count(*)::integer from public.orders where created_at >= v_week_ago and coalesce(is_test,false)=false),
    'orders_month', (select count(*)::integer from public.orders where created_at >= v_month_ago and coalesce(is_test,false)=false),
    'analytics_events_week', (select count(*)::integer from public.analytics_events where created_at >= v_week_ago),
    'analytics_events_month', (select count(*)::integer from public.analytics_events where created_at >= v_month_ago),
    'documents_week', (select count(*)::integer from public.order_documents where created_at >= v_week_ago),
    'documents_month', (select count(*)::integer from public.order_documents where created_at >= v_month_ago),
    'customers_week', (select count(*)::integer from public.customers where created_at >= v_week_ago),
    'customers_month', (select count(*)::integer from public.customers where created_at >= v_month_ago)
  ) into v_growth;

  select * into v_settings from public.data_retention_settings where singleton_key = 'default';
  v_retention := coalesce(v_settings.raw_analytics_days, 90);

  select count(*)::integer into v_raw_expired
  from public.analytics_events
  where created_at < now() - make_interval(days => v_retention);

  return jsonb_build_object(
    'timezone', 'Asia/Almaty',
    'counts', v_counts,
    'growth', v_growth,
    'largest_tables', v_tables,
    'database', jsonb_build_object(
      'approx_bytes', v_db_bytes,
      'approx_mb', round((v_db_bytes::numeric / (1024*1024)), 2),
      'bytes_is_estimate', true,
      'label', 'оценка (pg_total_relation_size)'
    ),
    'storage', jsonb_build_object(
      'note', 'Точный объём Storage — через server API (object count / listed size). Не смешивать с DB estimate.',
      'buckets', jsonb_build_array('product-images','organization-assets','data-archives'),
      'bytes_is_estimate', true
    ),
    'retention', jsonb_build_object(
      'raw_analytics_days', v_retention,
      'raw_analytics_expired_events', v_raw_expired,
      'last_aggregated_at', v_settings.last_aggregated_at,
      'last_cleanup_at', v_settings.last_cleanup_at,
      'last_cleanup_cutoff', v_settings.last_cleanup_cutoff
    )
  );
end;
$$;

revoke all on function public.admin_get_data_usage() from public, anon, authenticated;
grant execute on function public.admin_get_data_usage() to authenticated;

-- ============================================================
-- Notes
--
-- Physical stock  = inventory.quantity
-- Reserved floor  = greatest(inventory.reserved_quantity, sum active reservations)
-- Available       = physical - reserved floor
-- Matching key    = products.sku (trim only, case-sensitive unique)
-- Apply writes    = inventory.quantity + inventory_adjustments journal
-- inventory_adjustments has NO trigger that changes quantity
-- Apply does NOT  = stock_receipts, stock_received, reserved_quantity
--                   (except init of a missing inventory row),
--                   automatic product create, Excel-driven overwrite
-- ============================================================
