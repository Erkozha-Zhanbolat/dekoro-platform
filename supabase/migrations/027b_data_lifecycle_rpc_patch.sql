-- ============================================================
-- 027b_data_lifecycle_rpc_patch.sql
-- Minimal SAFE patch after a PARTIAL apply of 027_data_lifecycle.sql
--
-- NOT applied automatically. Run in Supabase SQL Editor when:
--   PostgREST error: Could not find the function
--   public.admin_list_data_archives(p_archive_type, p_limit) in the schema cache
--
-- Root cause (fixed in 027): CREATE of data_lifecycle_manifest_checksum
-- used extensions.digest, which fails on many Supabase projects where
-- pgcrypto lives in public (from 001). Migration aborted BEFORE Stage 27
-- RPCs were created. Tables may already exist.
--
-- This patch:
--   1) widens data_archives.status CHECK if needed
--   2) recreates checksum helper with md5 (no extensions.digest)
--   3) CREATE OR REPLACE all Stage 27 helpers + admin RPCs from section 7+
--   4) NOTIFY PostgREST to reload schema cache
--
-- Safe to re-run. Does NOT use CASCADE. Does NOT touch migrations 001–026.
-- Prefer THIS over re-running the full 2900-line 027 when tables already exist.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'orders missing — apply 005+ and full 027 schema sections first';
  end if;
  if to_regclass('public.data_archives') is null then
    raise exception 'data_archives missing — apply 027 table sections (1–6) first, then this patch';
  end if;
  if to_regprocedure('public.staff_assert_active_admin()') is null then
    raise exception 'staff_assert_active_admin missing — run 024 first';
  end if;
end
$$;

-- Ensure is_test exists (noop if already applied)
alter table public.orders
  add column if not exists is_test boolean not null default false;

-- Widen status check for partially-migrated data_archives
do $$
begin
  begin
    alter table public.data_archives drop constraint if exists data_archives_status_check;
  exception when undefined_object then
    null;
  end;
  begin
    alter table public.data_archives
      add constraint data_archives_status_check check (status in (
        'draft', 'ready', 'exported', 'db_cleaned',
        'storage_cleanup_pending', 'cleaned', 'failed', 'expired',
        'building', 'downloaded'
      ));
  exception when duplicate_object then
    null;
  end;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='data_archives' and column_name='manifest'
  ) then
    if exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='data_archives' and column_name='summary'
    ) then
      alter table public.data_archives rename column summary to manifest;
    else
      alter table public.data_archives add column manifest jsonb not null default '{}'::jsonb;
    end if;
  end if;

  alter table public.data_archives add column if not exists archive_number text;
  alter table public.data_archives add column if not exists schema_version integer not null default 1;
  alter table public.data_archives add column if not exists checksum text;
  alter table public.data_archives add column if not exists export_file_path text;
  alter table public.data_archives add column if not exists export_bytes bigint;
  alter table public.data_archives add column if not exists exported_at timestamptz;
  alter table public.data_archives add column if not exists db_cleaned_at timestamptz;
  alter table public.data_archives add column if not exists storage_cleaned_at timestamptz;

  -- backfill archive_number if null
  if exists (
    select 1 from public.data_archives where archive_number is null
  ) then
    if to_regclass('public.data_archives_number_seq') is null then
      create sequence public.data_archives_number_seq as bigint start with 1 increment by 1;
    end if;
    update public.data_archives
    set archive_number = 'DEKORO-AR-' || lpad(nextval('public.data_archives_number_seq')::text, 6, '0')
    where archive_number is null;
  end if;
end
$$;

-- ============================================================
-- 7. Helpers
-- ============================================================

create or replace function public.data_lifecycle_assert_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return public.staff_assert_active_admin();
end;
$$;

revoke all on function public.data_lifecycle_assert_admin() from public, anon, authenticated;

