-- DEKORO Platform V1
-- Migration: favorites
--
-- Depends on 002_catalog_inventory_pricing.sql (public.products). Run this
-- file once in the Supabase SQL Editor, after 001 and 002 (see
-- supabase/README.md). Not executed automatically.
--
-- Explicitly out of scope: orders, invoices, payments, admin UI/roles.
-- No service_role usage. RLS is enabled (never disabled).

-- ============================================================
-- 0. Guard: make sure 002_catalog_inventory_pricing.sql already ran
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null then
    raise exception
      'public.products is missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. favorites table
-- ============================================================

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint favorites_user_product_unique unique (user_id, product_id)
);

create index if not exists favorites_user_id_idx on public.favorites (user_id);
create index if not exists favorites_product_id_idx on public.favorites (product_id);

-- ============================================================
-- 2. Row Level Security
--
-- A user can only see, add, and remove their own favorites. UPDATE is
-- intentionally not supported (there is nothing to update on a favorite —
-- you add or remove it), so no UPDATE grant/policy exists at all.
-- ============================================================

alter table public.favorites enable row level security;

revoke all on public.favorites from anon, authenticated;
grant select, insert, delete on public.favorites to authenticated;

drop policy if exists favorites_select_own on public.favorites;
create policy favorites_select_own
  on public.favorites
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists favorites_insert_own on public.favorites;
create policy favorites_insert_own
  on public.favorites
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists favorites_delete_own on public.favorites;
create policy favorites_delete_own
  on public.favorites
  for delete
  to authenticated
  using (user_id = auth.uid());

-- No UPDATE policy/grant, and no access at all for anon: guests can never
-- read, add, or remove favorites, and no client can ever see or modify
-- another user's favorites.
