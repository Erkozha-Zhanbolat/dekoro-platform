-- DEKORO Platform V2 — Staff Platform
-- Migration: staff role-check helpers + read-only staff access to orders
--
-- Depends on:
--   001_companies_and_profiles.sql (public.user_role enum, public.profiles)
--   005_orders.sql (public.orders, public.order_items)
--
-- Run this file once in the Supabase SQL Editor after 009
-- (see supabase/README.md). Not executed automatically, not applied by
-- this change — apply by hand when ready.
--
-- Purpose: introduce the minimum needed for a read-only internal Staff
-- Platform (/staff, /staff/orders, /staff/orders/[id]):
--   1. public.get_my_role() — resolves the caller's public.profiles.role.
--   2. public.has_staff_role(allowed_roles) — checks the caller's role
--      against an allow-list, used by RLS policies below.
--   3. New SELECT policies on public.orders / public.order_items that let
--      manager / accountant / warehouse / admin read ALL rows, in addition
--      to (never replacing) the existing "own rows only" client policies.
--
-- Explicitly NOT done here (future steps):
--   - no changes to create_order() / cancel_order() — untouched;
--   - no order status changes, no new order status values;
--   - no INSERT/UPDATE/DELETE policy or RPC for staff — all writes stay
--     client-owned (create_order/cancel_order) until a later migration
--     introduces staff-facing RPCs (confirm_order, etc.);
--   - no broadened access to public.profiles or public.companies for staff
--     (still only "select own row" for everyone, unchanged);
--   - no broadened access to inventory / inventory_reservations;
--   - no employee creation, no role assignment RPC — roles are set by hand
--     in the SQL Editor for this step (see supabase/README.md);
--   - no service_role usage anywhere in this migration.
--
-- No structural changes to any existing table. RLS stays enabled
-- everywhere; only new policies are added, none are dropped except their
-- own same-named policy (for safe re-runs).

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception
      'public.profiles is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if not exists (
    select 1
    from pg_type as t
    join pg_namespace as n on n.oid = t.typnamespace
    where t.typname = 'user_role' and n.nspname = 'public'
  ) then
    raise exception
      'public.user_role enum is missing — run supabase/migrations/001_companies_and_profiles.sql first.';
  end if;

  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run supabase/migrations/005_orders.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. public.get_my_role(): the caller's own role, or null
--
-- SECURITY DEFINER with search_path locked to '' (empty) — every identifier
-- below is schema-qualified so name resolution can never be hijacked by a
-- caller-controlled search_path. STABLE (not VOLATILE): safe to call
-- multiple times within one statement/query plan.
--
-- Returns null for an unauthenticated caller (auth.uid() is null) and for
-- an authenticated user with no profiles row — callers must treat null as
-- "no role", never as a role to compare against.
--
-- Runs as the function owner (same SECURITY DEFINER pattern already used
-- by update_my_profile() / create_order() / cancel_order() in this
-- project), so it reads public.profiles directly without going through
-- profiles' own RLS — this is what avoids the classic recursive-RLS trap
-- (a policy on profiles that itself queries profiles).
-- ============================================================

create or replace function public.get_my_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles as p
  where p.id = auth.uid();
$$;

revoke all on function public.get_my_role() from public;
grant execute on function public.get_my_role() to authenticated;

-- ============================================================
-- 2. public.has_staff_role(allowed_roles): role allow-list check
--
-- Takes a plain array (not VARIADIC) — a fixed, non-variadic signature is
-- the more reliable shape to call from RLS policies across Postgres/
-- PostgREST versions. Returns false (never null) so it can be used
-- directly in a `using (...)` clause without an extra `coalesce`.
-- ============================================================

create or replace function public.has_staff_role(allowed_roles public.user_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.get_my_role() = any(allowed_roles), false);
$$;

revoke all on function public.has_staff_role(public.user_role[]) from public;
grant execute on function public.has_staff_role(public.user_role[]) to authenticated;

-- ============================================================
-- 3. Row Level Security — staff read access to orders / order_items
--
-- Additive only: the existing client policies (orders_select_own,
-- order_items_select_own from 005_orders.sql) are untouched. These new
-- policies are combined with OR by Postgres (multiple permissive policies
-- for the same command), so a client keeps seeing exactly their own
-- orders and staff additionally see every order, never fewer rows than
-- before for anyone.
--
-- No new table grant is needed: `grant select on public.orders/order_items
-- to authenticated` already exists from 005_orders.sql and covers this.
--
-- RLS is already enabled on both tables (005_orders.sql), but re-asserting
-- it here is idempotent and makes this migration safe to review/run on its
-- own without relying on that assumption.
--
-- has_staff_role(...) is wrapped in `(select ...)` in each policy: this is
-- the documented Postgres/Supabase pattern for hoisting a STABLE function
-- call into an initPlan, so it is evaluated once per query instead of once
-- per row.
-- ============================================================

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists orders_select_staff on public.orders;
create policy orders_select_staff
  on public.orders
  for select
  to authenticated
  using (
    (select public.has_staff_role(array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]))
  );

drop policy if exists order_items_select_staff on public.order_items;
create policy order_items_select_staff
  on public.order_items
  for select
  to authenticated
  using (
    (select public.has_staff_role(array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]))
  );

-- ============================================================
-- 4. Notes
--
-- - public.profiles and public.companies are intentionally NOT touched by
--   this migration: staff still only sees their own profile/company row,
--   exactly as before. Order detail pages rely on the contact_name /
--   contact_phone / contact_email / delivery_* snapshot columns already on
--   public.orders (from 007_checkout_order_details.sql) instead of joining
--   profiles/companies.
-- - No INSERT/UPDATE/DELETE policy is added anywhere in this migration —
--   staff can only read. All future status transitions (confirm, ship,
--   mark paid, etc.) will go through dedicated SECURITY DEFINER RPCs in a
--   later migration, the same pattern as create_order()/cancel_order().
-- - create_order() and cancel_order() are completely unmodified by this
--   migration — client checkout/cancel behavior is unaffected.
-- - No service_role used anywhere in this migration.
-- - To grant a role for manual testing, run (as a Supabase admin, in the
--   SQL Editor):
--     update public.profiles set role = 'manager' where id = '<user-uuid>';
--   (see supabase/README.md for the full test procedure).
-- ============================================================
