-- ============================================================
-- 022_order_payments.sql
-- Stage 22 — Payments and Receivables (manual payment ledger)
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–021 files.
-- Does NOT integrate online payments / acquiring / Kaspi.
--
-- amount_due model (frozen obligation):
--   - Before first payment: provisional = generated invoice final_total
--     else orders.total
--   - On first payment: freeze into public.order_payment_obligations
--   - After freeze: amount_due never changes automatically
--   - Invoice after freeze: allowed only if final_total = frozen amount_due
--
-- Overpayment: forbidden for all roles.
-- Reverse: admin + accountant. Manager records but does not reverse.
-- awaiting_payment → paid: gated on full payment; no auto status flip.
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'orders missing — run 005 first.';
  end if;
  if to_regclass('public.order_documents') is null then
    raise exception 'order_documents missing — run 014 first.';
  end if;
  if to_regclass('public.order_activity_log') is null then
    raise exception 'order_activity_log missing — run 012 first.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'profiles missing — run 001 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010 first.';
  end if;
  if to_regprocedure('public.staff_change_order_status(uuid, text, text)') is null then
    raise exception 'staff_change_order_status missing — run 012/017 first.';
  end if;
  if to_regprocedure('public.staff_record_order_activity(uuid, text, text, jsonb)') is null then
    raise exception 'staff_record_order_activity missing — run 012 first.';
  end if;
  if to_regprocedure('public.staff_assert_active_reservations_consistent(uuid)') is null then
    raise exception 'staff_assert_active_reservations_consistent missing — run 012 first.';
  end if;
  if to_regprocedure('public.staff_generate_order_document(uuid, text, text, uuid, text, date)') is null then
    raise exception 'staff_generate_order_document missing — run 018 first.';
  end if;
end;
$$;

-- ============================================================
-- 1. order_payment_obligations — frozen amount_due snapshot
-- ============================================================

create table if not exists public.order_payment_obligations (
  order_id uuid primary key references public.orders (id) on delete restrict,
  amount_due numeric(14, 2) not null,
  source_type text not null,
  source_document_id uuid references public.order_documents (id) on delete restrict,
  source_number text,
  frozen_at timestamptz not null default now(),
  frozen_by uuid not null references public.profiles (id) on delete restrict,
  metadata jsonb,
  constraint order_payment_obligations_amount_due_nonneg check (amount_due >= 0),
  constraint order_payment_obligations_source_type_check check (
    source_type in ('order', 'invoice')
  ),
  constraint order_payment_obligations_source_consistency check (
    (source_type = 'order' and source_document_id is null)
    or (source_type = 'invoice' and source_document_id is not null)
  )
);

comment on table public.order_payment_obligations is
  'Frozen client obligation for an order. Created atomically on first payment; never auto-updated.';
comment on column public.order_payment_obligations.amount_due is
  'Immutable after insert. Invoice generation after freeze must match this value.';

create index if not exists order_payment_obligations_frozen_at_idx
  on public.order_payment_obligations (frozen_at desc);

alter table public.order_payment_obligations enable row level security;
revoke all on table public.order_payment_obligations from public;
revoke all on table public.order_payment_obligations from anon;
revoke all on table public.order_payment_obligations from authenticated;

create or replace function public.order_payment_obligations_prevent_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Удаление зафиксированного обязательства запрещено';
  end if;

  if new.order_id is distinct from old.order_id
     or new.amount_due is distinct from old.amount_due
     or new.source_type is distinct from old.source_type
     or new.source_document_id is distinct from old.source_document_id
     or new.source_number is distinct from old.source_number
     or new.frozen_at is distinct from old.frozen_at
     or new.frozen_by is distinct from old.frozen_by
  then
    raise exception
      'Зафиксированное обязательство нельзя изменять';
  end if;

  return new;
end;
$$;

drop trigger if exists order_payment_obligations_prevent_mutation
  on public.order_payment_obligations;
create trigger order_payment_obligations_prevent_mutation
  before update or delete on public.order_payment_obligations
  for each row
  execute function public.order_payment_obligations_prevent_mutation();

revoke all on function public.order_payment_obligations_prevent_mutation() from public;
revoke all on function public.order_payment_obligations_prevent_mutation() from anon;
revoke all on function public.order_payment_obligations_prevent_mutation() from authenticated;

-- ============================================================
-- 2. order_payments — financial facts (immutable amount; reverse only)
-- ============================================================

create table if not exists public.order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  amount numeric(14, 2) not null,
  payment_date date not null,
  payment_method text not null,
  reference_number text,
  comment text,
  status text not null default 'confirmed',
  recorded_by uuid not null references public.profiles (id) on delete restrict,
  recorded_at timestamptz not null default now(),
  reversed_by uuid references public.profiles (id) on delete restrict,
  reversed_at timestamptz,
  reversal_reason text,
  metadata jsonb,
  constraint order_payments_amount_positive check (amount > 0),
  constraint order_payments_method_check check (
    payment_method in ('bank_transfer', 'cash', 'card_terminal', 'other')
  ),
  constraint order_payments_status_check check (status in ('confirmed', 'reversed')),
  constraint order_payments_confirmed_no_reversal check (
    status <> 'confirmed'
    or (
      reversed_by is null
      and reversed_at is null
      and reversal_reason is null
    )
  ),
  constraint order_payments_reversed_has_fields check (
    status <> 'reversed'
    or (
      reversed_by is not null
      and reversed_at is not null
      and reversal_reason is not null
      and length(trim(reversal_reason)) > 0
    )
  )
);

create index if not exists order_payments_order_id_status_idx
  on public.order_payments (order_id, status);

create index if not exists order_payments_order_id_recorded_at_idx
  on public.order_payments (order_id, recorded_at desc);

create index if not exists order_payments_payment_date_idx
  on public.order_payments (payment_date desc);

