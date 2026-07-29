-- DEKORO Platform V2 — Staff Platform
-- Migration: order workflow from creation to shipment (security-hardened)
--
-- Depends on:
--   001_companies_and_profiles.sql
--   002_catalog_inventory_pricing.sql
--   005_orders.sql
--   008_reserve_inventory_on_order.sql
--   009_cancel_order_release_reservation.sql (cancel_order left untouched)
--   010_staff_role_access.sql
--   011_staff_manual_orders.sql
--
-- Apply by hand in the Supabase SQL Editor after 011. NOT auto-applied.
--
-- Security model for new workflow tables:
--   - RLS enabled
--   - NO SELECT/INSERT/UPDATE/DELETE grants to anon or authenticated
--   - reads/writes only via SECURITY DEFINER staff RPCs
--   - helpers: REVOKE ALL from PUBLIC/anon/authenticated, no GRANT
--   - public RPCs: REVOKE ALL from PUBLIC/anon/authenticated, then
--     GRANT EXECUTE TO authenticated (role checks inside the function)
--
-- Explicitly NOT done:
--   - walk-in customers / customers entity
--   - payment gateways
--   - warehouse role UI
--   - changes to create_order() / cancel_order()
--   - service_role
--   - edits to migrations 010 / 011 files

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run 005 first.';
  end if;

  if to_regclass('public.inventory') is null or to_regclass('public.warehouses') is null then
    raise exception
      'public.inventory / public.warehouses missing — run 002 first.';
  end if;

  if to_regclass('public.inventory_reservations') is null then
    raise exception
      'public.inventory_reservations missing — run 008 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception
      'public.has_staff_role(...) missing — run 010 first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception
      'public.staff_resolve_warehouse_id() missing — run 011 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Diagnostic census + legacy status remap
--
-- Old CHECK (005): status in ('new','processing','completed','cancelled')
-- New CHECK: new|awaiting_payment|paid|picking|ready_for_shipment|
--            shipped|completed|cancelled
-- Sequence: diagnose → fail on unknown → drop old CHECK → map
--           processing→awaiting_payment → add new CHECK.
-- ============================================================

do $$
declare
  r record;
  v_unexpected text;
  v_processing_count bigint;
  v_new_count bigint;
  v_completed_count bigint;
  v_cancelled_count bigint;
  v_total bigint;
  v_known_legacy text[] := array['new', 'processing', 'completed', 'cancelled'];
begin
  select count(*) into v_total from public.orders;
  raise notice '012 diagnostic: total orders = %', v_total;

  for r in
    select o.status, count(*)::bigint as cnt
    from public.orders as o
    group by o.status
    order by o.status
  loop
    raise notice '012 diagnostic: status % = %', r.status, r.cnt;
  end loop;

  select string_agg(distinct o.status, ', ' order by o.status)
  into v_unexpected
  from public.orders as o
  where o.status is null
     or o.status <> all (v_known_legacy);

  if v_unexpected is not null then
    raise exception
      '012 aborted: unexpected orders.status values before remap: %. Resolve manually before re-running.',
      v_unexpected;
  end if;

  select count(*) into v_new_count from public.orders where status = 'new';
  select count(*) into v_processing_count from public.orders where status = 'processing';
  select count(*) into v_completed_count from public.orders where status = 'completed';
  select count(*) into v_cancelled_count from public.orders where status = 'cancelled';

  raise notice
    '012 diagnostic summary: new=%, processing(→awaiting_payment)=%, completed(keep)=%, cancelled(keep)=%',
    v_new_count, v_processing_count, v_completed_count, v_cancelled_count;

  -- 1) Drop old CHECK so remapped values can be written.
  alter table public.orders drop constraint if exists orders_status_check;

  -- 2) Remap legacy "in progress" bucket.
  update public.orders
  set status = 'awaiting_payment'
  where status = 'processing';

  get diagnostics v_processing_count = row_count;
  raise notice '012 remap: updated % row(s) processing → awaiting_payment', v_processing_count;

  -- 3) Install new CHECK. Any residual unexpected value fails here.
  alter table public.orders
    add constraint orders_status_check check (
      status in (
        'new',
        'awaiting_payment',
        'paid',
        'picking',
        'ready_for_shipment',
        'shipped',
        'completed',
        'cancelled'
      )
    );
end
$$;

-- ============================================================
-- 2. Workflow columns on orders (NO internal_notes column)
-- ============================================================

alter table public.orders
  add column if not exists assigned_manager_id uuid
    references public.profiles (id) on delete set null,
  add column if not exists payment_due_at timestamptz,
  add column if not exists reservation_expires_at timestamptz;

create index if not exists orders_assigned_manager_id_idx
  on public.orders (assigned_manager_id);
create index if not exists orders_payment_due_at_idx
  on public.orders (payment_due_at);
create index if not exists orders_reservation_expires_at_idx
  on public.orders (reservation_expires_at);

comment on column public.orders.assigned_manager_id is
  'Responsible manager/admin (profiles.id). Mutated only via staff_assign_order_manager().';
comment on column public.orders.payment_due_at is
  'Manual payment deadline. Mutated only via staff_update_order_deadlines().';
comment on column public.orders.reservation_expires_at is
  'Reservation follow-up deadline. Mutated only via staff_update_order_deadlines().';

-- ============================================================
-- 3. order_status_history — RPC-only (no table grants)
-- ============================================================

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid not null references public.profiles (id) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  constraint order_status_history_to_status_not_blank
    check (length(trim(to_status)) > 0)
);

create index if not exists order_status_history_order_id_created_at_idx
  on public.order_status_history (order_id, created_at desc);

