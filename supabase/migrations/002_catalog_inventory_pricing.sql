-- DEKORO Platform V1
-- Migration: catalog, warehouses, inventory and pricing foundation
--
-- Depends on 001_companies_and_profiles.sql (public.companies, public.profiles,
-- public.set_updated_at()). Run this file once in the Supabase SQL Editor,
-- after 001 (see supabase/README.md). Not executed automatically.
--
-- Explicitly out of scope for this migration: orders, invoices, payments,
-- admin UI/roles. No service_role usage anywhere. RLS is enabled (never
-- disabled) on every new table.

-- ============================================================
-- 0. Guard: make sure 001_companies_and_profiles.sql already ran
-- ============================================================

do $$
begin
  if to_regclass('public.companies') is null then
    raise exception
      'public.companies is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'public.set_updated_at() is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Extensions
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- 2. product_status enum
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_status') then
    create type public.product_status as enum ('draft', 'active', 'archived');
  end if;
end
$$;

-- ============================================================
-- 3. categories
-- ============================================================

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  image_url text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_name_not_blank check (length(trim(name)) > 0)
);

-- ============================================================
-- 4. products
-- ============================================================

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories (id) on delete set null,
  name text not null,
  slug text not null unique,
  sku text not null unique,
  original_sku text,
  description text,
  dimensions text,
  unit text not null default 'шт.',
  base_price numeric(14, 2),
  status public.product_status not null default 'draft',
  is_promotion boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_name_not_blank check (length(trim(name)) > 0),
  constraint products_sku_not_blank check (length(trim(sku)) > 0),
  constraint products_base_price_non_negative check (base_price is null or base_price >= 0)
);

create index if not exists products_category_id_idx on public.products (category_id);
create index if not exists products_status_idx on public.products (status);

-- ============================================================
-- 5. product_images
-- ============================================================

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  image_url text not null,
  alt_text text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists product_images_product_id_idx on public.product_images (product_id);

-- At most one primary image per product (partial unique index: only rows
-- with is_primary = true participate, so a product can have zero or one).
create unique index if not exists product_images_one_primary_per_product_idx
  on public.product_images (product_id)
  where is_primary;

-- ============================================================
-- 6. warehouses
-- ============================================================

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouses_name_not_blank check (length(trim(name)) > 0),
  constraint warehouses_code_not_blank check (length(trim(code)) > 0)
);

-- ============================================================
-- 7. inventory
-- ============================================================

create table if not exists public.inventory (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  warehouse_id uuid not null references public.warehouses (id) on delete cascade,
  quantity numeric(14, 3) not null default 0,
  reserved_quantity numeric(14, 3) not null default 0,
  updated_at timestamptz not null default now(),
  constraint inventory_product_warehouse_unique unique (product_id, warehouse_id),
  constraint inventory_quantity_non_negative check (quantity >= 0),
  constraint inventory_reserved_non_negative check (reserved_quantity >= 0),
  constraint inventory_reserved_not_over_quantity check (reserved_quantity <= quantity)
);

create index if not exists inventory_product_id_idx on public.inventory (product_id);
create index if not exists inventory_warehouse_id_idx on public.inventory (warehouse_id);

-- ============================================================
-- 8. product_availability view
--
-- Plain, unfiltered reporting view over inventory (matches the raw table
-- 1:1 plus the derived available_quantity). It is intentionally NOT
-- granted to anon/authenticated (see the RLS section below) — clients only
-- ever see stock through get_catalog(), which is the safer, narrower
-- surface recommended for hiding raw quantity/reserved_quantity.
-- ============================================================

create or replace view public.product_availability as
select
  product_id,
  warehouse_id,
  quantity,
  reserved_quantity,
  (quantity - reserved_quantity) as available_quantity
from public.inventory;

-- ============================================================
-- 9. price_groups
-- ============================================================

create table if not exists public.price_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_groups_name_not_blank check (length(trim(name)) > 0)
);

