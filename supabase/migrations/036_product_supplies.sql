-- ============================================================
-- 036_product_supplies.sql
-- Stage 38 — Product supplies + factual landed cost
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify migrations 001–035 files.
--
-- Financial procurement module, independent of Chinese invoice/PDF/Excel.
-- Manual entry now; future import should fill these same tables.
--
-- Explicitly NOT done:
--   - no inventory / stock_receipts writes on create or close;
--   - no operating expenses (rent, payroll, ads) in landed cost;
--   - no supplier directory (text field; no Chinese-supplier entity exists);
--   - no automatic reopen after close.
--
-- Product reuse:
--   public.products (draft = unpublished, excluded from get_catalog).
--   Weight snapshot lives on supply items, not as a required product field.
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null then
    raise exception 'public.products missing — run 002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_escape_ilike_term(text)') is null then
    raise exception 'staff_escape_ilike_term missing — run 011_staff_manual_orders.sql first.';
  end if;

  if to_regprocedure('public.staff_can_manage_products()') is null
     or to_regprocedure('public.staff_unique_product_slug(text, uuid)') is null
     or to_regprocedure('public.staff_assert_product_category_pair(uuid, uuid)') is null
  then
    raise exception 'Product RPCs missing — run 019_product_management.sql first.';
  end if;

  if to_regprocedure('public.set_updated_at()') is null then
    raise exception 'set_updated_at missing — run 001 first.';
  end if;

  if to_regclass('public.stock_receipts') is null then
    raise exception 'public.stock_receipts missing — run 030 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Enums
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_status') then
    create type public.product_supply_status as enum ('draft', 'closed');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'product_supply_currency') then
    create type public.product_supply_currency as enum ('KZT', 'CNY', 'USD');
  end if;
end
$$;

-- ============================================================
-- 2. Sequence / internal number
-- ============================================================

create sequence if not exists public.product_supplies_number_seq
  as bigint
  start with 1
  increment by 1
  minvalue 1
  no maxvalue
  cache 1;

revoke all on sequence public.product_supplies_number_seq
  from public, anon, authenticated;

