-- DEKORO Platform V1
-- Seed: demo catalog data
--
-- Depends on 002_catalog_inventory_pricing.sql. Run this file once in the
-- Supabase SQL Editor after both migrations (see supabase/README.md).
-- Safe to re-run: every insert is keyed off a natural unique column
-- (slug / sku / code / name) with ON CONFLICT ... DO UPDATE, so re-running
-- this file updates the same demo rows instead of creating duplicates.

do $$
begin
  if to_regclass('public.products') is null then
    raise exception
      'public.products is missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Categories
-- ============================================================

insert into public.categories (name, slug, sort_order, is_active)
values
  ('Бамбуковые панели', 'bambukovye-paneli', 1, true),
  ('Луверы', 'luvery', 2, true),
  ('Алюминиевые профили', 'alyuminievye-profili', 3, true)
on conflict (slug) do update set
  name = excluded.name,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

-- ============================================================
-- 2. Warehouse
-- ============================================================

insert into public.warehouses (name, code, address, is_active)
values ('Основной склад Алматы', 'ALMATY-01', null, true)
on conflict (code) do update set
  name = excluded.name,
  is_active = excluded.is_active;

-- ============================================================
-- 3. Price group
-- ============================================================

insert into public.price_groups (name, description, is_default)
values (
  'Базовая',
  'Базовая цена для клиентов без индивидуальной ценовой группы',
  true
)
on conflict (name) do update set
  description = excluded.description,
  is_default = excluded.is_default;

-- ============================================================
-- 4. Products (real DEKORO SKUs, matching the current static catalog)
-- ============================================================

insert into public.products (
  category_id, name, slug, sku, original_sku, dimensions, unit, base_price, status, is_promotion
)
values
  (
    (select id from public.categories where slug = 'bambukovye-paneli'),
    'Бамбук Лунный свет', 'bambuk-lunnyy-svet', 'Y01-1189', 'Y01-1189',
    null, 'шт.', 8500, 'active', false
  ),
  (
    (select id from public.categories where slug = 'bambukovye-paneli'),
    '3Д дерево светлое', '3d-derevo-svetloe', 'J36-507', 'J36-507',
    '1200×2900×4,8 мм', 'шт.', 9200, 'active', false
  ),
  (
    (select id from public.categories where slug = 'bambukovye-paneli'),
    '3Д дерево тёмное', '3d-derevo-temnoe', 'J35-502', 'J35-502',
    '1200×2900×4,8 мм', 'шт.', 9200, 'active', false
  ),
  (
    (select id from public.categories where slug = 'luvery'),
    'Луверы L-010', 'luvery-l-010', 'L-010', 'L-010',
    null, 'м.п.', 15200, 'active', true
  ),
  (
    (select id from public.categories where slug = 'alyuminievye-profili'),
    'Алюминиевый профиль A-100', 'alyuminievyy-profil-a-100', 'A-100', 'A-100',
    null, 'м.п.', 3200, 'active', false
  )
on conflict (slug) do update set
  category_id = excluded.category_id,
  name = excluded.name,
  sku = excluded.sku,
  original_sku = excluded.original_sku,
  dimensions = excluded.dimensions,
  unit = excluded.unit,
  base_price = excluded.base_price,
  status = excluded.status,
  is_promotion = excluded.is_promotion;

-- ============================================================
-- 5. Stock for the demo products at the demo warehouse
-- ============================================================

insert into public.inventory (product_id, warehouse_id, quantity, reserved_quantity)
select p.id, w.id, v.quantity, 0
from (
  values
    ('Y01-1189', 500::numeric),
    ('J36-507', 200::numeric),
    ('J35-502', 200::numeric),
    ('L-010', 120::numeric),
    ('A-100', 500::numeric)
) as v (sku, quantity)
join public.products p on p.sku = v.sku
join public.warehouses w on w.code = 'ALMATY-01'
on conflict (product_id, warehouse_id) do update set
  quantity = excluded.quantity,
  updated_at = now();

-- ============================================================
-- 6. Base price list entries in the default price group
--
-- Mirrors products.base_price into product_prices for the default group so
-- get_product_price() has a concrete price-group row to resolve even before
-- any company-specific overrides are configured.
-- ============================================================

insert into public.product_prices (product_id, price_group_id, price)
select p.id, pg.id, p.base_price
from public.products p
join public.price_groups pg on pg.is_default
where p.sku in ('Y01-1189', 'J36-507', 'J35-502', 'L-010', 'A-100')
  and p.base_price is not null
on conflict (product_id, price_group_id) do update set
  price = excluded.price;
