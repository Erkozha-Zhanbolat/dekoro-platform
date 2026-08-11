-- ============================================================
-- 030_workflow_notifications.sql
-- Stage 30 — Workflow & Client Notifications
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–029 files.
--
-- Purpose:
--   1. client_notifications (+ RLS / Realtime / client RPCs).
--   2. Extend staff_notifications types (+ stock_received).
--   3. Idempotent workflow milestone notifications (paid / picking /
--      ready / shipped) via AFTER UPDATE OF status on orders.
--   4. Explicit stock_receipts + staff_record_stock_receipt
--      (warehouse + admin) — separate from inventory corrections.
--   5. admin_get_data_usage includes client_notifications + stock_receipts.
--
-- Explicitly NOT done here:
--   - procurement / purchase orders / suppliers module;
--   - auto-emitting payment_received on every partial payment;
--   - order_completed client spam (type reserved, not emitted);
--   - auto-retention purge.
-- ============================================================

do $$
begin
  if to_regclass('public.staff_notifications') is null then
    raise exception 'public.staff_notifications missing — run 029 first.';
  end if;

  if to_regclass('public.orders') is null then
    raise exception 'public.orders missing — run 005 first.';
  end if;

  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles missing — run 001 first.';
  end if;

  if to_regclass('public.inventory') is null then
    raise exception 'public.inventory missing — run 002 first.';
  end if;

  if to_regclass('public.inventory_adjustments') is null then
    raise exception 'public.inventory_adjustments missing — run 020 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role missing — run 010 first.';
  end if;

  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception 'public.staff_resolve_warehouse_id missing — run 011 first.';
  end if;

  if to_regprocedure('public.staff_format_notification_amount(numeric)') is null then
    raise exception 'public.staff_format_notification_amount missing — run 029 first.';
  end if;

  if to_regprocedure('public.data_lifecycle_assert_admin()') is null then
    raise exception 'public.data_lifecycle_assert_admin missing — run 027 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Extend staff_notifications type check (+ stock_received)
-- ============================================================

alter table public.staff_notifications
  drop constraint if exists staff_notifications_type_check;

alter table public.staff_notifications
  add constraint staff_notifications_type_check check (
    notification_type in (
      'new_order',
      'payment_received',
      'payment_overdue',
      'order_paid',
      'picking_started',
      'order_ready',
      'order_shipped',
      'low_stock',
      'customer_registered',
      'stock_received'
    )
  );

-- Idempotency for workflow milestones (new_order unique index stays in 029).
create unique index if not exists staff_notifications_workflow_unique
  on public.staff_notifications (
    recipient_profile_id,
    notification_type,
    entity_type,
    entity_id
  )
  where notification_type in (
      'order_paid',
      'picking_started',
      'order_ready',
      'order_shipped',
      'stock_received'
    )
    and entity_type is not null
    and entity_id is not null;

-- ============================================================
-- 2. client_notifications
-- ============================================================

create table if not exists public.client_notifications (
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
  constraint client_notifications_type_check check (
    notification_type in (
      'payment_confirmed',
      'order_picking',
      'order_ready',
      'order_shipped',
      'order_completed'
    )
  ),
  constraint client_notifications_title_not_blank check (length(trim(title)) > 0),
  constraint client_notifications_metadata_object check (jsonb_typeof(metadata) = 'object')
);

comment on table public.client_notifications is
  'In-app client notifications. Client-safe copy only — no staff names, warehouse notes, payment refs, or stock internals.';

comment on column public.client_notifications.metadata is
  'Server-built client-safe snapshot (order_number, is_test, …). Never trust browser-supplied copy.';

create index if not exists client_notifications_recipient_created_idx
  on public.client_notifications (recipient_profile_id, created_at desc);

create index if not exists client_notifications_recipient_read_idx
  on public.client_notifications (recipient_profile_id, read_at);

create index if not exists client_notifications_type_created_idx
  on public.client_notifications (notification_type, created_at desc);

create unique index if not exists client_notifications_workflow_unique
  on public.client_notifications (
    recipient_profile_id,
    notification_type,
    entity_type,
    entity_id
  )
  where notification_type in (
      'payment_confirmed',
      'order_picking',
      'order_ready',
      'order_shipped',
      'order_completed'
    )
    and entity_type is not null
    and entity_id is not null;

alter table public.client_notifications enable row level security;

revoke all on public.client_notifications from public, anon, authenticated;

grant select on public.client_notifications to authenticated;

