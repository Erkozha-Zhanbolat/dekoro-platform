-- ============================================================
-- 024_staff_user_management.sql
-- Stage 24 — Staff users & roles (admin management)
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–023 files.
--
-- Purpose:
--   1. Harden get_my_role() so inactive profiles get NULL role
--      (has_staff_role / RLS / staff RPCs all fail for inactive staff).
--   2. staff_user_activity audit table (RPC-only).
--   3. Admin RPCs: list/get staff, change role, activate/deactivate,
--      promote client→staff (separate), list activity.
--   4. Last-active-admin protection under pg_advisory_xact_lock.
--   5. Optional handle_new_user support for dekoro_staff_invite metadata
--      (invite still requires server-only Admin API — not browser).
--
-- Explicitly NOT done here:
--   - auth.users delete / password reset / MFA / SSO;
--   - service_role usage inside SQL;
--   - physical profile deletion.
-- ============================================================

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'public.profiles missing — run 001 first.';
  end if;

  if not exists (
    select 1
    from pg_type as t
    join pg_namespace as n on n.oid = t.typnamespace
    where t.typname = 'user_role' and n.nspname = 'public'
  ) then
    raise exception 'public.user_role missing — run 001 first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role missing — run 010 first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'public.set_updated_at missing — run 001 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Harden get_my_role(): inactive → NULL
--
-- Before 024, inactive staff still passed has_staff_role() because only
-- role was checked. After this change, is_active=false immediately denies
-- every has_staff_role gate (RLS policies and SECURITY DEFINER RPCs).
-- ============================================================

create or replace function public.get_my_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles as p
  where p.id = auth.uid()
    and p.is_active = true;
$$;

revoke all on function public.get_my_role() from public;
grant execute on function public.get_my_role() to authenticated;

comment on function public.get_my_role() is
  'Caller role if authenticated + active profile; NULL otherwise (inactive/missing).';

-- ============================================================
-- 2. staff_user_activity — RPC-only audit
-- ============================================================

create table if not exists public.staff_user_activity (
  id uuid primary key default gen_random_uuid(),
  target_profile_id uuid references public.profiles (id) on delete restrict,
  event_type text not null,
  description text,
  metadata jsonb,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint staff_user_activity_event_type_check check (
    event_type in (
      'staff_invited',
      'staff_reinvited',
      'staff_role_changed',
      'staff_activated',
      'staff_deactivated',
      'staff_promoted',
      'invite_failed'
    )
  )
);

create index if not exists staff_user_activity_target_created_at_idx
  on public.staff_user_activity (target_profile_id, created_at desc);

create index if not exists staff_user_activity_created_at_idx
  on public.staff_user_activity (created_at desc);

comment on table public.staff_user_activity is
  'Admin audit trail for staff user management. RPC-only; no direct grants.';

alter table public.staff_user_activity enable row level security;

revoke all on table public.staff_user_activity from public;
revoke all on table public.staff_user_activity from anon;
revoke all on table public.staff_user_activity from authenticated;

-- ============================================================
-- 3. Internal helpers (no EXECUTE grant)
-- ============================================================

create or replace function public.staff_assert_active_admin()
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
    raise exception 'Только администратор может управлять сотрудниками';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.staff_assert_active_admin() from public;
revoke all on function public.staff_assert_active_admin() from anon;
revoke all on function public.staff_assert_active_admin() from authenticated;

