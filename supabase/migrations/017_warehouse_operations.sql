-- ============================================================
-- 017_warehouse_operations.sql
-- Stage 7 — Warehouse queue, picking tasks, and shipment
--
-- Depends on:
--   001_companies_and_profiles.sql
--   002_catalog_inventory_pricing.sql
--   005_orders.sql
--   008_reserve_inventory_on_order.sql
--   010_staff_role_access.sql
--   011_staff_manual_orders.sql (staff_resolve_warehouse_id)
--   012_staff_order_workflow.sql (status workflow + fulfill)
--   013_customers_foundation.sql (customers.display_name)
--   014_documents.sql (order_documents / delivery_note)
--
-- Apply by hand in the Supabase SQL Editor after 016. NOT auto-applied.
-- Does NOT modify migration files 001–016.
--
-- Design notes:
--   - Picking task is created atomically at paid → picking
--     (staff_start_order_picking), not when the order becomes paid.
--   - Physical write-off only via staff_fulfill_order_reservations (012)
--     from staff_ship_order (and manager/admin staff_change_order_status
--     which delegates to warehouse RPCs).
--   - warehouse NEVER uses staff_change_order_status — only dedicated
--     warehouse RPCs (start / set item / complete / ship).
--   - picked_quantity is stored for future partial picking; Stage 7 UI/RPC
--     only allow 0 or required_quantity (binary complete/incomplete).
--   - order_warehouse_activity is separate from order_status_history and
--     order_activity_log.
--   - Tables: RLS on, NO grants to anon/authenticated.
--   - Public RPCs: REVOKE ALL, then GRANT EXECUTE to authenticated.
--   - Internal helpers: no EXECUTE for authenticated.
-- ============================================================

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run 005 first.';
  end if;

  if to_regclass('public.inventory') is null
     or to_regclass('public.warehouses') is null
     or to_regclass('public.inventory_reservations') is null then
    raise exception
      'inventory / warehouses / inventory_reservations missing — run 002/008 first.';
  end if;

  if to_regclass('public.customers') is null then
    raise exception
      'public.customers missing — run 013 first.';
  end if;

  if to_regclass('public.order_documents') is null then
    raise exception
      'public.order_documents missing — run 014 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception
      'public.has_staff_role(...) missing — run 010 first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception
      'public.staff_resolve_warehouse_id() missing — run 011 first.';
  end if;

  if to_regprocedure('public.staff_fulfill_order_reservations(uuid)') is null then
    raise exception
      'public.staff_fulfill_order_reservations(...) missing — run 012 first.';
  end if;

  if to_regprocedure('public.staff_assert_active_reservations_consistent(uuid)') is null then
    raise exception
      'public.staff_assert_active_reservations_consistent(...) missing — run 012 first.';
  end if;

  if to_regprocedure('public.staff_record_order_status_change(uuid, text, text, text)') is null
     and to_regprocedure('public.staff_record_order_status_change(uuid, text, text)') is null then
    raise exception
      'public.staff_record_order_status_change(...) missing — run 012 first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception
      'public.set_updated_at() missing — run 001 first.';
  end if;
end
$$;

-- ============================================================
-- 1. order_picking_tasks
-- ============================================================

create table if not exists public.order_picking_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  status text not null,
  assigned_to uuid null references public.profiles (id) on delete restrict,
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_picking_tasks_status_check check (
    status in ('pending', 'in_progress', 'completed', 'cancelled')
  ),
  constraint order_picking_tasks_started_check check (
    (status = 'pending' and started_at is null)
    or (status in ('in_progress', 'completed', 'cancelled'))
  ),
  constraint order_picking_tasks_completed_check check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create index if not exists order_picking_tasks_status_idx
  on public.order_picking_tasks (status);

create index if not exists order_picking_tasks_warehouse_id_idx
  on public.order_picking_tasks (warehouse_id);

create index if not exists order_picking_tasks_assigned_to_idx
  on public.order_picking_tasks (assigned_to);

drop trigger if exists order_picking_tasks_set_updated_at on public.order_picking_tasks;
create trigger order_picking_tasks_set_updated_at
  before update on public.order_picking_tasks
  for each row
  execute function public.set_updated_at();

alter table public.order_picking_tasks enable row level security;

revoke all on table public.order_picking_tasks from public;
revoke all on table public.order_picking_tasks from anon;
revoke all on table public.order_picking_tasks from authenticated;

-- ============================================================
-- 2. order_picking_items
-- ============================================================

