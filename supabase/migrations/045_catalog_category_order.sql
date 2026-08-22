-- DEKORO Platform
-- Migration: storefront catalog order by category / subcategory
--
-- NOT applied automatically — run once in the Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–044.
--
-- Purpose:
--   get_catalog() currently orders by products.created_at, so a newly added
--   product lands at the end of the whole catalog instead of next to the
--   same category / subcategory.
--
--   This file only changes ORDER BY (and joins the existing subcategory).
--   RETURNS TABLE, sale_price, list_price, stock, images, and filters
--   stay identical to 041_order_pricing_engine.sql.
--
-- Existing fields used (no new columns):
--   categories.sort_order / name  — parent category
--   categories.sort_order / name  — subcategory (products.subcategory_id)
--   products.name, sku, created_at, id — stable fallback
--   products has no sort_order column; none is added.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regprocedure('public.get_catalog()') is null then
    raise exception 'get_catalog missing — run 041_order_pricing_engine.sql first.';
  end if;

  if to_regclass('public.categories') is null
     or to_regclass('public.products') is null
  then
    raise exception 'categories/products missing — run 002 and 019 first.';
  end if;
end
$$;

-- ============================================================
-- 1. get_catalog — same payload, category-aware order
-- ============================================================

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
  list_price numeric,
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
    p.base_price as list_price,
    coalesce(
      nullif(trim(p.main_photo_path), ''),
      img.image_url
    ) as image,
    p.is_promotion,
    p.updated_at
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
  order by
    coalesce(c.sort_order, 2147483647),
    coalesce(c.name, ''),
    coalesce(sub.sort_order, 0),
    coalesce(sub.name, ''),
    p.name,
    p.sku,
    p.created_at,
    p.id;
end;
$$;

revoke all on function public.get_catalog() from public;
revoke all on function public.get_catalog() from anon;
revoke all on function public.get_catalog() from authenticated;
grant execute on function public.get_catalog() to anon, authenticated;
