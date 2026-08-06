-- ============================================================
-- 020_product_inventory_and_catalog_images.sql
-- Stage 20 — Staff inventory adjustments + client catalog photos
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–019 files.
-- Does NOT modify organization-assets / document snapshots.
--
-- 1) inventory_adjustments + staff RPCs (ALMATY-01 only)
-- 2) product-images bucket → public (read); writes stay admin-only
-- 3) get_catalog() prefers products.main_photo_path
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

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception
      'staff_resolve_warehouse_id missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.get_catalog()') is null then
    raise exception 'get_catalog missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'main_photo_path'
  ) then
    raise exception
      'products.main_photo_path missing — run 019_product_management.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. inventory_adjustments
-- ============================================================

-- Quantities match public.inventory: numeric(14, 3). No integer truncation.
create table if not exists public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  inventory_id uuid not null references public.inventory (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  previous_quantity numeric(14, 3) not null,
  new_quantity numeric(14, 3) not null,
  difference numeric(14, 3) not null,
  reason text not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint inventory_adjustments_previous_non_negative check (previous_quantity >= 0),
  constraint inventory_adjustments_new_non_negative check (new_quantity >= 0),
  constraint inventory_adjustments_difference_matches check (
    difference = new_quantity - previous_quantity
  ),
  constraint inventory_adjustments_reason_not_blank check (
    length(trim(reason)) > 0
  ),
  constraint inventory_adjustments_reason_max_len check (
    char_length(trim(reason)) <= 500
  )
);

create index if not exists inventory_adjustments_product_id_created_at_idx
  on public.inventory_adjustments (product_id, created_at desc);

create index if not exists inventory_adjustments_inventory_id_idx
  on public.inventory_adjustments (inventory_id);

-- If a partial earlier draft created integer columns, widen to inventory scale.
alter table public.inventory_adjustments
  alter column previous_quantity type numeric(14, 3)
  using previous_quantity::numeric(14, 3);

alter table public.inventory_adjustments
  alter column new_quantity type numeric(14, 3)
  using new_quantity::numeric(14, 3);

alter table public.inventory_adjustments
  alter column difference type numeric(14, 3)
  using difference::numeric(14, 3);

comment on table public.inventory_adjustments is
  'Manual stock corrections by admin (not used for order ship/reserve).';

alter table public.inventory_adjustments enable row level security;

revoke all on table public.inventory_adjustments from public;
revoke all on table public.inventory_adjustments from anon;
revoke all on table public.inventory_adjustments from authenticated;

-- ============================================================
-- 2. Inventory RPCs
-- ============================================================

create or replace function public.staff_get_product_inventory(p_product_id uuid)
returns table (
  inventory_id uuid,
  product_id uuid,
  warehouse_id uuid,
  warehouse_code text,
  quantity numeric,
  reserved_quantity numeric,
  available_quantity numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_warehouse_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра остатка';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  if not exists (
    select 1 from public.products as p where p.id = p_product_id
  ) then
    raise exception 'Товар не найден';
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  return query
  select
    i.id as inventory_id,
    p_product_id as product_id,
    v_warehouse_id as warehouse_id,
    w.code as warehouse_code,
    coalesce(i.quantity, 0) as quantity,
    coalesce(i.reserved_quantity, 0) as reserved_quantity,
    greatest(coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0), 0)
      as available_quantity
  from public.warehouses as w
  left join public.inventory as i
    on i.product_id = p_product_id
   and i.warehouse_id = w.id
  where w.id = v_warehouse_id;
end;
$$;

revoke all on function public.staff_get_product_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_product_inventory(uuid)
  to authenticated;

-- Drop possible draft overloads from a partial earlier apply of 020.
drop function if exists public.staff_adjust_product_inventory(uuid, integer, text);
drop function if exists public.staff_adjust_product_inventory(uuid, numeric, text);

