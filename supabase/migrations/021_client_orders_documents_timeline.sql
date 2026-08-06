-- ============================================================
-- 021_client_orders_documents_timeline.sql
-- Client «Мои заказы» — status timeline + own documents (safe RPCs)
-- + client cancel_order writes order_status_history
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–020 files.
-- Does NOT grant SELECT on order_documents / order_status_history.
--
-- Adds:
--   - client_list_order_status_history(p_order_id)
--   - client_list_order_documents(p_order_id)
--   - client_get_order_document(p_order_id, p_document_id)
--   - client_can_read_document_asset(p_name) + storage SELECT policy
-- Replaces:
--   - public.cancel_order(uuid) — same signature; appends status history
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'orders missing — run 005 first.';
  end if;
  if to_regclass('public.order_status_history') is null then
    raise exception 'order_status_history missing — run 012 first.';
  end if;
  if to_regclass('public.order_documents') is null then
    raise exception 'order_documents missing — run 014 first.';
  end if;
  if to_regprocedure('public.staff_is_org_snapshot_asset_path(text, text)') is null then
    raise exception
      'staff_is_org_snapshot_asset_path missing — run 016 first.';
  end if;
  if to_regprocedure('public.cancel_order(uuid)') is null then
    raise exception 'cancel_order missing — run 009/013 first.';
  end if;
end;
$$;

-- ============================================================
-- 1. Client status timeline (no notes, no staff identity)
-- ============================================================

create or replace function public.client_list_order_status_history(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  from_status text,
  to_status text,
  created_at timestamptz
)
language plpgsql
security definer
stable
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

  if not exists (
    select 1
    from public.orders as o
    where o.id = p_order_id
      and o.user_id = v_uid
  ) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    h.id,
    h.order_id,
    h.from_status,
    h.to_status,
    h.created_at
  from public.order_status_history as h
  where h.order_id = p_order_id
  order by h.created_at asc;
end;
$$;

revoke all on function public.client_list_order_status_history(uuid)
  from public, anon, authenticated;
grant execute on function public.client_list_order_status_history(uuid)
  to authenticated;

-- ============================================================
-- 2. Client document list (generated only, no staff metadata)
-- ============================================================

