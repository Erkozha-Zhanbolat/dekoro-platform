-- DEKORO Platform V1
-- Migration: cancel_order() — safely release an order's inventory reservation
--
-- Depends on:
--   002_catalog_inventory_pricing.sql (public.warehouses, public.inventory)
--   005_orders.sql (public.orders, public.order_items)
--   008_reserve_inventory_on_order.sql (public.inventory_reservations;
--     create_order() reserves inventory.reserved_quantity and records one
--     'active' inventory_reservations row per order line)
--
-- Run this file once in the Supabase SQL Editor after 008
-- (see supabase/README.md). Not executed automatically, not applied by
-- this change — apply by hand when ready.
--
-- Purpose: create_order() (008) reserves stock and records exactly how
-- much in public.inventory_reservations, but nothing releases that
-- reservation yet. This migration adds public.cancel_order(p_order_id),
-- the only server-side entry point for cancelling an order: it verifies
-- ownership and status, atomically releases each of the order's *own*
-- active reservations (never inventory.reserved_quantity as a shared,
-- undifferentiated pool), marks each reservation 'released', and marks
-- the order 'cancelled' — or changes nothing at all if any step fails.
--
-- Why inventory_reservations instead of trusting inventory alone:
--   - inventory.reserved_quantity is a single aggregate number shared by
--     every order that has ever reserved that product at that warehouse.
--     It cannot, by itself, prove that *this* order is responsible for
--     any specific slice of it — subtracting from it directly (as an
--     earlier draft of this migration did, with a `greatest(x, 0)` floor)
--     could silently release a reservation that actually belongs to a
--     different order.
--   - inventory_reservations gives every order's contribution its own
--     row, so cancel_order() only ever reads and releases rows that carry
--     this exact order_id.
--   - Orders created before 008 (or any order whose items were, for
--     whatever reason, never actually reserved) simply have no 'active'
--     inventory_reservations row. cancel_order() detects that up front
--     and refuses to touch inventory at all for such an order — it fails
--     with a clear error instead of quietly decrementing
--     reserved_quantity that this order never owned.
--   - Each reservation row also carries its own warehouse_id (recorded at
--     creation time by create_order()), so cancel_order() never has to
--     re-derive or assume which warehouse an order's stock came from.
--
-- Explicitly NOT done here (future steps):
--   - decrementing quantity (physical stock never changes here or in
--     create_order() — only reserved_quantity does);
--   - reservation across multiple warehouses;
--   - manager/staff cancelling another user's order (no admin panel yet —
--     only the order's own owner may cancel it in this version);
--   - cancelling orders in any status other than 'new';
--   - any frontend change.
--
-- No new tables. No structural changes to orders/order_items/warehouses/
-- inventory/inventory_reservations. No service_role. RLS/grants on those
-- tables are untouched — clients still cannot update orders or write
-- inventory/inventory_reservations directly; cancel_order() (SECURITY
-- DEFINER) is the only path that changes any of them.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run supabase/migrations/005_orders.sql first.';
  end if;

  if to_regclass('public.warehouses') is null or to_regclass('public.inventory') is null then
    raise exception
      'public.warehouses / public.inventory missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regclass('public.inventory_reservations') is null then
    raise exception
      'public.inventory_reservations is missing — run supabase/migrations/008_reserve_inventory_on_order.sql first.';
  end if;

  if to_regprocedure('public.create_order(jsonb, text, text, text, text, text, text, text)') is null then
    raise exception
      'public.create_order(...) is missing — run supabase/migrations/006/007/008 first.';
  end if;
end
$$;

-- ============================================================
-- 1. cancel_order(p_order_id uuid)
--
-- Authorization: the caller must be the order's own owner
-- (auth.uid() = orders.user_id), the same identity RLS already scopes
-- orders_select_own to. There is no manager/staff override yet — that
-- needs an admin panel and a role check, both out of scope here.
--
-- Only orders with status = 'new' can be cancelled (nothing has shipped
-- or been confirmed yet); any other status is rejected with a clear
-- error and no side effects.
-- ============================================================