create or replace function public.data_lifecycle_log(
  p_event_type text,
  p_description text,
  p_metadata jsonb default '{}'::jsonb,
  p_actor uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.data_lifecycle_activity (event_type, description, metadata, created_by)
  values (
    coalesce(nullif(trim(p_event_type), ''), 'unknown'),
    coalesce(nullif(trim(p_description), ''), '—'),
    coalesce(p_metadata, '{}'::jsonb),
    p_actor
  );
end;
$$;

revoke all on function public.data_lifecycle_log(text, text, jsonb, uuid) from public, anon, authenticated;

create or replace function public.data_lifecycle_resolve_period(
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
  v_from date;
  v_to date;
  v_today date := (timezone('Asia/Almaty', now()))::date;
begin
  v_from := coalesce(p_date_from, date_trunc('month', v_today)::date);
  v_to := coalesce(p_date_to, v_today);
  if v_from > v_to then
    raise exception 'date_from не может быть позже date_to';
  end if;
  if (v_to - v_from) > 366 then
    raise exception 'Максимальный период — 366 дней';
  end if;
  date_from := v_from;
  date_to := v_to;
  ts_from := (v_from::timestamp at time zone 'Asia/Almaty');
  ts_to := ((v_to + 1)::timestamp at time zone 'Asia/Almaty');
  day_span := (v_to - v_from) + 1;
  return next;
end;
$$;

revoke all on function public.data_lifecycle_resolve_period(date, date) from public, anon, authenticated;

-- Compact checksum helper (manifest fingerprint).
-- IMPORTANT: use md5 only — do NOT call extensions.digest here.
-- On Supabase, pgcrypto may live in public (001) rather than extensions;
-- a failing CREATE at this point previously aborted 027 before Stage 27 RPCs
-- (including admin_list_data_archives) were created → PostgREST schema-cache miss.
create or replace function public.data_lifecycle_manifest_checksum(p_manifest jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select md5(coalesce(p_manifest, '{}'::jsonb)::text);
$$;

revoke all on function public.data_lifecycle_manifest_checksum(jsonb) from public;
revoke all on function public.data_lifecycle_manifest_checksum(jsonb) from anon;
revoke all on function public.data_lifecycle_manifest_checksum(jsonb) from authenticated;

-- ============================================================
-- 8. Director dashboard: exclude is_test (CREATE OR REPLACE of 025)
-- ============================================================

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
      and coalesce(o.is_test, false) = false
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
      d.order_id, d.order_number, d.status, d.customer_id, d.assigned_manager_id,
      d.created_at, d.updated_at, d.payment_due_at, d.reservation_expires_at, d.amount_due
  )
  select
    w.order_id, w.order_number, w.status, w.customer_id, w.assigned_manager_id,
    w.created_at, w.updated_at, w.payment_due_at, w.reservation_expires_at,
    w.amount_due, w.amount_paid,
    (w.amount_due - w.amount_paid)::numeric(14, 2) as amount_remaining,
    public.staff_derive_payment_status(w.amount_due, w.amount_paid) as payment_status
  from with_paid as w;
$$;

revoke all on function public.admin_dashboard_orders_money() from public, anon, authenticated;

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
    and coalesce(o.is_test, false) = false
  order by h.order_id, h.created_at asc;
$$;

revoke all on function public.admin_dashboard_completed_events() from public, anon, authenticated;

-- admin_get_dashboard_summary: exclude test from payments / new_orders / status join
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

  select
    coalesce(sum(m.amount_due), 0)::numeric(14, 2),
    count(*)::integer
  into v_sales, v_sales_orders
  from public.admin_dashboard_completed_events() as c
  join public.admin_dashboard_orders_money() as m on m.order_id = c.order_id
  where c.completed_at >= v_period.ts_from
    and c.completed_at < v_period.ts_to;

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
    v_avg := round(v_sales / v_sales_orders, 2);
  else
    v_avg := 0;
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

revoke all on function public.admin_get_dashboard_summary(date, date) from public, anon, authenticated;
grant execute on function public.admin_get_dashboard_summary(date, date) to authenticated;

comment on function public.admin_get_dashboard_summary(date, date) is
  'Director dashboard KPI. Excludes orders.is_test. Active admin only.';

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
  select * into v_period from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  if v_period.day_span <= 31 then v_granularity := 'day';
  elsif v_period.day_span <= 92 then v_granularity := 'week';
  else v_granularity := 'month';
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
    where c.completed_at >= v_period.ts_from and c.completed_at < v_period.ts_to
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
    coalesce(p.payments_amount, 0)::numeric(14, 2),
    coalesce(s.orders_count, 0)::integer
  from buckets as b
  left join sales as s on s.bucket_date = b.bucket_date
  left join pays as p on p.bucket_date = b.bucket_date
  order by b.bucket_date;
end;
$$;

revoke all on function public.admin_get_dashboard_chart(date, date) from public, anon, authenticated;
grant execute on function public.admin_get_dashboard_chart(date, date) to authenticated;

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
  select * into v_period from public.admin_dashboard_resolve_period(p_date_from, p_date_to);

  return query
  with period_sales as (
    select m.customer_id, count(*)::integer as orders_count,
           sum(m.amount_due)::numeric(14, 2) as sales_amount,
           max(c.completed_at) as last_completed_at
    from public.admin_dashboard_completed_events() as c
    join public.admin_dashboard_orders_money() as m on m.order_id = c.order_id
    where c.completed_at >= v_period.ts_from and c.completed_at < v_period.ts_to
      and m.customer_id is not null
    group by m.customer_id
  ),
  period_payments as (
    select o.customer_id, sum(p.amount)::numeric(14, 2) as payments_amount
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
    select m.customer_id, sum(greatest(m.amount_remaining, 0))::numeric(14, 2) as receivables_amount
    from public.admin_dashboard_orders_money() as m
    where m.customer_id is not null and m.amount_remaining > v_tol
    group by m.customer_id
  ),
  last_orders as (
    select o.customer_id, max(o.created_at) as last_order_at
    from public.orders as o
    where o.customer_id is not null
      and o.status <> 'cancelled'
      and coalesce(o.is_test, false) = false
    group by o.customer_id
  )
  select
    c.id, c.customer_type::text, c.display_name,
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

revoke all on function public.admin_get_dashboard_top_customers(date, date, integer) from public, anon, authenticated;
grant execute on function public.admin_get_dashboard_top_customers(date, date, integer) to authenticated;

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
    select
      'order_created:' || o.id::text as event_id,
      'order_created'::text as event_type,
      'Новый заказ'::text as event_label,
      o.id as order_id, o.order_number,
      ('Создан заказ ' || o.order_number)::text as description,
      o.created_at
    from public.orders as o
    where coalesce(o.is_test, false) = false

    union all

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
      h.order_id, o.order_number,
      coalesce(h.note, 'Статус → ' || h.to_status),
      h.created_at
    from public.order_status_history as h
    join public.orders as o on o.id = h.order_id
    where coalesce(o.is_test, false) = false
      and h.to_status in ('paid','picking','ready_for_shipment','shipped','completed')

    union all

    select
      'activity:' || a.id::text, a.event_type,
      case a.event_type
        when 'payment_recorded' then 'Платёж зарегистрирован'
        when 'payment_reversed' then 'Платёж сторнирован'
        when 'payment_completed' then 'Заказ оплачен полностью'
        else a.event_type
      end,
      a.order_id, o.order_number,
      coalesce(a.description, a.event_type), a.created_at
    from public.order_activity_log as a
    join public.orders as o on o.id = a.order_id
    where coalesce(o.is_test, false) = false
      and a.event_type in ('payment_recorded','payment_reversed','payment_completed')

    union all

    select
      'warehouse:' || w.id::text, w.event_type,
      case w.event_type
        when 'picking_started' then 'Сборка начата'
        when 'picking_completed' then 'Сборка завершена'
        when 'order_shipped' then 'Отгружен'
        else w.event_type
      end,
      w.order_id, o.order_number,
      coalesce(w.description, w.event_type), w.created_at
    from public.order_warehouse_activity as w
    join public.orders as o on o.id = w.order_id
    where coalesce(o.is_test, false) = false
      and w.event_type in ('picking_started','picking_completed','order_shipped')
  )
  select e.event_id, e.event_type, e.event_label, e.order_id, e.order_number, e.description, e.created_at
  from events as e
  order by e.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.admin_get_dashboard_recent_activity(integer) from public, anon, authenticated;
grant execute on function public.admin_get_dashboard_recent_activity(integer) to authenticated;

comment on function public.admin_get_dashboard_recent_activity(integer) is
  'Director recent activity feed. Excludes events linked to orders.is_test.';

-- ============================================================
-- 9. Retention settings RPCs
-- ============================================================

create or replace function public.admin_get_data_retention_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.data_retention_settings;
begin
  perform public.data_lifecycle_assert_admin();
  select * into v_row from public.data_retention_settings where singleton_key = 'default';
  if not found then
    insert into public.data_retention_settings (singleton_key) values ('default') returning * into v_row;
  end if;
  return jsonb_build_object(
    'raw_analytics_days', v_row.raw_analytics_days,
    'snapshots_days', v_row.snapshots_days,
    'test_archives_days', v_row.test_archives_days,
    'last_aggregated_at', v_row.last_aggregated_at,
    'last_aggregated_from', v_row.last_aggregated_from,
    'last_aggregated_to', v_row.last_aggregated_to,
    'last_cleanup_at', v_row.last_cleanup_at,
    'last_cleanup_cutoff', v_row.last_cleanup_cutoff,
    'updated_at', v_row.updated_at,
    'updated_by', v_row.updated_by,
    'auto_cleanup_enabled', false
  );
end;
$$;

revoke all on function public.admin_get_data_retention_settings() from public, anon, authenticated;
grant execute on function public.admin_get_data_retention_settings() to authenticated;

create or replace function public.admin_upsert_data_retention_settings(
  p_raw_analytics_days integer,
  p_snapshots_days integer,
  p_test_archives_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.data_retention_settings;
begin
  v_uid := public.data_lifecycle_assert_admin();
  if p_raw_analytics_days not in (30, 90, 180, 365) then
    raise exception 'raw_analytics_days: допустимы 30, 90, 180, 365';
  end if;
  if p_snapshots_days is null or p_snapshots_days < 30 or p_snapshots_days > 3660 then
    raise exception 'snapshots_days: от 30 до 3660';
  end if;
  if p_test_archives_days is not null
     and (p_test_archives_days < 30 or p_test_archives_days > 3660) then
    raise exception 'test_archives_days: null (никогда) или 30–3660';
  end if;

  insert into public.data_retention_settings as s (
    singleton_key, raw_analytics_days, snapshots_days, test_archives_days, updated_by, updated_at
  ) values (
    'default', p_raw_analytics_days, p_snapshots_days, p_test_archives_days, v_uid, now()
  )
  on conflict (singleton_key) do update set
    raw_analytics_days = excluded.raw_analytics_days,
    snapshots_days = excluded.snapshots_days,
    test_archives_days = excluded.test_archives_days,
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_row;

  perform public.data_lifecycle_log(
    'retention_settings_updated', 'Обновлены настройки хранения',
    jsonb_build_object(
      'raw_analytics_days', v_row.raw_analytics_days,
      'snapshots_days', v_row.snapshots_days,
      'test_archives_days', v_row.test_archives_days
    ), v_uid
  );

  return public.admin_get_data_retention_settings();
end;
$$;

revoke all on function public.admin_upsert_data_retention_settings(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_upsert_data_retention_settings(integer, integer, integer) to authenticated;

-- ============================================================
-- 10. Data usage (DB estimates vs Storage object counts)
-- ============================================================

create or replace function public.admin_get_data_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_db_bytes bigint := 0;
  v_week_ago timestamptz := now() - interval '7 days';
  v_month_ago timestamptz := now() - interval '30 days';
  v_retention integer;
  v_raw_expired integer := 0;
  v_growth jsonb;
  v_settings public.data_retention_settings;
begin
  perform public.data_lifecycle_assert_admin();

  select coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'table_name', t.relname,
        'row_estimate', greatest(t.n_live_tup, 0),
        'total_bytes', pg_total_relation_size(t.relid),
        'bytes_is_estimate', true
      )
      order by pg_total_relation_size(t.relid) desc
    )
    from pg_catalog.pg_stat_user_tables as t
    where t.schemaname = 'public'
      and t.relname in (
        'orders','order_items','order_payments','order_documents',
        'products','categories','customers','profiles',
        'analytics_events','analytics_sessions',
        'analytics_aggregates_daily','analytics_aggregates_weekly','analytics_aggregates_monthly',
        'inventory','data_archives','document_asset_snapshot_intents','product_images'
      )
  ), '[]'::jsonb) into v_tables;

  select coalesce(sum(pg_total_relation_size(c.oid)), 0) into v_db_bytes
  from pg_catalog.pg_class as c
  join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','i','t','m');

  select jsonb_build_object(
    'products', (select count(*)::integer from public.products),
    'categories', (select count(*)::integer from public.categories),
    'customers', (select count(*)::integer from public.customers),
    'orders', (select count(*)::integer from public.orders where coalesce(is_test,false)=false),
    'test_orders', (select count(*)::integer from public.orders where is_test = true),
    'order_items', (
      select count(*)::integer from public.order_items oi
      join public.orders o on o.id = oi.order_id where coalesce(o.is_test,false)=false
    ),
    'payments', (
      select count(*)::integer from public.order_payments p
      join public.orders o on o.id = p.order_id where coalesce(o.is_test,false)=false
    ),
    'documents', (select count(*)::integer from public.order_documents),
    'analytics_sessions', (select count(*)::integer from public.analytics_sessions),
    'analytics_events', (select count(*)::integer from public.analytics_events),
    'storage_snapshots', (
      select count(*)::integer from public.document_asset_snapshot_intents
      where status in ('consumed','pending')
    ),
    'data_archives', (select count(*)::integer from public.data_archives),
    'aggregates_daily', (select count(*)::integer from public.analytics_aggregates_daily),
    'aggregates_weekly', (select count(*)::integer from public.analytics_aggregates_weekly),
    'aggregates_monthly', (select count(*)::integer from public.analytics_aggregates_monthly),
    'product_image_refs', (
      select count(*)::integer from public.products where main_photo_path is not null
    )
  ) into v_counts;

  select jsonb_build_object(
    'orders_week', (select count(*)::integer from public.orders where created_at >= v_week_ago and coalesce(is_test,false)=false),
    'orders_month', (select count(*)::integer from public.orders where created_at >= v_month_ago and coalesce(is_test,false)=false),
    'analytics_events_week', (select count(*)::integer from public.analytics_events where created_at >= v_week_ago),
    'analytics_events_month', (select count(*)::integer from public.analytics_events where created_at >= v_month_ago),
    'documents_week', (select count(*)::integer from public.order_documents where created_at >= v_week_ago),
    'documents_month', (select count(*)::integer from public.order_documents where created_at >= v_month_ago),
    'customers_week', (select count(*)::integer from public.customers where created_at >= v_week_ago),
    'customers_month', (select count(*)::integer from public.customers where created_at >= v_month_ago)
  ) into v_growth;

  select * into v_settings from public.data_retention_settings where singleton_key = 'default';
  v_retention := coalesce(v_settings.raw_analytics_days, 90);

  select count(*)::integer into v_raw_expired
  from public.analytics_events
  where created_at < now() - make_interval(days => v_retention);

  return jsonb_build_object(
    'timezone', 'Asia/Almaty',
    'counts', v_counts,
    'growth', v_growth,
    'largest_tables', v_tables,
    'database', jsonb_build_object(
      'approx_bytes', v_db_bytes,
      'approx_mb', round((v_db_bytes::numeric / (1024*1024)), 2),
      'bytes_is_estimate', true,
      'label', 'оценка (pg_total_relation_size)'
    ),
    'storage', jsonb_build_object(
      'note', 'Точный объём Storage — через server API (object count / listed size). Не смешивать с DB estimate.',
      'buckets', jsonb_build_array('product-images','organization-assets','data-archives'),
      'bytes_is_estimate', true
    ),
    'retention', jsonb_build_object(
      'raw_analytics_days', v_retention,
      'raw_analytics_expired_events', v_raw_expired,
      'last_aggregated_at', v_settings.last_aggregated_at,
      'last_cleanup_at', v_settings.last_cleanup_at,
      'last_cleanup_cutoff', v_settings.last_cleanup_cutoff
    )
  );