create or replace function public.generate_product_supply_number(p_n bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'П-' || lpad(p_n::text, 6, '0');
$$;

revoke all on function public.generate_product_supply_number(bigint)
  from public, anon, authenticated;

-- ============================================================
-- 3. Tables
-- ============================================================

create table if not exists public.product_supplies (
  id uuid primary key default gen_random_uuid(),
  sequence_number bigint not null default nextval('public.product_supplies_number_seq'),
  supply_number text not null,
  title text not null,
  supplier_name text,
  supply_date date not null default current_date,
  default_currency public.product_supply_currency not null default 'CNY',
  default_exchange_rate_to_kzt numeric(18, 6),
  gross_weight_kg numeric(18, 6),
  notes text,
  status public.product_supply_status not null default 'draft',
  source_kind text not null default 'manual',
  source_metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles (id) on delete restrict,
  total_net_weight_kg numeric(18, 6),
  packaging_weight_kg numeric(18, 6),
  packaging_weight_pct numeric(18, 6),
  total_purchase_kzt numeric(18, 6),
  total_expenses_kzt numeric(18, 6),
  expense_per_kg numeric(18, 6),
  total_landed_cost_kzt numeric(18, 6),
  closed_snapshot jsonb,
  constraint product_supplies_sequence_unique unique (sequence_number),
  constraint product_supplies_number_unique unique (supply_number),
  constraint product_supplies_number_not_blank check (length(trim(supply_number)) > 0),
  constraint product_supplies_title_not_blank check (length(trim(title)) > 0),
  constraint product_supplies_title_len check (char_length(title) <= 200),
  constraint product_supplies_supplier_len check (
    supplier_name is null
    or (
      length(trim(supplier_name)) > 0
      and char_length(trim(supplier_name)) <= 200
    )
  ),
  constraint product_supplies_notes_len check (
    notes is null or char_length(notes) <= 4000
  ),
  constraint product_supplies_source_kind_check check (
    source_kind in ('manual', 'import')
  ),
  constraint product_supplies_source_metadata_object check (
    jsonb_typeof(source_metadata) = 'object'
  ),
  constraint product_supplies_rate_positive check (
    default_exchange_rate_to_kzt is null
    or default_exchange_rate_to_kzt > 0
  ),
  constraint product_supplies_gross_non_negative check (
    gross_weight_kg is null or gross_weight_kg >= 0
  ),
  constraint product_supplies_closed_fields check (
    (status = 'draft' and closed_at is null and closed_by is null)
    or (status = 'closed' and closed_at is not null and closed_by is not null)
  )
);

comment on table public.product_supplies is
  'Financial product supply (China procurement). Landed/factual cost only. Does not change inventory. Operating expenses are out of scope.';

comment on column public.product_supplies.source_kind is
  'manual now; future PDF/Excel import should write the same tables.';

comment on column public.product_supplies.gross_weight_kg is
  'Actual dirty/gross weight of the shipment (goods + pallets + packing).';

create index if not exists product_supplies_status_created_idx
  on public.product_supplies (status, created_at desc);

create index if not exists product_supplies_supply_date_idx
  on public.product_supplies (supply_date desc);

drop trigger if exists product_supplies_set_updated_at on public.product_supplies;
create trigger product_supplies_set_updated_at
  before update on public.product_supplies
  for each row
  execute function public.set_updated_at();

create table if not exists public.product_supply_items (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  sort_order integer not null default 0,
  quantity numeric(14, 3) not null,
  unit text not null default 'шт.',
  purchase_currency public.product_supply_currency not null,
  purchase_price_per_unit numeric(18, 6),
  exchange_rate_to_kzt numeric(18, 6),
  purchase_price_per_unit_kzt numeric(18, 6),
  unit_net_weight_kg numeric(18, 6),
  total_net_weight_kg numeric(18, 6),
  item_weight_share numeric(18, 8),
  allocated_gross_weight_kg numeric(18, 6),
  gross_weight_per_unit_kg numeric(18, 6),
  allocated_expenses_kzt numeric(18, 6),
  expense_per_unit_kzt numeric(18, 6),
  purchase_total_kzt numeric(18, 6),
  landed_cost_per_unit_kzt numeric(18, 6),
  landed_cost_total_kzt numeric(18, 6),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_supply_items_unique_product unique (supply_id, product_id),
  constraint product_supply_items_qty_positive check (quantity > 0),
  constraint product_supply_items_unit_not_blank check (length(trim(unit)) > 0),
  constraint product_supply_items_price_non_negative check (
    purchase_price_per_unit is null or purchase_price_per_unit >= 0
  ),
  constraint product_supply_items_rate_positive check (
    exchange_rate_to_kzt is null or exchange_rate_to_kzt > 0
  ),
  constraint product_supply_items_unit_weight_non_negative check (
    unit_net_weight_kg is null or unit_net_weight_kg >= 0
  )
);

comment on column public.product_supply_items.unit_net_weight_kg is
  'Snapshot of net weight per unit for this supply. Not a required products.weight_kg.';

create index if not exists product_supply_items_supply_idx
  on public.product_supply_items (supply_id, sort_order, id);

create index if not exists product_supply_items_product_idx
  on public.product_supply_items (product_id);

drop trigger if exists product_supply_items_set_updated_at on public.product_supply_items;
create trigger product_supply_items_set_updated_at
  before update on public.product_supply_items
  for each row
  execute function public.set_updated_at();

create table if not exists public.product_supply_expenses (
  id uuid primary key default gen_random_uuid(),
  supply_id uuid not null references public.product_supplies (id) on delete cascade,
  category_key text not null default 'custom',
  name text not null,
  amount numeric(18, 6) not null,
  currency public.product_supply_currency not null,
  exchange_rate_to_kzt numeric(18, 6),
  amount_kzt numeric(18, 6),
  expense_date date,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_supply_expenses_name_not_blank check (length(trim(name)) > 0),
  constraint product_supply_expenses_name_len check (char_length(name) <= 200),
  constraint product_supply_expenses_category_len check (
    length(trim(category_key)) > 0 and char_length(category_key) <= 80
  ),
  constraint product_supply_expenses_amount_non_negative check (amount >= 0),
  constraint product_supply_expenses_rate_positive check (
    exchange_rate_to_kzt is null or exchange_rate_to_kzt > 0
  ),
  constraint product_supply_expenses_notes_len check (
    notes is null or char_length(notes) <= 2000
  )
);

comment on table public.product_supply_expenses is
  'Supply-level landed-cost expenses (customs, freight, broker). Not operating overhead.';

create index if not exists product_supply_expenses_supply_idx
  on public.product_supply_expenses (supply_id, sort_order, id);

drop trigger if exists product_supply_expenses_set_updated_at on public.product_supply_expenses;
create trigger product_supply_expenses_set_updated_at
  before update on public.product_supply_expenses
  for each row
  execute function public.set_updated_at();

alter table public.product_supplies enable row level security;
alter table public.product_supply_items enable row level security;
alter table public.product_supply_expenses enable row level security;

revoke all on table public.product_supplies from public, anon, authenticated;
revoke all on table public.product_supply_items from public, anon, authenticated;
revoke all on table public.product_supply_expenses from public, anon, authenticated;

-- ============================================================
-- 4. Product status: allow draft (unpublished) in existing staff RPCs
-- ============================================================

create or replace function public.staff_list_products(
  p_query text default null,
  p_category_id uuid default null,
  p_status text default null,
  p_limit integer default 100
)
returns table (
  id uuid,
  sku text,
  name text,
  category_id uuid,
  category_name text,
  subcategory_id uuid,
  subcategory_name text,
  unit text,
  base_price numeric,
  min_order_qty numeric,
  status public.product_status,
  main_photo_path text,
  available_quantity numeric,
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
  v_status public.product_status;
  v_warehouse_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_read_products() then
    raise exception 'Недостаточно прав для просмотра товаров';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  if nullif(trim(p_status), '') is not null then
    begin
      v_status := trim(p_status)::public.product_status;
    exception
      when invalid_text_representation then
        raise exception 'Некорректный статус товара';
    end;
  end if;

  v_warehouse_id := public.staff_resolve_warehouse_id();

  return query
  select
    p.id,
    p.sku,
    p.name,
    p.category_id,
    cat.name as category_name,
    p.subcategory_id,
    sub.name as subcategory_name,
    p.unit,
    p.base_price,
    p.min_order_qty,
    p.status,
    p.main_photo_path,
    greatest(
      coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0),
      0
    ) as available_quantity,
    p.created_at,
    p.updated_at
  from public.products as p
  left join public.categories as cat on cat.id = p.category_id
  left join public.categories as sub on sub.id = p.subcategory_id
  left join public.inventory as i
    on i.product_id = p.id and i.warehouse_id = v_warehouse_id
  where (v_status is null or p.status = v_status)
    and (
      p_category_id is null
      or p.category_id = p_category_id
      or p.subcategory_id = p_category_id
    )
    and (
      v_term is null
      or p.sku ilike ('%' || v_term || '%') escape '\'
      or p.name ilike ('%' || v_term || '%') escape '\'
      or coalesce(p.original_sku, '') ilike ('%' || v_term || '%') escape '\'
    )
  order by p.updated_at desc, p.name
  limit v_limit;
end;
$$;

revoke all on function public.staff_list_products(text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_products(text, uuid, text, integer)
  to authenticated;

create or replace function public.staff_create_product(
  p_sku text,
  p_name text,
  p_category_id uuid,
  p_subcategory_id uuid default null,
  p_status text default 'active',
  p_base_price numeric default null,
  p_min_order_qty numeric default 1,
  p_unit text default 'шт.',
  p_length_mm numeric default null,
  p_width_mm numeric default null,
  p_thickness_mm numeric default null,
  p_weight_kg numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku text := nullif(trim(p_sku), '');
  v_name text := nullif(trim(p_name), '');
  v_unit text := coalesce(nullif(trim(p_unit), ''), 'шт.');
  v_status public.product_status;
  v_min numeric := coalesce(p_min_order_qty, 1);
  v_id uuid := gen_random_uuid();
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может создавать товары';
  end if;

  if v_sku is null then
    raise exception 'Артикул обязателен';
  end if;
  if v_name is null then
    raise exception 'Название обязательно';
  end if;
  if v_min <= 0 then
    raise exception 'Минимальный заказ должен быть больше 0';
  end if;
  if p_base_price is not null and p_base_price < 0 then
    raise exception 'Цена не может быть отрицательной';
  end if;

  begin
    v_status := coalesce(nullif(trim(p_status), ''), 'active')::public.product_status;
  exception
    when invalid_text_representation then
      raise exception 'Некорректный статус';
  end;

  if v_status = 'draft' and p_category_id is null then
    if p_subcategory_id is not null then
      raise exception 'Подкатегория без категории недопустима';
    end if;
  else
    perform public.staff_assert_product_category_pair(p_category_id, p_subcategory_id);
  end if;

  if exists (select 1 from public.products as p where p.sku = v_sku) then
    raise exception 'Товар с артикулом «%» уже существует', v_sku;
  end if;

  v_slug := public.staff_unique_product_slug(v_sku, null);

  insert into public.products (
    id,
    category_id,
    subcategory_id,
    name,
    slug,
    sku,
    unit,
    base_price,
    min_order_qty,
    length_mm,
    width_mm,
    thickness_mm,
    weight_kg,
    dimensions,
    status
  ) values (
    v_id,
    p_category_id,
    p_subcategory_id,
    v_name,
    v_slug,
    v_sku,
    v_unit,
    p_base_price,
    v_min,
    p_length_mm,
    p_width_mm,
    p_thickness_mm,
    p_weight_kg,
    public.staff_format_product_dimensions(p_length_mm, p_width_mm, p_thickness_mm),
    v_status
  );

  return public.staff_get_product(v_id);
end;
$$;

revoke all on function public.staff_create_product(
  text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.staff_create_product(
  text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) to authenticated;

create or replace function public.staff_update_product(
  p_product_id uuid,
  p_sku text,
  p_name text,
  p_category_id uuid,
  p_subcategory_id uuid default null,
  p_status text default 'active',
  p_base_price numeric default null,
  p_min_order_qty numeric default 1,
  p_unit text default 'шт.',
  p_length_mm numeric default null,
  p_width_mm numeric default null,
  p_thickness_mm numeric default null,
  p_weight_kg numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku text := nullif(trim(p_sku), '');
  v_name text := nullif(trim(p_name), '');
  v_unit text := coalesce(nullif(trim(p_unit), ''), 'шт.');
  v_status public.product_status;
  v_min numeric := coalesce(p_min_order_qty, 1);
  v_existing public.products;
begin
  if auth.uid() is null then
    raise exception 'Требуется авторизация';
  end if;

  if not public.staff_can_manage_products() then
    raise exception 'Только администратор может изменять товары';
  end if;

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  select * into v_existing
  from public.products as p
  where p.id = p_product_id
  for update;

  if not found then
    raise exception 'Товар не найден';
  end if;

  if v_sku is null then
    raise exception 'Артикул обязателен';
  end if;
  if v_name is null then
    raise exception 'Название обязательно';
  end if;
  if v_min <= 0 then
    raise exception 'Минимальный заказ должен быть больше 0';
  end if;
  if p_base_price is not null and p_base_price < 0 then
    raise exception 'Цена не может быть отрицательной';
  end if;

  begin
    v_status := coalesce(nullif(trim(p_status), ''), 'active')::public.product_status;
  exception
    when invalid_text_representation then
      raise exception 'Некорректный статус';
  end;

  if v_status = 'active' then
    perform public.staff_assert_product_category_pair(p_category_id, p_subcategory_id);
  elsif p_category_id is null then
    if p_subcategory_id is not null then
      raise exception 'Подкатегория без категории недопустима';
    end if;
  else
    perform public.staff_assert_product_category_pair(p_category_id, p_subcategory_id);
  end if;

  if exists (
    select 1 from public.products as p
    where p.sku = v_sku and p.id <> p_product_id
  ) then
    raise exception 'Товар с артикулом «%» уже существует', v_sku;
  end if;

  update public.products as p
  set
    sku = v_sku,
    name = v_name,
    slug = case
      when p.sku is distinct from v_sku
        then public.staff_unique_product_slug(v_sku, p_product_id)
      else p.slug
    end,
    category_id = p_category_id,
    subcategory_id = p_subcategory_id,
    status = v_status,
    unit = v_unit,
    base_price = p_base_price,
    min_order_qty = v_min,
    length_mm = p_length_mm,
    width_mm = p_width_mm,
    thickness_mm = p_thickness_mm,
    weight_kg = p_weight_kg,
    dimensions = public.staff_format_product_dimensions(
      p_length_mm, p_width_mm, p_thickness_mm
    ),
    updated_at = now()
  where p.id = p_product_id;

  return public.staff_get_product(p_product_id);
end;
$$;

revoke all on function public.staff_update_product(
  uuid, text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) from public, anon, authenticated;
grant execute on function public.staff_update_product(
  uuid, text, text, uuid, uuid, text, numeric, numeric, text,
  numeric, numeric, numeric, numeric
) to authenticated;

-- ============================================================
-- 5. Internal helpers
-- ============================================================

create or replace function public.staff_assert_product_supply_admin()
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
    raise exception 'Только администратор может управлять поставками';
  end if;

  return v_uid;
end;
$$;

revoke all on function public.staff_assert_product_supply_admin()
  from public, anon, authenticated;

create or replace function public.product_supply_parse_currency(p_currency text)
returns public.product_supply_currency
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cur public.product_supply_currency;
begin
  begin
    v_cur := upper(trim(coalesce(p_currency, '')))::public.product_supply_currency;
  exception
    when invalid_text_representation then
      raise exception 'Валюта: только KZT, CNY или USD';
  end;
  return v_cur;
end;
$$;

revoke all on function public.product_supply_parse_currency(text)
  from public, anon, authenticated;

create or replace function public.product_supply_amount_kzt(
  p_amount numeric,
  p_currency public.product_supply_currency,
  p_rate numeric
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_amount is null then
    return null;
  end if;
  if p_currency = 'KZT' then
    return p_amount;
  end if;
  if p_rate is null or p_rate <= 0 then
    return null;
  end if;
  return p_amount * p_rate;
end;
$$;

revoke all on function public.product_supply_amount_kzt(
  numeric, public.product_supply_currency, numeric
) from public, anon, authenticated;

create or replace function public.product_supply_resolved_rate(
  p_currency public.product_supply_currency,
  p_rate numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when p_currency = 'KZT' then 1::numeric
    else p_rate
  end;
$$;

revoke all on function public.product_supply_resolved_rate(
  public.product_supply_currency, numeric
) from public, anon, authenticated;

create or replace function public.staff_lock_product_supply(p_supply_id uuid)
returns public.product_supplies
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
begin
  if p_supply_id is null then
    raise exception 'id поставки обязателен';
  end if;

  select * into v_row
  from public.product_supplies as s
  where s.id = p_supply_id
  for update;

  if not found then
    raise exception 'Поставка не найдена';
  end if;

  return v_row;
end;
$$;

revoke all on function public.staff_lock_product_supply(uuid)
  from public, anon, authenticated;

create or replace function public.staff_assert_product_supply_draft(
  p_row public.product_supplies
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_row.status is distinct from 'draft' then
    raise exception 'Закрытую поставку нельзя изменять';
  end if;
end;
$$;

revoke all on function public.staff_assert_product_supply_draft(public.product_supplies)
  from public, anon, authenticated;

-- Remainder-preserving allocation so SUM(item allocated) = header totals.
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

  update public.product_supply_expenses as e
  set
    exchange_rate_to_kzt = public.product_supply_resolved_rate(
      e.currency, e.exchange_rate_to_kzt
    ),
    amount_kzt = public.product_supply_amount_kzt(
      e.amount,
      e.currency,
      public.product_supply_resolved_rate(e.currency, e.exchange_rate_to_kzt)
    )
  where e.supply_id = p_supply_id;

  update public.product_supply_items as i
  set
    exchange_rate_to_kzt = public.product_supply_resolved_rate(
      i.purchase_currency, i.exchange_rate_to_kzt
    ),
    purchase_price_per_unit_kzt = public.product_supply_amount_kzt(
      i.purchase_price_per_unit,
      i.purchase_currency,
      public.product_supply_resolved_rate(i.purchase_currency, i.exchange_rate_to_kzt)
    ),
    total_net_weight_kg = case
      when i.unit_net_weight_kg is null then null
      else i.quantity * i.unit_net_weight_kg
    end,
    purchase_total_kzt = case
      when i.purchase_price_per_unit is null then null
      else i.quantity * public.product_supply_amount_kzt(
        i.purchase_price_per_unit,
        i.purchase_currency,
        public.product_supply_resolved_rate(i.purchase_currency, i.exchange_rate_to_kzt)
      )
    end,
    item_weight_share = null,
    allocated_gross_weight_kg = null,
    gross_weight_per_unit_kg = null,
    allocated_expenses_kzt = null,
    expense_per_unit_kzt = null,
    landed_cost_per_unit_kzt = null,
    landed_cost_total_kzt = null
  where i.supply_id = p_supply_id;

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
    default_exchange_rate_to_kzt = public.product_supply_resolved_rate(
      s.default_currency, s.default_exchange_rate_to_kzt
    )
  where s.id = p_supply_id;
end;
$$;

revoke all on function public.staff_recalculate_product_supply(uuid)
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
    'landed_cost_total_kzt', i.landed_cost_total_kzt
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
        'amount_kzt', e.amount_kzt,
        'expense_date', e.expense_date,
        'notes', e.notes,
        'sort_order', e.sort_order
      )
      order by e.sort_order, e.created_at, e.id
    ),
    '[]'::jsonb
  )
  into v_expenses
  from public.product_supply_expenses as e
  where e.supply_id = p_supply_id;

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
      'source_kind', v_supply.source_kind,
      'created_by', v_supply.created_by,
      'created_at', v_supply.created_at,
      'updated_at', v_supply.updated_at,
      'closed_at', v_supply.closed_at,
      'closed_by', v_supply.closed_by,
      'is_preliminary', v_supply.status = 'draft'
    ),
    'items', v_items,
    'expenses', v_expenses,
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
-- 6. Public staff RPCs (admin only)
-- ============================================================

create or replace function public.staff_list_product_supplies(
  p_status text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_status public.product_supply_status;
  v_rows jsonb;
begin
  perform public.staff_assert_product_supply_admin();

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  if nullif(trim(p_status), '') is not null then
    begin
      v_status := trim(p_status)::public.product_supply_status;
    exception
      when invalid_text_representation then
        raise exception 'Статус поставки: draft или closed';
    end;
  end if;

  select coalesce(
    jsonb_agg(row_json order by sort_created desc, sequence_number desc),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      s.created_at as sort_created,
      s.sequence_number,
      jsonb_build_object(
        'id', s.id,
        'sequence_number', s.sequence_number,
        'supply_number', s.supply_number,
        'title', s.title,
        'supplier_name', s.supplier_name,
        'supply_date', s.supply_date,
        'status', s.status,
        'gross_weight_kg', s.gross_weight_kg,
        'total_expenses_kzt', s.total_expenses_kzt,
        'expense_per_kg', s.expense_per_kg,
        'total_landed_cost_kzt', s.total_landed_cost_kzt,
        'items_count', (
          select count(*)::integer
          from public.product_supply_items as i
          where i.supply_id = s.id
        ),
        'created_at', s.created_at,
        'closed_at', s.closed_at
      ) as row_json
    from public.product_supplies as s
    where v_status is null or s.status = v_status
    order by s.created_at desc, s.sequence_number desc
    limit v_limit
  ) as listed;

  return v_rows;
end;
$$;

revoke all on function public.staff_list_product_supplies(text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_product_supplies(text, integer)
  to authenticated;

create or replace function public.staff_get_product_supply(p_supply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.staff_assert_product_supply_admin();

  if p_supply_id is null then
    raise exception 'id поставки обязателен';
  end if;

  perform public.staff_recalculate_product_supply(p_supply_id);

  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_get_product_supply(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_get_product_supply(uuid)
  to authenticated;

create or replace function public.staff_create_product_supply(
  p_title text,
  p_supplier_name text default null,
  p_supply_date date default null,
  p_default_currency text default 'CNY',
  p_default_exchange_rate_to_kzt numeric default null,
  p_gross_weight_kg numeric default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_title text := nullif(trim(p_title), '');
  v_supplier text := nullif(trim(p_supplier_name), '');
  v_notes text := nullif(trim(p_notes), '');
  v_currency public.product_supply_currency;
  v_n bigint;
  v_id uuid := gen_random_uuid();
  v_rate numeric;
begin
  v_uid := public.staff_assert_product_supply_admin();

  if v_title is null then
    raise exception 'Название поставки обязательно';
  end if;

  v_currency := public.product_supply_parse_currency(
    coalesce(p_default_currency, 'CNY')
  );
  v_rate := public.product_supply_resolved_rate(
    v_currency, p_default_exchange_rate_to_kzt
  );

  if v_currency <> 'KZT' and v_rate is not null and v_rate <= 0 then
    raise exception 'Курс валюты должен быть больше 0';
  end if;

  if p_gross_weight_kg is not null and p_gross_weight_kg < 0 then
    raise exception 'Брутто-вес не может быть отрицательным';
  end if;

  v_n := nextval('public.product_supplies_number_seq');

  insert into public.product_supplies (
    id,
    sequence_number,
    supply_number,
    title,
    supplier_name,
    supply_date,
    default_currency,
    default_exchange_rate_to_kzt,
    gross_weight_kg,
    notes,
    created_by
  ) values (
    v_id,
    v_n,
    public.generate_product_supply_number(v_n),
    v_title,
    v_supplier,
    coalesce(p_supply_date, current_date),
    v_currency,
    v_rate,
    p_gross_weight_kg,
    v_notes,
    v_uid
  );

  perform public.staff_recalculate_product_supply(v_id);
  return public.staff_product_supply_payload(v_id);
end;
$$;

revoke all on function public.staff_create_product_supply(
  text, text, date, text, numeric, numeric, text
) from public, anon, authenticated;
grant execute on function public.staff_create_product_supply(
  text, text, date, text, numeric, numeric, text
) to authenticated;

create or replace function public.staff_update_product_supply(
  p_supply_id uuid,
  p_title text default null,
  p_supplier_name text default null,
  p_supply_date date default null,
  p_default_currency text default null,
  p_default_exchange_rate_to_kzt numeric default null,
  p_gross_weight_kg numeric default null,
  p_notes text default null,
  p_clear_supplier boolean default false,
  p_clear_notes boolean default false,
  p_clear_gross_weight boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
  v_title text;
  v_supplier text;
  v_notes text;
  v_currency public.product_supply_currency;
  v_rate numeric;
  v_gross numeric;
begin
  perform public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  v_title := coalesce(nullif(trim(p_title), ''), v_row.title);
  v_supplier := case
    when p_clear_supplier then null
    when p_supplier_name is not null then nullif(trim(p_supplier_name), '')
    else v_row.supplier_name
  end;
  v_notes := case
    when p_clear_notes then null
    when p_notes is not null then nullif(trim(p_notes), '')
    else v_row.notes
  end;
  v_currency := case
    when nullif(trim(p_default_currency), '') is not null
      then public.product_supply_parse_currency(p_default_currency)
    else v_row.default_currency
  end;
  v_rate := public.product_supply_resolved_rate(
    v_currency,
    coalesce(p_default_exchange_rate_to_kzt, v_row.default_exchange_rate_to_kzt)
  );
  v_gross := case
    when p_clear_gross_weight then null
    when p_gross_weight_kg is not null then p_gross_weight_kg
    else v_row.gross_weight_kg
  end;

  if v_gross is not null and v_gross < 0 then
    raise exception 'Брутто-вес не может быть отрицательным';
  end if;
  if v_currency <> 'KZT' and v_rate is not null and v_rate <= 0 then
    raise exception 'Курс валюты должен быть больше 0';
  end if;

  update public.product_supplies as s
  set
    title = v_title,
    supplier_name = v_supplier,
    supply_date = coalesce(p_supply_date, s.supply_date),
    default_currency = v_currency,
    default_exchange_rate_to_kzt = v_rate,
    gross_weight_kg = v_gross,
    notes = v_notes
  where s.id = p_supply_id;

  perform public.staff_recalculate_product_supply(p_supply_id);
  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_update_product_supply(
  uuid, text, text, date, text, numeric, numeric, text, boolean, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.staff_update_product_supply(
  uuid, text, text, date, text, numeric, numeric, text, boolean, boolean, boolean
) to authenticated;

create or replace function public.staff_delete_product_supply(p_supply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.product_supplies;
begin
  perform public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  delete from public.product_supplies where id = p_supply_id;
  return jsonb_build_object('deleted', true, 'id', p_supply_id);
end;
$$;

revoke all on function public.staff_delete_product_supply(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_delete_product_supply(uuid)
  to authenticated;

create or replace function public.staff_search_products_for_supply(
  p_query text default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_term text;
  v_rows jsonb;
begin
  perform public.staff_assert_product_supply_admin();

  v_limit := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  select coalesce(
    jsonb_agg(row_json order by updated_at desc, name),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      p.updated_at,
      p.name,
      jsonb_build_object(
        'id', p.id,
        'sku', p.sku,
        'name', p.name,
        'original_sku', p.original_sku,
        'unit', p.unit,
        'status', p.status,
        'weight_kg', p.weight_kg
      ) as row_json
    from public.products as p
    where p.status is distinct from 'archived'
      and (
        v_term is null
        or p.sku ilike ('%' || v_term || '%') escape '\'
        or p.name ilike ('%' || v_term || '%') escape '\'
        or coalesce(p.original_sku, '') ilike ('%' || v_term || '%') escape '\'
      )
    order by p.updated_at desc, p.name
    limit v_limit
  ) as found;

  return v_rows;
end;
$$;

revoke all on function public.staff_search_products_for_supply(text, integer)
  from public, anon, authenticated;
grant execute on function public.staff_search_products_for_supply(text, integer)
  to authenticated;

create or replace function public.staff_create_draft_product_for_supply(
  p_sku text,
  p_name text,
  p_unit text default 'шт.',
  p_original_sku text default null,
  p_category_id uuid default null,
  p_subcategory_id uuid default null,
  p_weight_kg numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku text := nullif(trim(p_sku), '');
  v_name text := nullif(trim(p_name), '');
  v_unit text := coalesce(nullif(trim(p_unit), ''), 'шт.');
  v_original text := nullif(trim(p_original_sku), '');
  v_id uuid := gen_random_uuid();
  v_slug text;
begin
  perform public.staff_assert_product_supply_admin();

  if v_sku is null then
    raise exception 'Артикул обязателен';
  end if;
  if v_name is null then
    raise exception 'Название обязательно';
  end if;
  if p_weight_kg is not null and p_weight_kg < 0 then
    raise exception 'Вес не может быть отрицательным';
  end if;

  if p_category_id is null then
    if p_subcategory_id is not null then
      raise exception 'Подкатегория без категории недопустима';
    end if;
  else
    perform public.staff_assert_product_category_pair(p_category_id, p_subcategory_id);
  end if;

  if exists (select 1 from public.products as p where p.sku = v_sku) then
    raise exception 'Товар с артикулом «%» уже существует', v_sku;
  end if;

  v_slug := public.staff_unique_product_slug(v_sku, null);

  insert into public.products (
    id,
    category_id,
    subcategory_id,
    name,
    slug,
    sku,
    original_sku,
    unit,
    min_order_qty,
    weight_kg,
    status
  ) values (
    v_id,
    p_category_id,
    p_subcategory_id,
    v_name,
    v_slug,
    v_sku,
    v_original,
    v_unit,
    1,
    p_weight_kg,
    'draft'
  );

  return jsonb_build_object(
    'id', v_id,
    'sku', v_sku,
    'name', v_name,
    'original_sku', v_original,
    'unit', v_unit,
    'status', 'draft',
    'weight_kg', p_weight_kg
  );
end;
$$;

revoke all on function public.staff_create_draft_product_for_supply(
  text, text, text, text, uuid, uuid, numeric
) from public, anon, authenticated;
grant execute on function public.staff_create_draft_product_for_supply(
  text, text, text, text, uuid, uuid, numeric
) to authenticated;

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
  v_rate := public.product_supply_resolved_rate(
    v_currency,
    coalesce(p_exchange_rate_to_kzt, v_row.default_exchange_rate_to_kzt)
  );

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
  v_rate := public.product_supply_resolved_rate(
    v_currency,
    coalesce(p_exchange_rate_to_kzt, v_item.exchange_rate_to_kzt)
  );

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

create or replace function public.staff_delete_product_supply_item(p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.product_supply_items;
  v_row public.product_supplies;
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

  delete from public.product_supply_items where id = p_item_id;
  perform public.staff_recalculate_product_supply(v_item.supply_id);
  return public.staff_product_supply_payload(v_item.supply_id);
end;
$$;

revoke all on function public.staff_delete_product_supply_item(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_delete_product_supply_item(uuid)
  to authenticated;

create or replace function public.staff_add_product_supply_expense(
  p_supply_id uuid,
  p_name text,
  p_amount numeric,
  p_currency text default 'KZT',
  p_exchange_rate_to_kzt numeric default null,
  p_category_key text default 'custom',
  p_expense_date date default null,
  p_notes text default null
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
  v_rate := public.product_supply_resolved_rate(
    v_currency,
    coalesce(p_exchange_rate_to_kzt, v_row.default_exchange_rate_to_kzt)
  );
  if v_currency <> 'KZT' and (v_rate is null or v_rate <= 0) then
    raise exception 'Для % укажите курс к тенге', v_currency;
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
    p_expense_date,
    v_notes,
    v_sort
  );

  perform public.staff_recalculate_product_supply(p_supply_id);
  return public.staff_product_supply_payload(p_supply_id);
end;
$$;

revoke all on function public.staff_add_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text
) from public, anon, authenticated;
grant execute on function public.staff_add_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text
) to authenticated;

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
  p_clear_date boolean default false
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
  v_rate := public.product_supply_resolved_rate(
    v_currency,
    coalesce(p_exchange_rate_to_kzt, v_exp.exchange_rate_to_kzt)
  );
  if v_currency <> 'KZT' and (v_rate is null or v_rate <= 0) then
    raise exception 'Для % укажите курс к тенге', v_currency;
  end if;

  update public.product_supply_expenses as e
  set
    name = v_name,
    amount = v_amount,
    currency = v_currency,
    exchange_rate_to_kzt = v_rate,
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
  uuid, text, numeric, text, numeric, text, date, text, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.staff_update_product_supply_expense(
  uuid, text, numeric, text, numeric, text, date, text, boolean, boolean
) to authenticated;

create or replace function public.staff_delete_product_supply_expense(p_expense_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exp public.product_supply_expenses;
  v_row public.product_supplies;
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

  delete from public.product_supply_expenses where id = p_expense_id;
  perform public.staff_recalculate_product_supply(v_exp.supply_id);
  return public.staff_product_supply_payload(v_exp.supply_id);
end;
$$;

revoke all on function public.staff_delete_product_supply_expense(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_delete_product_supply_expense(uuid)
  to authenticated;

create or replace function public.staff_close_product_supply(p_supply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_row public.product_supplies;
  v_item public.product_supply_items;
  v_exp public.product_supply_expenses;
  v_sum_gross numeric(18, 6);
  v_sum_exp numeric(18, 6);
  v_payload jsonb;
begin
  v_uid := public.staff_assert_product_supply_admin();
  v_row := public.staff_lock_product_supply(p_supply_id);
  perform public.staff_assert_product_supply_draft(v_row);

  perform public.staff_recalculate_product_supply(p_supply_id);

  select * into v_row
  from public.product_supplies as s
  where s.id = p_supply_id;

  if not exists (
    select 1 from public.product_supply_items as i where i.supply_id = p_supply_id
  ) then
    raise exception 'В поставке должна быть хотя бы одна позиция';
  end if;

  if v_row.gross_weight_kg is null or v_row.gross_weight_kg <= 0 then
    raise exception 'Укажите фактический брутто-вес поставки';
  end if;

  if v_row.default_currency <> 'KZT'
     and (v_row.default_exchange_rate_to_kzt is null
          or v_row.default_exchange_rate_to_kzt <= 0) then
    raise exception 'Укажите курс валюты закупки к тенге';
  end if;

  for v_item in
    select * from public.product_supply_items as i
    where i.supply_id = p_supply_id
  loop
    if v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'У всех позиций количество должно быть больше 0';
    end if;
    if v_item.purchase_price_per_unit is null then
      raise exception 'Укажите закупочную цену для всех позиций';
    end if;
    if v_item.unit_net_weight_kg is null or v_item.unit_net_weight_kg <= 0 then
      raise exception 'Укажите вес 1 единицы для всех позиций';
    end if;
    if v_item.purchase_currency <> 'KZT'
       and (v_item.exchange_rate_to_kzt is null or v_item.exchange_rate_to_kzt <= 0) then
      raise exception 'Укажите курс для позиций не в тенге';
    end if;
  end loop;

  for v_exp in
    select * from public.product_supply_expenses as e
    where e.supply_id = p_supply_id
  loop
    if v_exp.amount is null or v_exp.amount < 0 then
      raise exception 'Проверьте суммы расходов';
    end if;
    if v_exp.amount_kzt is null then
      raise exception 'Не удалось пересчитать расход «%» в тенге', v_exp.name;
    end if;
    if v_exp.currency <> 'KZT'
       and (v_exp.exchange_rate_to_kzt is null or v_exp.exchange_rate_to_kzt <= 0) then
      raise exception 'Укажите курс для расходов не в тенге';
    end if;
  end loop;

  if v_row.total_net_weight_kg is null or v_row.total_net_weight_kg <= 0 then
    raise exception 'Чистый вес поставки должен быть больше 0';
  end if;

  if v_row.gross_weight_kg < v_row.total_net_weight_kg then
    raise exception
      'Брутто-вес (% кг) меньше чистого веса товаров (% кг). Исправьте веса до закрытия.',
      v_row.gross_weight_kg,
      v_row.total_net_weight_kg;
  end if;

  select coalesce(sum(i.allocated_gross_weight_kg), 0)
  into v_sum_gross
  from public.product_supply_items as i
  where i.supply_id = p_supply_id;

  select coalesce(sum(i.allocated_expenses_kzt), 0)
  into v_sum_exp
  from public.product_supply_items as i
  where i.supply_id = p_supply_id;

  if abs(v_sum_gross - v_row.gross_weight_kg) > 0.000001 then
    raise exception 'Сумма распределённого брутто не совпадает с весом поставки';
  end if;

  if abs(v_sum_exp - coalesce(v_row.total_expenses_kzt, 0)) > 0.0001 then
    raise exception 'Сумма распределённых расходов не совпадает с итогами поставки';
  end if;

  update public.product_supplies as s
  set
    status = 'closed',
    closed_at = now(),
    closed_by = v_uid
  where s.id = p_supply_id;

  v_payload := public.staff_product_supply_payload(p_supply_id);

  update public.product_supplies as s
  set closed_snapshot = v_payload
  where s.id = p_supply_id;

  return v_payload;
end;
$$;

revoke all on function public.staff_close_product_supply(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_close_product_supply(uuid)
  to authenticated;

create or replace function public.staff_list_product_landed_costs(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform public.staff_assert_product_supply_admin();

  if p_product_id is null then
    raise exception 'id товара обязателен';
  end if;

  select coalesce(
    jsonb_agg(row_json order by sort_date desc, sequence_number desc),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      coalesce(s.closed_at, s.supply_date::timestamptz) as sort_date,
      s.sequence_number,
      jsonb_build_object(
        'supply_id', s.id,
        'supply_number', s.supply_number,
        'sequence_number', s.sequence_number,
        'title', s.title,
        'supply_date', s.supply_date,
        'status', s.status,
        'quantity', i.quantity,
        'unit', i.unit,
        'landed_cost_per_unit_kzt', i.landed_cost_per_unit_kzt,
        'is_preliminary', s.status = 'draft',
        'closed_at', s.closed_at
      ) as row_json
    from public.product_supply_items as i
    join public.product_supplies as s on s.id = i.supply_id
    where i.product_id = p_product_id
      and i.landed_cost_per_unit_kzt is not null
  ) as hist;

  return v_rows;
end;
$$;

revoke all on function public.staff_list_product_landed_costs(uuid)
  from public, anon, authenticated;
grant execute on function public.staff_list_product_landed_costs(uuid)
  to authenticated;
