-- ============================================================
-- 026_customer_behavior.sql
-- Stage 26 — Customer Behavior Analytics (security audit hardened)
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–025 files.
-- Security / privacy audit hardened (authoritative events, whitelist
-- metadata, rate limits, immutable session profile link, retention).
--
-- Trust model:
--   - Client may only ingest CLIENT_ALLOWED event types via
--     analytics_track_events (anon + authenticated).
--   - AUTHORITATIVE events (login/register/order/document) are written
--     ONLY by dedicated authenticated RPCs (source='server').
--   - profile_id / customer_id / created_at are NEVER trusted from
--     client payloads — resolved from auth.uid() / now() only.
--   - Consent is client-side (server accepts only what is sent).
--   - Logout strategy: client rotates visitor_id on signOut.
--   - Retention: 12 months recommended; no cron in this migration
--     (use admin_analytics_cleanup).
--
-- Architecture:
--   - Raw telemetry: analytics_sessions + analytics_events.
--   - RLS enabled, NO policies for anon/authenticated (deny-all).
--   - All table privileges revoked from public/anon/authenticated.
--   - Writes: analytics_track_events, analytics_link_visitor,
--             analytics_record_* (authoritative).
--   - Reads / admin ops: security definer staff/admin RPCs only.
--   - Internal helpers have NO EXECUTE grant.
--
-- Timezone for all day/period bounds: Asia/Almaty.
-- Period default (both dates null): current Almaty calendar day.
-- Inclusive end day: ts_to is exclusive start of (date_to + 1 day) Almaty.
--
-- Funnel order attribution:
--   Prefer distinct visitor_id from analytics_events where
--   event_type='order_created' AND source='server' in period.
--   Client should pass visitor/session cookies into
--   analytics_record_order_event at order create time
--   (session must match visitor). Attribution window for any
--   fallback joins = 7 days before order (documented; primary
--   path is the server order_created event).
--
-- Access:
--   - Traffic dashboard RPCs: active admin only.
--   - Online customers (manager): manager only, scoped.
--   - Product analytics: admin / manager / warehouse.
--   - Customer activity: analytics_can_view_customer
--     (admin | manager scoped | owning client).
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles missing — run 001 first.';
  end if;
  if to_regclass('public.customers') is null then
    raise exception 'public.customers missing — run 013 first.';
  end if;
  if to_regclass('public.orders') is null then
    raise exception 'public.orders missing — run 005+ first.';
  end if;
  if to_regclass('public.order_items') is null then
    raise exception 'public.order_items missing — run 005 first.';
  end if;
  if to_regclass('public.order_payments') is null then
    raise exception 'public.order_payments missing — run 022 first.';
  end if;
  if to_regclass('public.products') is null then
    raise exception 'public.products missing — run 002 first.';
  end if;
  if to_regclass('public.categories') is null then
    raise exception 'public.categories missing — run 002 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role missing — run 010 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Tables
-- ============================================================

create table if not exists public.analytics_sessions (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null,
  profile_id uuid null references public.profiles (id) on delete set null,
  customer_id uuid null references public.customers (id) on delete set null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz null,
  is_new_visitor boolean not null default false,
  utm_source text null,
  utm_medium text null,
  utm_campaign text null,
  referrer text null,
  traffic_source text not null default 'direct',
  landing_page text null,
  created_at timestamptz not null default now(),
  constraint analytics_sessions_traffic_source_check check (
    traffic_source in (
      'direct',
      'instagram',
      'google',
      'whatsapp',
      'other',
      'referral'
    )
  )
);

comment on table public.analytics_sessions is
  'Anonymous/authenticated browsing sessions. id IS session_id. Access via security definer RPCs only. profile_id once set cannot change to another user.';
comment on column public.analytics_sessions.is_new_visitor is
  'True when this is the first analytics_sessions row for visitor_id.';
comment on column public.analytics_sessions.referrer is
  'Host/path only, truncated. Never full query strings or cookies.';
comment on column public.analytics_sessions.traffic_source is
  'Set ONLY on session CREATE via server classify(utm, referrer). Never accepted from client as traffic_source.';
comment on column public.analytics_sessions.profile_id is
  'Immutable once set to a non-null value (cannot reassign to another profile). May be nulled by admin anonymize.';

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null,
  session_id uuid not null references public.analytics_sessions (id) on delete cascade,
  profile_id uuid null references public.profiles (id) on delete set null,
  customer_id uuid null references public.customers (id) on delete set null,
  event_type text not null,
  page text null,
  product_id uuid null references public.products (id) on delete set null,
  category_id uuid null references public.categories (id) on delete set null,
  order_id uuid null references public.orders (id) on delete set null,
  document_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  client_event_id uuid null,
  source text not null default 'client',
  created_at timestamptz not null default now(),
  constraint analytics_events_event_type_check check (
    event_type in (
      'page_view',
      'catalog_open',
      'category_open',
      'product_view',
      'search',
      'favorite_add',
      'favorite_remove',
      'cart_add',
      'cart_remove',
      'checkout_start',
      'login',
      'register',
      'order_created',
      'order_cancelled',
      'invoice_open',
      'delivery_note_open',
      'document_download'
    )
  ),
  constraint analytics_events_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint analytics_events_source_check check (source in ('client', 'server'))
);

-- Optional FK to order_documents when that table exists (014+)
do $$
begin
  if to_regclass('public.order_documents') is not null
     and not exists (
       select 1
       from pg_constraint
       where conname = 'analytics_events_document_id_fkey'
         and conrelid = 'public.analytics_events'::regclass
     )
  then
    alter table public.analytics_events
      add constraint analytics_events_document_id_fkey
      foreign key (document_id)
      references public.order_documents (id)
      on delete set null;
  end if;
end
$$;

comment on table public.analytics_events is
  'Behavioral telemetry. CLIENT types via analytics_track_events; AUTHORITATIVE via analytics_record_* only. Idempotent via client_event_id.';
comment on column public.analytics_events.client_event_id is
  'Client/server-generated idempotency key. Unique when present.';
comment on column public.analytics_events.source is
  'Who wrote the row: client (track_events) or server (authoritative RPCs).';
comment on column public.analytics_events.document_id is
  'Optional link to order_documents for invoice/delivery_note/download events.';
comment on column public.analytics_events.metadata is
  'Whitelisted keys only per event_type (see analytics_whitelist_metadata).';

-- ============================================================
-- 2. Indexes (lean)
-- ============================================================

create unique index if not exists analytics_events_client_event_id_uidx
  on public.analytics_events (client_event_id)
  where client_event_id is not null;

create unique index if not exists analytics_events_order_event_uidx
  on public.analytics_events (event_type, order_id)
  where event_type in ('order_created', 'order_cancelled')
    and order_id is not null;

create unique index if not exists analytics_events_document_event_uidx
  on public.analytics_events (event_type, document_id)
  where event_type in ('invoice_open', 'delivery_note_open', 'document_download')
    and document_id is not null;

create index if not exists analytics_events_session_created_at_idx
  on public.analytics_events (session_id, created_at);

create index if not exists analytics_events_visitor_created_at_idx
  on public.analytics_events (visitor_id, created_at);

create index if not exists analytics_events_profile_created_at_idx
  on public.analytics_events (profile_id, created_at)
  where profile_id is not null;

create index if not exists analytics_events_customer_created_at_idx
  on public.analytics_events (customer_id, created_at)
  where customer_id is not null;

create index if not exists analytics_events_type_created_at_idx
  on public.analytics_events (event_type, created_at desc);

create index if not exists analytics_events_product_type_created_at_idx
  on public.analytics_events (product_id, event_type, created_at)
  where product_id is not null;

create index if not exists analytics_events_source_type_created_at_idx
  on public.analytics_events (source, event_type, created_at)
  where source = 'server';

create index if not exists analytics_sessions_last_seen_at_idx
  on public.analytics_sessions (last_seen_at desc);

create index if not exists analytics_sessions_visitor_id_idx
  on public.analytics_sessions (visitor_id);

create index if not exists analytics_sessions_profile_id_idx
  on public.analytics_sessions (profile_id)
  where profile_id is not null;

create index if not exists analytics_sessions_customer_id_idx
  on public.analytics_sessions (customer_id)
  where customer_id is not null;

create index if not exists analytics_sessions_started_at_idx
  on public.analytics_sessions (started_at desc);

create index if not exists analytics_sessions_traffic_source_started_at_idx
  on public.analytics_sessions (traffic_source, started_at desc);

-- Manager scope helpers (safe if already present)
create index if not exists orders_customer_assigned_manager_idx
  on public.orders (customer_id, assigned_manager_id)
  where assigned_manager_id is not null;

create index if not exists customers_created_by_idx
  on public.customers (created_by)
  where created_by is not null;

-- ============================================================
-- 3. RLS — deny direct access; RPCs only
-- ============================================================

alter table public.analytics_sessions enable row level security;
alter table public.analytics_events enable row level security;

revoke all on table public.analytics_sessions from public;
revoke all on table public.analytics_sessions from anon;
revoke all on table public.analytics_sessions from authenticated;

revoke all on table public.analytics_events from public;
revoke all on table public.analytics_events from anon;
revoke all on table public.analytics_events from authenticated;

-- Immutable profile_id once linked (null → X ok; X → Y rejected; X → null ok for anonymize)
create or replace function public.analytics_sessions_protect_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.profile_id is not null
     and new.profile_id is not null
     and new.profile_id is distinct from old.profile_id
  then
    raise exception 'profile_id сессии неизменяем после привязки';
  end if;
  return new;
end;
$$;