create or replace function public.staff_adjust_product_inventory(
  p_product_id uuid,
  p_new_quantity numeric,
  p_reason text
)
returns table (
  inventory_id uuid,
  product_id uuid,
  warehouse_id uuid,
  warehouse_code text,
  quantity numeric,
  reserved_quantity numeric,
  available_quantity numeric,
  adjusted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_warehouse_id uuid;
  v_warehouse_code text;
  v_product public.products;
  v_inv public.inventory;
  v_reason text := nullif(trim(p_reason), '');
  -- Same scale as public.inventory.quantity / reserved_quantity (numeric(14,3)).
  v_prev numeric(14, 3);
  v_new numeric(14, 3);
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Только администратор может изменять остаток';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  if p_new_quantity is null then
    raise exception 'Новое количество обязательно';
  end if;

  if p_new_quantity < 0 then
    raise exception 'Фактический остаток не может быть отрицательным';
  end if;

  if v_reason is null then
    raise exception 'Причина корректировки обязательна';
  end if;

  if char_length(v_reason) > 500 then
    raise exception 'Причина не длиннее 500 символов';
  end if;

  -- Cast to inventory scale (14,3). No trunc/floor/integer conversion.
  v_new := p_new_quantity;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select w.code into v_warehouse_code
  from public.warehouses as w
  where w.id = v_warehouse_id;

  select * into v_product
  from public.products as p
  where p.id = p_product_id
  for update;

  if not found then
    raise exception 'Товар не найден';
  end if;

  select * into v_inv
  from public.inventory as i
  where i.product_id = p_product_id
    and i.warehouse_id = v_warehouse_id
  for update;

  if not found then
    insert into public.inventory (
      product_id,
      warehouse_id,
      quantity,
      reserved_quantity
    ) values (
      p_product_id,
      v_warehouse_id,
      0,
      0
    )
    returning * into v_inv;

    -- Re-lock the newly inserted row for consistency with FOR UPDATE path.
    select * into v_inv
    from public.inventory as i
    where i.id = v_inv.id
    for update;
  end if;

  v_prev := v_inv.quantity;

  if v_new < v_inv.reserved_quantity then
    raise exception
      'Фактический остаток (%) не может быть меньше количества в резерве (%)',
      v_new,
      v_inv.reserved_quantity;
  end if;

  -- Same quantity (at inventory scale): no false adjustment row.
  if v_new is not distinct from v_prev then
    return query
    select
      v_inv.id,
      v_inv.product_id,
      v_inv.warehouse_id,
      v_warehouse_code,
      v_inv.quantity,
      v_inv.reserved_quantity,
      greatest(v_inv.quantity - v_inv.reserved_quantity, 0),
      false;
    return;
  end if;

  update public.inventory as i
  set
    quantity = v_new,
    updated_at = now()
  where i.id = v_inv.id
  returning * into v_inv;

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
  );

  return query
  select
    v_inv.id,
    v_inv.product_id,
    v_inv.warehouse_id,
    v_warehouse_code,
    v_inv.quantity,
    v_inv.reserved_quantity,
    greatest(v_inv.quantity - v_inv.reserved_quantity, 0),
    true;
end;
$$;

