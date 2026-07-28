-- DEKORO Platform V1
-- Migration: customer orders foundation
--
-- Depends on:
--   001_companies_and_profiles.sql (public.profiles, public.companies,
--     public.set_updated_at())
--   002_catalog_inventory_pricing.sql (public.products)
--   004_customer_types.sql (public.profiles.customer_type)
--
-- Run this file once in the Supabase SQL Editor after 001, 002 and 004
-- (see supabase/README.md). Not executed automatically.
--
-- Explicitly out of scope for this migration: checkout UI, cart UI, "My
-- orders" UI, invoices, payments, stock reservation, and SECURITY DEFINER
-- RPCs that create an order + items atomically. Clients will insert rows
-- directly under RLS; totals are trusted at the DB boundary only via
-- non-negative CHECKs (see section 6 comments). No service_role usage.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception
      'public.profiles is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if to_regclass('public.products') is null then
    raise exception
      'public.products is missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'public.set_updated_at() is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'customer_type'
  ) then
    raise exception
      'public.profiles.customer_type is missing — run supabase/migrations/004_customer_types.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Order number sequence + generator
--
-- Format: DK-000001, DK-000002, ... Unique via the sequence (and a
-- unique constraint on orders.order_number). Safe under concurrency —
-- never count(*)+1.
-- ============================================================

create sequence if not exists public.orders_order_number_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1
  no maxvalue
  cache 1;

create or replace function public.generate_order_number()
returns text
language sql
volatile
set search_path = public, pg_temp
as $$
  select 'DK-' || lpad(nextval('public.orders_order_number_seq')::text, 6, '0');
$$;

revoke all on function public.generate_order_number() from public;
-- Evaluated as the inserting role when used as a column DEFAULT, so
-- authenticated callers need EXECUTE + sequence USAGE/SELECT.
grant execute on function public.generate_order_number() to authenticated;
grant usage, select on sequence public.orders_order_number_seq to authenticated;

-- ============================================================
-- 2. orders
-- ============================================================

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null default public.generate_order_number(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- profiles.id is 1:1 with auth.users.id; stored explicitly so historical
  -- orders keep a clear link to the customer profile row.
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- null for individual customers; companies.id for company/IP customers.
  company_id uuid references public.companies (id) on delete set null,
  status text not null default 'new',
  subtotal numeric(14, 2) not null,
  discount numeric(14, 2) not null default 0,
  total numeric(14, 2) not null,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_order_number_unique unique (order_number),
  constraint orders_status_check check (
    status in ('new', 'processing', 'completed', 'cancelled')
  ),
  constraint orders_subtotal_non_negative check (subtotal >= 0),
  constraint orders_discount_non_negative check (discount >= 0),
  constraint orders_total_non_negative check (total >= 0)
);

create index if not exists orders_user_id_idx on public.orders (user_id);
create index if not exists orders_profile_id_idx on public.orders (profile_id);
create index if not exists orders_company_id_idx on public.orders (company_id);
create index if not exists orders_created_at_idx on public.orders (created_at);
create index if not exists orders_status_idx on public.orders (status);

drop trigger if exists set_orders_updated_at on public.orders;
create trigger set_orders_updated_at
  before update on public.orders
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- 3. order_items
--
-- product_name / product_sku / unit_price / line_total are snapshots of
-- the catalog at order time and do not change if the product is later
-- renamed or repriced. product_id uses ON DELETE RESTRICT so a product
-- that appears in any order cannot be hard-deleted (archive via
-- products.status instead).
-- ============================================================

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  product_name text not null,
  product_sku text,
  -- Whole units only — matches the current cart QuantitySelector model.
  quantity integer not null,
  unit_price numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  constraint order_items_quantity_positive check (quantity > 0),
  constraint order_items_unit_price_non_negative check (unit_price >= 0),
  constraint order_items_line_total_non_negative check (line_total >= 0),
  constraint order_items_product_name_not_blank check (length(trim(product_name)) > 0)
);

create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists order_items_product_id_idx on public.order_items (product_id);

-- ============================================================
-- 4. Row Level Security — orders
--
-- Clients may SELECT and INSERT their own rows. There is intentionally
-- no UPDATE/DELETE grant or policy: status and money fields cannot be
-- changed by the customer after creation. Manager/admin tooling will use
-- a separate privileged path later (not introduced here).
-- ============================================================

alter table public.orders enable row level security;

revoke all on public.orders from anon, authenticated;
grant select, insert on public.orders to authenticated;

drop policy if exists orders_select_own on public.orders;
create policy orders_select_own
  on public.orders
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists orders_insert_own on public.orders;
create policy orders_insert_own
  on public.orders
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    -- profiles.id is the same uuid as auth.users.id, so the caller's
    -- profile_id must be exactly auth.uid().
    and profile_id = auth.uid()
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and (
          (p.customer_type = 'individual' and company_id is null)
          or (
            p.customer_type = 'company'
            and company_id is not distinct from p.company_id
          )
        )
    )
  );

-- ============================================================
-- 5. Row Level Security — order_items
-- ============================================================

alter table public.order_items enable row level security;

revoke all on public.order_items from anon, authenticated;
grant select, insert on public.order_items to authenticated;

drop policy if exists order_items_select_own on public.order_items;
create policy order_items_select_own
  on public.order_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.orders o
      where o.id = order_items.order_id
        and o.user_id = auth.uid()
    )
  );

drop policy if exists order_items_insert_own on public.order_items;
create policy order_items_insert_own
  on public.order_items
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.orders o
      where o.id = order_id
        and o.user_id = auth.uid()
    )
  );

-- ============================================================
-- 6. Trust boundary (documented, not enforced by this migration)
--
-- RLS guarantees ownership (user_id / profile_id / company_id linkage)
-- and blocks post-create mutation of status/totals by the client.
-- It does NOT verify that:
--   - subtotal / discount / total match the sum of line_totals;
--   - unit_price matches the caller's resolved catalog price;
--   - order + items are inserted atomically in one transaction.
-- Those checks belong in a follow-up SECURITY DEFINER RPC (or similar)
-- that creates the order and its items in a single transaction. Until
-- then, the client is the source of the submitted money figures, subject
-- only to the non-negative CHECKs above.
-- ============================================================
