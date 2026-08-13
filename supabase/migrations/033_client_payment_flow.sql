-- ============================================================
-- 033_client_payment_flow.sql
-- Stage 33 — Client Payment UX + Permanent Kaspi QR + Manager Payment Confirmation
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–032 / 032b files.
--
-- Purpose:
--   1. Permanent company Kaspi QR as a live organization-assets image
--      (not a payment integration, not per-order, not base64 in DB).
--   2. Client payment claim (order_payment_claims) — "Я оплатил" is NOT
--      authoritative payment and does NOT set orders.status = paid.
--   3. Staff notification payment_claimed via existing Staff Notification
--      Center (029/030). Warehouse is never a recipient.
--   4. Fail-soft auto invoice after client create_order (deferred trigger).
--      Same transaction, just before COMMIT — not after commit.
--      Order INSERT is not rolled back because invoice errors are caught.
--   5. staff_confirm_order_payment — one manager/admin action:
--      record via 022 helpers, then paid transition if remaining <= tolerance.
--      Stage 30 fires only through the real status UPDATE.
--
-- Explicitly NOT done here:
--   - Kaspi API / dynamic QR / webhooks / auto-paid;
--   - QR inside invoice PDF;
--   - second money ledger;
--   - accountant-only workflow;
--   - warehouse payment confirmation;
--   - changing staff_record_order_payment role grants (manager/accountant/admin).
-- ============================================================

do $$
begin
  if to_regclass('public.organization_settings') is null then
    raise exception 'organization_settings missing — run 014/016 first.';
  end if;
  if to_regclass('public.order_payments') is null then
    raise exception 'order_payments missing — run 022 first.';
  end if;
  if to_regclass('public.staff_notifications') is null then
    raise exception 'staff_notifications missing — run 029 first.';
  end if;
  if to_regprocedure('public.staff_record_order_payment(uuid, numeric, date, text, text, text)') is null then
    raise exception 'staff_record_order_payment missing — run 022 first.';
  end if;
  if to_regprocedure('public.staff_insert_notification(uuid, text, text, text, text, uuid, text, jsonb)') is null then
    raise exception 'staff_insert_notification missing — run 030 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010 first.';
  end if;
  if to_regprocedure(
    'public.staff_build_document_metadata(uuid, text, text, text, text, text, text, text, date)'
  ) is null then
    raise exception 'staff_build_document_metadata (023 signature) missing — run 023 first.';
  end if;
  if to_regprocedure('public.staff_change_order_status(uuid, text, text)') is null then
    raise exception 'staff_change_order_status missing — run 022 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Permanent Kaspi QR — organization_settings path only (no image bytes)
-- ============================================================

alter table public.organization_settings
  add column if not exists kaspi_qr_path text;

comment on column public.organization_settings.kaspi_qr_path is
  'Private Storage path for the company-wide Kaspi QR (organization/kaspi_qr.{png|jpg|jpeg|webp}). Not a payment integration and not per-order.';

alter table public.organization_settings
  drop constraint if exists organization_settings_kaspi_qr_path_check;
alter table public.organization_settings
  add constraint organization_settings_kaspi_qr_path_check check (
    kaspi_qr_path is null
    or kaspi_qr_path ~ '^organization/kaspi_qr\.(png|jpe?g|webp)$'
  );

create or replace function public.staff_is_org_live_asset_path(p_path text, p_kind text)
returns boolean
language sql
immutable
as $$
  select
    p_path is not null
    and p_kind in ('logo', 'stamp', 'signature', 'kaspi_qr')
    and p_path ~ (
      '^organization/' || p_kind || '\.(png|jpe?g|webp)$'
    );
$$;

revoke all on function public.staff_is_org_live_asset_path(text, text)
  from public, anon, authenticated;

