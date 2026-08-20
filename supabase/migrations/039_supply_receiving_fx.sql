-- ============================================================
-- 039_supply_receiving_fx.sql
-- Stage 40 — factual receiving + supply-level FX
--
-- NOT applied automatically — apply by hand when ready.
-- Does NOT rewrite 036–038.
-- Does NOT create claims/compensation.
-- Does NOT build pallet WMS.
-- Does NOT reallocate landed cost for shortages.
-- Receiving is independent of logistics_status and financial draft/closed.
-- Access: active admin only (staff_assert_product_supply_admin).
-- ============================================================

do $$
begin
  if to_regclass('public.product_supplies') is null then
    raise exception 'public.product_supplies missing — run 036 first.';
  end if;
  if to_regprocedure('public.staff_assert_product_supply_admin()') is null then
    raise exception 'staff_assert_product_supply_admin missing — run 036 first.';
  end if;
  if to_regprocedure('public.staff_recalculate_product_supply(uuid)') is null then
    raise exception 'staff_recalculate_product_supply missing — run 036 first.';
  end if;
  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception 'staff_resolve_warehouse_id missing — run 011 first.';
  end if;
  if to_regclass('public.stock_receipts') is null then
    raise exception 'public.stock_receipts missing — run 030 first.';
  end if;
  if to_regclass('public.inventory') is null then
    raise exception 'public.inventory missing — run 002 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Enums
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_receiving_status') then
    create type public.product_supply_receiving_status as enum (
      'not_started',
      'in_progress',
      'completed'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_discrepancy_type') then
    create type public.product_supply_discrepancy_type as enum (
      'shortage',
      'overage',
      'damaged',
      'wrong_product',
      'pallet_mismatch',
      'unexpected',
      'other'
    );
  end if;
end
$$;

-- ============================================================
-- 2. Header / item columns
-- ============================================================

alter table public.product_supplies
  add column if not exists receiving_status public.product_supply_receiving_status
    not null default 'not_started';

alter table public.product_supplies
  add column if not exists active_receiving_id uuid;

comment on column public.product_supplies.receiving_status is
  'Factual Almaty receiving lifecycle. Independent of logistics and financial status.';

comment on column public.product_supplies.active_receiving_id is
  'Current draft/confirmed receiving row for this supply (one receiving per supply).';

comment on column public.product_supplies.inventory_receipt_id is
  'After Stage 40 confirm: stock_receipt_batch_id shared by stock_receipts of this receiving.';

alter table public.product_supply_items
  add column if not exists received_quantity numeric(14, 3);

alter table public.product_supply_items
  add column if not exists damaged_quantity numeric(14, 3);

alter table public.product_supply_items
  add column if not exists accepted_quantity numeric(14, 3);

alter table public.product_supply_expenses
  add column if not exists use_custom_exchange_rate boolean not null default false;

comment on column public.product_supply_expenses.use_custom_exchange_rate is
  'When false, expense inherits supply-level FX; when true, exchange_rate_to_kzt is an override snapshot.';

-- Relax ordered/shipped checks to allow 0 (unexpected goods / zero baselines).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_ordered_qty_positive'
  ) then
    alter table public.product_supply_items
      drop constraint product_supply_items_ordered_qty_positive;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_ordered_qty_non_negative'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_ordered_qty_non_negative
      check (ordered_quantity is null or ordered_quantity >= 0);
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_shipped_qty_positive'
  ) then
    alter table public.product_supply_items
      drop constraint product_supply_items_shipped_qty_positive;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_shipped_qty_non_negative'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_shipped_qty_non_negative
      check (shipped_quantity is null or shipped_quantity >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_received_qty_non_negative'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_received_qty_non_negative
      check (received_quantity is null or received_quantity >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_damaged_qty_non_negative'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_damaged_qty_non_negative
      check (damaged_quantity is null or damaged_quantity >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supply_items_accepted_qty_non_negative'
  ) then
    alter table public.product_supply_items
      add constraint product_supply_items_accepted_qty_non_negative
      check (accepted_quantity is null or accepted_quantity >= 0);
  end if;
end
$$;

-- ============================================================
-- 3. FX rates table
-- ============================================================

create table if not exists public.product_supply_fx_rates (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  currency public.product_supply_currency not null,
  rate_to_kzt numeric(18, 6) not null,
  effective_date date,
  source_note text,
  updated_by uuid references public.profiles (id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint product_supply_fx_rates_supply_currency_unique unique (supply_id, currency),
  constraint product_supply_fx_rates_currency_cny_usd check (currency in ('CNY', 'USD')),
  constraint product_supply_fx_rates_rate_positive check (rate_to_kzt > 0),
  constraint product_supply_fx_rates_source_note_len check (
    source_note is null or char_length(source_note) <= 500
  )
);

comment on table public.product_supply_fx_rates is
  'Supply-level CNY/USD → KZT rates. KZT is never stored (always 1). Item/expense rows keep historical snapshots.';

create index if not exists product_supply_fx_rates_supply_idx
  on public.product_supply_fx_rates (supply_id);

drop trigger if exists product_supply_fx_rates_set_updated_at on public.product_supply_fx_rates;
create trigger product_supply_fx_rates_set_updated_at
  before update on public.product_supply_fx_rates
  for each row
  execute function public.set_updated_at();

alter table public.product_supply_fx_rates enable row level security;
revoke all on table public.product_supply_fx_rates from public, anon, authenticated;

-- ============================================================
-- 4. Receiving tables
-- ============================================================

create table if not exists public.product_supply_receivings (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  status text not null default 'draft',
  warehouse_id uuid references public.warehouses (id) on delete restrict,
  started_by uuid not null references public.profiles (id) on delete restrict,
  started_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles (id) on delete restrict,
  confirmed_at timestamptz,
  stock_receipt_batch_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_supply_receivings_supply_unique unique (supply_id),
  constraint product_supply_receivings_status_check check (status in ('draft', 'confirmed')),
  constraint product_supply_receivings_batch_unique unique (stock_receipt_batch_id),
  constraint product_supply_receivings_notes_len check (
    notes is null or char_length(notes) <= 4000
  ),
  constraint product_supply_receivings_confirmed_fields check (
    (status = 'draft' and confirmed_at is null and confirmed_by is null)
    or (status = 'confirmed' and confirmed_at is not null and confirmed_by is not null)
  )
);

comment on table public.product_supply_receivings is
  'One factual receiving session per supply. Draft until confirm; then immutable and linked to stock_receipt batch.';

create index if not exists product_supply_receivings_status_idx
  on public.product_supply_receivings (status, started_at desc);

drop trigger if exists product_supply_receivings_set_updated_at on public.product_supply_receivings;
create trigger product_supply_receivings_set_updated_at
  before update on public.product_supply_receivings
  for each row
  execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_supplies_active_receiving_fk'
  ) then
    alter table public.product_supplies
      add constraint product_supplies_active_receiving_fk
      foreign key (active_receiving_id)
      references public.product_supply_receivings (id)
      on delete set null;
  end if;
end
$$;

create table if not exists public.product_supply_receiving_items (
  id uuid primary key default gen_random_uuid(),
  receiving_id uuid not null references public.product_supply_receivings (id) on delete cascade,
  supply_item_id uuid references public.product_supply_items (id) on delete set null,
  product_id uuid not null references public.products (id) on delete restrict,
  sort_order integer not null default 0,
  sku_snapshot text,
  name_snapshot text,
  spec_snapshot text,
  ordered_quantity numeric(14, 3),
  shipped_quantity numeric(14, 3),
  expected_quantity numeric(14, 3) not null default 0,
  received_quantity numeric(14, 3),
  damaged_quantity numeric(14, 3) not null default 0,
  accepted_quantity numeric(14, 3),
  difference_quantity numeric(14, 3),
  discrepancy_type public.product_supply_discrepancy_type,
  comment text,
  is_unexpected boolean not null default false,
  line_status text not null default 'pending',
  stock_receipt_id uuid references public.stock_receipts (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_supply_receiving_items_product_unique unique (receiving_id, product_id),
  constraint product_supply_receiving_items_line_status_check check (
    line_status in ('pending', 'filled')
  ),
  constraint product_supply_receiving_items_expected_non_negative check (expected_quantity >= 0),
  constraint product_supply_receiving_items_received_non_negative check (
    received_quantity is null or received_quantity >= 0
  ),
  constraint product_supply_receiving_items_damaged_non_negative check (damaged_quantity >= 0),
  constraint product_supply_receiving_items_accepted_non_negative check (
    accepted_quantity is null or accepted_quantity >= 0
  ),
  constraint product_supply_receiving_items_comment_len check (
    comment is null or char_length(comment) <= 2000
  )
);

comment on table public.product_supply_receiving_items is
  'Receiving lines. Only accepted_quantity (>0) becomes stock on confirm.';

create index if not exists product_supply_receiving_items_receiving_idx
  on public.product_supply_receiving_items (receiving_id, sort_order, id);

create index if not exists product_supply_receiving_items_supply_item_idx
  on public.product_supply_receiving_items (supply_item_id)
  where supply_item_id is not null;

drop trigger if exists product_supply_receiving_items_set_updated_at
  on public.product_supply_receiving_items;
create trigger product_supply_receiving_items_set_updated_at
  before update on public.product_supply_receiving_items
  for each row
  execute function public.set_updated_at();

alter table public.product_supply_receivings enable row level security;
alter table public.product_supply_receiving_items enable row level security;

revoke all on table public.product_supply_receivings from public, anon, authenticated;
revoke all on table public.product_supply_receiving_items from public, anon, authenticated;

-- ============================================================
-- 5. FX helper
-- ============================================================

create or replace function public.product_supply_get_fx_rate(
  p_supply_id uuid,
  p_currency public.product_supply_currency
)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rate numeric(18, 6);
  v_default_currency public.product_supply_currency;
  v_default_rate numeric(18, 6);
begin
  if p_currency = 'KZT' then
    return 1::numeric;
  end if;

  select r.rate_to_kzt
  into v_rate
  from public.product_supply_fx_rates as r
  where r.supply_id = p_supply_id
    and r.currency = p_currency;

  if found then
    return v_rate;
  end if;

  select s.default_currency, s.default_exchange_rate_to_kzt
  into v_default_currency, v_default_rate
  from public.product_supplies as s
  where s.id = p_supply_id;

  if found
     and v_default_currency = p_currency
     and v_default_rate is not null
     and v_default_rate > 0 then
    return v_default_rate;
  end if;

  return null;
end;
$$;

revoke all on function public.product_supply_get_fx_rate(
  uuid, public.product_supply_currency
) from public, anon, authenticated;

-- ============================================================
-- 6. Recalculate — draft uses supply FX (+ expense custom override)
-- ============================================================

create or replace function public.staff_recalculate_product_supply(p_supply_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supply public.product_supplies;
  v_total_net numeric(18, 6) := 0;
  v_total_purchase numeric(18, 6) := 0;
  v_total_exp numeric(18, 6) := 0;
  v_gross numeric(18, 6);
  v_expense_per_kg numeric(18, 6);
  v_alloc_count integer := 0;
  v_alloc_i integer := 0;
  v_remaining_gross numeric(18, 6);
  v_remaining_exp numeric(18, 6);
  v_alloc_gross numeric(18, 6);
  v_alloc_exp numeric(18, 6);
  v_share numeric(18, 8);
  v_rate numeric(18, 6);
  r record;
begin
  select * into v_supply
  from public.product_supplies as s
  where s.id = p_supply_id
  for update;

  if not found then
    raise exception 'Поставка не найдена';
  end if;

  if v_supply.status = 'closed' then
    return;
  end if;

  for r in
    select e.id, e.currency, e.amount, e.exchange_rate_to_kzt, e.use_custom_exchange_rate
    from public.product_supply_expenses as e
    where e.supply_id = p_supply_id
    for update
  loop
    if r.use_custom_exchange_rate then
      v_rate := public.product_supply_resolved_rate(r.currency, r.exchange_rate_to_kzt);
    else
      v_rate := public.product_supply_get_fx_rate(p_supply_id, r.currency);
    end if;

    update public.product_supply_expenses as e
    set
      exchange_rate_to_kzt = v_rate,
      amount_kzt = public.product_supply_amount_kzt(r.amount, r.currency, v_rate)
    where e.id = r.id;
  end loop;

  for r in
    select
      i.id,
      i.quantity,
      i.purchase_currency,
      i.purchase_price_per_unit,
      i.unit_net_weight_kg
    from public.product_supply_items as i
    where i.supply_id = p_supply_id
    for update
  loop
    v_rate := public.product_supply_get_fx_rate(p_supply_id, r.purchase_currency);

    update public.product_supply_items as i
    set
      exchange_rate_to_kzt = v_rate,
      purchase_price_per_unit_kzt = public.product_supply_amount_kzt(
        r.purchase_price_per_unit,
        r.purchase_currency,
        v_rate
      ),
      total_net_weight_kg = case
        when r.unit_net_weight_kg is null then null
        else r.quantity * r.unit_net_weight_kg
      end,
      purchase_total_kzt = case
        when r.purchase_price_per_unit is null then null
        else r.quantity * public.product_supply_amount_kzt(
          r.purchase_price_per_unit,
          r.purchase_currency,
          v_rate
        )
      end,
      item_weight_share = null,
      allocated_gross_weight_kg = null,
      gross_weight_per_unit_kg = null,
      allocated_expenses_kzt = null,
      expense_per_unit_kzt = null,
      landed_cost_per_unit_kzt = null,
      landed_cost_total_kzt = null
    where i.id = r.id;
  end loop;

  select
    coalesce(sum(i.total_net_weight_kg), 0),
    coalesce(sum(i.purchase_total_kzt), 0),
    count(*) filter (where i.total_net_weight_kg is not null)::integer
  into v_total_net, v_total_purchase, v_alloc_count
  from public.product_supply_items as i
  where i.supply_id = p_supply_id;

  select coalesce(sum(e.amount_kzt), 0)
  into v_total_exp
  from public.product_supply_expenses as e
  where e.supply_id = p_supply_id;

  v_gross := v_supply.gross_weight_kg;
  v_expense_per_kg := case
    when v_gross is not null and v_gross > 0 then v_total_exp / v_gross
    else null
  end;

  v_remaining_gross := v_gross;
  v_remaining_exp := v_total_exp;

  for r in
    select i.id, i.quantity, i.total_net_weight_kg, i.purchase_total_kzt,
           i.purchase_price_per_unit_kzt
    from public.product_supply_items as i
    where i.supply_id = p_supply_id
    order by i.sort_order, i.id
  loop
    if v_gross is null or v_gross <= 0 or v_total_net <= 0
       or r.total_net_weight_kg is null then
      v_share := null;
      v_alloc_gross := null;
      v_alloc_exp := null;
    else
      v_alloc_i := v_alloc_i + 1;
      v_share := r.total_net_weight_kg / v_total_net;
      if v_alloc_i = v_alloc_count then
        v_alloc_gross := v_remaining_gross;
        v_alloc_exp := v_remaining_exp;
      else
        v_alloc_gross := v_gross * v_share;
        v_alloc_exp := case
          when v_expense_per_kg is null then 0
          else v_alloc_gross * v_expense_per_kg
        end;
        v_remaining_gross := v_remaining_gross - v_alloc_gross;
        v_remaining_exp := v_remaining_exp - v_alloc_exp;
      end if;
    end if;

    update public.product_supply_items as i
    set
      item_weight_share = v_share,
      allocated_gross_weight_kg = v_alloc_gross,
      gross_weight_per_unit_kg = case
        when v_alloc_gross is null or r.quantity <= 0 then null
        else v_alloc_gross / r.quantity
      end,
      allocated_expenses_kzt = v_alloc_exp,
      expense_per_unit_kzt = case
        when v_alloc_exp is null or r.quantity <= 0 then null
        else v_alloc_exp / r.quantity
      end,
      landed_cost_per_unit_kzt = case
        when r.purchase_price_per_unit_kzt is null then null
        when v_alloc_exp is null or r.quantity <= 0 then r.purchase_price_per_unit_kzt
        else r.purchase_price_per_unit_kzt + (v_alloc_exp / r.quantity)
      end,
      landed_cost_total_kzt = case
        when r.purchase_total_kzt is null then null
        when v_alloc_exp is null then r.purchase_total_kzt
        else r.purchase_total_kzt + v_alloc_exp
      end
    where i.id = r.id;
  end loop;

  update public.product_supplies as s
  set
    total_net_weight_kg = v_total_net,
    packaging_weight_kg = case
      when v_gross is null then null
      else v_gross - v_total_net
    end,
    packaging_weight_pct = case
      when v_gross is null or v_gross <= 0 then null
      else ((v_gross - v_total_net) / v_gross) * 100
    end,
    total_purchase_kzt = v_total_purchase,
    total_expenses_kzt = v_total_exp,
    expense_per_kg = v_expense_per_kg,
    total_landed_cost_kzt = coalesce(v_total_purchase, 0) + coalesce(v_total_exp, 0),
    default_exchange_rate_to_kzt = coalesce(
      public.product_supply_get_fx_rate(p_supply_id, s.default_currency),
      public.product_supply_resolved_rate(s.default_currency, s.default_exchange_rate_to_kzt)
    )
  where s.id = p_supply_id;
end;
$$;

revoke all on function public.staff_recalculate_product_supply(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 7. Payload helpers (item / receiving / full)
-- ============================================================

create or replace function public.staff_product_supply_receiving_json(p_receiving_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rec public.product_supply_receivings;
  v_items jsonb;
  v_expected numeric(18, 6) := 0;
  v_received numeric(18, 6) := 0;
  v_accepted numeric(18, 6) := 0;
  v_damaged numeric(18, 6) := 0;
  v_shortage numeric(18, 6) := 0;
  v_overage numeric(18, 6) := 0;
begin
  if p_receiving_id is null then
    return null;
  end if;

  select * into v_rec
  from public.product_supply_receivings as r
  where r.id = p_receiving_id;

  if not found then
    return null;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ri.id,
        'receiving_id', ri.receiving_id,
        'supply_item_id', ri.supply_item_id,
        'product_id', ri.product_id,
        'sort_order', ri.sort_order,
        'sku', ri.sku_snapshot,
        'name', ri.name_snapshot,
        'spec', ri.spec_snapshot,
        'ordered_quantity', ri.ordered_quantity,
        'shipped_quantity', ri.shipped_quantity,
        'expected_quantity', ri.expected_quantity,
        'received_quantity', ri.received_quantity,
        'damaged_quantity', ri.damaged_quantity,
        'accepted_quantity', ri.accepted_quantity,
        'difference_quantity', ri.difference_quantity,
        'discrepancy_type', ri.discrepancy_type,
        'comment', ri.comment,
        'is_unexpected', ri.is_unexpected,
        'line_status', ri.line_status,
        'stock_receipt_id', ri.stock_receipt_id
      )
      order by ri.sort_order, ri.id
    ),
    '[]'::jsonb
  )
  into v_items
  from public.product_supply_receiving_items as ri
  where ri.receiving_id = p_receiving_id;

  select
    coalesce(sum(ri.expected_quantity), 0),
    coalesce(sum(ri.received_quantity) filter (where ri.received_quantity is not null), 0),
    coalesce(sum(ri.accepted_quantity) filter (where ri.accepted_quantity is not null), 0),
    coalesce(sum(ri.damaged_quantity), 0),
    coalesce(sum(case
      when ri.difference_quantity is not null and ri.difference_quantity < 0
        then -ri.difference_quantity
      else 0
    end), 0),
    coalesce(sum(case
      when ri.difference_quantity is not null and ri.difference_quantity > 0
        then ri.difference_quantity
      else 0
    end), 0)
  into v_expected, v_received, v_accepted, v_damaged, v_shortage, v_overage
  from public.product_supply_receiving_items as ri
  where ri.receiving_id = p_receiving_id;

  return jsonb_build_object(
    'id', v_rec.id,
    'supply_id', v_rec.supply_id,
    'status', v_rec.status,
    'warehouse_id', v_rec.warehouse_id,
    'started_by', v_rec.started_by,
    'started_at', v_rec.started_at,
    'confirmed_by', v_rec.confirmed_by,
    'confirmed_at', v_rec.confirmed_at,
    'stock_receipt_batch_id', v_rec.stock_receipt_batch_id,
    'notes', v_rec.notes,
    'created_at', v_rec.created_at,
    'updated_at', v_rec.updated_at,
    'items', coalesce(v_items, '[]'::jsonb),
    'summary', jsonb_build_object(
      'expected_sum', v_expected,
      'received_sum', v_received,
      'accepted_sum', v_accepted,
      'damaged_sum', v_damaged,
      'shortage_sum', v_shortage,
      'overage_sum', v_overage
    )
  );
end;
$$;

revoke all on function public.staff_product_supply_receiving_json(uuid)
  from public, anon, authenticated;

create or replace function public.staff_product_supply_item_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id,
    'supply_id', i.supply_id,
    'product_id', i.product_id,
    'sku', p.sku,
    'name', p.name,
    'original_sku', p.original_sku,
    'product_status', p.status,
    'sort_order', i.sort_order,
    'quantity', i.quantity,
    'unit', i.unit,
    'purchase_currency', i.purchase_currency,
    'purchase_price_per_unit', i.purchase_price_per_unit,
    'exchange_rate_to_kzt', i.exchange_rate_to_kzt,
    'purchase_price_per_unit_kzt', i.purchase_price_per_unit_kzt,
    'unit_net_weight_kg', i.unit_net_weight_kg,
    'total_net_weight_kg', i.total_net_weight_kg,
    'item_weight_share', i.item_weight_share,
    'allocated_gross_weight_kg', i.allocated_gross_weight_kg,
    'gross_weight_per_unit_kg', i.gross_weight_per_unit_kg,
    'allocated_expenses_kzt', i.allocated_expenses_kzt,
    'expense_per_unit_kzt', i.expense_per_unit_kzt,
    'purchase_total_kzt', i.purchase_total_kzt,
    'landed_cost_per_unit_kzt', i.landed_cost_per_unit_kzt,
    'landed_cost_total_kzt', i.landed_cost_total_kzt,
    'qty_source', i.qty_source,
    'ordered_quantity', i.ordered_quantity,
    'ordered_unit', i.ordered_unit,
    'ordered_purchase_currency', i.ordered_purchase_currency,
    'ordered_price_per_unit', i.ordered_price_per_unit,
    'ordered_amount', i.ordered_amount,
    'ordered_spec', i.ordered_spec,
    'ordered_name', i.ordered_name,
    'ordered_source_document_id', i.ordered_source_document_id,
    'shipped_quantity', i.shipped_quantity,
    'shipped_unit', i.shipped_unit,
    'shipped_purchase_currency', i.shipped_purchase_currency,
    'shipped_price_per_unit', i.shipped_price_per_unit,
    'shipped_amount', i.shipped_amount,
    'shipped_spec', i.shipped_spec,
    'shipped_name', i.shipped_name,
    'shipped_source_document_id', i.shipped_source_document_id,
    'received_quantity', i.received_quantity,
    'damaged_quantity', i.damaged_quantity,
    'accepted_quantity', i.accepted_quantity
  )
  from public.product_supply_items as i
  join public.products as p on p.id = i.product_id
  where i.id = p_id;
$$;

revoke all on function public.staff_product_supply_item_json(uuid)
  from public, anon, authenticated;

create or replace function public.staff_product_supply_payload(p_supply_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_supply public.product_supplies;
  v_items jsonb;
  v_expenses jsonb;
  v_documents jsonb;
  v_history jsonb;
  v_fx jsonb;
  v_receiving jsonb;
  v_gross_lt_net boolean;
begin
  select * into v_supply
  from public.product_supplies as s
  where s.id = p_supply_id;

  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(public.staff_product_supply_item_json(i.id) order by i.sort_order, i.id), '[]'::jsonb)
  into v_items
  from public.product_supply_items as i
  where i.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'supply_id', e.supply_id,
        'category_key', e.category_key,
        'name', e.name,
        'amount', e.amount,
        'currency', e.currency,
        'exchange_rate_to_kzt', e.exchange_rate_to_kzt,
        'use_custom_exchange_rate', e.use_custom_exchange_rate,
        'amount_kzt', e.amount_kzt,
        'expense_date', e.expense_date,
        'notes', e.notes,
        'sort_order', e.sort_order,
        'linked_documents', (
          select coalesce(
            jsonb_agg(jsonb_build_object(
              'id', d.id,
              'title', d.title,
              'document_type', d.document_type,
              'original_filename', d.original_filename
            ) order by d.uploaded_at, d.id),
            '[]'::jsonb
          )
          from public.product_supply_documents as d
          where d.linked_expense_id = e.id
        )
      )
      order by e.sort_order, e.created_at, e.id
    ),
    '[]'::jsonb
  )
  into v_expenses
  from public.product_supply_expenses as e
  where e.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(public.staff_product_supply_document_json(d.id) order by d.uploaded_at desc, d.id),
    '[]'::jsonb
  )
  into v_documents
  from public.product_supply_documents as d
  where d.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', h.id,
        'supply_id', h.supply_id,
        'from_status', h.from_status,
        'to_status', h.to_status,
        'changed_by', h.changed_by,
        'changed_by_name', pr.full_name,
        'changed_at', h.changed_at,
        'note', h.note,
        'location', h.location
      )
      order by h.changed_at, h.id
    ),
    '[]'::jsonb
  )
  into v_history
  from public.product_supply_status_history as h
  left join public.profiles as pr on pr.id = h.changed_by
  where h.supply_id = p_supply_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'currency', f.currency,
        'rate_to_kzt', f.rate_to_kzt,
        'effective_date', f.effective_date,
        'source_note', f.source_note,
        'updated_at', f.updated_at,
        'updated_by', f.updated_by
      )
      order by f.currency
    ),
    '[]'::jsonb
  )
  into v_fx
  from public.product_supply_fx_rates as f
  where f.supply_id = p_supply_id;

  v_receiving := public.staff_product_supply_receiving_json(v_supply.active_receiving_id);

  v_gross_lt_net :=
    v_supply.gross_weight_kg is not null
    and v_supply.total_net_weight_kg is not null
    and v_supply.gross_weight_kg < v_supply.total_net_weight_kg;

  return jsonb_build_object(
    'supply', jsonb_build_object(
      'id', v_supply.id,
      'sequence_number', v_supply.sequence_number,
      'supply_number', v_supply.supply_number,
      'title', v_supply.title,
      'supplier_name', v_supply.supplier_name,
      'supply_date', v_supply.supply_date,
      'default_currency', v_supply.default_currency,
      'default_exchange_rate_to_kzt', v_supply.default_exchange_rate_to_kzt,
      'gross_weight_kg', v_supply.gross_weight_kg,
      'notes', v_supply.notes,
      'status', v_supply.status,
      'logistics_status', v_supply.logistics_status,
      'receiving_status', v_supply.receiving_status,
      'active_receiving_id', v_supply.active_receiving_id,
      'source_kind', v_supply.source_kind,
      'created_by', v_supply.created_by,
      'created_at', v_supply.created_at,
      'updated_at', v_supply.updated_at,
      'closed_at', v_supply.closed_at,
      'closed_by', v_supply.closed_by,
      'is_preliminary', v_supply.status = 'draft',
      'inventory_receipt_id', v_supply.inventory_receipt_id
    ),
    'items', v_items,
    'expenses', v_expenses,
    'fx_rates', coalesce(v_fx, '[]'::jsonb),
    'receiving', v_receiving,
    'documents', coalesce(v_documents, '[]'::jsonb),
    'logistics_history', coalesce(v_history, '[]'::jsonb),
    'comparison', public.staff_product_supply_comparison(p_supply_id),
    'totals', jsonb_build_object(
      'total_net_weight_kg', v_supply.total_net_weight_kg,
      'gross_weight_kg', v_supply.gross_weight_kg,
      'packaging_weight_kg', v_supply.packaging_weight_kg,
      'packaging_weight_pct', v_supply.packaging_weight_pct,
      'total_purchase_kzt', v_supply.total_purchase_kzt,
      'total_expenses_kzt', v_supply.total_expenses_kzt,
      'expense_per_kg', v_supply.expense_per_kg,
      'total_landed_cost_kzt', v_supply.total_landed_cost_kzt,
      'gross_lt_net', v_gross_lt_net
    )
  );