drop policy if exists client_notifications_select_own on public.client_notifications;
create policy client_notifications_select_own
  on public.client_notifications
  for select
  to authenticated
  using (recipient_profile_id = auth.uid());

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    begin
      alter publication supabase_realtime add table public.client_notifications;
    exception
      when duplicate_object then
        null;
    end;
  end if;
end
$$;

-- ============================================================
-- 3. stock_receipts — explicit receipt (not a correction)
--
-- Future procurement may add supplier / purchase_receipt / batch
-- without changing the core quantity path. metadata + nullable
-- placeholders reserve that space; no procurement module here.
-- ============================================================

create table if not exists public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  warehouse_id uuid not null references public.warehouses (id) on delete restrict,
  inventory_id uuid not null references public.inventory (id) on delete restrict,
  quantity numeric(14, 3) not null,
  previous_quantity numeric(14, 3) not null,
  new_quantity numeric(14, 3) not null,
  document_number text,
  reason text,
  -- Reserved for future procurement (no FK / no UI yet).
  supplier_name text,
  batch_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint stock_receipts_quantity_positive check (quantity > 0),
  constraint stock_receipts_previous_non_negative check (previous_quantity >= 0),
  constraint stock_receipts_new_non_negative check (new_quantity >= 0),
  constraint stock_receipts_qty_matches check (
    new_quantity = previous_quantity + quantity
  ),
  constraint stock_receipts_document_number_len check (
    document_number is null
    or (
      length(trim(document_number)) > 0
      and char_length(trim(document_number)) <= 100
    )
  ),
  constraint stock_receipts_reason_len check (
    reason is null
    or (
      length(trim(reason)) > 0
      and char_length(trim(reason)) <= 500
    )
  ),
  constraint stock_receipts_supplier_name_len check (
    supplier_name is null
    or (
      length(trim(supplier_name)) > 0
      and char_length(trim(supplier_name)) <= 200
    )
  ),
  constraint stock_receipts_batch_code_len check (
    batch_code is null
    or (
      length(trim(batch_code)) > 0
      and char_length(trim(batch_code)) <= 100
    )
  ),
  constraint stock_receipts_metadata_object check (jsonb_typeof(metadata) = 'object')
);

comment on table public.stock_receipts is
  'Explicit stock receipts (оприходование). Separate from inventory_adjustments corrections. Future procurement can attach supplier/batch/document without changing quantity math.';

create index if not exists stock_receipts_product_created_idx
  on public.stock_receipts (product_id, created_at desc);

create index if not exists stock_receipts_warehouse_created_idx
  on public.stock_receipts (warehouse_id, created_at desc);

alter table public.stock_receipts enable row level security;

revoke all on table public.stock_receipts from public, anon, authenticated;

-- ============================================================
-- 4. Internal helpers
-- ============================================================