create or replace function public.staff_can_read_organization_asset(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if p_name is null or p_name = '' then
    return false;
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    return false;
  end if;

  if p_name ~ '^organization/(logo|stamp|signature|kaspi_qr)\.(png|jpe?g|webp)$' then
    return true;
  end if;

  if exists (
    select 1
    from public.document_asset_snapshot_intents as i
    where i.created_by = auth.uid()
      and i.status = 'pending'
      and i.expires_at > now()
      and p_name in (i.logo_path, i.stamp_path, i.signature_path)
  ) then
    return true;
  end if;

  if exists (
    select 1
    from public.order_documents as d
    where d.metadata #>> '{supplier,logo_path}' = p_name
       or d.metadata #>> '{supplier,stamp_path}' = p_name
       or d.metadata #>> '{supplier,signature_path}' = p_name
  ) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.staff_can_read_organization_asset(text)
  from public, anon, authenticated;
grant execute on function public.staff_can_read_organization_asset(text) to authenticated;

-- Client may read ONLY the live Kaspi QR currently stored in settings.
-- Logo/stamp/signature live paths stay staff-only (021 snapshot policy unchanged).
create or replace function public.client_can_read_kaspi_qr_asset(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_name is null or p_name = '' then
    return false;
  end if;

  if p_name !~ '^organization/kaspi_qr\.(png|jpe?g|webp)$' then
    return false;
  end if;

  if not exists (
    select 1
    from public.profiles as p
    where p.id = v_uid
      and p.is_active = true
      and p.role = 'client'::public.user_role
  ) then
    return false;
  end if;

  return exists (
    select 1
    from public.organization_settings as s
    where s.singleton_key = 'default'
      and s.kaspi_qr_path is not null
      and s.kaspi_qr_path = p_name
  );
end;
$$;

revoke all on function public.client_can_read_kaspi_qr_asset(text)
  from public, anon, authenticated;
grant execute on function public.client_can_read_kaspi_qr_asset(text) to authenticated;

drop policy if exists organization_assets_select_client_kaspi_qr on storage.objects;
create policy organization_assets_select_client_kaspi_qr
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'organization-assets'
    and public.client_can_read_kaspi_qr_asset(name)
  );

-- Recreate admin live write policies to include kaspi_qr (admin only).
drop policy if exists organization_assets_insert_admin_live on storage.objects;
drop policy if exists organization_assets_update_admin_live on storage.objects;
drop policy if exists organization_assets_delete_admin_live on storage.objects;

create policy organization_assets_insert_admin_live
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'organization-assets'
    and (select public.has_staff_role(array['admin']::public.user_role[]))
    and (
      name ~ '^organization/logo\.(png|jpe?g|webp)$'
      or name ~ '^organization/stamp\.(png|jpe?g|webp)$'
      or name ~ '^organization/signature\.(png|jpe?g|webp)$'
      or name ~ '^organization/kaspi_qr\.(png|jpe?g|webp)$'
    )
  );

create policy organization_assets_update_admin_live
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'organization-assets'
    and (select public.has_staff_role(array['admin']::public.user_role[]))
    and (
      name ~ '^organization/logo\.(png|jpe?g|webp)$'
      or name ~ '^organization/stamp\.(png|jpe?g|webp)$'
      or name ~ '^organization/signature\.(png|jpe?g|webp)$'
      or name ~ '^organization/kaspi_qr\.(png|jpe?g|webp)$'
    )
  )
  with check (
    bucket_id = 'organization-assets'
    and (select public.has_staff_role(array['admin']::public.user_role[]))
    and (
      name ~ '^organization/logo\.(png|jpe?g|webp)$'
      or name ~ '^organization/stamp\.(png|jpe?g|webp)$'
      or name ~ '^organization/signature\.(png|jpe?g|webp)$'
      or name ~ '^organization/kaspi_qr\.(png|jpe?g|webp)$'
    )
  );

create policy organization_assets_delete_admin_live
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'organization-assets'
    and (select public.has_staff_role(array['admin']::public.user_role[]))
    and (
      name ~ '^organization/logo\.(png|jpe?g|webp)$'
      or name ~ '^organization/stamp\.(png|jpe?g|webp)$'
      or name ~ '^organization/signature\.(png|jpe?g|webp)$'
      or name ~ '^organization/kaspi_qr\.(png|jpe?g|webp)$'
    )
  );