create or replace function public.client_list_order_documents(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  document_type text,
  number text,
  status text,
  generated_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
stable
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

  if not exists (
    select 1
    from public.orders as o
    where o.id = p_order_id
      and o.user_id = v_uid
  ) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    d.id,
    d.order_id,
    d.document_type,
    d.number,
    d.status,
    d.generated_at,
    d.created_at
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.status = 'generated'
  order by d.generated_at asc;
end;
$$;

revoke all on function public.client_list_order_documents(uuid)
  from public, anon, authenticated;
grant execute on function public.client_list_order_documents(uuid)
  to authenticated;

-- ============================================================
-- 3. Client document get (ownership + order binding + metadata)
-- ============================================================

create or replace function public.client_get_order_document(
  p_order_id uuid,
  p_document_id uuid
)
returns table (
  id uuid,
  order_id uuid,
  document_type text,
  number text,
  status text,
  generated_at timestamptz,
  created_at timestamptz,
  metadata jsonb
)
language plpgsql
security definer
stable
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

  if p_document_id is null then
    raise exception 'document_id обязателен';
  end if;

  if not exists (
    select 1
    from public.orders as o
    where o.id = p_order_id
      and o.user_id = v_uid
  ) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    d.id,
    d.order_id,
    d.document_type,
    d.number,
    d.status,
    d.generated_at,
    d.created_at,
    d.metadata
  from public.order_documents as d
  where d.id = p_document_id
    and d.order_id = p_order_id
    and d.status = 'generated';
end;
$$;

revoke all on function public.client_get_order_document(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.client_get_order_document(uuid, uuid)
  to authenticated;

-- ============================================================
-- 4. Signed asset access — only paths sealed in own document metadata
-- ============================================================

create or replace function public.client_can_read_document_asset(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return false;
  end if;

  if p_name is null or p_name = '' then
    return false;
  end if;

  -- Snapshot paths only — never live organization/* assets.
  if not (
    public.staff_is_org_snapshot_asset_path(p_name, 'logo')
    or public.staff_is_org_snapshot_asset_path(p_name, 'stamp')
    or public.staff_is_org_snapshot_asset_path(p_name, 'signature')
  ) then
    return false;
  end if;

  return exists (
    select 1
    from public.order_documents as d
    inner join public.orders as o on o.id = d.order_id
    where o.user_id = v_uid
      and d.status = 'generated'
      and (
        d.metadata #>> '{supplier,logo_path}' = p_name
        or d.metadata #>> '{supplier,stamp_path}' = p_name
        or d.metadata #>> '{supplier,signature_path}' = p_name
      )
  );
end;
$$;

revoke all on function public.client_can_read_document_asset(text)
  from public, anon, authenticated;
grant execute on function public.client_can_read_document_asset(text)
  to authenticated;

drop policy if exists organization_assets_select_client_document on storage.objects;

create policy organization_assets_select_client_document
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'organization-assets'
    and public.client_can_read_document_asset(name)
  );

-- ============================================================
-- 5. cancel_order — same business rules + status history row
--
-- Diff vs 013_customers_foundation.sql cancel_order:
--   + capture v_from_status := v_order.status before update
--   + after successful status → cancelled, INSERT one
--     order_status_history row (from_status, cancelled, auth.uid(), note null)
--   + guard: skip insert if a cancelled history row already exists
--     (defense in depth; primary re-entry block remains status <> 'new')
-- Unchanged: auth, ownership IS DISTINCT FROM, status='new' only,
--            active reservation release loop, return shape, grants.
-- ============================================================

create or replace function public.cancel_order(p_order_id uuid)
returns table (
  id uuid,
  order_number text,
  status text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_order public.orders%rowtype;
  v_from_status text;
  v_has_active_reservation boolean;
  v_reservation record;
  v_inv_reserved numeric(14, 3);
  v_affected_rows integer;
  v_result_id uuid;
  v_result_order_number text;
  v_result_status text;
  v_result_updated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Требуется авторизация';
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

  -- Fail-closed for NULL user_id (staff walk-in orders are not client-cancellable).
  if v_order.user_id is distinct from v_user_id then
    raise exception 'Недостаточно прав для отмены этого заказа';
  end if;

  if v_order.status <> 'new' then
    raise exception
      'Отменить можно только заказ со статусом "new" (текущий статус: %)', v_order.status;
  end if;

  v_from_status := v_order.status;

  select exists (
    select 1
    from public.inventory_reservations as r
    where r.order_id = v_order.id and r.status = 'active'
  ) into v_has_active_reservation;

  if not v_has_active_reservation then
    raise exception
      'У заказа нет активного резерва склада — отмена с освобождением остатка невозможна';
  end if;

  for v_reservation in
    select r.id, r.warehouse_id, r.product_id, r.quantity
    from public.inventory_reservations as r
    where r.order_id = v_order.id and r.status = 'active'
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
        'Складская запись для товара % не найдена, отмена невозможна', v_reservation.product_id;
    end if;

    if v_inv_reserved < v_reservation.quantity then
      raise exception
        'Некорректный резерв товара %: зарезервировано % меньше, чем требуется освободить (%)',
        v_reservation.product_id, v_inv_reserved, v_reservation.quantity;
    end if;

    update public.inventory as i
    set
      reserved_quantity = i.reserved_quantity - v_reservation.quantity,
      updated_at = now()
    where i.warehouse_id = v_reservation.warehouse_id
      and i.product_id = v_reservation.product_id;

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
      raise exception
        'Не удалось освободить резерв товара % для заказа %',
        v_reservation.product_id,
        v_order.order_number;
    end if;
  end loop;

  update public.orders as o
  set status = 'cancelled'
  where o.id = v_order.id
  returning o.id, o.order_number, o.status, o.updated_at
  into v_result_id, v_result_order_number, v_result_status, v_result_updated_at;

  -- Client-visible timeline: one cancelled transition, no staff note.
  -- Re-cancel cannot reach here (status must be 'new'). Extra exists-guard
  -- prevents a duplicate history row if this block is ever re-entered oddly.
  if not exists (
    select 1
    from public.order_status_history as h
    where h.order_id = v_result_id
      and h.to_status = 'cancelled'
  ) then
    insert into public.order_status_history (
      order_id,
      from_status,
      to_status,
      changed_by,
      note
    ) values (
      v_result_id,
      v_from_status,
      'cancelled',
      v_user_id,
      null
    );
  end if;

  return query
  select v_result_id, v_result_order_number, v_result_status, v_result_updated_at;
end;
$$;

revoke all on function public.cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.cancel_order(uuid) to authenticated;

-- ============================================================
-- Notes
-- - No table grants on order_documents / order_status_history.
-- - Client sees only own orders (user_id = auth.uid()).
-- - Documents: generated only; no generated_by / printed_* / file_path.
-- - Timeline: status transitions only — no note / changed_by.
-- - Asset SELECT: snapshot paths present in own document metadata only.
-- - Live organization settings paths stay staff-only.
-- - cancel_order: business rules unchanged; adds one history row.
-- ============================================================
