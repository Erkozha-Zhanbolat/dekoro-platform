-- ============================================================
-- 029_staff_notifications.sql
-- Stage 29 — Staff Notifications (in-app)
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–028 files.
--
-- Purpose:
--   1. staff_notifications table (source of truth for in-app alerts).
--   2. Internal helper staff_notify_new_order() — no GRANT.
--   3. AFTER INSERT trigger on orders → notify active admin/manager
--      (fail-soft: notification errors never roll back the order).
--   4. Client-safe staff RPCs: list / unread count / mark read.
--   5. Safe Realtime: SELECT grant + RLS (own rows only) + publication.
--   6. admin_get_data_usage includes staff_notifications count.
--
-- Explicitly NOT done here:
--   - Web Push / Notification API / email / telegram / whatsapp;
--   - auto-retention purge;
--   - notifying accountant / warehouse on new_order;
--   - production notifications for is_test orders.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'public.orders missing — run 005 first.';
  end if;

  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles missing — run 001 first.';
  end if;

  if to_regclass('public.customers') is null then
    raise exception 'public.customers missing — run 013 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role missing — run 010 first.';
  end if;

  if to_regprocedure('public.data_lifecycle_assert_admin()') is null then
    raise exception 'public.data_lifecycle_assert_admin missing — run 027 first.';
  end if;
end
$$;

-- ============================================================
-- 1. staff_notifications
-- ============================================================

create table if not exists public.staff_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles (id) on delete cascade,
  notification_type text not null,
  title text not null,
  message text,
  entity_type text,
  entity_id uuid,
  action_url text,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint staff_notifications_type_check check (
    notification_type in (
      'new_order',
      'payment_received',
      'payment_overdue',
      'order_paid',
      'picking_started',
      'order_ready',
      'order_shipped',
      'low_stock',
      'customer_registered'
    )
  ),
  constraint staff_notifications_title_not_blank check (length(trim(title)) > 0),
  constraint staff_notifications_metadata_object check (jsonb_typeof(metadata) = 'object')
);

comment on table public.staff_notifications is
  'In-app staff notifications. Source of truth for Stage 29; future channels (email/telegram/push) should reference rows here via a deliveries table.';

comment on column public.staff_notifications.metadata is
  'Server-built snapshot (order_number, total, customer_label, is_test, …). Never trust browser-supplied copy.';

-- List / unread indexes
create index if not exists staff_notifications_recipient_created_idx
  on public.staff_notifications (recipient_profile_id, created_at desc);

create index if not exists staff_notifications_recipient_read_idx
  on public.staff_notifications (recipient_profile_id, read_at);

create index if not exists staff_notifications_type_created_idx
  on public.staff_notifications (notification_type, created_at desc);

-- Idempotency for new_order: one row per recipient per order.
-- Other future types may allow repeats — they are intentionally excluded
-- from this partial unique index.
create unique index if not exists staff_notifications_new_order_unique
  on public.staff_notifications (
    recipient_profile_id,
    notification_type,
    entity_type,
    entity_id
  )
  where notification_type = 'new_order'
    and entity_type = 'order'
    and entity_id is not null;

-- ============================================================
-- 2. RLS — own rows only; no unrestricted client access
-- ============================================================

alter table public.staff_notifications enable row level security;

revoke all on public.staff_notifications from public, anon, authenticated;

-- SELECT only: required for safe Realtime (postgres_changes) filtered by RLS.
-- Writes stay RPC/SECURITY DEFINER only (no INSERT/UPDATE/DELETE policies).
grant select on public.staff_notifications to authenticated;

drop policy if exists staff_notifications_select_own on public.staff_notifications;
create policy staff_notifications_select_own
  on public.staff_notifications
  for select
  to authenticated
  using (
    recipient_profile_id = auth.uid()
    and public.has_staff_role(
      array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
    )
  );

-- Realtime publication (hosted Supabase). Ignore if publication missing.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    begin
      alter publication supabase_realtime add table public.staff_notifications;
    exception
      when duplicate_object then
        null;
    end;
  end if;
end
$$;

-- ============================================================
-- 3. Amount formatting helper (internal)
-- ============================================================

