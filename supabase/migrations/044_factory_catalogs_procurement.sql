-- DEKORO Platform — Stage 44
-- Migration: factory catalogs + procurement analytics snapshot
--
-- NOT applied automatically — run once in the Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–043.
--
-- Purpose:
--   1. Admin-managed factory catalogs (Белая книга / Оранжевая книга / …)
--      as a many-to-many with products. Color is a visual token, not an id.
--   2. Configurable procurement settings (lead time, safety stock, weights).
--   3. Order flag exclude_from_regular_demand for one-off project sales.
--   4. Aggregating staff_get_procurement_snapshot() — one query for stock,
--      reservations, incoming supplies, and 7/30/90-day committed sales.
--      Recommendation math lives in TypeScript (src/lib/staff/procurementMath.ts)
--      so there is a single deterministic formula + self-check.
--
-- Customer catalog / get_catalog() is intentionally untouched.
-- Excel is generated client-side from this snapshot (xlsx, already in the app).

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null
     or to_regclass('public.inventory') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
  then
    raise exception
      'products / inventory / orders missing — run 002 and 005 first.';
  end if;

  if to_regclass('public.product_supplies') is null
     or to_regclass('public.product_supply_items') is null
  then
    raise exception
      'product_supplies missing — run 036_product_supplies.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010 first.';
  end if;

  if to_regprocedure('public.staff_can_read_products()') is null then
    raise exception 'staff_can_read_products missing — run 019 first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception 'staff_resolve_warehouse_id missing — run 011/019 first.';
  end if;

  if to_regprocedure('public.staff_list_products(text, uuid, text, integer)') is null then
    raise exception 'staff_list_products missing — run 019/036 first.';
  end if;
end
$$;

-- ============================================================
-- 1. factory_catalogs
-- ============================================================

create table if not exists public.factory_catalogs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default 'slate',
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  constraint factory_catalogs_name_not_blank check (length(trim(name)) > 0),
  constraint factory_catalogs_name_len check (char_length(name) <= 80),
  constraint factory_catalogs_description_len check (
    description is null or char_length(description) <= 500
  ),
  constraint factory_catalogs_color_allowed check (
    color in (
      'white', 'orange', 'amber', 'rose', 'red',
      'teal', 'emerald', 'blue', 'indigo', 'slate', 'stone'
    )
  )
);

create unique index if not exists factory_catalogs_name_unique_idx
  on public.factory_catalogs (lower(trim(name)));

create index if not exists factory_catalogs_active_sort_idx
  on public.factory_catalogs (is_active, sort_order, name);

drop trigger if exists factory_catalogs_set_updated_at on public.factory_catalogs;
create trigger factory_catalogs_set_updated_at
  before update on public.factory_catalogs
  for each row
  execute function public.set_updated_at();

comment on table public.factory_catalogs is
  'Staff-only factory books / labels (e.g. Белая книга). Color is visual only.';

comment on column public.factory_catalogs.color is
  'Allowlisted UI token. Never a business identifier; never raw CSS.';

-- ============================================================
-- 2. product_factory_catalogs (many-to-many)
-- ============================================================