create or replace function public.staff_set_organization_asset_path(
  p_kind text,
  p_path text
)
returns public.organization_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organization_settings;
  v_kind text := lower(trim(p_kind));
  v_path text := public.staff_normalize_optional_text(p_path);
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения изображений организации';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if v_kind not in ('logo', 'stamp', 'signature', 'kaspi_qr') then
    raise exception 'kind должен быть logo, stamp, signature или kaspi_qr';
  end if;

  if v_path is not null and not public.staff_is_org_live_asset_path(v_path, v_kind) then
    raise exception 'path должен быть organization/%.(png|jpg|jpeg|webp)', v_kind;
  end if;

  update public.organization_settings as s
  set
    logo_path = case when v_kind = 'logo' then v_path else s.logo_path end,
    stamp_path = case when v_kind = 'stamp' then v_path else s.stamp_path end,
    signature_path = case when v_kind = 'signature' then v_path else s.signature_path end,
    kaspi_qr_path = case when v_kind = 'kaspi_qr' then v_path else s.kaspi_qr_path end,
    updated_by = v_uid
  where s.singleton_key = 'default'
  returning * into v_org;

  if not found then
    raise exception 'organization_settings не найдена';
  end if;

  return v_org;
end;
$$;

revoke all on function public.staff_set_organization_asset_path(text, text)
  from public, anon, authenticated;
grant execute on function public.staff_set_organization_asset_path(text, text)
  to authenticated;

-- ============================================================
-- 2. order_payment_claims — client report, not a money ledger
-- ============================================================

create table if not exists public.order_payment_claims (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  customer_profile_id uuid not null references public.profiles (id) on delete restrict,
  status text not null default 'reported',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  confirmed_payment_id uuid references public.order_payments (id) on delete set null,
  constraint order_payment_claims_status_check check (
    status in ('reported', 'confirmed')
  ),
  constraint order_payment_claims_confirmed_fields check (
    (status = 'reported' and resolved_at is null and resolved_by is null and confirmed_payment_id is null)
    or (status = 'confirmed' and resolved_at is not null)
  )
);

comment on table public.order_payment_claims is
  'Client "I paid" report. Not authoritative money. Confirmation is staff_confirm_order_payment (033) → staff_record_order_payment (022).';

comment on column public.order_payment_claims.customer_profile_id is
  'Server-derived auth.uid() of the order owner. Never taken from the browser.';

comment on column public.order_payment_claims.confirmed_payment_id is
  'Set when an authoritative order_payments row is recorded for this order.';

create unique index if not exists order_payment_claims_one_reported_idx
  on public.order_payment_claims (order_id)
  where status = 'reported';

create index if not exists order_payment_claims_order_id_created_idx
  on public.order_payment_claims (order_id, created_at desc);

alter table public.order_payment_claims enable row level security;
revoke all on table public.order_payment_claims from public;
revoke all on table public.order_payment_claims from anon;
revoke all on table public.order_payment_claims from authenticated;

-- Resolve open claim when staff records an authoritative payment (022 ledger).
create or replace function public.order_payment_claims_on_payment_recorded()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and new.status = 'confirmed' then
    update public.order_payment_claims as c
    set
      status = 'confirmed',
      resolved_at = now(),
      resolved_by = new.recorded_by,
      confirmed_payment_id = new.id
    where c.order_id = new.order_id
      and c.status = 'reported';
  end if;
  return new;
end;
$$;

revoke all on function public.order_payment_claims_on_payment_recorded()
  from public, anon, authenticated;

drop trigger if exists order_payment_claims_on_payment_recorded on public.order_payments;
create trigger order_payment_claims_on_payment_recorded
  after insert on public.order_payments
  for each row
  execute function public.order_payment_claims_on_payment_recorded();

-- ============================================================
-- 3. Activity log — payment_claimed
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
      'invoice_generation_failed'
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
       'invoice_generation_failed'
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

-- ============================================================
-- 4. Staff notification type payment_claimed (existing inbox)
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
      'stock_received',
      'payment_claimed',
      'invoice_generation_failed'
    )
  );