end;
$$;

revoke all on function public.admin_get_data_usage() from public, anon, authenticated;
grant execute on function public.admin_get_data_usage() to authenticated;

create or replace function public.admin_get_dashboard_data_usage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_full jsonb;
begin
  v_full := public.admin_get_data_usage();
  return jsonb_build_object(
    'orders', coalesce((v_full->'counts'->>'orders')::integer, 0),
    'analytics_events', coalesce((v_full->'counts'->>'analytics_events')::integer, 0),
    'aggregates_daily', coalesce((v_full->'counts'->>'aggregates_daily')::integer, 0),
    'database_mb_estimate', coalesce((v_full->'database'->>'approx_mb')::numeric, 0),
    'database_bytes_estimate', coalesce((v_full->'database'->>'approx_bytes')::bigint, 0),
    'bytes_is_estimate', true,
    'raw_analytics_expired', coalesce((v_full->'retention'->>'raw_analytics_expired_events')::integer, 0),
    'raw_analytics_days', coalesce((v_full->'retention'->>'raw_analytics_days')::integer, 90),
    'documents', coalesce((v_full->'counts'->>'documents')::integer, 0),
    'data_archives', coalesce((v_full->'counts'->>'data_archives')::integer, 0),
    'test_orders', coalesce((v_full->'counts'->>'test_orders')::integer, 0),
    'last_aggregated_at', v_full->'retention'->'last_aggregated_at',
    'last_cleanup_at', v_full->'retention'->'last_cleanup_at',
    'last_cleanup_cutoff', v_full->'retention'->'last_cleanup_cutoff'
  );
end;
$$;

revoke all on function public.admin_get_dashboard_data_usage() from public, anon, authenticated;
grant execute on function public.admin_get_dashboard_data_usage() to authenticated;

-- ============================================================
-- 11. Build analytics aggregates (permanent) + coverage-gated cleanup
-- ============================================================

