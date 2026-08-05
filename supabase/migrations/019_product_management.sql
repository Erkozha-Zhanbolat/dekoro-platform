-- ============================================================
-- 019_product_management.sql
-- Stage 19 — Product Management (staff catalog CRUD)
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–018 files.
--
-- Extends:
--   public.categories  (+ parent_id for subcategory hierarchy)
--   public.products    (+ sales/specs/photo fields)
-- Adds:
--   Storage bucket product-images (private, path-only in DB)
--   Staff RPCs for products + categories
--
-- Roles:
--   Admin     — full write (create/update/copy/archive/photo/categories)
--   Manager   — read-only
--   Warehouse — read-only
--   Client    — no access to these RPCs
-- ============================================================

-- Guarantees from prior stages
do $$
begin
  if to_regclass('public.products') is null
     or to_regclass('public.categories') is null
     or to_regclass('public.inventory') is null
  then
    raise exception
      'Catalog tables missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_escape_ilike_term(text)') is null then
    raise exception
      'staff_escape_ilike_term missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception
      'staff_resolve_warehouse_id missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'set_updated_at missing — run 001 first.';
  end if;
end
$$;

-- ============================================================
-- 1. categories — subcategory hierarchy (2 levels)
-- ============================================================

alter table public.categories
  add column if not exists parent_id uuid references public.categories (id) on delete restrict;

create index if not exists categories_parent_id_idx
  on public.categories (parent_id);

comment on column public.categories.parent_id is
  'Null = top-level category. Non-null = subcategory of that parent. Max depth 2.';

-- ============================================================
-- 2. products — Stage 19 fields
-- ============================================================

alter table public.products
  add column if not exists subcategory_id uuid
    references public.categories (id) on delete set null;

alter table public.products
  add column if not exists min_order_qty numeric(14, 3) not null default 1;

alter table public.products
  add column if not exists length_mm numeric(14, 3);

alter table public.products
  add column if not exists width_mm numeric(14, 3);

alter table public.products
  add column if not exists thickness_mm numeric(14, 3);

alter table public.products
  add column if not exists weight_kg numeric(14, 3);

alter table public.products
  add column if not exists main_photo_path text;

create index if not exists products_subcategory_id_idx
  on public.products (subcategory_id);

alter table public.products
  drop constraint if exists products_min_order_qty_positive;
alter table public.products
  add constraint products_min_order_qty_positive check (min_order_qty > 0);

alter table public.products
  drop constraint if exists products_length_mm_non_negative;
alter table public.products
  add constraint products_length_mm_non_negative check (
    length_mm is null or length_mm >= 0
  );

alter table public.products
  drop constraint if exists products_width_mm_non_negative;
alter table public.products
  add constraint products_width_mm_non_negative check (
    width_mm is null or width_mm >= 0
  );

alter table public.products
  drop constraint if exists products_thickness_mm_non_negative;
alter table public.products
  add constraint products_thickness_mm_non_negative check (
    thickness_mm is null or thickness_mm >= 0
  );

alter table public.products
  drop constraint if exists products_weight_kg_non_negative;
alter table public.products
  add constraint products_weight_kg_non_negative check (
    weight_kg is null or weight_kg >= 0
  );

-- Path only in bucket product-images: products/{uuid}/main.{ext}
alter table public.products
  drop constraint if exists products_main_photo_path_check;
alter table public.products
  add constraint products_main_photo_path_check check (
    main_photo_path is null
    or main_photo_path ~
      (
        '^products/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || 'main\.(png|jpe?g|webp)$'
      )
  );

comment on column public.products.main_photo_path is
  'Private Storage path in bucket product-images (e.g. products/{id}/main.jpg).';
comment on column public.products.min_order_qty is
  'Minimum order quantity in product unit. Price is entered as-is; VAT applied at invoice generation.';
comment on column public.products.subcategory_id is
  'Optional subcategory (categories.parent_id must equal products.category_id).';