revoke all on function public.staff_adjust_product_inventory(uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.staff_adjust_product_inventory(uuid, numeric, text)
  to authenticated;

-- RETURNS TABLE OUT types may differ from an earlier draft — drop first.
drop function if exists public.staff_list_product_inventory_adjustments(uuid, integer);

create or replace function public.staff_list_product_inventory_adjustments(
  p_product_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  inventory_id uuid,
  product_id uuid,
  warehouse_id uuid,
  previous_quantity numeric,
  new_quantity numeric,
  difference numeric,
  reason text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра истории остатков';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  return query
  select
    a.id,
    a.inventory_id,
    a.product_id,
    a.warehouse_id,
    a.previous_quantity,
    a.new_quantity,
    a.difference,
    a.reason,
    a.created_by,
    pr.full_name as created_by_name,
    a.created_at
  from public.inventory_adjustments as a
  left join public.profiles as pr on pr.id = a.created_by
  where a.product_id = p_product_id
  order by a.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_product_inventory_adjustments(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_product_inventory_adjustments(uuid, integer)
  to authenticated;

-- ============================================================
-- 3. Storage: product-images → public read, admin write
-- ============================================================
-- Catalog photos are not confidential. Public bucket allows getPublicUrl
-- for anon/client without staff helpers or N+1 signed URLs.
-- organization-assets / doc-snapshots are intentionally untouched.

update storage.buckets
set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']::text[]
where id = 'product-images';

-- Replace staff-only SELECT with public read for this bucket only.
drop policy if exists product_images_select_staff on storage.objects;
drop policy if exists product_images_select_public on storage.objects;

create policy product_images_select_public
  on storage.objects
  for select
  to anon, authenticated
  using (
    bucket_id = 'product-images'
    and name ~
      (
        '^products/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || 'main\.(png|jpe?g|webp)$'
      )
  );

-- Keep admin-only write policies (recreate if missing after 019).
drop policy if exists product_images_insert_admin on storage.objects;
drop policy if exists product_images_update_admin on storage.objects;
drop policy if exists product_images_delete_admin on storage.objects;

create policy product_images_insert_admin
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'product-images'
    and (select public.staff_can_manage_products())
    and name ~
      (
        '^products/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || 'main\.(png|jpe?g|webp)$'
      )
  );

create policy product_images_update_admin
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'product-images'
    and (select public.staff_can_manage_products())
    and name ~
      (
        '^products/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || 'main\.(png|jpe?g|webp)$'
      )
  )
  with check (
    bucket_id = 'product-images'
    and (select public.staff_can_manage_products())
    and name ~
      (
        '^products/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || 'main\.(png|jpe?g|webp)$'
      )
  );

create policy product_images_delete_admin
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'product-images'
    and (select public.staff_can_manage_products())
    and name ~
      (
        '^products/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || 'main\.(png|jpe?g|webp)$'
      )
  );

-- ============================================================
-- 4. get_catalog — prefer main_photo_path, fallback product_images
-- ============================================================
-- Returns storage path (products/{id}/main.ext) or legacy absolute URL.
-- Also returns products.updated_at for client cache-busting (?v=...) when
-- the same Storage path is overwritten (no infinite versioned filenames).
-- Client builds public URL for paths; no per-card Storage round-trip in SQL.
--
-- CREATE OR REPLACE cannot change RETURNS TABLE (42P13). Drop the zero-arg
-- signature from 002 first — no CASCADE.

drop function if exists public.get_catalog();

create function public.get_catalog()
returns table (
  product_id uuid,
  name text,
  sku text,
  original_sku text,
  category text,
  dimensions text,
  unit text,
  available_stock numeric,
  sale_price numeric,
  image text,
  is_promotion boolean,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  return query
  select
    p.id as product_id,
    p.name,
    p.sku,
    p.original_sku,
    c.name as category,
    p.dimensions,
    p.unit,
    coalesce(stock.available_stock, 0) as available_stock,
    public.get_product_price(p.id) as sale_price,
    coalesce(
      nullif(trim(p.main_photo_path), ''),
      img.image_url
    ) as image,
    p.is_promotion,
    p.updated_at
  from public.products as p
  left join public.categories as c
    on c.id = p.category_id and c.is_active
  left join lateral (
    select sum(pa.available_quantity) as available_stock
    from public.product_availability as pa
    join public.warehouses as w
      on w.id = pa.warehouse_id and w.is_active
    where pa.product_id = p.id
  ) stock on true
  left join lateral (
    select pi.image_url
    from public.product_images as pi
    where pi.product_id = p.id and pi.is_primary
    order by pi.sort_order
    limit 1
  ) img on true
  where p.status = 'active'
  order by p.created_at;
end;
$$;

revoke all on function public.get_catalog() from public;
revoke all on function public.get_catalog() from anon;
revoke all on function public.get_catalog() from authenticated;
grant execute on function public.get_catalog() to anon, authenticated;

-- ============================================================
-- Notes
-- ============================================================
-- - Inventory adjust uses numeric(14,3) — same as inventory.quantity.
-- - reserved_quantity is never written by staff_adjust_product_inventory.
-- - Order reserve/ship continues via existing 008/012 workflow.
--   Note: order_items.quantity is integer (005); create_order validates
--   positive integers (008). That limits order lines to whole units, but
--   does not truncate warehouse inventory.quantity.
-- - product-images is public for READ only; writes require admin policies.
-- - organization-assets / document snapshots remain private (untouched).
-- ============================================================
