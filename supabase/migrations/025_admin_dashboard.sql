-- ============================================================
-- 025_admin_dashboard.sql
-- Stage 25 — Director / admin business monitoring dashboard
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–024 files.
--
-- Timezone for all period bounds: Asia/Almaty.
--
-- Sales (продажи):
--   SUM(amount_due) for orders that first reached status `completed`
--   within [p_date_from, p_date_to] (inclusive end day in Almaty).
--   amount_due = frozen obligation OR provisional invoice final_total
--   OR orders.total. Cancelled orders excluded.
--   Requires order_status_history → completed; legacy completed rows
--   without history are excluded (historical-data limitation).
-- Top products:
--   SUM(order_items.line_total) — catalog net, no VAT allocation from invoice.
--
-- Paid (оплачено):
--   SUM(confirmed order_payments.amount) where payment_date in period.
--   Reversed payments excluded.
--
-- Receivables (дебиторка / просрочено):
--   Current snapshot (not period-limited):
--   SUM(max(amount_due - confirmed_paid, 0)) for non-cancelled orders.
--   Overdue: remaining > 0 AND payment_due_at < now().
--
-- Access: active admin only (has_staff_role admin via get_my_role).
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'public.orders missing — run 005+ first.';
  end if;
  if to_regclass('public.order_payments') is null then
    raise exception 'public.order_payments missing — run 022 first.';
  end if;
  if to_regclass('public.order_payment_obligations') is null then
    raise exception 'public.order_payment_obligations missing — run 022 first.';
  end if;
  if to_regclass('public.order_status_history') is null then
    raise exception 'public.order_status_history missing — run 012 first.';
  end if;
  if to_regclass('public.inventory') is null then
    raise exception 'public.inventory missing — run 002 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role missing — run 010 first.';
  end if;
  if to_regprocedure('public.staff_derive_payment_status(numeric, numeric)') is null then
    raise exception 'public.staff_derive_payment_status missing — run 022 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Indexes (only if missing)
-- ============================================================

create index if not exists order_status_history_to_status_created_at_idx
  on public.order_status_history (to_status, created_at desc);

create index if not exists order_payments_status_payment_date_idx
  on public.order_payments (status, payment_date desc);

create index if not exists orders_status_created_at_idx
  on public.orders (status, created_at desc);

create index if not exists orders_assigned_manager_status_idx
  on public.orders (assigned_manager_id, status)
  where assigned_manager_id is not null;

create index if not exists order_activity_log_created_at_idx
  on public.order_activity_log (created_at desc);

create index if not exists order_warehouse_activity_created_at_idx
  on public.order_warehouse_activity (created_at desc);

-- ============================================================
-- 2. Internal helpers (NO EXECUTE grant)
-- ============================================================

create or replace function public.admin_dashboard_assert_caller()
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

  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Dashboard руководителя доступен только администратору';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.admin_dashboard_assert_caller() from public;
revoke all on function public.admin_dashboard_assert_caller() from anon;
revoke all on function public.admin_dashboard_assert_caller() from authenticated;

comment on function public.admin_dashboard_assert_caller() is
  'Internal: require active admin for director dashboard RPCs. No GRANT.';

/**
 * Resolve period in Asia/Almaty.
 * null/null → current calendar month in Almaty.
 * Inclusive end day: ts_to is exclusive start of (date_to + 1 day) Almaty.
 * Max span: 366 days inclusive.
 */