comment on table public.order_payments is
  'Manual payment ledger. Amount is immutable after insert; corrections via reverse + new row.';
comment on column public.order_payments.amount is
  'Immutable after insert. Never UPDATE amount — reverse and record a new payment.';
comment on column public.order_payments.status is
  'confirmed = counts toward amount_paid; reversed = excluded (row retained).';

alter table public.order_payments enable row level security;
revoke all on table public.order_payments from public;
revoke all on table public.order_payments from anon;
revoke all on table public.order_payments from authenticated;

create or replace function public.order_payments_prevent_immutable_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Удаление платежей запрещено — используйте сторнирование';
  end if;

  if new.order_id is distinct from old.order_id
     or new.amount is distinct from old.amount
     or new.payment_date is distinct from old.payment_date
     or new.payment_method is distinct from old.payment_method
     or new.reference_number is distinct from old.reference_number
     or new.comment is distinct from old.comment
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_at is distinct from old.recorded_at
  then
    raise exception
      'Изменение суммы и основных полей платежа запрещено — сторнируйте и создайте новую запись';
  end if;

  if old.status = 'reversed' then
    raise exception 'Сторнированный платёж нельзя изменять';
  end if;

  if old.status = 'confirmed' and new.status = 'reversed' then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception 'Недопустимый переход статуса платежа';
  end if;

  return new;
end;
$$;

drop trigger if exists order_payments_prevent_immutable_update on public.order_payments;
create trigger order_payments_prevent_immutable_update
  before update or delete on public.order_payments
  for each row
  execute function public.order_payments_prevent_immutable_update();

revoke all on function public.order_payments_prevent_immutable_update() from public;
revoke all on function public.order_payments_prevent_immutable_update() from anon;
revoke all on function public.order_payments_prevent_immutable_update() from authenticated;

-- ============================================================
-- 3. Extend order_activity_log for payment events
-- Diagnose actual CHECK by definition (do not drop by guessed name only).
-- ============================================================

do $$
declare
  v_conname text;
  v_def text;
begin
  select c.conname, pg_get_constraintdef(c.oid)
  into v_conname, v_def
  from pg_constraint as c
  join pg_class as t on t.oid = c.conrelid
  join pg_namespace as n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_activity_log'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%event_type%'
  order by c.conname
  limit 1;

  if v_conname is null then
    raise exception
      'order_activity_log event_type CHECK not found — unexpected schema state';
  end if;

  raise notice '022 dropping activity CHECK % : %', v_conname, v_def;
  execute format(
    'alter table public.order_activity_log drop constraint %I',
    v_conname
  );
end;
$$;

alter table public.order_activity_log
  add constraint order_activity_log_event_type_check check (
    event_type in (
      'manager_assigned',
      'manager_unassigned',
      'deadlines_updated',
      'payment_recorded',
      'payment_reversed',
      'payment_completed',
      'payment_shortfall_after_reversal'
    )
  );

-- Existing rows must still satisfy the new CHECK (old events preserved).
do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad
  from public.order_activity_log as a
  where a.event_type not in (
    'manager_assigned',
    'manager_unassigned',
    'deadlines_updated',
    'payment_recorded',
    'payment_reversed',
    'payment_completed',
    'payment_shortfall_after_reversal'
  );

  if v_bad > 0 then
    raise exception
      'order_activity_log has % row(s) with unsupported event_type',
      v_bad;
  end if;
end;
$$;

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
       'payment_shortfall_after_reversal'
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

revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb) from public;
revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb) from anon;
revoke all on function public.staff_record_order_activity(uuid, text, text, jsonb) from authenticated;

-- ============================================================
-- 4. Internal helpers (NO GRANT to authenticated)
-- ============================================================

create or replace function public.staff_payment_rounding_tolerance()
returns numeric
language sql
immutable
security definer
set search_path = ''
as $$
  select 0.01::numeric(14, 2);
$$;

revoke all on function public.staff_payment_rounding_tolerance() from public;
revoke all on function public.staff_payment_rounding_tolerance() from anon;
revoke all on function public.staff_payment_rounding_tolerance() from authenticated;