create or replace function public.admin_build_analytics_aggregates(
  p_date_from date default null,
  p_date_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_period record;
  v_day date;
  v_days_built integer := 0;
  v_weeks_built integer := 0;
  v_months_built integer := 0;
  v_visitors integer; v_sessions integer; v_new_visitors integer;
  v_page_views integer; v_product_views integer; v_searches integer;
  v_cart_adds integer; v_checkout_starts integer; v_orders_created integer;
  v_conversion numeric(8,4);
  v_sources jsonb; v_top_products jsonb;
  v_ts_from timestamptz; v_ts_to timestamptz;
  v_week_start date; v_week_end date; v_month_start date;
begin
  v_uid := public.data_lifecycle_assert_admin();
  select * into v_period from public.data_lifecycle_resolve_period(p_date_from, p_date_to);

  v_day := v_period.date_from;
  while v_day <= v_period.date_to loop
    v_ts_from := (v_day::timestamp at time zone 'Asia/Almaty');
    v_ts_to := ((v_day + 1)::timestamp at time zone 'Asia/Almaty');

    select count(distinct s.visitor_id)::integer, count(*)::integer,
           count(*) filter (where s.is_new_visitor)::integer
    into v_visitors, v_sessions, v_new_visitors
    from public.analytics_sessions as s
    where s.started_at >= v_ts_from and s.started_at < v_ts_to;

    select
      count(*) filter (where e.event_type = 'page_view')::integer,
      count(*) filter (where e.event_type = 'product_view')::integer,
      count(*) filter (where e.event_type in ('search','catalog_search'))::integer,
      count(*) filter (where e.event_type = 'add_to_cart')::integer,
      count(*) filter (where e.event_type = 'checkout_start')::integer,
      count(*) filter (where e.event_type = 'order_created')::integer
    into v_page_views, v_product_views, v_searches, v_cart_adds, v_checkout_starts, v_orders_created
    from public.analytics_events as e
    where e.created_at >= v_ts_from and e.created_at < v_ts_to;

    v_conversion := case when coalesce(v_visitors,0)=0 then 0
      else round((coalesce(v_orders_created,0)::numeric / v_visitors::numeric)*100, 4) end;

    select coalesce(jsonb_agg(row_obj order by (row_obj->>'sessions')::integer desc), '[]'::jsonb)
    into v_sources from (
      select jsonb_build_object(
        'source', coalesce(nullif(s.traffic_source,''),'direct'),
        'sessions', count(*)::integer,
        'visitors', count(distinct s.visitor_id)::integer
      ) as row_obj
      from public.analytics_sessions as s
      where s.started_at >= v_ts_from and s.started_at < v_ts_to
      group by 1 order by count(*) desc limit 20
    ) src;

    select coalesce(jsonb_agg(row_obj order by (row_obj->>'views')::integer desc), '[]'::jsonb)
    into v_top_products from (
      select jsonb_build_object('product_id', e.product_id, 'views', count(*)::integer) as row_obj
      from public.analytics_events as e
      where e.created_at >= v_ts_from and e.created_at < v_ts_to
        and e.event_type = 'product_view' and e.product_id is not null
      group by e.product_id order by count(*) desc limit 20
    ) tp;

    insert into public.analytics_aggregates_daily as d (
      bucket_date, visitors, sessions, new_visitors, page_views, product_views,
      searches, cart_adds, checkout_starts, orders_created, conversion_rate,
      sources, top_products, built_at, updated_at
    ) values (
      v_day, coalesce(v_visitors,0), coalesce(v_sessions,0), coalesce(v_new_visitors,0),
      coalesce(v_page_views,0), coalesce(v_product_views,0), coalesce(v_searches,0),
      coalesce(v_cart_adds,0), coalesce(v_checkout_starts,0), coalesce(v_orders_created,0),
      v_conversion, coalesce(v_sources,'[]'::jsonb), coalesce(v_top_products,'[]'::jsonb),
      now(), now()
    )
    on conflict (bucket_date) do update set
      visitors=excluded.visitors, sessions=excluded.sessions, new_visitors=excluded.new_visitors,
      page_views=excluded.page_views, product_views=excluded.product_views, searches=excluded.searches,
      cart_adds=excluded.cart_adds, checkout_starts=excluded.checkout_starts,
      orders_created=excluded.orders_created, conversion_rate=excluded.conversion_rate,
      sources=excluded.sources, top_products=excluded.top_products, updated_at=now();

    v_days_built := v_days_built + 1;
    v_day := v_day + 1;
  end loop;

  v_week_start := date_trunc('week', v_period.date_from)::date;
  while v_week_start <= v_period.date_to loop
    v_week_end := v_week_start + 6;
    select coalesce(sum(d.visitors),0)::integer, coalesce(sum(d.sessions),0)::integer,
           coalesce(sum(d.new_visitors),0)::integer, coalesce(sum(d.page_views),0)::integer,
           coalesce(sum(d.product_views),0)::integer, coalesce(sum(d.searches),0)::integer,
           coalesce(sum(d.cart_adds),0)::integer, coalesce(sum(d.checkout_starts),0)::integer,
           coalesce(sum(d.orders_created),0)::integer
    into v_visitors, v_sessions, v_new_visitors, v_page_views, v_product_views,
         v_searches, v_cart_adds, v_checkout_starts, v_orders_created
    from public.analytics_aggregates_daily as d
    where d.bucket_date >= v_week_start and d.bucket_date <= v_week_end;

    v_conversion := case when coalesce(v_visitors,0)=0 then 0
      else round((coalesce(v_orders_created,0)::numeric / v_visitors::numeric)*100, 4) end;

    insert into public.analytics_aggregates_weekly as w (
      week_start, week_end, visitors, sessions, new_visitors, page_views, product_views,
      searches, cart_adds, checkout_starts, orders_created, conversion_rate,
      sources, top_products, built_at, updated_at
    ) values (
      v_week_start, v_week_end, coalesce(v_visitors,0), coalesce(v_sessions,0), coalesce(v_new_visitors,0),
      coalesce(v_page_views,0), coalesce(v_product_views,0), coalesce(v_searches,0),
      coalesce(v_cart_adds,0), coalesce(v_checkout_starts,0), coalesce(v_orders_created,0),
      v_conversion, '[]'::jsonb, '[]'::jsonb, now(), now()
    )
    on conflict (week_start) do update set
      week_end=excluded.week_end, visitors=excluded.visitors, sessions=excluded.sessions,
      new_visitors=excluded.new_visitors, page_views=excluded.page_views,
      product_views=excluded.product_views, searches=excluded.searches,
      cart_adds=excluded.cart_adds, checkout_starts=excluded.checkout_starts,
      orders_created=excluded.orders_created, conversion_rate=excluded.conversion_rate,
      updated_at=now();

    v_weeks_built := v_weeks_built + 1;
    v_week_start := v_week_start + 7;
  end loop;

  v_month_start := date_trunc('month', v_period.date_from)::date;
  while v_month_start <= v_period.date_to loop
    select coalesce(sum(d.visitors),0)::integer, coalesce(sum(d.sessions),0)::integer,
           coalesce(sum(d.new_visitors),0)::integer, coalesce(sum(d.page_views),0)::integer,
           coalesce(sum(d.product_views),0)::integer, coalesce(sum(d.searches),0)::integer,
           coalesce(sum(d.cart_adds),0)::integer, coalesce(sum(d.checkout_starts),0)::integer,
           coalesce(sum(d.orders_created),0)::integer
    into v_visitors, v_sessions, v_new_visitors, v_page_views, v_product_views,
         v_searches, v_cart_adds, v_checkout_starts, v_orders_created
    from public.analytics_aggregates_daily as d
    where d.bucket_date >= v_month_start
      and d.bucket_date < (v_month_start + interval '1 month')::date;

    v_conversion := case when coalesce(v_visitors,0)=0 then 0
      else round((coalesce(v_orders_created,0)::numeric / v_visitors::numeric)*100, 4) end;

    insert into public.analytics_aggregates_monthly as m (
      month_start, month_label, visitors, sessions, new_visitors, page_views, product_views,
      searches, cart_adds, checkout_starts, orders_created, conversion_rate,
      sources, top_products, built_at, updated_at
    ) values (
      v_month_start, to_char(v_month_start, 'YYYY-MM'),
      coalesce(v_visitors,0), coalesce(v_sessions,0), coalesce(v_new_visitors,0),
      coalesce(v_page_views,0), coalesce(v_product_views,0), coalesce(v_searches,0),
      coalesce(v_cart_adds,0), coalesce(v_checkout_starts,0), coalesce(v_orders_created,0),
      v_conversion, '[]'::jsonb, '[]'::jsonb, now(), now()
    )
    on conflict (month_start) do update set
      month_label=excluded.month_label, visitors=excluded.visitors, sessions=excluded.sessions,
      new_visitors=excluded.new_visitors, page_views=excluded.page_views,
      product_views=excluded.product_views, searches=excluded.searches,
      cart_adds=excluded.cart_adds, checkout_starts=excluded.checkout_starts,
      orders_created=excluded.orders_created, conversion_rate=excluded.conversion_rate,
      updated_at=now();

    v_months_built := v_months_built + 1;
    v_month_start := (v_month_start + interval '1 month')::date;
  end loop;

  update public.data_retention_settings
  set last_aggregated_at = now(),
      last_aggregated_from = v_period.date_from,
      last_aggregated_to = v_period.date_to,
      updated_at = now()
  where singleton_key = 'default';

  perform public.data_lifecycle_log(
    'analytics_aggregates_built', 'Построены агрегаты аналитики',
    jsonb_build_object(
      'date_from', v_period.date_from, 'date_to', v_period.date_to,
      'days', v_days_built, 'weeks', v_weeks_built, 'months', v_months_built
    ), v_uid
  );

  return jsonb_build_object(
    'date_from', v_period.date_from, 'date_to', v_period.date_to,
    'days_built', v_days_built, 'weeks_built', v_weeks_built, 'months_built', v_months_built,
    'last_aggregated_at', now()
  );
end;
$$;

revoke all on function public.admin_build_analytics_aggregates(date, date) from public, anon, authenticated;
grant execute on function public.admin_build_analytics_aggregates(date, date) to authenticated;

create or replace function public.admin_cleanup_raw_analytics(
  p_older_than_days integer default null,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_days integer;
  v_cutoff timestamptz;
  v_settings_days integer;
  v_events_count integer := 0;
  v_sessions_count integer := 0;
  v_agg jsonb;
  v_deleted_events integer := 0;
  v_deleted_sessions integer := 0;
  v_from date;
  v_to date;
  v_missing integer := 0;
  v_coverage_ok boolean := false;
begin
  v_uid := public.data_lifecycle_assert_admin();

  select raw_analytics_days into v_settings_days
  from public.data_retention_settings where singleton_key = 'default';
  v_days := coalesce(p_older_than_days, v_settings_days, 90);
  if v_days < 30 then raise exception 'Минимальный срок хранения raw analytics — 30 дней'; end if;
  if v_days > 3660 then raise exception 'Некорректный срок хранения'; end if;

  v_cutoff := now() - make_interval(days => v_days);
  v_from := (timezone('Asia/Almaty', (
    select coalesce(min(created_at), v_cutoff) from public.analytics_events where created_at < v_cutoff
  )))::date;
  v_to := (timezone('Asia/Almaty', v_cutoff))::date;

  -- 1-3: build aggregates covering expire window through today
  v_agg := public.admin_build_analytics_aggregates(
    v_from,
    (timezone('Asia/Almaty', now()))::date
  );

  -- 4: verify daily coverage for every day with raw events before cutoff
  select count(*)::integer into v_missing
  from (
    select distinct (timezone('Asia/Almaty', e.created_at))::date as d
    from public.analytics_events as e
    where e.created_at < v_cutoff
  ) as days
  where not exists (
    select 1 from public.analytics_aggregates_daily as a where a.bucket_date = days.d
  );

  v_coverage_ok := (v_missing = 0);

  select count(*)::integer into v_events_count
  from public.analytics_events where created_at < v_cutoff;

  select count(*)::integer into v_sessions_count
  from public.analytics_sessions as s
  where s.started_at < v_cutoff
    and not exists (select 1 from public.analytics_events as e where e.session_id = s.id);

  if p_dry_run or not v_coverage_ok then
    return jsonb_build_object(
      'dry_run', true,
      'deleted', false,
      'older_than_days', v_days,
      'cutoff', v_cutoff,
      'events_to_delete', v_events_count,
      'orphan_sessions_to_delete', v_sessions_count,
      'aggregates', v_agg,
      'coverage_ok', v_coverage_ok,
      'missing_aggregate_days', v_missing,
      'last_aggregated_at', v_agg->'last_aggregated_at',
      'blocked_reason', case when not v_coverage_ok
        then 'Aggregate coverage incomplete — raw events NOT deleted'
        else null end
    );
  end if;

  -- 5: delete only after coverage OK
  delete from public.analytics_events where created_at < v_cutoff;
  get diagnostics v_deleted_events = row_count;

  delete from public.analytics_sessions as s
  where s.started_at < v_cutoff
    and not exists (select 1 from public.analytics_events as e where e.session_id = s.id);
  get diagnostics v_deleted_sessions = row_count;

  update public.data_retention_settings
  set last_cleanup_at = now(), last_cleanup_cutoff = v_cutoff, updated_at = now()
  where singleton_key = 'default';

  perform public.data_lifecycle_log(
    'raw_analytics_cleaned', 'Очищены устаревшие raw analytics events',
    jsonb_build_object(
      'older_than_days', v_days, 'cutoff', v_cutoff,
      'events_deleted', v_deleted_events, 'sessions_deleted', v_deleted_sessions
    ), v_uid
  );

  return jsonb_build_object(
    'dry_run', false, 'deleted', true,
    'older_than_days', v_days, 'cutoff', v_cutoff,
    'events_deleted', v_deleted_events, 'sessions_deleted', v_deleted_sessions,
    'aggregates', v_agg, 'coverage_ok', true,
    'last_cleanup_at', now(), 'last_cleanup_cutoff', v_cutoff
  );
end;
$$;

revoke all on function public.admin_cleanup_raw_analytics(integer, boolean) from public, anon, authenticated;
grant execute on function public.admin_cleanup_raw_analytics(integer, boolean) to authenticated;

comment on function public.admin_cleanup_raw_analytics(integer, boolean) is
  'Build aggregates, verify coverage, then delete raw analytics_events older than retention. Default dry_run=true. Idempotent.';

-- ============================================================
-- 12. Compact period archive (NO full payload in Postgres)
-- Export limits for on-demand ZIP generation
-- ============================================================

-- Hard limits for export datasets (server should also enforce)
-- orders: 5000, order_items: 50000, payments: 20000, analytics_raw: 20000

create or replace function public.admin_compute_period_manifest(
  p_date_from date,
  p_date_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_orders_count integer;
  v_items_count integer;
  v_payments_count integer;
  v_sales numeric(14,2);
  v_payments_amount numeric(14,2);
  v_visitors integer;
  v_orders_ev integer;
begin
  perform public.data_lifecycle_assert_admin();
  select * into v_period from public.data_lifecycle_resolve_period(p_date_from, p_date_to);

  select count(*)::integer, coalesce(sum(o.total),0)
  into v_orders_count, v_sales
  from public.orders as o
  where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
    and coalesce(o.is_test,false)=false and o.status <> 'cancelled';

  select count(*)::integer into v_items_count
  from public.order_items as oi
  join public.orders as o on o.id = oi.order_id
  where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
    and coalesce(o.is_test,false)=false;

  select count(*)::integer, coalesce(sum(p.amount),0)
  into v_payments_count, v_payments_amount
  from public.order_payments as p
  join public.orders as o on o.id = p.order_id
  where p.recorded_at >= v_period.ts_from and p.recorded_at < v_period.ts_to
    and p.status = 'confirmed' and coalesce(o.is_test,false)=false;

  select count(distinct visitor_id)::integer into v_visitors
  from public.analytics_sessions
  where started_at >= v_period.ts_from and started_at < v_period.ts_to;

  select count(*)::integer into v_orders_ev
  from public.analytics_events
  where created_at >= v_period.ts_from and created_at < v_period.ts_to
    and event_type = 'order_created';

  return jsonb_build_object(
    'schema_version', 1,
    'kind', 'period_report',
    'deletes_production_orders', false,
    'period', jsonb_build_object(
      'date_from', v_period.date_from,
      'date_to', v_period.date_to,
      'timezone', 'Asia/Almaty'
    ),
    'row_counts', jsonb_build_object(
      'orders', v_orders_count,
      'order_items', v_items_count,
      'payments', v_payments_count,
      'analytics_sessions', (
        select count(*)::integer from public.analytics_sessions
        where started_at >= v_period.ts_from and started_at < v_period.ts_to
      ),
      'analytics_events', (
        select count(*)::integer from public.analytics_events
        where created_at >= v_period.ts_from and created_at < v_period.ts_to
      )
    ),
    'financial_totals', jsonb_build_object(
      'sales_amount', v_sales,
      'payments_amount', v_payments_amount,
      'average_order_value', case when v_orders_count=0 then 0 else round(v_sales/v_orders_count,2) end
    ),
    'analytics_totals', jsonb_build_object(
      'visitors', coalesce(v_visitors,0),
      'orders_created_events', coalesce(v_orders_ev,0),
      'conversion_rate', case when coalesce(v_visitors,0)=0 then 0
        else round((coalesce(v_orders_ev,0)::numeric/v_visitors::numeric)*100,4) end
    )
  );
end;
$$;

revoke all on function public.admin_compute_period_manifest(date, date) from public, anon, authenticated;
grant execute on function public.admin_compute_period_manifest(date, date) to authenticated;

create or replace function public.admin_create_period_archive(
  p_archive_type text,
  p_date_from date,
  p_date_to date,
  p_title text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_period record;
  v_manifest jsonb;
  v_title text;
  v_row public.data_archives;
  v_type text;
  v_checksum text;
begin
  v_uid := public.data_lifecycle_assert_admin();
  v_type := lower(trim(coalesce(p_archive_type, '')));
  if v_type not in ('weekly','monthly','export','manual') then
    raise exception 'archive_type: weekly | monthly | export | manual';
  end if;

  select * into v_period from public.data_lifecycle_resolve_period(p_date_from, p_date_to);
  v_manifest := public.admin_compute_period_manifest(v_period.date_from, v_period.date_to);
  v_checksum := public.data_lifecycle_manifest_checksum(v_manifest);

  v_title := coalesce(nullif(trim(p_title), ''),
    case v_type
      when 'weekly' then 'Еженедельный архив '||to_char(v_period.date_from,'DD.MM')||'–'||to_char(v_period.date_to,'DD.MM.YYYY')
      when 'monthly' then 'Ежемесячный архив '||to_char(v_period.date_from,'MM.YYYY')
      else 'Экспорт '||to_char(v_period.date_from,'DD.MM.YYYY')||'–'||to_char(v_period.date_to,'DD.MM.YYYY')
    end
  );

  insert into public.data_archives (
    archive_type, period_from, period_to, title, status,
    schema_version, manifest, checksum, created_by, notes
  ) values (
    v_type, v_period.date_from, v_period.date_to, v_title, 'ready',
    1, v_manifest, v_checksum, v_uid,
    'Отчёт. НЕ удаляет рабочие заказы. ZIP формируется server-side в bucket data-archives.'
  ) returning * into v_row;

  perform public.data_lifecycle_log(
    'archive_created', v_title,
    jsonb_build_object(
      'archive_id', v_row.id, 'archive_number', v_row.archive_number,
      'archive_type', v_type, 'checksum', v_checksum,
      'row_counts', v_manifest->'row_counts'
    ), v_uid
  );

  return jsonb_build_object(
    'id', v_row.id,
    'archive_number', v_row.archive_number,
    'archive_type', v_row.archive_type,
    'period_from', v_row.period_from,
    'period_to', v_row.period_to,
    'title', v_row.title,
    'status', v_row.status,
    'schema_version', v_row.schema_version,
    'manifest', v_row.manifest,
    'checksum', v_row.checksum,
    'export_file_path', v_row.export_file_path,
    'created_at', v_row.created_at,
    'created_by', v_row.created_by,
    'notes', v_row.notes,
    'approx_db_row_bytes', octet_length(to_jsonb(v_row)::text)
  );
end;
$$;

revoke all on function public.admin_create_period_archive(text, date, date, text) from public, anon, authenticated;
grant execute on function public.admin_create_period_archive(text, date, date, text) to authenticated;

-- On-demand export dataset for server ZIP (NOT persisted). Hard limits.
create or replace function public.admin_get_period_export_dataset(
  p_date_from date,
  p_date_to date,
  p_max_orders integer default 5000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period record;
  v_max_orders integer;
  v_orders_count integer;
  v_orders jsonb;
  v_items jsonb;
  v_payments jsonb;
  v_top_products jsonb;
  v_top_customers jsonb;
  v_sources jsonb;
  v_inventory jsonb;
begin
  perform public.data_lifecycle_assert_admin();
  v_max_orders := greatest(1, least(coalesce(p_max_orders, 5000), 5000));
  select * into v_period from public.data_lifecycle_resolve_period(p_date_from, p_date_to);

  select count(*)::integer into v_orders_count
  from public.orders as o
  where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
    and coalesce(o.is_test,false)=false;

  if v_orders_count > v_max_orders then
    raise exception
      'Слишком много заказов для export (% > %). Используйте server-side chunked export / сузьте период.',
      v_orders_count, v_max_orders;
  end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]'::jsonb) into v_orders
  from (
    select o.id, o.order_number, o.status, o.total, o.subtotal, o.discount,
           o.customer_id, o.created_at, o.updated_at
    from public.orders as o
    where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
      and coalesce(o.is_test,false)=false
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]'::jsonb) into v_items
  from (
    select oi.id, oi.order_id, oi.product_id, oi.product_name, oi.product_sku,
           oi.quantity, oi.unit_price, oi.line_total, oi.created_at
    from public.order_items as oi
    join public.orders as o on o.id = oi.order_id
    where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
      and coalesce(o.is_test,false)=false
    limit 50000
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.recorded_at), '[]'::jsonb) into v_payments
  from (
    select p.id, p.order_id, p.amount, p.payment_date, p.payment_method, p.status, p.recorded_at
    from public.order_payments as p
    join public.orders as o on o.id = p.order_id
    where p.recorded_at >= v_period.ts_from and p.recorded_at < v_period.ts_to
      and coalesce(o.is_test,false)=false and p.status='confirmed'
    limit 20000
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.sales_amount desc), '[]'::jsonb) into v_top_products
  from (
    select oi.product_id, max(oi.product_sku) product_sku, max(oi.product_name) product_name,
           sum(oi.quantity) quantity_sold, sum(oi.line_total) sales_amount,
           count(distinct oi.order_id)::integer orders_count
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
      and coalesce(o.is_test,false)=false and o.status <> 'cancelled'
    group by oi.product_id order by sum(oi.line_total) desc limit 50
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.sales_amount desc), '[]'::jsonb) into v_top_customers
  from (
    select o.customer_id, count(*)::integer orders_count, sum(o.total) sales_amount
    from public.orders o
    where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
      and coalesce(o.is_test,false)=false and o.status <> 'cancelled'
    group by o.customer_id order by sum(o.total) desc limit 50
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.sessions desc), '[]'::jsonb) into v_sources
  from (
    select coalesce(nullif(s.traffic_source,''),'direct') as source,
           count(*)::integer as sessions,
           count(distinct s.visitor_id)::integer as visitors
    from public.analytics_sessions s
    where s.started_at >= v_period.ts_from and s.started_at < v_period.ts_to
    group by 1 order by count(*) desc limit 30
  ) r;

  -- Prefer aggregates for analytics sheet (not raw events)
  select coalesce(jsonb_agg(to_jsonb(d) order by d.bucket_date), '[]'::jsonb) into v_inventory
  from public.analytics_aggregates_daily d
  where d.bucket_date >= v_period.date_from and d.bucket_date <= v_period.date_to;

  return jsonb_build_object(
    'period', jsonb_build_object('date_from', v_period.date_from, 'date_to', v_period.date_to, 'timezone', 'Asia/Almaty'),
    'orders', coalesce(v_orders,'[]'::jsonb),
    'order_items', coalesce(v_items,'[]'::jsonb),
    'payments', coalesce(v_payments,'[]'::jsonb),
    'top_products', coalesce(v_top_products,'[]'::jsonb),
    'top_customers', coalesce(v_top_customers,'[]'::jsonb),
    'sources', coalesce(v_sources,'[]'::jsonb),
    'analytics_daily_aggregates', coalesce(v_inventory,'[]'::jsonb),
    'limits', jsonb_build_object('max_orders', v_max_orders, 'orders_in_period', v_orders_count),
    'persisted', false
  );