create or replace function public.admin_dashboard_resolve_period(
  p_date_from date,
  p_date_to date
)
returns table (
  date_from date,
  date_to date,
  ts_from timestamptz,
  ts_to timestamptz,
  day_span integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := 'Asia/Almaty';
  v_today date;
  v_from date;
  v_to date;
  v_span integer;
begin
  v_today := (timezone(v_tz, now()))::date;

  if p_date_from is null and p_date_to is null then
    v_from := date_trunc('month', v_today::timestamp)::date;
    v_to := v_today;
  elsif p_date_from is null or p_date_to is null then
    raise exception 'Укажите обе даты периода или оставьте обе пустыми (текущий месяц)';
  else
    v_from := p_date_from;
    v_to := p_date_to;
  end if;

  if v_from > v_to then
    raise exception 'date_from (%) не может быть позже date_to (%)', v_from, v_to;
  end if;

  v_span := (v_to - v_from) + 1;
  if v_span > 366 then
    raise exception 'Максимальный диапазон dashboard — 366 дней (запрошено %)', v_span;
  end if;

  return query
  select
    v_from,
    v_to,
    (v_from::timestamp at time zone v_tz),
    ((v_to + 1)::timestamp at time zone v_tz),
    v_span;
end;
$$;

revoke all on function public.admin_dashboard_resolve_period(date, date) from public;
revoke all on function public.admin_dashboard_resolve_period(date, date) from anon;
revoke all on function public.admin_dashboard_resolve_period(date, date) from authenticated;

/**
 * Set-based amount_due / paid / remaining for non-cancelled orders.
 * Same resolution as staff_get_customer_receivables (022).
 */
create or replace function public.admin_dashboard_orders_money()
returns table (
  order_id uuid,
  order_number text,
  status text,
  customer_id uuid,
  assigned_manager_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  payment_due_at timestamptz,
  reservation_expires_at timestamptz,
  amount_due numeric,
  amount_paid numeric,
  amount_remaining numeric,
  payment_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  with order_rows as (
    select
      o.id,
      o.order_number,
      o.status,
      o.customer_id,
      o.assigned_manager_id,
      o.created_at,
      o.updated_at,
      o.payment_due_at,
      o.reservation_expires_at,
      o.total,
      d.metadata as doc_metadata,
      d.id as doc_id,
      obl.amount_due as frozen_due,
      (obl.order_id is not null) as is_frozen
    from public.orders as o
    left join public.order_documents as d
      on d.order_id = o.id
     and d.document_type = 'invoice'
     and d.status = 'generated'
    left join public.order_payment_obligations as obl
      on obl.order_id = o.id
    where o.status <> 'cancelled'
  ),
  with_due as (
    select
      r.id as order_id,
      r.order_number,
      r.status,
      r.customer_id,
      r.assigned_manager_id,
      r.created_at,
      r.updated_at,
      r.payment_due_at,
      r.reservation_expires_at,
      case
        when r.is_frozen then round(r.frozen_due, 2)
        when r.doc_id is not null then
          round(
            coalesce(
              nullif(r.doc_metadata -> 'totals' ->> 'final_total', '')::numeric,
              nullif(r.doc_metadata -> 'totals' ->> 'total', '')::numeric,
              r.total
            ),
            2
          )
        else round(coalesce(r.total, 0), 2)
      end as amount_due
    from order_rows as r
  ),
  with_paid as (
    select
      d.order_id,
      d.order_number,
      d.status,
      d.customer_id,
      d.assigned_manager_id,
      d.created_at,
      d.updated_at,
      d.payment_due_at,
      d.reservation_expires_at,
      d.amount_due,
      coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0)::numeric(14, 2)
        as amount_paid
    from with_due as d
    left join public.order_payments as p on p.order_id = d.order_id
    group by
      d.order_id,
      d.order_number,
      d.status,
      d.customer_id,
      d.assigned_manager_id,
      d.created_at,
      d.updated_at,
      d.payment_due_at,
      d.reservation_expires_at,
      d.amount_due
  )
  select
    w.order_id,
    w.order_number,
    w.status,
    w.customer_id,
    w.assigned_manager_id,
    w.created_at,
    w.updated_at,
    w.payment_due_at,
    w.reservation_expires_at,
    w.amount_due,
    w.amount_paid,
    (w.amount_due - w.amount_paid)::numeric(14, 2) as amount_remaining,
    public.staff_derive_payment_status(w.amount_due, w.amount_paid) as payment_status
  from with_paid as w;
$$;

revoke all on function public.admin_dashboard_orders_money() from public;
revoke all on function public.admin_dashboard_orders_money() from anon;
revoke all on function public.admin_dashboard_orders_money() from authenticated;

/**
 * First completion event per order (status history → completed).
 */
create or replace function public.admin_dashboard_completed_events()
returns table (
  order_id uuid,
  completed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (h.order_id)
    h.order_id,
    h.created_at as completed_at
  from public.order_status_history as h
  join public.orders as o on o.id = h.order_id
  where h.to_status = 'completed'
    and o.status = 'completed'
  order by h.order_id, h.created_at asc;
$$;

revoke all on function public.admin_dashboard_completed_events() from public;
revoke all on function public.admin_dashboard_completed_events() from anon;
revoke all on function public.admin_dashboard_completed_events() from authenticated;

-- ============================================================
-- 3. admin_get_dashboard_summary
-- ============================================================

create or replace function public.admin_get_dashboard_summary(
  p_date_from date default null,
  p_date_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_tol numeric(14, 2) := 0.01;
  v_sales numeric(14, 2) := 0;
  v_sales_orders integer := 0;
  v_paid numeric(14, 2) := 0;
  v_ar numeric(14, 2) := 0;
  v_ar_overdue numeric(14, 2) := 0;
  v_new_orders integer := 0;
  v_avg numeric(14, 2) := 0;
  v_status jsonb;
  v_ops jsonb;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  -- Sales: completed in period (amount_due)
  select
    coalesce(sum(m.amount_due), 0)::numeric(14, 2),
    count(*)::integer
  into v_sales, v_sales_orders
  from public.admin_dashboard_completed_events() as c
  join public.admin_dashboard_orders_money() as m on m.order_id = c.order_id
  where c.completed_at >= v_period.ts_from
    and c.completed_at < v_period.ts_to;

  -- Paid: confirmed payments by payment_date (calendar date)
  select coalesce(sum(p.amount), 0)::numeric(14, 2)
  into v_paid
  from public.order_payments as p
  where p.status = 'confirmed'
    and p.payment_date >= v_period.date_from
    and p.payment_date <= v_period.date_to;

  -- Receivables / overdue (current snapshot)
  select
    coalesce(sum(greatest(m.amount_remaining, 0)), 0)::numeric(14, 2),
    coalesce(
      sum(greatest(m.amount_remaining, 0)) filter (
        where m.amount_remaining > v_tol
          and m.payment_due_at is not null
          and m.payment_due_at < now()
      ),
      0
    )::numeric(14, 2)
  into v_ar, v_ar_overdue
  from public.admin_dashboard_orders_money() as m;

  -- New orders in period
  select count(*)::integer
  into v_new_orders
  from public.orders as o
  where o.created_at >= v_period.ts_from
    and o.created_at < v_period.ts_to;

  if v_sales_orders > 0 then
    v_avg := round(v_sales / v_sales_orders, 2);
  else
    v_avg := 0;
  end if;

  -- Status breakdown: count + amount_due (cancelled uses orders.total)
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'status', s.status,
      'orders_count', s.orders_count,
      'amount_total', s.amount_total
    )
    order by s.sort_order
  ), '[]'::jsonb)
  into v_status
  from (
    select
      st.status,
      st.sort_order,
      count(o.id)::integer as orders_count,
      coalesce(
        sum(
          case
            when o.status = 'cancelled' then round(coalesce(o.total, 0), 2)
            else m.amount_due
          end
        ),
        0
      )::numeric(14, 2) as amount_total
    from (
      values
        ('new', 1),
        ('awaiting_payment', 2),
        ('paid', 3),
        ('picking', 4),
        ('ready_for_shipment', 5),
        ('shipped', 6),
        ('completed', 7),
        ('cancelled', 8)
    ) as st(status, sort_order)
    left join public.orders as o on o.status = st.status
    left join public.admin_dashboard_orders_money() as m
      on m.order_id = o.id and o.status <> 'cancelled'
    group by st.status, st.sort_order
  ) as s;

  -- Operational alerts (current)
  select jsonb_build_object(
    'awaiting_payment',
      jsonb_build_object(
        'orders_count', count(*) filter (where m.status = 'awaiting_payment'),
        'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'awaiting_payment'), 0)
      ),
    'partially_paid',
      jsonb_build_object(
        'orders_count', count(*) filter (where m.payment_status = 'partially_paid'),
        'amount_remaining', coalesce(sum(greatest(m.amount_remaining, 0)) filter (where m.payment_status = 'partially_paid'), 0)
      ),
    'fully_paid_not_moved',
      jsonb_build_object(
        'orders_count', count(*) filter (
          where m.status = 'awaiting_payment'
            and m.payment_status in ('paid', 'overpaid')
        ),
        'amount_total', coalesce(sum(m.amount_due) filter (
          where m.status = 'awaiting_payment'
            and m.payment_status in ('paid', 'overpaid')
        ), 0)
      ),
    'picking',
      jsonb_build_object(
        'orders_count', count(*) filter (where m.status = 'picking'),
        'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'picking'), 0)
      ),
    'ready_for_shipment',
      jsonb_build_object(
        'orders_count', count(*) filter (where m.status = 'ready_for_shipment'),
        'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'ready_for_shipment'), 0)
      ),
    'shipped_not_completed',
      jsonb_build_object(
        'orders_count', count(*) filter (where m.status = 'shipped'),
        'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'shipped'), 0)
      ),
    'payment_overdue',
      jsonb_build_object(
        'orders_count', count(*) filter (
          where m.amount_remaining > v_tol
            and m.payment_due_at is not null
            and m.payment_due_at < now()
        ),
        'amount_remaining', coalesce(sum(greatest(m.amount_remaining, 0)) filter (
          where m.amount_remaining > v_tol
            and m.payment_due_at is not null
            and m.payment_due_at < now()
        ), 0)
      ),
    'reservation_overdue',
      jsonb_build_object(
        'orders_count', count(*) filter (
          where m.reservation_expires_at is not null
            and m.reservation_expires_at < now()
            and m.status not in ('shipped', 'completed')
        ),
        'amount_total', coalesce(sum(m.amount_due) filter (
          where m.reservation_expires_at is not null
            and m.reservation_expires_at < now()
            and m.status not in ('shipped', 'completed')
        ), 0)
      ),
    'unassigned_manager',
      jsonb_build_object(
        'orders_count', count(*) filter (
          where m.assigned_manager_id is null
            and m.status not in ('completed')
        ),
        'amount_total', coalesce(sum(m.amount_due) filter (
          where m.assigned_manager_id is null
            and m.status not in ('completed')
        ), 0)
      )
  )
  into v_ops
  from public.admin_dashboard_orders_money() as m;

  return jsonb_build_object(
    'timezone', 'Asia/Almaty',
    'period', jsonb_build_object(
      'date_from', v_period.date_from,
      'date_to', v_period.date_to,
      'day_span', v_period.day_span
    ),
    'kpi', jsonb_build_object(
      'sales_amount', v_sales,
      'sales_orders_count', v_sales_orders,
      'payments_amount', v_paid,
      'receivables_amount', v_ar,
      'overdue_receivables_amount', v_ar_overdue,
      'new_orders_count', v_new_orders,
      'average_order_value', v_avg
    ),
    'statuses', coalesce(v_status, '[]'::jsonb),
    'operational', coalesce(v_ops, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.admin_get_dashboard_summary(date, date) from public;
revoke all on function public.admin_get_dashboard_summary(date, date) from anon;
revoke all on function public.admin_get_dashboard_summary(date, date) from authenticated;
grant execute on function public.admin_get_dashboard_summary(date, date) to authenticated;

comment on function public.admin_get_dashboard_summary(date, date) is
  'Director dashboard KPI + status + operational alerts. Active admin only.';

-- ============================================================
-- 4. admin_get_dashboard_chart
-- ============================================================

create or replace function public.admin_get_dashboard_chart(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_date date,
  bucket_label text,
  granularity text,
  sales_amount numeric,
  payments_amount numeric,
  orders_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_granularity text;
  v_tz text := 'Asia/Almaty';
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  if v_period.day_span <= 31 then
    v_granularity := 'day';
  elsif v_period.day_span <= 92 then
    v_granularity := 'week';
  else
    v_granularity := 'month';
  end if;

  return query
  with buckets as (
    select
      case v_granularity
        when 'day' then d::date
        when 'week' then date_trunc('week', d::timestamp)::date
        else date_trunc('month', d::timestamp)::date
      end as bucket_date
    from generate_series(v_period.date_from, v_period.date_to, interval '1 day') as d
    group by 1
  ),
  sales as (
    select
      case v_granularity
        when 'day' then (timezone(v_tz, c.completed_at))::date
        when 'week' then date_trunc('week', timezone(v_tz, c.completed_at))::date
        else date_trunc('month', timezone(v_tz, c.completed_at))::date
      end as bucket_date,
      sum(m.amount_due)::numeric(14, 2) as sales_amount,
      count(*)::integer as orders_count
    from public.admin_dashboard_completed_events() as c
    join public.admin_dashboard_orders_money() as m on m.order_id = c.order_id
    where c.completed_at >= v_period.ts_from
      and c.completed_at < v_period.ts_to
    group by 1
  ),
  pays as (
    select
      case v_granularity
        when 'day' then p.payment_date
        when 'week' then date_trunc('week', p.payment_date::timestamp)::date
        else date_trunc('month', p.payment_date::timestamp)::date
      end as bucket_date,
      sum(p.amount)::numeric(14, 2) as payments_amount
    from public.order_payments as p
    where p.status = 'confirmed'
      and p.payment_date >= v_period.date_from
      and p.payment_date <= v_period.date_to
    group by 1
  )
  select
    b.bucket_date,
    case v_granularity
      when 'day' then to_char(b.bucket_date, 'DD.MM')
      when 'week' then 'нед. ' || to_char(b.bucket_date, 'DD.MM')
      else to_char(b.bucket_date, 'MM.YYYY')
    end as bucket_label,
    v_granularity as granularity,
    coalesce(s.sales_amount, 0)::numeric(14, 2),
    coalesce(p.payments_amount, 0)::numeric(14, 2),
    coalesce(s.orders_count, 0)::integer
  from buckets as b
  left join sales as s on s.bucket_date = b.bucket_date
  left join pays as p on p.bucket_date = b.bucket_date
  order by b.bucket_date;
end;
$$;

revoke all on function public.admin_get_dashboard_chart(date, date) from public;
revoke all on function public.admin_get_dashboard_chart(date, date) from anon;
revoke all on function public.admin_get_dashboard_chart(date, date) from authenticated;
grant execute on function public.admin_get_dashboard_chart(date, date) to authenticated;

-- ============================================================
-- 5. admin_get_dashboard_top_products
-- ============================================================

create or replace function public.admin_get_dashboard_top_products(
  p_date_from date default null,
  p_date_to date default null,
  p_limit integer default 10
)
returns table (
  product_id uuid,
  product_sku text,
  product_name text,
  main_photo_path text,
  quantity_sold numeric,
  sales_amount numeric,
  orders_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  return query
  select
    oi.product_id,
    max(oi.product_sku)::text as product_sku,
    max(oi.product_name)::text as product_name,
    max(pr.main_photo_path)::text as main_photo_path,
    sum(oi.quantity)::numeric as quantity_sold,
    sum(oi.line_total)::numeric(14, 2) as sales_amount,
    count(distinct oi.order_id)::integer as orders_count
  from public.admin_dashboard_completed_events() as c
  join public.order_items as oi on oi.order_id = c.order_id
  left join public.products as pr on pr.id = oi.product_id
  where c.completed_at >= v_period.ts_from
    and c.completed_at < v_period.ts_to
  group by oi.product_id
  order by sum(oi.line_total) desc, sum(oi.quantity) desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_dashboard_top_products(date, date, integer) from public;
revoke all on function public.admin_get_dashboard_top_products(date, date, integer) from anon;
revoke all on function public.admin_get_dashboard_top_products(date, date, integer) from authenticated;
grant execute on function public.admin_get_dashboard_top_products(date, date, integer) to authenticated;

-- ============================================================
-- 6. admin_get_dashboard_inventory_alerts
-- ============================================================

create or replace function public.admin_get_dashboard_inventory_alerts(
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_zero jsonb;
  v_below_min jsonb;
  v_lowest jsonb;
  v_reserved_amount numeric(14, 3) := 0;
  v_products_with_reserves integer := 0;
begin
  perform public.admin_dashboard_assert_caller();

  with stock as (
    select
      p.id as product_id,
      p.sku,
      p.name,
      p.main_photo_path,
      p.min_order_qty,
      p.status,
      coalesce(sum(i.quantity), 0)::numeric(14, 3) as quantity,
      coalesce(sum(i.reserved_quantity), 0)::numeric(14, 3) as reserved_quantity,
      coalesce(sum(i.quantity - i.reserved_quantity), 0)::numeric(14, 3) as available_quantity
    from public.products as p
    left join public.inventory as i on i.product_id = p.id
    where p.status = 'active'
    group by p.id, p.sku, p.name, p.main_photo_path, p.min_order_qty, p.status
  )
  select
    coalesce(sum(s.reserved_quantity), 0),
    count(*) filter (where s.reserved_quantity > 0)
  into v_reserved_amount, v_products_with_reserves
  from stock as s;

  with stock as (
    select
      p.id as product_id,
      p.sku,
      p.name,
      p.main_photo_path,
      p.min_order_qty,
      coalesce(sum(i.quantity - i.reserved_quantity), 0)::numeric(14, 3) as available_quantity,
      coalesce(sum(i.reserved_quantity), 0)::numeric(14, 3) as reserved_quantity
    from public.products as p
    left join public.inventory as i on i.product_id = p.id
    where p.status = 'active'
    group by p.id, p.sku, p.name, p.main_photo_path, p.min_order_qty
  )
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  into v_zero
  from (
    select
      s.product_id,
      s.sku,
      s.name,
      s.main_photo_path,
      s.available_quantity,
      s.min_order_qty
    from stock as s
    where s.available_quantity <= 0
    order by s.name
    limit v_limit
  ) as x;

  with stock as (
    select
      p.id as product_id,
      p.sku,
      p.name,
      p.main_photo_path,
      p.min_order_qty,
      coalesce(sum(i.quantity - i.reserved_quantity), 0)::numeric(14, 3) as available_quantity
    from public.products as p
    left join public.inventory as i on i.product_id = p.id
    where p.status = 'active'
    group by p.id, p.sku, p.name, p.main_photo_path, p.min_order_qty
  )
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  into v_below_min
  from (
    select
      s.product_id,
      s.sku,
      s.name,
      s.main_photo_path,
      s.available_quantity,
      s.min_order_qty
    from stock as s
    where s.available_quantity > 0
      and s.available_quantity < s.min_order_qty
    order by s.available_quantity asc, s.name
    limit v_limit
  ) as x;

  with stock as (
    select
      p.id as product_id,
      p.sku,
      p.name,
      p.main_photo_path,
      p.min_order_qty,
      coalesce(sum(i.quantity - i.reserved_quantity), 0)::numeric(14, 3) as available_quantity,
      coalesce(sum(i.reserved_quantity), 0)::numeric(14, 3) as reserved_quantity
    from public.products as p
    left join public.inventory as i on i.product_id = p.id
    where p.status = 'active'
    group by p.id, p.sku, p.name, p.main_photo_path, p.min_order_qty
  )
  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
  into v_lowest
  from (
    select
      s.product_id,
      s.sku,
      s.name,
      s.main_photo_path,
      s.available_quantity,
      s.reserved_quantity,
      s.min_order_qty
    from stock as s
    order by s.available_quantity asc, s.name
    limit v_limit
  ) as x;

  return jsonb_build_object(
    'zero_available', coalesce(v_zero, '[]'::jsonb),
    'below_min_order', coalesce(v_below_min, '[]'::jsonb),
    'lowest_stock', coalesce(v_lowest, '[]'::jsonb),
    'reserved_quantity_total', v_reserved_amount,
    'products_with_active_reserves', v_products_with_reserves
  );
end;
$$;

revoke all on function public.admin_get_dashboard_inventory_alerts(integer) from public;
revoke all on function public.admin_get_dashboard_inventory_alerts(integer) from anon;
revoke all on function public.admin_get_dashboard_inventory_alerts(integer) from authenticated;
grant execute on function public.admin_get_dashboard_inventory_alerts(integer) to authenticated;

-- ============================================================
-- 7. admin_get_dashboard_top_customers
-- ============================================================

create or replace function public.admin_get_dashboard_top_customers(
  p_date_from date default null,
  p_date_to date default null,
  p_limit integer default 10
)
returns table (
  customer_id uuid,
  customer_type text,
  display_name text,
  orders_count integer,
  sales_amount numeric,
  payments_amount numeric,
  receivables_amount numeric,
  last_order_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_tol numeric(14, 2) := 0.01;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  return query
  with period_sales as (
    select
      m.customer_id,
      count(*)::integer as orders_count,
      sum(m.amount_due)::numeric(14, 2) as sales_amount,
      max(c.completed_at) as last_completed_at
    from public.admin_dashboard_completed_events() as c
    join public.admin_dashboard_orders_money() as m on m.order_id = c.order_id
    where c.completed_at >= v_period.ts_from
      and c.completed_at < v_period.ts_to
      and m.customer_id is not null
    group by m.customer_id
  ),
  period_payments as (
    select
      o.customer_id,
      sum(p.amount)::numeric(14, 2) as payments_amount
    from public.order_payments as p
    join public.orders as o on o.id = p.order_id
    where p.status = 'confirmed'
      and p.payment_date >= v_period.date_from
      and p.payment_date <= v_period.date_to
      and o.customer_id is not null
    group by o.customer_id
  ),
  current_ar as (
    select
      m.customer_id,
      sum(greatest(m.amount_remaining, 0))::numeric(14, 2) as receivables_amount
    from public.admin_dashboard_orders_money() as m
    where m.customer_id is not null
      and m.amount_remaining > v_tol
    group by m.customer_id
  ),
  last_orders as (
    select
      o.customer_id,
      max(o.created_at) as last_order_at
    from public.orders as o
    where o.customer_id is not null
      and o.status <> 'cancelled'
    group by o.customer_id
  )
  select
    c.id as customer_id,
    c.customer_type::text,
    c.display_name,
    coalesce(ps.orders_count, 0)::integer,
    coalesce(ps.sales_amount, 0)::numeric(14, 2),
    coalesce(pp.payments_amount, 0)::numeric(14, 2),
    coalesce(ar.receivables_amount, 0)::numeric(14, 2),
    lo.last_order_at
  from period_sales as ps
  join public.customers as c on c.id = ps.customer_id
  left join period_payments as pp on pp.customer_id = c.id
  left join current_ar as ar on ar.customer_id = c.id
  left join last_orders as lo on lo.customer_id = c.id
  order by ps.sales_amount desc, ps.orders_count desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_dashboard_top_customers(date, date, integer) from public;
revoke all on function public.admin_get_dashboard_top_customers(date, date, integer) from anon;
revoke all on function public.admin_get_dashboard_top_customers(date, date, integer) from authenticated;
grant execute on function public.admin_get_dashboard_top_customers(date, date, integer) to authenticated;

-- ============================================================
-- 8. admin_get_dashboard_managers
-- ============================================================

create or replace function public.admin_get_dashboard_managers(
  p_date_from date default null,
  p_date_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_stale_days integer := 7;
  v_tol numeric(14, 2) := 0.01;
  v_managers jsonb;
  v_unassigned jsonb;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sales_amount desc, x.full_name), '[]'::jsonb)
  into v_managers
  from (
    select
      p.id as manager_id,
      p.full_name,
      p.email,
      p.role::text as role,
      count(m.order_id) filter (
        where m.status not in ('completed', 'cancelled')
      )::integer as assigned_open_orders,
      count(c.order_id) filter (
        where c.completed_at >= v_period.ts_from
          and c.completed_at < v_period.ts_to
      )::integer as completed_in_period,
      coalesce(sum(m.amount_due) filter (
        where c.completed_at >= v_period.ts_from
          and c.completed_at < v_period.ts_to
      ), 0)::numeric(14, 2) as sales_amount,
      count(m.order_id) filter (where m.status = 'awaiting_payment')::integer as awaiting_payment,
      count(m.order_id) filter (
        where m.amount_remaining > v_tol
          and m.payment_due_at is not null
          and m.payment_due_at < now()
      )::integer as payment_overdue,
      count(m.order_id) filter (
        where m.status not in ('completed', 'cancelled', 'shipped')
          and m.updated_at < (now() - make_interval(days => v_stale_days))
      )::integer as stale_orders,
      v_stale_days as stale_days_threshold
    from public.profiles as p
    left join public.admin_dashboard_orders_money() as m
      on m.assigned_manager_id = p.id
    left join public.admin_dashboard_completed_events() as c
      on c.order_id = m.order_id
    where p.is_active = true
      and p.role in ('manager', 'admin')
    group by p.id, p.full_name, p.email, p.role
  ) as x;

  select jsonb_build_object(
    'orders_count', count(*)::integer,
    'amount_total', coalesce(sum(m.amount_due), 0)::numeric(14, 2),
    'awaiting_payment', count(*) filter (where m.status = 'awaiting_payment'),
    'payment_overdue', count(*) filter (
      where m.amount_remaining > v_tol
        and m.payment_due_at is not null
        and m.payment_due_at < now()
    ),
    'stale_orders', count(*) filter (
      where m.status not in ('completed', 'shipped')
        and m.updated_at < (now() - make_interval(days => v_stale_days))
    )
  )
  into v_unassigned
  from public.admin_dashboard_orders_money() as m
  where m.assigned_manager_id is null
    and m.status <> 'completed';

  return jsonb_build_object(
    'stale_days_threshold', v_stale_days,
    'managers', coalesce(v_managers, '[]'::jsonb),
    'unassigned', coalesce(v_unassigned, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.admin_get_dashboard_managers(date, date) from public;
revoke all on function public.admin_get_dashboard_managers(date, date) from anon;
revoke all on function public.admin_get_dashboard_managers(date, date) from authenticated;
grant execute on function public.admin_get_dashboard_managers(date, date) to authenticated;

-- ============================================================
-- 9. admin_get_dashboard_recent_activity
-- ============================================================

create or replace function public.admin_get_dashboard_recent_activity(
  p_limit integer default 20
)
returns table (
  event_id text,
  event_type text,
  event_label text,
  order_id uuid,
  order_number text,
  description text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
begin
  perform public.admin_dashboard_assert_caller();

  return query
  with events as (
    -- New orders
    select
      'order_created:' || o.id::text as event_id,
      'order_created'::text as event_type,
      'Новый заказ'::text as event_label,
      o.id as order_id,
      o.order_number,
      ('Создан заказ ' || o.order_number)::text as description,
      o.created_at
    from public.orders as o

    union all

    -- Significant status changes
    select
      'status:' || h.id::text,
      'status_' || h.to_status,
      case h.to_status
        when 'paid' then 'Заказ оплачен'
        when 'picking' then 'Сборка начата'
        when 'ready_for_shipment' then 'Заказ готов'
        when 'shipped' then 'Отгружен'
        when 'completed' then 'Завершён'
        else 'Статус: ' || h.to_status
      end,
      h.order_id,
      o.order_number,
      coalesce(h.note, 'Статус → ' || h.to_status),
      h.created_at
    from public.order_status_history as h
    join public.orders as o on o.id = h.order_id
    where h.to_status in (
      'paid',
      'picking',
      'ready_for_shipment',
      'shipped',
      'completed'
    )

    union all

    -- Payments (no secret metadata)
    select
      'activity:' || a.id::text,
      a.event_type,
      case a.event_type
        when 'payment_recorded' then 'Платёж зарегистрирован'
        when 'payment_reversed' then 'Платёж сторнирован'
        when 'payment_completed' then 'Заказ оплачен полностью'
        else a.event_type
      end,
      a.order_id,
      o.order_number,
      coalesce(a.description, a.event_type),
      a.created_at
    from public.order_activity_log as a
    join public.orders as o on o.id = a.order_id
    where a.event_type in (
      'payment_recorded',
      'payment_reversed',
      'payment_completed'
    )

    union all

    -- Warehouse milestones (dedupe with status where possible still OK for feed)
    select
      'warehouse:' || w.id::text,
      w.event_type,
      case w.event_type
        when 'picking_started' then 'Сборка начата'
        when 'picking_completed' then 'Сборка завершена'
        when 'order_shipped' then 'Отгружен'
        else w.event_type
      end,
      w.order_id,
      o.order_number,
      coalesce(w.description, w.event_type),
      w.created_at
    from public.order_warehouse_activity as w
    join public.orders as o on o.id = w.order_id
    where w.event_type in (
      'picking_started',
      'picking_completed',
      'order_shipped'
    )
  )
  select
    e.event_id,
    e.event_type,
    e.event_label,
    e.order_id,
    e.order_number,
    e.description,
    e.created_at
  from events as e
  order by e.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_dashboard_recent_activity(integer) from public;
revoke all on function public.admin_get_dashboard_recent_activity(integer) from anon;
revoke all on function public.admin_get_dashboard_recent_activity(integer) from authenticated;
grant execute on function public.admin_get_dashboard_recent_activity(integer) to authenticated;

comment on function public.admin_get_dashboard_recent_activity(integer) is
  'Recent significant order/payment/warehouse events. No secret metadata. Active admin only.';