end;
$$;

revoke all on function public.staff_product_supply_payload(uuid)
  from public, anon, authenticated;

-- ============================================================
-- 8. FX RPC
-- ============================================================

create or replace function public.staff_set_product_supply_fx_rates(
  p_supply_id uuid,
  p_rates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_elem jsonb;
  v_currency public.product_supply_currency;
  v_rate numeric(18, 6);
  v_eff date;
  v_note text;
  v_items_updated integer := 0;
  v_expenses_updated integer := 0;
  v_payload jsonb;
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  if p_rates is null or jsonb_typeof(p_rates) is distinct from 'array' then
    raise exception 'Курсы должны быть массивом JSON';
  end if;

  for v_elem in select * from jsonb_array_elements(p_rates)
  loop
    begin
      v_currency := public.product_supply_parse_currency(v_elem ->> 'currency');
    exception
      when others then
        raise exception 'Некорректная валюта курса';
    end;

    if v_currency = 'KZT' then
      raise exception 'Курс KZT не хранится (всегда 1)';
    end if;
    if v_currency not in ('CNY', 'USD') then
      raise exception 'Допустимы только курсы CNY и USD';
    end if;

    begin
      v_rate := (v_elem ->> 'rate_to_kzt')::numeric;
    exception
      when others then
        raise exception 'Некорректный курс для %', v_currency;
    end;

    if v_rate is null or v_rate <= 0 then
      raise exception 'Курс % должен быть больше 0', v_currency;
    end if;

    v_eff := null;
    if nullif(trim(coalesce(v_elem ->> 'effective_date', '')), '') is not null then
      begin
        v_eff := (v_elem ->> 'effective_date')::date;
      exception
        when others then
          raise exception 'Некорректная дата курса для %', v_currency;
      end;
    end if;

    v_note := nullif(trim(coalesce(v_elem ->> 'source_note', '')), '');
    if v_note is not null and char_length(v_note) > 500 then
      raise exception 'Примечание к курсу не длиннее 500 символов';
    end if;

    insert into public.product_supply_fx_rates (
      supply_id,
      currency,
      rate_to_kzt,
      effective_date,
      source_note,
      updated_by,
      updated_at
    ) values (
      p_supply_id,
      v_currency,
      v_rate,
      v_eff,
      v_note,
      v_uid,
      now()
    )
    on conflict (supply_id, currency) do update
    set
      rate_to_kzt = excluded.rate_to_kzt,
      effective_date = excluded.effective_date,
      source_note = excluded.source_note,
      updated_by = excluded.updated_by,
      updated_at = now();

    if v_currency = v_row.default_currency then
      update public.product_supplies as s
      set default_exchange_rate_to_kzt = v_rate
      where s.id = p_supply_id;
    end if;
  end loop;

  update public.product_supply_items as i
  set exchange_rate_to_kzt = public.product_supply_get_fx_rate(p_supply_id, i.purchase_currency)
  where i.supply_id = p_supply_id;
  get diagnostics v_items_updated = row_count;

  update public.product_supply_expenses as e
  set exchange_rate_to_kzt = public.product_supply_get_fx_rate(p_supply_id, e.currency)
  where e.supply_id = p_supply_id
    and e.use_custom_exchange_rate = false;
  get diagnostics v_expenses_updated = row_count;

  perform public.staff_recalculate_product_supply(p_supply_id);

  v_payload := public.staff_product_supply_payload(p_supply_id);
  return v_payload || jsonb_build_object(
    'fx_apply', jsonb_build_object(
      'items', v_items_updated,
      'expenses', v_expenses_updated
    )
  );
end;
$$;

revoke all on function public.staff_set_product_supply_fx_rates(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_set_product_supply_fx_rates(uuid, jsonb)
  to authenticated;

-- ============================================================
-- 9. Item add/update — always supply FX (ignore per-item rate arg)
-- ============================================================

create or replace function public.staff_add_product_supply_item(
  p_supply_id uuid,
  p_product_id uuid,
  p_quantity numeric,
  p_unit_net_weight_kg numeric default null,
  p_purchase_price_per_unit numeric default null,
  p_purchase_currency text default null,
  p_exchange_rate_to_kzt numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
  v_product public.products;
  v_currency public.product_supply_currency;
  v_rate numeric;
  v_sort integer;
  v_id uuid := gen_random_uuid();
begin
  perform public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  if p_product_id is null then
    raise exception 'Товар обязателен';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;
  if p_unit_net_weight_kg is not null and p_unit_net_weight_kg < 0 then
    raise exception 'Вес единицы не может быть отрицательным';
  end if;
  if p_purchase_price_per_unit is not null and p_purchase_price_per_unit < 0 then
    raise exception 'Закупочная цена не может быть отрицательной';
  end if;

  select * into v_product
  from public.products as p
  where p.id = p_product_id;

  if not found then
    raise exception 'Товар не найден';
  end if;

  if exists (
    select 1 from public.product_supply_items as i
    where i.supply_id = p_supply_id and i.product_id = p_product_id
  ) then
    raise exception 'Товар «%» уже есть в этой поставке', v_product.sku;
  end if;

  v_currency := public.product_supply_parse_currency(
    coalesce(nullif(trim(p_purchase_currency), ''), v_row.default_currency::text)
  );
  -- Per-item rate from UI is ignored; supply FX (or KZT=1) is authoritative.
  v_rate := public.product_supply_get_fx_rate(p_supply_id, v_currency);

  select coalesce(max(i.sort_order), 0) + 1
  into v_sort
  from public.product_supply_items as i
  where i.supply_id = p_supply_id;

  insert into public.product_supply_items (
    id,
    supply_id,
    product_id,
    sort_order,
    quantity,
    unit,
    purchase_currency,
    purchase_price_per_unit,
    exchange_rate_to_kzt,
    unit_net_weight_kg
  ) values (
    v_id,
    p_supply_id,
    p_product_id,
    v_sort,
    p_quantity,
    v_product.unit,
    v_currency,
    p_purchase_price_per_unit,
    v_rate,
    coalesce(p_unit_net_weight_kg, v_product.weight_kg)
  );

  perform public.staff_recalculate_product_supply(p_supply_id);
  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_add_product_supply_item(
  uuid, uuid, numeric, numeric, numeric, text, numeric
) from public, anon, authenticated;
grant execute on function public.staff_add_product_supply_item(
  uuid, uuid, numeric, numeric, numeric, text, numeric
) to authenticated;

create or replace function public.staff_update_product_supply_item(
  p_item_id uuid,
  p_quantity numeric default null,
  p_unit_net_weight_kg numeric default null,
  p_purchase_price_per_unit numeric default null,
  p_purchase_currency text default null,
  p_exchange_rate_to_kzt numeric default null,
  p_clear_weight boolean default false,
  p_clear_price boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.product_supply_items;
  v_row public.product_supplies;
  v_qty numeric;
  v_weight numeric;
  v_price numeric;
  v_currency public.product_supply_currency;
  v_rate numeric;
begin
  perform public.staff_assert_product_supply_admin();

  if p_item_id is null then
    raise exception 'id позиции обязателен';
  end if;

  select * into v_item
  from public.product_supply_items as i
  where i.id = p_item_id
  for update;

  if not found then
    raise exception 'Позиция не найдена';
  end if;

  v_row := public.staff_lock_product_supply(v_item.supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  v_qty := coalesce(p_quantity, v_item.quantity);
  if v_qty <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;

  v_weight := case
    when p_clear_weight then null
    when p_unit_net_weight_kg is not null then p_unit_net_weight_kg
    else v_item.unit_net_weight_kg
  end;
  if v_weight is not null and v_weight < 0 then
    raise exception 'Вес единицы не может быть отрицательным';
  end if;

  v_price := case
    when p_clear_price then null
    when p_purchase_price_per_unit is not null then p_purchase_price_per_unit
    else v_item.purchase_price_per_unit
  end;
  if v_price is not null and v_price < 0 then
    raise exception 'Закупочная цена не может быть отрицательной';
  end if;

  v_currency := case
    when nullif(trim(p_purchase_currency), '') is not null
      then public.product_supply_parse_currency(p_purchase_currency)
    else v_item.purchase_currency
  end;
  v_rate := public.product_supply_get_fx_rate(v_item.supply_id, v_currency);

  update public.product_supply_items as i
  set
    quantity = v_qty,
    unit_net_weight_kg = v_weight,
    purchase_price_per_unit = v_price,
    purchase_currency = v_currency,
    exchange_rate_to_kzt = v_rate
  where i.id = p_item_id;

  perform public.staff_recalculate_product_supply(v_item.supply_id);
  return public.staff_product_supply_payload(v_item.supply_id);
end;
$$;

revoke all on function public.staff_update_product_supply_item(
  uuid, numeric, numeric, numeric, text, numeric, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.staff_update_product_supply_item(
  uuid, numeric, numeric, numeric, text, numeric, boolean, boolean
) to authenticated;

-- ============================================================
-- 10. Expense add/update — custom FX flag
-- ============================================================

drop function if exists public.staff_add_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text
);

create or replace function public.staff_add_product_supply_expense(
  p_supply_id uuid,
  p_name text,
  p_amount numeric,
  p_currency text default 'KZT',
  p_exchange_rate_to_kzt numeric default null,
  p_category_key text default 'custom',
  p_expense_date date default null,
  p_notes text default null,
  p_use_custom_exchange_rate boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
  v_name text := nullif(trim(p_name), '');
  v_category text := coalesce(nullif(trim(p_category_key), ''), 'custom');
  v_notes text := nullif(trim(p_notes), '');
  v_currency public.product_supply_currency;
  v_rate numeric;
  v_use_custom boolean := coalesce(p_use_custom_exchange_rate, false);
  v_sort integer;
begin
  perform public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  if v_name is null then
    raise exception 'Название расхода обязательно';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Сумма расхода не может быть отрицательной';
  end if;

  v_currency := public.product_supply_parse_currency(coalesce(p_currency, 'KZT'));

  if v_use_custom then
    v_rate := public.product_supply_resolved_rate(v_currency, p_exchange_rate_to_kzt);
    if v_currency <> 'KZT' and (v_rate is null or v_rate <= 0) then
      raise exception 'Для своего курса % укажите курс к тенге', v_currency;
    end if;
  else
    v_rate := public.product_supply_get_fx_rate(p_supply_id, v_currency);
  end if;

  select coalesce(max(e.sort_order), 0) + 1
  into v_sort
  from public.product_supply_expenses as e
  where e.supply_id = p_supply_id;

  insert into public.product_supply_expenses (
    supply_id,
    category_key,
    name,
    amount,
    currency,
    exchange_rate_to_kzt,
    use_custom_exchange_rate,
    expense_date,
    notes,
    sort_order
  ) values (
    p_supply_id,
    v_category,
    v_name,
    p_amount,
    v_currency,
    v_rate,
    v_use_custom,
    p_expense_date,
    v_notes,
    v_sort
  );

  perform public.staff_recalculate_product_supply(p_supply_id);
  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_add_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text, boolean
) from public, anon, authenticated;
grant execute on function public.staff_add_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text, boolean
) to authenticated;

drop function if exists public.staff_update_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text, boolean, boolean
);

create or replace function public.staff_update_product_supply_expense(
  p_expense_id uuid,
  p_name text default null,
  p_amount numeric default null,
  p_currency text default null,
  p_exchange_rate_to_kzt numeric default null,
  p_category_key text default null,
  p_expense_date date default null,
  p_notes text default null,
  p_clear_notes boolean default false,
  p_clear_date boolean default false,
  p_use_custom_exchange_rate boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exp public.product_supply_expenses;
  v_row public.product_supplies;
  v_name text;
  v_amount numeric;
  v_currency public.product_supply_currency;
  v_rate numeric;
  v_use_custom boolean;
begin
  perform public.staff_assert_product_supply_admin();

  if p_expense_id is null then
    raise exception 'id расхода обязателен';
  end if;

  select * into v_exp
  from public.product_supply_expenses as e
  where e.id = p_expense_id
  for update;

  if not found then
    raise exception 'Расход не найден';
  end if;

  v_row := public.staff_lock_product_supply(v_exp.supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  v_name := coalesce(nullif(trim(p_name), ''), v_exp.name);
  v_amount := coalesce(p_amount, v_exp.amount);
  if v_amount < 0 then
    raise exception 'Сумма расхода не может быть отрицательной';
  end if;

  v_currency := case
    when nullif(trim(p_currency), '') is not null
      then public.product_supply_parse_currency(p_currency)
    else v_exp.currency
  end;

  v_use_custom := coalesce(p_use_custom_exchange_rate, v_exp.use_custom_exchange_rate);

  if v_use_custom then
    v_rate := public.product_supply_resolved_rate(
      v_currency,
      coalesce(p_exchange_rate_to_kzt, v_exp.exchange_rate_to_kzt)
    );
    if v_currency <> 'KZT' and (v_rate is null or v_rate <= 0) then
      raise exception 'Для своего курса % укажите курс к тенге', v_currency;
    end if;
  else
    v_rate := public.product_supply_get_fx_rate(v_exp.supply_id, v_currency);
  end if;

  update public.product_supply_expenses as e
  set
    name = v_name,
    amount = v_amount,
    currency = v_currency,
    exchange_rate_to_kzt = v_rate,
    use_custom_exchange_rate = v_use_custom,
    category_key = coalesce(nullif(trim(p_category_key), ''), e.category_key),
    expense_date = case
      when p_clear_date then null
      else coalesce(p_expense_date, e.expense_date)
    end,
    notes = case
      when p_clear_notes then null
      when p_notes is not null then nullif(trim(p_notes), '')
      else e.notes
    end
  where e.id = p_expense_id;

  perform public.staff_recalculate_product_supply(v_exp.supply_id);
  return public.staff_product_supply_payload(v_exp.supply_id);
end;
$$;

revoke all on function public.staff_update_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.staff_update_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text, boolean, boolean, boolean
) to authenticated;

-- ============================================================
-- 11. Receiving RPCs
-- ============================================================

create or replace function public.staff_start_product_supply_receiving(p_supply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_rec public.product_supply_receivings;
  v_rec_id uuid;
  v_item public.product_supply_items;
  v_product public.products;
  v_expected numeric(14, 3);
  v_sort integer := 0;
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);

  if v_row.receiving_status = 'completed' then
    return public.staff_product_supply_payload(p_supply_id);
  end if;

  if v_row.active_receiving_id is not null then
    select * into v_rec
    from public.product_supply_receivings as r
    where r.id = v_row.active_receiving_id;

    if found and v_rec.status = 'draft' then
      if v_row.receiving_status is distinct from 'in_progress' then
        update public.product_supplies
        set receiving_status = 'in_progress'
        where id = p_supply_id;
      end if;
      return public.staff_product_supply_payload(p_supply_id);
    end if;

    if found and v_rec.status = 'confirmed' then
      return public.staff_product_supply_payload(p_supply_id);
    end if;
  end if;

  v_rec_id := gen_random_uuid();

  insert into public.product_supply_receivings (
    id,
    supply_id,
    status,
    started_by,
    started_at
  ) values (
    v_rec_id,
    p_supply_id,
    'draft',
    v_uid,
    now()
  );

  for v_item in
    select *
    from public.product_supply_items as i
    where i.supply_id = p_supply_id
    order by i.sort_order, i.id
  loop
    select * into v_product
    from public.products as p
    where p.id = v_item.product_id;

    v_expected := coalesce(v_item.shipped_quantity, v_item.ordered_quantity, v_item.quantity, 0);
    v_sort := v_sort + 1;

    insert into public.product_supply_receiving_items (
      receiving_id,
      supply_item_id,
      product_id,
      sort_order,
      sku_snapshot,
      name_snapshot,
      spec_snapshot,
      ordered_quantity,
      shipped_quantity,
      expected_quantity,
      received_quantity,
      damaged_quantity,
      accepted_quantity,
      difference_quantity,
      discrepancy_type,
      is_unexpected,
      line_status
    ) values (
      v_rec_id,
      v_item.id,
      v_item.product_id,
      v_sort,
      v_product.sku,
      v_product.name,
      coalesce(v_item.shipped_spec, v_item.ordered_spec),
      v_item.ordered_quantity,
      v_item.shipped_quantity,
      v_expected,
      null,
      0,
      null,
      null,
      null,
      false,
      'pending'
    );
  end loop;

  update public.product_supplies as s
  set
    receiving_status = 'in_progress',
    active_receiving_id = v_rec_id
  where s.id = p_supply_id;

  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_start_product_supply_receiving(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_start_product_supply_receiving(uuid)
  to authenticated;

create or replace function public.staff_fill_product_supply_receiving_expected(p_supply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
  v_rec public.product_supply_receivings;
begin
  perform public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);

  if v_row.receiving_status = 'completed' then
    raise exception 'Приёмка уже подтверждена';
  end if;

  if v_row.active_receiving_id is null then
    raise exception 'Сначала начните приёмку';
  end if;

  select * into v_rec
  from public.product_supply_receivings as r
  where r.id = v_row.active_receiving_id
  for update;

  if not found or v_rec.status is distinct from 'draft' then
    raise exception 'Черновик приёмки не найден';
  end if;

  update public.product_supply_receiving_items as ri
  set
    received_quantity = ri.expected_quantity,
    damaged_quantity = 0,
    accepted_quantity = ri.expected_quantity,
    difference_quantity = 0,
    discrepancy_type = null,
    line_status = 'filled'
  where ri.receiving_id = v_rec.id;

  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_fill_product_supply_receiving_expected(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_fill_product_supply_receiving_expected(uuid)
  to authenticated;

create or replace function public.staff_save_product_supply_receiving(
  p_supply_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
  v_rec public.product_supply_receivings;
  v_elem jsonb;
  v_line public.product_supply_receiving_items;
  v_line_id uuid;
  v_received numeric(14, 3);
  v_damaged numeric(14, 3);
  v_accepted numeric(14, 3);
  v_diff numeric(14, 3);
  v_disc public.product_supply_discrepancy_type;
  v_comment text;
begin
  perform public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);

  if v_row.receiving_status = 'completed' then
    raise exception 'Приёмка уже подтверждена';
  end if;

  if v_row.active_receiving_id is null then
    raise exception 'Сначала начните приёмку';
  end if;

  select * into v_rec
  from public.product_supply_receivings as r
  where r.id = v_row.active_receiving_id
  for update;

  if not found or v_rec.status is distinct from 'draft' then
    raise exception 'Черновик приёмки не найден';
  end if;

  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Позиции приёмки должны быть массивом JSON';
  end if;

  for v_elem in select * from jsonb_array_elements(p_items)
  loop
    begin
      v_line_id := (v_elem ->> 'id')::uuid;
    exception
      when others then
        raise exception 'Некорректный id строки приёмки';
    end;

    if v_line_id is null then
      raise exception 'id строки приёмки обязателен';
    end if;

    select * into v_line
    from public.product_supply_receiving_items as ri
    where ri.id = v_line_id
      and ri.receiving_id = v_rec.id
    for update;

    if not found then
      raise exception 'Строка приёмки не найдена';
    end if;

    if not (v_elem ? 'received_quantity')
       or nullif(trim(coalesce(v_elem ->> 'received_quantity', '')), '') is null then
      -- Draft save: leave received unset.
      update public.product_supply_receiving_items as ri
      set
        received_quantity = null,
        damaged_quantity = 0,
        accepted_quantity = null,
        difference_quantity = null,
        discrepancy_type = case
          when ri.is_unexpected then 'unexpected'::public.product_supply_discrepancy_type
          else null
        end,
        comment = nullif(trim(coalesce(v_elem ->> 'comment', '')), ''),
        line_status = 'pending'
      where ri.id = v_line_id;
      continue;
    end if;

    begin
      v_received := (v_elem ->> 'received_quantity')::numeric;
    exception
      when others then
        raise exception 'Некорректное полученное количество';
    end;

    if v_received < 0 then
      raise exception 'Полученное количество не может быть отрицательным';
    end if;

    begin
      v_damaged := coalesce((v_elem ->> 'damaged_quantity')::numeric, 0);
    exception
      when others then
        raise exception 'Некорректное количество повреждённого';
    end;

    if v_damaged < 0 then
      raise exception 'Повреждённое количество не может быть отрицательным';
    end if;
    if v_damaged > v_received then
      raise exception 'Повреждённое не может превышать полученное';
    end if;

    v_accepted := v_received - v_damaged;
    v_diff := v_received - v_line.expected_quantity;

    v_disc := null;
    if nullif(trim(coalesce(v_elem ->> 'discrepancy_type', '')), '') is not null then
      begin
        v_disc := trim(v_elem ->> 'discrepancy_type')::public.product_supply_discrepancy_type;
      exception
        when invalid_text_representation then
          raise exception 'Некорректный тип расхождения';
      end;
    end if;

    if v_diff <> 0 and v_disc is null then
      raise exception 'Укажите причину расхождения для %', coalesce(v_line.sku_snapshot, v_line_id::text);
    end if;

    if v_line.is_unexpected and v_disc is null then
      v_disc := 'unexpected';
    end if;

    if v_damaged > 0 and v_disc is null then
      v_disc := 'damaged';
    end if;

    if v_diff = 0 and not v_line.is_unexpected and v_damaged = 0 then
      v_disc := null;
    end if;

    v_comment := nullif(trim(coalesce(v_elem ->> 'comment', '')), '');
    if v_comment is not null and char_length(v_comment) > 2000 then
      raise exception 'Комментарий не длиннее 2000 символов';
    end if;

    update public.product_supply_receiving_items as ri
    set
      received_quantity = v_received,
      damaged_quantity = v_damaged,
      accepted_quantity = v_accepted,
      difference_quantity = v_diff,
      discrepancy_type = v_disc,
      comment = coalesce(v_comment, ri.comment),
      line_status = 'filled'
    where ri.id = v_line_id;
  end loop;

  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_save_product_supply_receiving(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.staff_save_product_supply_receiving(uuid, jsonb)
  to authenticated;

create or replace function public.staff_add_unexpected_product_supply_receiving_item(
  p_supply_id uuid,
  p_product_id uuid,
  p_received_quantity numeric,
  p_damaged_quantity numeric default 0,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_rec public.product_supply_receivings;
  v_product public.products;
  v_supply_item_id uuid;
  v_rate numeric;
  v_sort integer;
  v_received numeric(14, 3);
  v_damaged numeric(14, 3);
  v_accepted numeric(14, 3);
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);

  if v_row.status = 'closed' then
    raise exception 'В закрытую поставку нельзя добавить неожиданный товар';
  end if;

  if v_row.receiving_status = 'completed' then
    raise exception 'Приёмка уже подтверждена';
  end if;

  if v_row.active_receiving_id is null then
    raise exception 'Сначала начните приёмку';
  end if;

  select * into v_rec
  from public.product_supply_receivings as r
  where r.id = v_row.active_receiving_id
  for update;

  if not found or v_rec.status is distinct from 'draft' then
    raise exception 'Черновик приёмки не найден';
  end if;

  if p_product_id is null then
    raise exception 'Товар обязателен';
  end if;

  select * into v_product
  from public.products as p
  where p.id = p_product_id;

  if not found then
    raise exception 'Товар не найден';
  end if;

  if p_received_quantity is null or p_received_quantity < 0 then
    raise exception 'Полученное количество не может быть отрицательным';
  end if;
  v_received := coalesce(p_received_quantity, 0);
  v_damaged := coalesce(p_damaged_quantity, 0);
  if v_damaged < 0 then
    raise exception 'Повреждённое количество не может быть отрицательным';
  end if;
  if v_damaged > v_received then
    raise exception 'Повреждённое не может превышать полученное';
  end if;
  v_accepted := v_received - v_damaged;

  if exists (
    select 1
    from public.product_supply_receiving_items as ri
    where ri.receiving_id = v_rec.id
      and ri.product_id = p_product_id
  ) then
    raise exception 'Товар «%» уже есть в приёмке', v_product.sku;
  end if;

  select i.id into v_supply_item_id
  from public.product_supply_items as i
  where i.supply_id = p_supply_id
    and i.product_id = p_product_id;

  if v_supply_item_id is null then
    v_rate := public.product_supply_get_fx_rate(p_supply_id, v_row.default_currency);

    select coalesce(max(i.sort_order), 0) + 1
    into v_sort
    from public.product_supply_items as i
    where i.supply_id = p_supply_id;

    insert into public.product_supply_items (
      supply_id,
      product_id,
      sort_order,
      quantity,
      unit,
      purchase_currency,
      purchase_price_per_unit,
      exchange_rate_to_kzt,
      unit_net_weight_kg,
      qty_source,
      ordered_quantity,
      shipped_quantity
    ) values (
      p_supply_id,
      p_product_id,
      v_sort,
      greatest(coalesce(nullif(v_received, 0), 1), 1),
      v_product.unit,
      v_row.default_currency,
      null,
      v_rate,
      v_product.weight_kg,
      'manual',
      0,
      0
    )
    returning id into v_supply_item_id;

    perform public.staff_recalculate_product_supply(p_supply_id);
  end if;

  select coalesce(max(ri.sort_order), 0) + 1
  into v_sort
  from public.product_supply_receiving_items as ri
  where ri.receiving_id = v_rec.id;

  insert into public.product_supply_receiving_items (
    receiving_id,
    supply_item_id,
    product_id,
    sort_order,
    sku_snapshot,
    name_snapshot,
    spec_snapshot,
    ordered_quantity,
    shipped_quantity,
    expected_quantity,
    received_quantity,
    damaged_quantity,
    accepted_quantity,
    difference_quantity,
    discrepancy_type,
    comment,
    is_unexpected,
    line_status
  ) values (
    v_rec.id,
    v_supply_item_id,
    p_product_id,
    v_sort,
    v_product.sku,
    v_product.name,
    null,
    0,
    0,
    0,
    v_received,
    v_damaged,
    v_accepted,
    v_received,
    'unexpected',
    v_comment,
    true,
    'filled'
  );

  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_add_unexpected_product_supply_receiving_item(
  uuid, uuid, numeric, numeric, text
) from public, anon, authenticated;
grant execute on function public.staff_add_unexpected_product_supply_receiving_item(
  uuid, uuid, numeric, numeric, text
) to authenticated;

create or replace function public.staff_confirm_product_supply_receiving(p_supply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_rec public.product_supply_receivings;
  v_line public.product_supply_receiving_items;
  v_product public.products;
  v_warehouse_id uuid;
  v_batch uuid;
  v_inv public.inventory;
  v_prev numeric(14, 3);
  v_new numeric(14, 3);
  v_qty numeric(14, 3);
  v_receipt_id uuid;
  v_accepted numeric(14, 3);
  v_diff numeric(14, 3);
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);

  -- Idempotent: already completed / confirmed → no new receipts.
  if v_row.receiving_status = 'completed' then
    return public.staff_product_supply_payload(p_supply_id);
  end if;

  if v_row.active_receiving_id is null then
    raise exception 'Сначала начните приёмку';
  end if;

  select * into v_rec
  from public.product_supply_receivings as r
  where r.id = v_row.active_receiving_id
  for update;

  if not found then
    raise exception 'Приёмка не найдена';
  end if;

  if v_rec.status = 'confirmed' then
    update public.product_supplies
    set
      receiving_status = 'completed',
      inventory_receipt_id = coalesce(inventory_receipt_id, v_rec.stock_receipt_batch_id)
    where id = p_supply_id;
    return public.staff_product_supply_payload(p_supply_id);
  end if;

  -- Unresolved product matching on factory docs (preview/committed, not skipped).
  if to_regclass('public.product_supply_document_rows') is not null then
    if exists (
      select 1
      from public.product_supply_document_rows as r
      join public.product_supply_documents as d on d.id = r.document_id
      where r.supply_id = p_supply_id
        and d.document_type in ('factory_order', 'factory_shipment')
        and d.parser_status is distinct from 'skipped'
        and r.match_status in ('unmatched', 'needs_selection')
        and r.match_status is distinct from 'skipped'
    ) then
      raise exception 'Есть несопоставленные строки документов — сначала завершите matching';
    end if;
  end if;

  for v_line in
    select *
    from public.product_supply_receiving_items as ri
    where ri.receiving_id = v_rec.id
    order by ri.sort_order, ri.id
  loop
    if v_line.received_quantity is null then
      raise exception 'Укажите полученное количество для всех позиций (нет: %)',
        coalesce(v_line.sku_snapshot, v_line.id::text);
    end if;
    if v_line.received_quantity < 0 or v_line.damaged_quantity < 0 then
      raise exception 'Количества приёмки не могут быть отрицательными';
    end if;
    if v_line.damaged_quantity > v_line.received_quantity then
      raise exception 'Повреждённое не может превышать полученное (%)',
        coalesce(v_line.sku_snapshot, v_line.id::text);
    end if;

    v_accepted := v_line.received_quantity - v_line.damaged_quantity;
    v_diff := v_line.received_quantity - v_line.expected_quantity;

    if v_accepted is distinct from v_line.accepted_quantity then
      update public.product_supply_receiving_items
      set accepted_quantity = v_accepted, difference_quantity = v_diff
      where id = v_line.id;
    end if;

    if v_line.product_id is null then
      raise exception 'У строки приёмки должен быть товар';
    end if;

    if (v_diff <> 0 or v_line.is_unexpected or v_line.damaged_quantity > 0)
       and v_line.discrepancy_type is null then
      raise exception 'Укажите причину расхождения для %',
        coalesce(v_line.sku_snapshot, v_line.id::text);
    end if;
  end loop;

  v_warehouse_id := public.staff_resolve_warehouse_id();
  v_batch := gen_random_uuid();

  for v_line in
    select *
    from public.product_supply_receiving_items as ri
    where ri.receiving_id = v_rec.id
    order by ri.sort_order, ri.id
    for update
  loop
    -- Always recompute from received/damaged (do not trust loop row snapshot).
    v_accepted := v_line.received_quantity - v_line.damaged_quantity;

    if v_accepted is null or v_accepted <= 0 then
      continue;
    end if;

    v_qty := v_accepted;

    select * into v_product
    from public.products as p
    where p.id = v_line.product_id
    for update;

    if not found then
      raise exception 'Товар не найден';
    end if;

    select * into v_inv
    from public.inventory as i
    where i.product_id = v_line.product_id
      and i.warehouse_id = v_warehouse_id
    for update;

    if not found then
      insert into public.inventory (
        product_id,
        warehouse_id,
        quantity,
        reserved_quantity
      ) values (
        v_line.product_id,
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

    if v_new > 99999999999.999 then
      raise exception 'Итоговый остаток превысит допустимый предел numeric(14,3)';
    end if;

    update public.inventory as i
    set
      quantity = v_new,
      updated_at = now()
    where i.id = v_inv.id;

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
      v_line.product_id,
      v_warehouse_id,
      v_inv.id,
      v_qty,
      v_prev,
      v_new,
      v_row.supply_number,
      'Приёмка поставки ' || v_row.supply_number,
      v_uid,
      jsonb_build_object(
        'source', 'product_supply_receiving',
        'supply_id', p_supply_id,
        'supply_number', v_row.supply_number,
        'receiving_id', v_rec.id,
        'receiving_item_id', v_line.id,
        'supply_item_id', v_line.supply_item_id,
        'product_sku', v_product.sku,
        'ordered_quantity', v_line.ordered_quantity,
        'shipped_quantity', v_line.shipped_quantity,
        'received_quantity', v_line.received_quantity,
        'damaged_quantity', v_line.damaged_quantity,
        'accepted_quantity', v_accepted,
        'stock_receipt_batch_id', v_batch
      )
    )
    returning id into v_receipt_id;

    update public.product_supply_receiving_items
    set stock_receipt_id = v_receipt_id
    where id = v_line.id;

    begin
      perform public.notify_stock_received(v_receipt_id);
    exception
      when others then
        raise warning
          'notify_stock_received failed for receipt %: %',
          v_receipt_id,
          SQLERRM;
    end;
  end loop;

  -- Mirror received/damaged/accepted onto supply items (financial qty untouched).
  update public.product_supply_items as i
  set
    received_quantity = ri.received_quantity,
    damaged_quantity = ri.damaged_quantity,
    accepted_quantity = ri.accepted_quantity
  from public.product_supply_receiving_items as ri
  where ri.receiving_id = v_rec.id
    and ri.supply_item_id = i.id;

  update public.product_supply_receivings as r
  set
    status = 'confirmed',
    warehouse_id = v_warehouse_id,
    confirmed_by = v_uid,
    confirmed_at = now(),
    stock_receipt_batch_id = v_batch
  where r.id = v_rec.id;

  update public.product_supplies as s
  set
    receiving_status = 'completed',
    inventory_receipt_id = v_batch,
    active_receiving_id = v_rec.id
  where s.id = p_supply_id;

  -- Intentionally NO financial recalculate / close changes for shortages.
  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_confirm_product_supply_receiving(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_confirm_product_supply_receiving(uuid)
  to authenticated;

-- ============================================================
-- 12. FX backfill (no recalc of closed supplies)
-- ============================================================

-- Uniform non-null CNY item rates → supply CNY FX
insert into public.product_supply_fx_rates (
  supply_id, currency, rate_to_kzt, source_note, updated_at
)
select
  x.supply_id,
  'CNY'::public.product_supply_currency,
  x.rate_to_kzt,
  'backfill: uniform item rates',
  now()
from (
  select
    i.supply_id,
    min(i.exchange_rate_to_kzt) as rate_to_kzt
  from public.product_supply_items as i
  where i.purchase_currency = 'CNY'
    and i.exchange_rate_to_kzt is not null
    and i.exchange_rate_to_kzt > 0
  group by i.supply_id
  having count(distinct i.exchange_rate_to_kzt) = 1
) as x
where not exists (
  select 1
  from public.product_supply_fx_rates as f
  where f.supply_id = x.supply_id
    and f.currency = 'CNY'
);

-- Uniform non-null USD item rates → supply USD FX
insert into public.product_supply_fx_rates (
  supply_id, currency, rate_to_kzt, source_note, updated_at
)
select
  x.supply_id,
  'USD'::public.product_supply_currency,
  x.rate_to_kzt,
  'backfill: uniform item rates',
  now()
from (
  select
    i.supply_id,
    min(i.exchange_rate_to_kzt) as rate_to_kzt
  from public.product_supply_items as i
  where i.purchase_currency = 'USD'
    and i.exchange_rate_to_kzt is not null
    and i.exchange_rate_to_kzt > 0
  group by i.supply_id
  having count(distinct i.exchange_rate_to_kzt) = 1
) as x
where not exists (
  select 1
  from public.product_supply_fx_rates as f
  where f.supply_id = x.supply_id
    and f.currency = 'USD'
);

-- Header default rate when no matching FX yet (incl. supplies without items)
insert into public.product_supply_fx_rates (
  supply_id, currency, rate_to_kzt, source_note, updated_at
)
select
  s.id,
  s.default_currency,
  s.default_exchange_rate_to_kzt,
  'backfill: default_exchange_rate_to_kzt',
  now()
from public.product_supplies as s
where s.default_currency in ('CNY', 'USD')
  and s.default_exchange_rate_to_kzt is not null
  and s.default_exchange_rate_to_kzt > 0
  and not exists (
    select 1
    from public.product_supply_fx_rates as f
    where f.supply_id = s.id
      and f.currency = s.default_currency
  );

-- Sync header default from FX when currencies match
update public.product_supplies as s
set default_exchange_rate_to_kzt = f.rate_to_kzt
from public.product_supply_fx_rates as f
where f.supply_id = s.id
  and f.currency = s.default_currency
  and (
    s.default_exchange_rate_to_kzt is distinct from f.rate_to_kzt
  );

-- ============================================================
-- 13. Notes
-- ============================================================

comment on function public.staff_confirm_product_supply_receiving(uuid) is
  'Admin: confirm factual receiving. Idempotent. Writes ALMATY-01 stock_receipts for accepted_quantity only. Does not change financial landed-cost formula.';

comment on function public.staff_set_product_supply_fx_rates(uuid, jsonb) is
  'Admin draft: upsert supply CNY/USD rates, snapshot onto items and non-custom expenses, recalculate.';

comment on function public.product_supply_get_fx_rate(uuid, public.product_supply_currency) is
  'KZT→1; else product_supply_fx_rates; else default_exchange_rate_to_kzt only when currency=default_currency.';
