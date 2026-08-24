-- DEKORO Platform
-- Migration: storefront category business order (sort_order)
--
-- NOT applied automatically — run once in the Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–046.
-- Does NOT change get_catalog_page / get_catalog pricing payload.
--
-- Root cause (audit):
--   Stage 45/046 ORDER BY categories.sort_order, then name.
--   Seeded categories had sort_order 1,2,3 (Бамбук/Луверы/Алюминий).
--   Later categories (Клей, Плинтусы) were created with default sort_order = 0,
--   so they sorted BEFORE the seeded ones:
--     Клей → Плинтусы → Бамбуковые панели → Луверы → Алюминиевые профили
--
-- Fix:
--   Set top-level categories.sort_order by exact name (no UUID hardcoding).
--   get_catalog / get_catalog_categories / get_catalog_page already ORDER BY
--   sort_order — data fix чis the single source of truth.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.categories') is null then
    raise exception 'categories missing — run 002 / 019 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Core DEKORO top-level category business order (by name)
-- ============================================================

update public.categories as c
set
  sort_order = v.sort_order,
  updated_at = now()
from (
  values
    ('Бамбуковые панели', 10),
    ('Луверы', 20),
    ('Плинтусы', 30),
    ('Алюминиевые профили', 40),
    ('Клей', 50)
) as v(name, sort_order)
where c.parent_id is null
  and c.name = v.name
  and c.sort_order is distinct from v.sort_order;

-- ============================================================
-- 2. Other top-level categories — keep after the core block (100, 110, …)
--    Do not touch subcategories (parent_id is not null).
-- ============================================================

with others as (
  select
    c.id,
    row_number() over (order by c.name) as rn
  from public.categories as c
  where c.parent_id is null
    and c.name not in (
      'Бамбуковые панели',
      'Луверы',
      'Плинтусы',
      'Алюминиевые профили',
      'Клей'
    )
)
update public.categories as c
set
  sort_order = 100 + (o.rn - 1) * 10,
  updated_at = now()
from others as o
where c.id = o.id
  and c.sort_order is distinct from (100 + (o.rn - 1) * 10);

-- ============================================================
-- 3. Notes
--
-- - get_catalog_categories() and get_catalog_page() already use
--   ORDER BY coalesce(c.sort_order, …), c.name — no RPC rewrite required.
-- - Subcategory ordering (Stage 45) is unchanged.
-- - LIMIT/OFFSET pagination (046) is unchanged; order is applied before OFFSET.
-- ============================================================