-- One inbox row per recipient per claim (entity_id = claim id).
-- Repeat "Я оплатил" does not insert a new claim, so no duplicate notify.
create unique index if not exists staff_notifications_payment_claimed_unique
  on public.staff_notifications (
    recipient_profile_id,
    notification_type,
    entity_type,
    entity_id
  )
  where notification_type = 'payment_claimed'
    and entity_type = 'order_payment_claim'
    and entity_id is not null;

create unique index if not exists staff_notifications_invoice_failed_unique
  on public.staff_notifications (
    recipient_profile_id,
    notification_type,
    entity_type,
    entity_id
  )
  where notification_type = 'invoice_generation_failed'
    and entity_type = 'order'
    and entity_id is not null;

create or replace function public.staff_notify_payment_claimed(
  p_order_id uuid,
  p_claim_id uuid
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
  v_amount numeric(14, 2);
  v_paid numeric(14, 2);
  v_remaining numeric(14, 2);
  v_amount_text text;
  v_title text;
  v_message text;
  v_action_url text;
  v_metadata jsonb;
  v_recipient record;
  v_assigned uuid;
  v_assigned_ok boolean := false;
begin
  if p_order_id is null or p_claim_id is null then
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

  v_amount := public.staff_resolve_order_amount_due(p_order_id);
  v_paid := public.staff_sum_confirmed_order_payments(p_order_id);
  v_remaining := v_amount - v_paid;
  if v_remaining < 0 then
    v_remaining := 0;
  end if;

  v_amount_text := public.staff_format_notification_amount(
    case when v_remaining > 0 then v_remaining else v_amount end
  );
  v_title := 'Клиент сообщил об оплате заказа ' || coalesce(v_order.order_number, '');
  v_message := v_customer_label || ' · К оплате: ' || v_amount_text;
  v_action_url := '/staff/orders/' || v_order.id::text;
  v_metadata := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'claim_id', p_claim_id,
    'amount_due', v_amount,
    'amount_remaining', v_remaining,
    'customer_id', v_order.customer_id,
    'customer_label', v_customer_label,
    'is_test', false
  );

  v_assigned := v_order.assigned_manager_id;
  if v_assigned is not null then
    if exists (
      select 1
      from public.profiles as p
      where p.id = v_assigned
        and p.is_active = true
        and p.role in ('manager'::public.user_role, 'admin'::public.user_role)
    ) then
      v_assigned_ok := true;
      perform public.staff_insert_notification(
        v_assigned,
        'payment_claimed',
        v_title,
        v_message,
        'order_payment_claim',
        p_claim_id,
        v_action_url,
        v_metadata
      );
    end if;
  end if;

  if v_assigned_ok then
    return;
  end if;

  -- No assigned manager (or assignee inactive / not manager|admin):
  -- active managers + admin. Never warehouse / accountant.
  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role in ('admin'::public.user_role, 'manager'::public.user_role)
  loop
    perform public.staff_insert_notification(
      v_recipient.id,
      'payment_claimed',
      v_title,
      v_message,
      'order_payment_claim',
      p_claim_id,
      v_action_url,
      v_metadata
    );
  end loop;
end;
$$;

revoke all on function public.staff_notify_payment_claimed(uuid, uuid)
  from public, anon, authenticated;

comment on function public.staff_notify_payment_claimed(uuid, uuid) is
  'Internal: notify assigned manager, else active managers+admin. No GRANT. Skips test orders. Never warehouse.';

-- ============================================================
-- 5. Client RPCs — ownership via orders.user_id = auth.uid()
-- ============================================================