end;
$$;

revoke all on function public.admin_get_period_export_dataset(date, date, integer) from public, anon, authenticated;
grant execute on function public.admin_get_period_export_dataset(date, date, integer) to authenticated;

create or replace function public.admin_mark_archive_exported(
  p_archive_id uuid,
  p_export_file_path text,
  p_export_bytes bigint default null,
  p_file_checksum text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.data_archives;
begin
  v_uid := public.data_lifecycle_assert_admin();
  if p_archive_id is null then raise exception 'archive_id обязателен'; end if;
  if nullif(trim(p_export_file_path),'') is null then
    raise exception 'export_file_path обязателен';
  end if;
  if p_export_file_path not like ('archives/' || p_archive_id::text || '/%') then
    raise exception 'export_file_path должен быть archives/{archive_id}/...';
  end if;

  select * into v_row from public.data_archives where id = p_archive_id for update;
  if not found then raise exception 'Архив не найден'; end if;
  if v_row.status not in ('ready','draft','exported') then
    raise exception 'Нельзя пометить exported из статуса %', v_row.status;
  end if;
  if v_row.export_file_path is not null and v_row.export_file_path is distinct from p_export_file_path then
    raise exception 'ZIP immutable: путь уже задан и не совпадает';
  end if;

  update public.data_archives
  set status = 'exported',
      export_file_path = p_export_file_path,
      export_bytes = coalesce(p_export_bytes, export_bytes),
      exported_at = coalesce(exported_at, now()),
      checksum = coalesce(p_file_checksum, checksum)
  where id = p_archive_id
  returning * into v_row;

  perform public.data_lifecycle_log(
    'archive_exported', 'ZIP сохранён в Storage',
    jsonb_build_object(
      'archive_id', v_row.id, 'archive_number', v_row.archive_number,
      'export_file_path', v_row.export_file_path, 'export_bytes', v_row.export_bytes
    ), v_uid
  );

  return jsonb_build_object(
    'id', v_row.id, 'archive_number', v_row.archive_number,
    'status', v_row.status, 'export_file_path', v_row.export_file_path,
    'export_bytes', v_row.export_bytes, 'exported_at', v_row.exported_at
  );
end;
$$;

revoke all on function public.admin_mark_archive_exported(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_mark_archive_exported(uuid, text, bigint, text) to authenticated;

create or replace function public.admin_list_data_archives(
  p_archive_type text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit,50), 200));
  v_type text := nullif(lower(trim(coalesce(p_archive_type,''))), '');
  v_rows jsonb;