-- ============================================================
-- 3. Helpers (REVOKE ALL — no EXECUTE for clients)
-- ============================================================

create or replace function public.staff_can_manage_products()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_staff_role(array['admin']::public.user_role[]);
$$;

revoke all on function public.staff_can_manage_products()
  from public, anon, authenticated;

create or replace function public.staff_can_read_products()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_staff_role(
    array['manager', 'warehouse', 'admin']::public.user_role[]
  );
$$;

revoke all on function public.staff_can_read_products()
  from public, anon, authenticated;

create or replace function public.staff_slugify_label(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_raw text := lower(trim(coalesce(p_text, '')));
  v_slug text;
begin
  if v_raw = '' then
    return 'item';
  end if;

  v_slug := regexp_replace(v_raw, '[^a-z0-9а-яё]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then
    return 'item';
  end if;
  return left(v_slug, 80);
end;
$$;

revoke all on function public.staff_slugify_label(text)
  from public, anon, authenticated;

create or replace function public.staff_unique_category_slug(p_base text, p_exclude_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text := public.staff_slugify_label(p_base);
  v_slug text := v_base;
  v_n integer := 1;
begin
  loop
    if not exists (
      select 1
      from public.categories as c
      where c.slug = v_slug
        and (p_exclude_id is null or c.id <> p_exclude_id)
    ) then
      return v_slug;
    end if;
    v_n := v_n + 1;
    v_slug := left(v_base, 70) || '-' || v_n::text;
  end loop;
end;
$$;

revoke all on function public.staff_unique_category_slug(text, uuid)
  from public, anon, authenticated;

create or replace function public.staff_unique_product_slug(p_base text, p_exclude_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text := public.staff_slugify_label(p_base);
  v_slug text := v_base;
  v_n integer := 1;
begin
  loop
    if not exists (
      select 1
      from public.products as p
      where p.slug = v_slug
        and (p_exclude_id is null or p.id <> p_exclude_id)
    ) then
      return v_slug;
    end if;
    v_n := v_n + 1;
    v_slug := left(v_base, 70) || '-' || v_n::text;
  end loop;
end;
$$;

revoke all on function public.staff_unique_product_slug(text, uuid)
  from public, anon, authenticated;

create or replace function public.staff_format_product_dimensions(
  p_length numeric,
  p_width numeric,
  p_thickness numeric
)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    concat_ws(
      ' × ',
      case when p_length is not null then p_length::text || ' мм' else null end,
      case when p_width is not null then p_width::text || ' мм' else null end,
      case when p_thickness is not null then p_thickness::text || ' мм' else null end
    ),
    ''
  );
$$;

revoke all on function public.staff_format_product_dimensions(numeric, numeric, numeric)
  from public, anon, authenticated;

create or replace function public.staff_assert_product_category_pair(
  p_category_id uuid,
  p_subcategory_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cat public.categories;
  v_sub public.categories;
begin
  if p_category_id is null then
    raise exception 'Категория обязательна';
  end if;

  select * into v_cat
  from public.categories as c
  where c.id = p_category_id;

  if not found then
    raise exception 'Категория не найдена';
  end if;

  if v_cat.parent_id is not null then
    raise exception 'В поле «Категория» можно выбрать только верхний уровень';
  end if;

  if not v_cat.is_active then
    raise exception 'Нельзя назначить архивную категорию';
  end if;

  if p_subcategory_id is null then
    return;
  end if;

  select * into v_sub
  from public.categories as c
  where c.id = p_subcategory_id;

  if not found then
    raise exception 'Подкатегория не найдена';
  end if;

  if v_sub.parent_id is distinct from p_category_id then
    raise exception 'Подкатегория не принадлежит выбранной категории';
  end if;

  if not v_sub.is_active then
    raise exception 'Нельзя назначить архивную подкатегорию';
  end if;
end;
$$;

revoke all on function public.staff_assert_product_category_pair(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.staff_is_product_photo_path(p_path text, p_product_id uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    p_path is not null
    and p_product_id is not null
    and p_path ~ ('^products/' || p_product_id::text || '/main\.(png|jpe?g|webp)$');
$$;

revoke all on function public.staff_is_product_photo_path(text, uuid)
  from public, anon, authenticated;

-- Storage policy helper (SECURITY DEFINER for storage.objects policies)
create or replace function public.staff_can_read_product_image(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if p_name is null or p_name = '' then
    return false;
  end if;

  if not public.staff_can_read_products() then
    return false;
  end if;

  return p_name ~ (
    '^products/'
    || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    || 'main\.(png|jpe?g|webp)$'
  );
end;
$$;

revoke all on function public.staff_can_read_product_image(text)
  from public, anon, authenticated;

-- ============================================================
-- 4. Storage bucket product-images
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists product_images_select_staff on storage.objects;
drop policy if exists product_images_insert_admin on storage.objects;
drop policy if exists product_images_update_admin on storage.objects;
drop policy if exists product_images_delete_admin on storage.objects;

create policy product_images_select_staff
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'product-images'
    and public.staff_can_read_product_image(name)
  );

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
-- 5. Categories RPCs
-- ============================================================

create or replace function public.staff_list_categories(
  p_include_archived boolean default false
)
returns table (
  id uuid,
  name text,
  slug text,
  parent_id uuid,
  sort_order integer,
  is_active boolean,
  products_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_read_products() then
    raise exception 'Недостаточно прав для просмотра категорий';
  end if;

  return query
  select
    c.id,
    c.name,
    c.slug,
    c.parent_id,
    c.sort_order,
    c.is_active,
    (
      select count(*)::bigint
      from public.products as p
      where p.category_id = c.id
         or p.subcategory_id = c.id
    ) as products_count,
    c.created_at,
    c.updated_at
  from public.categories as c
  where coalesce(p_include_archived, false) or c.is_active
  order by
    c.parent_id nulls first,
    c.sort_order,
    c.name;
end;
$$;

revoke all on function public.staff_list_categories(boolean)
  from public, anon, authenticated;
grant execute on function public.staff_list_categories(boolean)
  to authenticated;

create or replace function public.staff_create_category(
  p_name text,
  p_parent_id uuid default null,
  p_sort_order integer default 0
)
returns public.categories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(trim(p_name), '');
  v_parent public.categories;
  v_slug text;
  v_row public.categories;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может создавать категории';
  end if;

  if v_name is null then
    raise exception 'Название категории обязательно';
  end if;

  if p_parent_id is not null then
    select * into v_parent
    from public.categories as c
    where c.id = p_parent_id;

    if not found then
      raise exception 'Родительская категория не найдена';
    end if;

    if v_parent.parent_id is not null then
      raise exception 'Подкатегория не может быть родителем (макс. 2 уровня)';
    end if;

    if not v_parent.is_active then
      raise exception 'Нельзя создать подкатегорию в архивной категории';
    end if;
  end if;

  v_slug := public.staff_unique_category_slug(v_name, null);

  insert into public.categories (
    name,
    slug,
    parent_id,
    sort_order,
    is_active
  ) values (
    v_name,
    v_slug,
    p_parent_id,
    coalesce(p_sort_order, 0),
    true
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.staff_create_category(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staff_create_category(text, uuid, integer)
  to authenticated;

create or replace function public.staff_update_category(
  p_id uuid,
  p_name text,
  p_sort_order integer default null,
  p_parent_id uuid default null,
  p_clear_parent boolean default false
)
returns public.categories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := nullif(trim(p_name), '');
  v_row public.categories;
  v_parent public.categories;
  v_new_parent uuid;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может изменять категории';
  end if;

  if p_id is null then
    raise exception 'id категории обязателен';
  end if;

  if v_name is null then
    raise exception 'Название категории обязательно';
  end if;

  select * into v_row
  from public.categories as c
  where c.id = p_id
  for update;

  if not found then
    raise exception 'Категория не найдена';
  end if;

  if coalesce(p_clear_parent, false) then
    v_new_parent := null;
  elsif p_parent_id is not null then
    v_new_parent := p_parent_id;
  else
    v_new_parent := v_row.parent_id;
  end if;

  if v_new_parent is not null then
    if v_new_parent = p_id then
      raise exception 'Категория не может быть родителем самой себя';
    end if;

    select * into v_parent
    from public.categories as c
    where c.id = v_new_parent;

    if not found then
      raise exception 'Родительская категория не найдена';
    end if;

    if v_parent.parent_id is not null then
      raise exception 'Подкатегория не может быть родителем (макс. 2 уровня)';
    end if;

    -- Promoting/demoting: category with children cannot become a subcategory
    if exists (
      select 1 from public.categories as ch where ch.parent_id = p_id
    ) and v_new_parent is not null then
      raise exception 'У категории есть подкатегории — нельзя сделать её подкатегорией';
    end if;
  end if;

  update public.categories as c
  set
    name = v_name,
    slug = public.staff_unique_category_slug(v_name, p_id),
    parent_id = v_new_parent,
    sort_order = coalesce(p_sort_order, c.sort_order),
    updated_at = now()
  where c.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.staff_update_category(uuid, text, integer, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_update_category(uuid, text, integer, uuid, boolean)
  to authenticated;

create or replace function public.staff_archive_category(p_id uuid)
returns public.categories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.categories;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может архивировать категории';
  end if;

  if p_id is null then
    raise exception 'id категории обязателен';
  end if;

  select * into v_row
  from public.categories as c
  where c.id = p_id
  for update;

  if not found then
    raise exception 'Категория не найдена';
  end if;

  -- Soft-archive only; hard delete is intentionally not provided
  -- (products may still reference the category via FK).
  if exists (
    select 1 from public.categories as ch where ch.parent_id = p_id and ch.is_active
  ) then
    raise exception
      'Сначала архивируйте активные подкатегории';
  end if;

  update public.categories as c
  set
    is_active = false,
    updated_at = now()
  where c.id = p_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.staff_archive_category(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_archive_category(uuid)
  to authenticated;

-- ============================================================
-- 6. Products RPCs
-- ============================================================

create or replace function public.staff_list_products(
  p_query text default null,
  p_category_id uuid default null,
  p_status text default null,
  p_limit integer default 100
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
  updated_at timestamptz
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
    if v_status not in ('active', 'archived') then
      raise exception 'Фильтр статуса: только active или archived';
    end if;
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
    p.updated_at
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
    )
  order by p.updated_at desc, p.name
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_products(text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_products(text, uuid, text, integer)
  to authenticated;

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
    'updated_at', p.updated_at
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

create or replace function public.staff_create_product(
  p_sku text,
  p_name text,
  p_category_id uuid,
  p_subcategory_id uuid default null,
  p_status text default 'active',
  p_base_price numeric default null,
  p_min_order_qty numeric default 1,
  p_unit text default 'шт.',
  p_length_mm numeric default null,
  p_width_mm numeric default null,
  p_thickness_mm numeric default null,
  p_weight_kg numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku text := nullif(trim(p_sku), '');
  v_name text := nullif(trim(p_name), '');
  v_unit text := coalesce(nullif(trim(p_unit), ''), 'шт.');
  v_status public.product_status;
  v_min numeric := coalesce(p_min_order_qty, 1);
  v_id uuid := gen_random_uuid();
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может создавать товары';
  end if;

  if v_sku is null then
    raise exception 'Артикул обязателен';
  end if;
  if v_name is null then
    raise exception 'Название обязательно';
  end if;
  if v_min <= 0 then
    raise exception 'Минимальный заказ должен быть больше 0';
  end if;
  if p_base_price is not null and p_base_price < 0 then
    raise exception 'Цена не может быть отрицательной';
  end if;

  begin
    v_status := coalesce(nullif(trim(p_status), ''), 'active')::public.product_status;
  exception
    when invalid_text_representation then
      raise exception 'Некорректный статус';
  end;

  if v_status not in ('active', 'archived') then
    raise exception 'Статус товара: только Активен или Архив';
  end if;

  perform public.staff_assert_product_category_pair(p_category_id, p_subcategory_id);

  if exists (select 1 from public.products as p where p.sku = v_sku) then
    raise exception 'Товар с артикулом «%» уже существует', v_sku;
  end if;

  v_slug := public.staff_unique_product_slug(v_sku, null);

  insert into public.products (
    id,
    category_id,
    subcategory_id,
    name,
    slug,
    sku,
    unit,
    base_price,
    min_order_qty,
    length_mm,
    width_mm,
    thickness_mm,
    weight_kg,
    dimensions,
    status
  ) values (
    v_id,
    p_category_id,
    p_subcategory_id,
    v_name,
    v_slug,
    v_sku,
    v_unit,
    p_base_price,
    v_min,
    p_length_mm,
    p_width_mm,
    p_thickness_mm,
    p_weight_kg,
    public.staff_format_product_dimensions(p_length_mm, p_width_mm, p_thickness_mm),
    v_status
  );

  return public.staff_get_product(v_id);
end;
$$;

revoke all on function public.staff_create_product(
  text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.staff_create_product(
  text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) to authenticated;

create or replace function public.staff_update_product(
  p_product_id uuid,
  p_sku text,
  p_name text,
  p_category_id uuid,
  p_subcategory_id uuid default null,
  p_status text default 'active',
  p_base_price numeric default null,
  p_min_order_qty numeric default 1,
  p_unit text default 'шт.',
  p_length_mm numeric default null,
  p_width_mm numeric default null,
  p_thickness_mm numeric default null,
  p_weight_kg numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku text := nullif(trim(p_sku), '');
  v_name text := nullif(trim(p_name), '');
  v_unit text := coalesce(nullif(trim(p_unit), ''), 'шт.');
  v_status public.product_status;
  v_min numeric := coalesce(p_min_order_qty, 1);
  v_existing public.products;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может изменять товары';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  select * into v_existing
  from public.products as p
  where p.id = p_product_id
  for update;

  if not found then
    raise exception 'Товар не найден';
  end if;

  if v_sku is null then
    raise exception 'Артикул обязателен';
  end if;
  if v_name is null then
    raise exception 'Название обязательно';
  end if;
  if v_min <= 0 then
    raise exception 'Минимальный заказ должен быть больше 0';
  end if;
  if p_base_price is not null and p_base_price < 0 then
    raise exception 'Цена не может быть отрицательной';
  end if;

  begin
    v_status := coalesce(nullif(trim(p_status), ''), 'active')::public.product_status;
  exception
    when invalid_text_representation then
      raise exception 'Некорректный статус';
  end;

  if v_status not in ('active', 'archived') then
    raise exception 'Статус товара: только Активен или Архив';
  end if;

  perform public.staff_assert_product_category_pair(p_category_id, p_subcategory_id);

  if exists (
    select 1 from public.products as p
    where p.sku = v_sku and p.id <> p_product_id
  ) then
    raise exception 'Товар с артикулом «%» уже существует', v_sku;
  end if;

  update public.products as p
  set
    sku = v_sku,
    name = v_name,
    slug = case
      when p.sku is distinct from v_sku
        then public.staff_unique_product_slug(v_sku, p_product_id)
      else p.slug
    end,
    category_id = p_category_id,
    subcategory_id = p_subcategory_id,
    status = v_status,
    unit = v_unit,
    base_price = p_base_price,
    min_order_qty = v_min,
    length_mm = p_length_mm,
    width_mm = p_width_mm,
    thickness_mm = p_thickness_mm,
    weight_kg = p_weight_kg,
    dimensions = public.staff_format_product_dimensions(
      p_length_mm, p_width_mm, p_thickness_mm
    ),
    updated_at = now()
  where p.id = p_product_id;

  return public.staff_get_product(p_product_id);
end;
$$;

revoke all on function public.staff_update_product(
  uuid, text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.staff_update_product(
  uuid, text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) to authenticated;

create or replace function public.staff_set_product_main_photo(
  p_product_id uuid,
  p_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text := nullif(trim(p_path), '');
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может менять фото товара';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  if not exists (select 1 from public.products as p where p.id = p_product_id) then
    raise exception 'Товар не найден';
  end if;

  if v_path is not null
     and not public.staff_is_product_photo_path(v_path, p_product_id)
  then
    raise exception
      'Некорректный путь фото. Ожидается products/{id}/main.{png|jpg|jpeg|webp}';
  end if;

  update public.products as p
  set
    main_photo_path = v_path,
    updated_at = now()
  where p.id = p_product_id;

  return public.staff_get_product(p_product_id);
end;
$$;

revoke all on function public.staff_set_product_main_photo(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_set_product_main_photo(uuid, text)
  to authenticated;

create or replace function public.staff_copy_product(
  p_source_id uuid,
  p_sku text,
  p_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.products;
  v_sku text := nullif(trim(p_sku), '');
  v_name text := nullif(trim(p_name), '');
  v_id uuid := gen_random_uuid();
  v_slug text;
  v_source_photo text;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может копировать товары';
  end if;

  if p_source_id is null then
    raise exception 'id исходного товара обязателен';
  end if;

  select * into v_source
  from public.products as p
  where p.id = p_source_id;

  if not found then
    raise exception 'Исходный товар не найден';
  end if;

  if v_sku is null then
    raise exception 'Артикул копии обязателен';
  end if;
  if v_name is null then
    raise exception 'Название копии обязательно';
  end if;

  if exists (select 1 from public.products as p where p.sku = v_sku) then
    raise exception 'Товар с артикулом «%» уже существует', v_sku;
  end if;

  -- Validate category pair still valid (active)
  if v_source.category_id is not null then
    perform public.staff_assert_product_category_pair(
      v_source.category_id,
      v_source.subcategory_id
    );
  else
    raise exception 'У исходного товара нет категории — сначала назначьте категорию';
  end if;

  v_slug := public.staff_unique_product_slug(v_sku, null);
  v_source_photo := v_source.main_photo_path;

  -- Copies: photo (via client), category/subcategory, price,
  -- min order, unit, L/W/T/weight. Does NOT copy SKU/name (passed in)
  -- or archived status (always starts as active).
  insert into public.products (
    id,
    category_id,
    subcategory_id,
    name,
    slug,
    sku,
    unit,
    base_price,
    min_order_qty,
    length_mm,
    width_mm,
    thickness_mm,
    weight_kg,
    dimensions,
    status,
    main_photo_path
  ) values (
    v_id,
    v_source.category_id,
    v_source.subcategory_id,
    v_name,
    v_slug,
    v_sku,
    v_source.unit,
    v_source.base_price,
    v_source.min_order_qty,
    v_source.length_mm,
    v_source.width_mm,
    v_source.thickness_mm,
    v_source.weight_kg,
    v_source.dimensions,
    'active',
    null
  );

  return public.staff_get_product(v_id)
    || jsonb_build_object(
      'source_product_id', p_source_id,
      'source_main_photo_path', v_source_photo
    );
end;
$$;

revoke all on function public.staff_copy_product(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.staff_copy_product(uuid, text, text)
  to authenticated;

-- ============================================================
-- Notes
-- ============================================================
-- - Product hard-delete is intentionally NOT provided (order_items RESTRICT).
-- - Category hard-delete is intentionally NOT provided; use archive.
-- - Price stored in base_price as entered; VAT applied only at invoice generate.
-- - One main photo only; gallery / product_images table unused by Stage 19 UI.
-- - Bucket product-images is private; DB stores path only.
-- ============================================================