create table if not exists public.product_factory_catalogs (
  product_id uuid not null references public.products (id) on delete cascade,
  factory_catalog_id uuid not null references public.factory_catalogs (id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete restrict,
  primary key (product_id, factory_catalog_id)
);

create index if not exists product_factory_catalogs_catalog_idx
  on public.product_factory_catalogs (factory_catalog_id, product_id);

comment on table public.product_factory_catalogs is
  'A product may belong to several factory catalogs (universal SKU).';

-- ============================================================
-- 3. procurement_settings (singleton)
-- ============================================================

create table if not exists public.procurement_settings (
  id boolean primary key default true check (id),
  lead_time_days integer not null default 60,
  safety_stock_days integer not null default 14,
  velocity_weight_7 numeric(6, 4) not null default 0.5000,
  velocity_weight_30 numeric(6, 4) not null default 0.3000,
  velocity_weight_90 numeric(6, 4) not null default 0.2000,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete restrict,
  constraint procurement_settings_lead_time_range
    check (lead_time_days between 1 and 365),
  constraint procurement_settings_safety_range
    check (safety_stock_days between 0 and 180),
  constraint procurement_settings_weights_non_negative
    check (
      velocity_weight_7 >= 0
      and velocity_weight_30 >= 0
      and velocity_weight_90 >= 0
    ),
  constraint procurement_settings_weights_sum_positive
    check (velocity_weight_7 + velocity_weight_30 + velocity_weight_90 > 0)
);

drop trigger if exists procurement_settings_set_updated_at on public.procurement_settings;
create trigger procurement_settings_set_updated_at
  before update on public.procurement_settings
  for each row
  execute function public.set_updated_at();

insert into public.procurement_settings (id)
values (true)
on conflict (id) do nothing;

comment on table public.procurement_settings is
  'Singleton procurement parameters. Formula coefficients, not catalog identity.';

-- ============================================================
-- 4. One-off / project orders
-- ============================================================

alter table public.orders
  add column if not exists exclude_from_regular_demand boolean not null default false;

comment on column public.orders.exclude_from_regular_demand is
  'Admin: exclude this order from procurement velocity (one-off project). '
  'Does not affect inventory reservation. Independent from is_test.';

-- ============================================================
-- 5. RLS — RPC only, no table grants
-- ============================================================

alter table public.factory_catalogs enable row level security;
alter table public.product_factory_catalogs enable row level security;
alter table public.procurement_settings enable row level security;

revoke all on table public.factory_catalogs from public, anon, authenticated;
revoke all on table public.product_factory_catalogs from public, anon, authenticated;
revoke all on table public.procurement_settings from public, anon, authenticated;

-- ============================================================
-- 6. Indexes for the aggregating snapshot (only where the new query needs them)
-- ============================================================

create index if not exists orders_procurement_sales_idx
  on public.orders (created_at)
  where coalesce(is_test, false) = false
    and coalesce(exclude_from_regular_demand, false) = false
    and status in ('paid', 'picking', 'ready_for_shipment', 'shipped', 'completed');

-- ============================================================
-- 7. Role helpers (no GRANT — called from other DEFINER functions)
-- ============================================================

create or replace function public.staff_assert_factory_catalog_reader()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;
  if not public.has_staff_role(array['admin', 'manager', 'warehouse']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.staff_assert_factory_catalog_reader()
  from public, anon, authenticated;

create or replace function public.staff_assert_factory_catalog_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Управлять заводскими каталогами может только администратор';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.staff_assert_factory_catalog_admin()
  from public, anon, authenticated;

create or replace function public.staff_assert_procurement_reader()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;
  if not public.has_staff_role(array['admin', 'manager']::public.user_role[]) then
    raise exception 'Закупочная аналитика доступна администратору и менеджеру';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.staff_assert_procurement_reader()
  from public, anon, authenticated;

create or replace function public.staff_factory_catalogs_json(p_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'color', c.color,
        'is_active', c.is_active,
        'sort_order', c.sort_order
      )
      order by c.sort_order, c.name
    ),
    '[]'::jsonb
  )
  from public.product_factory_catalogs as m
  join public.factory_catalogs as c on c.id = m.factory_catalog_id
  where m.product_id = p_product_id
    and c.is_active;
$$;