begin
  perform public.data_lifecycle_assert_admin();
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
  into v_rows from (
    select a.id, a.archive_number, a.archive_type, a.period_from, a.period_to,
           a.title, a.status, a.schema_version, a.manifest, a.checksum,
           a.export_file_path, a.export_bytes, a.created_by, a.created_at,
           a.exported_at, a.db_cleaned_at, a.storage_cleaned_at, a.notes
    from public.data_archives a
    where v_type is null or a.archive_type = v_type
    order by a.created_at desc limit v_limit
  ) r;
  return jsonb_build_object('archives', v_rows);
end;
$$;

revoke all on function public.admin_list_data_archives(text, integer) from public, anon, authenticated;
grant execute on function public.admin_list_data_archives(text, integer) to authenticated;

create or replace function public.admin_get_data_archive(p_archive_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.data_archives;
begin
  perform public.data_lifecycle_assert_admin();
  select * into v_row from public.data_archives where id = p_archive_id;
  if not found then raise exception 'Архив не найден'; end if;
  return jsonb_build_object(
    'id', v_row.id, 'archive_number', v_row.archive_number,
    'archive_type', v_row.archive_type, 'period_from', v_row.period_from,
    'period_to', v_row.period_to, 'title', v_row.title, 'status', v_row.status,
    'schema_version', v_row.schema_version, 'manifest', v_row.manifest,
    'checksum', v_row.checksum, 'export_file_path', v_row.export_file_path,
    'export_bytes', v_row.export_bytes, 'created_at', v_row.created_at,
    'exported_at', v_row.exported_at, 'db_cleaned_at', v_row.db_cleaned_at,
    'storage_cleaned_at', v_row.storage_cleaned_at, 'notes', v_row.notes,
    'approx_db_row_bytes', octet_length(to_jsonb(v_row)::text)
  );
end;
$$;

revoke all on function public.admin_get_data_archive(uuid) from public, anon, authenticated;
grant execute on function public.admin_get_data_archive(uuid) to authenticated;

-- ============================================================
-- 13. Test orders: prepare archive + ATOMIC cleanup
-- ============================================================
-- Inventory restore formula (exactly once per order):
--   active    → release reserved_quantity (staff_release_order_reservations)
--               quantity unchanged
--   fulfilled → quantity += reservation.quantity; mark reservation released
--   released  → no inventory change
-- Repeat cleanup: exception/no-op — never +quantity again.

create or replace function public.admin_set_order_test_flag(
  p_order_id uuid,
  p_is_test boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_order public.orders;
begin
  v_uid := public.data_lifecycle_assert_admin();
  update public.orders set is_test = coalesce(p_is_test,false)
  where id = p_order_id returning * into v_order;
  if not found then raise exception 'Заказ не найден'; end if;
  perform public.data_lifecycle_log(
    case when v_order.is_test then 'order_marked_test' else 'order_unmarked_test' end,
    'Флаг is_test для заказа '||v_order.order_number,
    jsonb_build_object('order_id', v_order.id, 'is_test', v_order.is_test), v_uid
  );
  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'is_test', v_order.is_test);
end;
$$;

revoke all on function public.admin_set_order_test_flag(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_order_test_flag(uuid, boolean) to authenticated;

create or replace function public.admin_list_test_orders(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit,100), 500));
  v_rows jsonb;
begin
  perform public.data_lifecycle_assert_admin();
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
  into v_rows from (
    select o.id, o.order_number, o.status, o.total, o.customer_id, o.created_at, o.is_test,
      (select coalesce(sum(r2.quantity),0) from public.inventory_reservations r2
       where r2.order_id=o.id and r2.status='active') as active_reserved_qty,
      (select count(*)::integer from public.inventory_reservations r2
       where r2.order_id=o.id and r2.status='fulfilled') as fulfilled_reservations,
      (select count(*)::integer from public.inventory_reservations r2
       where r2.order_id=o.id and r2.status='released') as released_reservations
    from public.orders o where o.is_test = true
    order by o.created_at desc limit v_limit
  ) r;
  return jsonb_build_object('orders', v_rows);
end;
$$;

revoke all on function public.admin_list_test_orders(integer) from public, anon, authenticated;
grant execute on function public.admin_list_test_orders(integer) to authenticated;

create or replace function public.admin_prepare_test_orders_archive(
  p_order_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_ids uuid[];
  v_orders_meta jsonb;
  v_manifest jsonb;
  v_checksum text;
  v_row public.data_archives;
begin
  v_uid := public.data_lifecycle_assert_admin();

  if p_order_ids is null or cardinality(p_order_ids)=0 then
    select array_agg(o.id) into v_ids from public.orders o where o.is_test = true;
  else
    v_ids := p_order_ids;
  end if;
  if v_ids is null or cardinality(v_ids)=0 then
    raise exception 'Нет тестовых заказов для архивации';
  end if;
  if exists (
    select 1 from public.orders o where o.id = any(v_ids) and coalesce(o.is_test,false)=false
  ) then
    raise exception 'Можно архивировать только заказы с is_test=true';
  end if;

  -- Compact fingerprints only (not full items/payments dumps)
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb)
  into v_orders_meta
  from (
    select
      o.id as order_id,
      o.order_number,
      o.status,
      o.total,
      o.created_at,
      false as inventory_restored,
      false as deleted,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'reservation_id', r.id,
          'product_id', r.product_id,
          'warehouse_id', r.warehouse_id,
          'quantity', r.quantity,
          'status', r.status
        ) order by r.product_id)
        from public.inventory_reservations r where r.order_id = o.id
      ), '[]'::jsonb) as reservations
    from public.orders o
    where o.id = any(v_ids)
  ) x;

  v_manifest := jsonb_build_object(
    'schema_version', 1,
    'kind', 'test_orders_cleanup',
    'deletes_production_orders', false,
    'order_ids', to_jsonb(v_ids),
    'orders', v_orders_meta,
    'row_counts', jsonb_build_object(
      'orders', cardinality(v_ids),
      'order_items', (select count(*)::integer from public.order_items where order_id = any(v_ids)),
      'payments', (select count(*)::integer from public.order_payments where order_id = any(v_ids))
    ),
    'financial_totals', jsonb_build_object(
      'orders_total', (select coalesce(sum(total),0) from public.orders where id = any(v_ids))
    )
  );
  v_checksum := public.data_lifecycle_manifest_checksum(v_manifest);

  insert into public.data_archives (
    archive_type, title, status, schema_version, manifest, checksum, created_by, notes
  ) values (
    'test_orders',
    'Архив тестовых заказов ('||cardinality(v_ids)::text||')',
    'ready', 1, v_manifest, v_checksum, v_uid,
    'После ZIP (exported) вызовите admin_execute_test_order_cleanup. Production orders не затрагиваются.'
  ) returning * into v_row;

  perform public.data_lifecycle_log(
    'test_orders_archive_prepared', v_row.title,
    jsonb_build_object('archive_id', v_row.id, 'archive_number', v_row.archive_number, 'order_ids', v_ids),
    v_uid
  );

  return jsonb_build_object(
    'id', v_row.id, 'archive_number', v_row.archive_number,
    'status', v_row.status, 'manifest', v_row.manifest, 'checksum', v_row.checksum,
    'approx_db_row_bytes', octet_length(to_jsonb(v_row)::text)
  );
end;
$$;

revoke all on function public.admin_prepare_test_orders_archive(uuid[]) from public, anon, authenticated;
grant execute on function public.admin_prepare_test_orders_archive(uuid[]) to authenticated;