revoke all on function public.analytics_sessions_protect_profile() from public;
revoke all on function public.analytics_sessions_protect_profile() from anon;
revoke all on function public.analytics_sessions_protect_profile() from authenticated;

drop trigger if exists analytics_sessions_protect_profile_trg
  on public.analytics_sessions;

create trigger analytics_sessions_protect_profile_trg
  before update on public.analytics_sessions
  for each row
  execute function public.analytics_sessions_protect_profile();

-- ============================================================
-- 4. Internal helpers (NO EXECUTE grant)
-- ============================================================

create or replace function public.analytics_assert_admin()
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
    raise exception 'Аналитика трафика доступна только администратору';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.analytics_assert_admin() from public;
revoke all on function public.analytics_assert_admin() from anon;
revoke all on function public.analytics_assert_admin() from authenticated;

comment on function public.analytics_assert_admin() is
  'Internal: require active admin for traffic analytics RPCs. No GRANT.';

create or replace function public.analytics_assert_staff_analytics()
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

  if not public.has_staff_role(array['admin', 'manager']::public.user_role[]) then
    raise exception 'Аналитика доступна только администратору или менеджеру';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.analytics_assert_staff_analytics() from public;
revoke all on function public.analytics_assert_staff_analytics() from anon;
revoke all on function public.analytics_assert_staff_analytics() from authenticated;

comment on function public.analytics_assert_staff_analytics() is
  'Internal: require active admin or manager. No GRANT.';

create or replace function public.analytics_assert_manager()
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

  if not public.has_staff_role(array['manager']::public.user_role[]) then
    raise exception 'Онлайн-клиенты доступны только менеджеру';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.analytics_assert_manager() from public;
revoke all on function public.analytics_assert_manager() from anon;
revoke all on function public.analytics_assert_manager() from authenticated;

comment on function public.analytics_assert_manager() is
  'Internal: require active manager. No GRANT.';