-- At most one default price group, globally (partial unique index over a
-- constant expression: every qualifying row indexes to the same value).
create unique index if not exists price_groups_single_default_idx
  on public.price_groups ((true))
  where is_default;

-- ============================================================
-- 10. companies.price_group_id
-- ============================================================

alter table public.companies
  add column if not exists price_group_id uuid references public.price_groups (id) on delete set null;

-- ============================================================
-- 11. product_prices (price list per price group)
-- ============================================================

create table if not exists public.product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  price_group_id uuid not null references public.price_groups (id) on delete cascade,
  price numeric(14, 2) not null,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_prices_product_group_unique unique (product_id, price_group_id),
  constraint product_prices_price_non_negative check (price >= 0),
  constraint product_prices_valid_range check (
    valid_from is null or valid_to is null or valid_to > valid_from
  )
);

create index if not exists product_prices_product_id_idx on public.product_prices (product_id);

-- ============================================================
-- 12. company_product_prices (personal price per company, highest priority)
-- ============================================================

create table if not exists public.company_product_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  price numeric(14, 2) not null,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_product_prices_company_product_unique unique (company_id, product_id),
  constraint company_product_prices_price_non_negative check (price >= 0),
  constraint company_product_prices_valid_range check (
    valid_from is null or valid_to is null or valid_to > valid_from
  )
);

create index if not exists company_product_prices_company_id_idx on public.company_product_prices (company_id);
create index if not exists company_product_prices_product_id_idx on public.company_product_prices (product_id);

-- ============================================================
-- 13. get_product_price(p_product_id): resolve the caller's price
--
-- Priority: company_product_prices (personal price) > product_prices for
-- the caller's price group (falling back to the default price group if the
-- company has none assigned) > products.base_price. Returns null for
-- unauthenticated callers, matching the existing "price available after
-- sign-in" UX. SECURITY DEFINER with a locked search_path so it always
-- resolves public.* regardless of the caller's search_path.
-- ============================================================

create or replace function public.get_product_price(p_product_id uuid)
returns numeric
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_price_group_id uuid;
  v_price numeric;
begin
  if v_user_id is null then
    return null;
  end if;

  select company_id into v_company_id from public.profiles where id = v_user_id;

  if v_company_id is not null then
    select price into v_price
    from public.company_product_prices
    where company_id = v_company_id
      and product_id = p_product_id
      and (valid_from is null or valid_from <= now())
      and (valid_to is null or valid_to >= now())
    limit 1;

    if v_price is not null then
      return v_price;
    end if;

    select price_group_id into v_price_group_id
    from public.companies
    where id = v_company_id;
  end if;

  if v_price_group_id is null then
    select id into v_price_group_id from public.price_groups where is_default limit 1;
  end if;

  if v_price_group_id is not null then
    select price into v_price
    from public.product_prices
    where product_id = p_product_id
      and price_group_id = v_price_group_id
      and (valid_from is null or valid_from <= now())
      and (valid_to is null or valid_to >= now())
    limit 1;

    if v_price is not null then
      return v_price;
    end if;
  end if;

  return (select base_price from public.products where id = p_product_id);
end;
$$;

revoke all on function public.get_product_price(uuid) from public;
grant execute on function public.get_product_price(uuid) to anon, authenticated;

-- ============================================================
-- 14. get_catalog(): one round-trip catalog read for the storefront
--
-- Returns active products with their category name, primary image,
-- aggregated available stock across active warehouses, and the caller's
-- resolved price (via get_product_price, so it is personalized per user
-- without the client issuing a separate price query per product).
-- SECURITY DEFINER + STABLE, locked search_path.
-- ============================================================

create or replace function public.get_catalog()
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
  is_promotion boolean
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
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
    img.image_url as image,
    p.is_promotion
  from public.products p
  left join public.categories c on c.id = p.category_id and c.is_active
  left join lateral (
    select sum(pa.available_quantity) as available_stock
    from public.product_availability pa
    join public.warehouses w on w.id = pa.warehouse_id and w.is_active
    where pa.product_id = p.id
  ) stock on true
  left join lateral (
    select pi.image_url
    from public.product_images pi
    where pi.product_id = p.id and pi.is_primary
    order by pi.sort_order
    limit 1
  ) img on true
  where p.status = 'active'
  order by p.created_at;
