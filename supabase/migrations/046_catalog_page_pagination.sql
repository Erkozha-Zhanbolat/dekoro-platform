-- DEKORO Platform
-- Migration: storefront catalog page pagination + category list
--
-- NOT applied automatically — run once in the Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–045.
-- Does NOT replace public.get_catalog() — full-catalog consumers (favorites,
-- quick-order, product detail, cart sync, repeat-order) keep working.
--
-- Purpose:
--   Client /catalog must stop fetching every active product in one RPC.
--   Pagination runs AFTER the Stage 45 category/subcategory sort, with
--   server-side search and category filter. Pricing via get_product_price()
--   is unchanged.
--
-- Pagination strategy (intentionally simple for current catalog size):
--   LIMIT / OFFSET over the deterministic Stage 45 ORDER BY.
--   Same filter + ORDER BY on every page → page N is rows
--   [offset, offset+limit) of that ordered set. No composite cursor.
--
-- New RPCs:
--   public.get_catalog_categories() — filter chips without loading products
--   public.get_catalog_page(...)    — LIMIT/OFFSET page

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regprocedure('public.get_catalog()') is null then
    raise exception 'get_catalog missing — run 045_catalog_category_order.sql first.';
  end if;

  if to_regprocedure('public.get_product_price(uuid)') is null then
    raise exception 'get_product_price missing — run pricing migrations first.';
  end if;

  if to_regclass('public.categories') is null
     or to_regclass('public.products') is null
  then
    raise exception 'categories/products missing — run 002 and 019 first.';
  end if;
end
$$;

-- ============================================================
-- 1. get_catalog_categories — distinct active storefront categories
-- ============================================================

create or replace function public.get_catalog_categories()
returns table (
  category text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  return query
  select c.name as category
  from public.categories as c
  where c.is_active
    and c.parent_id is null
    and exists (
      select 1
      from public.products as p
      where p.category_id = c.id
        and p.status = 'active'
    )
  order by
    coalesce(c.sort_order, 2147483647),
    c.name;
end;
$$;

revoke all on function public.get_catalog_categories() from public;
revoke all on function public.get_catalog_categories() from anon;
revoke all on function public.get_catalog_categories() from authenticated;
grant execute on function public.get_catalog_categories() to anon, authenticated;

-- ============================================================
-- 2. get_catalog_page — LIMIT/OFFSET after Stage 45 ORDER BY
-- ============================================================

-- Drop any prior draft signatures (keyset draft used uuid cursor).
drop function if exists public.get_catalog_page(integer, text, text, uuid);
drop function if exists public.get_catalog_page(integer, text, text, integer);

create function public.get_catalog_page(
  p_limit integer default 32,
  p_search text default null,
  p_category text default null,
  p_offset integer default 0
)
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
  list_price numeric,
  image text,
  is_promotion boolean,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_limit integer;
  v_offset integer;
  v_search text;
  v_category text;
begin
  v_limit := least(greatest(coalesce(p_limit, 32), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);
  v_search := nullif(trim(coalesce(p_search, '')), '');
  v_category := nullif(trim(coalesce(p_category, '')), '');

  return query
  with base as (
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
      p.base_price as list_price,
      coalesce(
        nullif(trim(p.main_photo_path), ''),
        img.image_url
      ) as image,
      p.is_promotion,
      p.updated_at,
      coalesce(c.sort_order, 2147483647) as category_sort,
      coalesce(c.name, '') as category_name_key,
      coalesce(sub.sort_order, 0) as sub_sort,
      coalesce(sub.name, '') as sub_name_key,
      p.created_at
    from public.products as p
    left join public.categories as c
      on c.id = p.category_id and c.is_active
    left join public.categories as sub
      on sub.id = p.subcategory_id and sub.is_active
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
      and (
        v_category is null
        or c.name = v_category
      )
      and (
        v_search is null
        or position(lower(v_search) in lower(p.name)) > 0
        or position(lower(v_search) in lower(p.sku)) > 0
        or position(lower(v_search) in lower(coalesce(p.original_sku, ''))) > 0
      )
  ),
  numbered as (
    select
      b.*,
      count(*) over() as total_count
    from base as b
  )
  select
    n.product_id,
    n.name,
    n.sku,
    n.original_sku,
    n.category,
    n.dimensions,
    n.unit,
    n.available_stock,
    n.sale_price,
    n.list_price,
    n.image,
    n.is_promotion,
    n.updated_at,
    n.total_count
  from numbered as n
  order by
    n.category_sort,
    n.category_name_key,
    n.sub_sort,
    n.sub_name_key,
    n.name,
    n.sku,
    n.created_at,
    n.product_id
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.get_catalog_page(integer, text, text, integer) from public;
revoke all on function public.get_catalog_page(integer, text, text, integer) from anon;
revoke all on function public.get_catalog_page(integer, text, text, integer) from authenticated;
grant execute on function public.get_catalog_page(integer, text, text, integer) to anon, authenticated;