create or replace function public.client_get_order_payment_flow(p_order_id uuid)
returns table (
  amount_due numeric,
  amount_paid numeric,
  amount_remaining numeric,
  payment_status text,
  invoice_id uuid,
  invoice_number text,
  kaspi_qr_path text,
  claim_id uuid,
  claim_status text,
  claim_created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_inv_id uuid;
  v_inv text;
  v_qr text;
  v_claim public.order_payment_claims;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
    and o.user_id = v_uid;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  v_due := public.staff_resolve_order_amount_due(p_order_id);
  v_paid := public.staff_sum_confirmed_order_payments(p_order_id);

  select d.id, d.number into v_inv_id, v_inv
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = 'invoice'
    and d.status = 'generated'
  order by d.generated_at desc
  limit 1;

  if v_inv is null then
    select o.source_number into v_inv
    from public.order_payment_obligations as o
    where o.order_id = p_order_id
      and o.source_type = 'invoice';
  end if;

  select s.kaspi_qr_path into v_qr
  from public.organization_settings as s
  where s.singleton_key = 'default';

  if v_qr is not null
     and v_qr !~ '^organization/kaspi_qr\.(png|jpe?g|webp)$' then
    v_qr := null;
  end if;

  select * into v_claim
  from public.order_payment_claims as c
  where c.order_id = p_order_id
  order by
    case when c.status = 'reported' then 0 else 1 end,
    c.created_at desc
  limit 1;

  return query
  select
    v_due,
    v_paid,
    (v_due - v_paid)::numeric(14, 2),
    public.staff_derive_payment_status(v_due, v_paid),
    v_inv_id,
    v_inv,
    v_qr,
    v_claim.id,
    v_claim.status,
    v_claim.created_at;
end;
$$;

revoke all on function public.client_get_order_payment_flow(uuid)
  from public, anon, authenticated;
grant execute on function public.client_get_order_payment_flow(uuid)
  to authenticated;

create or replace function public.client_report_order_payment(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  status text,
  created_at timestamptz,
  already_reported boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_remaining numeric(14, 2);
  v_claim public.order_payment_claims;
  v_already boolean := false;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  -- Ownership: only the client account on the order. Walk-in (user_id null) denied.
  select * into v_order
  from public.orders as o
  where o.id = p_order_id
    and o.user_id = v_uid
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Нельзя сообщить об оплате по отменённому заказу';
  end if;

  if coalesce(v_order.is_test, false) then
    raise exception 'Для тестового заказа сообщение об оплате не создаётся';
  end if;

  if v_order.status is distinct from 'awaiting_payment' then
    raise exception
      'Сообщить об оплате можно только для заказа в статусе «Ожидает оплаты»';
  end if;

  v_due := public.staff_resolve_order_amount_due(p_order_id);
  v_paid := public.staff_sum_confirmed_order_payments(p_order_id);
  v_remaining := v_due - v_paid;

  if v_remaining <= 0 then
    raise exception 'Заказ уже оплачен';
  end if;

  select * into v_claim
  from public.order_payment_claims as c
  where c.order_id = p_order_id
    and c.status = 'reported'
  for update;

  if found then
    v_already := true;
  else
    insert into public.order_payment_claims (
      order_id,
      customer_profile_id,
      status
    ) values (
      p_order_id,
      v_uid,
      'reported'
    )
    on conflict (order_id) where status = 'reported'
    do nothing
    returning * into v_claim;

    if v_claim.id is null then
      select * into v_claim
      from public.order_payment_claims as c
      where c.order_id = p_order_id
        and c.status = 'reported';
      v_already := true;
    end if;
  end if;

  if not v_already then
    perform public.staff_record_order_activity(
      p_order_id,
      'payment_claimed',
      'Клиент сообщил об оплате',
      jsonb_build_object(
        'claim_id', v_claim.id,
        'amount_due', v_due,
        'amount_paid', v_paid,
        'amount_remaining', v_remaining
      )
    );

    perform public.staff_notify_payment_claimed(p_order_id, v_claim.id);
  end if;

  return query
  select
    v_claim.id,
    v_claim.order_id,
    v_claim.status,
    v_claim.created_at,
    v_already;
end;
$$;

revoke all on function public.client_report_order_payment(uuid)
  from public, anon, authenticated;
grant execute on function public.client_report_order_payment(uuid)
  to authenticated;

-- ============================================================
-- 6. Staff claim read (manager / accountant / admin — same as 022 payments)
-- ============================================================

create or replace function public.staff_get_order_payment_claim(p_order_id uuid)
returns table (
  claim_id uuid,
  status text,
  created_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid,
  resolved_by_name text,
  confirmed_payment_id uuid,
  kaspi_qr_path text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claim public.order_payment_claims;
  v_name text;
  v_qr text;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра оплаты';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  select s.kaspi_qr_path into v_qr
  from public.organization_settings as s
  where s.singleton_key = 'default';

  if v_qr is not null
     and v_qr !~ '^organization/kaspi_qr\.(png|jpe?g|webp)$' then
    v_qr := null;
  end if;

  select * into v_claim
  from public.order_payment_claims as c
  where c.order_id = p_order_id
  order by
    case when c.status = 'reported' then 0 else 1 end,
    c.created_at desc
  limit 1;

  if v_claim.id is null then
    return query
    select
      null::uuid,
      null::text,
      null::timestamptz,
      null::timestamptz,
      null::uuid,
      null::text,
      null::uuid,
      v_qr;
    return;
  end if;

  if v_claim.resolved_by is not null then
    select nullif(trim(p.full_name), '')
    into v_name
    from public.profiles as p
    where p.id = v_claim.resolved_by;
  end if;

  return query
  select
    v_claim.id,
    v_claim.status,
    v_claim.created_at,
    v_claim.resolved_at,
    v_claim.resolved_by,
    v_name,
    v_claim.confirmed_payment_id,
    v_qr;
end;
$$;

revoke all on function public.staff_get_order_payment_claim(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_order_payment_claim(uuid)
  to authenticated;

-- ============================================================
-- 7. Data lifecycle — counts + storage refs (kaspi_qr_path)
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
        'orders','order_items','order_payments','order_payment_claims','order_documents',
        'products','categories','customers','profiles',
        'analytics_events','analytics_sessions',
        'analytics_aggregates_daily','analytics_aggregates_weekly','analytics_aggregates_monthly',
        'inventory','data_archives','document_asset_snapshot_intents','product_images',
        'price_groups','product_prices','customer_product_prices','company_product_prices',
        'staff_notifications','client_notifications','stock_receipts',
        'inventory_reconciliations','inventory_reconciliation_items'
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
    'payment_claims', (select count(*)::integer from public.order_payment_claims),
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
    'stock_receipts', (select count(*)::integer from public.stock_receipts),
    'inventory_reconciliations', (select count(*)::integer from public.inventory_reconciliations),
    'inventory_reconciliation_items', (select count(*)::integer from public.inventory_reconciliation_items)
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
    'logo_path', s.logo_path,
    'stamp_path', s.stamp_path,
    'signature_path', s.signature_path,
    'kaspi_qr_path', s.kaspi_qr_path
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

-- ============================================================
-- 8. Fail-soft auto invoice after client create_order
--
-- Architecture:
--   CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED on orders INSERT.
--   Fires at the end of the create_order transaction, just before COMMIT
--   (PostgreSQL deferred constraint trigger — not AFTER COMMIT).
--   By then order_items from the same RPC are visible.
--   Client create_order has items + user_id → auto invoice.
--   Staff shells (0 items) and walk-in (user_id null) keep controlled flow.
--   Exceptions are caught inside the trigger/function: an invoice failure
--   does not abort the order transaction.
--   Logo/stamp/signature snapshots cannot be copied from SQL (Storage bytes
--   are not in PostgreSQL). Auto invoice stores null image paths. Legal
--   buyer/seller/payment_profile/totals still come from existing builders.
--   Staff manual generate (browser snapshot copy) is unchanged.
-- ============================================================

create or replace function public.staff_notify_invoice_generation_failed(
  p_order_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_title text;
  v_message text;
  v_action_url text;
  v_metadata jsonb;
  v_err text;
  v_recipient record;
  v_assigned uuid;
  v_assigned_ok boolean := false;
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

  v_err := nullif(trim(coalesce(p_error, '')), '');
  v_title := 'Не удалось сформировать счёт — заказ ' || coalesce(v_order.order_number, '');
  v_message := coalesce(v_err, 'Неизвестная ошибка');
  v_action_url := '/staff/orders/' || v_order.id::text;
  v_metadata := jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'error', v_message,
    'is_test', false
  );

  v_assigned := v_order.assigned_manager_id;
  if v_assigned is not null then
    if exists (
      select 1
      from public.profiles as p
      where p.id = v_assigned
        and p.is_active = true
        and p.role in ('manager'::public.user_role, 'admin'::public.user_role)
    ) then
      v_assigned_ok := true;
      perform public.staff_insert_notification(
        v_assigned,
        'invoice_generation_failed',
        v_title,
        v_message,
        'order',
        v_order.id,
        v_action_url,
        v_metadata
      );
    end if;
  end if;

  if v_assigned_ok then
    return;
  end if;

  for v_recipient in
    select p.id
    from public.profiles as p
    where p.is_active = true
      and p.role in ('admin'::public.user_role, 'manager'::public.user_role)
  loop
    perform public.staff_insert_notification(
      v_recipient.id,
      'invoice_generation_failed',
      v_title,
      v_message,
      'order',
      v_order.id,
      v_action_url,
      v_metadata
    );
  end loop;
end;
$$;

revoke all on function public.staff_notify_invoice_generation_failed(uuid, text)
  from public, anon, authenticated;

create or replace function public.try_auto_issue_client_order_invoice(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_org public.organization_settings;
  v_items_count integer;
  v_existing uuid;
  v_number text;
  v_metadata jsonb;
  v_doc public.order_documents;
  v_uid uuid := auth.uid();
  v_generated_by uuid;
  v_tax_mode text;
  v_err text;
begin
  if p_order_id is null then
    return;
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    return;
  end if;

  if v_order.status is distinct from 'new' then
    return;
  end if;

  -- Walk-in / no client account: not a client checkout.
  -- Staff empty shells (staff_create_order*) have 0 items when the
  -- deferred trigger runs (end of the same transaction) → skip.
  if v_order.user_id is null then
    return;
  end if;

  select count(*) into v_items_count
  from public.order_items as oi
  where oi.order_id = p_order_id;

  if v_items_count = 0 then
    return;
  end if;

  select d.id into v_existing
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = 'invoice';

  if v_existing is null then
    begin
      v_org := public.staff_require_organization_settings();
      v_tax_mode := coalesce(nullif(trim(v_org.default_tax_mode), ''), 'without_vat');
      v_generated_by := coalesce(v_order.user_id, v_order.profile_id, v_uid);

      if v_generated_by is null then
        raise exception 'Нет профиля для generated_by';
      end if;

      perform public.staff_assert_active_reservations_consistent(p_order_id);

      v_number := public.staff_document_number_from_order(v_order.order_number, 'invoice');
      v_metadata := public.staff_build_document_metadata(
        p_order_id,
        'invoice',
        v_number,
        v_tax_mode,
        null,
        null,
        null,
        null,
        null
      );

      perform public.staff_assert_invoice_matches_frozen_obligation(
        p_order_id,
        (v_metadata -> 'totals' ->> 'final_total')::numeric
      );

      insert into public.order_documents (
        order_id,
        document_type,
        number,
        status,
        file_path,
        generated_by,
        generated_at,
        metadata
      ) values (
        p_order_id,
        'invoice',
        v_number,
        'generated',
        null,
        v_generated_by,
        now(),
        v_metadata
      )
      returning * into v_doc;
    exception
      when unique_violation then
        null;
      when others then
        v_err := sqlerrm;
        begin
          perform public.staff_notify_invoice_generation_failed(p_order_id, v_err);
          if v_uid is not null then
            perform public.staff_record_order_activity(
              p_order_id,
              'invoice_generation_failed',
              'Не удалось сформировать счёт — ' || v_err,
              jsonb_build_object('error', v_err)
            );
          end if;
        exception
          when others then
            null;
        end;
        return;
    end;
  end if;

  if not exists (
    select 1
    from public.order_documents as d
    where d.order_id = p_order_id
      and d.document_type = 'invoice'
      and d.status = 'generated'
  ) then
    return;
  end if;

  begin
    perform public.staff_assert_active_reservations_consistent(p_order_id);

    if not public.staff_is_status_transition_allowed('new', 'awaiting_payment') then
      raise exception 'Переход new → awaiting_payment запрещён';
    end if;

    update public.orders as o
    set status = 'awaiting_payment'
    where o.id = p_order_id
      and o.status = 'new';

    if found then
      perform public.staff_record_order_status_change(
        p_order_id, 'new', 'awaiting_payment', 'Автоматически после формирования счёта'
      );
    end if;
  exception
    when others then
      v_err := sqlerrm;
      begin
        perform public.staff_notify_invoice_generation_failed(
          p_order_id,
          'Счёт создан, но заказ не переведён в «Ожидает оплаты»: ' || v_err
        );
      exception
        when others then
          null;
      end;
  end;
end;
$$;

revoke all on function public.try_auto_issue_client_order_invoice(uuid)
  from public, anon, authenticated;

create or replace function public.orders_try_auto_invoice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform public.try_auto_issue_client_order_invoice(new.id);
  exception
    when others then
      null;
  end;
  return new;
end;
$$;

revoke all on function public.orders_try_auto_invoice()
  from public, anon, authenticated;

drop trigger if exists orders_try_auto_invoice_trg on public.orders;
create constraint trigger orders_try_auto_invoice_trg
  after insert on public.orders
  deferrable initially deferred
  for each row
  execute function public.orders_try_auto_invoice();

-- ============================================================
-- 9. One-action manager/admin confirmation
--    Atomic: payment + optional paid transition in one transaction.
--    If paid gate fails after a full payment, the whole RPC rolls back
--    (no orphan ledger row, error is visible).
--    Partials: record only, status stays awaiting_payment.
--    Claim resolve: existing AFTER INSERT trigger on order_payments.
--    Stage 30: only via staff_change_order_status → UPDATE orders.status.
-- ============================================================

create or replace function public.staff_confirm_order_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_reference_number text default null,
  p_comment text default null
)
returns table (
  payment_id uuid,
  amount numeric,
  amount_remaining numeric,
  payment_status text,
  order_status text,
  transitioned_to_paid boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_payment public.order_payments;
  v_method text;
  v_comment text;
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_remaining numeric(14, 2);
  v_tol numeric(14, 2) := public.staff_payment_rounding_tolerance();
  v_transitioned boolean := false;
  v_status text;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для подтверждения оплаты';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  v_method := lower(trim(coalesce(p_payment_method, '')));
  -- 022 ledger whitelist. Kaspi is a UI method stored as other + comment.
  -- Prefix fits in the 1000-char 022 comment limit ('Kaspi. ' = 7).
  if v_method = 'kaspi' then
    v_comment := public.staff_sanitize_payment_text(p_comment, 'Комментарий', 993);
    v_comment := nullif(trim('Kaspi. ' || coalesce(v_comment, '')), '');
    v_method := 'other';
  else
    v_comment := p_comment;
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status is distinct from 'awaiting_payment' then
    raise exception
      'Подтвердить оплату можно только для заказа в статусе «Ожидает оплаты»';
  end if;

  v_payment := public.staff_record_order_payment(
    p_order_id,
    p_amount,
    p_payment_date,
    v_method,
    p_reference_number,
    v_comment
  );

  v_due := public.staff_resolve_order_amount_due(p_order_id);
  v_paid := public.staff_sum_confirmed_order_payments(p_order_id);
  v_remaining := v_due - v_paid;

  select o.status into v_status
  from public.orders as o
  where o.id = p_order_id;

  if v_status = 'awaiting_payment'
     and v_due > 0
     and v_paid + v_tol >= v_due
  then
    perform public.staff_change_order_status(p_order_id, 'paid', null);
    v_transitioned := true;
    select o.status into v_status
    from public.orders as o
    where o.id = p_order_id;
    v_remaining := public.staff_resolve_order_amount_due(p_order_id)
      - public.staff_sum_confirmed_order_payments(p_order_id);
  end if;

  return query
  select
    v_payment.id,
    v_payment.amount,
    v_remaining::numeric(14, 2),
    public.staff_derive_payment_status(v_due, v_paid),
    v_status,
    v_transitioned;
end;
$$;

revoke all on function public.staff_confirm_order_payment(
  uuid, numeric, date, text, text, text
) from public, anon, authenticated;
grant execute on function public.staff_confirm_order_payment(
  uuid, numeric, date, text, text, text
) to authenticated;
