-- ============================================================
-- 016_organization_assets.sql
-- Stage 6 — Organization settings assets (logo/stamp/signature)
-- + website / whatsapp / warehouse_address
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–015 files.
-- Uses CREATE OR REPLACE / ALTER to extend 014/015 objects.
--
-- Immutable document images (option B + reservation intent):
--   Live settings use overwrite paths:
--     organization/logo.{ext}
--     organization/stamp.{ext}
--     organization/signature.{ext}
--   Generate flow (no client-trusted paths):
--     1) staff_begin_document_asset_snapshot → intent + allowed dest paths
--     2) browser copies live→dest only for returned pairs (INSERT once)
--     3) staff_generate_* (p_snapshot_intent_id) verifies objects + consumes intent
--   doc-snapshots/** : INSERT only (no UPDATE/DELETE via browser client)
-- ============================================================

-- Guarantees from prior stages
do $$
begin
  if to_regclass('public.organization_settings') is null then
    raise exception 'organization_settings missing — run 014_documents.sql first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010 first.';
  end if;
end;
$$;

-- ============================================================
-- 1. Columns (only missing fields)
-- ============================================================

alter table public.organization_settings
  add column if not exists logo_path text;

alter table public.organization_settings
  add column if not exists stamp_path text;

alter table public.organization_settings
  add column if not exists signature_path text;

alter table public.organization_settings
  add column if not exists website text;

alter table public.organization_settings
  add column if not exists whatsapp text;

alter table public.organization_settings
  add column if not exists warehouse_address text;

comment on column public.organization_settings.logo_path is
  'Private Storage path in bucket organization-assets (e.g. organization/logo.png).';
comment on column public.organization_settings.stamp_path is
  'Private Storage path for company stamp image.';
comment on column public.organization_settings.signature_path is
  'Private Storage path for director signature image.';

-- Path must be under organization/ and end with allowed image extension.
-- Rejects http(s) URLs and path traversal.
alter table public.organization_settings
  drop constraint if exists organization_settings_logo_path_check;
alter table public.organization_settings
  add constraint organization_settings_logo_path_check check (
    logo_path is null
    or logo_path ~ '^organization/logo\.(png|jpe?g|webp)$'
  );

alter table public.organization_settings
  drop constraint if exists organization_settings_stamp_path_check;
alter table public.organization_settings
  add constraint organization_settings_stamp_path_check check (
    stamp_path is null
    or stamp_path ~ '^organization/stamp\.(png|jpe?g|webp)$'
  );

alter table public.organization_settings
  drop constraint if exists organization_settings_signature_path_check;
alter table public.organization_settings
  add constraint organization_settings_signature_path_check check (
    signature_path is null
    or signature_path ~ '^organization/signature\.(png|jpe?g|webp)$'
  );

-- ============================================================
-- 2. Path helpers
-- ============================================================

create or replace function public.staff_is_org_live_asset_path(p_path text, p_kind text)
returns boolean
language sql
immutable
as $$
  select
    p_path is not null
    and p_kind in ('logo', 'stamp', 'signature')
    and p_path ~ (
      '^organization/' || p_kind || '\.(png|jpe?g|webp)$'
    );
$$;

revoke all on function public.staff_is_org_live_asset_path(text, text)
  from public, anon, authenticated;

create or replace function public.staff_is_org_snapshot_asset_path(p_path text, p_kind text)
returns boolean
language sql
immutable
as $$
  select
    p_path is not null
    and p_kind in ('logo', 'stamp', 'signature')
    and p_path ~
      (
        '^organization/doc-snapshots/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || p_kind
        || '\.(png|jpe?g|webp)$'
      );
$$;

revoke all on function public.staff_is_org_snapshot_asset_path(text, text)
  from public, anon, authenticated;

create or replace function public.staff_normalize_optional_text(p_value text)
returns text
language sql
immutable
as $$
  select nullif(trim(p_value), '');
$$;

revoke all on function public.staff_normalize_optional_text(text)
  from public, anon, authenticated;

-- ============================================================
-- 3. Snapshot intent table + private Storage bucket + policies
-- ============================================================

create table if not exists public.document_asset_snapshot_intents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  document_type text not null,
  created_by uuid not null references public.profiles (id) on delete cascade,
  -- Frozen live sources at begin-time (consistency for client copy).
  source_logo_path text,
  source_stamp_path text,
  source_signature_path text,
  -- Allowed immutable destinations (null = kind not used).
  logo_path text,
  stamp_path text,
  signature_path text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  consumed_at timestamptz,
  consumed_document_id uuid references public.order_documents (id) on delete set null,
  constraint document_asset_snapshot_intents_type_check check (
    document_type in ('invoice', 'delivery_note')
  ),
  constraint document_asset_snapshot_intents_status_check check (
    status in ('pending', 'consumed', 'expired', 'failed')
  )
);

create index if not exists document_asset_snapshot_intents_order_idx
  on public.document_asset_snapshot_intents (order_id, document_type);

create index if not exists document_asset_snapshot_intents_creator_pending_idx
  on public.document_asset_snapshot_intents (created_by, status)
  where status = 'pending';

alter table public.document_asset_snapshot_intents enable row level security;
revoke all on table public.document_asset_snapshot_intents from public;
revoke all on table public.document_asset_snapshot_intents from anon;
revoke all on table public.document_asset_snapshot_intents from authenticated;

-- Storage RLS helpers (SECURITY DEFINER — used only from policies).
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

  -- Live assets: any staff with org-read role.
  if p_name ~ '^organization/(logo|stamp|signature)\.(png|jpe?g|webp)$' then
    return true;
  end if;

  -- Pending intent destinations owned by caller (copy verification / rare reads).
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

  -- Snapshots already sealed into document metadata (immutable PDF).
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
-- Invoked from storage policies as table owner / supabase — grant to authenticated
-- so policy expressions can call it under the invoking role.
grant execute on function public.staff_can_read_organization_asset(text) to authenticated;

create or replace function public.staff_can_insert_document_snapshot_object(p_name text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    return false;
  end if;

  return exists (
    select 1
    from public.document_asset_snapshot_intents as i
    where i.created_by = auth.uid()
      and i.status = 'pending'
      and i.expires_at > now()
      and p_name is not null
      and p_name in (i.logo_path, i.stamp_path, i.signature_path)
  );
end;
$$;

revoke all on function public.staff_can_insert_document_snapshot_object(text)
  from public, anon, authenticated;
grant execute on function public.staff_can_insert_document_snapshot_object(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-assets',
  'organization-assets',
  false,
  3145728,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists organization_assets_select_staff on storage.objects;
drop policy if exists organization_assets_insert_admin_live on storage.objects;
drop policy if exists organization_assets_update_admin_live on storage.objects;
drop policy if exists organization_assets_delete_admin_live on storage.objects;
drop policy if exists organization_assets_insert_staff_snapshots on storage.objects;
drop policy if exists organization_assets_update_snapshots on storage.objects;
drop policy if exists organization_assets_delete_snapshots on storage.objects;

-- SELECT: live + sealed document snapshots + own pending intent paths only.
create policy organization_assets_select_staff
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'organization-assets'
    and public.staff_can_read_organization_asset(name)
  );

-- Admin INSERT live only (predictable overwrite paths).
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
    )
  );

-- Admin UPDATE live only — NEVER doc-snapshots/**.
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
    )
  )
  with check (
    bucket_id = 'organization-assets'
    and (select public.has_staff_role(array['admin']::public.user_role[]))
    and (
      name ~ '^organization/logo\.(png|jpe?g|webp)$'
      or name ~ '^organization/stamp\.(png|jpe?g|webp)$'
      or name ~ '^organization/signature\.(png|jpe?g|webp)$'
    )
  );

-- Admin DELETE live only — NEVER doc-snapshots/**.
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
    )
  );

-- Snapshot INSERT only for paths reserved by caller's pending intent.
-- No UPDATE/DELETE policies for doc-snapshots → overwrite/delete denied.
-- Re-INSERT same name fails with unique storage constraint (upsert forbidden by policy).
create policy organization_assets_insert_staff_snapshots
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'organization-assets'
    and public.staff_can_insert_document_snapshot_object(name)
  );

-- ============================================================
-- 4. staff_get_organization_settings — include warehouse (PDF print)
-- ============================================================

create or replace function public.staff_get_organization_settings()
returns public.organization_settings
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_org public.organization_settings;
begin
  if not public.has_staff_role(
    array['manager', 'accountant', 'warehouse', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра реквизитов организации';
  end if;

  select * into v_org
  from public.organization_settings as s
  where s.singleton_key = 'default';

  if not found then
    raise exception 'organization_settings не найдена';
  end if;

  return v_org;
end;
$$;

revoke all on function public.staff_get_organization_settings() from public, anon, authenticated;
grant execute on function public.staff_get_organization_settings() to authenticated;

-- ============================================================
-- 5. staff_upsert_organization_settings — extended fields
-- Drop prior 15-arg signature from 014, create new full signature.
-- ============================================================

drop function if exists public.staff_upsert_organization_settings(
  text, text, text, text, text, text, text, text, text, text, text, text, text, text, numeric
);

create or replace function public.staff_upsert_organization_settings(
  p_legal_name text,
  p_bin text,
  p_address text,
  p_phone text,
  p_bank_name text,
  p_bank_bik text,
  p_bank_iik text,
  p_bank_kbe text,
  p_director_name text,
  p_city text default null,
  p_email text default null,
  p_warehouse_name text default null,
  p_warehouse_code text default null,
  p_default_tax_mode text default 'without_vat',
  p_vat_rate numeric default null,
  p_website text default null,
  p_whatsapp text default null,
  p_warehouse_address text default null,
  p_logo_path text default null,
  p_stamp_path text default null,
  p_signature_path text default null
)
returns public.organization_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organization_settings;
  v_legal_name text := public.staff_normalize_optional_text(p_legal_name);
  v_bin text := public.staff_normalize_optional_text(p_bin);
  v_address text := public.staff_normalize_optional_text(p_address);
  v_phone text := public.staff_normalize_optional_text(p_phone);
  v_bank_name text := public.staff_normalize_optional_text(p_bank_name);
  v_bank_bik text := public.staff_normalize_optional_text(p_bank_bik);
  v_bank_iik text := public.staff_normalize_optional_text(p_bank_iik);
  v_bank_kbe text := public.staff_normalize_optional_text(p_bank_kbe);
  v_director_name text := public.staff_normalize_optional_text(p_director_name);
  v_tax_mode text := coalesce(public.staff_normalize_optional_text(p_default_tax_mode), 'without_vat');
  v_vat_rate numeric(5, 2) := p_vat_rate;
  v_logo text := public.staff_normalize_optional_text(p_logo_path);
  v_stamp text := public.staff_normalize_optional_text(p_stamp_path);
  v_signature text := public.staff_normalize_optional_text(p_signature_path);
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения реквизитов организации';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if v_legal_name is null
     or v_bin is null
     or v_address is null
     or v_phone is null
     or v_bank_name is null
     or v_bank_bik is null
     or v_bank_iik is null
     or v_bank_kbe is null
     or v_director_name is null
  then
    raise exception
      'Обязательны: legal_name, bin, address, phone, bank_name, bank_bik, bank_iik, bank_kbe, director_name';
  end if;

  if v_bin !~ '^\d{12}$' then
    raise exception 'БИН должен состоять из 12 цифр';
  end if;

  if v_tax_mode not in ('without_vat', 'with_vat') then
    raise exception 'default_tax_mode должен быть without_vat или with_vat';
  end if;

  if v_vat_rate is not null and (v_vat_rate < 0 or v_vat_rate > 100) then
    raise exception 'vat_rate должен быть в диапазоне 0..100';
  end if;

  if v_tax_mode = 'with_vat' and v_vat_rate is null then
    raise exception 'При default_tax_mode=with_vat необходимо указать vat_rate';
  end if;

  -- Reject arbitrary URLs / traversal — only live Storage paths.
  if v_logo is not null and not public.staff_is_org_live_asset_path(v_logo, 'logo') then
    raise exception 'logo_path должен быть Storage path вида organization/logo.(png|jpg|jpeg|webp)';
  end if;
  if v_stamp is not null and not public.staff_is_org_live_asset_path(v_stamp, 'stamp') then
    raise exception 'stamp_path должен быть Storage path вида organization/stamp.(png|jpg|jpeg|webp)';
  end if;
  if v_signature is not null and not public.staff_is_org_live_asset_path(v_signature, 'signature') then
    raise exception 'signature_path должен быть Storage path вида organization/signature.(png|jpg|jpeg|webp)';
  end if;

  insert into public.organization_settings as s (
    singleton_key,
    legal_name,
    bin,
    address,
    city,
    phone,
    email,
    bank_name,
    bank_bik,
    bank_iik,
    bank_kbe,
    director_name,
    warehouse_name,
    warehouse_code,
    default_tax_mode,
    vat_rate,
    website,
    whatsapp,
    warehouse_address,
    logo_path,
    stamp_path,
    signature_path,
    updated_by
  ) values (
    'default',
    v_legal_name,
    v_bin,
    v_address,
    public.staff_normalize_optional_text(p_city),
    v_phone,
    public.staff_normalize_optional_text(p_email),
    v_bank_name,
    v_bank_bik,
    v_bank_iik,
    v_bank_kbe,
    v_director_name,
    public.staff_normalize_optional_text(p_warehouse_name),
    public.staff_normalize_optional_text(p_warehouse_code),
    v_tax_mode,
    v_vat_rate,
    public.staff_normalize_optional_text(p_website),
    public.staff_normalize_optional_text(p_whatsapp),
    public.staff_normalize_optional_text(p_warehouse_address),
    v_logo,
    v_stamp,
    v_signature,
    v_uid
  )
  on conflict (singleton_key) do update set
    legal_name = excluded.legal_name,
    bin = excluded.bin,
    address = excluded.address,
    city = excluded.city,
    phone = excluded.phone,
    email = excluded.email,
    bank_name = excluded.bank_name,
    bank_bik = excluded.bank_bik,
    bank_iik = excluded.bank_iik,
    bank_kbe = excluded.bank_kbe,
    director_name = excluded.director_name,
    warehouse_name = excluded.warehouse_name,
    warehouse_code = excluded.warehouse_code,
    default_tax_mode = excluded.default_tax_mode,
    vat_rate = excluded.vat_rate,
    website = excluded.website,
    whatsapp = excluded.whatsapp,
    warehouse_address = excluded.warehouse_address,
    logo_path = excluded.logo_path,
    stamp_path = excluded.stamp_path,
    signature_path = excluded.signature_path,
    updated_by = excluded.updated_by
  returning * into v_org;

  return v_org;
end;
$$;

revoke all on function public.staff_upsert_organization_settings(
  text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, numeric,
  text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.staff_upsert_organization_settings(
  text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, numeric,
  text, text, text, text, text, text
) to authenticated;

-- Set/clear a single live asset path after Storage upload/delete (admin).
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

  if v_kind not in ('logo', 'stamp', 'signature') then
    raise exception 'kind должен быть logo, stamp или signature';
  end if;

  if v_path is not null and not public.staff_is_org_live_asset_path(v_path, v_kind) then
    raise exception 'path должен быть organization/%.(png|jpg|jpeg|webp)', v_kind;
  end if;

  update public.organization_settings as s
  set
    logo_path = case when v_kind = 'logo' then v_path else s.logo_path end,
    stamp_path = case when v_kind = 'stamp' then v_path else s.stamp_path end,
    signature_path = case when v_kind = 'signature' then v_path else s.signature_path end,
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
grant execute on function public.staff_set_organization_asset_path(text, text) to authenticated;

-- ============================================================
-- 5b. Begin asset snapshot intent (server-issued paths only)
-- ============================================================

create or replace function public.staff_storage_object_exists(p_path text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from storage.objects as o
    where o.bucket_id = 'organization-assets'
      and o.name = p_path
  );
$$;

revoke all on function public.staff_storage_object_exists(text)
  from public, anon, authenticated;

create or replace function public.staff_ext_from_live_asset_path(p_path text)
returns text
language sql
immutable
as $$
  select lower(substring(p_path from '\.(png|jpe?g|webp)$'));
$$;

revoke all on function public.staff_ext_from_live_asset_path(text)
  from public, anon, authenticated;

create or replace function public.staff_begin_document_asset_snapshot(
  p_order_id uuid,
  p_document_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_org public.organization_settings;
  v_intent_id uuid := gen_random_uuid();
  v_logo_src text;
  v_stamp_src text;
  v_sig_src text;
  v_logo_dest text;
  v_stamp_dest text;
  v_sig_dest text;
  v_ext text;
  v_assets jsonb := '[]'::jsonb;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для подготовки снимка изображений';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_document_type is null or p_document_type not in ('invoice', 'delivery_note') then
    raise exception 'Некорректный тип документа';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  if exists (
    select 1
    from public.order_documents as d
    where d.order_id = p_order_id
      and d.document_type = p_document_type
  ) then
    raise exception 'Документ этого типа для заказа уже существует';
  end if;

  -- Expire stale pending intents for same order/type owned by caller.
  update public.document_asset_snapshot_intents as i
  set status = 'expired'
  where i.order_id = p_order_id
    and i.document_type = p_document_type
    and i.created_by = v_uid
    and i.status = 'pending';

  v_org := public.staff_require_organization_settings();

  v_logo_src := nullif(trim(v_org.logo_path), '');
  v_stamp_src := nullif(trim(v_org.stamp_path), '');
  v_sig_src := nullif(trim(v_org.signature_path), '');

  if v_logo_src is not null then
    if not public.staff_is_org_live_asset_path(v_logo_src, 'logo') then
      raise exception 'Некорректный live logo_path в organization_settings';
    end if;
    v_ext := public.staff_ext_from_live_asset_path(v_logo_src);
    if v_ext = 'jpeg' then
      v_ext := 'jpg';
    end if;
    v_logo_dest := 'organization/doc-snapshots/' || v_intent_id::text || '/logo.' || v_ext;
    v_assets := v_assets || jsonb_build_array(jsonb_build_object(
      'kind', 'logo',
      'source_path', v_logo_src,
      'dest_path', v_logo_dest
    ));
  end if;

  if v_stamp_src is not null then
    if not public.staff_is_org_live_asset_path(v_stamp_src, 'stamp') then
      raise exception 'Некорректный live stamp_path в organization_settings';
    end if;
    v_ext := public.staff_ext_from_live_asset_path(v_stamp_src);
    if v_ext = 'jpeg' then
      v_ext := 'jpg';
    end if;
    v_stamp_dest := 'organization/doc-snapshots/' || v_intent_id::text || '/stamp.' || v_ext;
    v_assets := v_assets || jsonb_build_array(jsonb_build_object(
      'kind', 'stamp',
      'source_path', v_stamp_src,
      'dest_path', v_stamp_dest
    ));
  end if;

  if v_sig_src is not null then
    if not public.staff_is_org_live_asset_path(v_sig_src, 'signature') then
      raise exception 'Некорректный live signature_path в organization_settings';
    end if;
    v_ext := public.staff_ext_from_live_asset_path(v_sig_src);
    if v_ext = 'jpeg' then
      v_ext := 'jpg';
    end if;
    v_sig_dest := 'organization/doc-snapshots/' || v_intent_id::text || '/signature.' || v_ext;
    v_assets := v_assets || jsonb_build_array(jsonb_build_object(
      'kind', 'signature',
      'source_path', v_sig_src,
      'dest_path', v_sig_dest
    ));
  end if;

  insert into public.document_asset_snapshot_intents (
    id,
    order_id,
    document_type,
    created_by,
    source_logo_path,
    source_stamp_path,
    source_signature_path,
    logo_path,
    stamp_path,
    signature_path,
    status
  ) values (
    v_intent_id,
    p_order_id,
    p_document_type,
    v_uid,
    v_logo_src,
    v_stamp_src,
    v_sig_src,
    v_logo_dest,
    v_stamp_dest,
    v_sig_dest,
    'pending'
  );

  return jsonb_build_object(
    'intent_id', v_intent_id,
    'order_id', p_order_id,
    'document_type', p_document_type,
    'expires_at', now() + interval '15 minutes',
    'assets', v_assets
  );
end;
$$;

revoke all on function public.staff_begin_document_asset_snapshot(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_begin_document_asset_snapshot(uuid, text) to authenticated;

create or replace function public.staff_fail_document_asset_snapshot(p_intent_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  update public.document_asset_snapshot_intents as i
  set status = 'failed'
  where i.id = p_intent_id
    and i.created_by = auth.uid()
    and i.status = 'pending';
end;
$$;

revoke all on function public.staff_fail_document_asset_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_fail_document_asset_snapshot(uuid) to authenticated;

-- ============================================================
-- 6. Supplier snapshot + metadata + generate (asset snapshot paths)
-- ============================================================

drop function if exists public.staff_document_supplier_snapshot();

create or replace function public.staff_document_supplier_snapshot(
  p_logo_path text default null,
  p_stamp_path text default null,
  p_signature_path text default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_org public.organization_settings;
  v_logo text := public.staff_normalize_optional_text(p_logo_path);
  v_stamp text := public.staff_normalize_optional_text(p_stamp_path);
  v_signature text := public.staff_normalize_optional_text(p_signature_path);
begin
  v_org := public.staff_require_organization_settings();

  -- Document metadata may only reference immutable snapshot paths (or null).
  if v_logo is not null and not public.staff_is_org_snapshot_asset_path(v_logo, 'logo') then
    raise exception 'logo snapshot path некорректен';
  end if;
  if v_stamp is not null and not public.staff_is_org_snapshot_asset_path(v_stamp, 'stamp') then
    raise exception 'stamp snapshot path некорректен';
  end if;
  if v_signature is not null and not public.staff_is_org_snapshot_asset_path(v_signature, 'signature') then
    raise exception 'signature snapshot path некорректен';
  end if;

  return jsonb_build_object(
    'legal_name', trim(v_org.legal_name),
    'bin', trim(v_org.bin),
    'address', trim(v_org.address),
    'city', nullif(trim(v_org.city), ''),
    'phone', trim(v_org.phone),
    'email', nullif(trim(v_org.email), ''),
    'website', nullif(trim(v_org.website), ''),
    'whatsapp', nullif(trim(v_org.whatsapp), ''),
    'bank_name', trim(v_org.bank_name),
    'bank_bik', trim(v_org.bank_bik),
    'bank_iik', trim(v_org.bank_iik),
    'bank_kbe', trim(v_org.bank_kbe),
    'director_name', trim(v_org.director_name),
    'warehouse_name', nullif(trim(v_org.warehouse_name), ''),
    'warehouse_code', nullif(trim(v_org.warehouse_code), ''),
    'warehouse_address', nullif(trim(v_org.warehouse_address), ''),
    'logo_path', v_logo,
    'stamp_path', v_stamp,
    'signature_path', v_signature
  );
end;
$$;

revoke all on function public.staff_document_supplier_snapshot(text, text, text)
  from public, anon, authenticated;

-- Rebuild metadata builder with asset path args (keep tax_mode signature extension).
drop function if exists public.staff_build_document_metadata(uuid, text, text, text);

create or replace function public.staff_build_document_metadata(
  p_order_id uuid,
  p_document_type text,
  p_document_number text,
  p_tax_mode text,
  p_logo_path text default null,
  p_stamp_path text default null,
  p_signature_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_customer public.customers;
  v_org public.organization_settings;
  v_items jsonb;
  v_items_count integer;
  v_total_quantity numeric;
  v_form_hint text;
  v_missing_unit_count integer;
  v_tax_mode text := nullif(trim(p_tax_mode), '');
  v_vat_rate numeric(5, 2);
  v_vat_amount numeric(14, 2);
  v_amount_without_vat numeric(14, 2);
  v_document_total numeric(14, 2);
  v_tax_label text;
  v_formula text;
begin
  select * into v_order
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  select * into v_customer
  from public.customers as c
  where c.id = v_order.customer_id;

  if not found then
    raise exception 'Клиент заказа не найден';
  end if;

  if v_tax_mode is null or v_tax_mode not in ('without_vat', 'with_vat') then
    raise exception 'tax_mode должен быть without_vat или with_vat';
  end if;

  if p_document_type = 'invoice' then
    v_form_hint := 'kz_invoice';
  else
    v_form_hint := 'kz_form_3_2';
  end if;

  select count(*) into v_missing_unit_count
  from public.order_items as oi
  left join public.products as p on p.id = oi.product_id
  where oi.order_id = p_order_id
    and (p.id is null or nullif(trim(p.unit), '') is null);

  if v_missing_unit_count > 0 then
    raise exception
      'У одной или нескольких позиций отсутствует единица измерения товара (products.unit)';
  end if;

  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'line_no', sub.line_no,
          'order_item_id', sub.id,
          'product_id', sub.product_id,
          'product_name', sub.product_name,
          'product_sku', sub.product_sku,
          'unit', sub.unit,
          'quantity', sub.quantity,
          'unit_price', sub.unit_price,
          'line_total', sub.line_total
        )
        order by sub.line_no
      ),
      '[]'::jsonb
    ),
    coalesce(count(*), 0),
    coalesce(sum(sub.quantity), 0)
  into v_items, v_items_count, v_total_quantity
  from (
    select
      oi.id,
      oi.product_id,
      oi.product_name,
      oi.product_sku,
      trim(p.unit) as unit,
      oi.quantity,
      oi.unit_price,
      oi.line_total,
      row_number() over (order by oi.created_at, oi.id) as line_no
    from public.order_items as oi
    inner join public.products as p on p.id = oi.product_id
    where oi.order_id = p_order_id
  ) as sub;

  if v_items_count = 0 then
    raise exception 'Нельзя сформировать документ для заказа без позиций';
  end if;

  v_amount_without_vat := v_order.total;

  if v_tax_mode = 'without_vat' then
    v_vat_rate := 0;
    v_vat_amount := 0;
    v_document_total := v_order.total;
    v_tax_label := 'Без НДС';
    v_formula :=
      'without_vat: vat_rate=0; vat_amount=0; total=orders.total';
  else
    select * into v_org
    from public.organization_settings as s
    where s.singleton_key = 'default';

    if not found or v_org.vat_rate is null then
      raise exception
        'Для режима «С НДС» необходимо задать organization_settings.vat_rate (например 12.00 для РК)';
    end if;

    v_vat_rate := v_org.vat_rate;
    v_vat_amount := round(v_amount_without_vat * v_vat_rate / 100, 2);
    v_document_total := v_amount_without_vat + v_vat_amount;
    v_tax_label := 'С НДС';
    v_formula :=
      'with_vat: amount_without_vat=orders.total; '
      || 'vat_amount=round(amount_without_vat*vat_rate/100,2); '
      || 'total=amount_without_vat+vat_amount; '
      || 'vat_rate from organization_settings.vat_rate';
  end if;

  return jsonb_build_object(
    'schema_version', 2,
    'document_type', p_document_type,
    'document_number', p_document_number,
    'form_hint', v_form_hint,
    'generated_at', now(),
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'status', v_order.status,
      'created_at', v_order.created_at,
      'customer_id', v_order.customer_id,
      'company_id', v_order.company_id,
      'comment', v_order.comment,
      'delivery_type', v_order.delivery_type,
      'delivery_address', v_order.delivery_address,
      'delivery_comment', v_order.delivery_comment,
      'contact_name', v_order.contact_name,
      'contact_phone', v_order.contact_phone,
      'contact_email', v_order.contact_email
    ),
    'supplier', public.staff_document_supplier_snapshot(
      p_logo_path,
      p_stamp_path,
      p_signature_path
    ),
    'buyer', jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_type', v_customer.customer_type,
      'display_name', v_customer.display_name,
      'legal_name', v_customer.legal_name,
      'iin_bin', v_customer.iin_bin,
      'phone', coalesce(v_customer.phone, v_order.contact_phone),
      'email', coalesce(v_customer.email, v_order.contact_email),
      'contact_person', coalesce(v_customer.contact_person, v_order.contact_name),
      'address', coalesce(v_customer.address, v_order.delivery_address),
      'city', v_customer.city,
      'profile_id', v_customer.profile_id,
      'company_id', v_customer.company_id
    ),
    'items', v_items,
    'totals', jsonb_build_object(
      'subtotal', v_order.subtotal,
      'discount', v_order.discount,
      'order_total', v_order.total,
      'amount_without_vat', v_amount_without_vat,
      'vat_rate', v_vat_rate,
      'vat_amount', v_vat_amount,
      'total', v_document_total,
      'items_count', v_items_count,
      'total_quantity', v_total_quantity,
      'currency', 'KZT',
      'tax_mode', v_tax_mode,
      'tax_label', v_tax_label,
      'formula', v_formula
    ),
    'basis', jsonb_build_object(
      'label', 'Заказ ' || v_order.order_number,
      'order_number', v_order.order_number,
      'order_date', v_order.created_at
    ),
    'form_3_2', jsonb_build_object(
      'organization_stamp', null,
      'released_by_name', null,
      'released_by_position', null,
      'received_by_name', null,
      'received_by_position', null,
      'transport', null,
      'power_of_attorney', null,
      'notes', null
    )
  );
end;
$$;

revoke all on function public.staff_build_document_metadata(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;

drop function if exists public.staff_generate_order_document(uuid, text, text);
drop function if exists public.staff_generate_order_document(uuid, text, text, text, text, text);

create or replace function public.staff_generate_order_document(
  p_order_id uuid,
  p_document_type text,
  p_tax_mode text,
  p_snapshot_intent_id uuid
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_order public.orders;
  v_number text;
  v_metadata jsonb;
  v_doc public.order_documents;
  v_existing_id uuid;
  v_items_count integer;
  v_lines_subtotal numeric(14, 2);
  v_tax_mode text := nullif(trim(p_tax_mode), '');
  v_intent public.document_asset_snapshot_intents;
begin
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для формирования документов';
  end if;

  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_uid;

  if not found then
    raise exception 'Профиль сотрудника не найден';
  end if;

  if v_profile.role not in ('manager', 'admin') or not v_profile.is_active then
    raise exception 'Недостаточно прав для формирования документов';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_document_type is null or p_document_type not in ('invoice', 'delivery_note') then
    raise exception 'Некорректный тип документа';
  end if;

  if v_tax_mode is null or v_tax_mode not in ('without_vat', 'with_vat') then
    raise exception 'tax_mode должен быть without_vat или with_vat';
  end if;

  if p_snapshot_intent_id is null then
    raise exception 'snapshot_intent_id обязателен';
  end if;

  select * into v_intent
  from public.document_asset_snapshot_intents as i
  where i.id = p_snapshot_intent_id
  for update;

  if not found then
    raise exception 'Снимок изображений не найден';
  end if;

  if v_intent.created_by is distinct from v_uid then
    raise exception 'Снимок изображений принадлежит другому пользователю';
  end if;

  if v_intent.order_id is distinct from p_order_id then
    raise exception 'Снимок изображений не принадлежит этому заказу';
  end if;

  if v_intent.document_type is distinct from p_document_type then
    raise exception 'Снимок изображений не соответствует типу документа';
  end if;

  if v_intent.status = 'pending' and v_intent.expires_at <= now() then
    update public.document_asset_snapshot_intents
    set status = 'expired'
    where id = v_intent.id;
    raise exception 'Срок действия снимка изображений истёк — начните генерацию заново';
  end if;

  if v_intent.status is distinct from 'pending' then
    raise exception 'Снимок изображений уже использован или недействителен (%)', v_intent.status;
  end if;

  -- Verify each reserved dest object exists (client must have copied).
  if v_intent.logo_path is not null
     and not public.staff_storage_object_exists(v_intent.logo_path) then
    raise exception 'Файл logo snapshot не найден в Storage';
  end if;
  if v_intent.stamp_path is not null
     and not public.staff_storage_object_exists(v_intent.stamp_path) then
    raise exception 'Файл stamp snapshot не найден в Storage';
  end if;
  if v_intent.signature_path is not null
     and not public.staff_storage_object_exists(v_intent.signature_path) then
    raise exception 'Файл signature snapshot не найден в Storage';
  end if;

  if v_intent.logo_path is not null
     and not public.staff_is_org_snapshot_asset_path(v_intent.logo_path, 'logo') then
    raise exception 'logo snapshot path некорректен';
  end if;
  if v_intent.stamp_path is not null
     and not public.staff_is_org_snapshot_asset_path(v_intent.stamp_path, 'stamp') then
    raise exception 'stamp snapshot path некорректен';
  end if;
  if v_intent.signature_path is not null
     and not public.staff_is_org_snapshot_asset_path(v_intent.signature_path, 'signature') then
    raise exception 'signature snapshot path некорректен';
  end if;

  -- Dest folder must equal intent id (document-specific binding).
  if v_intent.logo_path is not null
     and v_intent.logo_path not like ('organization/doc-snapshots/' || v_intent.id::text || '/%') then
    raise exception 'logo snapshot path не принадлежит intent';
  end if;
  if v_intent.stamp_path is not null
     and v_intent.stamp_path not like ('organization/doc-snapshots/' || v_intent.id::text || '/%') then
    raise exception 'stamp snapshot path не принадлежит intent';
  end if;
  if v_intent.signature_path is not null
     and v_intent.signature_path not like ('organization/doc-snapshots/' || v_intent.id::text || '/%') then
    raise exception 'signature snapshot path не принадлежит intent';
  end if;

  perform public.staff_require_organization_settings();

  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Нельзя сформировать документ для отменённого заказа';
  end if;

  if p_document_type = 'delivery_note'
     and v_order.status not in (
       'paid',
       'picking',
       'ready_for_shipment',
       'shipped',
       'completed'
     )
  then
    raise exception
      'Накладную можно создать только после оплаты (статусы: paid, picking, ready_for_shipment, shipped, completed). Текущий статус: %',
      v_order.status;
  end if;

  select count(*), coalesce(sum(oi.line_total), 0)::numeric(14, 2)
  into v_items_count, v_lines_subtotal
  from public.order_items as oi
  where oi.order_id = p_order_id;

  if v_items_count = 0 then
    raise exception 'Нельзя сформировать документ для заказа без позиций';
  end if;

  if v_order.subtotal < 0 or v_order.discount < 0 or v_order.total < 0 then
    raise exception 'Некорректные суммы заказа';
  end if;

  if v_order.discount > v_order.subtotal then
    raise exception 'Скидка превышает подытог заказа';
  end if;

  if v_order.total is distinct from (v_order.subtotal - v_order.discount) then
    raise exception
      'Несогласованность сумм заказа: total (%) != subtotal (%) - discount (%)',
      v_order.total, v_order.subtotal, v_order.discount;
  end if;

  if abs(v_order.subtotal - v_lines_subtotal) > 0.01 then
    raise exception
      'Подытог заказа (%) не совпадает с суммой позиций (%)',
      v_order.subtotal, v_lines_subtotal;
  end if;

  select d.id into v_existing_id
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = p_document_type;

  if found then
    raise exception 'Документ этого типа для заказа уже существует';
  end if;

  v_number := public.staff_document_number_from_order(v_order.order_number, p_document_type);
  v_metadata := public.staff_build_document_metadata(
    p_order_id,
    p_document_type,
    v_number,
    v_tax_mode,
    v_intent.logo_path,
    v_intent.stamp_path,
    v_intent.signature_path
  );

  begin
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
      p_document_type,
      v_number,
      'generated',
      null,
      v_uid,
      now(),
      v_metadata
    )
    returning * into v_doc;
  exception
    when unique_violation then
      raise exception 'Документ этого типа для заказа уже существует (параллельный запрос)';
  end;

  update public.document_asset_snapshot_intents as i
  set
    status = 'consumed',
    consumed_at = now(),
    consumed_document_id = v_doc.id
  where i.id = v_intent.id;

  return v_doc;
end;
$$;

revoke all on function public.staff_generate_order_document(uuid, text, text, uuid)
  from public, anon, authenticated;

drop function if exists public.staff_generate_invoice(uuid, text);
drop function if exists public.staff_generate_invoice(uuid, text, text, text, text);
drop function if exists public.staff_generate_delivery_note(uuid, text);
drop function if exists public.staff_generate_delivery_note(uuid, text, text, text, text);

create or replace function public.staff_generate_invoice(
  p_order_id uuid,
  p_tax_mode text,
  p_snapshot_intent_id uuid
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.staff_generate_order_document(
    p_order_id,
    'invoice',
    p_tax_mode,
    p_snapshot_intent_id
  );
end;
$$;

revoke all on function public.staff_generate_invoice(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_generate_invoice(uuid, text, uuid) to authenticated;

create or replace function public.staff_generate_delivery_note(
  p_order_id uuid,
  p_tax_mode text,
  p_snapshot_intent_id uuid
)
returns public.order_documents
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.staff_generate_order_document(
    p_order_id,
    'delivery_note',
    p_tax_mode,
    p_snapshot_intent_id
  );
end;
$$;

revoke all on function public.staff_generate_delivery_note(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_generate_delivery_note(uuid, text, uuid) to authenticated;

-- ============================================================
-- Notes
-- - Bucket organization-assets is private (public=false).
-- - Live paths: admin INSERT/UPDATE/DELETE only.
-- - doc-snapshots/**: INSERT only via pending intent; no UPDATE/DELETE policies.
-- - Generate accepts p_snapshot_intent_id only (never raw client paths).
-- - Orphan snapshots from failed/expired intents are not browser-deletable;
--   cleanup requires a future privileged job (not service_role in browser).
-- - Images optional; empty assets[] intent still valid.
-- ============================================================