create or replace function public.staff_format_notification_amount(p_amount numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select
    coalesce(
      nullif(
        replace(
          trim(to_char(round(coalesce(p_amount, 0)), 'FM999,999,999,999,990')),
          ',',
          ' '
        ),
        ''
      ),
      '0'
    ) || ' ₸';
$$;

revoke all on function public.staff_format_notification_amount(numeric)
  from public, anon, authenticated;

comment on function public.staff_format_notification_amount(numeric) is
  'Internal: format order total like UI formatPrice (spaces + ₸). No GRANT.';

-- ============================================================
-- 4. staff_notify_new_order — internal SECURITY DEFINER helper
-- ============================================================

create or replace function public.staff_notify_new_order(
  p_order_id uuid,
  p_actor_profile_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_customer public.customers%rowtype;
  v_has_customer boolean := false;
  v_customer_label text;
  v_title text;
  v_message text;
  v_amount_text text;
  v_action_url text;
  v_metadata jsonb;
  v_recipient record;
begin
  if p_order_id is null then
    return;
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    return;
  end if;

  -- Stage 27: never spam production inboxes with test orders.
  if coalesce(v_order.is_test, false) then
    return;
  end if;

  if v_order.customer_id is not null then
    select * into v_customer
    from public.customers as c
    where c.id = v_order.customer_id;
    v_has_customer := found;
  end if;

  if v_has_customer then
    if v_customer.customer_type = 'company' then
      v_customer_label := coalesce(
        nullif(trim(v_customer.legal_name), ''),
        nullif(trim(v_customer.display_name), ''),
        nullif(trim(v_order.contact_name), ''),
        'Клиент'
      );
    else
      v_customer_label := coalesce(
        nullif(trim(v_customer.display_name), ''),
        nullif(trim(v_order.contact_name), ''),
        'Клиент'
      );
    end if;
  else
    v_customer_label := coalesce(nullif(trim(v_order.contact_name), ''), 'Клиент');
  end if;

  v_amount_text := public.staff_format_notification_amount(v_order.total);
  v_title := 'Новый заказ ' || coalesce(v_order.order_number, '');
  -- "Сумма заказа" (not "К оплате") — order.total may differ from invoice VAT total.
  v_message := v_customer_label || ' · Сумма заказа: ' || v_amount_text;
  v_action_url := '/staff/orders/' || v_order.id::text;

  v_metadata := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'order_total', v_order.total,
    'customer_id', v_order.customer_id,
    'customer_label', v_customer_label,
    'is_test', coalesce(v_order.is_test, false),
    'actor_profile_id', p_actor_profile_id
  );

  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role in ('admin', 'manager')
      and (p_actor_profile_id is null or p.id is distinct from p_actor_profile_id)
  loop
    insert into public.staff_notifications (
      recipient_profile_id,
      notification_type,
      title,
      message,
      entity_type,
      entity_id,
      action_url,
      metadata
    ) values (
      v_recipient.id,
      'new_order',
      v_title,
      v_message,
      'order',
      v_order.id,
      v_action_url,
      v_metadata
    )
    -- Partial unique index staff_notifications_new_order_unique.
    on conflict do nothing;
  end loop;
end;
$$;

revoke all on function public.staff_notify_new_order(uuid, uuid)
  from public, anon, authenticated;

comment on function public.staff_notify_new_order(uuid, uuid) is
  'Internal: fan-out new_order notifications to active admin/manager. No GRANT. Skips is_test and optional actor.';

-- ============================================================
-- 5. AFTER INSERT trigger on orders (fail-soft)
--
-- Preference: order must never be lost because of notifications.
-- Helper runs in the same transaction AFTER the order row exists
-- (and after BEFORE INSERT customer_id ensure). If notify raises,
-- catch and WARNING — order/items/reservations still commit.
-- If the outer order RPC later raises, the whole txn (incl. notify
-- inserts) rolls back — so notification-without-order is impossible.
-- ============================================================

create or replace function public.orders_notify_staff_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public.staff_notify_new_order(NEW.id, auth.uid());
  exception
    when others then
      raise warning
        'staff_notify_new_order failed for order %: %',
        NEW.id,
        SQLERRM;
  end;

  return NEW;
end;
$$;

revoke all on function public.orders_notify_staff_after_insert()
  from public, anon, authenticated;

drop trigger if exists orders_notify_staff_after_insert_trg on public.orders;
create trigger orders_notify_staff_after_insert_trg
  after insert on public.orders
  for each row
  execute function public.orders_notify_staff_after_insert();

comment on function public.orders_notify_staff_after_insert() is
  'AFTER INSERT on orders: fail-soft call to staff_notify_new_order. Covers create_order + staff create RPCs.';

-- ============================================================
-- 6. Client-safe staff RPCs (recipient always = auth.uid())
-- ============================================================

create or replace function public.staff_list_notifications(
  p_limit integer default 30,
  p_unread_only boolean default false,
  p_offset integer default 0
)
returns table (
  id uuid,
  notification_type text,
  title text,
  message text,
  entity_type text,
  entity_id uuid,
  action_url text,
  metadata jsonb,
  read_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_limit integer;
  v_offset integer;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 30), 100));
  v_offset := greatest(0, coalesce(p_offset, 0));

  return query
  select
    n.id,
    n.notification_type,
    n.title,
    n.message,
    n.entity_type,
    n.entity_id,
    n.action_url,
    n.metadata,
    n.read_at,
    n.created_at
  from public.staff_notifications as n
  where n.recipient_profile_id = v_uid
    and (
      coalesce(p_unread_only, false) = false
      or n.read_at is null
    )
  order by n.created_at desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.staff_list_notifications(integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_notifications(integer, boolean, integer)
  to authenticated;

create or replace function public.staff_get_unread_notification_count()
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав';
  end if;

  select count(*)::integer into v_count
  from public.staff_notifications as n
  where n.recipient_profile_id = v_uid
    and n.read_at is null;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.staff_get_unread_notification_count()
  from public, anon, authenticated;
grant execute on function public.staff_get_unread_notification_count()
  to authenticated;

create or replace function public.staff_mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав';
  end if;

  if p_notification_id is null then
    raise exception 'Не указано уведомление';
  end if;

  update public.staff_notifications as n
  set read_at = coalesce(n.read_at, now())
  where n.id = p_notification_id
    and n.recipient_profile_id = v_uid;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.staff_mark_notification_read(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_mark_notification_read(uuid)
  to authenticated;

create or replace function public.staff_mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав';
  end if;

  update public.staff_notifications as n
  set read_at = now()
  where n.recipient_profile_id = v_uid
    and n.read_at is null;

  get diagnostics v_updated = row_count;
  return coalesce(v_updated, 0);
end;
$$;

revoke all on function public.staff_mark_all_notifications_read()
  from public, anon, authenticated;
grant execute on function public.staff_mark_all_notifications_read()
  to authenticated;

-- ============================================================
-- 7. admin_get_data_usage — include staff_notifications
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
        'inventory','data_archives','document_asset_snapshot_intents','product_images',
        'price_groups','product_prices','customer_product_prices','company_product_prices',
        'staff_notifications'
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
    ),
    'price_groups', (select count(*)::integer from public.price_groups),
    'product_prices', (select count(*)::integer from public.product_prices),
    'customer_product_prices', (select count(*)::integer from public.customer_product_prices),
    'company_product_prices', (select count(*)::integer from public.company_product_prices),
    'staff_notifications', (select count(*)::integer from public.staff_notifications)
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

-- ============================================================
-- Notes
--
-- Order creation paths covered by AFTER INSERT trigger:
--   - public.create_order(...)           — client checkout / repeat→cart
--   - public.staff_create_order(...)     — legacy staff shell
--   - public.staff_create_order_for_customer(...) — primary staff path
--
-- Fail-soft: notify exception → WARNING, order commits.
-- Atomic opposite: order RPC failure → notify rows roll back with txn.
--
-- Recipients (new_order): active admin + manager only.
-- Actor (staff creator) excluded when auth.uid() matches.
-- is_test=true → no notification.
-- ============================================================
