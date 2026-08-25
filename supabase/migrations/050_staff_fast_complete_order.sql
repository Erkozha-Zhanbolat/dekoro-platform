-- ============================================================
-- 050_staff_fast_complete_order.sql
-- Controlled fast-path: paid → picking → ready_for_shipment →
-- shipped → completed via existing warehouse / status RPCs.
--
-- Does NOT skip guards:
--   - picking item completion (marks remaining via staff_set_picking_item_completed)
--   - reservation consistency
--   - delivery_note required before ship (staff_ship_order)
--   - physical write-off only inside staff_fulfill_order_reservations
--
-- Does NOT modify pricing, payments calc, VAT, inventory model,
-- reservation model, catalog, procurement, or supplies.
-- Does NOT edit migrations 001–049.
-- ============================================================

do $$
begin
  if to_regprocedure('public.staff_start_order_picking(uuid)') is null then
    raise exception 'staff_start_order_picking missing — run 017 first.';
  end if;
  if to_regprocedure('public.staff_set_picking_item_completed(uuid, boolean)') is null then
    raise exception 'staff_set_picking_item_completed missing — run 017 first.';
  end if;
  if to_regprocedure('public.staff_complete_order_picking(uuid)') is null then
    raise exception 'staff_complete_order_picking missing — run 017 first.';
  end if;
  if to_regprocedure('public.staff_ship_order(uuid)') is null then
    raise exception 'staff_ship_order missing — run 017 first.';
  end if;
  if to_regprocedure('public.staff_change_order_status(uuid, text, text)') is null then
    raise exception 'staff_change_order_status missing — run 022 first.';
  end if;
  if to_regprocedure('public.staff_record_order_activity(uuid, text, text, jsonb)') is null then
    raise exception 'staff_record_order_activity missing — run 041 first.';
  end if;
  if to_regprocedure('public.staff_resolve_order_amount_due(uuid)') is null then
    raise exception 'staff_resolve_order_amount_due missing — run 022 first.';
  end if;
  if to_regprocedure('public.staff_sum_confirmed_order_payments(uuid)') is null then
    raise exception 'staff_sum_confirmed_order_payments missing — run 022 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run staff role migrations first.';
  end if;
end
$$;

-- ============================================================
-- 1. Activity log: fast_completed_by_staff
-- ============================================================

alter table public.order_activity_log
  drop constraint if exists order_activity_log_event_type_check;

alter table public.order_activity_log
  add constraint order_activity_log_event_type_check check (
    event_type in (
      'manager_assigned',
      'manager_unassigned',
      'deadlines_updated',
      'payment_recorded',
      'payment_reversed',
      'payment_completed',
      'payment_shortfall_after_reversal',
      'payment_claimed',
      'invoice_generation_failed',
      'item_price_overridden',
      'item_price_reset',
      'fast_completed_by_staff'
    )
  );

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
     or p_event_type not in (
       'manager_assigned',
       'manager_unassigned',
       'deadlines_updated',
       'payment_recorded',
       'payment_reversed',
       'payment_completed',
       'payment_shortfall_after_reversal',
       'payment_claimed',
       'invoice_generation_failed',
       'item_price_overridden',
       'item_price_reset',
       'fast_completed_by_staff'
     )
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

revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb)
  from public, anon, authenticated;

comment on function public.staff_record_order_activity(uuid, text, text, jsonb) is
  'Internal order activity writer. Stage 50 adds fast_completed_by_staff.';

-- ============================================================
-- 2. staff_fast_complete_order — orchestration only
-- ============================================================