-- Dataset for test ZIP (on-demand, not stored)
create or replace function public.admin_get_test_archive_export_dataset(p_archive_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.data_archives;
  v_ids uuid[];
begin
  perform public.data_lifecycle_assert_admin();
  select * into v_row from public.data_archives where id = p_archive_id;
  if not found then raise exception 'Архив не найден'; end if;
  if v_row.archive_type <> 'test_orders' then raise exception 'Не test_orders архив'; end if;

  select array_agg(x::uuid) into v_ids
  from jsonb_array_elements_text(coalesce(v_row.manifest->'order_ids','[]'::jsonb)) as x;

  return jsonb_build_object(
    'archive_id', v_row.id,
    'archive_number', v_row.archive_number,
    'manifest', v_row.manifest,
    'orders', coalesce((select jsonb_agg(to_jsonb(o)) from public.orders o where o.id = any(v_ids)), '[]'::jsonb),
    'order_items', coalesce((select jsonb_agg(to_jsonb(oi)) from public.order_items oi where oi.order_id = any(v_ids)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(to_jsonb(p)) from public.order_payments p where p.order_id = any(v_ids)), '[]'::jsonb),
    'reservations', coalesce((select jsonb_agg(to_jsonb(r)) from public.inventory_reservations r where r.order_id = any(v_ids)), '[]'::jsonb),
    'persisted', false
  );
end;
$$;

revoke all on function public.admin_get_test_archive_export_dataset(uuid) from public, anon, authenticated;
grant execute on function public.admin_get_test_archive_export_dataset(uuid) to authenticated;

create or replace function public.admin_execute_test_order_cleanup(
  p_archive_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_archive public.data_archives;
  v_ids uuid[];
  v_order public.orders;
  v_order_id uuid;
  v_res record;
  v_restored integer := 0;
  v_deleted integer := 0;
  v_orders_meta jsonb;
  v_lock_key bigint;
begin
  v_uid := public.data_lifecycle_assert_admin();

  if coalesce(p_confirmation,'') <> 'DELETE_TEST_ORDERS' then
    raise exception 'Подтверждение: передайте p_confirmation = DELETE_TEST_ORDERS';
  end if;
  if p_archive_id is null then raise exception 'archive_id обязателен'; end if;

  -- Global advisory lock for test cleanup
  v_lock_key := ('x' || substr(md5('dekoro:test_order_cleanup'), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select * into v_archive from public.data_archives where id = p_archive_id for update;
  if not found then raise exception 'Архив не найден'; end if;
  if v_archive.archive_type <> 'test_orders' then
    raise exception 'Cleanup только для archive_type=test_orders';
  end if;

  -- Idempotent: already cleaned
  if v_archive.status in ('db_cleaned','storage_cleanup_pending','cleaned') then
    return jsonb_build_object(
      'idempotent', true,
      'archive_id', v_archive.id,
      'status', v_archive.status,
      'message', 'DB cleanup уже выполнен — inventory/delete не повторяются'
    );
  end if;

  if v_archive.status <> 'exported' then
    raise exception 'Архив должен быть в статусе exported (сейчас: %)', v_archive.status;
  end if;
  if v_archive.export_file_path is null or v_archive.exported_at is null then
    raise exception 'Архив не экспортирован в Storage';
  end if;

  select array_agg(x::uuid) into v_ids
  from jsonb_array_elements_text(coalesce(v_archive.manifest->'order_ids','[]'::jsonb)) as x;
  if v_ids is null or cardinality(v_ids)=0 then
    raise exception 'В манифесте нет order_ids';
  end if;

  -- Lock all target orders
  perform 1 from public.orders o where o.id = any(v_ids) for update;
  if exists (
    select 1 from public.orders o where o.id = any(v_ids) and coalesce(o.is_test,false)=false
  ) then
    raise exception 'Обнаружен production order — cleanup отклонён';
  end if;
  if exists (
    select 1 from unnest(v_ids) as oid where not exists (select 1 from public.orders o where o.id = oid)
  ) then
    raise exception 'Один или несколько заказов уже отсутствуют — проверьте состояние вручную';
  end if;

  -- Verify orders still match manifest
  if coalesce((v_archive.manifest->'row_counts'->>'orders')::integer,0) <> cardinality(v_ids) then
    raise exception 'Manifest order count mismatch';
  end if;
  if coalesce(v_archive.checksum,'') <> ''
     and v_archive.checksum is distinct from public.data_lifecycle_manifest_checksum(v_archive.manifest) then
    -- Manifest mutated after prepare — refuse cleanup
    raise exception 'Manifest checksum mismatch — archive state changed';
  end if;

  v_orders_meta := coalesce(v_archive.manifest->'orders', '[]'::jsonb);

  foreach v_order_id in array v_ids loop
    select * into v_order from public.orders where id = v_order_id for update;

    -- Skip if already marked inventory_restored in manifest
    if exists (
      select 1 from jsonb_array_elements(v_orders_meta) as e
      where (e->>'order_id')::uuid = v_order_id
        and coalesce((e->>'inventory_restored')::boolean, false) = true
    ) then
      continue;
    end if;

    -- Lock inventory rows for this order's reservations
    perform 1
    from public.inventory i
    where exists (
      select 1 from public.inventory_reservations r
      where r.order_id = v_order_id
        and r.product_id = i.product_id
        and r.warehouse_id = i.warehouse_id
    )
    for update;

    -- active → release reserved
    perform public.staff_release_order_reservations(v_order_id);

    -- fulfilled → restock quantity exactly once, then mark released
    for v_res in
      select r.id, r.warehouse_id, r.product_id, r.quantity
      from public.inventory_reservations r
      where r.order_id = v_order_id and r.status = 'fulfilled'
      order by r.product_id
      for update
    loop
      update public.inventory i
      set quantity = i.quantity + v_res.quantity, updated_at = now()
      where i.warehouse_id = v_res.warehouse_id and i.product_id = v_res.product_id;

      update public.inventory_reservations r
      set status = 'released', released_at = coalesce(r.released_at, now())
      where r.id = v_res.id;

      v_restored := v_restored + 1;
    end loop;
    -- released reservations: no quantity change

    -- Delete dependents then order
    delete from public.order_picking_items i
    using public.order_picking_tasks t
    where i.picking_task_id = t.id and t.order_id = v_order_id;

    delete from public.order_warehouse_activity where order_id = v_order_id;
    delete from public.order_picking_tasks where order_id = v_order_id;
    delete from public.order_payments where order_id = v_order_id;
    delete from public.order_payment_obligations where order_id = v_order_id;

    update public.document_asset_snapshot_intents
    set consumed_document_id = null where order_id = v_order_id;
    delete from public.document_asset_snapshot_intents where order_id = v_order_id;
    delete from public.order_documents where order_id = v_order_id;
    delete from public.order_internal_notes where order_id = v_order_id;
    delete from public.order_activity_log where order_id = v_order_id;
    delete from public.order_status_history where order_id = v_order_id;
    delete from public.inventory_reservations where order_id = v_order_id;
    delete from public.order_items where order_id = v_order_id;

    update public.analytics_events set order_id = null where order_id = v_order_id;
    delete from public.orders where id = v_order_id;

    v_deleted := v_deleted + 1;
  end loop;

  -- Mark all orders inventory_restored+deleted in manifest
  select coalesce(jsonb_agg(
    (e - 'inventory_restored' - 'deleted')
      || jsonb_build_object('inventory_restored', true, 'deleted', true)
  ), '[]'::jsonb)
  into v_orders_meta
  from jsonb_array_elements(coalesce(v_archive.manifest->'orders','[]'::jsonb)) e;

  update public.data_archives
  set status = 'db_cleaned',
      db_cleaned_at = now(),
      manifest = manifest
        || jsonb_build_object(
          'orders', v_orders_meta,
          'cleanup', jsonb_build_object(
            'deleted_orders', v_deleted,
            'fulfilled_lines_restocked', v_restored,
            'cleaned_at', now(),
            'cleaned_by', v_uid
          )
        )
  where id = p_archive_id
  returning * into v_archive;

  -- Move to storage_cleanup_pending (ZIP may still exist; Storage cleanup is separate)
  update public.data_archives
  set status = 'storage_cleanup_pending'
  where id = p_archive_id
  returning * into v_archive;

  perform public.data_lifecycle_log(
    'test_orders_db_cleaned',
    'Атомарно удалены тестовые заказы архива '||v_archive.archive_number,
    jsonb_build_object(
      'archive_id', v_archive.id,
      'deleted_orders', v_deleted,
      'fulfilled_lines_restocked', v_restored
    ), v_uid
  );

  return jsonb_build_object(
    'idempotent', false,
    'archive_id', v_archive.id,
    'archive_number', v_archive.archive_number,
    'status', v_archive.status,
    'deleted_orders', v_deleted,
    'fulfilled_lines_restocked', v_restored,
    'next_step', 'storage_cleanup (server) → cleaned'
  );
end;
$$;

revoke all on function public.admin_execute_test_order_cleanup(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_execute_test_order_cleanup(uuid, text) to authenticated;

comment on function public.admin_execute_test_order_cleanup(uuid, text) is
  'Atomic test-order cleanup: restore inventory once + delete dependents/orders in one transaction. Requires exported archive + confirmation DELETE_TEST_ORDERS.';

create or replace function public.admin_mark_archive_storage_cleaned(
  p_archive_id uuid,
  p_keep_zip boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.data_archives;
begin
  v_uid := public.data_lifecycle_assert_admin();
  select * into v_row from public.data_archives where id = p_archive_id for update;
  if not found then raise exception 'Архив не найден'; end if;

  if v_row.status = 'cleaned' then
    return jsonb_build_object('idempotent', true, 'status', v_row.status);
  end if;

  if v_row.archive_type = 'test_orders' then
    if v_row.status not in ('db_cleaned','storage_cleanup_pending') then
      raise exception 'Ожидался status db_cleaned|storage_cleanup_pending (сейчас %)', v_row.status;
    end if;
  elsif v_row.status <> 'exported' and v_row.status <> 'storage_cleanup_pending' then
    raise exception 'Некорректный статус для storage cleanup: %', v_row.status;
  end if;

  update public.data_archives
  set status = case when p_keep_zip then status else 'cleaned' end,
      storage_cleaned_at = now(),
      -- if keep_zip for weekly reports, stay exported
      export_file_path = case when p_keep_zip then export_file_path else export_file_path end
  where id = p_archive_id
  returning * into v_row;

  if not p_keep_zip and v_row.archive_type = 'test_orders' then
    update public.data_archives set status = 'cleaned' where id = p_archive_id returning * into v_row;
  end if;

  perform public.data_lifecycle_log(
    'archive_storage_cleaned', 'Storage cleanup отмечен',
    jsonb_build_object('archive_id', v_row.id, 'keep_zip', p_keep_zip, 'status', v_row.status),
    v_uid
  );

  return jsonb_build_object(
    'id', v_row.id, 'status', v_row.status,
    'export_file_path', v_row.export_file_path,
    'storage_cleaned_at', v_row.storage_cleaned_at
  );
end;
$$;

revoke all on function public.admin_mark_archive_storage_cleaned(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_mark_archive_storage_cleaned(uuid, boolean) to authenticated;

-- ============================================================
-- 14. Export Center (on-demand, limited) + storage refs + schedules
-- ============================================================

create or replace function public.admin_get_export_dataset(
  p_dataset text,
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
  v_dataset text;
  v_rows jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  perform public.data_lifecycle_assert_admin();
  v_dataset := lower(trim(coalesce(p_dataset,'')));
  if v_dataset not in ('orders','customers','products','payments','analytics','inventory','dashboard') then
    raise exception 'dataset: orders|customers|products|payments|analytics|inventory|dashboard';
  end if;
  select * into v_period from public.data_lifecycle_resolve_period(p_date_from, p_date_to);

  if v_dataset = 'orders' then
    select count(*)::integer into v_count from public.orders o
    where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
      and coalesce(o.is_test,false)=false;
    if v_count > 5000 then
      raise exception 'Export orders limit 5000 exceeded (%). Сузьте период / server-side.', v_count;
    end if;
    select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at),'[]'::jsonb) into v_rows from (
      select o.id, o.order_number, o.status, o.total, o.customer_id, o.created_at
      from public.orders o
      where o.created_at >= v_period.ts_from and o.created_at < v_period.ts_to
        and coalesce(o.is_test,false)=false
    ) r;
  elsif v_dataset = 'customers' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at),'[]'::jsonb) into v_rows from (
      select c.id, c.customer_type, c.display_name, c.phone, c.email, c.city, c.created_at
      from public.customers c
      where c.created_at >= v_period.ts_from and c.created_at < v_period.ts_to
      limit 10000
    ) r;
  elsif v_dataset = 'products' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at),'[]'::jsonb) into v_rows from (
      select p.id, p.sku, p.name, p.status, p.base_price, p.category_id, p.main_photo_path, p.created_at
      from public.products p limit 20000
    ) r;
  elsif v_dataset = 'payments' then
    select count(*)::integer into v_count
    from public.order_payments p join public.orders o on o.id=p.order_id
    where p.recorded_at >= v_period.ts_from and p.recorded_at < v_period.ts_to
      and coalesce(o.is_test,false)=false;
    if v_count > 20000 then
      raise exception 'Export payments limit 20000 exceeded (%)', v_count;
    end if;
    select coalesce(jsonb_agg(to_jsonb(r) order by r.recorded_at),'[]'::jsonb) into v_rows from (
      select p.id, p.order_id, p.amount, p.payment_date, p.payment_method, p.status, p.recorded_at
      from public.order_payments p join public.orders o on o.id=p.order_id
      where p.recorded_at >= v_period.ts_from and p.recorded_at < v_period.ts_to
        and coalesce(o.is_test,false)=false
    ) r;
  elsif v_dataset = 'analytics' then
    -- Prefer permanent aggregates — NOT raw events
    select coalesce(jsonb_agg(to_jsonb(d) order by d.bucket_date),'[]'::jsonb) into v_rows from (
      select * from public.analytics_aggregates_daily d
      where d.bucket_date >= v_period.date_from and d.bucket_date <= v_period.date_to
    ) d;
  elsif v_dataset = 'inventory' then
    select coalesce(jsonb_agg(to_jsonb(r) order by r.sku),'[]'::jsonb) into v_rows from (
      select i.product_id, p.sku, p.name, i.warehouse_id, i.quantity, i.reserved_quantity,
             (i.quantity - i.reserved_quantity) as available_quantity
      from public.inventory i join public.products p on p.id = i.product_id
    ) r;
  else
    v_rows := jsonb_build_array(public.admin_compute_period_manifest(v_period.date_from, v_period.date_to)->'financial_totals');
  end if;

  return jsonb_build_object(
    'dataset', v_dataset,
    'period', jsonb_build_object('date_from', v_period.date_from, 'date_to', v_period.date_to, 'timezone', 'Asia/Almaty'),
    'rows', coalesce(v_rows,'[]'::jsonb),
    'row_count', jsonb_array_length(coalesce(v_rows,'[]'::jsonb)),
    'persisted', false,
    'source', case when v_dataset='analytics' then 'aggregates_daily' else 'live_query' end
  );
end;
$$;

revoke all on function public.admin_get_export_dataset(text, date, date) from public, anon, authenticated;
grant execute on function public.admin_get_export_dataset(text, date, date) to authenticated;

create or replace function public.admin_get_storage_references()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product_images jsonb;
  v_documents jsonb;
  v_snapshots jsonb;
  v_org jsonb;
  v_archives jsonb;
begin
  perform public.data_lifecycle_assert_admin();

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_product_images from (
    select distinct 'product-images'::text as bucket, p.main_photo_path as path, p.id as product_id
    from public.products p where p.main_photo_path is not null
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_documents from (
    select 'organization-assets'::text as bucket, d.file_path as path, d.id as document_id, d.order_id
    from public.order_documents d where d.file_path is not null
  ) r;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb) into v_snapshots from (
    select i.id, i.status, i.order_id, i.document_type,
           i.source_logo_path, i.source_stamp_path, i.source_signature_path,
           i.logo_path, i.stamp_path, i.signature_path, i.expires_at, i.created_at
    from public.document_asset_snapshot_intents i
    order by i.created_at desc limit 500
  ) r;

  select jsonb_build_object(
    'logo_path', s.logo_path, 'stamp_path', s.stamp_path, 'signature_path', s.signature_path
  ) into v_org from public.organization_settings s where s.singleton_key='default';

  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_archives from (
    select a.id, a.archive_number, a.export_file_path, a.status, a.export_bytes
    from public.data_archives a where a.export_file_path is not null
  ) r;

  return jsonb_build_object(
    'product_images', coalesce(v_product_images,'[]'::jsonb),
    'documents', coalesce(v_documents,'[]'::jsonb),
    'snapshots', coalesce(v_snapshots,'[]'::jsonb),
    'organization_assets', coalesce(v_org,'{}'::jsonb),
    'data_archives', coalesce(v_archives,'[]'::jsonb),
    'note', 'Physical orphan scan/delete — server API only (service_role after admin JWT).'
  );
end;
$$;

revoke all on function public.admin_get_storage_references() from public, anon, authenticated;
grant execute on function public.admin_get_storage_references() to authenticated;

create or replace function public.admin_expire_snapshot_intents(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_count integer := 0;
begin
  v_uid := public.data_lifecycle_assert_admin();
  select count(*)::integer into v_count
  from public.document_asset_snapshot_intents
  where status='pending' and expires_at < now();
  if p_dry_run then
    return jsonb_build_object('dry_run', true, 'pending_expired', v_count);
  end if;
  update public.document_asset_snapshot_intents set status='expired'
  where status='pending' and expires_at < now();
  get diagnostics v_count = row_count;
  perform public.data_lifecycle_log('snapshot_intents_expired','Истекли pending snapshot intents',
    jsonb_build_object('expired_count', v_count), v_uid);
  return jsonb_build_object('dry_run', false, 'expired_count', v_count);
end;
$$;

revoke all on function public.admin_expire_snapshot_intents(boolean) from public, anon, authenticated;
grant execute on function public.admin_expire_snapshot_intents(boolean) to authenticated;

create or replace function public.admin_list_archive_schedules()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_rows jsonb;
begin
  perform public.data_lifecycle_assert_admin();
  select coalesce(jsonb_agg(to_jsonb(r) order by r.schedule_key),'[]'::jsonb) into v_rows from (
    select s.* from public.data_archive_schedules s
  ) r;
  return jsonb_build_object(
    'schedules', v_rows, 'automation_enabled', false,
    'note', 'Cron не подключён. weekly_sunday / monthly_first подготовлены.'
  );
end;
$$;

revoke all on function public.admin_list_archive_schedules() from public, anon, authenticated;
grant execute on function public.admin_list_archive_schedules() to authenticated;

create or replace function public.admin_prepare_scheduled_weekly_archive()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_today date := (timezone('Asia/Almaty', now()))::date;
  v_period_to date;
  v_period_from date;
  v_archive jsonb;
begin
  v_uid := public.data_lifecycle_assert_admin();
  v_period_to := v_today - ((extract(dow from v_today)::integer + 7 - 0) % 7);
  if v_period_to = v_today then v_period_to := v_today - 7; end if;
  v_period_from := v_period_to - 6;

  v_archive := public.admin_create_period_archive('weekly', v_period_from, v_period_to, null);

  update public.data_archive_schedules
  set last_run_at = now(),
      last_archive_id = (v_archive->>'id')::uuid,
      next_run_at = (
        (
          date_trunc('day', timezone('Asia/Almaty', now()))
          + ((7 - extract(dow from timezone('Asia/Almaty', now()))::integer) % 7) * interval '1 day'
          + interval '7 days' + interval '3 hours'
        ) at time zone 'Asia/Almaty'
      ),
      updated_at = now()
  where schedule_key = 'weekly_sunday';

  perform public.data_lifecycle_log(
    'scheduled_weekly_archive_prepared', 'Сформирован compact weekly archive (ZIP отдельно)',
    jsonb_build_object('archive', v_archive), v_uid
  );

  return jsonb_build_object(
    'archive', v_archive,
    'period_from', v_period_from, 'period_to', v_period_to,
    'automation_enabled', false,
    'note', 'Создаёт отчёт/манифест. НЕ удаляет рабочие заказы. ZIP — через server export.'
  );
end;
$$;

revoke all on function public.admin_prepare_scheduled_weekly_archive() from public, anon, authenticated;
grant execute on function public.admin_prepare_scheduled_weekly_archive() to authenticated;

create or replace function public.admin_list_lifecycle_activity(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit,50), 200));
  v_rows jsonb;
begin
  perform public.data_lifecycle_assert_admin();
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc),'[]'::jsonb) into v_rows from (
    select a.id, a.event_type, a.description, a.metadata, a.created_by, a.created_at
    from public.data_lifecycle_activity a
    order by a.created_at desc limit v_limit
  ) r;
  return jsonb_build_object('activity', v_rows);
end;
$$;

revoke all on function public.admin_list_lifecycle_activity(integer) from public, anon, authenticated;
grant execute on function public.admin_list_lifecycle_activity(integer) to authenticated;

-- Drop superseded draft RPCs if present (safe)
drop function if exists public.admin_build_period_archive_payload(date, date);
drop function if exists public.admin_archive_test_orders(uuid[]);
drop function if exists public.admin_restore_test_order_inventory(uuid);
drop function if exists public.admin_delete_test_order(uuid, boolean);

-- ============================================================
-- Safety notes
-- ============================================================
-- NEVER: TRUNCATE / DELETE ALL / reset sequences /
--        auto-delete customers, products, staff, production orders
-- SAFE cleanup: test orders (atomic RPC), raw analytics (after aggregates),
--               expired intents, confirmed orphan storage (server)
-- Weekly/monthly archive = REPORT ONLY
-- Archive Postgres row ≈ 2–15 KB (manifest). ZIP in data-archives Storage.
-- ============================================================


-- Reload PostgREST schema cache so RPC names appear immediately
notify pgrst, 'reload schema';
