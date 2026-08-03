-- ============================================================
-- 015_document_pdf_print.sql
-- Stage 5 — PDF print tracking + order-bound document fetch
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT alter 001–014 business rules (generate, tax, metadata).
--
-- Adds:
--   - order_documents.printed_at / printed_by (first successful PDF only)
--   - staff_mark_document_printed(p_order_id, p_document_id)
--   - staff_get_document(p_order_id, p_document_id) — order binding required
--   - list/get return printed_* fields
-- ============================================================

-- 1. Print audit columns (nullable until first successful PDF)
alter table public.order_documents
  add column if not exists printed_at timestamptz;

alter table public.order_documents
  add column if not exists printed_by uuid references public.profiles (id) on delete set null;

comment on column public.order_documents.printed_at is
  'First successful PDF generation timestamp. Immutable after set.';
comment on column public.order_documents.printed_by is
  'Staff profile that first printed the PDF. Immutable after set.';

-- 2. Drop Stage-4 get-by-id-only overload (cross-order URL swap risk).
-- New signature requires both order_id and document_id.
drop function if exists public.staff_get_document(uuid);

create or replace function public.staff_get_document(
  p_order_id uuid,
  p_document_id uuid
)
returns table (
  id uuid,
  order_id uuid,
  document_type text,
  number text,
  status text,
  file_path text,
  generated_by uuid,
  generated_by_name text,
  generated_at timestamptz,
  printed_at timestamptz,
  printed_by uuid,
  printed_by_name text,
  created_at timestamptz,
  updated_at timestamptz,
  metadata jsonb
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра документа';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_document_id is null then
    raise exception 'document_id обязателен';
  end if;

  -- Security: document must belong to the route order (no cross-order fetch).
  return query
  select
    d.id,
    d.order_id,
    d.document_type,
    d.number,
    d.status,
    d.file_path,
    d.generated_by,
    gp.full_name as generated_by_name,
    d.generated_at,
    d.printed_at,
    d.printed_by,
    pp.full_name as printed_by_name,
    d.created_at,
    d.updated_at,
    d.metadata
  from public.order_documents as d
  left join public.profiles as gp on gp.id = d.generated_by
  left join public.profiles as pp on pp.id = d.printed_by
  where d.id = p_document_id
    and d.order_id = p_order_id;
end;
$$;

revoke all on function public.staff_get_document(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_document(uuid, uuid) to authenticated;

-- 3. List: include print audit (still no metadata).
drop function if exists public.staff_list_order_documents(uuid);

create or replace function public.staff_list_order_documents(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  document_type text,
  number text,
  status text,
  file_path text,
  generated_by uuid,
  generated_by_name text,
  generated_at timestamptz,
  printed_at timestamptz,
  printed_by uuid,
  printed_by_name text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра документов';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    d.id,
    d.order_id,
    d.document_type,
    d.number,
    d.status,
    d.file_path,
    d.generated_by,
    gp.full_name as generated_by_name,
    d.generated_at,
    d.printed_at,
    d.printed_by,
    pp.full_name as printed_by_name,
    d.created_at,
    d.updated_at
  from public.order_documents as d
  left join public.profiles as gp on gp.id = d.generated_by
  left join public.profiles as pp on pp.id = d.printed_by
  where d.order_id = p_order_id
  order by d.generated_at asc;
end;
$$;

revoke all on function public.staff_list_order_documents(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_list_order_documents(uuid) to authenticated;

-- 4. Mark first successful PDF print (idempotent — never overwrites).
create or replace function public.staff_mark_document_printed(
  p_order_id uuid,
  p_document_id uuid
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.order_documents;
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для печати документа';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_document_id is null then
    raise exception 'document_id обязателен';
  end if;

  select * into v_doc
  from public.order_documents as d
  where d.id = p_document_id
    and d.order_id = p_order_id
  for update;

  if not found then
    raise exception 'Документ не найден или не принадлежит указанному заказу';
  end if;

  if v_doc.status = 'cancelled' then
    raise exception 'Нельзя печатать отменённый документ';
  end if;

  -- First successful print only.
  if v_doc.printed_at is not null then
    return v_doc;
  end if;

  update public.order_documents as d
  set
    printed_at = now(),
    printed_by = v_uid
  where d.id = v_doc.id
  returning * into v_doc;

  return v_doc;
end;
$$;

revoke all on function public.staff_mark_document_printed(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_mark_document_printed(uuid, uuid) to authenticated;

-- ============================================================
-- Notes
-- - PDF bytes are NOT stored; printed_* is audit only.
-- - metadata remains immutable (014 trigger unchanged).
-- - staff_get_document requires order_id + document_id (URL swap blocked).
-- - Reprint does not change printed_at / printed_by.
-- ============================================================