revoke all on function public.staff_factory_catalogs_json(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 8. Catalog CRUD
-- ============================================================

create or replace function public.staff_list_factory_catalogs(
  p_include_inactive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  perform public.staff_assert_factory_catalog_reader();

  select coalesce(
    jsonb_agg(row_to_json(x)::jsonb order by x.sort_order, x.name),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      c.id,
      c.name,
      c.color,
      c.description,
      c.is_active,
      c.sort_order,
      c.created_at,
      c.updated_at,
      (
        select count(*)::integer
        from public.product_factory_catalogs as m
        where m.factory_catalog_id = c.id
      ) as products_count
    from public.factory_catalogs as c
    where p_include_inactive or c.is_active
  ) as x;

  return v_rows;
end;
$$;

revoke all on function public.staff_list_factory_catalogs(boolean)
  from public, anon, authenticated;
grant execute on function public.staff_list_factory_catalogs(boolean)
  to authenticated;

create or replace function public.staff_create_factory_catalog(
  p_name text,
  p_color text,
  p_description text default null,
  p_sort_order integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_name text := nullif(trim(p_name), '');
  v_color text := lower(trim(coalesce(p_color, '')));
  v_row public.factory_catalogs;
begin
  v_uid := public.staff_assert_factory_catalog_admin();

  if v_name is null then
    raise exception 'Название каталога обязательно';
  end if;
  if v_color is null or v_color = '' then
    v_color := 'slate';
  end if;

  insert into public.factory_catalogs (
    name, color, description, sort_order, created_by
  )
  values (
    v_name,
    v_color,
    nullif(trim(p_description), ''),
    coalesce(p_sort_order, 0),
    v_uid
  )
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'color', v_row.color,
    'description', v_row.description,
    'is_active', v_row.is_active,
    'sort_order', v_row.sort_order,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at,
    'products_count', 0
  );
end;
$$;

revoke all on function public.staff_create_factory_catalog(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_create_factory_catalog(text, text, text, integer)
  to authenticated;

create or replace function public.staff_update_factory_catalog(
  p_id uuid,
  p_name text,
  p_color text,
  p_description text default null,
  p_sort_order integer default null,
  p_is_active boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := nullif(trim(p_name), '');
  v_color text := lower(trim(coalesce(p_color, '')));
  v_row public.factory_catalogs;
  v_count integer;
begin
  perform public.staff_assert_factory_catalog_admin();

  if p_id is null then
    raise exception 'id каталога обязателен';
  end if;
  if v_name is null then
    raise exception 'Название каталога обязательно';
  end if;
  if v_color is null or v_color = '' then
    v_color := 'slate';
  end if;

  update public.factory_catalogs
  set
    name = v_name,
    color = v_color,
    description = nullif(trim(p_description), ''),
    sort_order = coalesce(p_sort_order, sort_order),
    is_active = coalesce(p_is_active, is_active)
  where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'Каталог не найден';
  end if;

  select count(*) into v_count
  from public.product_factory_catalogs
  where factory_catalog_id = v_row.id;

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'color', v_row.color,
    'description', v_row.description,
    'is_active', v_row.is_active,
    'sort_order', v_row.sort_order,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at,
    'products_count', v_count
  );
end;
$$;

revoke all on function public.staff_update_factory_catalog(uuid, text, text, text, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_update_factory_catalog(uuid, text, text, text, integer, boolean)
  to authenticated;

create or replace function public.staff_archive_factory_catalog(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.factory_catalogs;
begin
  select * into v_row from public.factory_catalogs where id = p_id;
  if not found then
    raise exception 'Каталог не найден';
  end if;
  return public.staff_update_factory_catalog(
    p_id,
    v_row.name,
    v_row.color,
    v_row.description,
    v_row.sort_order,
    false
  );
end;
$$;

revoke all on function public.staff_archive_factory_catalog(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_archive_factory_catalog(uuid)
  to authenticated;

-- ============================================================
-- 9. Product assignment
-- ============================================================

create or replace function public.staff_set_product_factory_catalogs(
  p_product_id uuid,
  p_catalog_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_ids uuid[];
  v_missing integer;
begin
  v_uid := public.staff_assert_factory_catalog_admin();

  if p_product_id is null or not exists (
    select 1 from public.products as p where p.id = p_product_id
  ) then
    raise exception 'Товар не найден';
  end if;

  select coalesce(array_agg(distinct cid), array[]::uuid[])
  into v_ids
  from unnest(coalesce(p_catalog_ids, array[]::uuid[])) as cid
  where cid is not null;

  if cardinality(v_ids) > 0 then
    select count(*) into v_missing
    from unnest(v_ids) as cid
    where not exists (
      select 1 from public.factory_catalogs as c
      where c.id = cid and c.is_active
    );
    if v_missing > 0 then
      raise exception 'Один или несколько каталогов не найдены или архивированы';
    end if;
  end if;

  delete from public.product_factory_catalogs
  where product_id = p_product_id
    and (
      cardinality(v_ids) = 0
      or factory_catalog_id <> all (v_ids)
    );

  if cardinality(v_ids) > 0 then
    insert into public.product_factory_catalogs (
      product_id, factory_catalog_id, created_by
    )
    select p_product_id, cid, v_uid
    from unnest(v_ids) as cid
    on conflict (product_id, factory_catalog_id) do nothing;
  end if;

  return public.staff_factory_catalogs_json(p_product_id);
end;
$$;

revoke all on function public.staff_set_product_factory_catalogs(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.staff_set_product_factory_catalogs(uuid, uuid[])
  to authenticated;

create or replace function public.staff_bulk_assign_factory_catalogs(
  p_product_ids uuid[],
  p_catalog_ids uuid[],
  p_mode text default 'add'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_products uuid[];
  v_catalogs uuid[];
  v_mode text := lower(coalesce(nullif(trim(p_mode), ''), 'add'));
  v_missing integer;
  v_assigned integer := 0;
begin
  v_uid := public.staff_assert_factory_catalog_admin();

  if v_mode not in ('add', 'replace') then
    raise exception 'Режим: add или replace';
  end if;

  select coalesce(array_agg(distinct pid), array[]::uuid[])
  into v_products
  from unnest(coalesce(p_product_ids, array[]::uuid[])) as pid
  where pid is not null;

  select coalesce(array_agg(distinct cid), array[]::uuid[])
  into v_catalogs
  from unnest(coalesce(p_catalog_ids, array[]::uuid[])) as cid
  where cid is not null;

  if cardinality(v_products) = 0 then
    raise exception 'Не указаны товары';
  end if;
  if cardinality(v_products) > 500 then
    raise exception 'Слишком много товаров (максимум 500 за один запрос)';
  end if;
  if v_mode = 'add' and cardinality(v_catalogs) = 0 then
    raise exception 'Выберите хотя бы один каталог';
  end if;

  select count(*) into v_missing
  from unnest(v_products) as pid
  where not exists (select 1 from public.products as p where p.id = pid);
  if v_missing > 0 then
    raise exception 'Один или несколько товаров не найдены';
  end if;

  if cardinality(v_catalogs) > 0 then
    select count(*) into v_missing
    from unnest(v_catalogs) as cid
    where not exists (
      select 1 from public.factory_catalogs as c
      where c.id = cid and c.is_active
    );
    if v_missing > 0 then
      raise exception 'Один или несколько каталогов не найдены или архивированы';
    end if;
  end if;

  if v_mode = 'replace' then
    delete from public.product_factory_catalogs
    where product_id = any (v_products);
  end if;

  if cardinality(v_catalogs) > 0 then
    insert into public.product_factory_catalogs (
      product_id, factory_catalog_id, created_by
    )
    select pid, cid, v_uid
    from unnest(v_products) as pid
    cross join unnest(v_catalogs) as cid
    on conflict (product_id, factory_catalog_id) do nothing;

    get diagnostics v_assigned = row_count;
  end if;

  return jsonb_build_object(
    'mode', v_mode,
    'products', cardinality(v_products),
    'catalogs', cardinality(v_catalogs),
    'rows_inserted', v_assigned
  );
end;
$$;

revoke all on function public.staff_bulk_assign_factory_catalogs(uuid[], uuid[], text)
  from public, anon, authenticated;
grant execute on function public.staff_bulk_assign_factory_catalogs(uuid[], uuid[], text)
  to authenticated;

-- ============================================================
-- 10. staff_list_products — catalogs + filter
-- Changing RETURNS TABLE requires DROP of the 4-arg version (036).
-- ============================================================

drop function if exists public.staff_list_products(text, uuid, text, integer);
drop function if exists public.staff_list_products(text, uuid, text, integer, uuid);
drop function if exists public.staff_list_products(text, uuid, text, integer, uuid, boolean);

create function public.staff_list_products(
  p_query text default null,
  p_category_id uuid default null,
  p_status text default null,
  p_limit integer default 100,
  p_factory_catalog_id uuid default null,
  p_unassigned_only boolean default false
)
returns table (
  id uuid,
  sku text,
  name text,
  category_id uuid,
  category_name text,
  subcategory_id uuid,
  subcategory_name text,
  unit text,
  base_price numeric,
  min_order_qty numeric,
  status public.product_status,
  main_photo_path text,
  available_quantity numeric,
  created_at timestamptz,
  updated_at timestamptz,
  factory_catalogs jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_term text;
  v_status public.product_status;
  v_warehouse_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_read_products() then
    raise exception 'Недостаточно прав для просмотра товаров';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  if nullif(trim(p_status), '') is not null then
    begin
      v_status := trim(p_status)::public.product_status;
    exception
      when invalid_text_representation then
        raise exception 'Некорректный статус товара';
    end;
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  return query
  select
    p.id,
    p.sku,
    p.name,
    p.category_id,
    cat.name as category_name,
    p.subcategory_id,
    sub.name as subcategory_name,
    p.unit,
    p.base_price,
    p.min_order_qty,
    p.status,
    p.main_photo_path,
    greatest(
      coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0),
      0
    ) as available_quantity,
    p.created_at,
    p.updated_at,
    public.staff_factory_catalogs_json(p.id) as factory_catalogs
  from public.products as p
  left join public.categories as cat on cat.id = p.category_id
  left join public.categories as sub on sub.id = p.subcategory_id
  left join public.inventory as i
    on i.product_id = p.id and i.warehouse_id = v_warehouse_id
  where (v_status is null or p.status = v_status)
    and (
      p_category_id is null
      or p.category_id = p_category_id
      or p.subcategory_id = p_category_id
    )
    and (
      v_term is null
      or p.sku ilike ('%' || v_term || '%') escape '\'
      or p.name ilike ('%' || v_term || '%') escape '\'
      or coalesce(p.original_sku, '') ilike ('%' || v_term || '%') escape '\'
    )
    and (
      coalesce(p_unassigned_only, false) = false
      or not exists (
        select 1
        from public.product_factory_catalogs as m
        join public.factory_catalogs as fc on fc.id = m.factory_catalog_id
        where m.product_id = p.id and fc.is_active
      )
    )
    and (
      p_factory_catalog_id is null
      or exists (
        select 1
        from public.product_factory_catalogs as m
        where m.product_id = p.id
          and m.factory_catalog_id = p_factory_catalog_id
      )
    )
  order by p.updated_at desc, p.name
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_products(text, uuid, text, integer, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_list_products(text, uuid, text, integer, uuid, boolean)
  to authenticated;

-- ============================================================
-- 11. staff_get_product — add factory_catalogs
-- ============================================================

create or replace function public.staff_get_product(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_warehouse_id uuid;
  v_row jsonb;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_read_products() then
    raise exception 'Недостаточно прав для просмотра товаров';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select jsonb_build_object(
    'id', p.id,
    'sku', p.sku,
    'name', p.name,
    'slug', p.slug,
    'category_id', p.category_id,
    'category_name', cat.name,
    'subcategory_id', p.subcategory_id,
    'subcategory_name', sub.name,
    'status', p.status,
    'unit', p.unit,
    'base_price', p.base_price,
    'min_order_qty', p.min_order_qty,
    'length_mm', p.length_mm,
    'width_mm', p.width_mm,
    'thickness_mm', p.thickness_mm,
    'weight_kg', p.weight_kg,
    'dimensions', p.dimensions,
    'main_photo_path', p.main_photo_path,
    'available_quantity', greatest(
      coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0),
      0
    ),
    'physical_quantity', coalesce(i.quantity, 0),
    'reserved_quantity', coalesce(i.reserved_quantity, 0),
    'created_at', p.created_at,
    'updated_at', p.updated_at,
    'factory_catalogs', public.staff_factory_catalogs_json(p.id)
  )
  into v_row
  from public.products as p
  left join public.categories as cat on cat.id = p.category_id
  left join public.categories as sub on sub.id = p.subcategory_id
  left join public.inventory as i
    on i.product_id = p.id and i.warehouse_id = v_warehouse_id
  where p.id = p_product_id;

  if v_row is null then
    raise exception 'Товар не найден';
  end if;

  return v_row;
end;
$$;

revoke all on function public.staff_get_product(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_product(uuid)
  to authenticated;

-- ============================================================
-- 12. staff_search_products — markers for order creation
-- ============================================================

drop function if exists public.staff_search_products(text, integer, uuid);

create function public.staff_search_products(
  p_query text default null,
  p_limit integer default 50,
  p_customer_id uuid default null
)
returns table (
  product_id uuid,
  name text,
  sku text,
  category text,
  unit text,
  price numeric,
  warehouse_id uuid,
  warehouse_name text,
  physical_quantity numeric,
  reserved_quantity numeric,
  available_quantity numeric,
  factory_catalogs jsonb
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer;
  v_term text;
  v_warehouse_id uuid;
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для поиска товаров';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 50);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  return query
  select
    p.id as product_id,
    p.name,
    p.sku,
    cat.name as category,
    p.unit,
    public.staff_resolve_price(p.id, p_customer_id) as price,
    v_warehouse_id as warehouse_id,
    w.name as warehouse_name,
    coalesce(i.quantity, 0) as physical_quantity,
    coalesce(i.reserved_quantity, 0) as reserved_quantity,
    public.staff_assert_non_negative_stock(
      coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0),
      p.name
    ) as available_quantity,
    public.staff_factory_catalogs_json(p.id) as factory_catalogs
  from public.products as p
  left join public.categories as cat on cat.id = p.category_id
  left join public.inventory as i
    on i.product_id = p.id and i.warehouse_id = v_warehouse_id
  left join public.warehouses as w on w.id = v_warehouse_id
  where p.status = 'active'
    and (
      v_term is null
      or p.name ilike ('%' || v_term || '%') escape '\'
      or p.sku ilike ('%' || v_term || '%') escape '\'
      or p.original_sku ilike ('%' || v_term || '%') escape '\'
    )
  order by p.name
  limit v_limit;
end;
$$;

revoke all on function public.staff_search_products(text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_search_products(text, integer, uuid)
  to authenticated;

-- ============================================================
-- 13. staff_search_products_for_supply — jsonb, add catalogs
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
        'subcategory_name', sub.name,
        'factory_catalogs', public.staff_factory_catalogs_json(p.id)
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

revoke all on function public.staff_search_products_for_supply(text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_search_products_for_supply(text, integer)
  to authenticated;

-- ============================================================
-- 14. Procurement settings + snapshot
-- ============================================================

create or replace function public.staff_get_procurement_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.procurement_settings;
begin
  perform public.staff_assert_procurement_reader();

  select * into v_row from public.procurement_settings where id = true;
  if not found then
    insert into public.procurement_settings (id) values (true)
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'lead_time_days', v_row.lead_time_days,
    'safety_stock_days', v_row.safety_stock_days,
    'velocity_weight_7', v_row.velocity_weight_7,
    'velocity_weight_30', v_row.velocity_weight_30,
    'velocity_weight_90', v_row.velocity_weight_90,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.staff_get_procurement_settings()
  from public, anon, authenticated;
grant execute on function public.staff_get_procurement_settings()
  to authenticated;

create or replace function public.staff_update_procurement_settings(
  p_lead_time_days integer,
  p_safety_stock_days integer,
  p_velocity_weight_7 numeric,
  p_velocity_weight_30 numeric,
  p_velocity_weight_90 numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_row public.procurement_settings;
begin
  v_uid := public.staff_assert_factory_catalog_admin();

  update public.procurement_settings
  set
    lead_time_days = p_lead_time_days,
    safety_stock_days = p_safety_stock_days,
    velocity_weight_7 = p_velocity_weight_7,
    velocity_weight_30 = p_velocity_weight_30,
    velocity_weight_90 = p_velocity_weight_90,
    updated_by = v_uid
  where id = true
  returning * into v_row;

  if not found then
    insert into public.procurement_settings (
      id, lead_time_days, safety_stock_days,
      velocity_weight_7, velocity_weight_30, velocity_weight_90, updated_by
    )
    values (
      true, p_lead_time_days, p_safety_stock_days,
      p_velocity_weight_7, p_velocity_weight_30, p_velocity_weight_90, v_uid
    )
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'lead_time_days', v_row.lead_time_days,
    'safety_stock_days', v_row.safety_stock_days,
    'velocity_weight_7', v_row.velocity_weight_7,
    'velocity_weight_30', v_row.velocity_weight_30,
    'velocity_weight_90', v_row.velocity_weight_90,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.staff_update_procurement_settings(integer, integer, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.staff_update_procurement_settings(integer, integer, numeric, numeric, numeric)
  to authenticated;

create or replace function public.staff_set_order_exclude_from_regular_demand(
  p_order_id uuid,
  p_exclude boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exclude boolean := coalesce(p_exclude, false);
begin
  perform public.staff_assert_factory_catalog_admin();

  update public.orders
  set exclude_from_regular_demand = v_exclude
  where id = p_order_id;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  return v_exclude;
end;
$$;

revoke all on function public.staff_set_order_exclude_from_regular_demand(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_set_order_exclude_from_regular_demand(uuid, boolean)
  to authenticated;

create or replace function public.staff_procurement_logistics_label(
  p_status public.product_supply_logistics_status
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_status
    when 'ordered' then 'Заказ заводу'
    when 'in_production' then 'В производстве'
    when 'ready_at_factory' then 'Готово на заводе'
    when 'to_khorgos' then 'На Хоргос'
    when 'khorgos_queue' then 'Очередь Хоргос'
    when 'khorgos_customs' then 'Таможня Хоргос'
    when 'to_almaty' then 'Хоргос → Алматы'
    when 'arrived_almaty' then 'Прибыло в Алматы'
    when 'completed' then 'Завершено'
    else 'Черновик'
  end;
$$;

revoke all on function public.staff_procurement_logistics_label(public.product_supply_logistics_status)
  from public, anon, authenticated;

create or replace function public.staff_get_procurement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings jsonb;
  v_warehouse_id uuid;
  v_tz text := 'Asia/Almaty';
  v_today date;
  v_from_7 date;
  v_from_30 date;
  v_from_90 date;
  v_ts_7 timestamptz;
  v_ts_30 timestamptz;
  v_ts_90 timestamptz;
  v_ts_end timestamptz;
  v_products jsonb;
  v_catalogs jsonb;
begin
  perform public.staff_assert_procurement_reader();

  v_settings := public.staff_get_procurement_settings();
  v_warehouse_id := public.staff_resolve_warehouse_id();
  v_today := (timezone(v_tz, now()))::date;
  v_from_7 := v_today - 6;
  v_from_30 := v_today - 29;
  v_from_90 := v_today - 89;
  v_ts_7 := (v_from_7::timestamp at time zone v_tz);
  v_ts_30 := (v_from_30::timestamp at time zone v_tz);
  v_ts_90 := (v_from_90::timestamp at time zone v_tz);
  v_ts_end := ((v_today + 1)::timestamp at time zone v_tz);

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sort_order, x.name), '[]'::jsonb)
  into v_catalogs
  from (
    select id, name, color, description, is_active, sort_order
    from public.factory_catalogs
    where is_active
    order by sort_order, name
  ) as x;

  with stock as (
    select
      p.id as product_id,
      coalesce(i.quantity, 0)::numeric(14, 3) as physical_qty,
      coalesce(i.reserved_quantity, 0)::numeric(14, 3) as reserved_qty,
      greatest(coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0), 0)::numeric(14, 3)
        as available_qty
    from public.products as p
    left join public.inventory as i
      on i.product_id = p.id and i.warehouse_id = v_warehouse_id
    where p.status is distinct from 'archived'
  ),
  sales as (
    select
      oi.product_id,
      coalesce(sum(oi.quantity) filter (
        where o.created_at >= v_ts_7 and o.created_at < v_ts_end
      ), 0)::numeric(14, 3) as sales_7,
      coalesce(sum(oi.quantity) filter (
        where o.created_at >= v_ts_30 and o.created_at < v_ts_end
      ), 0)::numeric(14, 3) as sales_30,
      coalesce(sum(oi.quantity) filter (
        where o.created_at >= v_ts_90 and o.created_at < v_ts_end
      ), 0)::numeric(14, 3) as sales_90,
      min(o.created_at) as first_committed_sale_at
    from public.order_items as oi
    join public.orders as o on o.id = oi.order_id
    where coalesce(o.is_test, false) = false
      and coalesce(o.exclude_from_regular_demand, false) = false
      and o.status in (
        'paid', 'picking', 'ready_for_shipment', 'shipped', 'completed'
      )
      and o.created_at >= v_ts_90
      and o.created_at < v_ts_end
    group by oi.product_id
  ),
  first_sale as (
    select
      oi.product_id,
      min(o.created_at) as first_committed_sale_at
    from public.order_items as oi
    join public.orders as o on o.id = oi.order_id
    where coalesce(o.is_test, false) = false
      and coalesce(o.exclude_from_regular_demand, false) = false
      and o.status in (
        'paid', 'picking', 'ready_for_shipment', 'shipped', 'completed'
      )
    group by oi.product_id
  ),
  incoming as (
    select
      si.product_id,
      coalesce(sum(
        case
          when si.shipped_quantity is not null then si.shipped_quantity
          when si.ordered_quantity is not null then si.ordered_quantity
          else si.quantity
        end
      ), 0)::numeric(14, 3) as incoming_qty,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'supply_id', s.id,
            'supply_number', s.supply_number,
            'logistics_status', s.logistics_status,
            'quantity',
              case
                when si.shipped_quantity is not null then si.shipped_quantity
                when si.ordered_quantity is not null then si.ordered_quantity
                else si.quantity
              end,
            'label',
              s.supply_number
              || ' — '
              || trim(to_char(
                case
                  when si.shipped_quantity is not null then si.shipped_quantity
                  when si.ordered_quantity is not null then si.ordered_quantity
                  else si.quantity
                end,
                'FM999999990.###'
              ))
              || ' шт. — '
              || public.staff_procurement_logistics_label(s.logistics_status)
          )
          order by s.supply_date desc, s.supply_number
        ),
        '[]'::jsonb
      ) as incoming_breakdown
    from public.product_supply_items as si
    join public.product_supplies as s on s.id = si.supply_id
    where s.receiving_status is distinct from 'completed'
      and s.logistics_status is distinct from 'draft'
    group by si.product_id
  ),
  catalog_map as (
    select
      m.product_id,
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'color', c.color,
          'is_active', c.is_active,
          'sort_order', c.sort_order
        )
        order by c.sort_order, c.name
      ) as catalogs
    from public.product_factory_catalogs as m
    join public.factory_catalogs as c on c.id = m.factory_catalog_id
    where c.is_active
    group by m.product_id
  )
  select coalesce(jsonb_agg(row_to_json(r)::jsonb order by r.sku), '[]'::jsonb)
  into v_products
  from (
    select
      p.id as product_id,
      p.sku,
      p.original_sku,
      p.name,
      p.dimensions,
      p.unit,
      p.weight_kg,
      p.min_order_qty,
      p.status,
      p.created_at,
      st.physical_qty,
      st.reserved_qty,
      st.available_qty,
      coalesce(sa.sales_7, 0) as sales_7,
      coalesce(sa.sales_30, 0) as sales_30,
      coalesce(sa.sales_90, 0) as sales_90,
      fs.first_committed_sale_at,
      coalesce(inc.incoming_qty, 0) as incoming_qty,
      coalesce(inc.incoming_breakdown, '[]'::jsonb) as incoming_breakdown,
      coalesce(cm.catalogs, '[]'::jsonb) as catalogs
    from public.products as p
    join stock as st on st.product_id = p.id
    left join sales as sa on sa.product_id = p.id
    left join first_sale as fs on fs.product_id = p.id
    left join incoming as inc on inc.product_id = p.id
    left join catalog_map as cm on cm.product_id = p.id
    where p.status is distinct from 'archived'
  ) as r;

  return jsonb_build_object(
    'generated_at', now(),
    'timezone', v_tz,
    'period', jsonb_build_object(
      'today', v_today,
      'sales_7_from', v_from_7,
      'sales_30_from', v_from_30,
      'sales_90_from', v_from_90
    ),
    'settings', v_settings,
    'catalogs', v_catalogs,
    'products', coalesce(v_products, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.staff_get_procurement_snapshot()
  from public, anon, authenticated;
grant execute on function public.staff_get_procurement_snapshot()
  to authenticated;

comment on function public.staff_get_procurement_snapshot() is
  'Stage 44: one aggregating snapshot for procurement analytics. '
  'Admin + manager only. Recommendation math is applied in TypeScript.';
