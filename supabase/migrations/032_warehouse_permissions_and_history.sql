-- ============================================================
-- 032_warehouse_permissions_and_history.sql
-- Stage 32 — Warehouse permission hardening + shipment history
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–031 files.
-- Does NOT create analytics-consent tables (client localStorage).
--
-- Business rule change vs 030/031:
--   warehouse may pick / complete / ship / read shipment history
--   warehouse may NOT record stock receipts, adjust inventory,
--   or create/apply/cancel 1C reconciliation.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null
     or to_regclass('public.order_items') is null
  then
    raise exception 'orders/order_items missing — run 005_orders.sql first.';
  end if;

  if to_regclass('public.order_status_history') is null then
    raise exception
      'order_status_history missing — run 012_staff_order_workflow.sql first.';
  end if;

  if to_regclass('public.order_warehouse_activity') is null then
    raise exception
      'order_warehouse_activity missing — run 017_warehouse_operations.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_escape_ilike_term(text)') is null then
    raise exception
      'staff_escape_ilike_term missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.staff_assert_stock_receipt_role()') is null then
    raise exception
      'staff_assert_stock_receipt_role missing — run 030_workflow_notifications.sql first.';
  end if;

  if to_regprocedure('public.staff_assert_inventory_reconciliation_role()') is null then
    raise exception
      'staff_assert_inventory_reconciliation_role missing — run 031_inventory_reconciliation.sql first.';
  end if;

  if to_regprocedure('public.staff_adjust_product_inventory(uuid, numeric, text)') is null then
    raise exception
      'staff_adjust_product_inventory missing — run 020_product_inventory_and_catalog_images.sql first.';
  end if;

  if to_regprocedure('public.staff_list_product_stock_receipts(uuid, integer)') is null then
    raise exception
      'staff_list_product_stock_receipts missing — run 030_workflow_notifications.sql first.';
  end if;

  if to_regprocedure('public.staff_list_product_inventory_adjustments(uuid, integer)') is null then
    raise exception
      'staff_list_product_inventory_adjustments missing — run 020_product_inventory_and_catalog_images.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Indexes for shipment history (grows for years)
-- ============================================================

create index if not exists order_warehouse_activity_shipped_at_idx
  on public.order_warehouse_activity (created_at desc)
  where event_type = 'order_shipped';

create index if not exists order_warehouse_activity_shipped_order_idx
  on public.order_warehouse_activity (order_id, created_at desc)
  where event_type = 'order_shipped';

create index if not exists order_status_history_shipped_at_idx
  on public.order_status_history (created_at desc)
  where to_status = 'shipped';

create index if not exists order_status_history_order_to_status_idx
  on public.order_status_history (order_id, to_status, created_at);

create index if not exists order_items_order_sku_name_idx
  on public.order_items (order_id, product_sku, product_name);

-- ============================================================
-- 2. Stage 30 fix — stock receipt write: admin only
-- ============================================================