create or replace function public.staff_format_notification_qty(p_qty numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select
    case
      when p_qty is null then '0'
      when p_qty = trunc(p_qty) then trunc(p_qty)::text
      else trim(both '0' from trim(trailing '.' from p_qty::text))
    end;
$$;

revoke all on function public.staff_format_notification_qty(numeric)
  from public, anon, authenticated;

comment on function public.staff_format_notification_qty(numeric) is
  'Internal: compact qty for notification copy (120 or 120.5). No GRANT.';

create or replace function public.client_resolve_order_recipient(p_order_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_recipient uuid;
  v_profile public.profiles%rowtype;
begin
  if p_order_id is null then
    return null;
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    return null;
  end if;

  v_recipient := coalesce(v_order.user_id, v_order.profile_id);

  if v_recipient is null and v_order.customer_id is not null then
    select c.profile_id into v_recipient
    from public.customers as c
    where c.id = v_order.customer_id;
  end if;

  if v_recipient is null then
    return null;
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_recipient;

  if not found then
    return null;
  end if;

  -- Walk-in / staff / inactive: no client inbox row.
  if coalesce(v_profile.is_active, false) = false then
    return null;
  end if;

  if v_profile.role is distinct from 'client'::public.user_role then
    return null;
  end if;

  return v_profile.id;
end;
$$;

revoke all on function public.client_resolve_order_recipient(uuid)
  from public, anon, authenticated;

comment on function public.client_resolve_order_recipient(uuid) is
  'Internal: active client profile for an order (user_id/profile_id/customer.profile_id). Null for walk-in. No GRANT.';

create or replace function public.staff_insert_notification(
  p_recipient_profile_id uuid,
  p_notification_type text,
  p_title text,
  p_message text,
  p_entity_type text,
  p_entity_id uuid,
  p_action_url text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_recipient_profile_id is null or p_notification_type is null then
    return;
  end if;

  if p_title is null or length(trim(p_title)) = 0 then
    return;
  end if;

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
    p_recipient_profile_id,
    p_notification_type,
    trim(p_title),
    nullif(trim(coalesce(p_message, '')), ''),
    p_entity_type,
    p_entity_id,
    p_action_url,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict do nothing;
end;
$$;

revoke all on function public.staff_insert_notification(
  uuid, text, text, text, text, uuid, text, jsonb
) from public, anon, authenticated;

create or replace function public.client_insert_notification(
  p_recipient_profile_id uuid,
  p_notification_type text,
  p_title text,
  p_message text,
  p_entity_type text,
  p_entity_id uuid,
  p_action_url text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_recipient_profile_id is null or p_notification_type is null then
    return;
  end if;

  if p_title is null or length(trim(p_title)) = 0 then
    return;
  end if;

  insert into public.client_notifications (
    recipient_profile_id,
    notification_type,
    title,
    message,
    entity_type,
    entity_id,
    action_url,
    metadata
  ) values (
    p_recipient_profile_id,
    p_notification_type,
    trim(p_title),
    nullif(trim(coalesce(p_message, '')), ''),
    p_entity_type,
    p_entity_id,
    p_action_url,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict do nothing;
end;
$$;

revoke all on function public.client_insert_notification(
  uuid, text, text, text, text, uuid, text, jsonb
) from public, anon, authenticated;

-- ============================================================
-- 5. Workflow notify helpers (internal, no GRANT)
-- ============================================================

create or replace function public.notify_order_paid(p_order_id uuid)
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
  v_amount_text text;
  v_meta jsonb;
  v_client uuid;
  v_recipient record;
begin
  if p_order_id is null then
    return;
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    return;
  end if;

  if coalesce(v_order.is_test, false) then
    return;
  end if;

  if v_order.customer_id is not null then
    select * into v_customer from public.customers as c where c.id = v_order.customer_id;
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
  v_meta := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'order_total', v_order.total,
    'customer_id', v_order.customer_id,
    'customer_label', v_customer_label,
    'is_test', false
  );

  -- Warehouse: start picking.
  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role = 'warehouse'::public.user_role
  loop
    perform public.staff_insert_notification(
      v_recipient.id,
      'order_paid',
      'Заказ ' || coalesce(v_order.order_number, '') || ' оплачен',
      'Можно начинать сборку',
      'order',
      v_order.id,
      '/staff/warehouse/' || v_order.id::text,
      v_meta
    );
  end loop;

  -- Manager / admin: payment confirmed.
  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role in ('admin'::public.user_role, 'manager'::public.user_role)
  loop
    perform public.staff_insert_notification(
      v_recipient.id,
      'order_paid',
      'Оплата подтверждена',
      'Заказ ' || coalesce(v_order.order_number, '') || ' · ' || v_customer_label || ' · ' || v_amount_text,
      'order',
      v_order.id,
      '/staff/orders/' || v_order.id::text,
      v_meta
    );
  end loop;

  -- Client (optional confirmation; skipped for walk-in).
  v_client := public.client_resolve_order_recipient(v_order.id);
  if v_client is not null then
    perform public.client_insert_notification(
      v_client,
      'payment_confirmed',
      'Оплата по заказу ' || coalesce(v_order.order_number, '') || ' подтверждена',
      null,
      'order',
      v_order.id,
      '/orders/' || v_order.id::text,
      jsonb_build_object(
        'order_id', v_order.id,
        'order_number', v_order.order_number,
        'is_test', false
      )
    );
  end if;
end;
$$;

revoke all on function public.notify_order_paid(uuid)
  from public, anon, authenticated;

create or replace function public.notify_order_picking_started(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_client uuid;
begin
  if p_order_id is null then
    return;
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    return;
  end if;

  if coalesce(v_order.is_test, false) then
    return;
  end if;

  v_client := public.client_resolve_order_recipient(v_order.id);
  if v_client is null then
    return;
  end if;

  perform public.client_insert_notification(
    v_client,
    'order_picking',
    'Заказ ' || coalesce(v_order.order_number, '') || ' передан на сборку',
    'Мы начали комплектацию вашего заказа.',
    'order',
    v_order.id,
    '/orders/' || v_order.id::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'is_test', false
    )
  );
end;
$$;

revoke all on function public.notify_order_picking_started(uuid)
  from public, anon, authenticated;

create or replace function public.notify_order_ready(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_client uuid;
  v_recipient record;
  v_meta jsonb;
begin
  if p_order_id is null then
    return;
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    return;
  end if;

  if coalesce(v_order.is_test, false) then
    return;
  end if;

  v_meta := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'is_test', false
  );

  v_client := public.client_resolve_order_recipient(v_order.id);
  if v_client is not null then
    perform public.client_insert_notification(
      v_client,
      'order_ready',
      'Заказ ' || coalesce(v_order.order_number, '') || ' готов к отгрузке',
      'Ваш заказ собран и готов к выдаче/отгрузке.',
      'order',
      v_order.id,
      '/orders/' || v_order.id::text,
      v_meta
    );
  end if;

  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role in ('admin'::public.user_role, 'manager'::public.user_role)
  loop
    perform public.staff_insert_notification(
      v_recipient.id,
      'order_ready',
      'Заказ ' || coalesce(v_order.order_number, '') || ' готов к отгрузке',
      null,
      'order',
      v_order.id,
      '/staff/orders/' || v_order.id::text,
      v_meta
    );
  end loop;
end;
$$;

revoke all on function public.notify_order_ready(uuid)
  from public, anon, authenticated;

create or replace function public.notify_order_shipped(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_client uuid;
begin
  if p_order_id is null then
    return;
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    return;
  end if;

  if coalesce(v_order.is_test, false) then
    return;
  end if;

  v_client := public.client_resolve_order_recipient(v_order.id);
  if v_client is null then
    return;
  end if;

  perform public.client_insert_notification(
    v_client,
    'order_shipped',
    'Заказ ' || coalesce(v_order.order_number, '') || ' отгружен',
    'Заказ передан на отгрузку.',
    'order',
    v_order.id,
    '/orders/' || v_order.id::text,
    jsonb_build_object(
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'is_test', false
    )
  );
end;
$$;

revoke all on function public.notify_order_shipped(uuid)
  from public, anon, authenticated;

create or replace function public.notify_stock_received(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.stock_receipts%rowtype;
  v_sku text;
  v_qty_text text;
  v_message text;
  v_meta jsonb;
  v_recipient record;
begin
  if p_receipt_id is null then
    return;
  end if;

  select * into v_receipt
  from public.stock_receipts as r
  where r.id = p_receipt_id;

  if not found then
    return;
  end if;

  select p.sku into v_sku
  from public.products as p
  where p.id = v_receipt.product_id;

  v_qty_text := public.staff_format_notification_qty(v_receipt.quantity);
  v_message := coalesce(nullif(trim(v_sku), ''), 'Товар')
    || ' · +'
    || v_qty_text
    || ' шт';

  v_meta := jsonb_build_object(
    'receipt_id', v_receipt.id,
    'product_id', v_receipt.product_id,
    'product_sku', v_sku,
    'quantity', v_receipt.quantity,
    'warehouse_id', v_receipt.warehouse_id,
    'document_number', v_receipt.document_number
  );

  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role in ('warehouse'::public.user_role, 'admin'::public.user_role)
  loop
    perform public.staff_insert_notification(
      v_recipient.id,
      'stock_received',
      'Поступление товара',
      v_message,
      'stock_receipt',
      v_receipt.id,
      '/staff/products/' || v_receipt.product_id::text,
      v_meta
    );
  end loop;
end;
$$;

revoke all on function public.notify_stock_received(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 6. AFTER UPDATE OF status on orders (fail-soft)
--
-- Source of truth = successful status transition rows.
-- Covers staff_change_order_status + warehouse RPCs.
-- Notification never precedes the status UPDATE; if notify
-- raises, WARNING only — business txn still commits.
-- ============================================================

create or replace function public.orders_notify_workflow_after_status_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if OLD.status is not distinct from NEW.status then
    return NEW;
  end if;

  begin
    if OLD.status = 'awaiting_payment' and NEW.status = 'paid' then
      perform public.notify_order_paid(NEW.id);
    elsif OLD.status = 'paid' and NEW.status = 'picking' then
      perform public.notify_order_picking_started(NEW.id);
    elsif OLD.status = 'picking' and NEW.status = 'ready_for_shipment' then
      perform public.notify_order_ready(NEW.id);
    elsif OLD.status = 'ready_for_shipment' and NEW.status = 'shipped' then
      perform public.notify_order_shipped(NEW.id);
    end if;
    -- shipped → completed: intentionally no client notification (redundant
    -- after order_shipped; type order_completed reserved for a later decision).
  exception
    when others then
      raise warning
        'workflow notification failed for order % (% → %): %',
        NEW.id,
        OLD.status,
        NEW.status,
        SQLERRM;
  end;

  return NEW;
end;
$$;

revoke all on function public.orders_notify_workflow_after_status_update()
  from public, anon, authenticated;

drop trigger if exists orders_notify_workflow_after_status_update_trg on public.orders;
create trigger orders_notify_workflow_after_status_update_trg
  after update of status on public.orders
  for each row
  execute function public.orders_notify_workflow_after_status_update();

comment on function public.orders_notify_workflow_after_status_update() is
  'AFTER UPDATE OF status: fail-soft workflow notifications (paid/picking/ready/shipped).';

-- ============================================================
-- 7. staff_record_stock_receipt
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

  -- Manager intentionally excluded — corrections stay admin-only;
  -- receipts are warehouse + admin.
  if not public.has_staff_role(
    array['warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для оприходования товара';
  end if;
end;
$$;

revoke all on function public.staff_assert_stock_receipt_role()
  from public, anon, authenticated;

drop function if exists public.staff_record_stock_receipt(uuid, numeric, text, text);

create or replace function public.staff_record_stock_receipt(
  p_product_id uuid,
  p_quantity numeric,
  p_document_number text default null,
  p_reason text default null
)
returns table (
  receipt_id uuid,
  inventory_id uuid,
  product_id uuid,
  warehouse_id uuid,
  warehouse_code text,
  quantity numeric,
  reserved_quantity numeric,
  available_quantity numeric,
  received_quantity numeric,
  previous_quantity numeric,
  new_quantity numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_warehouse_id uuid;
  v_warehouse_code text;
  v_product public.products%rowtype;
  v_inv public.inventory%rowtype;
  v_qty numeric(14, 3);
  v_prev numeric(14, 3);
  v_new numeric(14, 3);
  v_doc text := nullif(trim(coalesce(p_document_number, '')), '');
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_receipt public.stock_receipts%rowtype;
begin
  perform public.staff_assert_stock_receipt_role();

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество поступления должно быть больше 0';
  end if;

  -- numeric(14,3) scale; reject absurd / non-finite values early.
  if p_quantity <> p_quantity then
    raise exception 'Количество поступления должно быть конечным числом';
  end if;

  if p_quantity > 1000000000 then
    raise exception 'Количество поступления слишком большое (макс. 1 000 000 000)';
  end if;

  if v_doc is not null and char_length(v_doc) > 100 then
    raise exception 'Номер документа не длиннее 100 символов';
  end if;

  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'Причина не длиннее 500 символов';
  end if;

  v_qty := p_quantity;
  v_warehouse_id := public.staff_resolve_warehouse_id();

  select w.code into v_warehouse_code
  from public.warehouses as w
  where w.id = v_warehouse_id;

  select * into v_product
  from public.products as p
  where p.id = p_product_id
  for update;

  if not found then
    raise exception 'Товар не найден';
  end if;

  select * into v_inv
  from public.inventory as i
  where i.product_id = p_product_id
    and i.warehouse_id = v_warehouse_id
  for update;

  if not found then
    insert into public.inventory (
      product_id,
      warehouse_id,
      quantity,
      reserved_quantity
    ) values (
      p_product_id,
      v_warehouse_id,
      0,
      0
    )
    returning * into v_inv;

    select * into v_inv
    from public.inventory as i
    where i.id = v_inv.id
    for update;
  end if;

  v_prev := v_inv.quantity;
  v_new := v_prev + v_qty;

  -- Physical stock only — reserved_quantity is intentionally untouched.
  if v_new > 99999999999.999 then
    raise exception 'Итоговый остаток превысит допустимый предел numeric(14,3)';
  end if;

  update public.inventory as i
  set
    quantity = v_new,
    updated_at = now()
  where i.id = v_inv.id
  returning * into v_inv;

  insert into public.stock_receipts (
    product_id,
    warehouse_id,
    inventory_id,
    quantity,
    previous_quantity,
    new_quantity,
    document_number,
    reason,
    created_by,
    metadata
  ) values (
    p_product_id,
    v_warehouse_id,
    v_inv.id,
    v_qty,
    v_prev,
    v_new,
    v_doc,
    v_reason,
    v_uid,
    jsonb_build_object(
      'source', 'staff_record_stock_receipt',
      'product_sku', v_product.sku
    )
  )
  returning * into v_receipt;

  -- Fail-soft notification AFTER successful receipt.
  begin
    perform public.notify_stock_received(v_receipt.id);
  exception
    when others then
      raise warning
        'notify_stock_received failed for receipt %: %',
        v_receipt.id,
        SQLERRM;
  end;

  return query
  select
    v_receipt.id,
    v_inv.id,
    v_inv.product_id,
    v_inv.warehouse_id,
    v_warehouse_code,
    v_inv.quantity,
    v_inv.reserved_quantity,
    greatest(v_inv.quantity - v_inv.reserved_quantity, 0),
    v_qty,
    v_prev,
    v_new;
end;
$$;

revoke all on function public.staff_record_stock_receipt(uuid, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.staff_record_stock_receipt(uuid, numeric, text, text)
  to authenticated;

comment on function public.staff_record_stock_receipt(uuid, numeric, text, text) is
  'Warehouse/admin: explicit stock receipt (+qty). Locks inventory row; does not touch reserved_quantity or staff_adjust_product_inventory. Each successful call creates a new stock_receipts row (not idempotent — intentional for real arrivals). Fail-soft stock_received uses entity_id=receipt.id.';

drop function if exists public.staff_list_product_stock_receipts(uuid, integer);

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
    array['manager', 'warehouse', 'admin']::public.user_role[]
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

-- ============================================================
-- 8. Client notification RPCs (recipient always = auth.uid())
-- ============================================================

create or replace function public.client_list_notifications(
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
  from public.client_notifications as n
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

revoke all on function public.client_list_notifications(integer, boolean, integer)
  from public, anon, authenticated;
grant execute on function public.client_list_notifications(integer, boolean, integer)
  to authenticated;

create or replace function public.client_get_unread_notification_count()
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

  select count(*)::integer into v_count
  from public.client_notifications as n
  where n.recipient_profile_id = v_uid
    and n.read_at is null;

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.client_get_unread_notification_count()
  from public, anon, authenticated;
grant execute on function public.client_get_unread_notification_count()
  to authenticated;

create or replace function public.client_mark_notification_read(p_notification_id uuid)
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

  if p_notification_id is null then
    raise exception 'Не указано уведомление';
  end if;

  update public.client_notifications as n
  set read_at = coalesce(n.read_at, now())
  where n.id = p_notification_id
    and n.recipient_profile_id = v_uid;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.client_mark_notification_read(uuid)
  from public, anon, authenticated;
grant execute on function public.client_mark_notification_read(uuid)
  to authenticated;

create or replace function public.client_mark_all_notifications_read()
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

  update public.client_notifications as n
  set read_at = now()
  where n.recipient_profile_id = v_uid
    and n.read_at is null;

  get diagnostics v_updated = row_count;
  return coalesce(v_updated, 0);
end;
$$;

revoke all on function public.client_mark_all_notifications_read()
  from public, anon, authenticated;
grant execute on function public.client_mark_all_notifications_read()
  to authenticated;

-- ============================================================
-- 9. admin_get_data_usage — + client_notifications + stock_receipts
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
        'staff_notifications','client_notifications','stock_receipts'
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
    'staff_notifications', (select count(*)::integer from public.staff_notifications),
    'client_notifications', (select count(*)::integer from public.client_notifications),
    'stock_receipts', (select count(*)::integer from public.stock_receipts)
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
-- Transition sources (AFTER UPDATE OF status):
--   awaiting_payment → paid              → notify_order_paid
--   paid → picking                       → notify_order_picking_started
--   picking → ready_for_shipment         → notify_order_ready
--   ready_for_shipment → shipped         → notify_order_shipped
--
-- Paths covered: staff_change_order_status + staff_start/complete/
-- ship warehouse RPCs (all flip orders.status).
--
-- Fail-soft: notify exception → WARNING; order/receipt commits.
-- Atomic opposite: business RPC failure → notify rows roll back.
--
-- Idempotency: unique (recipient, type, entity_type, entity_id).
-- Order milestones: entity_id = order.id (one notify per milestone).
-- Stock receipt: entity_id = stock_receipts.id (J01 +100 then +200 → two notifies).
-- is_test=true → no production workflow notifications.
-- Walk-in (no client profile) → staff still notified; client skipped.
-- Correction via staff_adjust_product_inventory → NOT stock_received.
-- Receipt RPC is intentionally non-idempotent: retry/double-submit adds stock again.
-- ============================================================