create or replace function public.analytics_can_view_customer(p_customer_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if p_customer_id is null or v_uid is null then
    return false;
  end if;

  if public.has_staff_role(array['admin']::public.user_role[]) then
    return true;
  end if;

  if public.has_staff_role(array['manager']::public.user_role[]) then
    return exists (
      select 1
      from public.customers as c
      where c.id = p_customer_id
        and c.created_by = v_uid
    )
    or exists (
      select 1
      from public.orders as o
      where o.customer_id = p_customer_id
        and o.assigned_manager_id = v_uid
    );
  end if;

  return exists (
    select 1
    from public.customers as c
    where c.id = p_customer_id
      and c.profile_id = v_uid
  );
end;
$$;

revoke all on function public.analytics_can_view_customer(uuid) from public;
revoke all on function public.analytics_can_view_customer(uuid) from anon;
revoke all on function public.analytics_can_view_customer(uuid) from authenticated;

comment on function public.analytics_can_view_customer(uuid) is
  'Internal: admin always; manager if created_by or assigned order; client if own profile. No GRANT.';

create or replace function public.analytics_resolve_customer_id(p_profile_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.customers as c
  where c.profile_id = p_profile_id
  limit 1;
$$;

revoke all on function public.analytics_resolve_customer_id(uuid) from public;
revoke all on function public.analytics_resolve_customer_id(uuid) from anon;
revoke all on function public.analytics_resolve_customer_id(uuid) from authenticated;

comment on function public.analytics_resolve_customer_id(uuid) is
  'Internal: resolve customers.id from profiles.id. No GRANT.';

create or replace function public.analytics_is_client_event_type(p_event_type text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_event_type in (
    'page_view',
    'catalog_open',
    'category_open',
    'product_view',
    'search',
    'favorite_add',
    'favorite_remove',
    'cart_add',
    'cart_remove',
    'checkout_start'
  );
$$;

revoke all on function public.analytics_is_client_event_type(text) from public;
revoke all on function public.analytics_is_client_event_type(text) from anon;
revoke all on function public.analytics_is_client_event_type(text) from authenticated;

comment on function public.analytics_is_client_event_type(text) is
  'Internal: CLIENT_ALLOWED event types for analytics_track_events. No GRANT.';

create or replace function public.analytics_is_authoritative_event_type(p_event_type text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_event_type in (
    'login',
    'register',
    'order_created',
    'order_cancelled',
    'invoice_open',
    'delivery_note_open',
    'document_download'
  );
$$;

revoke all on function public.analytics_is_authoritative_event_type(text) from public;
revoke all on function public.analytics_is_authoritative_event_type(text) from anon;
revoke all on function public.analytics_is_authoritative_event_type(text) from authenticated;

comment on function public.analytics_is_authoritative_event_type(text) is
  'Internal: AUTHORITATIVE types — never accepted via analytics_track_events. No GRANT.';

-- Back-compat alias used by older comments / tooling
create or replace function public.analytics_is_allowed_event_type(p_event_type text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select public.analytics_is_client_event_type(p_event_type)
      or public.analytics_is_authoritative_event_type(p_event_type);
$$;

revoke all on function public.analytics_is_allowed_event_type(text) from public;
revoke all on function public.analytics_is_allowed_event_type(text) from anon;
revoke all on function public.analytics_is_allowed_event_type(text) from authenticated;

create or replace function public.analytics_is_sensitive_meta_key(p_key text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(
    lower(p_key) ~ '(password|passwd|token|jwt|card|cvv|cookie|authorization|apikey|api_key|secret|service_role|access_token|refresh_token|session_id|visitor_id|profile_id|customer_id|user_id|email|phone|iin|bin)',
    false
  );
$$;

revoke all on function public.analytics_is_sensitive_meta_key(text) from public;
revoke all on function public.analytics_is_sensitive_meta_key(text) from anon;
revoke all on function public.analytics_is_sensitive_meta_key(text) from authenticated;

create or replace function public.analytics_sanitize_search_query(p_query text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_clean text;
  v_digits text;
begin
  v_raw := nullif(trim(p_query), '');
  if v_raw is null then
    return null;
  end if;

  -- Remove control characters
  v_clean := regexp_replace(v_raw, '[[:cntrl:]]', '', 'g');
  v_clean := nullif(trim(v_clean), '');
  if v_clean is null then
    return null;
  end if;

  v_clean := left(v_clean, 80);

  -- Email-like
  if v_clean ~* '[^@\s]+@[^@\s]+\.[^@\s]+' then
    return '[redacted_email]';
  end if;

  -- IIN/BIN: exactly 12 digits (allow spaces/dashes in input)
  v_digits := regexp_replace(v_clean, '[^0-9]', '', 'g');
  if length(v_digits) = 12 and v_clean ~ '^[0-9\s\-]+$' then
    return '[redacted_id]';
  end if;

  -- Phone-like: 10+ digits
  if length(v_digits) >= 10 then
    return '[redacted_phone]';
  end if;

  return v_clean;
end;
$$;

revoke all on function public.analytics_sanitize_search_query(text) from public;
revoke all on function public.analytics_sanitize_search_query(text) from anon;
revoke all on function public.analytics_sanitize_search_query(text) from authenticated;

comment on function public.analytics_sanitize_search_query(text) is
  'Internal: trim/max 80, strip controls, redact email/phone/IIN. No GRANT.';

create or replace function public.analytics_whitelist_metadata(
  p_event_type text,
  p_meta jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_in jsonb;
  v_out jsonb := '{}'::jsonb;
  v_key text;
  v_val jsonb;
  v_text text;
  v_qty integer;
begin
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' then
    v_in := '{}'::jsonb;
  else
    v_in := p_meta;
  end if;

  -- Always drop sensitive keys from input first
  for v_key, v_val in
    select key, value from jsonb_each(v_in)
  loop
    if public.analytics_is_sensitive_meta_key(v_key) then
      v_in := v_in - v_key;
    end if;
  end loop;

  if p_event_type in ('page_view', 'catalog_open', 'checkout_start') then
    return '{}'::jsonb;
  end if;

  if p_event_type = 'category_open' then
    v_text := nullif(trim(v_in ->> 'category_name'), '');
    if v_text is not null then
      v_out := jsonb_build_object('category_name', left(v_text, 100));
    end if;
    return v_out;
  end if;

  if p_event_type = 'product_view' then
    -- static_product_id only if caller will store with null product_id
    -- (caller passes flag via sentinel key __product_id_null — prefer checking outside)
    v_text := nullif(trim(v_in ->> 'static_product_id'), '');
    if v_text is not null then
      v_out := jsonb_build_object('static_product_id', left(v_text, 80));
    end if;
    return v_out;
  end if;

  if p_event_type = 'search' then
    v_text := public.analytics_sanitize_search_query(
      coalesce(v_in ->> 'query', v_in ->> 'q')
    );
    if v_text is not null then
      v_out := jsonb_build_object('query', v_text);
    end if;
    return v_out;
  end if;

  if p_event_type in ('favorite_add', 'favorite_remove') then
    v_text := nullif(trim(v_in ->> 'sku'), '');
    if v_text is not null then
      v_out := v_out || jsonb_build_object('sku', left(v_text, 64));
    end if;
    return v_out;
  end if;

  if p_event_type in ('cart_add', 'cart_remove') then
    begin
      v_qty := (v_in ->> 'quantity')::integer;
    exception
      when others then
        v_qty := null;
    end;
    if v_qty is not null and v_qty >= 1 and v_qty <= 9999 then
      v_out := v_out || jsonb_build_object('quantity', v_qty);
    end if;

    v_text := nullif(trim(v_in ->> 'sku'), '');
    if v_text is not null then
      v_out := v_out || jsonb_build_object('sku', left(v_text, 64));
    end if;

    v_text := nullif(trim(v_in ->> 'static_product_id'), '');
    if v_text is not null then
      v_out := v_out || jsonb_build_object('static_product_id', left(v_text, 80));
    end if;
    return v_out;
  end if;

  if p_event_type in ('invoice_open', 'delivery_note_open', 'document_download') then
    v_text := nullif(trim(v_in ->> 'document_type'), '');
    if v_text is not null and v_text in ('invoice', 'delivery_note') then
      v_out := v_out || jsonb_build_object('document_type', v_text);
    end if;
    v_text := nullif(trim(v_in ->> 'number'), '');
    if v_text is not null then
      v_out := v_out || jsonb_build_object('number', left(v_text, 64));
    end if;
    return v_out;
  end if;

  -- login/register/order_*: no client metadata
  return '{}'::jsonb;
end;
$$;

revoke all on function public.analytics_whitelist_metadata(text, jsonb) from public;
revoke all on function public.analytics_whitelist_metadata(text, jsonb) from anon;
revoke all on function public.analytics_whitelist_metadata(text, jsonb) from authenticated;

comment on function public.analytics_whitelist_metadata(text, jsonb) is
  'Internal: per-event_type metadata whitelist + always strip sensitive keys. No GRANT.';

create or replace function public.analytics_sanitize_referrer(p_referrer text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_no_frag text;
  v_no_query text;
  v_hostpath text;
begin
  v_raw := nullif(trim(p_referrer), '');
  if v_raw is null then
    return null;
  end if;

  v_no_frag := split_part(v_raw, '#', 1);
  v_no_query := split_part(v_no_frag, '?', 1);

  if v_no_query ~* '^https?://' then
    v_hostpath := regexp_replace(v_no_query, '^https?://', '', 'i');
  else
    v_hostpath := v_no_query;
  end if;

  v_hostpath := nullif(trim(v_hostpath), '');
  if v_hostpath is null then
    return null;
  end if;

  return left(v_hostpath, 300);
end;
$$;

revoke all on function public.analytics_sanitize_referrer(text) from public;
revoke all on function public.analytics_sanitize_referrer(text) from anon;
revoke all on function public.analytics_sanitize_referrer(text) from authenticated;

create or replace function public.analytics_sanitize_page(p_page text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_clean text;
  v_lower text;
begin
  v_raw := nullif(trim(p_page), '');
  if v_raw is null then
    return null;
  end if;

  v_lower := lower(v_raw);
  -- Block token-like query params even before stripping
  if v_lower ~ '(token=|access_token|refresh_token|id_token|api_key=|apikey=|authorization=|bearer )' then
    return null;
  end if;

  -- Path only: drop fragment and query entirely
  v_clean := split_part(split_part(v_raw, '#', 1), '?', 1);
  v_clean := nullif(trim(v_clean), '');
  if v_clean is null then
    return null;
  end if;

  -- Strip scheme/host if absolute URL slipped in
  if v_clean ~* '^https?://' then
    v_clean := regexp_replace(v_clean, '^https?://[^/]+', '', 'i');
    if v_clean = '' then
      v_clean := '/';
    end if;
  end if;

  -- Privacy: replace UUID segments in known private routes
  v_clean := regexp_replace(
    v_clean,
    '/orders/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    '/orders/[id]',
    'gi'
  );
  v_clean := regexp_replace(
    v_clean,
    '/product/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    '/product/[id]',
    'gi'
  );
  v_clean := regexp_replace(
    v_clean,
    '/staff/customers/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
    '/staff/customers/[id]',
    'gi'
  );

  return left(v_clean, 300);
end;
$$;

revoke all on function public.analytics_sanitize_page(text) from public;
revoke all on function public.analytics_sanitize_page(text) from anon;
revoke all on function public.analytics_sanitize_page(text) from authenticated;

comment on function public.analytics_sanitize_page(text) is
  'Internal: path-only max 300; redact /orders|/product UUIDs; block token query paths. No GRANT.';

create or replace function public.analytics_sanitize_page_for_display(p_page text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_page text;
begin
  v_page := public.analytics_sanitize_page(p_page);
  if v_page is null then
    return null;
  end if;

  -- Never expose search pages with residual query text in path
  if lower(v_page) ~ '^/?(catalog/)?search' then
    return '/search';
  end if;

  -- Guests / online views: only public-ish prefixes
  if v_page !~* '^/(catalog|product|category|cart|checkout|favorites|login|register|about|contacts)?(/|$)'
     and v_page !~* '^/orders/\[id\]'
     and v_page <> '/'
  then
    -- Keep staff paths only as generic label for admin online list
    if lower(v_page) like '/staff%' then
      return '/staff';
    end if;
  end if;

  return v_page;
end;
$$;

revoke all on function public.analytics_sanitize_page_for_display(text) from public;
revoke all on function public.analytics_sanitize_page_for_display(text) from anon;
revoke all on function public.analytics_sanitize_page_for_display(text) from authenticated;

create or replace function public.analytics_classify_traffic(
  p_utm_source text,
  p_referrer text
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_utm text := lower(coalesce(nullif(trim(p_utm_source), ''), ''));
  v_ref text := lower(coalesce(nullif(trim(p_referrer), ''), ''));
begin
  if v_utm <> '' then
    if v_utm ~ '(instagram|ig)' then
      return 'instagram';
    elsif v_utm ~ 'google' then
      return 'google';
    elsif v_utm ~ '(whatsapp|wa\.me)' then
      return 'whatsapp';
    else
      return 'other';
    end if;
  end if;

  if v_ref <> '' then
    if v_ref ~ '(instagram\.com|l\.instagram\.com)' then
      return 'instagram';
    elsif v_ref ~ '(google\.|googleapis\.|googleusercontent\.)' then
      return 'google';
    elsif v_ref ~ '(whatsapp\.com|wa\.me)' then
      return 'whatsapp';
    else
      return 'referral';
    end if;
  end if;

  return 'direct';
end;
$$;

revoke all on function public.analytics_classify_traffic(text, text) from public;
revoke all on function public.analytics_classify_traffic(text, text) from anon;
revoke all on function public.analytics_classify_traffic(text, text) from authenticated;

comment on function public.analytics_classify_traffic(text, text) is
  'Internal: map utm_source/referrer → direct|instagram|google|whatsapp|other|referral. No GRANT.';

/**
 * Resolve Almaty day bounds for analytics periods.
 * null/null → today in Asia/Almaty.
 * Inclusive end day: ts_to exclusive start of (date_to + 1) Almaty.
 * Max span: 366 days inclusive.
 */
create or replace function public.analytics_almaty_day_bounds(
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
    v_from := v_today;
    v_to := v_today;
  elsif p_date_from is null or p_date_to is null then
    raise exception 'Укажите обе даты периода или оставьте обе пустыми (сегодня)';
  else
    v_from := p_date_from;
    v_to := p_date_to;
  end if;

  if v_from > v_to then
    raise exception 'date_from (%) не может быть позже date_to (%)', v_from, v_to;
  end if;

  v_span := (v_to - v_from) + 1;
  if v_span > 366 then
    raise exception 'Максимальный диапазон аналитики — 366 дней (запрошено %)', v_span;
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

revoke all on function public.analytics_almaty_day_bounds(date, date) from public;
revoke all on function public.analytics_almaty_day_bounds(date, date) from anon;
revoke all on function public.analytics_almaty_day_bounds(date, date) from authenticated;

comment on function public.analytics_almaty_day_bounds(date, date) is
  'Internal: Asia/Almaty period bounds; null/null = today. No GRANT.';

create or replace function public.analytics_assert_order_owner(p_order_id uuid)
returns public.orders
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders%rowtype;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;
  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order
  from public.orders as o
  where o.id = p_order_id;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.user_id is not distinct from v_uid
     or v_order.profile_id is not distinct from v_uid
     or exists (
       select 1
       from public.customers as c
       where c.id = v_order.customer_id
         and c.profile_id = v_uid
     )
  then
    return v_order;
  end if;

  raise exception 'Нет доступа к этому заказу';
end;
$$;

revoke all on function public.analytics_assert_order_owner(uuid) from public;
revoke all on function public.analytics_assert_order_owner(uuid) from anon;
revoke all on function public.analytics_assert_order_owner(uuid) from authenticated;

comment on function public.analytics_assert_order_owner(uuid) is
  'Internal: verify order ownership via user_id/profile_id/customer.profile_id. No GRANT.';

/**
 * Ensure session exists for visitor; enforce ownership / link rules.
 * Does not accept traffic_source from client — classify on CREATE only.
 */
create or replace function public.analytics_ensure_session(
  p_visitor_id uuid,
  p_session_id uuid,
  p_session jsonb default null,
  p_link_profile boolean default true
)
returns public.analytics_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_session public.analytics_sessions%rowtype;
  v_is_new boolean := false;
  v_utm_source text;
  v_utm_medium text;
  v_utm_campaign text;
  v_referrer text;
  v_landing_page text;
  v_traffic_source text;
  v_profile_id uuid;
begin
  if p_visitor_id is null then
    raise exception 'visitor_id обязателен';
  end if;
  if p_session_id is null then
    raise exception 'session_id обязателен';
  end if;

  if v_uid is not null and p_link_profile then
    v_profile_id := v_uid;
    v_customer_id := public.analytics_resolve_customer_id(v_uid);
  end if;

  if p_session is not null and jsonb_typeof(p_session) = 'object' then
    -- Never accept traffic_source / profile_id / customer_id from payload
    v_utm_source := left(nullif(trim(p_session ->> 'utm_source'), ''), 200);
    v_utm_medium := left(nullif(trim(p_session ->> 'utm_medium'), ''), 200);
    v_utm_campaign := left(nullif(trim(p_session ->> 'utm_campaign'), ''), 200);
    v_referrer := public.analytics_sanitize_referrer(p_session ->> 'referrer');
    v_landing_page := public.analytics_sanitize_page(p_session ->> 'landing_page');
  end if;

  v_traffic_source := public.analytics_classify_traffic(v_utm_source, v_referrer);

  select * into v_session
  from public.analytics_sessions as s
  where s.id = p_session_id;

  if not found then
    select not exists (
      select 1
      from public.analytics_sessions as s
      where s.visitor_id = p_visitor_id
    )
    into v_is_new;

    begin
      insert into public.analytics_sessions (
        id,
        visitor_id,
        profile_id,
        customer_id,
        started_at,
        last_seen_at,
        is_new_visitor,
        utm_source,
        utm_medium,
        utm_campaign,
        referrer,
        traffic_source,
        landing_page
      ) values (
        p_session_id,
        p_visitor_id,
        v_profile_id,
        v_customer_id,
        now(),
        now(),
        v_is_new,
        v_utm_source,
        v_utm_medium,
        v_utm_campaign,
        v_referrer,
        v_traffic_source,
        v_landing_page
      )
      returning * into v_session;
    exception
      when unique_violation then
        select * into v_session
        from public.analytics_sessions as s
        where s.id = p_session_id;

        if not found or v_session.visitor_id is distinct from p_visitor_id then
          raise exception 'session_id не принадлежит visitor_id';
        end if;
    end;
  else
    if v_session.visitor_id is distinct from p_visitor_id then
      raise exception 'session_id не принадлежит visitor_id';
    end if;
  end if;

  -- Cross-account reuse guard
  if v_session.profile_id is not null
     and v_uid is not null
     and v_session.profile_id is distinct from v_uid
  then
    raise exception 'Сессия принадлежит другому пользователю';
  end if;

  -- Update last_seen (throttled) + link profile only when unlinked / matching
  update public.analytics_sessions as s
  set
    last_seen_at = case
      when s.last_seen_at < now() - interval '15 seconds' then now()
      else s.last_seen_at
    end,
    profile_id = case
      when s.profile_id is null and v_profile_id is not null then v_profile_id
      else s.profile_id
    end,
    customer_id = case
      when s.customer_id is null and v_customer_id is not null
           and (s.profile_id is null or s.profile_id is not distinct from coalesce(v_profile_id, s.profile_id))
        then v_customer_id
      when s.customer_id is null
           and v_customer_id is not null
           and s.profile_id is not distinct from v_uid
        then v_customer_id
      else s.customer_id
    end,
    -- UTM/referrer/landing: fill only if previously null (never overwrite)
    utm_source = coalesce(s.utm_source, v_utm_source),
    utm_medium = coalesce(s.utm_medium, v_utm_medium),
    utm_campaign = coalesce(s.utm_campaign, v_utm_campaign),
    referrer = coalesce(s.referrer, v_referrer),
    landing_page = coalesce(s.landing_page, v_landing_page)
    -- traffic_source: NEVER update after create
  where s.id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

revoke all on function public.analytics_ensure_session(uuid, uuid, jsonb, boolean) from public;
revoke all on function public.analytics_ensure_session(uuid, uuid, jsonb, boolean) from anon;
revoke all on function public.analytics_ensure_session(uuid, uuid, jsonb, boolean) from authenticated;

comment on function public.analytics_ensure_session(uuid, uuid, jsonb, boolean) is
  'Internal: create/update session; traffic_source on create only; profile link immutable. No GRANT.';

create or replace function public.analytics_product_exists(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.products as p where p.id = p_product_id
  );
$$;

revoke all on function public.analytics_product_exists(uuid) from public;
revoke all on function public.analytics_product_exists(uuid) from anon;
revoke all on function public.analytics_product_exists(uuid) from authenticated;

create or replace function public.analytics_category_exists(p_category_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.categories as c where c.id = p_category_id
  );
$$;

revoke all on function public.analytics_category_exists(uuid) from public;
revoke all on function public.analytics_category_exists(uuid) from anon;
revoke all on function public.analytics_category_exists(uuid) from authenticated;

-- ============================================================
-- 5. Public write RPCs — client ingest
-- ============================================================

create or replace function public.analytics_track_events(
  p_visitor_id uuid,
  p_session_id uuid,
  p_events jsonb,
  p_session jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_session public.analytics_sessions%rowtype;
  v_event jsonb;
  v_client_event_id uuid;
  v_event_type text;
  v_page text;
  v_product_id uuid;
  v_category_id uuid;
  v_metadata jsonb;
  v_raw_meta jsonb;
  v_accepted integer := 0;
  v_skipped integer := 0;
  v_rejected integer := 0;
  v_event_count integer;
  v_recent_count bigint;
  v_profile_id uuid;
  v_payload_bytes integer;
  v_lock_key bigint;
begin
  if p_visitor_id is null then
    raise exception 'visitor_id обязателен';
  end if;
  if p_session_id is null then
    raise exception 'session_id обязателен';
  end if;

  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'events должен быть JSON-массивом';
  end if;

  v_event_count := jsonb_array_length(p_events);
  if v_event_count > 40 then
    raise exception 'Максимум 40 событий за вызов (получено %)', v_event_count;
  end if;

  v_payload_bytes := octet_length(p_events::text);
  if v_payload_bytes > 32000 then
    raise exception 'Слишком большой пакет событий (% байт, лимит 32000)', v_payload_bytes;
  end if;

  -- Serialize concurrent batches for the same session (advisory lock).
  -- hashtext is stable for uuid::text within a DB.
  v_lock_key := hashtext(p_session_id::text);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Rate limit AFTER lock, BEFORE inserts
  select count(*)
  into v_recent_count
  from public.analytics_events as e
  where e.session_id = p_session_id
    and e.created_at > now() - interval '1 minute';

  if v_recent_count >= 120 then
    raise exception 'Слишком много событий';
  end if;

  -- Also reject if this batch alone would exceed the remaining budget
  if v_recent_count + v_event_count > 120 then
    raise exception 'Слишком много событий';
  end if;

  -- Identity ONLY from auth — never from event payload
  if v_uid is not null then
    v_profile_id := v_uid;
    v_customer_id := public.analytics_resolve_customer_id(v_uid);
  end if;

  v_session := public.analytics_ensure_session(
    p_visitor_id,
    p_session_id,
    p_session,
    true
  );

  if v_event_count = 0 then
    return jsonb_build_object(
      'accepted', 0,
      'accepted_count', 0,
      'skipped', 0,
      'rejected', 0,
      'rejected_count', 0,
      'rate_limited', false
    );
  end if;

  for v_event in
    select value from jsonb_array_elements(p_events) as t(value)
  loop
    if jsonb_typeof(v_event) <> 'object' then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    v_event_type := nullif(trim(v_event ->> 'event_type'), '');

    -- Unknown / authoritative / non-client types → rejected (not inserted)
    if v_event_type is null
       or not public.analytics_is_client_event_type(v_event_type)
    then
      v_rejected := v_rejected + 1;
      continue;
    end if;

    begin
      v_client_event_id := nullif(v_event ->> 'client_event_id', '')::uuid;
    exception
      when others then
        v_rejected := v_rejected + 1;
        continue;
    end;

    if v_client_event_id is not null
       and exists (
         select 1
         from public.analytics_events as e
         where e.client_event_id = v_client_event_id
       )
    then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    begin
      v_product_id := nullif(v_event ->> 'product_id', '')::uuid;
      v_category_id := nullif(v_event ->> 'category_id', '')::uuid;
    exception
      when others then
        v_rejected := v_rejected + 1;
        continue;
    end;

    if v_product_id is not null
       and not public.analytics_product_exists(v_product_id)
    then
      v_product_id := null;
    end if;

    if v_category_id is not null
       and not public.analytics_category_exists(v_category_id)
    then
      v_category_id := null;
    end if;

    v_page := public.analytics_sanitize_page(v_event ->> 'page');

    v_raw_meta := case
      when v_event ? 'metadata' and jsonb_typeof(v_event -> 'metadata') = 'object'
        then v_event -> 'metadata'
      else '{}'::jsonb
    end;

    v_metadata := public.analytics_whitelist_metadata(v_event_type, v_raw_meta);

    if v_event_type = 'product_view' and v_product_id is not null then
      v_metadata := v_metadata - 'static_product_id';
    end if;

    begin
      insert into public.analytics_events (
        visitor_id,
        session_id,
        profile_id,
        customer_id,
        event_type,
        page,
        product_id,
        category_id,
        order_id,
        document_id,
        metadata,
        client_event_id,
        source,
        created_at
      ) values (
        p_visitor_id,
        p_session_id,
        coalesce(v_session.profile_id, v_profile_id),
        coalesce(v_session.customer_id, v_customer_id),
        v_event_type,
        v_page,
        v_product_id,
        v_category_id,
        null,
        null,
        v_metadata,
        v_client_event_id,
        'client',
        now()
      );
      v_accepted := v_accepted + 1;
    exception
      when unique_violation then
        v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'accepted', v_accepted,
    'accepted_count', v_accepted,
    'skipped', v_skipped,
    'rejected', v_rejected,
    'rejected_count', v_rejected,
    'rate_limited', false
  );
end;
$$;

revoke all on function public.analytics_track_events(uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.analytics_track_events(uuid, uuid, jsonb, jsonb) to anon;
grant execute on function public.analytics_track_events(uuid, uuid, jsonb, jsonb) to authenticated;

comment on function public.analytics_track_events(uuid, uuid, jsonb, jsonb) is
  'CLIENT_ALLOWED only. Advisory lock per session + 120/min. Returns accepted_count/rejected_count. Unknown types rejected.';

-- ============================================================
-- 6. Authoritative write RPCs (authenticated only)
-- ============================================================

create or replace function public.analytics_record_auth_event(
  p_visitor_id uuid,
  p_session_id uuid,
  p_event_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_session public.analytics_sessions%rowtype;
  v_event_id uuid;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_event_type is null
     or p_event_type not in ('login', 'register')
  then
    raise exception 'event_type должен быть login или register';
  end if;

  v_customer_id := public.analytics_resolve_customer_id(v_uid);
  v_session := public.analytics_ensure_session(
    p_visitor_id,
    p_session_id,
    null,
    true
  );

  insert into public.analytics_events (
    visitor_id,
    session_id,
    profile_id,
    customer_id,
    event_type,
    page,
    product_id,
    category_id,
    order_id,
    document_id,
    metadata,
    client_event_id,
    source,
    created_at
  ) values (
    p_visitor_id,
    p_session_id,
    v_uid,
    v_customer_id,
    p_event_type,
    null,
    null,
    null,
    null,
    null,
    '{}'::jsonb,
    gen_random_uuid(),
    'server',
    now()
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'event_type', p_event_type,
    'source', 'server'
  );
end;
$$;

revoke all on function public.analytics_record_auth_event(uuid, uuid, text) from public;
revoke all on function public.analytics_record_auth_event(uuid, uuid, text) from anon;
grant execute on function public.analytics_record_auth_event(uuid, uuid, text) to authenticated;

comment on function public.analytics_record_auth_event(uuid, uuid, text) is
  'Authoritative login/register event (source=server). Authenticated only.';

create or replace function public.analytics_record_order_event(
  p_order_id uuid,
  p_visitor_id uuid,
  p_session_id uuid,
  p_event_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_order public.orders%rowtype;
  v_session public.analytics_sessions%rowtype;
  v_event_id uuid;
  v_existing uuid;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_event_type is null
     or p_event_type not in ('order_created', 'order_cancelled')
  then
    raise exception 'event_type должен быть order_created или order_cancelled';
  end if;

  v_order := public.analytics_assert_order_owner(p_order_id);
  v_customer_id := coalesce(
    v_order.customer_id,
    public.analytics_resolve_customer_id(v_uid)
  );

  v_session := public.analytics_ensure_session(
    p_visitor_id,
    p_session_id,
    null,
    true
  );

  select e.id into v_existing
  from public.analytics_events as e
  where e.event_type = p_event_type
    and e.order_id = p_order_id
  limit 1;

  if v_existing is not null then
    return jsonb_build_object(
      'ok', true,
      'event_id', v_existing,
      'event_type', p_event_type,
      'source', 'server',
      'idempotent', true
    );
  end if;

  begin
    insert into public.analytics_events (
      visitor_id,
      session_id,
      profile_id,
      customer_id,
      event_type,
      page,
      product_id,
      category_id,
      order_id,
      document_id,
      metadata,
      client_event_id,
      source,
      created_at
    ) values (
      p_visitor_id,
      p_session_id,
      v_uid,
      v_customer_id,
      p_event_type,
      null,
      null,
      null,
      p_order_id,
      null,
      '{}'::jsonb,
      gen_random_uuid(),
      'server',
      now()
    )
    returning id into v_event_id;
  exception
    when unique_violation then
      select e.id into v_event_id
      from public.analytics_events as e
      where e.event_type = p_event_type
        and e.order_id = p_order_id
      limit 1;

      return jsonb_build_object(
        'ok', true,
        'event_id', v_event_id,
        'event_type', p_event_type,
        'source', 'server',
        'idempotent', true
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'event_type', p_event_type,
    'source', 'server',
    'idempotent', false
  );
end;
$$;

revoke all on function public.analytics_record_order_event(uuid, uuid, uuid, text) from public;
revoke all on function public.analytics_record_order_event(uuid, uuid, uuid, text) from anon;
grant execute on function public.analytics_record_order_event(uuid, uuid, uuid, text) to authenticated;

comment on function public.analytics_record_order_event(uuid, uuid, uuid, text) is
  'Authoritative order_created/order_cancelled (source=server). Idempotent per (event_type, order_id). Authenticated + order owner.';

create or replace function public.analytics_record_document_event(
  p_order_id uuid,
  p_document_id uuid,
  p_visitor_id uuid,
  p_session_id uuid,
  p_event_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_order public.orders%rowtype;
  v_session public.analytics_sessions%rowtype;
  v_doc_type text;
  v_doc_number text;
  v_meta jsonb := '{}'::jsonb;
  v_event_id uuid;
  v_existing uuid;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_event_type is null
     or p_event_type not in (
       'invoice_open',
       'delivery_note_open',
       'document_download'
     )
  then
    raise exception 'Недопустимый event_type документа';
  end if;

  if p_document_id is null then
    raise exception 'document_id обязателен';
  end if;

  v_order := public.analytics_assert_order_owner(p_order_id);
  v_customer_id := coalesce(
    v_order.customer_id,
    public.analytics_resolve_customer_id(v_uid)
  );

  -- Resolve document from DB (never trust client metadata)
  if to_regclass('public.order_documents') is null then
    raise exception 'order_documents отсутствует';
  end if;

  select d.document_type, d.number
  into v_doc_type, v_doc_number
  from public.order_documents as d
  where d.id = p_document_id
    and d.order_id = p_order_id;

  if not found then
    raise exception 'Документ не принадлежит заказу';
  end if;

  v_meta := public.analytics_whitelist_metadata(
    p_event_type,
    jsonb_build_object(
      'document_type', v_doc_type,
      'number', v_doc_number
    )
  );

  v_session := public.analytics_ensure_session(
    p_visitor_id,
    p_session_id,
    null,
    true
  );

  select e.id into v_existing
  from public.analytics_events as e
  where e.event_type = p_event_type
    and e.document_id = p_document_id
  limit 1;

  if v_existing is not null then
    return jsonb_build_object(
      'ok', true,
      'event_id', v_existing,
      'event_type', p_event_type,
      'source', 'server',
      'idempotent', true
    );
  end if;

  begin
    insert into public.analytics_events (
      visitor_id,
      session_id,
      profile_id,
      customer_id,
      event_type,
      page,
      product_id,
      category_id,
      order_id,
      document_id,
      metadata,
      client_event_id,
      source,
      created_at
    ) values (
      p_visitor_id,
      p_session_id,
      v_uid,
      v_customer_id,
      p_event_type,
      null,
      null,
      null,
      p_order_id,
      p_document_id,
      v_meta,
      gen_random_uuid(),
      'server',
      now()
    )
    returning id into v_event_id;
  exception
    when unique_violation then
      select e.id into v_event_id
      from public.analytics_events as e
      where e.event_type = p_event_type
        and e.document_id = p_document_id
      limit 1;

      return jsonb_build_object(
        'ok', true,
        'event_id', v_event_id,
        'event_type', p_event_type,
        'source', 'server',
        'idempotent', true
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'event_id', v_event_id,
    'event_type', p_event_type,
    'source', 'server',
    'idempotent', false
  );
end;
$$;

revoke all on function public.analytics_record_document_event(uuid, uuid, uuid, uuid, text) from public;
revoke all on function public.analytics_record_document_event(uuid, uuid, uuid, uuid, text) from anon;
grant execute on function public.analytics_record_document_event(uuid, uuid, uuid, uuid, text) to authenticated;

comment on function public.analytics_record_document_event(uuid, uuid, uuid, uuid, text) is
  'Authoritative document open/download (source=server). Metadata from DB. Authenticated + order owner.';

-- ============================================================
-- 7. Link visitor (authenticated)
-- ============================================================

create or replace function public.analytics_link_visitor(p_visitor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer_id uuid;
  v_sessions_updated integer := 0;
  v_events_updated integer := 0;
  v_linked boolean := false;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_visitor_id is null then
    raise exception 'visitor_id обязателен';
  end if;

  v_customer_id := public.analytics_resolve_customer_id(v_uid);

  -- Reject if visitor already linked to another account
  if exists (
    select 1
    from public.analytics_sessions as s
    where s.visitor_id = p_visitor_id
      and s.profile_id is not null
      and s.profile_id is distinct from v_uid
  ) then
    raise exception 'Visitor уже связан с другим аккаунтом';
  end if;

  if exists (
    select 1
    from public.analytics_events as e
    where e.visitor_id = p_visitor_id
      and e.profile_id is not null
      and e.profile_id is distinct from v_uid
  ) then
    raise exception 'Visitor уже связан с другим аккаунтом';
  end if;

  -- Set profile_id/customer_id where null only (idempotent; no transfer)
  update public.analytics_sessions as s
  set
    profile_id = coalesce(s.profile_id, v_uid),
    customer_id = coalesce(s.customer_id, v_customer_id)
  where s.visitor_id = p_visitor_id
    and (
      s.profile_id is null
      or (v_customer_id is not null and s.customer_id is null)
    );

  get diagnostics v_sessions_updated = row_count;

  update public.analytics_events as e
  set
    profile_id = coalesce(e.profile_id, v_uid),
    customer_id = coalesce(e.customer_id, v_customer_id)
  where e.visitor_id = p_visitor_id
    and (
      e.profile_id is null
      or (v_customer_id is not null and e.customer_id is null)
    );

  get diagnostics v_events_updated = row_count;

  v_linked := (v_sessions_updated > 0 or v_events_updated > 0)
    or exists (
      select 1
      from public.analytics_sessions as s
      where s.visitor_id = p_visitor_id
        and s.profile_id = v_uid
    );

  return jsonb_build_object(
    'linked', v_linked,
    'sessions_updated', v_sessions_updated,
    'events_updated', v_events_updated
  );
end;
$$;

revoke all on function public.analytics_link_visitor(uuid) from public;
revoke all on function public.analytics_link_visitor(uuid) from anon;
grant execute on function public.analytics_link_visitor(uuid) to authenticated;

comment on function public.analytics_link_visitor(uuid) is
  'Link current auth profile onto visitor sessions/events where null. Rejects cross-account. No history transfer.';

-- ============================================================
-- 8. Retention / cleanup (admin only)
-- Retention 12 months recommended; no cron in this migration.
-- ============================================================

create or replace function public.admin_analytics_cleanup(
  p_older_than_days integer default 365
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days integer;
  v_cutoff timestamptz;
  v_events_deleted integer := 0;
  v_sessions_deleted integer := 0;
begin
  perform public.analytics_assert_admin();

  v_days := coalesce(p_older_than_days, 365);
  if v_days < 30 then
    raise exception 'Минимальный срок хранения для cleanup — 30 дней';
  end if;
  if v_days > 3660 then
    raise exception 'Некорректный срок хранения';
  end if;

  v_cutoff := now() - make_interval(days => v_days);

  delete from public.analytics_events as e
  where e.created_at < v_cutoff;

  get diagnostics v_events_deleted = row_count;

  delete from public.analytics_sessions as s
  where s.started_at < v_cutoff
    and not exists (
      select 1
      from public.analytics_events as e
      where e.session_id = s.id
    );

  get diagnostics v_sessions_deleted = row_count;

  return jsonb_build_object(
    'events_deleted', v_events_deleted,
    'sessions_deleted', v_sessions_deleted,
    'older_than_days', v_days,
    'cutoff', v_cutoff
  );
end;
$$;

revoke all on function public.admin_analytics_cleanup(integer) from public;
revoke all on function public.admin_analytics_cleanup(integer) from anon;
revoke all on function public.admin_analytics_cleanup(integer) from authenticated;
grant execute on function public.admin_analytics_cleanup(integer) to authenticated;

comment on function public.admin_analytics_cleanup(integer) is
  'Admin: delete events older than N days (default 365) and orphan sessions. Retention 12 months recommended. No cron.';

create or replace function public.admin_analytics_anonymize_visitor(p_visitor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sessions integer := 0;
  v_events integer := 0;
begin
  perform public.analytics_assert_admin();

  if p_visitor_id is null then
    raise exception 'visitor_id обязателен';
  end if;

  update public.analytics_sessions as s
  set
    profile_id = null,
    customer_id = null,
    utm_source = null,
    utm_medium = null,
    utm_campaign = null,
    referrer = null,
    landing_page = null
  where s.visitor_id = p_visitor_id;

  get diagnostics v_sessions = row_count;

  update public.analytics_events as e
  set
    profile_id = null,
    customer_id = null
  where e.visitor_id = p_visitor_id;

  get diagnostics v_events = row_count;

  return jsonb_build_object(
    'visitor_id', p_visitor_id,
    'sessions_updated', v_sessions,
    'events_updated', v_events
  );
end;
$$;

revoke all on function public.admin_analytics_anonymize_visitor(uuid) from public;
revoke all on function public.admin_analytics_anonymize_visitor(uuid) from anon;
revoke all on function public.admin_analytics_anonymize_visitor(uuid) from authenticated;
grant execute on function public.admin_analytics_anonymize_visitor(uuid) to authenticated;

comment on function public.admin_analytics_anonymize_visitor(uuid) is
  'Admin: clear profile/customer links and UTM/referrer/landing for a visitor. Keeps anonymous aggregate rows.';

create or replace function public.admin_analytics_anonymize_customer(p_customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sessions integer := 0;
  v_events integer := 0;
begin
  perform public.analytics_assert_admin();

  if p_customer_id is null then
    raise exception 'customer_id обязателен';
  end if;

  update public.analytics_sessions as s
  set
    profile_id = null,
    customer_id = null
  where s.customer_id = p_customer_id;

  get diagnostics v_sessions = row_count;

  update public.analytics_events as e
  set
    profile_id = null,
    customer_id = null
  where e.customer_id = p_customer_id;

  get diagnostics v_events = row_count;

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'sessions_updated', v_sessions,
    'events_updated', v_events
  );
end;
$$;

revoke all on function public.admin_analytics_anonymize_customer(uuid) from public;
revoke all on function public.admin_analytics_anonymize_customer(uuid) from anon;
revoke all on function public.admin_analytics_anonymize_customer(uuid) from authenticated;
grant execute on function public.admin_analytics_anonymize_customer(uuid) to authenticated;

comment on function public.admin_analytics_anonymize_customer(uuid) is
  'Admin: clear customer_id/profile_id on analytics rows for that customer. Aggregate-safe anonymous rows remain.';

-- ============================================================
-- 9. Staff / admin read RPCs
-- ============================================================

create or replace function public.admin_get_traffic_summary(
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
  v_today_bounds record;
  v_unique_visitors bigint := 0;
  v_sessions_count bigint := 0;
  v_new_visitors bigint := 0;
  v_returning_visitors bigint := 0;
  v_visitors_today bigint := 0;
  v_online_now bigint := 0;
  v_product_views bigint := 0;
  v_cart_adds bigint := 0;
  v_checkout_starts bigint := 0;
  v_orders_created bigint := 0;
  v_conversion numeric := 0;
begin
  perform public.analytics_assert_admin();

  select * into v_period
  from public.analytics_almaty_day_bounds(p_date_from, p_date_to);

  select * into v_today_bounds
  from public.analytics_almaty_day_bounds(null, null);

  select count(distinct s.visitor_id)
  into v_unique_visitors
  from public.analytics_sessions as s
  where s.started_at >= v_period.ts_from
    and s.started_at < v_period.ts_to;

  select count(distinct s.id)
  into v_sessions_count
  from public.analytics_sessions as s
  where s.started_at >= v_period.ts_from
    and s.started_at < v_period.ts_to;

  select count(distinct s.visitor_id)
  into v_new_visitors
  from public.analytics_sessions as s
  where s.started_at >= v_period.ts_from
    and s.started_at < v_period.ts_to
    and s.is_new_visitor;

  v_returning_visitors := greatest(v_unique_visitors - v_new_visitors, 0);

  select count(distinct s.visitor_id)
  into v_visitors_today
  from public.analytics_sessions as s
  where s.started_at >= v_today_bounds.ts_from
    and s.started_at < v_today_bounds.ts_to;

  select count(*)
  into v_online_now
  from public.analytics_sessions as s
  where s.last_seen_at > now() - interval '5 minutes';

  select
    count(*) filter (where e.event_type = 'product_view'),
    count(*) filter (where e.event_type = 'cart_add'),
    count(*) filter (where e.event_type = 'checkout_start'),
    count(*) filter (
      where e.event_type = 'order_created'
        and e.source = 'server'
    )
  into v_product_views, v_cart_adds, v_checkout_starts, v_orders_created
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to;

  if v_unique_visitors > 0 then
    v_conversion := round(
      (v_orders_created::numeric / v_unique_visitors::numeric) * 100,
      2
    );
  end if;

  return jsonb_build_object(
    'date_from', v_period.date_from,
    'date_to', v_period.date_to,
    'timezone', 'Asia/Almaty',
    'visitors_today', v_visitors_today,
    'online_now', v_online_now,
    'unique_visitors', v_unique_visitors,
    'sessions_count', v_sessions_count,
    'new_visitors', v_new_visitors,
    'returning_visitors', v_returning_visitors,
    'product_views', v_product_views,
    'cart_adds', v_cart_adds,
    'checkout_starts', v_checkout_starts,
    'orders_created', v_orders_created,
    'conversion_rate', v_conversion
  );
end;
$$;

revoke all on function public.admin_get_traffic_summary(date, date) from public;
revoke all on function public.admin_get_traffic_summary(date, date) from anon;
revoke all on function public.admin_get_traffic_summary(date, date) from authenticated;
grant execute on function public.admin_get_traffic_summary(date, date) to authenticated;

comment on function public.admin_get_traffic_summary(date, date) is
  'Admin traffic KPIs. orders_created/conversion use server order_created events. Asia/Almaty. Active admin only.';

create or replace function public.admin_get_traffic_funnel(
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
  v_sessions bigint := 0;
  v_catalog bigint := 0;
  v_product bigint := 0;
  v_cart bigint := 0;
  v_checkout bigint := 0;
  v_order bigint := 0;
  v_payment bigint := 0;
  v_steps jsonb;
begin
  perform public.analytics_assert_admin();

  select * into v_period
  from public.analytics_almaty_day_bounds(p_date_from, p_date_to);

  -- Funnel unit: distinct session_id (one visit continuum)
  select count(distinct s.id)
  into v_sessions
  from public.analytics_sessions as s
  where s.started_at >= v_period.ts_from
    and s.started_at < v_period.ts_to;

  select count(distinct e.session_id)
  into v_catalog
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to
    and e.event_type = 'catalog_open';

  select count(distinct e.session_id)
  into v_product
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to
    and e.event_type = 'product_view';

  select count(distinct e.session_id)
  into v_cart
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to
    and e.event_type = 'cart_add';

  select count(distinct e.session_id)
  into v_checkout
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to
    and e.event_type = 'checkout_start';

  select count(distinct e.session_id)
  into v_order
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to
    and e.event_type = 'order_created'
    and e.source = 'server';

  select count(distinct e.session_id)
  into v_payment
  from public.analytics_events as e
  where e.created_at >= v_period.ts_from
    and e.created_at < v_period.ts_to
    and e.event_type = 'order_created'
    and e.source = 'server'
    and e.order_id is not null
    and exists (
      select 1
      from public.order_payments as p
      where p.order_id = e.order_id
        and p.status = 'confirmed'
    );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'step', f.step,
        'label', f.label,
        'count', f.cnt,
        'rate_from_previous', f.rate_from_previous
      )
      order by f.ord
    ),
    '[]'::jsonb
  )
  into v_steps
  from (
    select
      s.ord,
      s.step,
      s.label,
      s.cnt,
      case
        when s.ord = 1 then null::numeric
        when lag(s.cnt) over (order by s.ord) is null
          or lag(s.cnt) over (order by s.ord) = 0 then 0::numeric
        else round(
          (s.cnt::numeric / (lag(s.cnt) over (order by s.ord))::numeric) * 100,
          2
        )
      end as rate_from_previous
    from (
      values
        (1, 'session'::text, 'Сессия'::text, v_sessions),
        (2, 'catalog', 'Каталог', v_catalog),
        (3, 'product', 'Товар', v_product),
        (4, 'cart', 'Корзина', v_cart),
        (5, 'checkout', 'Оформление', v_checkout),
        (6, 'order', 'Заказ', v_order),
        (7, 'payment', 'Оплата', v_payment)
    ) as s(ord, step, label, cnt)
  ) as f;

  return jsonb_build_object(
    'date_from', v_period.date_from,
    'date_to', v_period.date_to,
    'timezone', 'Asia/Almaty',
    'unit', 'session',
    'unit_label', 'Уникальные сессии (session_id)',
    'steps', v_steps
  );
end;
$$;

revoke all on function public.admin_get_traffic_funnel(date, date) from public;
revoke all on function public.admin_get_traffic_funnel(date, date) from anon;
revoke all on function public.admin_get_traffic_funnel(date, date) from authenticated;
grant execute on function public.admin_get_traffic_funnel(date, date) to authenticated;

comment on function public.admin_get_traffic_funnel(date, date) is
  'Admin funnel by distinct session_id. Order/payment = authoritative server events.';

create or replace function public.admin_get_traffic_sources(
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
  v_total bigint := 0;
  v_sources jsonb;
begin
  perform public.analytics_assert_admin();

  select * into v_period
  from public.analytics_almaty_day_bounds(p_date_from, p_date_to);

  select count(*)
  into v_total
  from public.analytics_sessions as s
  where s.started_at >= v_period.ts_from
    and s.started_at < v_period.ts_to;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'traffic_source', src.traffic_source,
        'sessions', src.sessions,
        'unique_visitors', src.unique_visitors,
        'share_pct', case
          when v_total = 0 then 0
          else round((src.sessions::numeric / v_total::numeric) * 100, 2)
        end
      )
      order by src.sessions desc, src.traffic_source
    ),
    '[]'::jsonb
  )
  into v_sources
  from (
    select
      s.traffic_source,
      count(*)::bigint as sessions,
      count(distinct s.visitor_id)::bigint as unique_visitors
    from public.analytics_sessions as s
    where s.started_at >= v_period.ts_from
      and s.started_at < v_period.ts_to
    group by s.traffic_source
  ) as src;

  return jsonb_build_object(
    'date_from', v_period.date_from,
    'date_to', v_period.date_to,
    'timezone', 'Asia/Almaty',
    'total_sessions', v_total,
    'sources', v_sources
  );
end;
$$;

revoke all on function public.admin_get_traffic_sources(date, date) from public;
revoke all on function public.admin_get_traffic_sources(date, date) from anon;
revoke all on function public.admin_get_traffic_sources(date, date) from authenticated;
grant execute on function public.admin_get_traffic_sources(date, date) to authenticated;

comment on function public.admin_get_traffic_sources(date, date) is
  'Admin session counts grouped by traffic_source. Active admin only.';

create or replace function public.admin_get_online_visitors()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.analytics_assert_admin();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'session_id', x.id,
        'visitor_id', x.visitor_id,
        'profile_id', x.profile_id,
        'customer_id', x.customer_id,
        'display_name', x.display_name,
        'company_name', x.company_name,
        'last_page', x.last_page,
        'last_seen_at', x.last_seen_at,
        'is_authenticated', x.is_authenticated,
        'traffic_source', x.traffic_source
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      s.id,
      s.visitor_id,
      s.profile_id,
      s.customer_id,
      case
        when s.profile_id is not null
          then coalesce(c.display_name, p.full_name)
        else null
      end as display_name,
      case
        when s.profile_id is not null then co.name
        else null
      end as company_name,
      public.analytics_sanitize_page_for_display(
        (
          select e.page
          from public.analytics_events as e
          where e.session_id = s.id
            and e.event_type = 'page_view'
            and e.page is not null
          order by e.created_at desc
          limit 1
        )
      ) as last_page,
      s.last_seen_at,
      (s.profile_id is not null) as is_authenticated,
      s.traffic_source
    from public.analytics_sessions as s
    left join public.customers as c on c.id = s.customer_id
    left join public.profiles as p on p.id = s.profile_id
    left join public.companies as co on co.id = coalesce(c.company_id, p.company_id)
    where s.last_seen_at > now() - interval '5 minutes'
  ) as x;

  return jsonb_build_object(
    'online_now', jsonb_array_length(v_rows),
    'visitors', v_rows
  );
end;
$$;

revoke all on function public.admin_get_online_visitors() from public;
revoke all on function public.admin_get_online_visitors() from anon;
revoke all on function public.admin_get_online_visitors() from authenticated;
grant execute on function public.admin_get_online_visitors() to authenticated;

comment on function public.admin_get_online_visitors() is
  'Admin: sessions last_seen < 5 min. Guests: display_name null. last_page sanitized (no raw order UUIDs / query / search).';

create or replace function public.manager_get_online_customers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.analytics_assert_manager();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'session_id', x.id,
        'visitor_id', x.visitor_id,
        'profile_id', x.profile_id,
        'customer_id', x.customer_id,
        'display_name', x.display_name,
        'company_name', x.company_name,
        'last_page', x.last_page,
        'last_seen_at', x.last_seen_at,
        'traffic_source', x.traffic_source
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      s.id,
      s.visitor_id,
      s.profile_id,
      s.customer_id,
      coalesce(c.display_name, p.full_name) as display_name,
      co.name as company_name,
      public.analytics_sanitize_page_for_display(
        (
          select e.page
          from public.analytics_events as e
          where e.session_id = s.id
            and e.event_type = 'page_view'
            and e.page is not null
          order by e.created_at desc
          limit 1
        )
      ) as last_page,
      s.last_seen_at,
      s.traffic_source
    from public.analytics_sessions as s
    inner join public.customers as c on c.id = s.customer_id
    left join public.profiles as p on p.id = s.profile_id
    left join public.companies as co on co.id = coalesce(c.company_id, p.company_id)
    where s.last_seen_at > now() - interval '5 minutes'
      and s.customer_id is not null
      and public.analytics_can_view_customer(s.customer_id)
  ) as x;

  return jsonb_build_object(
    'online_now', jsonb_array_length(v_rows),
    'customers', v_rows
  );
end;
$$;

revoke all on function public.manager_get_online_customers() from public;
revoke all on function public.manager_get_online_customers() from anon;
revoke all on function public.manager_get_online_customers() from authenticated;
grant execute on function public.manager_get_online_customers() to authenticated;

comment on function public.manager_get_online_customers() is
  'Manager: online sessions with viewable customer_id only (no guests). last_page sanitized. No metadata.';

create or replace function public.staff_get_product_analytics(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today record;
  v_views_today bigint := 0;
  v_views_7d bigint := 0;
  v_views_30d bigint := 0;
  v_views_total bigint := 0;
  v_cart_adds bigint := 0;
  v_favorite_adds bigint := 0;
  v_orders_count bigint := 0;
  v_conversion_cart numeric := 0;
  v_conversion_order numeric := 0;
  v_tz text := 'Asia/Almaty';
  v_now_almaty timestamp;
  v_7d_from timestamptz;
  v_30d_from timestamptz;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['admin', 'manager', 'warehouse']::public.user_role[]
  ) then
    raise exception 'Аналитика товара доступна администратору, менеджеру или складу';
  end if;

  if p_product_id is null then
    raise exception 'product_id обязателен';
  end if;

  select * into v_today
  from public.analytics_almaty_day_bounds(null, null);

  v_now_almaty := timezone(v_tz, now());
  v_7d_from := ((v_now_almaty::date - 6)::timestamp at time zone v_tz);
  v_30d_from := ((v_now_almaty::date - 29)::timestamp at time zone v_tz);

  select
    count(*) filter (
      where e.created_at >= v_today.ts_from
        and e.created_at < v_today.ts_to
        and e.event_type = 'product_view'
    ),
    count(*) filter (
      where e.created_at >= v_7d_from
        and e.event_type = 'product_view'
    ),
    count(*) filter (
      where e.created_at >= v_30d_from
        and e.event_type = 'product_view'
    ),
    count(*) filter (where e.event_type = 'product_view'),
    count(*) filter (where e.event_type = 'cart_add'),
    count(*) filter (where e.event_type = 'favorite_add')
  into
    v_views_today,
    v_views_7d,
    v_views_30d,
    v_views_total,
    v_cart_adds,
    v_favorite_adds
  from public.analytics_events as e
  where e.product_id = p_product_id;

  select count(distinct oi.order_id)
  into v_orders_count
  from public.order_items as oi
  where oi.product_id = p_product_id;

  if v_views_total > 0 then
    v_conversion_cart := round(
      (v_cart_adds::numeric / v_views_total::numeric) * 100,
      2
    );
    v_conversion_order := round(
      (v_orders_count::numeric / v_views_total::numeric) * 100,
      2
    );
  end if;

  return jsonb_build_object(
    'product_id', p_product_id,
    'timezone', 'Asia/Almaty',
    'views_today', v_views_today,
    'views_7d', v_views_7d,
    'views_30d', v_views_30d,
    'views_total', v_views_total,
    'cart_adds', v_cart_adds,
    'favorite_adds', v_favorite_adds,
    'orders_count', v_orders_count,
    'conversion_cart', v_conversion_cart,
    'conversion_order', v_conversion_order
  );
end;
$$;

revoke all on function public.staff_get_product_analytics(uuid) from public;
revoke all on function public.staff_get_product_analytics(uuid) from anon;
revoke all on function public.staff_get_product_analytics(uuid) from authenticated;
grant execute on function public.staff_get_product_analytics(uuid) to authenticated;

comment on function public.staff_get_product_analytics(uuid) is
  'Product engagement + order conversion. Admin/manager/warehouse. Almaty day windows.';

create or replace function public.staff_get_customer_activity(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_customer public.customers%rowtype;
  v_last_visit timestamptz;
  v_traffic_source text;
  v_last_activity timestamptz;
  v_registered_at timestamptz;
  v_visits_count bigint := 0;
  v_avg_duration numeric := 0;
  v_pages jsonb;
  v_products jsonb;
  v_searches jsonb;
  v_cart_adds jsonb;
  v_cart_removes jsonb;
  v_recent_events jsonb;
  v_is_admin boolean := false;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_customer_id is null then
    raise exception 'customer_id обязателен';
  end if;

  if not public.analytics_can_view_customer(p_customer_id) then
    raise exception 'Нет доступа к активности этого клиента';
  end if;

  v_is_admin := public.has_staff_role(array['admin']::public.user_role[]);

  select * into v_customer
  from public.customers as c
  where c.id = p_customer_id;

  if not found then
    raise exception 'Клиент не найден';
  end if;

  v_registered_at := v_customer.created_at;
  if v_customer.profile_id is not null then
    select p.created_at
    into v_registered_at
    from public.profiles as p
    where p.id = v_customer.profile_id;
  end if;

  select s.started_at, s.traffic_source
  into v_last_visit, v_traffic_source
  from public.analytics_sessions as s
  where s.customer_id = p_customer_id
  order by s.started_at desc
  limit 1;

  select count(*)
  into v_visits_count
  from public.analytics_sessions as s
  where s.customer_id = p_customer_id;

  select coalesce(
    avg(
      extract(
        epoch from (
          coalesce(s.ended_at, s.last_seen_at) - s.started_at
        )
      )
    ),
    0
  )
  into v_avg_duration
  from public.analytics_sessions as s
  where s.customer_id = p_customer_id
    and coalesce(s.ended_at, s.last_seen_at) > s.started_at;

  select max(e.created_at)
  into v_last_activity
  from public.analytics_events as e
  where e.customer_id = p_customer_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'page', x.page,
        'count', x.views,
        'last_at', x.last_seen_at
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_pages
  from (
    select
      public.analytics_sanitize_page_for_display(e.page) as page,
      count(*)::bigint as views,
      max(e.created_at) as last_seen_at
    from public.analytics_events as e
    where e.customer_id = p_customer_id
      and e.event_type = 'page_view'
      and e.page is not null
    group by public.analytics_sanitize_page_for_display(e.page)
    order by max(e.created_at) desc
    limit 20
  ) as x
  where x.page is not null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', x.product_id,
        'product_name', x.product_name,
        'product_sku', x.product_sku,
        'views', x.views,
        'last_at', x.last_seen_at
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_products
  from (
    select
      e.product_id,
      p.name as product_name,
      p.sku as product_sku,
      count(*)::bigint as views,
      max(e.created_at) as last_seen_at
    from public.analytics_events as e
    left join public.products as p on p.id = e.product_id
    where e.customer_id = p_customer_id
      and e.event_type = 'product_view'
      and e.product_id is not null
    group by e.product_id, p.name, p.sku
    order by max(e.created_at) desc
    limit 20
  ) as x;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', x.product_id,
        'product_name', x.product_name,
        'count', x.cnt,
        'last_at', x.last_seen_at
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_cart_adds
  from (
    select
      e.product_id,
      p.name as product_name,
      count(*)::bigint as cnt,
      max(e.created_at) as last_seen_at
    from public.analytics_events as e
    left join public.products as p on p.id = e.product_id
    where e.customer_id = p_customer_id
      and e.event_type = 'cart_add'
      and e.product_id is not null
    group by e.product_id, p.name
    order by max(e.created_at) desc
    limit 20
  ) as x;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', x.product_id,
        'product_name', x.product_name,
        'count', x.cnt,
        'last_at', x.last_seen_at
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_cart_removes
  from (
    select
      e.product_id,
      p.name as product_name,
      count(*)::bigint as cnt,
      max(e.created_at) as last_seen_at
    from public.analytics_events as e
    left join public.products as p on p.id = e.product_id
    where e.customer_id = p_customer_id
      and e.event_type = 'cart_remove'
      and e.product_id is not null
    group by e.product_id, p.name
    order by max(e.created_at) desc
    limit 20
  ) as x;

  -- Searches already stored redacted via analytics_sanitize_search_query
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'query', x.query,
        'count', x.cnt,
        'last_at', x.last_seen_at
      )
      order by x.last_seen_at desc
    ),
    '[]'::jsonb
  )
  into v_searches
  from (
    select
      q.query,
      count(*)::bigint as cnt,
      max(q.created_at) as last_seen_at
    from (
      select
        left(coalesce(e.metadata ->> 'query', ''), 80) as query,
        e.created_at
      from public.analytics_events as e
      where e.customer_id = p_customer_id
        and e.event_type = 'search'
    ) as q
    where q.query <> ''
    group by q.query
    order by max(q.created_at) desc
    limit 20
  ) as x;

  -- Manager / non-admin: strip recent_events to type + sanitized page + created_at
  if v_is_admin then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'event_type', e.event_type,
          'page', public.analytics_sanitize_page_for_display(e.page),
          'product_id', e.product_id,
          'category_id', e.category_id,
          'order_id', e.order_id,
          'source', e.source,
          'metadata', e.metadata,
          'created_at', e.created_at
        )
        order by e.created_at desc
      ),
      '[]'::jsonb
    )
    into v_recent_events
    from (
      select *
      from public.analytics_events as ev
      where ev.customer_id = p_customer_id
      order by ev.created_at desc
      limit 50
    ) as e;
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'event_type', e.event_type,
          'page', public.analytics_sanitize_page_for_display(e.page),
          'created_at', e.created_at
        )
        order by e.created_at desc
      ),
      '[]'::jsonb
    )
    into v_recent_events
    from (
      select *
      from public.analytics_events as ev
      where ev.customer_id = p_customer_id
      order by ev.created_at desc
      limit 50
    ) as e;
  end if;

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'display_name', v_customer.display_name,
    'last_visit', v_last_visit,
    'traffic_source', v_traffic_source,
    'pages', v_pages,
    'products_viewed', v_products,
    'searches', v_searches,
    'cart_adds', v_cart_adds,
    'cart_removes', v_cart_removes,
    'last_activity', v_last_activity,
    'registered_at', v_registered_at,
    'visits_count', v_visits_count,
    'avg_session_duration_seconds', round(coalesce(v_avg_duration, 0), 1),
    'recent_events', v_recent_events
  );
end;
$$;

revoke all on function public.staff_get_customer_activity(uuid) from public;
revoke all on function public.staff_get_customer_activity(uuid) from anon;
revoke all on function public.staff_get_customer_activity(uuid) from authenticated;
grant execute on function public.staff_get_customer_activity(uuid) to authenticated;

comment on function public.staff_get_customer_activity(uuid) is
  'Customer behavior dossier. Gated by analytics_can_view_customer. Managers get stripped recent_events.';

-- ============================================================
-- 10. Notes
--
-- - Migration is NOT applied by this change — apply manually when ready.
-- - Security audit hardened: authoritative events, metadata whitelist,
--   search redaction, rate limits, immutable session profile_id,
--   payload size cap, server-only identity/timestamps.
-- - No policies on analytics_* tables: RLS deny-by-default for
--   anon/authenticated; table owner / security definer RPCs only.
-- - CLIENT_ALLOWED via analytics_track_events (anon+auth):
--   page_view, catalog_open, category_open, product_view, search,
--   favorite_*, cart_*, checkout_start.
-- - AUTHORITATIVE via analytics_record_* (authenticated only):
--   login, register, order_created, order_cancelled,
--   invoice_open, delivery_note_open, document_download.
-- - Consent is client-side; server stores only what is sent (after
--   sanitization/whitelist). Logout: client rotates visitor_id.
-- - Retention: 12 months recommended. Use admin_analytics_cleanup.
--   No cron job in this migration.
-- - Funnel order/payment steps use source='server' order_created.
--   Attribution window for any fallback joins = 7 days (documented);
--   primary path is analytics_record_order_event at create time.
-- - Behavior overview page should call admin_get_traffic_summary,
--   admin_get_traffic_funnel, and admin_get_traffic_sources in parallel.
-- ============================================================