end;
$$;

revoke all on function public.get_catalog() from public;
grant execute on function public.get_catalog() to anon, authenticated;

-- ============================================================
-- 15. updated_at triggers (reusing public.set_updated_at() from 001)
-- ============================================================

drop trigger if exists set_categories_updated_at on public.categories;
create trigger set_categories_updated_at
  before update on public.categories
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_products_updated_at on public.products;
create trigger set_products_updated_at
  before update on public.products
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_warehouses_updated_at on public.warehouses;
create trigger set_warehouses_updated_at
  before update on public.warehouses
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_inventory_updated_at on public.inventory;
create trigger set_inventory_updated_at
  before update on public.inventory
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_price_groups_updated_at on public.price_groups;
create trigger set_price_groups_updated_at
  before update on public.price_groups
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_product_prices_updated_at on public.product_prices;
create trigger set_product_prices_updated_at
  before update on public.product_prices
  for each row
  execute function public.set_updated_at();

drop trigger if exists set_company_product_prices_updated_at on public.company_product_prices;
create trigger set_company_product_prices_updated_at
  before update on public.company_product_prices
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- 16. Row Level Security
-- ============================================================

alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.warehouses enable row level security;
alter table public.inventory enable row level security;
alter table public.price_groups enable row level security;
alter table public.product_prices enable row level security;
alter table public.company_product_prices enable row level security;

-- Deny everything by default, then grant back only what's needed.
revoke all on public.categories from anon, authenticated;
revoke all on public.products from anon, authenticated;
revoke all on public.product_images from anon, authenticated;
revoke all on public.warehouses from anon, authenticated;
revoke all on public.inventory from anon, authenticated;
revoke all on public.product_availability from anon, authenticated;
revoke all on public.price_groups from anon, authenticated;
revoke all on public.product_prices from anon, authenticated;
revoke all on public.company_product_prices from anon, authenticated;

-- --- categories: public read of active categories -----------------------

grant select on public.categories to anon, authenticated;

drop policy if exists categories_select_active on public.categories;
create policy categories_select_active
  on public.categories
  for select
  to anon, authenticated
  using (is_active);

-- --- products: public read of active products ----------------------------

grant select on public.products to anon, authenticated;

drop policy if exists products_select_active on public.products;
create policy products_select_active
  on public.products
  for select
  to anon, authenticated
  using (status = 'active');

-- --- product_images: public read of active products' images -------------

grant select on public.product_images to anon, authenticated;

drop policy if exists product_images_select_active_products on public.product_images;
create policy product_images_select_active_products
  on public.product_images
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from public.products p
      where p.id = product_images.product_id and p.status = 'active'
    )
  );

-- --- warehouses: public read of active warehouses ------------------------

grant select on public.warehouses to anon, authenticated;

drop policy if exists warehouses_select_active on public.warehouses;
create policy warehouses_select_active
  on public.warehouses
  for select
  to anon, authenticated
  using (is_active);

-- --- inventory / product_availability: no direct client access ----------
-- Raw quantity/reserved_quantity are never exposed directly. Stock is only
-- available to clients through get_catalog() (SECURITY DEFINER), which
-- aggregates available_quantity across active warehouses. No SELECT policy
-- is created here, so RLS denies all direct reads for anon/authenticated
-- even if a future grant is accidentally added.

-- --- price_groups: no direct client access -------------------------------
-- Clients never need to read price group rows directly — resolved prices
-- come from get_product_price()/get_catalog() only. No SELECT policy.

-- --- product_prices / company_product_prices: no direct client access ---
-- Same reasoning: prices are only ever resolved through get_product_price()
-- (SECURITY DEFINER), never read directly by clients. No SELECT policy.

-- No INSERT/UPDATE/DELETE policy exists on any table in this migration for
-- anon/authenticated — all writes are denied for regular clients.
