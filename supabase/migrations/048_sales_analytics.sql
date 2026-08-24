-- ============================================================
-- 048_sales_analytics.sql
-- Sales analytics: VAT-aware completed-sales helpers + RPCs.
--
-- Builds on 025 / 027b dashboard helpers:
--   admin_dashboard_assert_caller / resolve_period /
--   completed_events / orders_money
--
-- Sales = completed_events (first history → completed, current
-- status=completed, is_test excluded). Financials do NOT exclude
-- exclude_from_regular_demand. Cancelled never appear in
-- completed_events.
--
-- VAT from invoice metadata->totals snapshots (040 model):
--   amount_without_vat, vat_amount, final_total, vat_rate, tax_mode.
-- Historical snapshots are never recalculated with the current rate.
-- When amount_due differs from snap net+vat, scale proportionally;
-- if no usable snapshot → treat as without_vat (net=gross, vat=0).
--
-- Updates dashboard summary / chart / top products / top customers /
-- managers to use sales_gross (and net/vat where return type allows).
-- Does NOT touch traffic tables or traffic RPCs.
-- Does NOT modify migrations 001–047.
-- ============================================================

do $$
begin
  if to_regprocedure('public.admin_dashboard_assert_caller()') is null then
    raise exception 'admin_dashboard_assert_caller missing — run 025 first.';
  end if;
  if to_regprocedure('public.admin_dashboard_resolve_period(date, date)') is null then
    raise exception 'admin_dashboard_resolve_period missing — run 025 first.';
  end if;
  if to_regprocedure('public.admin_dashboard_completed_events()') is null then
    raise exception 'admin_dashboard_completed_events missing — run 025/027b first.';
  end if;
  if to_regprocedure('public.admin_dashboard_orders_money()') is null then
    raise exception 'admin_dashboard_orders_money missing — run 025/027b first.';
  end if;
  if to_regclass('public.order_items') is null then
    raise exception 'public.order_items missing — run 005 first.';
  end if;
  if to_regclass('public.products') is null then
    raise exception 'public.products missing — run 002 first.';
  end if;
  if to_regclass('public.categories') is null then
    raise exception 'public.categories missing — run 002 first.';
  end if;
end
$$;

-- ============================================================
-- 1. admin_dashboard_resolve_vat
-- ============================================================

/**
 * Split amount_due into net / vat / gross using invoice metadata snapshot.
 * Prefer historical amount_without_vat + vat_amount; scale if needed.
 * Always returns net + vat = gross (vat adjusted last).
 */
create or replace function public.admin_dashboard_resolve_vat(
  p_amount_due numeric,
  p_doc_metadata jsonb
)
returns table (
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric
)
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_gross numeric(14, 2);
  v_net numeric(14, 2);
  v_vat numeric(14, 2);
  v_snap_net numeric;
  v_snap_vat numeric;
  v_snap_sum numeric;
begin
  v_gross := round(coalesce(p_amount_due, 0), 2);

  v_snap_net := nullif(p_doc_metadata -> 'totals' ->> 'amount_without_vat', '')::numeric;
  v_snap_vat := nullif(p_doc_metadata -> 'totals' ->> 'vat_amount', '')::numeric;

  if v_snap_net is not null and v_snap_vat is not null then
    v_snap_sum := v_snap_net + v_snap_vat;
    if abs(v_snap_sum - v_gross) <= 0.05 then
      v_net := round(v_snap_net, 2);
      v_vat := round(v_snap_vat, 2);
    elsif v_snap_sum > 0 then
      v_net := round(v_gross * v_snap_net / v_snap_sum, 2);
      v_vat := v_gross - v_net;
    else
      v_net := v_gross;
      v_vat := 0;
    end if;
  else
    v_net := v_gross;
    v_vat := 0;
  end if;

  -- Guarantee net + vat = gross
  v_vat := v_gross - v_net;

  sales_net := v_net;
  sales_vat := v_vat;
  sales_gross := v_gross;
  return next;
end;
$$;

revoke all on function public.admin_dashboard_resolve_vat(numeric, jsonb) from public;
revoke all on function public.admin_dashboard_resolve_vat(numeric, jsonb) from anon;
revoke all on function public.admin_dashboard_resolve_vat(numeric, jsonb) from authenticated;

comment on function public.admin_dashboard_resolve_vat(numeric, jsonb) is
  'Internal: split amount_due into sales_net/vat/gross from invoice totals snapshot. No GRANT.';