alter table public.order_status_history enable row level security;
drop policy if exists order_status_history_select_staff on public.order_status_history;
revoke all on table public.order_status_history from public;
revoke all on table public.order_status_history from anon;
revoke all on table public.order_status_history from authenticated;
-- Intentionally NO GRANT and NO policies: access only via SECURITY DEFINER RPCs.

-- ============================================================
-- 4. order_internal_notes — append-only history of staff notes
-- ============================================================

create table if not exists public.order_internal_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  body text not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint order_internal_notes_body_not_blank check (length(trim(body)) > 0),
  constraint order_internal_notes_body_max_length check (char_length(body) <= 5000)
);

create index if not exists order_internal_notes_order_id_created_at_idx
  on public.order_internal_notes (order_id, created_at desc);

alter table public.order_internal_notes enable row level security;
revoke all on table public.order_internal_notes from public;
revoke all on table public.order_internal_notes from anon;
revoke all on table public.order_internal_notes from authenticated;
-- Intentionally NO GRANT and NO policies.

-- ============================================================
-- 4b. order_activity_log — non-status staff activity (RPC-only)
-- ============================================================

create table if not exists public.order_activity_log (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  event_type text not null,
  description text,
  metadata jsonb,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint order_activity_log_event_type_check check (
    event_type in ('manager_assigned', 'manager_unassigned', 'deadlines_updated')
  )
);

create index if not exists order_activity_log_order_id_created_at_idx
  on public.order_activity_log (order_id, created_at desc);

alter table public.order_activity_log enable row level security;
revoke all on table public.order_activity_log from public;
revoke all on table public.order_activity_log from anon;
revoke all on table public.order_activity_log from authenticated;
-- Intentionally NO GRANT and NO policies: access only via SECURITY DEFINER RPCs.

-- ============================================================
-- 5. inventory_reservations: add 'fulfilled'
--
-- Compatibility:
--   - cancel_order() / staff_cancel_order() / release helpers only touch
--     status = 'active' → never treat fulfilled as releasable
--   - staff item RPCs only select status = 'active'
--   - ON CONFLICT reactivation in staff_add_order_item resets released
--     rows; fulfilled rows cannot reappear on editable orders because
--     item edits are blocked from paid onward, and cancel of shipped is
--     forbidden so fulfilled stock is never "re-released"
-- ============================================================

alter table public.inventory_reservations
  drop constraint if exists inventory_reservations_status_check;

alter table public.inventory_reservations
  drop constraint if exists inventory_reservations_released_at_matches_status;

alter table public.inventory_reservations
  add constraint inventory_reservations_status_check check (
    status in ('active', 'released', 'fulfilled')
  );

alter table public.inventory_reservations
  add constraint inventory_reservations_released_at_matches_status check (
    (status = 'active' and released_at is null)
    or (status in ('released', 'fulfilled') and released_at is not null)
  );

-- ============================================================
-- 6. Internal helpers (NO execute grant to authenticated)
-- ============================================================

create or replace function public.staff_record_order_status_change(
  p_order_id uuid,
  p_from_status text,
  p_to_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  insert into public.order_status_history (
    order_id, from_status, to_status, changed_by, note
  ) values (
    p_order_id,
    p_from_status,
    p_to_status,
    v_uid,
    nullif(trim(coalesce(p_note, '')), '')
  );
end;
$$;

revoke all on function public.staff_record_order_status_change(uuid, text, text, text) from public;
revoke all on function public.staff_record_order_status_change(uuid, text, text, text) from anon;
revoke all on function public.staff_record_order_status_change(uuid, text, text, text) from authenticated;

create or replace function public.staff_record_order_activity(
  p_order_id uuid,
  p_event_type text,
  p_description text default null,
  p_metadata jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_event_type is null
     or p_event_type not in ('manager_assigned', 'manager_unassigned', 'deadlines_updated')
  then
    raise exception 'Недопустимый event_type: %', p_event_type;
  end if;

  insert into public.order_activity_log (
    order_id, event_type, description, metadata, created_by
  ) values (
    p_order_id,
    p_event_type,
    nullif(trim(coalesce(p_description, '')), ''),
    p_metadata,
    v_uid
  );
end;
$$;

revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb) from public;
revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb) from anon;
revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb) from authenticated;