create or replace function public.staff_assert_stock_receipt_role()
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

  -- Stage 32: warehouse no longer records arrivals.
  if not public.has_staff_role(
    array['admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для оприходования товара';
  end if;
end;
$$;

revoke all on function public.staff_assert_stock_receipt_role()
  from public, anon, authenticated;

comment on function public.staff_assert_stock_receipt_role() is
  'Admin only (032). Warehouse/manager/accountant/client denied. Inactive staff fail has_staff_role.';

comment on function public.staff_record_stock_receipt(uuid, numeric, text, text) is
  'Admin only: explicit stock receipt (+qty). Warehouse denied as of 032. Does not touch reserved_quantity.';

-- List receipts: manager keeps read (existing product-card UI).
-- Warehouse denied — shipment history ≠ inventory movement history.
create or replace function public.staff_list_product_stock_receipts(
  p_product_id uuid,
  p_limit integer default 20
)
returns table (
  id uuid,
  product_id uuid,
  warehouse_id uuid,
  quantity numeric,
  previous_quantity numeric,
  new_quantity numeric,
  document_number text,
  reason text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра поступлений';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);

  return query
  select
    r.id,
    r.product_id,
    r.warehouse_id,
    r.quantity,
    r.previous_quantity,
    r.new_quantity,
    r.document_number,
    r.reason,
    r.created_by,
    pr.full_name as created_by_name,
    r.created_at
  from public.stock_receipts as r
  left join public.profiles as pr on pr.id = r.created_by
  where r.product_id = p_product_id
  order by r.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_product_stock_receipts(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_product_stock_receipts(uuid, integer)
  to authenticated;

comment on function public.staff_list_product_stock_receipts(uuid, integer) is
  'Manager/admin read of stock receipts. Warehouse denied as of 032.';

-- ============================================================
-- 3. Inventory correction — confirm admin only (already true in 020)
--    Adjustment history: warehouse denied (not shipment history).
-- ============================================================

comment on function public.staff_adjust_product_inventory(uuid, numeric, text) is
  'Admin only: manual physical quantity correction. Warehouse is denied (020 role check; confirmed 032).';

create or replace function public.staff_list_product_inventory_adjustments(
  p_product_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  inventory_id uuid,
  product_id uuid,
  warehouse_id uuid,
  previous_quantity numeric,
  new_quantity numeric,
  difference numeric,
  reason text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра истории остатков';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  return query
  select
    a.id,
    a.inventory_id,
    a.product_id,
    a.warehouse_id,
    a.previous_quantity,
    a.new_quantity,
    a.difference,
    a.reason,
    a.created_by,
    pr.full_name as created_by_name,
    a.created_at
  from public.inventory_adjustments as a
  left join public.profiles as pr on pr.id = a.created_by
  where a.product_id = p_product_id
  order by a.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_product_inventory_adjustments(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_product_inventory_adjustments(uuid, integer)
  to authenticated;

comment on function public.staff_list_product_inventory_adjustments(uuid, integer) is
  'Manager/admin read of inventory corrections. Warehouse denied as of 032.';

-- ============================================================
-- 4. Stage 31 fix — 1C reconciliation: admin only
-- ============================================================

create or replace function public.staff_assert_inventory_reconciliation_role()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  -- Stage 32: warehouse no longer reconciles with 1C.
  if not public.has_staff_role(
    array['admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для сверки остатков с 1С';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.staff_assert_inventory_reconciliation_role()
  from public, anon, authenticated;

comment on function public.staff_assert_inventory_reconciliation_role() is
  'Admin only (032). Gates create/get/list/apply/cancel. Warehouse denied. Inactive staff denied.';

comment on function public.staff_create_inventory_reconciliation(text, jsonb, jsonb) is
  'Admin only: 1C comparison session. Does not change inventory. Warehouse denied as of 032.';

comment on function public.staff_get_inventory_reconciliation(uuid) is
  'Admin only: read one 1C reconciliation. Warehouse denied as of 032.';

comment on function public.staff_list_inventory_reconciliations(integer) is
  'Admin only: list 1C reconciliations. Warehouse denied as of 032.';

comment on function public.staff_apply_inventory_reconciliation(uuid, uuid[]) is
  'Admin only: apply selected 1C diffs. Warehouse denied as of 032.';

comment on function public.staff_cancel_inventory_reconciliation(uuid) is
  'Admin only: cancel a 1C session. Warehouse denied as of 032.';

-- ============================================================
-- 5. History role helper — warehouse + admin read
--    Manager/accountant/client are not granted automatically.
-- ============================================================

create or replace function public.staff_assert_warehouse_history_role()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для истории отгрузок';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.staff_assert_warehouse_history_role()
  from public, anon, authenticated;

comment on function public.staff_assert_warehouse_history_role() is
  'Warehouse/admin read of shipment history. Manager/accountant/client denied. Inactive staff denied via has_staff_role.';

-- ============================================================
-- 6. staff_list_warehouse_shipment_history
--    Source of truth: order_shipped activity, else status history to shipped.
--    Warehouse-safe columns only — no totals, payments, invoices, debt.
-- ============================================================

drop function if exists public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer);

create or replace function public.staff_list_warehouse_shipment_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  order_id uuid,
  order_number text,
  customer_display_name text,
  shipped_at timestamptz,
  line_count integer,
  total_quantity numeric,
  picked_by_name text,
  shipped_by_name text,
  status text,
  total_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_offset integer;
  v_search text;
begin
  perform public.staff_assert_warehouse_history_role();

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'Некорректный период: дата начала позже даты окончания';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  v_search := nullif(trim(coalesce(p_search, '')), '');
  if v_search is not null then
    v_search := public.staff_escape_ilike_term(v_search);
  end if;

  return query
  with shipped_events as (
    select
      a.order_id,
      a.created_at as shipped_at,
      a.created_by as shipped_by,
      row_number() over (
        partition by a.order_id
        order by a.created_at desc, a.id desc
      ) as rn
    from public.order_warehouse_activity as a
    where a.event_type = 'order_shipped'
    union all
    select
      h.order_id,
      h.created_at,
      h.changed_by,
      row_number() over (
        partition by h.order_id
        order by h.created_at desc, h.id desc
      )
    from public.order_status_history as h
    where h.to_status = 'shipped'
      and not exists (
        select 1
        from public.order_warehouse_activity as a
        where a.order_id = h.order_id
          and a.event_type = 'order_shipped'
      )
  ),
  shipped as (
    select
      e.order_id,
      e.shipped_at,
      e.shipped_by
    from shipped_events as e
    where e.rn = 1
  ),
  filtered as (
    select
      o.id as order_id,
      o.order_number,
      coalesce(c.display_name, o.contact_name) as customer_display_name,
      s.shipped_at,
      coalesce(item_stats.line_count, 0)::integer as line_count,
      coalesce(item_stats.total_quantity, 0) as total_quantity,
      picker.full_name as picked_by_name,
      shipper.full_name as shipped_by_name,
      o.status,
      count(*) over ()::integer as total_count
    from shipped as s
    join public.orders as o on o.id = s.order_id
    left join public.customers as c on c.id = o.customer_id
    left join public.order_picking_tasks as t on t.order_id = o.id
    left join public.profiles as picker on picker.id = t.assigned_to
    left join public.profiles as shipper on shipper.id = s.shipped_by
    left join lateral (
      select
        count(oi.id)::integer as line_count,
        coalesce(sum(oi.quantity), 0) as total_quantity
      from public.order_items as oi
      where oi.order_id = o.id
    ) as item_stats on true
    where (p_from is null or s.shipped_at >= p_from)
      and (p_to is null or s.shipped_at <= p_to)
      and (
        v_search is null
        or o.order_number ilike '%' || v_search || '%' escape '\'
        or o.contact_name ilike '%' || v_search || '%' escape '\'
        or coalesce(c.display_name, '') ilike '%' || v_search || '%' escape '\'
        or exists (
          select 1
          from public.order_items as oi
          where oi.order_id = o.id
            and (
              coalesce(oi.product_sku, '') ilike '%' || v_search || '%' escape '\'
              or oi.product_name ilike '%' || v_search || '%' escape '\'
            )
        )
      )
  )
  select
    f.order_id,
    f.order_number,
    f.customer_display_name,
    f.shipped_at,
    f.line_count,
    f.total_quantity,
    f.picked_by_name,
    f.shipped_by_name,
    f.status,
    f.total_count
  from filtered as f
  order by f.shipped_at desc, f.order_id desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer)
  to authenticated;

comment on function public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer) is
  'Warehouse/admin: paginated shipped-order history. Source = order_shipped activity (fallback status history). No financial fields.';

-- ============================================================
-- 7. staff_get_warehouse_shipment_history_order
--    Warehouse-safe detail: items + warehouse timeline only.
-- ============================================================

drop function if exists public.staff_get_warehouse_shipment_history_order(uuid);

create or replace function public.staff_get_warehouse_shipment_history_order(
  p_order_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shipped_at timestamptz;
  v_shipped_by uuid;
  v_result jsonb;
begin
  perform public.staff_assert_warehouse_history_role();

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  select a.created_at, a.created_by
    into v_shipped_at, v_shipped_by
  from public.order_warehouse_activity as a
  where a.order_id = p_order_id
    and a.event_type = 'order_shipped'
  order by a.created_at desc, a.id desc
  limit 1;

  if v_shipped_at is null then
    select h.created_at, h.changed_by
      into v_shipped_at, v_shipped_by
    from public.order_status_history as h
    where h.order_id = p_order_id
      and h.to_status = 'shipped'
    order by h.created_at desc
    limit 1;
  end if;

  if v_shipped_at is null then
    raise exception 'Заказ не найден в истории отгрузок';
  end if;

  select jsonb_build_object(
    'order', jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'status', o.status,
      'created_at', o.created_at
    ),
    'customer_display_name', coalesce(c.display_name, o.contact_name),
    'shipped_at', v_shipped_at,
    'picked_by_name', picker.full_name,
    'shipped_by_name', shipper.full_name,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'product_id', oi.product_id,
          'product_sku', oi.product_sku,
          'product_name', oi.product_name,
          'quantity', oi.quantity
        )
        order by oi.created_at asc, oi.id asc
      )
      from public.order_items as oi
      where oi.order_id = o.id
    ), '[]'::jsonb),
    'timeline', jsonb_build_object(
      'paid_at', (
        select min(h.created_at)
        from public.order_status_history as h
        where h.order_id = o.id
          and h.to_status = 'paid'
      ),
      'picking_started_at', coalesce(
        t.started_at,
        (
          select min(a.created_at)
          from public.order_warehouse_activity as a
          where a.order_id = o.id
            and a.event_type = 'picking_started'
        )
      ),
      'picking_completed_at', coalesce(
        t.completed_at,
        (
          select min(a.created_at)
          from public.order_warehouse_activity as a
          where a.order_id = o.id
            and a.event_type = 'picking_completed'
        )
      ),
      'shipped_at', v_shipped_at
    )
  )
  into v_result
  from public.orders as o
  left join public.customers as c on c.id = o.customer_id
  left join public.order_picking_tasks as t on t.order_id = o.id
  left join public.profiles as picker on picker.id = t.assigned_to
  left join public.profiles as shipper on shipper.id = v_shipped_by
  where o.id = p_order_id;

  return v_result;
end;
$$;

revoke all on function public.staff_get_warehouse_shipment_history_order(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_warehouse_shipment_history_order(uuid)
  to authenticated;

comment on function public.staff_get_warehouse_shipment_history_order(uuid) is
  'Warehouse/admin: shipped-order detail. Items + warehouse timeline only. No prices, payments, invoices, or private customer fields.';