-- ============================================================
-- 2. admin_dashboard_completed_sales
-- ============================================================

/**
 * One row per completed sale with VAT-resolved money.
 * Invoice join matches orders_money document pattern.
 */
create or replace function public.admin_dashboard_completed_sales()
returns table (
  order_id uuid,
  customer_id uuid,
  assigned_manager_id uuid,
  completed_at timestamptz,
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.order_id,
    m.customer_id,
    m.assigned_manager_id,
    c.completed_at,
    v.sales_net,
    v.sales_vat,
    v.sales_gross
  from public.admin_dashboard_completed_events() as c
  join public.admin_dashboard_orders_money() as m
    on m.order_id = c.order_id
  left join public.order_documents as d
    on d.order_id = c.order_id
   and d.document_type = 'invoice'
   and d.status = 'generated'
  cross join lateral public.admin_dashboard_resolve_vat(m.amount_due, d.metadata) as v;
$$;

revoke all on function public.admin_dashboard_completed_sales() from public;
revoke all on function public.admin_dashboard_completed_sales() from anon;
revoke all on function public.admin_dashboard_completed_sales() from authenticated;

comment on function public.admin_dashboard_completed_sales() is
  'Internal: completed sales with VAT split. No GRANT.';

-- ============================================================
-- 3. admin_dashboard_completed_sale_lines
-- ============================================================

/**
 * Allocate order-level sales_net/vat/gross across order_items by
 * line_total share (equal share if sum line_total = 0).
 * Round to 2dp; residual on largest line so sum(lines) = order totals.
 */
create or replace function public.admin_dashboard_completed_sale_lines()
returns table (
  order_id uuid,
  completed_at timestamptz,
  product_id uuid,
  product_sku text,
  product_name text,
  category_id uuid,
  quantity numeric,
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select
      s.order_id,
      s.completed_at,
      oi.product_id,
      coalesce(nullif(trim(oi.product_sku), ''), p.sku)::text as product_sku,
      coalesce(nullif(trim(oi.product_name), ''), p.name)::text as product_name,
      p.category_id,
      oi.quantity::numeric as quantity,
      oi.line_total,
      s.sales_net as order_net,
      s.sales_vat as order_vat,
      s.sales_gross as order_gross,
      sum(oi.line_total) over (partition by s.order_id) as order_line_sum,
      count(*) over (partition by s.order_id) as line_count
    from public.admin_dashboard_completed_sales() as s
    join public.order_items as oi on oi.order_id = s.order_id
    left join public.products as p on p.id = oi.product_id
  ),
  shares as (
    select
      b.*,
      case
        when b.order_line_sum > 0 then b.line_total / b.order_line_sum
        else 1.0 / nullif(b.line_count, 0)
      end as share
    from base as b
  ),
  rounded as (
    select
      sh.*,
      round(sh.order_net * sh.share, 2) as raw_net,
      round(sh.order_gross * sh.share, 2) as raw_gross,
      row_number() over (
        partition by sh.order_id
        order by round(sh.order_gross * sh.share, 2) desc, sh.product_id, sh.line_total desc
      ) as rn
    from shares as sh
  ),
  with_sums as (
    select
      r.*,
      sum(r.raw_net) over (partition by r.order_id) as sum_raw_net,
      sum(r.raw_gross) over (partition by r.order_id) as sum_raw_gross
    from rounded as r
  )
  select
    w.order_id,
    w.completed_at,
    w.product_id,
    w.product_sku,
    w.product_name,
    w.category_id,
    w.quantity,
    (
      case
        when w.rn = 1 then w.raw_net + (w.order_net - w.sum_raw_net)
        else w.raw_net
      end
    )::numeric(14, 2) as sales_net,
    (
      (
        case
          when w.rn = 1 then w.raw_gross + (w.order_gross - w.sum_raw_gross)
          else w.raw_gross
        end
      )
      -
      (
        case
          when w.rn = 1 then w.raw_net + (w.order_net - w.sum_raw_net)
          else w.raw_net
        end
      )
    )::numeric(14, 2) as sales_vat,
    (
      case
        when w.rn = 1 then w.raw_gross + (w.order_gross - w.sum_raw_gross)
        else w.raw_gross
      end
    )::numeric(14, 2) as sales_gross
  from with_sums as w;
$$;

revoke all on function public.admin_dashboard_completed_sale_lines() from public;
revoke all on function public.admin_dashboard_completed_sale_lines() from anon;
revoke all on function public.admin_dashboard_completed_sale_lines() from authenticated;

comment on function public.admin_dashboard_completed_sale_lines() is
  'Internal: product-line allocation of completed sales with residual fix. No GRANT.';

-- ============================================================
-- 4. admin_get_dashboard_summary (CREATE OR REPLACE)
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
  v_sales_net numeric(14, 2) := 0;
  v_sales_vat numeric(14, 2) := 0;
  v_sales_gross numeric(14, 2) := 0;
  v_sales_orders integer := 0;
  v_paid numeric(14, 2) := 0;
  v_ar numeric(14, 2) := 0;
  v_ar_overdue numeric(14, 2) := 0;
  v_new_orders integer := 0;
  v_avg numeric(14, 2) := 0;
  v_avg_net numeric(14, 2) := 0;
  v_status jsonb;
  v_ops jsonb;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  select
    coalesce(sum(s.sales_net), 0)::numeric(14, 2),
    coalesce(sum(s.sales_vat), 0)::numeric(14, 2),
    coalesce(sum(s.sales_gross), 0)::numeric(14, 2),
    count(*)::integer
  into v_sales_net, v_sales_vat, v_sales_gross, v_sales_orders
  from public.admin_dashboard_completed_sales() as s
  where s.completed_at >= v_period.ts_from
    and s.completed_at < v_period.ts_to;

  select coalesce(sum(p.amount), 0)::numeric(14, 2)
  into v_paid
  from public.order_payments as p
  join public.orders as o on o.id = p.order_id
  where p.status = 'confirmed'
    and p.payment_date >= v_period.date_from
    and p.payment_date <= v_period.date_to
    and coalesce(o.is_test, false) = false;

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

  select count(*)::integer
  into v_new_orders
  from public.orders as o
  where o.created_at >= v_period.ts_from
    and o.created_at < v_period.ts_to
    and coalesce(o.is_test, false) = false;

  if v_sales_orders > 0 then
    v_avg := round(v_sales_gross / v_sales_orders, 2);
    v_avg_net := round(v_sales_net / v_sales_orders, 2);
  else
    v_avg := 0;
    v_avg_net := 0;
  end if;

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
        ('new', 1), ('awaiting_payment', 2), ('paid', 3), ('picking', 4),
        ('ready_for_shipment', 5), ('shipped', 6), ('completed', 7), ('cancelled', 8)
    ) as st(status, sort_order)
    left join public.orders as o
      on o.status = st.status
     and coalesce(o.is_test, false) = false
    left join public.admin_dashboard_orders_money() as m
      on m.order_id = o.id and o.status <> 'cancelled'
    group by st.status, st.sort_order
  ) as s;

  select jsonb_build_object(
    'awaiting_payment', jsonb_build_object(
      'orders_count', count(*) filter (where m.status = 'awaiting_payment'),
      'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'awaiting_payment'), 0)
    ),
    'partially_paid', jsonb_build_object(
      'orders_count', count(*) filter (where m.payment_status = 'partially_paid'),
      'amount_remaining', coalesce(sum(greatest(m.amount_remaining, 0)) filter (where m.payment_status = 'partially_paid'), 0)
    ),
    'fully_paid_not_moved', jsonb_build_object(
      'orders_count', count(*) filter (
        where m.status = 'awaiting_payment' and m.payment_status in ('paid', 'overpaid')
      ),
      'amount_total', coalesce(sum(m.amount_due) filter (
        where m.status = 'awaiting_payment' and m.payment_status in ('paid', 'overpaid')
      ), 0)
    ),
    'picking', jsonb_build_object(
      'orders_count', count(*) filter (where m.status = 'picking'),
      'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'picking'), 0)
    ),
    'ready_for_shipment', jsonb_build_object(
      'orders_count', count(*) filter (where m.status = 'ready_for_shipment'),
      'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'ready_for_shipment'), 0)
    ),
    'shipped_not_completed', jsonb_build_object(
      'orders_count', count(*) filter (where m.status = 'shipped'),
      'amount_total', coalesce(sum(m.amount_due) filter (where m.status = 'shipped'), 0)
    ),
    'payment_overdue', jsonb_build_object(
      'orders_count', count(*) filter (
        where m.amount_remaining > v_tol and m.payment_due_at is not null and m.payment_due_at < now()
      ),
      'amount_remaining', coalesce(sum(greatest(m.amount_remaining, 0)) filter (
        where m.amount_remaining > v_tol and m.payment_due_at is not null and m.payment_due_at < now()
      ), 0)
    ),
    'reservation_overdue', jsonb_build_object(
      'orders_count', count(*) filter (
        where m.reservation_expires_at is not null and m.reservation_expires_at < now()
          and m.status not in ('shipped', 'completed')
      ),
      'amount_total', coalesce(sum(m.amount_due) filter (
        where m.reservation_expires_at is not null and m.reservation_expires_at < now()
          and m.status not in ('shipped', 'completed')
      ), 0)
    ),
    'unassigned_manager', jsonb_build_object(
      'orders_count', count(*) filter (
        where m.assigned_manager_id is null and m.status not in ('completed')
      ),
      'amount_total', coalesce(sum(m.amount_due) filter (
        where m.assigned_manager_id is null and m.status not in ('completed')
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
      'sales_amount', v_sales_gross,
      'sales_net', v_sales_net,
      'sales_vat', v_sales_vat,
      'sales_gross', v_sales_gross,
      'sales_orders_count', v_sales_orders,
      'payments_amount', v_paid,
      'receivables_amount', v_ar,
      'overdue_receivables_amount', v_ar_overdue,
      'new_orders_count', v_new_orders,
      'average_order_value', v_avg,
      'average_order_value_net', v_avg_net
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
  'Director dashboard KPI with VAT sales split. Excludes is_test. Active admin only.';

-- ============================================================
-- 5. admin_get_dashboard_chart (DROP — return type changes)
-- ============================================================

drop function if exists public.admin_get_dashboard_chart(date, date);

create function public.admin_get_dashboard_chart(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_date date,
  bucket_label text,
  granularity text,
  sales_amount numeric,
  sales_net numeric,
  sales_vat numeric,
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
        when 'day' then (timezone(v_tz, s.completed_at))::date
        when 'week' then date_trunc('week', timezone(v_tz, s.completed_at))::date
        else date_trunc('month', timezone(v_tz, s.completed_at))::date
      end as bucket_date,
      sum(s.sales_gross)::numeric(14, 2) as sales_amount,
      sum(s.sales_net)::numeric(14, 2) as sales_net,
      sum(s.sales_vat)::numeric(14, 2) as sales_vat,
      count(*)::integer as orders_count
    from public.admin_dashboard_completed_sales() as s
    where s.completed_at >= v_period.ts_from
      and s.completed_at < v_period.ts_to
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
    join public.orders as o on o.id = p.order_id
    where p.status = 'confirmed'
      and p.payment_date >= v_period.date_from
      and p.payment_date <= v_period.date_to
      and coalesce(o.is_test, false) = false
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
    coalesce(s.sales_net, 0)::numeric(14, 2),
    coalesce(s.sales_vat, 0)::numeric(14, 2),
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

comment on function public.admin_get_dashboard_chart(date, date) is
  'Director dashboard chart buckets with VAT sales split. Active admin only.';

-- ============================================================
-- 6. admin_get_dashboard_top_products (DROP — return type changes)
-- ============================================================

drop function if exists public.admin_get_dashboard_top_products(date, date, integer);

create function public.admin_get_dashboard_top_products(
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
  sales_net numeric,
  sales_vat numeric,
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
    l.product_id,
    max(l.product_sku)::text as product_sku,
    max(l.product_name)::text as product_name,
    max(pr.main_photo_path)::text as main_photo_path,
    sum(l.quantity)::numeric as quantity_sold,
    sum(l.sales_gross)::numeric(14, 2) as sales_amount,
    sum(l.sales_net)::numeric(14, 2) as sales_net,
    sum(l.sales_vat)::numeric(14, 2) as sales_vat,
    count(distinct l.order_id)::integer as orders_count
  from public.admin_dashboard_completed_sale_lines() as l
  left join public.products as pr on pr.id = l.product_id
  where l.completed_at >= v_period.ts_from
    and l.completed_at < v_period.ts_to
  group by l.product_id
  order by sum(l.sales_gross) desc, sum(l.quantity) desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_dashboard_top_products(date, date, integer) from public;
revoke all on function public.admin_get_dashboard_top_products(date, date, integer) from anon;
revoke all on function public.admin_get_dashboard_top_products(date, date, integer) from authenticated;
grant execute on function public.admin_get_dashboard_top_products(date, date, integer) to authenticated;

comment on function public.admin_get_dashboard_top_products(date, date, integer) is
  'Director dashboard top products by completed sales_gross (VAT allocated). Active admin only.';

-- ============================================================
-- 7. admin_get_dashboard_top_customers (DROP — return type changes)
-- ============================================================

drop function if exists public.admin_get_dashboard_top_customers(date, date, integer);

create function public.admin_get_dashboard_top_customers(
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
  sales_net numeric,
  sales_vat numeric,
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
      s.customer_id,
      count(*)::integer as orders_count,
      sum(s.sales_gross)::numeric(14, 2) as sales_amount,
      sum(s.sales_net)::numeric(14, 2) as sales_net,
      sum(s.sales_vat)::numeric(14, 2) as sales_vat
    from public.admin_dashboard_completed_sales() as s
    where s.completed_at >= v_period.ts_from
      and s.completed_at < v_period.ts_to
      and s.customer_id is not null
    group by s.customer_id
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
      and coalesce(o.is_test, false) = false
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
      and coalesce(o.is_test, false) = false
    group by o.customer_id
  )
  select
    c.id as customer_id,
    c.customer_type::text,
    c.display_name,
    coalesce(ps.orders_count, 0)::integer,
    coalesce(ps.sales_amount, 0)::numeric(14, 2),
    coalesce(ps.sales_net, 0)::numeric(14, 2),
    coalesce(ps.sales_vat, 0)::numeric(14, 2),
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

comment on function public.admin_get_dashboard_top_customers(date, date, integer) is
  'Director dashboard top customers by completed sales_gross with VAT split. Active admin only.';

-- ============================================================
-- 8. admin_get_dashboard_managers (CREATE OR REPLACE — same shape)
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
      count(cs.order_id) filter (
        where cs.completed_at >= v_period.ts_from
          and cs.completed_at < v_period.ts_to
      )::integer as completed_in_period,
      coalesce(sum(cs.sales_gross) filter (
        where cs.completed_at >= v_period.ts_from
          and cs.completed_at < v_period.ts_to
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
    left join public.admin_dashboard_completed_sales() as cs
      on cs.order_id = m.order_id
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

comment on function public.admin_get_dashboard_managers(date, date) is
  'Director dashboard managers workload; sales_amount from completed sales_gross. Active admin only.';

-- ============================================================
-- 9. Sales analytics RPCs
-- ============================================================

create or replace function public.admin_get_sales_analytics_summary(
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
  v_prev_from date;
  v_prev_to date;
  v_prev_ts_from timestamptz;
  v_prev_ts_to timestamptz;
  v_tz text := 'Asia/Almaty';

  v_sales_net numeric(14, 2) := 0;
  v_sales_vat numeric(14, 2) := 0;
  v_sales_gross numeric(14, 2) := 0;
  v_orders integer := 0;
  v_qty numeric := 0;
  v_aov numeric(14, 2) := 0;
  v_paid numeric(14, 2) := 0;

  v_prev_gross numeric(14, 2) := 0;
  v_prev_orders integer := 0;
  v_prev_qty numeric := 0;
  v_prev_aov numeric(14, 2) := 0;

  v_comparison jsonb;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  v_prev_to := v_period.date_from - 1;
  v_prev_from := v_prev_to - (v_period.day_span - 1);
  v_prev_ts_from := (v_prev_from::timestamp at time zone v_tz);
  v_prev_ts_to := ((v_prev_to + 1)::timestamp at time zone v_tz);

  select
    coalesce(sum(s.sales_net), 0)::numeric(14, 2),
    coalesce(sum(s.sales_vat), 0)::numeric(14, 2),
    coalesce(sum(s.sales_gross), 0)::numeric(14, 2),
    count(*)::integer
  into v_sales_net, v_sales_vat, v_sales_gross, v_orders
  from public.admin_dashboard_completed_sales() as s
  where s.completed_at >= v_period.ts_from
    and s.completed_at < v_period.ts_to;

  select coalesce(sum(l.quantity), 0)
  into v_qty
  from public.admin_dashboard_completed_sale_lines() as l
  where l.completed_at >= v_period.ts_from
    and l.completed_at < v_period.ts_to;

  select coalesce(sum(p.amount), 0)::numeric(14, 2)
  into v_paid
  from public.order_payments as p
  join public.orders as o on o.id = p.order_id
  where p.status = 'confirmed'
    and p.payment_date >= v_period.date_from
    and p.payment_date <= v_period.date_to
    and coalesce(o.is_test, false) = false;

  if v_orders > 0 then
    v_aov := round(v_sales_gross / v_orders, 2);
  else
    v_aov := 0;
  end if;

  select
    coalesce(sum(s.sales_gross), 0)::numeric(14, 2),
    count(*)::integer
  into v_prev_gross, v_prev_orders
  from public.admin_dashboard_completed_sales() as s
  where s.completed_at >= v_prev_ts_from
    and s.completed_at < v_prev_ts_to;

  select coalesce(sum(l.quantity), 0)
  into v_prev_qty
  from public.admin_dashboard_completed_sale_lines() as l
  where l.completed_at >= v_prev_ts_from
    and l.completed_at < v_prev_ts_to;

  if v_prev_orders > 0 then
    v_prev_aov := round(v_prev_gross / v_prev_orders, 2);
  else
    v_prev_aov := 0;
  end if;

  v_comparison := jsonb_build_object(
    'sales_gross', jsonb_build_object(
      'current', v_sales_gross,
      'previous', v_prev_gross,
      'delta', (v_sales_gross - v_prev_gross)::numeric(14, 2),
      'pct_change', case
        when v_prev_gross = 0 then null
        else round((v_sales_gross - v_prev_gross) / v_prev_gross * 100, 1)
      end,
      'has_baseline', (v_prev_gross <> 0)
    ),
    'completed_orders', jsonb_build_object(
      'current', v_orders,
      'previous', v_prev_orders,
      'delta', (v_orders - v_prev_orders),
      'pct_change', case
        when v_prev_orders = 0 then null
        else round((v_orders - v_prev_orders)::numeric / v_prev_orders * 100, 1)
      end,
      'has_baseline', (v_prev_orders <> 0)
    ),
    'quantity_sold', jsonb_build_object(
      'current', v_qty,
      'previous', v_prev_qty,
      'delta', (v_qty - v_prev_qty),
      'pct_change', case
        when v_prev_qty = 0 then null
        else round((v_qty - v_prev_qty) / v_prev_qty * 100, 1)
      end,
      'has_baseline', (v_prev_qty <> 0)
    ),
    'average_order_value', jsonb_build_object(
      'current', v_aov,
      'previous', v_prev_aov,
      'delta', (v_aov - v_prev_aov)::numeric(14, 2),
      'pct_change', case
        when v_prev_aov = 0 then null
        else round((v_aov - v_prev_aov) / v_prev_aov * 100, 1)
      end,
      'has_baseline', (v_prev_aov <> 0)
    )
  );

  return jsonb_build_object(
    'timezone', v_tz,
    'period', jsonb_build_object(
      'date_from', v_period.date_from,
      'date_to', v_period.date_to,
      'day_span', v_period.day_span
    ),
    'previous_period', jsonb_build_object(
      'date_from', v_prev_from,
      'date_to', v_prev_to,
      'day_span', v_period.day_span
    ),
    'kpi', jsonb_build_object(
      'sales_net', v_sales_net,
      'sales_vat', v_sales_vat,
      'sales_gross', v_sales_gross,
      'completed_orders_count', v_orders,
      'quantity_sold', v_qty,
      'average_order_value', v_aov,
      'payments_amount', v_paid
    ),
    'comparison', v_comparison
  );
end;
$$;

revoke all on function public.admin_get_sales_analytics_summary(date, date) from public;
revoke all on function public.admin_get_sales_analytics_summary(date, date) from anon;
revoke all on function public.admin_get_sales_analytics_summary(date, date) from authenticated;
grant execute on function public.admin_get_sales_analytics_summary(date, date) to authenticated;

comment on function public.admin_get_sales_analytics_summary(date, date) is
  'Sales analytics KPI + previous-period comparison. Active admin only.';

-- ------------------------------------------------------------
-- Chart
-- ------------------------------------------------------------

create or replace function public.admin_get_sales_analytics_chart(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  bucket_date date,
  bucket_label text,
  granularity text,
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric,
  orders_count integer,
  quantity_sold numeric
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
        when 'day' then (timezone(v_tz, s.completed_at))::date
        when 'week' then date_trunc('week', timezone(v_tz, s.completed_at))::date
        else date_trunc('month', timezone(v_tz, s.completed_at))::date
      end as bucket_date,
      sum(s.sales_net)::numeric(14, 2) as sales_net,
      sum(s.sales_vat)::numeric(14, 2) as sales_vat,
      sum(s.sales_gross)::numeric(14, 2) as sales_gross,
      count(*)::integer as orders_count
    from public.admin_dashboard_completed_sales() as s
    where s.completed_at >= v_period.ts_from
      and s.completed_at < v_period.ts_to
    group by 1
  ),
  qtys as (
    select
      case v_granularity
        when 'day' then (timezone(v_tz, l.completed_at))::date
        when 'week' then date_trunc('week', timezone(v_tz, l.completed_at))::date
        else date_trunc('month', timezone(v_tz, l.completed_at))::date
      end as bucket_date,
      sum(l.quantity)::numeric as quantity_sold
    from public.admin_dashboard_completed_sale_lines() as l
    where l.completed_at >= v_period.ts_from
      and l.completed_at < v_period.ts_to
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
    coalesce(s.sales_net, 0)::numeric(14, 2),
    coalesce(s.sales_vat, 0)::numeric(14, 2),
    coalesce(s.sales_gross, 0)::numeric(14, 2),
    coalesce(s.orders_count, 0)::integer,
    coalesce(q.quantity_sold, 0)::numeric
  from buckets as b
  left join sales as s on s.bucket_date = b.bucket_date
  left join qtys as q on q.bucket_date = b.bucket_date
  order by b.bucket_date;
end;
$$;

revoke all on function public.admin_get_sales_analytics_chart(date, date) from public;
revoke all on function public.admin_get_sales_analytics_chart(date, date) from anon;
revoke all on function public.admin_get_sales_analytics_chart(date, date) from authenticated;
grant execute on function public.admin_get_sales_analytics_chart(date, date) to authenticated;

comment on function public.admin_get_sales_analytics_chart(date, date) is
  'Sales analytics time buckets (net/vat/gross + qty). Active admin only.';

-- ------------------------------------------------------------
-- Products
-- ------------------------------------------------------------

create or replace function public.admin_get_sales_analytics_products(
  p_date_from date default null,
  p_date_to date default null,
  p_limit integer default 500
)
returns table (
  product_id uuid,
  product_sku text,
  product_name text,
  category_id uuid,
  category_name text,
  quantity_sold numeric,
  orders_count integer,
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric,
  share_pct numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 1000));
  v_total_gross numeric(14, 2) := 0;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  select coalesce(sum(l.sales_gross), 0)::numeric(14, 2)
  into v_total_gross
  from public.admin_dashboard_completed_sale_lines() as l
  where l.completed_at >= v_period.ts_from
    and l.completed_at < v_period.ts_to;

  return query
  select
    ag.product_id,
    ag.product_sku,
    ag.product_name,
    ag.category_id,
    ag.category_name,
    ag.quantity_sold,
    ag.orders_count,
    ag.sales_net,
    ag.sales_vat,
    ag.sales_gross,
    round(ag.sales_gross / nullif(v_total_gross, 0) * 100, 2) as share_pct
  from (
    select
      l.product_id,
      max(l.product_sku)::text as product_sku,
      max(l.product_name)::text as product_name,
      l.category_id,
      coalesce(max(cat.name), 'Без категории')::text as category_name,
      sum(l.quantity)::numeric as quantity_sold,
      count(distinct l.order_id)::integer as orders_count,
      sum(l.sales_net)::numeric(14, 2) as sales_net,
      sum(l.sales_vat)::numeric(14, 2) as sales_vat,
      sum(l.sales_gross)::numeric(14, 2) as sales_gross
    from public.admin_dashboard_completed_sale_lines() as l
    left join public.categories as cat on cat.id = l.category_id
    where l.completed_at >= v_period.ts_from
      and l.completed_at < v_period.ts_to
    group by l.product_id, l.category_id
  ) as ag
  order by ag.sales_gross desc, ag.quantity_sold desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_sales_analytics_products(date, date, integer) from public;
revoke all on function public.admin_get_sales_analytics_products(date, date, integer) from anon;
revoke all on function public.admin_get_sales_analytics_products(date, date, integer) from authenticated;
grant execute on function public.admin_get_sales_analytics_products(date, date, integer) to authenticated;

comment on function public.admin_get_sales_analytics_products(date, date, integer) is
  'Sales analytics by product with category share. Active admin only.';

-- ------------------------------------------------------------
-- Categories
-- ------------------------------------------------------------

create or replace function public.admin_get_sales_analytics_categories(
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  category_id uuid,
  category_name text,
  quantity_sold numeric,
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric,
  share_pct numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_total_gross numeric(14, 2) := 0;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  select coalesce(sum(l.sales_gross), 0)::numeric(14, 2)
  into v_total_gross
  from public.admin_dashboard_completed_sale_lines() as l
  where l.completed_at >= v_period.ts_from
    and l.completed_at < v_period.ts_to;

  return query
  select
    ag.category_id,
    ag.category_name,
    ag.quantity_sold,
    ag.sales_net,
    ag.sales_vat,
    ag.sales_gross,
    round(ag.sales_gross / nullif(v_total_gross, 0) * 100, 2) as share_pct
  from (
    select
      l.category_id,
      coalesce(max(cat.name), 'Без категории')::text as category_name,
      sum(l.quantity)::numeric as quantity_sold,
      sum(l.sales_net)::numeric(14, 2) as sales_net,
      sum(l.sales_vat)::numeric(14, 2) as sales_vat,
      sum(l.sales_gross)::numeric(14, 2) as sales_gross
    from public.admin_dashboard_completed_sale_lines() as l
    left join public.categories as cat on cat.id = l.category_id
    where l.completed_at >= v_period.ts_from
      and l.completed_at < v_period.ts_to
    group by l.category_id
  ) as ag
  order by ag.sales_gross desc, ag.quantity_sold desc;
end;
$$;

revoke all on function public.admin_get_sales_analytics_categories(date, date) from public;
revoke all on function public.admin_get_sales_analytics_categories(date, date) from anon;
revoke all on function public.admin_get_sales_analytics_categories(date, date) from authenticated;
grant execute on function public.admin_get_sales_analytics_categories(date, date) to authenticated;

comment on function public.admin_get_sales_analytics_categories(date, date) is
  'Sales analytics by product category with share. Active admin only.';

-- ------------------------------------------------------------
-- Customers
-- ------------------------------------------------------------

create or replace function public.admin_get_sales_analytics_customers(
  p_date_from date default null,
  p_date_to date default null,
  p_limit integer default 500
)
returns table (
  customer_id uuid,
  customer_type text,
  display_name text,
  orders_count integer,
  sales_net numeric,
  sales_vat numeric,
  sales_gross numeric,
  average_order_value numeric,
  receivables_amount numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 1000));
  v_tol numeric(14, 2) := 0.01;
begin
  perform public.admin_dashboard_assert_caller();

  select * into v_period
  from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  return query
  with period_sales as (
    select
      s.customer_id,
      count(*)::integer as orders_count,
      sum(s.sales_net)::numeric(14, 2) as sales_net,
      sum(s.sales_vat)::numeric(14, 2) as sales_vat,
      sum(s.sales_gross)::numeric(14, 2) as sales_gross
    from public.admin_dashboard_completed_sales() as s
    where s.completed_at >= v_period.ts_from
      and s.completed_at < v_period.ts_to
      and s.customer_id is not null
    group by s.customer_id
  ),
  current_ar as (
    select
      m.customer_id,
      sum(greatest(m.amount_remaining, 0))::numeric(14, 2) as receivables_amount
    from public.admin_dashboard_orders_money() as m
    where m.customer_id is not null
      and m.amount_remaining > v_tol
    group by m.customer_id
  )
  select
    c.id as customer_id,
    c.customer_type::text,
    c.display_name,
    ps.orders_count,
    ps.sales_net,
    ps.sales_vat,
    ps.sales_gross,
    case
      when ps.orders_count > 0 then round(ps.sales_gross / ps.orders_count, 2)
      else 0::numeric(14, 2)
    end as average_order_value,
    coalesce(ar.receivables_amount, 0)::numeric(14, 2) as receivables_amount
  from period_sales as ps
  join public.customers as c on c.id = ps.customer_id
  left join current_ar as ar on ar.customer_id = c.id
  order by ps.sales_gross desc, ps.orders_count desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_sales_analytics_customers(date, date, integer) from public;
revoke all on function public.admin_get_sales_analytics_customers(date, date, integer) from anon;
revoke all on function public.admin_get_sales_analytics_customers(date, date, integer) from authenticated;
grant execute on function public.admin_get_sales_analytics_customers(date, date, integer) to authenticated;

comment on function public.admin_get_sales_analytics_customers(date, date, integer) is
  'Sales analytics by customer; receivables are current snapshot. Active admin only.';