create or replace function public.staff_assert_active_reservations_consistent(
  p_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_reservation public.inventory_reservations;
  v_warehouse_id uuid;
  v_inv_reserved numeric(14, 3);
  v_item_count integer;
  v_active_for_product integer;
  v_expected_subtotal numeric(14, 2);
  v_expected_total numeric(14, 2);
  v_order public.orders;
begin
  -- Caller must already hold FOR UPDATE on the order row.
  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.total is null then
    raise exception 'total заказа не задан';
  end if;

  if v_order.total < 0 then
    raise exception 'total заказа не может быть отрицательным (%)', v_order.total;
  end if;

  select count(*) into v_item_count
  from public.order_items as oi
  where oi.order_id = p_order_id;

  if v_item_count < 1 then
    raise exception 'Заказ должен содержать минимум одну позицию';
  end if;

  select coalesce(sum(oi.line_total), 0)::numeric(14, 2) into v_expected_subtotal
  from public.order_items as oi
  where oi.order_id = p_order_id;

  if v_order.subtotal is distinct from v_expected_subtotal then
    raise exception
      'Некорректный subtotal заказа: в заказе %, по позициям %',
      v_order.subtotal, v_expected_subtotal;
  end if;

  v_expected_total := v_expected_subtotal - coalesce(v_order.discount, 0);
  if v_order.total is distinct from v_expected_total then
    raise exception
      'Некорректный total заказа: в заказе %, ожидается %',
      v_order.total, v_expected_total;
  end if;

  -- ALMATY-01 via staff_resolve_warehouse_id()
  v_warehouse_id := public.staff_resolve_warehouse_id();

  for v_item in
    select oi.id, oi.product_id, oi.product_name, oi.quantity
    from public.order_items as oi
    where oi.order_id = p_order_id
    order by oi.product_id
  loop
    select count(*) into v_active_for_product
    from public.inventory_reservations as r
    where r.order_id = p_order_id
      and r.product_id = v_item.product_id
      and r.status = 'active';

    if v_active_for_product <> 1 then
      raise exception
        'Для товара % ожидается ровно 1 active reservation, найдено %',
        v_item.product_name, v_active_for_product;
    end if;

    select * into v_reservation
    from public.inventory_reservations as r
    where r.order_id = p_order_id
      and r.product_id = v_item.product_id
      and r.status = 'active'
    for update;

    if v_reservation.product_id is distinct from v_item.product_id then
      raise exception 'product_id резерва не совпадает с позицией заказа';
    end if;

    if v_reservation.quantity is distinct from v_item.quantity::numeric(14, 3) then
      raise exception
        'Количество резерва не совпадает с позицией для товара %: резерв %, позиция %',
        v_item.product_name, v_reservation.quantity, v_item.quantity;
    end if;

    if v_reservation.warehouse_id is distinct from v_warehouse_id then
      raise exception
        'Резерв товара % относится не к складу ALMATY-01', v_item.product_name;
    end if;

    select i.reserved_quantity into v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_item.product_id
    for update;

    if not found then
      raise exception 'Складская запись для товара % не найдена', v_item.product_name;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'inventory.reserved_quantity (%) меньше резерва (%) для товара %',
        v_inv_reserved, v_reservation.quantity, v_item.product_name;
    end if;
  end loop;

  if exists (
    select 1
    from public.inventory_reservations as r
    where r.order_id = p_order_id
      and r.status = 'active'
      and not exists (
        select 1
        from public.order_items as oi
        where oi.order_id = p_order_id and oi.product_id = r.product_id
      )
  ) then
    raise exception 'Обнаружен лишний active reservation без позиции заказа';
  end if;
end;
$$;

revoke all on function public.staff_assert_active_reservations_consistent(uuid) from public;
revoke all on function public.staff_assert_active_reservations_consistent(uuid) from anon;
revoke all on function public.staff_assert_active_reservations_consistent(uuid) from authenticated;


create or replace function public.staff_release_order_reservations(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation record;
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
begin
  -- Only status = 'active' — fulfilled/released are never touched.
  for v_reservation in
    select r.id, r.warehouse_id, r.product_id, r.quantity
    from public.inventory_reservations as r
    where r.order_id = p_order_id and r.status = 'active'
    order by r.product_id
    for update
  loop
    select i.reserved_quantity into v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id
    for update;

    if not found then
      raise exception
        'Складская запись для товара % не найдена, отмена невозможна',
        v_reservation.product_id;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара %: reserved % < release %',
        v_reservation.product_id, v_inv_reserved, v_reservation.quantity;
    end if;

    update public.inventory as i
    set reserved_quantity = i.reserved_quantity - v_reservation.quantity,
        updated_at = now()
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id
      and i.reserved_quantity >= v_reservation.quantity;

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
      raise exception 'Не удалось освободить резерв товара %', v_reservation.product_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.staff_release_order_reservations(uuid) from public;
revoke all on function public.staff_release_order_reservations(uuid) from anon;
revoke all on function public.staff_release_order_reservations(uuid) from authenticated;


create or replace function public.staff_fulfill_order_reservations(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation record;
  v_inv_quantity numeric(14, 3);
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
  v_active_count integer;
begin
  select count(*) into v_active_count
  from public.inventory_reservations as r
  where r.order_id = p_order_id and r.status = 'active';

  if v_active_count < 1 then
    raise exception
      'Нет активных резервов для отгрузки — повторное списание невозможно';
  end if;

  perform public.staff_assert_active_reservations_consistent(p_order_id);

  for v_reservation in
    select r.id, r.warehouse_id, r.product_id, r.quantity
    from public.inventory_reservations as r
    where r.order_id = p_order_id and r.status = 'active'
    order by r.product_id
    for update
  loop
    select i.quantity, i.reserved_quantity
    into v_inv_quantity, v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id
    for update;

    if not found then
      raise exception 'Складская запись для товара % не найдена', v_reservation.product_id;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара % при отгрузке: reserved %, требуется %',
        v_reservation.product_id, v_inv_reserved, v_reservation.quantity;
    end if;

    if v_inv_quantity < v_reservation.quantity then
      raise exception
        'Недостаточно физического остатка товара %: quantity %, требуется %',
        v_reservation.product_id, v_inv_quantity, v_reservation.quantity;
    end if;

    update public.inventory as i
    set quantity = i.quantity - v_reservation.quantity,
        reserved_quantity = i.reserved_quantity - v_reservation.quantity,
        updated_at = now()
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id
      and i.quantity >= v_reservation.quantity
      and i.reserved_quantity >= v_reservation.quantity;

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось списать товар % (защита от минуса)', v_reservation.product_id;
    end if;

    update public.inventory_reservations as r
    set status = 'fulfilled',
        released_at = now()
    where r.id = v_reservation.id
      and r.status = 'active';

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось отметить резерв товара % как fulfilled', v_reservation.product_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.staff_fulfill_order_reservations(uuid) from public;
revoke all on function public.staff_fulfill_order_reservations(uuid) from anon;
revoke all on function public.staff_fulfill_order_reservations(uuid) from authenticated;


create or replace function public.staff_is_status_transition_allowed(
  p_from text,
  p_to text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_from = 'new' and p_to = 'awaiting_payment' then true
    when p_from = 'awaiting_payment' and p_to in ('paid', 'new') then true
    when p_from = 'paid' and p_to = 'picking' then true
    when p_from = 'picking' and p_to in ('ready_for_shipment', 'paid') then true
    when p_from = 'ready_for_shipment' and p_to in ('shipped', 'picking') then true
    when p_from = 'shipped' and p_to = 'completed' then true
    else false
  end;
$$;

revoke all on function public.staff_is_status_transition_allowed(text, text) from public;
revoke all on function public.staff_is_status_transition_allowed(text, text) from anon;
revoke all on function public.staff_is_status_transition_allowed(text, text) from authenticated;

-- ============================================================
-- 7. Public staff RPCs
-- ============================================================

create or replace function public.staff_change_order_status(
  p_order_id uuid,
  p_new_status text,
  p_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_from text;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения статуса заказа';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_new_status is null or length(trim(p_new_status)) = 0 then
    raise exception 'Новый статус обязателен';
  end if;

  if p_new_status = 'cancelled' then
    raise exception 'Для отмены используйте public.staff_cancel_order(...)';
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  v_from := v_order.status;

  if v_from in ('completed', 'cancelled') then
    raise exception 'Заказ в финальном статусе "%" нельзя изменить', v_from;
  end if;

  if not public.staff_is_status_transition_allowed(v_from, p_new_status) then
    raise exception 'Переход статуса "%" → "%" запрещён', v_from, p_new_status;
  end if;

  -- Explicitly forbid reverse shipment (also covered by matrix above).
  if v_from = 'shipped' and p_new_status = 'ready_for_shipment' then
    raise exception 'Возврат shipped → ready_for_shipment запрещён: товар уже списан';
  end if;

  if p_new_status = 'awaiting_payment' then
    if not exists (select 1 from public.order_items as oi where oi.order_id = p_order_id) then
      raise exception 'Нельзя отправить на оплату пустой заказ';
    end if;
    perform public.staff_assert_active_reservations_consistent(p_order_id);
  end if;

  if v_from = 'awaiting_payment' and p_new_status = 'paid' then
    perform public.staff_assert_active_reservations_consistent(p_order_id);
  end if;

  if v_from = 'ready_for_shipment' and p_new_status = 'shipped' then
    -- Atomic write-off BEFORE status flip; abort rolls both back.
    perform public.staff_fulfill_order_reservations(p_order_id);
  end if;

  update public.orders as o
  set status = p_new_status
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_status_change(
    p_order_id, v_from, p_new_status, p_note
  );

  return v_order;
end;
$$;

revoke all on function public.staff_change_order_status(uuid, text, text) from public;
revoke all on function public.staff_change_order_status(uuid, text, text) from anon;
revoke all on function public.staff_change_order_status(uuid, text, text) from authenticated;
grant execute on function public.staff_change_order_status(uuid, text, text) to authenticated;


create or replace function public.staff_cancel_order(
  p_order_id uuid,
  p_note text
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_from text;
  v_role public.user_role;
  v_can_cancel boolean := false;
  v_reason text;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для отмены заказа';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  v_reason := trim(coalesce(p_note, ''));
  if v_reason = '' then
    raise exception 'Причина отмены обязательна';
  end if;
  if char_length(v_reason) > 2000 then
    raise exception 'Причина отмены слишком длинная (макс. 2000 символов)';
  end if;

  v_role := public.get_my_role();

  select * into v_order from public.orders as o where o.id = p_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  v_from := v_order.status;

  if v_from in ('shipped', 'completed', 'cancelled') then
    raise exception 'Заказ в статусе "%" нельзя отменить', v_from;
  end if;

  if v_from in ('new', 'awaiting_payment') then
    v_can_cancel := true;
  elsif v_from in ('paid', 'picking', 'ready_for_shipment') then
    v_can_cancel := (v_role = 'admin');
  end if;

  if not v_can_cancel then
    raise exception
      'Отмена из статуса "%" доступна только администратору', v_from;
  end if;

  -- Releases only active reservations (fulfilled never reached here).
  perform public.staff_release_order_reservations(p_order_id);

  update public.orders as o
  set status = 'cancelled'
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_status_change(
    p_order_id, v_from, 'cancelled', v_reason
  );

  return v_order;
end;
$$;

revoke all on function public.staff_cancel_order(uuid, text) from public;
revoke all on function public.staff_cancel_order(uuid, text) from anon;
revoke all on function public.staff_cancel_order(uuid, text) from authenticated;
grant execute on function public.staff_cancel_order(uuid, text) to authenticated;


create or replace function public.staff_add_order_note(
  p_order_id uuid,
  p_body text
)
returns public.order_internal_notes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_body text;
  v_note public.order_internal_notes;
  v_uid uuid := auth.uid();
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для добавления заметки';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  v_body := trim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'Пустая заметка запрещена';
  end if;
  if char_length(v_body) > 5000 then
    raise exception 'Заметка слишком длинная (макс. 5000 символов)';
  end if;

  select o.id into v_order_id
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  insert into public.order_internal_notes (order_id, body, created_by)
  values (p_order_id, v_body, v_uid)
  returning * into v_note;

  return v_note;
end;
$$;

revoke all on function public.staff_add_order_note(uuid, text) from public;
revoke all on function public.staff_add_order_note(uuid, text) from anon;
revoke all on function public.staff_add_order_note(uuid, text) from authenticated;
grant execute on function public.staff_add_order_note(uuid, text) to authenticated;


create or replace function public.staff_list_order_internal_notes(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  body text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра заметок';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    n.id,
    n.order_id,
    n.body,
    n.created_by,
    p.full_name,
    n.created_at,
    n.updated_at
  from public.order_internal_notes as n
  left join public.profiles as p on p.id = n.created_by
  where n.order_id = p_order_id
  order by n.created_at desc;
end;
$$;

revoke all on function public.staff_list_order_internal_notes(uuid) from public;
revoke all on function public.staff_list_order_internal_notes(uuid) from anon;
revoke all on function public.staff_list_order_internal_notes(uuid) from authenticated;
grant execute on function public.staff_list_order_internal_notes(uuid) to authenticated;


create or replace function public.staff_list_order_status_history(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  from_status text,
  to_status text,
  changed_by uuid,
  changed_by_name text,
  note text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра истории статусов';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    h.id,
    h.order_id,
    h.from_status,
    h.to_status,
    h.changed_by,
    p.full_name,
    h.note,
    h.created_at
  from public.order_status_history as h
  left join public.profiles as p on p.id = h.changed_by
  where h.order_id = p_order_id
  order by h.created_at desc;
end;
$$;

revoke all on function public.staff_list_order_status_history(uuid) from public;
revoke all on function public.staff_list_order_status_history(uuid) from anon;
revoke all on function public.staff_list_order_status_history(uuid) from authenticated;
grant execute on function public.staff_list_order_status_history(uuid) to authenticated;


create or replace function public.staff_assign_order_manager(
  p_order_id uuid,
  p_manager_id uuid
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_role public.user_role;
  v_uid uuid := auth.uid();
  v_target public.profiles;
  v_from_manager uuid;
  v_note text;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для назначения менеджера';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  v_role := public.get_my_role();

  select * into v_order from public.orders as o where o.id = p_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status in ('completed', 'cancelled') then
    raise exception 'Нельзя менять ответственного в финальном статусе "%"', v_order.status;
  end if;

  v_from_manager := v_order.assigned_manager_id;

  if p_manager_id is null then
    if v_role <> 'admin' then
      raise exception 'Снять назначение может только admin';
    end if;

    update public.orders as o
    set assigned_manager_id = null
    where o.id = p_order_id
    returning * into v_order;

    v_note := 'Снято назначение ответственного менеджера';
  else
    select * into v_target from public.profiles as p where p.id = p_manager_id;
    if not found then
      raise exception 'Пользователь не найден';
    end if;

    if v_target.role = 'client' then
      raise exception 'Клиента нельзя назначить ответственным';
    end if;

    if v_target.role not in ('manager', 'admin') then
      raise exception 'Ответственным можно назначить только manager или admin';
    end if;

    if v_target.is_active is not true then
      raise exception 'Нельзя назначить неактивного сотрудника';
    end if;

    if v_role = 'manager' and p_manager_id is distinct from v_uid then
      raise exception 'Менеджер может назначить ответственным только себя';
    end if;

    update public.orders as o
    set assigned_manager_id = p_manager_id
    where o.id = p_order_id
    returning * into v_order;

    v_note := format(
      'Назначен ответственный менеджер: %s (%s)',
      v_target.full_name, p_manager_id
    );
  end if;

  if p_manager_id is null then
    perform public.staff_record_order_activity(
      p_order_id,
      'manager_unassigned',
      v_note,
      jsonb_build_object('previous_manager_id', v_from_manager)
    );
  else
    perform public.staff_record_order_activity(
      p_order_id,
      'manager_assigned',
      v_note,
      jsonb_build_object(
        'previous_manager_id', v_from_manager,
        'manager_id', p_manager_id,
        'manager_name', v_target.full_name
      )
    );
  end if;

  return v_order;
end;
$$;

revoke all on function public.staff_assign_order_manager(uuid, uuid) from public;
revoke all on function public.staff_assign_order_manager(uuid, uuid) from anon;
revoke all on function public.staff_assign_order_manager(uuid, uuid) from authenticated;
grant execute on function public.staff_assign_order_manager(uuid, uuid) to authenticated;


create or replace function public.staff_update_order_deadlines(
  p_order_id uuid,
  p_payment_due_at timestamptz,
  p_reservation_expires_at timestamptz
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_payment timestamptz;
  v_reservation timestamptz;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения сроков';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status in ('completed', 'cancelled') then
    raise exception 'Нельзя менять сроки в финальном статусе "%"', v_order.status;
  end if;

  -- null = clear that deadline; non-null must not be in the past.
  v_payment := p_payment_due_at;
  v_reservation := p_reservation_expires_at;

  if v_payment is not null and v_payment < now() then
    raise exception 'Срок оплаты не может быть в прошлом';
  end if;

  if v_reservation is not null and v_reservation < now() then
    raise exception 'Срок резерва не может быть в прошлом';
  end if;

  if v_payment is not null
     and v_reservation is not null
     and v_payment > v_reservation
  then
    raise exception
      'Срок оплаты не может быть позже срока резерва';
  end if;

  update public.orders as o
  set payment_due_at = v_payment,
      reservation_expires_at = v_reservation
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_activity(
    p_order_id,
    'deadlines_updated',
    'Обновлены сроки оплаты и/или резерва',
    jsonb_build_object(
      'payment_due_at', v_payment,
      'reservation_expires_at', v_reservation
    )
  );

  return v_order;
end;
$$;

revoke all on function public.staff_update_order_deadlines(uuid, timestamptz, timestamptz) from public;
revoke all on function public.staff_update_order_deadlines(uuid, timestamptz, timestamptz) from anon;
revoke all on function public.staff_update_order_deadlines(uuid, timestamptz, timestamptz) from authenticated;
grant execute on function public.staff_update_order_deadlines(uuid, timestamptz, timestamptz) to authenticated;


create or replace function public.staff_list_assignable_managers()
returns table (
  id uuid,
  full_name text,
  role public.user_role
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_role public.user_role;
  v_uid uuid := auth.uid();
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для списка менеджеров';
  end if;

  v_role := public.get_my_role();

  if v_role = 'manager' then
    return query
    select p.id, p.full_name, p.role
    from public.profiles as p
    where p.id = v_uid
      and p.is_active
      and p.role = 'manager';
    return;
  end if;

  -- admin: all active manager/admin
  return query
  select p.id, p.full_name, p.role
  from public.profiles as p
  where p.role in ('manager', 'admin')
    and p.is_active
  order by p.full_name;
end;
$$;

revoke all on function public.staff_list_assignable_managers() from public;
revoke all on function public.staff_list_assignable_managers() from anon;
revoke all on function public.staff_list_assignable_managers() from authenticated;
grant execute on function public.staff_list_assignable_managers() to authenticated;

-- ============================================================
-- 7b. staff_list_order_activity — read activity log (RPC-only)
-- ============================================================

create or replace function public.staff_list_order_activity(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  event_type text,
  description text,
  metadata jsonb,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра активности заказа';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    a.id,
    a.order_id,
    a.event_type,
    a.description,
    a.metadata,
    a.created_by,
    p.full_name,
    a.created_at
  from public.order_activity_log as a
  left join public.profiles as p on p.id = a.created_by
  where a.order_id = p_order_id
  order by a.created_at desc;
end;
$$;

revoke all on function public.staff_list_order_activity(uuid) from public;
revoke all on function public.staff_list_order_activity(uuid) from anon;
revoke all on function public.staff_list_order_activity(uuid) from authenticated;
grant execute on function public.staff_list_order_activity(uuid) to authenticated;

-- ============================================================
-- 8. Item edit RPCs: allow awaiting_payment (replace 011 bodies)
-- ============================================================

create or replace function public.staff_add_order_item(
  p_order_id uuid,
  p_product_id uuid,
  p_quantity integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_product public.products;
  v_warehouse_id uuid;
  v_inv_quantity numeric(14, 3);
  v_inv_reserved numeric(14, 3);
  v_available numeric(14, 3);
  v_unit_price numeric(14, 2);
  v_line_total numeric(14, 2);
  v_existing_item public.order_items;
  v_existing_count integer;
  v_new_quantity integer;
  v_affected_rows integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения заказа';
  end if;

  if p_order_id is null or p_product_id is null then
    raise exception 'order_id и product_id обязательны';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество должно быть положительным целым числом';
  end if;

  -- --- lock the order first (see note above) -----------------------------
  select * into v_order from public.orders as o where o.id = p_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)', v_order.status;
  end if;

  select * into v_product from public.products as p where p.id = p_product_id;

  if not found then
    raise exception 'Товар не найден';
  end if;

  if v_product.status <> 'active' then
    raise exception 'Товар недоступен для заказа';
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  -- --- lock + check inventory ---------------------------------------------
  select i.quantity, i.reserved_quantity into v_inv_quantity, v_inv_reserved
  from public.inventory as i
  where i.warehouse_id = v_warehouse_id and i.product_id = p_product_id
  for update;

  if not found then
    -- No inventory row for this product at this warehouse: available is 0.
    -- Nothing to lock — nothing else can reserve against a row that
    -- doesn't exist — and this always fails the check just below.
    v_inv_quantity := 0;
    v_inv_reserved := 0;
  end if;

  v_available := public.staff_assert_non_negative_stock(v_inv_quantity - v_inv_reserved, v_product.name);

  if v_available < p_quantity::numeric(14, 3) then
    raise exception 'Недостаточно товара на складе: % (доступно %, требуется %)',
      v_product.name, v_available, p_quantity;
  end if;

  -- --- defense-in-depth: this product must appear at most once ------------
  -- See the "Duplicate-row safety" note above for why concurrent calls
  -- cannot create a second row; this only guards against a pre-existing
  -- duplicate slipping through unnoticed.
  select count(*) into v_existing_count
  from public.order_items as oi
  where oi.order_id = p_order_id and oi.product_id = p_product_id;

  if v_existing_count > 1 then
    raise exception
      'Обнаружено несколько позиций товара % в заказе — требуется ручная проверка данных', v_product.name;
  end if;

  -- --- add to an existing line, or insert a new one -----------------------
  select * into v_existing_item
  from public.order_items as oi
  where oi.order_id = p_order_id and oi.product_id = p_product_id
  for update;

  if found then
    -- Integer-overflow guard mirrors create_order()'s own check
    -- (006_create_order_rpc.sql) for the same reason: quantity is a plain
    -- `integer` column/parameter.
    if v_existing_item.quantity > (2147483647 - p_quantity) then
      raise exception 'Слишком большое количество для товара %', v_product.name;
    end if;

    -- Price snapshot rule: reuse the EXISTING unit_price, never
    -- re-resolve it — see the function-level note above.
    v_new_quantity := v_existing_item.quantity + p_quantity;
    v_line_total := round(v_existing_item.unit_price * v_new_quantity, 2);

    update public.order_items as oi
    set quantity = v_new_quantity,
        line_total = v_line_total
    where oi.id = v_existing_item.id;
  else
    -- Client-specific price snapshot, resolved for the ORDER's customer
    -- (v_order.company_id), never for the calling staff member — and only
    -- ever resolved here, at the moment a NEW line is first created.
    v_unit_price := public.staff_resolve_price(p_product_id, v_order.company_id);

    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'Цена недоступна для товара: %', v_product.name;
    end if;

    v_line_total := round(v_unit_price * p_quantity, 2);

    insert into public.order_items (
      order_id, product_id, product_name, product_sku, quantity, unit_price, line_total
    ) values (
      p_order_id, p_product_id, v_product.name, v_product.sku, p_quantity, v_unit_price, v_line_total
    );
  end if;

  -- --- reserve the stock ---------------------------------------------------
  update public.inventory as i
  set reserved_quantity = i.reserved_quantity + p_quantity::numeric(14, 3),
      updated_at = now()
  where i.warehouse_id = v_warehouse_id and i.product_id = p_product_id;

  get diagnostics v_affected_rows = row_count;
  if v_affected_rows <> 1 then
    raise exception 'Не удалось зарезервировать товар: %', v_product.name;
  end if;

  -- Reactivating a previously RELEASED reservation must RESET its quantity
  -- to exactly p_quantity, never add to the stale released amount (e.g.
  -- add 10 -> remove -> add 4 must end at quantity = 4, not 14). Only when
  -- the existing conflicting row is still 'active' (this product's
  -- quantity was just increased above, in the `if found` branch) does the
  -- reservation grow by the same delta that was just added to
  -- order_items.
  insert into public.inventory_reservations (order_id, warehouse_id, product_id, quantity, status)
  values (p_order_id, v_warehouse_id, p_product_id, p_quantity::numeric(14, 3), 'active')
  on conflict (order_id, product_id)
  do update set
    quantity = case
      when public.inventory_reservations.status = 'active'
        then public.inventory_reservations.quantity + excluded.quantity
      else excluded.quantity
    end,
    status = 'active',
    released_at = null;

  return public.staff_recalculate_order_totals(p_order_id);
end;
$$;

revoke all on function public.staff_add_order_item(uuid, uuid, integer) from public;
revoke all on function public.staff_add_order_item(uuid, uuid, integer) from anon;
revoke all on function public.staff_add_order_item(uuid, uuid, integer) from authenticated;
grant execute on function public.staff_add_order_item(uuid, uuid, integer) to authenticated;

create or replace function public.staff_update_order_item_quantity(
  p_order_item_id uuid,
  p_quantity integer
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_order public.orders;
  v_item public.order_items;
  v_warehouse_id uuid;
  v_inv_quantity numeric(14, 3);
  v_inv_reserved numeric(14, 3);
  v_available numeric(14, 3);
  v_diff integer;
  v_new_line_total numeric(14, 2);
  v_reservation public.inventory_reservations;
  v_affected_rows integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения заказа';
  end if;

  if p_order_item_id is null then
    raise exception 'order_item_id обязателен';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество должно быть положительным целым числом';
  end if;

  select oi.order_id into v_order_id from public.order_items as oi where oi.id = p_order_item_id;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  -- --- lock the order first (see note in section 5) -----------------------
  select * into v_order from public.orders as o where o.id = v_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)', v_order.status;
  end if;

  select * into v_item
  from public.order_items as oi
  where oi.id = p_order_item_id and oi.order_id = v_order.id
  for update;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  v_diff := p_quantity - v_item.quantity;

  if v_diff = 0 then
    return v_order;
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select i.quantity, i.reserved_quantity into v_inv_quantity, v_inv_reserved
  from public.inventory as i
  where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id
  for update;

  if not found then
    raise exception 'Складская запись для товара % не найдена', v_item.product_name;
  end if;

  if v_diff > 0 then
    v_available := public.staff_assert_non_negative_stock(v_inv_quantity - v_inv_reserved, v_item.product_name);

    if v_available < v_diff::numeric(14, 3) then
      raise exception 'Недостаточно товара на складе: % (доступно %, требуется дополнительно %)',
        v_item.product_name, v_available, v_diff;
    end if;
  end if;

  -- --- lock + verify the reservation this item owns -----------------------
  select * into v_reservation
  from public.inventory_reservations as r
  where r.order_id = v_order.id and r.product_id = v_item.product_id and r.status = 'active'
  for update;

  if not found then
    raise exception 'Активный резерв для товара % не найден', v_item.product_name;
  end if;

  -- Consistency checks: the reservation found above is already filtered by
  -- order_id/product_id, so a mismatch there would mean the query itself
  -- is broken — asserted anyway, as cheap, explicit defense-in-depth.
  -- quantity is the one field that can genuinely drift if some other code
  -- path ever touched either row without going through this RPC, so this
  -- check is the one that actually matters in practice.
  if v_reservation.order_id <> v_order.id or v_reservation.product_id <> v_item.product_id then
    raise exception
      'Резерв не соответствует позиции заказа (резерв: заказ %, товар %; позиция: заказ %, товар %)',
      v_reservation.order_id, v_reservation.product_id, v_order.id, v_item.product_id;
  end if;

  if v_reservation.quantity <> v_item.quantity::numeric(14, 3) then
    raise exception
      'Резерв рассинхронизирован с позицией заказа для товара %: резерв %, позиция %',
      v_item.product_name, v_reservation.quantity, v_item.quantity;
  end if;

  -- Price snapshot rule: unit_price is intentionally left untouched — only
  -- quantity and line_total change (see function-level note above).
  v_new_line_total := round(v_item.unit_price * p_quantity, 2);

  update public.order_items as oi
  set quantity = p_quantity,
      line_total = v_new_line_total
  where oi.id = p_order_item_id;

  update public.inventory as i
  set reserved_quantity = i.reserved_quantity + v_diff::numeric(14, 3),
      updated_at = now()
  where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id;

  get diagnostics v_affected_rows = row_count;
  if v_affected_rows <> 1 then
    raise exception 'Не удалось обновить резерв товара: %', v_item.product_name;
  end if;

  update public.inventory_reservations as r
  set quantity = v_reservation.quantity + v_diff::numeric(14, 3)
  where r.id = v_reservation.id;

  return public.staff_recalculate_order_totals(v_order.id);
end;
$$;

revoke all on function public.staff_update_order_item_quantity(uuid, integer) from public;
revoke all on function public.staff_update_order_item_quantity(uuid, integer) from anon;
revoke all on function public.staff_update_order_item_quantity(uuid, integer) from authenticated;
grant execute on function public.staff_update_order_item_quantity(uuid, integer) to authenticated;

create or replace function public.staff_remove_order_item(p_order_item_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_order public.orders;
  v_item public.order_items;
  v_warehouse_id uuid;
  v_reservation public.inventory_reservations;
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения заказа';
  end if;

  if p_order_item_id is null then
    raise exception 'order_item_id обязателен';
  end if;

  select oi.order_id into v_order_id from public.order_items as oi where oi.id = p_order_item_id;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  -- --- lock the order first (see note in section 5) -----------------------
  select * into v_order from public.orders as o where o.id = v_order_id for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in ('new', 'awaiting_payment') then
    raise exception 'Изменение позиций возможно только для заказа в статусе "new" или "awaiting_payment" (текущий статус: %)', v_order.status;
  end if;

  select * into v_item
  from public.order_items as oi
  where oi.id = p_order_item_id and oi.order_id = v_order.id
  for update;

  if not found then
    raise exception 'Позиция заказа не найдена';
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select * into v_reservation
  from public.inventory_reservations as r
  where r.order_id = v_order.id and r.product_id = v_item.product_id and r.status = 'active'
  for update;

  if found then
    -- Consistency checks — see staff_update_order_item_quantity() for why
    -- these matter in practice (quantity drift) even though order_id/
    -- product_id are already implied by the WHERE clause above.
    if v_reservation.order_id <> v_order.id or v_reservation.product_id <> v_item.product_id then
      raise exception
        'Резерв не соответствует позиции заказа (резерв: заказ %, товар %; позиция: заказ %, товар %)',
        v_reservation.order_id, v_reservation.product_id, v_order.id, v_item.product_id;
    end if;

    if v_reservation.quantity <> v_item.quantity::numeric(14, 3) then
      raise exception
        'Резерв рассинхронизирован с позицией заказа для товара %: резерв %, позиция %',
        v_item.product_name, v_reservation.quantity, v_item.quantity;
    end if;

    select i.reserved_quantity into v_inv_reserved
    from public.inventory as i
    where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id
    for update;

    if not found then
      raise exception 'Складская запись для товара % не найдена, удаление невозможно', v_item.product_name;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара %: зарезервировано % меньше, чем требуется освободить (%)',
        v_item.product_name, v_inv_reserved, v_reservation.quantity;
    end if;

    update public.inventory as i
    set reserved_quantity = i.reserved_quantity - v_reservation.quantity,
        updated_at = now()
    where i.warehouse_id = v_warehouse_id and i.product_id = v_item.product_id;

    get diagnostics v_affected_rows = row_count;
    if v_affected_rows <> 1 then
      raise exception 'Не удалось освободить резерв товара: %', v_item.product_name;
    end if;

    update public.inventory_reservations as r
    set status = 'released', released_at = now()
    where r.id = v_reservation.id;
  end if;

  delete from public.order_items as oi where oi.id = p_order_item_id;

  return public.staff_recalculate_order_totals(v_order.id);
end;
$$;

revoke all on function public.staff_remove_order_item(uuid) from public;
revoke all on function public.staff_remove_order_item(uuid) from anon;
revoke all on function public.staff_remove_order_item(uuid) from authenticated;
grant execute on function public.staff_remove_order_item(uuid) to authenticated;


-- Drop obsolete draft objects if an earlier 012 draft was applied.
drop function if exists public.staff_update_order_workflow_fields(
  uuid, text, uuid, timestamptz, timestamptz, boolean, boolean, boolean, boolean
);
drop function if exists public.staff_change_order_status(uuid, text, text, timestamptz, timestamptz);
drop policy if exists profiles_select_staff_peers on public.profiles;

create or replace function public.staff_get_order_assignee_name(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_name text;
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select p.full_name into v_name
  from public.orders as o
  left join public.profiles as p on p.id = o.assigned_manager_id
  where o.id = p_order_id;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  return v_name;
end;
$$;

revoke all on function public.staff_get_order_assignee_name(uuid) from public;
revoke all on function public.staff_get_order_assignee_name(uuid) from anon;
revoke all on function public.staff_get_order_assignee_name(uuid) from authenticated;
grant execute on function public.staff_get_order_assignee_name(uuid) to authenticated;

-- ============================================================
-- 9. Notes
-- ============================================================
-- - create_order() / cancel_order() unchanged.
-- - Client cancel still only for status = 'new'.
-- - Physical quantity decreases only in staff_fulfill_order_reservations.
-- - order_status_history: real status transitions + cancel only.
-- - order_activity_log: manager assign/unassign + deadlines (no fake
--   from_status = to_status rows in status history).
-- - order_status_history / order_internal_notes / order_activity_log:
--   no table grants.
-- - Deadlines are NEVER auto-set on status change; only via
--   staff_update_order_deadlines().
-- - No service_role. Manager directory is exposed only via
--   staff_list_assignable_managers() (no extra profiles SELECT policy).