create table if not exists public.order_picking_items (
  id uuid primary key default gen_random_uuid(),
  picking_task_id uuid not null references public.order_picking_tasks (id) on delete cascade,
  order_item_id uuid not null references public.order_items (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete restrict,
  required_quantity integer not null,
  picked_quantity integer not null default 0,
  is_completed boolean not null default false,
  completed_by uuid null references public.profiles (id) on delete restrict,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_picking_items_task_item_unique unique (picking_task_id, order_item_id),
  constraint order_picking_items_required_qty_check check (required_quantity > 0),
  constraint order_picking_items_picked_qty_range check (
    picked_quantity >= 0 and picked_quantity <= required_quantity
  ),
  -- is_completed ↔ fully picked (partial future: is_completed=false, 0 < picked < required)
  constraint order_picking_items_completed_consistent check (
    is_completed = (picked_quantity = required_quantity)
  ),
  constraint order_picking_items_completed_meta check (
    (is_completed = true and completed_by is not null and completed_at is not null)
    or (is_completed = false and completed_by is null and completed_at is null)
  )
);

comment on table public.order_picking_items is
  'Picking line snapshot. Stage 7 UI is binary (not picked / fully picked); '
  'picked_quantity is kept for a future partial-picking business flow.';

comment on column public.order_picking_items.required_quantity is
  'Snapshot of order_items.quantity at picking start. Immutable for the task.';

comment on column public.order_picking_items.picked_quantity is
  'Quantity marked picked. Stored for future partial picking. '
  'Stage 7 allows only 0 or required_quantity via staff_set_picking_item_completed; '
  'partial picking is not a business feature yet.';

comment on column public.order_picking_items.is_completed is
  'True iff picked_quantity = required_quantity. Stage 7 toggles this with the binary UI.';

create index if not exists order_picking_items_task_id_idx
  on public.order_picking_items (picking_task_id);

create index if not exists order_picking_items_order_item_id_idx
  on public.order_picking_items (order_item_id);

drop trigger if exists order_picking_items_set_updated_at on public.order_picking_items;
create trigger order_picking_items_set_updated_at
  before update on public.order_picking_items
  for each row
  execute function public.set_updated_at();

alter table public.order_picking_items enable row level security;

revoke all on table public.order_picking_items from public;
revoke all on table public.order_picking_items from anon;
revoke all on table public.order_picking_items from authenticated;

-- ============================================================
-- 3. order_warehouse_activity (separate from status/manager activity logs)
-- ============================================================

create table if not exists public.order_warehouse_activity (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  picking_task_id uuid null references public.order_picking_tasks (id) on delete set null,
  event_type text not null,
  description text null,
  metadata jsonb null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint order_warehouse_activity_event_type_check check (
    event_type in (
      'picking_started',
      'picking_item_completed',
      'picking_item_reopened',
      'picking_completed',
      'order_shipped'
    )
  )
);

comment on table public.order_warehouse_activity is
  'Warehouse-only audit trail. Distinct from order_status_history and order_activity_log.';

create index if not exists order_warehouse_activity_order_created_idx
  on public.order_warehouse_activity (order_id, created_at desc);

alter table public.order_warehouse_activity enable row level security;

revoke all on table public.order_warehouse_activity from public;
revoke all on table public.order_warehouse_activity from anon;
revoke all on table public.order_warehouse_activity from authenticated;

-- ============================================================
-- 4. Internal helpers
-- ============================================================

create or replace function public.staff_assert_warehouse_ops_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['warehouse', 'manager', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для складских операций';
  end if;
end;
$$;

revoke all on function public.staff_assert_warehouse_ops_role() from public;
revoke all on function public.staff_assert_warehouse_ops_role() from anon;
revoke all on function public.staff_assert_warehouse_ops_role() from authenticated;


create or replace function public.staff_assert_active_assignee(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.user_role;
  v_active boolean;
begin
  if p_user_id is null then
    return;
  end if;

  select p.role, p.is_active
  into v_role, v_active
  from public.profiles as p
  where p.id = p_user_id;

  if not found then
    raise exception 'Назначенный сотрудник не найден';
  end if;

  if not v_active then
    raise exception 'Назначенный сотрудник неактивен';
  end if;

  if v_role not in ('warehouse', 'admin', 'manager') then
    raise exception
      'Назначить сборку можно только сотруднику склада, менеджеру или администратору';
  end if;
end;
$$;

revoke all on function public.staff_assert_active_assignee(uuid) from public;
revoke all on function public.staff_assert_active_assignee(uuid) from anon;
revoke all on function public.staff_assert_active_assignee(uuid) from authenticated;


-- Resolve single warehouse for an order's active reservations.
create or replace function public.staff_resolve_order_reservation_warehouse_id(
  p_order_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_warehouse_id uuid;
  v_count integer;
begin
  select count(distinct r.warehouse_id)
  into v_count
  from public.inventory_reservations as r
  where r.order_id = p_order_id
    and r.status = 'active';

  if v_count is null or v_count = 0 then
    raise exception 'У заказа нет активных резервов склада';
  end if;

  if v_count > 1 then
    raise exception
      'Заказ относится к нескольким складам — сборка недоступна на текущем этапе';
  end if;

  select r.warehouse_id
  into v_warehouse_id
  from public.inventory_reservations as r
  where r.order_id = p_order_id
    and r.status = 'active'
  limit 1;

  return v_warehouse_id;
end;
$$;

revoke all on function public.staff_resolve_order_reservation_warehouse_id(uuid) from public;
revoke all on function public.staff_resolve_order_reservation_warehouse_id(uuid) from anon;
revoke all on function public.staff_resolve_order_reservation_warehouse_id(uuid) from authenticated;


-- Snapshot order_items → picking_items. Caller holds FOR UPDATE on order + task.
create or replace function public.staff_sync_picking_items_from_order(
  p_task_id uuid,
  p_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.order_picking_items as pi
  where pi.picking_task_id = p_task_id;

  insert into public.order_picking_items (
    picking_task_id,
    order_item_id,
    product_id,
    required_quantity,
    picked_quantity,
    is_completed
  )
  select
    p_task_id,
    oi.id,
    oi.product_id,
    oi.quantity,
    0,
    false
  from public.order_items as oi
  where oi.order_id = p_order_id
  order by oi.created_at asc, oi.id asc;

  if not exists (
    select 1 from public.order_picking_items as pi where pi.picking_task_id = p_task_id
  ) then
    raise exception 'Нельзя начать сборку пустого заказа';
  end if;
end;
$$;

revoke all on function public.staff_sync_picking_items_from_order(uuid, uuid) from public;
revoke all on function public.staff_sync_picking_items_from_order(uuid, uuid) from anon;
revoke all on function public.staff_sync_picking_items_from_order(uuid, uuid) from authenticated;


create or replace function public.staff_assert_picking_snapshot_matches_order(
  p_order_id uuid,
  p_task_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order_count integer;
  v_pick_count integer;
  v_mismatch integer;
begin
  select count(*) into v_order_count
  from public.order_items as oi
  where oi.order_id = p_order_id;

  select count(*) into v_pick_count
  from public.order_picking_items as pi
  where pi.picking_task_id = p_task_id;

  if v_order_count is distinct from v_pick_count then
    raise exception
      'Состав сборки не совпадает с заказом: позиций в заказе %, в сборке %',
      v_order_count, v_pick_count;
  end if;

  select count(*) into v_mismatch
  from (
    select oi.id as order_item_id, oi.product_id, oi.quantity
    from public.order_items as oi
    where oi.order_id = p_order_id
  ) as o
  full outer join (
    select pi.order_item_id, pi.product_id, pi.required_quantity
    from public.order_picking_items as pi
    where pi.picking_task_id = p_task_id
  ) as p
    on p.order_item_id = o.order_item_id
  where o.order_item_id is null
     or p.order_item_id is null
     or o.product_id is distinct from p.product_id
     or o.quantity is distinct from p.required_quantity;

  if v_mismatch > 0 then
    raise exception
      'Снимок сборки не совпадает с текущими позициями заказа (позиции/SKU/кол-во)';
  end if;
end;
$$;

revoke all on function public.staff_assert_picking_snapshot_matches_order(uuid, uuid) from public;
revoke all on function public.staff_assert_picking_snapshot_matches_order(uuid, uuid) from anon;
revoke all on function public.staff_assert_picking_snapshot_matches_order(uuid, uuid) from authenticated;


create or replace function public.staff_assert_all_picking_items_completed(p_task_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_done integer;
begin
  select count(*), count(*) filter (where pi.is_completed)
  into v_total, v_done
  from public.order_picking_items as pi
  where pi.picking_task_id = p_task_id;

  if v_total < 1 then
    raise exception 'В задаче сборки нет позиций';
  end if;

  if v_done is distinct from v_total then
    raise exception
      'Не все позиции собраны (% из %)', v_done, v_total;
  end if;
end;
$$;

revoke all on function public.staff_assert_all_picking_items_completed(uuid) from public;
revoke all on function public.staff_assert_all_picking_items_completed(uuid) from anon;
revoke all on function public.staff_assert_all_picking_items_completed(uuid) from authenticated;


create or replace function public.staff_assert_delivery_note_ready(p_order_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_doc_id uuid;
begin
  select d.id into v_doc_id
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = 'delivery_note'
    and d.status = 'generated'
  order by d.generated_at desc
  limit 1;

  if v_doc_id is null then
    raise exception
      'Для отгрузки нужна сформированная накладная (delivery_note со статусом generated)';
  end if;

  return v_doc_id;
end;
$$;

revoke all on function public.staff_assert_delivery_note_ready(uuid) from public;
revoke all on function public.staff_assert_delivery_note_ready(uuid) from anon;
revoke all on function public.staff_assert_delivery_note_ready(uuid) from authenticated;


create or replace function public.staff_cancel_picking_task_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.order_picking_tasks as t
  set
    status = 'cancelled',
    completed_at = null,
    updated_at = now()
  where t.order_id = p_order_id
    and t.status in ('pending', 'in_progress', 'completed');
end;
$$;

revoke all on function public.staff_cancel_picking_task_for_order(uuid) from public;
revoke all on function public.staff_cancel_picking_task_for_order(uuid) from anon;
revoke all on function public.staff_cancel_picking_task_for_order(uuid) from authenticated;


create or replace function public.staff_record_warehouse_activity(
  p_order_id uuid,
  p_picking_task_id uuid,
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

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_event_type is null
     or p_event_type not in (
       'picking_started',
       'picking_item_completed',
       'picking_item_reopened',
       'picking_completed',
       'order_shipped'
     ) then
    raise exception 'Недопустимый event_type складской истории: %', p_event_type;
  end if;

  insert into public.order_warehouse_activity (
    order_id,
    picking_task_id,
    event_type,
    description,
    metadata,
    created_by
  )
  values (
    p_order_id,
    p_picking_task_id,
    p_event_type,
    nullif(trim(coalesce(p_description, '')), ''),
    p_metadata,
    v_uid
  );
end;
$$;

revoke all on function public.staff_record_warehouse_activity(uuid, uuid, text, text, jsonb)
  from public;
revoke all on function public.staff_record_warehouse_activity(uuid, uuid, text, text, jsonb)
  from anon;
revoke all on function public.staff_record_warehouse_activity(uuid, uuid, text, text, jsonb)
  from authenticated;

-- ============================================================
-- 5. staff_start_order_picking
-- ============================================================

create or replace function public.staff_start_order_picking(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_task public.order_picking_tasks;
  v_warehouse_id uuid;
  v_from text;
begin
  perform public.staff_assert_warehouse_ops_role();

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  -- Idempotent: already picking with an in-progress task (no activity).
  if v_order.status = 'picking' then
    select * into v_task
    from public.order_picking_tasks as t
    where t.order_id = p_order_id
    for update;

    if found and v_task.status = 'in_progress' then
      return jsonb_build_object(
        'order_id', v_order.id,
        'order_status', v_order.status,
        'picking_task_id', v_task.id,
        'picking_task_status', v_task.status,
        'assigned_to', v_task.assigned_to,
        'idempotent', true
      );
    end if;

    raise exception
      'Заказ уже в статусе picking, но задача сборки отсутствует или неактивна';
  end if;

  if v_order.status <> 'paid' then
    raise exception
      'Сборку можно начать только из статуса paid (текущий: %)', v_order.status;
  end if;

  perform public.staff_assert_active_reservations_consistent(p_order_id);
  v_warehouse_id := public.staff_resolve_order_reservation_warehouse_id(p_order_id);
  perform public.staff_assert_active_assignee(v_uid);

  select * into v_task
  from public.order_picking_tasks as t
  where t.order_id = p_order_id
  for update;

  if found then
    if v_task.status = 'completed' then
      raise exception 'Задача сборки уже завершена — повторный старт невозможен';
    end if;

    -- Reuse cancelled/pending task: reset snapshot and reopen.
    perform public.staff_sync_picking_items_from_order(v_task.id, p_order_id);

    update public.order_picking_tasks as t
    set
      warehouse_id = v_warehouse_id,
      status = 'in_progress',
      assigned_to = v_uid,
      started_at = coalesce(t.started_at, now()),
      completed_at = null,
      updated_at = now()
    where t.id = v_task.id
    returning * into v_task;
  else
    insert into public.order_picking_tasks (
      order_id,
      warehouse_id,
      status,
      assigned_to,
      started_at
    )
    values (
      p_order_id,
      v_warehouse_id,
      'in_progress',
      v_uid,
      now()
    )
    returning * into v_task;

    perform public.staff_sync_picking_items_from_order(v_task.id, p_order_id);
  end if;

  v_from := v_order.status;

  update public.orders as o
  set status = 'picking'
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_status_change(
    p_order_id, v_from, 'picking', 'Начата сборка'
  );

  perform public.staff_record_warehouse_activity(
    p_order_id,
    v_task.id,
    'picking_started',
    'Начал сборку',
    jsonb_build_object(
      'started_by', v_uid,
      'picking_task_id', v_task.id,
      'warehouse_id', v_warehouse_id
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_status', v_order.status,
    'picking_task_id', v_task.id,
    'picking_task_status', v_task.status,
    'assigned_to', v_task.assigned_to,
    'idempotent', false
  );
end;
$$;

revoke all on function public.staff_start_order_picking(uuid) from public;
revoke all on function public.staff_start_order_picking(uuid) from anon;
revoke all on function public.staff_start_order_picking(uuid) from authenticated;
grant execute on function public.staff_start_order_picking(uuid) to authenticated;

-- ============================================================
-- 5. staff_set_picking_item_completed
-- ============================================================

create or replace function public.staff_set_picking_item_completed(
  p_picking_item_id uuid,
  p_completed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_item public.order_picking_items;
  v_task public.order_picking_tasks;
  v_order public.orders;
  v_sku text;
  v_product_name text;
  v_label text;
  v_meta jsonb;
begin
  perform public.staff_assert_warehouse_ops_role();

  if p_picking_item_id is null then
    raise exception 'picking_item_id обязателен';
  end if;

  if p_completed is null then
    raise exception 'p_completed обязателен';
  end if;

  select * into v_item
  from public.order_picking_items as pi
  where pi.id = p_picking_item_id
  for update;

  if not found then
    raise exception 'Позиция сборки не найдена';
  end if;

  select * into v_task
  from public.order_picking_tasks as t
  where t.id = v_item.picking_task_id
  for update;

  if not found then
    raise exception 'Задача сборки не найдена';
  end if;

  if v_task.status <> 'in_progress' then
    raise exception
      'Отмечать позиции можно только в задаче со статусом in_progress (текущий: %)',
      v_task.status;
  end if;

  select * into v_order
  from public.orders as o
  where o.id = v_task.order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status <> 'picking' then
    raise exception
      'Отмечать позиции можно только пока заказ в статусе picking (текущий: %)',
      v_order.status;
  end if;

  -- Idempotent: no state change → no warehouse activity.
  if p_completed and v_item.is_completed then
    return jsonb_build_object(
      'id', v_item.id,
      'picking_task_id', v_item.picking_task_id,
      'order_item_id', v_item.order_item_id,
      'product_id', v_item.product_id,
      'required_quantity', v_item.required_quantity,
      'picked_quantity', v_item.picked_quantity,
      'is_completed', v_item.is_completed,
      'completed_by', v_item.completed_by,
      'completed_at', v_item.completed_at,
      'idempotent', true
    );
  end if;

  if (not p_completed) and (not v_item.is_completed) then
    return jsonb_build_object(
      'id', v_item.id,
      'picking_task_id', v_item.picking_task_id,
      'order_item_id', v_item.order_item_id,
      'product_id', v_item.product_id,
      'required_quantity', v_item.required_quantity,
      'picked_quantity', v_item.picked_quantity,
      'is_completed', v_item.is_completed,
      'completed_by', v_item.completed_by,
      'completed_at', v_item.completed_at,
      'idempotent', true
    );
  end if;

  select oi.product_sku, oi.product_name
  into v_sku, v_product_name
  from public.order_items as oi
  where oi.id = v_item.order_item_id;

  v_label := coalesce(nullif(trim(coalesce(v_sku, '')), ''), v_product_name, 'позиция');

  v_meta := jsonb_build_object(
    'picking_item_id', v_item.id,
    'order_item_id', v_item.order_item_id,
    'product_id', v_item.product_id,
    'product_sku', v_sku,
    'product_name', v_product_name,
    'required_quantity', v_item.required_quantity
  );

  if p_completed then
    -- Stage 7: binary complete → picked_quantity = required_quantity.
    update public.order_picking_items as pi
    set
      picked_quantity = pi.required_quantity,
      is_completed = true,
      completed_by = v_uid,
      completed_at = now()
    where pi.id = v_item.id
    returning * into v_item;

    perform public.staff_record_warehouse_activity(
      v_task.order_id,
      v_task.id,
      'picking_item_completed',
      'Собрал позицию ' || v_label,
      v_meta
    );
  else
    -- Stage 7: binary reopen → picked_quantity = 0.
    update public.order_picking_items as pi
    set
      picked_quantity = 0,
      is_completed = false,
      completed_by = null,
      completed_at = null
    where pi.id = v_item.id
    returning * into v_item;

    perform public.staff_record_warehouse_activity(
      v_task.order_id,
      v_task.id,
      'picking_item_reopened',
      'Вернул позицию в несобранные',
      v_meta
    );
  end if;

  return jsonb_build_object(
    'id', v_item.id,
    'picking_task_id', v_item.picking_task_id,
    'order_item_id', v_item.order_item_id,
    'product_id', v_item.product_id,
    'required_quantity', v_item.required_quantity,
    'picked_quantity', v_item.picked_quantity,
    'is_completed', v_item.is_completed,
    'completed_by', v_item.completed_by,
    'completed_at', v_item.completed_at,
    'idempotent', false
  );
end;
$$;

revoke all on function public.staff_set_picking_item_completed(uuid, boolean) from public;
revoke all on function public.staff_set_picking_item_completed(uuid, boolean) from anon;
revoke all on function public.staff_set_picking_item_completed(uuid, boolean) from authenticated;
grant execute on function public.staff_set_picking_item_completed(uuid, boolean) to authenticated;

-- ============================================================
-- 6. staff_complete_order_picking
-- ============================================================

create or replace function public.staff_complete_order_picking(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_task public.order_picking_tasks;
  v_from text;
  v_total integer;
  v_done integer;
begin
  perform public.staff_assert_warehouse_ops_role();

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  -- Idempotent complete (no activity).
  if v_order.status = 'ready_for_shipment' then
    select * into v_task
    from public.order_picking_tasks as t
    where t.order_id = p_order_id;

    if found and v_task.status = 'completed' then
      return jsonb_build_object(
        'order_id', v_order.id,
        'order_status', v_order.status,
        'picking_task_id', v_task.id,
        'picking_task_status', v_task.status,
        'idempotent', true
      );
    end if;
  end if;

  if v_order.status <> 'picking' then
    raise exception
      'Завершить сборку можно только из статуса picking (текущий: %)',
      v_order.status;
  end if;

  select * into v_task
  from public.order_picking_tasks as t
  where t.order_id = p_order_id
  for update;

  if not found then
    raise exception 'Задача сборки не найдена';
  end if;

  if v_task.status <> 'in_progress' then
    raise exception
      'Задача сборки должна быть in_progress (текущий: %)', v_task.status;
  end if;

  perform public.staff_assert_picking_snapshot_matches_order(p_order_id, v_task.id);
  perform public.staff_assert_all_picking_items_completed(v_task.id);
  perform public.staff_assert_active_reservations_consistent(p_order_id);

  select count(*), count(*) filter (where pi.is_completed)
  into v_total, v_done
  from public.order_picking_items as pi
  where pi.picking_task_id = v_task.id;

  update public.order_picking_tasks as t
  set
    status = 'completed',
    completed_at = now(),
    updated_at = now()
  where t.id = v_task.id
  returning * into v_task;

  v_from := v_order.status;

  update public.orders as o
  set status = 'ready_for_shipment'
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_status_change(
    p_order_id, v_from, 'ready_for_shipment', 'Сборка завершена'
  );

  perform public.staff_record_warehouse_activity(
    p_order_id,
    v_task.id,
    'picking_completed',
    'Завершил сборку',
    jsonb_build_object(
      'total_item_count', v_total,
      'completed_item_count', v_done
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_status', v_order.status,
    'picking_task_id', v_task.id,
    'picking_task_status', v_task.status,
    'idempotent', false
  );
end;
$$;

revoke all on function public.staff_complete_order_picking(uuid) from public;
revoke all on function public.staff_complete_order_picking(uuid) from anon;
revoke all on function public.staff_complete_order_picking(uuid) from authenticated;
grant execute on function public.staff_complete_order_picking(uuid) to authenticated;

-- ============================================================
-- 7. staff_ship_order — reuses staff_fulfill_order_reservations (012)
-- ============================================================

create or replace function public.staff_ship_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_task public.order_picking_tasks;
  v_from text;
  v_delivery_note_id uuid;
  v_delivery_note_number text;
begin
  perform public.staff_assert_warehouse_ops_role();

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  -- Idempotent: already shipped — do not write off / no activity.
  if v_order.status = 'shipped' then
    select t.id into v_task
    from public.order_picking_tasks as t
    where t.order_id = p_order_id;

    return jsonb_build_object(
      'order_id', v_order.id,
      'order_status', v_order.status,
      'picking_task_id', v_task.id,
      'idempotent', true
    );
  end if;

  if v_order.status <> 'ready_for_shipment' then
    raise exception
      'Отгрузка возможна только из статуса ready_for_shipment (текущий: %)',
      v_order.status;
  end if;

  select * into v_task
  from public.order_picking_tasks as t
  where t.order_id = p_order_id
  for update;

  if not found then
    raise exception 'Задача сборки не найдена';
  end if;

  if v_task.status <> 'completed' then
    raise exception
      'Отгрузка возможна только после завершённой сборки (task: %)', v_task.status;
  end if;

  perform public.staff_assert_picking_snapshot_matches_order(p_order_id, v_task.id);
  perform public.staff_assert_all_picking_items_completed(v_task.id);
  v_delivery_note_id := public.staff_assert_delivery_note_ready(p_order_id);

  select d.number into v_delivery_note_number
  from public.order_documents as d
  where d.id = v_delivery_note_id;

  -- Atomic write-off BEFORE status flip (same helper as 012).
  perform public.staff_fulfill_order_reservations(p_order_id);

  v_from := v_order.status;

  update public.orders as o
  set status = 'shipped'
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_status_change(
    p_order_id, v_from, 'shipped', 'Отгружено со склада'
  );

  perform public.staff_record_warehouse_activity(
    p_order_id,
    v_task.id,
    'order_shipped',
    'Отгрузил заказ',
    jsonb_build_object(
      'warehouse_id', v_task.warehouse_id,
      'delivery_note_id', v_delivery_note_id,
      'delivery_note_number', v_delivery_note_number
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_status', v_order.status,
    'picking_task_id', v_task.id,
    'delivery_note_id', v_delivery_note_id,
    'idempotent', false
  );
end;
$$;

revoke all on function public.staff_ship_order(uuid) from public;
revoke all on function public.staff_ship_order(uuid) from anon;
revoke all on function public.staff_ship_order(uuid) from authenticated;
grant execute on function public.staff_ship_order(uuid) to authenticated;

-- ============================================================
-- 9. staff_change_order_status — manager/admin ONLY
--
-- warehouse must NOT call this RPC. Warehouse transitions go only through:
--   staff_start_order_picking / staff_complete_order_picking / staff_ship_order.
-- Manager/admin may still use this RPC; warehouse-related forward transitions
-- delegate to those dedicated RPCs so picking rules stay mandatory.
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
  v_task public.order_picking_tasks;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  -- warehouse intentionally excluded — use dedicated warehouse RPCs.
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

  -- Forward warehouse transitions: reuse dedicated RPCs (picking rules + DN).
  if v_from = 'paid' and p_new_status = 'picking' then
    perform public.staff_start_order_picking(p_order_id);
    select * into v_order from public.orders as o where o.id = p_order_id;
    return v_order;
  end if;

  if v_from = 'picking' and p_new_status = 'ready_for_shipment' then
    perform public.staff_complete_order_picking(p_order_id);
    select * into v_order from public.orders as o where o.id = p_order_id;
    return v_order;
  end if;

  if v_from = 'ready_for_shipment' and p_new_status = 'shipped' then
    perform public.staff_ship_order(p_order_id);
    select * into v_order from public.orders as o where o.id = p_order_id;
    return v_order;
  end if;

  -- Reverse: picking → paid cancels task.
  if v_from = 'picking' and p_new_status = 'paid' then
    perform public.staff_cancel_picking_task_for_order(p_order_id);
  end if;

  -- Reverse: ready_for_shipment → picking reopens task.
  if v_from = 'ready_for_shipment' and p_new_status = 'picking' then
    select * into v_task
    from public.order_picking_tasks as t
    where t.order_id = p_order_id
    for update;

    if found and v_task.status = 'completed' then
      update public.order_picking_tasks as t
      set
        status = 'in_progress',
        completed_at = null,
        updated_at = now()
      where t.id = v_task.id;
    end if;
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

-- Cancel: also cancel picking task when present.
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

  perform public.staff_release_order_reservations(p_order_id);
  perform public.staff_cancel_picking_task_for_order(p_order_id);

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

-- ============================================================
-- 9. Read RPCs
-- ============================================================

create or replace function public.warehouse_list_orders(
  p_status text default null,
  p_limit integer default 50,
  p_search text default null
)
returns table (
  order_id uuid,
  order_number text,
  customer_display_name text,
  delivery_type text,
  status text,
  total_item_count integer,
  completed_item_count integer,
  picking_task_status text,
  assigned_to uuid,
  assigned_to_name text,
  created_at timestamptz,
  payment_due_at timestamptz,
  reservation_expires_at timestamptz,
  total numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_search text;
begin
  perform public.staff_assert_warehouse_ops_role();

  if p_status is not null
     and p_status not in ('paid', 'picking', 'ready_for_shipment') then
    raise exception
      'Фильтр склада допускает только: paid, picking, ready_for_shipment';
  end if;

  v_limit := coalesce(p_limit, 50);
  if v_limit < 1 then
    v_limit := 1;
  elsif v_limit > 200 then
    v_limit := 200;
  end if;

  v_search := nullif(trim(coalesce(p_search, '')), '');
  if v_search is not null then
    v_search := replace(replace(v_search, '\', '\\'), '%', '\%');
    v_search := replace(v_search, '_', '\_');
  end if;

  return query
  select
    o.id as order_id,
    o.order_number,
    coalesce(c.display_name, o.contact_name) as customer_display_name,
    o.delivery_type,
    o.status,
    (
      case
        when t.id is null then coalesce(order_counts.total_item_count, 0)
        else coalesce(pick_counts.total_item_count, 0)
      end
    )::integer as total_item_count,
    coalesce(pick_counts.completed_item_count, 0)::integer as completed_item_count,
    t.status as picking_task_status,
    t.assigned_to,
    ap.full_name as assigned_to_name,
    o.created_at,
    o.payment_due_at,
    o.reservation_expires_at,
    o.total
  from public.orders as o
  left join public.customers as c on c.id = o.customer_id
  left join public.order_picking_tasks as t on t.order_id = o.id
  left join public.profiles as ap on ap.id = t.assigned_to
  left join lateral (
    select count(oi.id)::integer as total_item_count
    from public.order_items as oi
    where oi.order_id = o.id
  ) as order_counts on true
  left join lateral (
    select
      count(pi.id)::integer as total_item_count,
      count(pi.id) filter (where pi.is_completed)::integer as completed_item_count
    from public.order_picking_items as pi
    where pi.picking_task_id = t.id
  ) as pick_counts on true
  where o.status in ('paid', 'picking', 'ready_for_shipment')
    and (p_status is null or o.status = p_status)
    and (
      v_search is null
      or o.order_number ilike '%' || v_search || '%' escape '\'
      or o.contact_name ilike '%' || v_search || '%' escape '\'
      or coalesce(c.display_name, '') ilike '%' || v_search || '%' escape '\'
      or coalesce(o.contact_phone, '') ilike '%' || v_search || '%' escape '\'
    )
  order by
    case o.status
      when 'picking' then 0
      when 'paid' then 1
      when 'ready_for_shipment' then 2
      else 3
    end,
    o.created_at asc
  limit v_limit;
end;
$$;

revoke all on function public.warehouse_list_orders(text, integer, text) from public;
revoke all on function public.warehouse_list_orders(text, integer, text) from anon;
revoke all on function public.warehouse_list_orders(text, integer, text) from authenticated;
grant execute on function public.warehouse_list_orders(text, integer, text) to authenticated;


create or replace function public.warehouse_get_order_picking(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_result jsonb;
begin
  perform public.staff_assert_warehouse_ops_role();

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status not in (
    'paid', 'picking', 'ready_for_shipment', 'shipped', 'completed'
  ) then
    raise exception
      'Заказ недоступен для складского просмотра в статусе %', v_order.status;
  end if;

  select jsonb_build_object(
    'order', jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'status', o.status,
      'total', o.total,
      'delivery_type', o.delivery_type,
      'contact_name', o.contact_name,
      'contact_phone', o.contact_phone,
      'contact_email', o.contact_email,
      'delivery_address', o.delivery_address,
      'delivery_comment', o.delivery_comment,
      'comment', o.comment,
      'payment_due_at', o.payment_due_at,
      'reservation_expires_at', o.reservation_expires_at,
      'created_at', o.created_at,
      'updated_at', o.updated_at,
      'assigned_manager_id', o.assigned_manager_id,
      'customer_id', o.customer_id
    ),
    'customer', case
      when c.id is null then null
      else jsonb_build_object(
        'id', c.id,
        'display_name', c.display_name,
        'phone', c.phone,
        'email', c.email,
        'customer_type', c.customer_type
      )
    end,
    'manager', case
      when mp.id is null then null
      else jsonb_build_object(
        'id', mp.id,
        'full_name', mp.full_name
      )
    end,
    'picking_task', case
      when t.id is null then null
      else jsonb_build_object(
        'id', t.id,
        'order_id', t.order_id,
        'warehouse_id', t.warehouse_id,
        'status', t.status,
        'assigned_to', t.assigned_to,
        'assigned_to_name', ap.full_name,
        'started_at', t.started_at,
        'completed_at', t.completed_at,
        'created_at', t.created_at,
        'updated_at', t.updated_at
      )
    end,
    'picking_items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', pi.id,
          'picking_task_id', pi.picking_task_id,
          'order_item_id', pi.order_item_id,
          'product_id', pi.product_id,
          'product_name', oi.product_name,
          'product_sku', oi.product_sku,
          'required_quantity', pi.required_quantity,
          'picked_quantity', pi.picked_quantity,
          'is_completed', pi.is_completed,
          'completed_by', pi.completed_by,
          'completed_at', pi.completed_at
        )
        order by oi.created_at asc, oi.id asc
      )
      from public.order_picking_items as pi
      join public.order_items as oi on oi.id = pi.order_item_id
      where pi.picking_task_id = t.id
    ), '[]'::jsonb),
    -- Fallback lines before picking starts (paid, no task yet).
    'order_items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', oi.id,
          'product_id', oi.product_id,
          'product_name', oi.product_name,
          'product_sku', oi.product_sku,
          'quantity', oi.quantity
        )
        order by oi.created_at asc, oi.id asc
      )
      from public.order_items as oi
      where oi.order_id = o.id
    ), '[]'::jsonb),
    'delivery_note', (
      select jsonb_build_object(
        'id', d.id,
        'number', d.number,
        'status', d.status,
        'generated_at', d.generated_at,
        'printed_at', d.printed_at
      )
      from public.order_documents as d
      where d.order_id = o.id
        and d.document_type = 'delivery_note'
        and d.status = 'generated'
      order by d.generated_at desc
      limit 1
    ),
    'progress', jsonb_build_object(
      'total', case
        when t.id is null then (
          select count(*)::integer
          from public.order_items as oi
          where oi.order_id = o.id
        )
        else (
          select count(*)::integer
          from public.order_picking_items as pi
          where pi.picking_task_id = t.id
        )
      end,
      'completed', case
        when t.id is null then 0
        else (
          select count(*)::integer
          from public.order_picking_items as pi
          where pi.picking_task_id = t.id
            and pi.is_completed
        )
      end
    )
  )
  into v_result
  from public.orders as o
  left join public.customers as c on c.id = o.customer_id
  left join public.profiles as mp on mp.id = o.assigned_manager_id
  left join public.order_picking_tasks as t on t.order_id = o.id
  left join public.profiles as ap on ap.id = t.assigned_to
  where o.id = p_order_id;

  return v_result;
end;
$$;

revoke all on function public.warehouse_get_order_picking(uuid) from public;
revoke all on function public.warehouse_get_order_picking(uuid) from anon;
revoke all on function public.warehouse_get_order_picking(uuid) from authenticated;
grant execute on function public.warehouse_get_order_picking(uuid) to authenticated;


create or replace function public.warehouse_list_order_activity(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  picking_task_id uuid,
  event_type text,
  description text,
  metadata jsonb,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.staff_assert_warehouse_ops_role();

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
    a.picking_task_id,
    a.event_type,
    a.description,
    a.metadata,
    a.created_by,
    p.full_name as created_by_name,
    a.created_at
  from public.order_warehouse_activity as a
  left join public.profiles as p on p.id = a.created_by
  where a.order_id = p_order_id
  order by a.created_at desc, a.id desc;
end;
$$;

revoke all on function public.warehouse_list_order_activity(uuid) from public;
revoke all on function public.warehouse_list_order_activity(uuid) from anon;
revoke all on function public.warehouse_list_order_activity(uuid) from authenticated;
grant execute on function public.warehouse_list_order_activity(uuid) to authenticated;

-- ============================================================
-- 11. Notes
-- ============================================================
-- - Task created at paid→picking (staff_start_order_picking), not at paid.
-- - warehouse has NO access to staff_change_order_status role-check.
--   Warehouse transitions: start / complete / ship RPCs only.
-- - manager/admin staff_change_order_status may delegate forward warehouse
--   transitions to those RPCs (does not expand warehouse EXECUTE).
-- - Write-off: only staff_fulfill_order_reservations (012).
-- - order_warehouse_activity ≠ status history / manager activity log.
-- - Activity rows only on real state changes (idempotent paths skip insert).
-- - Stage 7 picked_quantity is binary (0 or required); schema ready for partial.
-- - No service_role. No table grants. No partial shipment / multi-warehouse.
-- ============================================================