create or replace function public.staff_is_allowed_staff_role(p_role text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role in ('admin', 'manager', 'accountant', 'warehouse');
$$;

revoke all on function public.staff_is_allowed_staff_role(text) from public;
revoke all on function public.staff_is_allowed_staff_role(text) from anon;
revoke all on function public.staff_is_allowed_staff_role(text) from authenticated;

create or replace function public.staff_lock_admin_guard()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Transaction-scoped; released on commit/rollback. Serializes last-admin checks.
  perform pg_advisory_xact_lock(hashtext('dekoro:staff_admin_guard'));
end;
$$;

revoke all on function public.staff_lock_admin_guard() from public;
revoke all on function public.staff_lock_admin_guard() from anon;
revoke all on function public.staff_lock_admin_guard() from authenticated;

create or replace function public.staff_count_active_admins()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.profiles as p
  where p.role = 'admin'
    and p.is_active = true;
$$;

revoke all on function public.staff_count_active_admins() from public;
revoke all on function public.staff_count_active_admins() from anon;
revoke all on function public.staff_count_active_admins() from authenticated;

create or replace function public.staff_assert_not_last_active_admin(
  p_profile_id uuid,
  p_would_lose_admin boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.profiles;
  v_active_admins integer;
begin
  if not p_would_lose_admin then
    return;
  end if;

  -- Caller must already hold staff_lock_admin_guard() in this transaction.
  -- Re-read and re-count under that lock so concurrent demotions cannot
  -- leave the system without an active admin.
  select * into v_target
  from public.profiles as p
  where p.id = p_profile_id;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_target.role is distinct from 'admin' or v_target.is_active is not true then
    return;
  end if;

  v_active_admins := public.staff_count_active_admins();

  if v_active_admins <= 1 then
    raise exception 'Нельзя отключить или снять роль последнего активного администратора';
  end if;
end;
$$;

revoke all on function public.staff_assert_not_last_active_admin(uuid, boolean) from public;
revoke all on function public.staff_assert_not_last_active_admin(uuid, boolean) from anon;
revoke all on function public.staff_assert_not_last_active_admin(uuid, boolean) from authenticated;

create or replace function public.staff_record_staff_user_activity(
  p_target_profile_id uuid,
  p_event_type text,
  p_description text default null,
  p_metadata jsonb default null,
  p_created_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_by uuid := coalesce(p_created_by, auth.uid());
begin
  if v_by is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_event_type is null or p_event_type not in (
    'staff_invited',
    'staff_reinvited',
    'staff_role_changed',
    'staff_activated',
    'staff_deactivated',
    'staff_promoted',
    'invite_failed'
  ) then
    raise exception 'Некорректный тип события';
  end if;

  -- Never persist secrets even if a caller accidentally passes them.
  insert into public.staff_user_activity (
    target_profile_id,
    event_type,
    description,
    metadata,
    created_by
  )
  values (
    p_target_profile_id,
    p_event_type,
    nullif(trim(p_description), ''),
    case
      when p_metadata is null then null
      else p_metadata
        - 'token'
        - 'access_token'
        - 'refresh_token'
        - 'password'
        - 'service_role'
        - 'service_key'
        - 'authorization'
        - 'invite_token'
        - 'hashed_token'
    end,
    v_by
  );
end;
$$;

revoke all on function public.staff_record_staff_user_activity(uuid, text, text, jsonb, uuid)
  from public, anon, authenticated;

-- ============================================================
-- 4. READ RPCs
-- ============================================================

create or replace function public.staff_list_staff_users(
  p_query text default null,
  p_role text default null,
  p_status text default null,
  p_limit integer default 100
)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  phone text,
  role public.user_role,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_term text;
  v_role text;
  v_status text;
begin
  perform public.staff_assert_active_admin();

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_term := nullif(trim(p_query), '');
  v_role := nullif(trim(p_role), '');
  v_status := nullif(lower(trim(p_status)), '');

  if v_role is not null and not public.staff_is_allowed_staff_role(v_role) then
    raise exception 'Некорректная роль фильтра';
  end if;

  if v_status is not null and v_status not in ('active', 'inactive', 'all') then
    raise exception 'Статус должен быть active, inactive или all';
  end if;

  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.phone,
    p.role,
    p.is_active,
    p.created_at,
    p.updated_at
  from public.profiles as p
  left join auth.users as au on au.id = p.id
  where p.role in ('admin', 'manager', 'accountant', 'warehouse')
    and (
      v_role is null
      or p.role = v_role::public.user_role
    )
    and (
      v_status is null
      or v_status = 'all'
      or (v_status = 'active' and p.is_active = true)
      or (v_status = 'inactive' and p.is_active = false)
    )
    and (
      v_term is null
      or p.full_name ilike ('%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\'
      or coalesce(p.phone, '') ilike ('%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\'
      or coalesce(au.email::text, '') ilike ('%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%') escape '\'
    )
  order by p.is_active desc, p.full_name
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_staff_users(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_staff_users(text, text, text, integer)
  to authenticated;

create or replace function public.staff_get_staff_user(p_profile_id uuid)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  phone text,
  role public.user_role,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exists boolean := false;
begin
  perform public.staff_assert_active_admin();

  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

  select exists (
    select 1
    from public.profiles as p
    where p.id = p_profile_id
      and p.role in ('admin', 'manager', 'accountant', 'warehouse')
  ) into v_exists;

  if not v_exists then
    raise exception 'Сотрудник не найден';
  end if;

  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.phone,
    p.role,
    p.is_active,
    p.created_at,
    p.updated_at,
    au.last_sign_in_at
  from public.profiles as p
  left join auth.users as au on au.id = p.id
  where p.id = p_profile_id
    and p.role in ('admin', 'manager', 'accountant', 'warehouse');
end;
$$;

revoke all on function public.staff_get_staff_user(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_staff_user(uuid)
  to authenticated;

create or replace function public.staff_find_profile_by_email(p_email text)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  role public.user_role,
  is_active boolean,
  email_confirmed boolean,
  is_pending_staff_invite boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform public.staff_assert_active_admin();

  if v_email is null or v_email = '' or position('@' in v_email) = 0 then
    raise exception 'Укажите корректный email';
  end if;

  -- SECURITY DEFINER may read auth.users, but only safe derived columns are
  -- returned (never encrypted_password, tokens, or raw_*_meta_data).
  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.role,
    p.is_active,
    (au.email_confirmed_at is not null) as email_confirmed,
    (
      coalesce(au.raw_user_meta_data ->> 'dekoro_staff_invite', '') in ('true', '1')
      and au.email_confirmed_at is null
    ) as is_pending_staff_invite
  from auth.users as au
  join public.profiles as p on p.id = au.id
  where lower(au.email::text) = v_email
  limit 1;
end;
$$;

revoke all on function public.staff_find_profile_by_email(text)
  from public, anon, authenticated;
grant execute on function public.staff_find_profile_by_email(text)
  to authenticated;

create or replace function public.staff_list_staff_user_activity(
  p_profile_id uuid default null,
  p_limit integer default 100
)
returns table (
  id uuid,
  target_profile_id uuid,
  target_full_name text,
  event_type text,
  description text,
  metadata jsonb,
  created_by uuid,
  created_by_name text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  perform public.staff_assert_active_admin();

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  return query
  select
    a.id,
    a.target_profile_id,
    tp.full_name as target_full_name,
    a.event_type,
    a.description,
    a.metadata,
    a.created_by,
    cp.full_name as created_by_name,
    a.created_at
  from public.staff_user_activity as a
  left join public.profiles as tp on tp.id = a.target_profile_id
  left join public.profiles as cp on cp.id = a.created_by
  where p_profile_id is null
     or a.target_profile_id = p_profile_id
  order by a.created_at desc
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_staff_user_activity(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_staff_user_activity(uuid, integer)
  to authenticated;

-- ============================================================
-- 5. WRITE RPCs — role / active / promote
-- ============================================================

create or replace function public.staff_update_staff_role(
  p_profile_id uuid,
  p_role text
)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  phone text,
  role public.user_role,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
  v_new_role text := nullif(trim(p_role), '');
  v_target public.profiles;
  v_old_role public.user_role;
begin
  v_admin := public.staff_assert_active_admin();

  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

  if v_new_role is null or not public.staff_is_allowed_staff_role(v_new_role) then
    raise exception 'Роль должна быть admin, manager, accountant или warehouse';
  end if;

  perform public.staff_lock_admin_guard();

  select * into v_target
  from public.profiles as p
  where p.id = p_profile_id
  for update;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_target.role = 'client' then
    raise exception
      'Нельзя тихо перевести клиента в сотрудника. Используйте admin_promote_profile_to_staff';
  end if;

  if v_target.role not in ('admin', 'manager', 'accountant', 'warehouse') then
    raise exception 'Целевой профиль не является сотрудником';
  end if;

  v_old_role := v_target.role;

  if v_old_role = v_new_role::public.user_role then
    return query
    select
      p.id as profile_id,
      p.full_name,
      au.email::text as email,
      p.phone,
      p.role,
      p.is_active,
      p.created_at,
      p.updated_at
    from public.profiles as p
    left join auth.users as au on au.id = p.id
    where p.id = p_profile_id;
    return;
  end if;

  perform public.staff_assert_not_last_active_admin(
    p_profile_id,
    v_old_role = 'admin' and v_new_role is distinct from 'admin'
  );

  update public.profiles as p
  set role = v_new_role::public.user_role
  where p.id = p_profile_id
  returning * into v_target;

  perform public.staff_record_staff_user_activity(
    p_profile_id,
    'staff_role_changed',
    format('Роль изменена: %s → %s', v_old_role::text, v_new_role),
    jsonb_build_object(
      'from_role', v_old_role::text,
      'to_role', v_new_role,
      'self', (p_profile_id = v_admin)
    ),
    v_admin
  );

  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.phone,
    p.role,
    p.is_active,
    p.created_at,
    p.updated_at
  from public.profiles as p
  left join auth.users as au on au.id = p.id
  where p.id = p_profile_id;
end;
$$;

revoke all on function public.staff_update_staff_role(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_update_staff_role(uuid, text)
  to authenticated;

create or replace function public.staff_set_staff_active(
  p_profile_id uuid,
  p_is_active boolean,
  p_reason text default null
)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  phone text,
  role public.user_role,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
  v_target public.profiles;
  v_reason text := nullif(trim(p_reason), '');
begin
  v_admin := public.staff_assert_active_admin();

  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

  if p_is_active is null then
    raise exception 'is_active обязателен';
  end if;

  if p_is_active = false and v_reason is null then
    raise exception 'Укажите причину отключения доступа';
  end if;

  perform public.staff_lock_admin_guard();

  select * into v_target
  from public.profiles as p
  where p.id = p_profile_id
  for update;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_target.role not in ('admin', 'manager', 'accountant', 'warehouse') then
    raise exception 'Целевой профиль не является сотрудником';
  end if;

  if v_target.is_active = p_is_active then
    return query
    select
      p.id as profile_id,
      p.full_name,
      au.email::text as email,
      p.phone,
      p.role,
      p.is_active,
      p.created_at,
      p.updated_at
    from public.profiles as p
    left join auth.users as au on au.id = p.id
    where p.id = p_profile_id;
    return;
  end if;

  if p_is_active = false then
    perform public.staff_assert_not_last_active_admin(p_profile_id, true);
  end if;

  update public.profiles as p
  set is_active = p_is_active
  where p.id = p_profile_id
  returning * into v_target;

  perform public.staff_record_staff_user_activity(
    p_profile_id,
    case when p_is_active then 'staff_activated' else 'staff_deactivated' end,
    case
      when p_is_active then 'Доступ сотрудника включён'
      else format('Доступ сотрудника отключён: %s', v_reason)
    end,
    jsonb_build_object(
      'is_active', p_is_active,
      'reason', v_reason,
      'role', v_target.role::text,
      'self', (p_profile_id = v_admin)
    ),
    v_admin
  );

  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.phone,
    p.role,
    p.is_active,
    p.created_at,
    p.updated_at
  from public.profiles as p
  left join auth.users as au on au.id = p.id
  where p.id = p_profile_id;
end;
$$;

revoke all on function public.staff_set_staff_active(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.staff_set_staff_active(uuid, boolean, text)
  to authenticated;

create or replace function public.admin_promote_profile_to_staff(
  p_profile_id uuid,
  p_role text,
  p_confirm boolean default false
)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  phone text,
  role public.user_role,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
  v_new_role text := nullif(trim(p_role), '');
  v_target public.profiles;
begin
  v_admin := public.staff_assert_active_admin();

  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

  if coalesce(p_confirm, false) is not true then
    raise exception 'Подтвердите повышение клиента до сотрудника (p_confirm = true)';
  end if;

  if v_new_role is null or not public.staff_is_allowed_staff_role(v_new_role) then
    raise exception 'Роль должна быть admin, manager, accountant или warehouse';
  end if;

  perform public.staff_lock_admin_guard();

  select * into v_target
  from public.profiles as p
  where p.id = p_profile_id
  for update;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if v_target.role is distinct from 'client' then
    raise exception 'Повышать можно только клиентский профиль';
  end if;

  update public.profiles as p
  set
    role = v_new_role::public.user_role,
    is_active = true
  where p.id = p_profile_id
  returning * into v_target;

  perform public.staff_record_staff_user_activity(
    p_profile_id,
    'staff_promoted',
    format('Клиент повышен до сотрудника (%s)', v_new_role),
    jsonb_build_object(
      'from_role', 'client',
      'to_role', v_new_role
    ),
    v_admin
  );

  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.phone,
    p.role,
    p.is_active,
    p.created_at,
    p.updated_at
  from public.profiles as p
  left join auth.users as au on au.id = p.id
  where p.id = p_profile_id;
end;
$$;

revoke all on function public.admin_promote_profile_to_staff(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_promote_profile_to_staff(uuid, text, boolean)
  to authenticated;

-- Called by server-only invite route after Admin API invite / reinvite.
-- Still requires an active admin JWT (auth.uid()), not service_role alone.
--
-- Client → staff is allowed ONLY for a pending staff invite bootstrap:
--   dekoro_staff_invite metadata + email not yet confirmed.
-- Confirmed clients must use admin_promote_profile_to_staff.
create or replace function public.staff_finalize_staff_invite(
  p_profile_id uuid,
  p_role text,
  p_full_name text,
  p_is_reinvite boolean default false
)
returns table (
  profile_id uuid,
  full_name text,
  email text,
  phone text,
  role public.user_role,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
  v_new_role text := nullif(trim(p_role), '');
  v_full_name text := nullif(trim(p_full_name), '');
  v_target public.profiles;
  v_was_client boolean := false;
  v_email_confirmed boolean := false;
  v_pending_staff_invite boolean := false;
  v_old_role public.user_role;
begin
  v_admin := public.staff_assert_active_admin();

  if p_profile_id is null then
    raise exception 'profile_id обязателен';
  end if;

  if v_new_role is null or not public.staff_is_allowed_staff_role(v_new_role) then
    raise exception 'Роль должна быть admin, manager, accountant или warehouse';
  end if;

  if v_full_name is null then
    raise exception 'ФИО обязательно';
  end if;

  perform public.staff_lock_admin_guard();

  select * into v_target
  from public.profiles as p
  where p.id = p_profile_id
  for update;

  if not found then
    raise exception 'Профиль приглашённого пользователя ещё не создан';
  end if;

  select
    (au.email_confirmed_at is not null),
    (
      coalesce(au.raw_user_meta_data ->> 'dekoro_staff_invite', '') in ('true', '1')
      and au.email_confirmed_at is null
    )
  into v_email_confirmed, v_pending_staff_invite
  from auth.users as au
  where au.id = p_profile_id;

  if not found then
    raise exception 'Auth-пользователь не найден';
  end if;

  v_old_role := v_target.role;

  if v_target.role = 'client' then
    v_was_client := true;
    -- Only incomplete staff-invite bootstraps may be finalized here.
    if not v_pending_staff_invite then
      raise exception
        'Существующий клиентский аккаунт нельзя повысить через приглашение. Используйте admin_promote_profile_to_staff';
    end if;
  elsif v_target.role not in ('admin', 'manager', 'accountant', 'warehouse') then
    raise exception 'Некорректная текущая роль профиля';
  elsif v_email_confirmed and coalesce(p_is_reinvite, false) then
    -- Confirmed staff must not be "reinvited" via this path.
    raise exception 'Сотрудник уже зарегистрирован';
  end if;

  -- Re-count under the same advisory lock before dropping admin.
  perform public.staff_assert_not_last_active_admin(
    p_profile_id,
    v_old_role = 'admin' and v_new_role is distinct from 'admin'
  );

  update public.profiles as p
  set
    full_name = v_full_name,
    role = v_new_role::public.user_role,
    is_active = true,
    customer_type = coalesce(p.customer_type, 'individual')
  where p.id = p_profile_id
  returning * into v_target;

  perform public.staff_record_staff_user_activity(
    p_profile_id,
    case when coalesce(p_is_reinvite, false) then 'staff_reinvited' else 'staff_invited' end,
    case
      when coalesce(p_is_reinvite, false) then format('Повторное приглашение (%s)', v_new_role)
      else format('Приглашён сотрудник (%s)', v_new_role)
    end,
    jsonb_build_object(
      'role', v_new_role,
      'was_client_bootstrap', v_was_client,
      'pending_invite_completed', v_pending_staff_invite,
      'from_role', v_old_role::text
    ),
    v_admin
  );

  return query
  select
    p.id as profile_id,
    p.full_name,
    au.email::text as email,
    p.phone,
    p.role,
    p.is_active,
    p.created_at,
    p.updated_at
  from public.profiles as p
  left join auth.users as au on au.id = p.id
  where p.id = p_profile_id;
end;
$$;

revoke all on function public.staff_finalize_staff_invite(uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.staff_finalize_staff_invite(uuid, text, text, boolean)
  to authenticated;

create or replace function public.staff_record_invite_failure(
  p_email text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  v_admin := public.staff_assert_active_admin();

  perform public.staff_record_staff_user_activity(
    null,
    'invite_failed',
    coalesce(nullif(trim(p_reason), ''), 'Не удалось отправить приглашение'),
    jsonb_build_object(
      -- Store only a weak fingerprint, not the full email, to limit leakage.
      'email_domain', nullif(split_part(v_email, '@', 2), ''),
      'email_len', length(v_email)
    ),
    v_admin
  );
end;
$$;

revoke all on function public.staff_record_invite_failure(text, text)
  from public, anon, authenticated;
grant execute on function public.staff_record_invite_failure(text, text)
  to authenticated;

-- ============================================================
-- 6. handle_new_user — honor dekoro_staff_invite metadata
--
-- Public self-registration stays client. Staff invites (Admin API) may
-- pass dekoro_staff_invite=true + staff_role + full_name so the profile
-- is created with the staff role immediately (no silent client→staff in
-- the public signup form — that form never sets dekoro_staff_invite).
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_type text;
  v_company_id uuid;
  v_company_name text;
  v_bin text;
  v_contact_person text;
  v_individual_name text;
  v_phone text;
  v_full_name text;
  v_staff_invite boolean;
  v_staff_role text;
  v_role public.user_role := 'client';
begin
  v_company_name := nullif(trim(new.raw_user_meta_data ->> 'company_name'), '');
  v_bin := nullif(trim(new.raw_user_meta_data ->> 'bin'), '');
  v_contact_person := nullif(trim(new.raw_user_meta_data ->> 'contact_person'), '');
  v_individual_name := nullif(trim(new.raw_user_meta_data ->> 'name'), '');
  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');

  v_staff_invite := coalesce(new.raw_user_meta_data ->> 'dekoro_staff_invite', '') in ('true', '1');
  v_staff_role := nullif(trim(new.raw_user_meta_data ->> 'staff_role'), '');

  if v_staff_invite
     and v_staff_role in ('admin', 'manager', 'accountant', 'warehouse') then
    v_role := v_staff_role::public.user_role;
    v_customer_type := 'individual';
    v_company_id := null;
    v_full_name := coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      v_individual_name,
      v_contact_person,
      split_part(new.email, '@', 1),
      'Новый сотрудник'
    );

    insert into public.profiles (id, company_id, full_name, phone, role, customer_type)
    values (
      new.id,
      null,
      v_full_name,
      v_phone,
      v_role,
      'individual'
    )
    on conflict (id) do nothing;

    return new;
  end if;

  v_customer_type := nullif(trim(new.raw_user_meta_data ->> 'customer_type'), '');
  if v_customer_type is null or v_customer_type not in ('individual', 'company') then
    v_customer_type := case
      when v_company_name is not null and v_bin is not null then 'company'
      else 'individual'
    end;
  end if;

  if v_customer_type = 'company' then
    v_company_id := null;

    if v_bin is not null and v_bin ~ '^\d{12}$' then
      insert into public.companies (name, bin, phone, email)
      values (coalesce(v_company_name, 'Компания без названия'), v_bin, v_phone, new.email)
      on conflict (bin) do nothing
      returning id into v_company_id;

      if v_company_id is null then
        select id into v_company_id from public.companies where bin = v_bin;
      end if;
    end if;

    v_full_name := coalesce(v_contact_person, split_part(new.email, '@', 1), 'Новый пользователь');
  else
    v_customer_type := 'individual';
    v_company_id := null;
    v_full_name := coalesce(v_individual_name, split_part(new.email, '@', 1), 'Новый пользователь');
  end if;

  insert into public.profiles (id, company_id, full_name, phone, role, customer_type)
  values (
    new.id,
    v_company_id,
    v_full_name,
    v_phone,
    'client',
    v_customer_type
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ============================================================
-- 7. Notes
-- ============================================================
-- - get_my_role() now requires is_active=true.
-- - Role changes take effect on the next request that re-evaluates
--   has_staff_role (JWT itself does not embed role).
-- - Invite email is sent only via server Admin API (not this SQL).
-- - No service_role key material in SQL.
-- - profiles still has no direct UPDATE grant for authenticated.
-- ============================================================