create or replace function public.staff_fast_complete_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_item_id uuid;
  v_steps text[] := array[]::text[];
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_tol numeric(14, 2) := public.staff_payment_rounding_tolerance();
  v_items_count integer;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  -- Same role gate as staff_change_order_status (manager/admin only).
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для быстрого завершения заказа';
  end if;

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

  -- Idempotent retry: already completed → no side effects, no activity.
  if v_order.status = 'completed' then
    return jsonb_build_object(
      'order_id', v_order.id,
      'order_status', v_order.status,
      'idempotent', true,
      'steps', '[]'::jsonb
    );
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Нельзя быстро завершить отменённый заказ';
  end if;

  if v_order.status not in (
    'paid',
    'picking',
    'ready_for_shipment',
    'shipped'
  ) then
    raise exception
      'Быстрое завершение доступно только после оплаты (paid и далее). Текущий статус: %',
      v_order.status;
  end if;

  select count(*) into v_items_count
  from public.order_items as oi
  where oi.order_id = p_order_id;

  if v_items_count < 1 then
    raise exception 'Нельзя быстро завершить пустой заказ';
  end if;

  -- Full confirmed payment required before inventory write-off path.
  -- shipped → completed does not re-check (stock already written off by ship).
  if v_order.status in ('paid', 'picking', 'ready_for_shipment') then
    v_due := public.staff_resolve_order_amount_due(p_order_id);
    v_paid := public.staff_sum_confirmed_order_payments(p_order_id);

    if v_due <= 0 then
      raise exception
        'Быстрое завершение требует положительную сумму к оплате';
    end if;

    if v_paid + v_tol < v_due then
      raise exception
        'Быстрое завершение требует полной подтверждённой оплаты: оплачено % из %',
        v_paid,
        v_due;
    end if;
  end if;

  -- paid → picking (existing RPC: task snapshot + status history + warehouse activity)
  if v_order.status = 'paid' then
    perform public.staff_start_order_picking(p_order_id);
    v_steps := array_append(v_steps, 'picking');
    select * into v_order from public.orders as o where o.id = p_order_id;
  end if;

  -- picking → mark remaining items complete → ready_for_shipment
  if v_order.status = 'picking' then
    perform public.staff_assert_active_reservations_consistent(p_order_id);

    for v_item_id in
      select pi.id
      from public.order_picking_items as pi
      inner join public.order_picking_tasks as t
        on t.id = pi.picking_task_id
      where t.order_id = p_order_id
        and pi.is_completed = false
      order by pi.id
    loop
      -- Explicit confirm semantics: full required quantity via existing helper.
      perform public.staff_set_picking_item_completed(v_item_id, true);
    end loop;

    perform public.staff_complete_order_picking(p_order_id);
    v_steps := array_append(v_steps, 'ready_for_shipment');
    select * into v_order from public.orders as o where o.id = p_order_id;
  end if;

  -- ready_for_shipment → shipped (write-off + DN guard live here)
  if v_order.status = 'ready_for_shipment' then
    perform public.staff_ship_order(p_order_id);
    v_steps := array_append(v_steps, 'shipped');
    select * into v_order from public.orders as o where o.id = p_order_id;
  end if;

  -- shipped → completed
  if v_order.status = 'shipped' then
    perform public.staff_change_order_status(
      p_order_id,
      'completed',
      'Быстрое завершение выполнено сотрудником'
    );
    v_steps := array_append(v_steps, 'completed');
    select * into v_order from public.orders as o where o.id = p_order_id;
  end if;

  if v_order.status is distinct from 'completed' then
    raise exception
      'Не удалось быстро завершить заказ (остался статус %)',
      v_order.status;
  end if;

  perform public.staff_record_order_activity(
    p_order_id,
    'fast_completed_by_staff',
    'Быстрое завершение выполнено сотрудником',
    jsonb_build_object(
      'steps', to_jsonb(v_steps),
      'fast_path', true
    )
  );

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_status', v_order.status,
    'idempotent', false,
    'steps', to_jsonb(v_steps)
  );
end;
$$;

revoke all on function public.staff_fast_complete_order(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_fast_complete_order(uuid)
  to authenticated;

comment on function public.staff_fast_complete_order(uuid) is
  'Stage 50: manager/admin orchestration RPC. Sequences existing picking/ship/complete '
  'transitions in one transaction. Does not skip inventory write-off or DN guards.';