create or replace function public.staff_derive_payment_status(
  p_amount_due numeric,
  p_amount_paid numeric
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_tol numeric(14, 2) := public.staff_payment_rounding_tolerance();
  v_due numeric(14, 2) := coalesce(p_amount_due, 0);
  v_paid numeric(14, 2) := coalesce(p_amount_paid, 0);
  v_remaining numeric(14, 2);
begin
  v_remaining := v_due - v_paid;

  if v_paid <= 0 then
    return 'unpaid';
  end if;

  if v_paid > v_due + v_tol then
    return 'overpaid';
  end if;

  if v_remaining <= v_tol then
    return 'paid';
  end if;

  return 'partially_paid';
end;
$$;

revoke all on function public.staff_derive_payment_status(numeric, numeric) from public;
revoke all on function public.staff_derive_payment_status(numeric, numeric) from anon;
revoke all on function public.staff_derive_payment_status(numeric, numeric) from authenticated;

-- Safe finite numeric check (rejects NaN/Infinity from float casts).
create or replace function public.staff_assert_finite_money(p_value numeric, p_label text)
returns numeric
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v numeric(14, 2);
begin
  if p_value is null then
    raise exception '% обязателен', p_label;
  end if;

  -- numeric has no NaN; still reject absurd magnitudes / non-finite via text.
  if p_value::text ~* '(nan|inf)' then
    raise exception '% имеет недопустимое значение', p_label;
  end if;

  v := round(p_value, 2);
  return v;
end;
$$;

revoke all on function public.staff_assert_finite_money(numeric, text) from public;
revoke all on function public.staff_assert_finite_money(numeric, text) from anon;
revoke all on function public.staff_assert_finite_money(numeric, text) from authenticated;

create or replace function public.staff_sanitize_payment_text(
  p_value text,
  p_label text,
  p_max_len integer
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  v := nullif(trim(coalesce(p_value, '')), '');
  if v is null then
    return null;
  end if;

  if v ~ '[[:cntrl:]]' then
    raise exception '% содержит недопустимые управляющие символы', p_label;
  end if;

  if char_length(v) > p_max_len then
    raise exception '% слишком длинный (макс. %)', p_label, p_max_len;
  end if;

  return v;
end;
$$;

revoke all on function public.staff_sanitize_payment_text(text, text, integer) from public;
revoke all on function public.staff_sanitize_payment_text(text, text, integer) from anon;
revoke all on function public.staff_sanitize_payment_text(text, text, integer) from authenticated;

/**
 * Provisional (unfrozen) amount_due:
 *   generated invoice metadata.totals.final_total → else orders.total
 * Never reads live organization settings.
 */
create or replace function public.staff_peek_provisional_amount_due(p_order_id uuid)
returns table (
  amount_due numeric,
  source_type text,
  source_document_id uuid,
  source_number text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_doc public.order_documents;
  v_raw jsonb;
  v_final numeric;
begin
  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  select * into v_doc
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = 'invoice'
    and d.status = 'generated'
  limit 1;

  if found then
    v_raw := v_doc.metadata -> 'totals' -> 'final_total';
    if v_raw is null or v_raw = 'null'::jsonb then
      v_raw := v_doc.metadata -> 'totals' -> 'total';
    end if;

    if v_raw is null or v_raw = 'null'::jsonb then
      raise exception 'Счёт % не содержит metadata.totals.final_total', v_doc.number;
    end if;

    begin
      v_final := (v_raw #>> '{}')::numeric;
    exception
      when others then
        raise exception 'Счёт %: final_total не является числом', v_doc.number;
    end;

    if v_final::text ~* '(nan|inf)' then
      raise exception 'Счёт %: final_total недопустим', v_doc.number;
    end if;

    if v_final is null or v_final < 0 then
      raise exception 'Счёт %: final_total должен быть >= 0', v_doc.number;
    end if;

    return query
    select
      round(v_final, 2),
      'invoice'::text,
      v_doc.id,
      v_doc.number;
    return;
  end if;

  return query
  select
    round(coalesce(v_order.total, 0), 2),
    'order'::text,
    null::uuid,
    null::text;
end;
$$;

revoke all on function public.staff_peek_provisional_amount_due(uuid) from public;
revoke all on function public.staff_peek_provisional_amount_due(uuid) from anon;
revoke all on function public.staff_peek_provisional_amount_due(uuid) from authenticated;

/**
 * Resolve amount_due:
 *   1) frozen obligation if present
 *   2) else provisional (invoice snapshot / orders.total)
 */
create or replace function public.staff_resolve_order_amount_due(p_order_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_frozen numeric(14, 2);
  v_peek record;
begin
  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select o.amount_due into v_frozen
  from public.order_payment_obligations as o
  where o.order_id = p_order_id;

  if found then
    return v_frozen;
  end if;

  select * into v_peek from public.staff_peek_provisional_amount_due(p_order_id);
  return v_peek.amount_due;
end;
$$;

revoke all on function public.staff_resolve_order_amount_due(uuid) from public;
revoke all on function public.staff_resolve_order_amount_due(uuid) from anon;
revoke all on function public.staff_resolve_order_amount_due(uuid) from authenticated;

-- Caller MUST hold orders FOR UPDATE.
create or replace function public.staff_freeze_order_payment_obligation(p_order_id uuid)
returns public.order_payment_obligations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.order_payment_obligations;
  v_peek record;
  v_row public.order_payment_obligations;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_existing
  from public.order_payment_obligations as o
  where o.order_id = p_order_id
  for update;

  if found then
    return v_existing;
  end if;

  select * into v_peek from public.staff_peek_provisional_amount_due(p_order_id);

  if v_peek.amount_due is null or v_peek.amount_due < 0 then
    raise exception 'Некорректная сумма обязательства';
  end if;

  begin
    insert into public.order_payment_obligations (
      order_id,
      amount_due,
      source_type,
      source_document_id,
      source_number,
      frozen_by,
      metadata
    ) values (
      p_order_id,
      v_peek.amount_due,
      v_peek.source_type,
      v_peek.source_document_id,
      v_peek.source_number,
      v_uid,
      jsonb_build_object(
        'frozen_from', v_peek.source_type,
        'provisional_amount_due', v_peek.amount_due
      )
    )
    returning * into v_row;
  exception
    when unique_violation then
      select * into v_row
      from public.order_payment_obligations as o
      where o.order_id = p_order_id;
  end;

  return v_row;
end;
$$;

revoke all on function public.staff_freeze_order_payment_obligation(uuid) from public;
revoke all on function public.staff_freeze_order_payment_obligation(uuid) from anon;
revoke all on function public.staff_freeze_order_payment_obligation(uuid) from authenticated;

-- Called from invoice generation under orders FOR UPDATE.
create or replace function public.staff_assert_invoice_matches_frozen_obligation(
  p_order_id uuid,
  p_invoice_final_total numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obl public.order_payment_obligations;
  v_total numeric(14, 2);
  v_tol numeric(14, 2) := public.staff_payment_rounding_tolerance();
begin
  select * into v_obl
  from public.order_payment_obligations as o
  where o.order_id = p_order_id
  for update;

  if not found then
    return;
  end if;

  v_total := public.staff_assert_finite_money(p_invoice_final_total, 'Итого счёта');

  if abs(v_total - v_obl.amount_due) > v_tol then
    raise exception
      'Нельзя создать счёт на %: обязательство уже зафиксировано на % (источник: %). Создайте счёт без изменения суммы либо сторнируйте оплаты и обратитесь к администратору.',
      v_total,
      v_obl.amount_due,
      v_obl.source_type;
  end if;
end;
$$;

revoke all on function public.staff_assert_invoice_matches_frozen_obligation(uuid, numeric)
  from public;
revoke all on function public.staff_assert_invoice_matches_frozen_obligation(uuid, numeric)
  from anon;
revoke all on function public.staff_assert_invoice_matches_frozen_obligation(uuid, numeric)
  from authenticated;

create or replace function public.staff_sum_confirmed_order_payments(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(p.amount), 0)::numeric(14, 2)
  from public.order_payments as p
  where p.order_id = p_order_id
    and p.status = 'confirmed';
$$;

revoke all on function public.staff_sum_confirmed_order_payments(uuid) from public;
revoke all on function public.staff_sum_confirmed_order_payments(uuid) from anon;
revoke all on function public.staff_sum_confirmed_order_payments(uuid) from authenticated;

create or replace function public.staff_order_has_payment_shortfall(
  p_order_status text,
  p_payment_status text,
  p_amount_remaining numeric
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select
    p_order_status in (
      'paid',
      'picking',
      'ready_for_shipment',
      'shipped',
      'completed'
    )
    and (
      p_payment_status in ('unpaid', 'partially_paid')
      or coalesce(p_amount_remaining, 0) > public.staff_payment_rounding_tolerance()
    );
$$;

revoke all on function public.staff_order_has_payment_shortfall(text, text, numeric) from public;
revoke all on function public.staff_order_has_payment_shortfall(text, text, numeric) from anon;
revoke all on function public.staff_order_has_payment_shortfall(text, text, numeric) from authenticated;

-- ============================================================
-- 5. Staff payment summary / list RPCs
-- ============================================================

create or replace function public.staff_get_order_payment_summary(p_order_id uuid)
returns table (
  order_id uuid,
  order_number text,
  order_status text,
  amount_due numeric,
  amount_paid numeric,
  amount_remaining numeric,
  payment_status text,
  invoice_id uuid,
  invoice_number text,
  invoice_tax_mode text,
  invoice_final_total numeric,
  has_payment_shortfall boolean,
  payment_due_at timestamptz,
  obligation_frozen boolean,
  obligation_source_type text,
  obligation_source_number text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_doc public.order_documents;
  v_obl public.order_payment_obligations;
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_remaining numeric(14, 2);
  v_status text;
  v_tax text;
  v_inv_final numeric;
  v_peek record;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра оплат';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  select * into v_obl
  from public.order_payment_obligations as o
  where o.order_id = p_order_id;

  if found then
    v_due := v_obl.amount_due;
  else
    select * into v_peek from public.staff_peek_provisional_amount_due(p_order_id);
    v_due := v_peek.amount_due;
  end if;

  v_paid := public.staff_sum_confirmed_order_payments(p_order_id);
  v_remaining := v_due - v_paid;
  v_status := public.staff_derive_payment_status(v_due, v_paid);

  select * into v_doc
  from public.order_documents as d
  where d.order_id = p_order_id
    and d.document_type = 'invoice'
    and d.status = 'generated'
  limit 1;

  if found then
    v_tax := nullif(trim(coalesce(v_doc.metadata -> 'totals' ->> 'tax_mode', '')), '');
    begin
      v_inv_final := (v_doc.metadata -> 'totals' ->> 'final_total')::numeric;
    exception
      when others then
        v_inv_final := null;
    end;
  end if;

  return query
  select
    v_order.id,
    v_order.order_number,
    v_order.status,
    v_due,
    v_paid,
    v_remaining,
    v_status,
    v_doc.id,
    v_doc.number,
    v_tax,
    round(v_inv_final, 2),
    public.staff_order_has_payment_shortfall(v_order.status, v_status, v_remaining),
    v_order.payment_due_at,
    (v_obl.order_id is not null),
    v_obl.source_type,
    coalesce(v_obl.source_number, v_doc.number);
end;
$$;

revoke all on function public.staff_get_order_payment_summary(uuid) from public;
revoke all on function public.staff_get_order_payment_summary(uuid) from anon;
revoke all on function public.staff_get_order_payment_summary(uuid) from authenticated;
grant execute on function public.staff_get_order_payment_summary(uuid) to authenticated;

create or replace function public.staff_list_orders_payment_summaries(p_order_ids uuid[])
returns table (
  order_id uuid,
  order_number text,
  order_status text,
  amount_due numeric,
  amount_paid numeric,
  amount_remaining numeric,
  payment_status text,
  invoice_id uuid,
  invoice_number text,
  has_payment_shortfall boolean,
  payment_due_at timestamptz,
  obligation_frozen boolean,
  obligation_source_type text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра оплат';
  end if;

  v_ids := coalesce(p_order_ids, array[]::uuid[]);
  if cardinality(v_ids) is null or cardinality(v_ids) = 0 then
    return;
  end if;

  if cardinality(v_ids) > 500 then
    raise exception 'Слишком много заказов в одном запросе (макс. 500)';
  end if;

  return query
  with wanted as (
    select distinct unnest(v_ids) as id
  ),
  base as (
    select
      o.id as oid,
      o.order_number,
      o.status as ostatus,
      o.total as order_total,
      o.payment_due_at,
      d.id as doc_id,
      d.number as doc_number,
      d.metadata as doc_metadata,
      obl.amount_due as frozen_due,
      obl.source_type as frozen_source,
      (obl.order_id is not null) as is_frozen
    from wanted as w
    inner join public.orders as o on o.id = w.id
    left join public.order_documents as d
      on d.order_id = o.id
     and d.document_type = 'invoice'
     and d.status = 'generated'
    left join public.order_payment_obligations as obl
      on obl.order_id = o.id
  ),
  paid as (
    select
      p.order_id,
      coalesce(sum(p.amount), 0)::numeric(14, 2) as amount_paid
    from public.order_payments as p
    where p.order_id in (select id from wanted)
      and p.status = 'confirmed'
    group by p.order_id
  ),
  due as (
    select
      b.*,
      case
        when b.is_frozen then round(b.frozen_due, 2)
        when b.doc_id is not null then
          round(
            coalesce(
              nullif(b.doc_metadata -> 'totals' ->> 'final_total', '')::numeric,
              nullif(b.doc_metadata -> 'totals' ->> 'total', '')::numeric,
              b.order_total
            ),
            2
          )
        else round(coalesce(b.order_total, 0), 2)
      end as amount_due
    from base as b
  )
  select
    d.oid,
    d.order_number,
    d.ostatus,
    d.amount_due,
    coalesce(paid.amount_paid, 0)::numeric(14, 2),
    (d.amount_due - coalesce(paid.amount_paid, 0))::numeric(14, 2),
    public.staff_derive_payment_status(d.amount_due, coalesce(paid.amount_paid, 0)),
    d.doc_id,
    d.doc_number,
    public.staff_order_has_payment_shortfall(
      d.ostatus,
      public.staff_derive_payment_status(d.amount_due, coalesce(paid.amount_paid, 0)),
      d.amount_due - coalesce(paid.amount_paid, 0)
    ),
    d.payment_due_at,
    d.is_frozen,
    d.frozen_source
  from due as d
  left join paid on paid.order_id = d.oid;
end;
$$;

revoke all on function public.staff_list_orders_payment_summaries(uuid[]) from public;
revoke all on function public.staff_list_orders_payment_summaries(uuid[]) from anon;
revoke all on function public.staff_list_orders_payment_summaries(uuid[]) from authenticated;
grant execute on function public.staff_list_orders_payment_summaries(uuid[]) to authenticated;

create or replace function public.staff_list_order_payments(p_order_id uuid)
returns table (
  id uuid,
  order_id uuid,
  amount numeric,
  payment_date date,
  payment_method text,
  reference_number text,
  comment text,
  status text,
  recorded_by uuid,
  recorded_by_name text,
  recorded_at timestamptz,
  reversed_by uuid,
  reversed_by_name text,
  reversed_at timestamptz,
  reversal_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра оплат';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if not exists (select 1 from public.orders as o where o.id = p_order_id) then
    raise exception 'Заказ не найден';
  end if;

  return query
  select
    p.id,
    p.order_id,
    p.amount,
    p.payment_date,
    p.payment_method,
    p.reference_number,
    p.comment,
    p.status,
    p.recorded_by,
    rp.full_name,
    p.recorded_at,
    p.reversed_by,
    vp.full_name,
    p.reversed_at,
    p.reversal_reason
  from public.order_payments as p
  left join public.profiles as rp on rp.id = p.recorded_by
  left join public.profiles as vp on vp.id = p.reversed_by
  where p.order_id = p_order_id
  order by p.recorded_at desc, p.payment_date desc;
end;
$$;

revoke all on function public.staff_list_order_payments(uuid) from public;
revoke all on function public.staff_list_order_payments(uuid) from anon;
revoke all on function public.staff_list_order_payments(uuid) from authenticated;
grant execute on function public.staff_list_order_payments(uuid) to authenticated;

-- ============================================================
-- 6. Record / reverse payments
-- ============================================================

create or replace function public.staff_record_order_payment(
  p_order_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_reference_number text default null,
  p_comment text default null
)
returns public.order_payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_order public.orders;
  v_amount numeric(14, 2);
  v_method text;
  v_ref text;
  v_comment text;
  v_obl public.order_payment_obligations;
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_remaining numeric(14, 2);
  v_new_paid numeric(14, 2);
  v_payment public.order_payments;
  v_prev_status text;
  v_new_status text;
  v_tol numeric(14, 2) := public.staff_payment_rounding_tolerance();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для регистрации оплаты';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  v_amount := public.staff_assert_finite_money(p_amount, 'Сумма оплаты');
  if v_amount <= 0 then
    raise exception 'Сумма оплаты должна быть больше 0';
  end if;

  if p_payment_date is null then
    raise exception 'Дата оплаты обязательна';
  end if;

  -- Max +1 calendar day in the future.
  if p_payment_date > (current_date + 1) then
    raise exception 'Дата оплаты не может быть далеко в будущем (макс. +1 день)';
  end if;

  v_method := lower(trim(coalesce(p_payment_method, '')));
  if v_method not in ('bank_transfer', 'cash', 'card_terminal', 'other') then
    raise exception
      'Способ оплаты должен быть bank_transfer, cash, card_terminal или other';
  end if;

  v_ref := public.staff_sanitize_payment_text(
    p_reference_number, 'Номер платёжного документа', 100
  );
  v_comment := public.staff_sanitize_payment_text(p_comment, 'Комментарий', 1000);

  -- Lock order first (same order as invoice generate / status / reverse).
  select * into v_order
  from public.orders as o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  if v_order.status = 'cancelled' then
    raise exception 'Нельзя регистрировать оплату по отменённому заказу';
  end if;

  -- Freeze obligation atomically on first payment (under order lock).
  v_obl := public.staff_freeze_order_payment_obligation(p_order_id);
  v_due := v_obl.amount_due;
  v_paid := public.staff_sum_confirmed_order_payments(p_order_id);
  v_remaining := v_due - v_paid;
  v_prev_status := public.staff_derive_payment_status(v_due, v_paid);

  if v_amount > v_remaining then
    raise exception
      'Сумма оплаты (%) превышает остаток к оплате (%). Переплата запрещена.',
      v_amount,
      v_remaining;
  end if;

  insert into public.order_payments (
    order_id,
    amount,
    payment_date,
    payment_method,
    reference_number,
    comment,
    status,
    recorded_by
  ) values (
    p_order_id,
    v_amount,
    p_payment_date,
    v_method,
    v_ref,
    v_comment,
    'confirmed',
    v_uid
  )
  returning * into v_payment;

  v_new_paid := v_paid + v_amount;
  v_new_status := public.staff_derive_payment_status(v_due, v_new_paid);

  perform public.staff_record_order_activity(
    p_order_id,
    'payment_recorded',
    format('Зарегистрирована оплата %s ₸', v_amount),
    jsonb_build_object(
      'payment_id', v_payment.id,
      'amount', v_amount,
      'payment_method', v_method,
      'reference_number', v_ref,
      'payment_date', p_payment_date,
      'previous_payment_status', v_prev_status,
      'updated_payment_status', v_new_status,
      'amount_due', v_due,
      'amount_paid', v_new_paid,
      'amount_remaining', v_due - v_new_paid,
      'obligation_source_type', v_obl.source_type,
      'obligation_source_number', v_obl.source_number
    )
  );

  if v_new_status = 'paid'
     and v_prev_status is distinct from 'paid'
     and v_due > 0
     and v_new_paid + v_tol >= v_due
  then
    perform public.staff_record_order_activity(
      p_order_id,
      'payment_completed',
      'Заказ оплачен полностью (статус заказа не изменён автоматически)',
      jsonb_build_object(
        'payment_id', v_payment.id,
        'amount', v_amount,
        'payment_method', v_method,
        'reference_number', v_ref,
        'previous_payment_status', v_prev_status,
        'updated_payment_status', v_new_status,
        'amount_due', v_due,
        'amount_paid', v_new_paid,
        'amount_remaining', v_due - v_new_paid
      )
    );
  end if;

  return v_payment;
end;
$$;

revoke all on function public.staff_record_order_payment(uuid, numeric, date, text, text, text)
  from public;
revoke all on function public.staff_record_order_payment(uuid, numeric, date, text, text, text)
  from anon;
revoke all on function public.staff_record_order_payment(uuid, numeric, date, text, text, text)
  from authenticated;
grant execute on function public.staff_record_order_payment(uuid, numeric, date, text, text, text)
  to authenticated;

create or replace function public.staff_reverse_order_payment(
  p_payment_id uuid,
  p_reason text
)
returns public.order_payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_payment public.order_payments;
  v_order public.orders;
  v_order_id uuid;
  v_reason text;
  v_due numeric(14, 2);
  v_paid_before numeric(14, 2);
  v_paid_after numeric(14, 2);
  v_prev_status text;
  v_new_status text;
  v_remaining numeric(14, 2);
  v_shortfall_before boolean;
  v_shortfall_after boolean;
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для сторнирования оплаты';
  end if;

  if p_payment_id is null then
    raise exception 'payment_id обязателен';
  end if;

  v_reason := public.staff_sanitize_payment_text(p_reason, 'Причина сторнирования', 1000);
  if v_reason is null then
    raise exception 'Причина сторнирования обязательна';
  end if;

  select p.order_id into v_order_id
  from public.order_payments as p
  where p.id = p_payment_id;

  if not found then
    raise exception 'Платёж не найден';
  end if;

  -- Lock order first, then payment (same order as record / paid transition).
  select * into v_order
  from public.orders as o
  where o.id = v_order_id
  for update;

  if not found then
    raise exception 'Заказ не найден';
  end if;

  select * into v_payment
  from public.order_payments as p
  where p.id = p_payment_id
  for update;

  if not found then
    raise exception 'Платёж не найден';
  end if;

  if v_payment.status <> 'confirmed' then
    raise exception 'Сторнировать можно только confirmed платёж';
  end if;

  v_due := public.staff_resolve_order_amount_due(v_order.id);
  v_paid_before := public.staff_sum_confirmed_order_payments(v_order.id);
  v_prev_status := public.staff_derive_payment_status(v_due, v_paid_before);
  v_shortfall_before := public.staff_order_has_payment_shortfall(
    v_order.status, v_prev_status, v_due - v_paid_before
  );

  update public.order_payments as p
  set
    status = 'reversed',
    reversed_by = v_uid,
    reversed_at = now(),
    reversal_reason = v_reason
  where p.id = p_payment_id
  returning * into v_payment;

  v_paid_after := public.staff_sum_confirmed_order_payments(v_order.id);
  v_new_status := public.staff_derive_payment_status(v_due, v_paid_after);
  v_remaining := v_due - v_paid_after;
  v_shortfall_after := public.staff_order_has_payment_shortfall(
    v_order.status, v_new_status, v_remaining
  );

  perform public.staff_record_order_activity(
    v_order.id,
    'payment_reversed',
    format('Сторнирована оплата %s ₸', v_payment.amount),
    jsonb_build_object(
      'payment_id', v_payment.id,
      'amount', v_payment.amount,
      'payment_method', v_payment.payment_method,
      'reference_number', v_payment.reference_number,
      'reversal_reason', v_reason,
      'previous_payment_status', v_prev_status,
      'updated_payment_status', v_new_status,
      'amount_due', v_due,
      'amount_paid', v_paid_after,
      'amount_remaining', v_remaining
    )
  );

  -- Shortfall activity only on transition into shortfall (once per entry).
  -- Do NOT roll back order workflow.
  if v_shortfall_after and not v_shortfall_before then
    perform public.staff_record_order_activity(
      v_order.id,
      'payment_shortfall_after_reversal',
      'Оплата сторнирована, заказ недофинансирован — статус заказа не откатан',
      jsonb_build_object(
        'payment_id', v_payment.id,
        'amount', v_payment.amount,
        'order_status', v_order.status,
        'previous_payment_status', v_prev_status,
        'updated_payment_status', v_new_status,
        'amount_due', v_due,
        'amount_paid', v_paid_after,
        'amount_remaining', v_remaining,
        'reversal_reason', v_reason
      )
    );
  end if;

  return v_payment;
end;
$$;

revoke all on function public.staff_reverse_order_payment(uuid, text) from public;
revoke all on function public.staff_reverse_order_payment(uuid, text) from anon;
revoke all on function public.staff_reverse_order_payment(uuid, text) from authenticated;
grant execute on function public.staff_reverse_order_payment(uuid, text) to authenticated;

-- ============================================================
-- 7. Gate awaiting_payment → paid (preserve 017 workflow body otherwise)
-- ============================================================

create or replace function public.staff_change_order_status(
  p_order_id uuid,
  p_new_status text,
  p_note text default null
)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_from text;
  v_task public.order_picking_tasks;
  v_uid uuid := auth.uid();
  v_due numeric(14, 2);
  v_paid numeric(14, 2);
  v_tol numeric(14, 2) := public.staff_payment_rounding_tolerance();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;

  -- warehouse intentionally excluded — use dedicated warehouse RPCs.
  if not public.has_staff_role(array['manager', 'admin']::public.user_role[]) then
    raise exception 'Недостаточно прав для изменения статуса заказа';
  end if;

  if p_order_id is null then
    raise exception 'order_id обязателен';
  end if;

  if p_new_status is null or length(trim(p_new_status)) = 0 then
    raise exception 'Новый статус обязателен';
  end if;

  if p_new_status = 'cancelled' then
    raise exception 'Для отмены используйте public.staff_cancel_order(...)';
  end if;

  select * into v_order from public.orders as o where o.id = p_order_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;

  v_from := v_order.status;

  if v_from in ('completed', 'cancelled') then
    raise exception 'Заказ в финальном статусе "%" нельзя изменить', v_from;
  end if;

  if not public.staff_is_status_transition_allowed(v_from, p_new_status) then
    raise exception 'Переход статуса "%" → "%" запрещён', v_from, p_new_status;
  end if;

  if v_from = 'shipped' and p_new_status = 'ready_for_shipment' then
    raise exception 'Возврат shipped → ready_for_shipment запрещён: товар уже списан';
  end if;

  if p_new_status = 'awaiting_payment' then
    if not exists (select 1 from public.order_items as oi where oi.order_id = p_order_id) then
      raise exception 'Нельзя отправить на оплату пустой заказ';
    end if;
    perform public.staff_assert_active_reservations_consistent(p_order_id);
  end if;

  if v_from = 'awaiting_payment' and p_new_status = 'paid' then
    perform public.staff_assert_active_reservations_consistent(p_order_id);

    -- Payment gate under order lock (blocks concurrent reversal mid-transition).
    v_due := public.staff_resolve_order_amount_due(p_order_id);
    v_paid := public.staff_sum_confirmed_order_payments(p_order_id);

    if v_due <= 0 then
      raise exception
        'Нельзя перевести в «Оплачен»: сумма к оплате должна быть больше 0';
    end if;

    if v_paid + v_tol < v_due then
      raise exception
        'Нельзя перевести в «Оплачен»: оплачено % из % (осталось %)',
        v_paid,
        v_due,
        v_due - v_paid;
    end if;
  end if;

  -- Forward warehouse transitions: reuse dedicated RPCs (picking rules + DN).
  if v_from = 'paid' and p_new_status = 'picking' then
    perform public.staff_start_order_picking(p_order_id);
    select * into v_order from public.orders as o where o.id = p_order_id;
    return v_order;
  end if;

  if v_from = 'picking' and p_new_status = 'ready_for_shipment' then
    perform public.staff_complete_order_picking(p_order_id);
    select * into v_order from public.orders as o where o.id = p_order_id;
    return v_order;
  end if;

  if v_from = 'ready_for_shipment' and p_new_status = 'shipped' then
    perform public.staff_ship_order(p_order_id);
    select * into v_order from public.orders as o where o.id = p_order_id;
    return v_order;
  end if;

  if v_from = 'picking' and p_new_status = 'paid' then
    perform public.staff_cancel_picking_task_for_order(p_order_id);
  end if;

  if v_from = 'ready_for_shipment' and p_new_status = 'picking' then
    select * into v_task
    from public.order_picking_tasks as t
    where t.order_id = p_order_id
    for update;

    if found and v_task.status = 'completed' then
      update public.order_picking_tasks as t
      set
        status = 'in_progress',
        completed_at = null,
        updated_at = now()
      where t.id = v_task.id;
    end if;
  end if;

  update public.orders as o
  set status = p_new_status
  where o.id = p_order_id
  returning * into v_order;

  perform public.staff_record_order_status_change(
    p_order_id, v_from, p_new_status, p_note
  );

  return v_order;
end;
$$;

revoke all on function public.staff_change_order_status(uuid, text, text) from public;
revoke all on function public.staff_change_order_status(uuid, text, text) from anon;
revoke all on function public.staff_change_order_status(uuid, text, text) from authenticated;
grant execute on function public.staff_change_order_status(uuid, text, text) to authenticated;

-- ============================================================
-- 8. Client payment summary (ownership via orders.user_id)
-- ============================================================

create or replace function public.client_get_order_payment_summary(p_order_id uuid)
returns table (
  amount_due numeric,
  amount_paid numeric,
  amount_remaining numeric,
  payment_status text,
  invoice_number text
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
  v_inv text;
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

  select o.source_number into v_inv
  from public.order_payment_obligations as o
  where o.order_id = p_order_id
    and o.source_type = 'invoice';

  if v_inv is null then
    select d.number into v_inv
    from public.order_documents as d
    where d.order_id = p_order_id
      and d.document_type = 'invoice'
      and d.status = 'generated'
    limit 1;
  end if;

  return query
  select
    v_due,
    v_paid,
    (v_due - v_paid)::numeric(14, 2),
    public.staff_derive_payment_status(v_due, v_paid),
    v_inv;
end;
$$;

revoke all on function public.client_get_order_payment_summary(uuid) from public;
revoke all on function public.client_get_order_payment_summary(uuid) from anon;
revoke all on function public.client_get_order_payment_summary(uuid) from authenticated;
grant execute on function public.client_get_order_payment_summary(uuid) to authenticated;

-- ============================================================
-- 9. Customer receivables (frozen obligation preferred; no N+1)
-- ============================================================

create or replace function public.staff_get_customer_receivables(p_customer_id uuid)
returns table (
  customer_id uuid,
  open_obligation_total numeric,
  amount_paid_total numeric,
  amount_outstanding_total numeric,
  orders_with_balance_count integer,
  overdue_outstanding_total numeric,
  overdue_orders_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.has_staff_role(
    array['manager', 'accountant', 'admin']::public.user_role[]
  ) then
    raise exception 'Недостаточно прав для просмотра дебиторки';
  end if;

  if p_customer_id is null then
    raise exception 'customer_id обязателен';
  end if;

  if not exists (
    select 1 from public.customers as c where c.id = p_customer_id
  ) then
    raise exception 'Клиент не найден';
  end if;

  return query
  with order_rows as (
    select
      o.id,
      o.status,
      o.total,
      o.payment_due_at,
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
    where o.customer_id = p_customer_id
      and o.status <> 'cancelled'
  ),
  with_due as (
    select
      r.id,
      r.status,
      r.payment_due_at,
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
      d.id,
      d.status,
      d.payment_due_at,
      d.amount_due,
      coalesce(sum(p.amount) filter (where p.status = 'confirmed'), 0)::numeric(14, 2)
        as amount_paid
    from with_due as d
    left join public.order_payments as p on p.order_id = d.id
    group by d.id, d.status, d.payment_due_at, d.amount_due
  ),
  computed as (
    select
      w.*,
      (w.amount_due - w.amount_paid) as amount_remaining
    from with_paid as w
  )
  select
    p_customer_id,
    coalesce(sum(c.amount_due), 0)::numeric(14, 2),
    coalesce(sum(c.amount_paid), 0)::numeric(14, 2),
    coalesce(sum(greatest(c.amount_remaining, 0)), 0)::numeric(14, 2),
    coalesce(
      count(*) filter (
        where c.amount_remaining > public.staff_payment_rounding_tolerance()
      ),
      0
    )::integer,
    coalesce(
      sum(greatest(c.amount_remaining, 0)) filter (
        where c.payment_due_at is not null
          and c.payment_due_at < now()
          and c.amount_remaining > public.staff_payment_rounding_tolerance()
      ),
      0
    )::numeric(14, 2),
    coalesce(
      count(*) filter (
        where c.payment_due_at is not null
          and c.payment_due_at < now()
          and c.amount_remaining > public.staff_payment_rounding_tolerance()
      ),
      0
    )::integer
  from computed as c;
end;
$$;

revoke all on function public.staff_get_customer_receivables(uuid) from public;
revoke all on function public.staff_get_customer_receivables(uuid) from anon;
revoke all on function public.staff_get_customer_receivables(uuid) from authenticated;
grant execute on function public.staff_get_customer_receivables(uuid) to authenticated;

-- ============================================================
-- 10. Invoice generation — lock order first + freeze gate (018 body)
-- ============================================================

-- Replaces 018 staff_generate_order_document: order FOR UPDATE first, then intent;
-- asserts frozen obligation matches invoice final_total before insert.
-- Wrappers unchanged in signature (GRANT preserved).

create or replace function public.staff_generate_order_document(
  p_order_id uuid,
  p_document_type text,
  p_tax_mode text,
  p_snapshot_intent_id uuid,
  p_contract_number text default null,
  p_contract_date date default null
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
  v_contract_number text := nullif(trim(p_contract_number), '');
  v_contract_date date := p_contract_date;
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

  -- Contract fields are invoice-only snapshot params (no live order columns).
  if p_document_type = 'delivery_note'
     and (v_contract_number is not null or v_contract_date is not null)
  then
    raise exception 'Параметры договора применимы только к счёту';
  end if;

  if v_contract_number is not null then
    if char_length(v_contract_number) > 120 then
      raise exception 'Номер договора слишком длинный (макс. 120 символов)';
    end if;
    if v_contract_number ~ '[[:cntrl:]]' then
      raise exception 'Номер договора содержит недопустимые символы';
    end if;
  end if;

  if v_contract_date is not null and v_contract_number is null then
    raise exception 'Укажите номер договора вместе с датой';
  end if;
  -- Number without date is allowed.

  -- Lock order FIRST (same order as payment RPCs) to serialize with
  -- staff_record_order_payment / freeze obligation.
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
    v_intent.signature_path,
    v_contract_number,
    v_contract_date
  );

  -- If payment obligation already frozen, invoice final_total must match it.
  if p_document_type = 'invoice' then
    perform public.staff_assert_invoice_matches_frozen_obligation(
      p_order_id,
      (v_metadata -> 'totals' ->> 'final_total')::numeric
    );
  end if;

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


create or replace function public.staff_generate_invoice(
  p_order_id uuid,
  p_tax_mode text,
  p_snapshot_intent_id uuid,
  p_contract_number text default null,
  p_contract_date date default null
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
    p_snapshot_intent_id,
    p_contract_number,
    p_contract_date
  );
end;
$$;

revoke all on function public.staff_generate_invoice(uuid, text, uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.staff_generate_invoice(uuid, text, uuid, text, date)
  to authenticated;

-- Delivery note signature unchanged (3 args) — contract params not exposed.
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
    p_snapshot_intent_id,
    null,
    null
  );
end;
$$;

revoke all on function public.staff_generate_delivery_note(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.staff_generate_delivery_note(uuid, text, uuid)
  to authenticated;

-- ============================================================
-- Done
-- ============================================================
-- Confirms:
--   - Frozen obligation on first payment
--   - Invoice after freeze must match frozen amount_due
--   - No online payment / acquiring
--   - No service_role usage
--   - Payments + obligations RPC-only
--   - Overpayment blocked for all roles
--   - Status paid gated; not auto-flipped on payment record
-- ============================================================