create or replace function public.cancel_order(p_order_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_has_active_reservation boolean;
  v_reservation record;
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
  v_result_id uuid;
  v_result_order_number text;
  v_result_status text;
  v_result_updated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  -- --- lock the order first ---------------------------------------------
  -- Locking here (before the status check) is what makes double-cancel
  -- and cancel-vs-create races safe: a concurrent cancel_order() call for
  -- the same order blocks on this SELECT ... FOR UPDATE until the first
  -- call commits or rolls back, then re-reads the now-current row —
  -- never a stale one — before deciding anything.
  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.user_id <> v_user_id then
    raise exception 'Недостаточно прав для отмены этого заказа';
  end if;

  if v_order.status <> 'new' then
    raise exception
      'Отменить можно только заказ со статусом "new" (текущий статус: %)', v_order.status;
  end if;

  -- --- this order must own at least one active reservation ---------------
  -- Protects orders created before 008 (or any order whose lines were,
  -- for any reason, never actually reserved): if there is no 'active'
  -- inventory_reservations row for this order, there is nothing this
  -- order can prove it owns in inventory.reserved_quantity, so inventory
  -- is left completely untouched and the whole call fails with a clear
  -- error instead of guessing.
  select exists (
    select 1
    from public.inventory_reservations as r
    where r.order_id = v_order.id and r.status = 'active'
  ) into v_has_active_reservation;

  if not v_has_active_reservation then
    raise exception
      'У заказа нет активного резерва склада — отмена с освобождением остатка невозможна';
  end if;

  -- --- lock + release each of this order's own active reservations ------
  -- Only rows carrying this exact order_id are ever touched — never
  -- inventory.reserved_quantity as an undifferentiated pool. Deterministic
  -- product_id order matches create_order()'s own reservation loop (008),
  -- so a cancel_order() racing a create_order() (or another
  -- cancel_order()) over the same products always requests row locks in
  -- the same relative order — avoiding deadlocks.
  for v_reservation in
    select r.id, r.warehouse_id, r.product_id, r.quantity
    from public.inventory_reservations as r
    where r.order_id = v_order.id and r.status = 'active'
    order by r.product_id
    for update
  loop
    select i.reserved_quantity into v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id
    for update;

    if not found then
      -- The reservation row says stock was reserved here, but the
      -- inventory row itself is gone — a genuine data inconsistency, not
      -- something to paper over. Abort rather than silently skip it.
      raise exception
        'Складская запись для товара % не найдена, отмена невозможна', v_reservation.product_id;
    end if;

    -- Strict check, no floor/greatest(): this order's own reservation can
    -- never legitimately exceed the row's current reserved_quantity. If
    -- it does, something else already violated that invariant, and this
    -- function must fail loudly instead of masking it.
    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара %: зарезервировано % меньше, чем требуется освободить (%)',
        v_reservation.product_id, v_inv_reserved, v_reservation.quantity;
    end if;

    update public.inventory as i
    set
      reserved_quantity = i.reserved_quantity - v_reservation.quantity,
      updated_at = now()
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id;

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось снять резерв товара %', v_reservation.product_id;
    end if;

    update public.inventory_reservations as r
    set status = 'released',
        released_at = now()
    where r.id = v_reservation.id
      and r.status = 'active';

    get diagnostics v_affected_rows = row_count;

    if v_affected_rows <> 1 then
      raise exception
        'Не удалось освободить резерв товара % для заказа %',
        v_reservation.product_id,
        v_order.order_number;
    end if;
  end loop;

  -- --- mark the order cancelled ------------------------------------------
  -- Only reached once every one of this order's reservations has been
  -- verified and released above. quantity (physical stock) is never
  -- touched by this function — only reserved_quantity changes, exactly
  -- mirroring create_order(): stock is only ever decremented by a future
  -- physical shipment step.
  update public.orders as o
  set status = 'cancelled'
  where o.id = v_order.id
  returning o.id, o.order_number, o.status, o.updated_at
  into v_result_id, v_result_order_number, v_result_status, v_result_updated_at;

  return query
  select v_result_id, v_result_order_number, v_result_status, v_result_updated_at;
end;
$$;

revoke all on function public.cancel_order(uuid) from public;
grant execute on function public.cancel_order(uuid) to authenticated;

-- ============================================================
-- 2. Notes
--
-- - Any RAISE inside this function aborts the whole transaction: neither
--   the orders.status change, nor any inventory.reserved_quantity change,
--   nor any inventory_reservations.status change is committed. No manual
--   BEGIN/COMMIT is used anywhere — this relies entirely on PostgreSQL's
--   implicit "one function call = one transaction" semantics.
-- - Calling cancel_order() twice for the same order: the first call locks
--   the order row, finds status = 'new' and an active reservation,
--   releases it (inventory.reserved_quantity decreases, the
--   inventory_reservations row flips to 'released'), and sets
--   orders.status = 'cancelled'. A second call (sequential or concurrent)
--   locks the same order row, sees status = 'cancelled' once it acquires
--   the lock, and raises before even looking at inventory_reservations
--   again — the reservation is released exactly once no matter how many
--   times cancel_order() is called. The has-active-reservation check adds
--   a second, independent layer of protection: even if this function were
--   ever reached for an order whose reservations were already all
--   'released', it would find zero active rows and refuse to touch
--   inventory rather than re-releasing anything.
-- - The warehouse for each line comes from inventory_reservations.warehouse_id
--   — recorded once by create_order() at reservation time — never
--   re-derived or assumed by cancel_order() itself.
-- - quantity (physical stock) is never modified here, matching
--   create_order() (008): only reserved_quantity moves at order/cancel
--   time; quantity only ever changes at a future physical shipment step.
-- - Clients still cannot UPDATE orders or write inventory/
--   inventory_reservations directly — no RLS policy or grant is added for
--   that; cancel_order() (SECURITY DEFINER) is the only path that changes
--   any of them.
-- - No service_role used anywhere in this migration.
-- - No frontend change: nothing yet calls cancel_order() from the app.
-- ============================================================
