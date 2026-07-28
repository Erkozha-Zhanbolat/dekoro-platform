-- DEKORO Platform V1
-- Migration: create_order RPC (server-side order creation)
--
-- Depends on:
--   005_orders.sql (public.orders, public.order_items,
--     public.generate_order_number())
--   002_catalog_inventory_pricing.sql (public.products, public.get_product_price)
--   004_customer_types.sql (public.profiles.customer_type)
--
-- Run this file once in the Supabase SQL Editor after 005
-- (see supabase/README.md). Not executed automatically.
--
-- Purpose: one authenticated entry point for creating an order. The client
-- must NOT insert into public.orders / public.order_items directly and must
-- NOT send money figures. Prices are resolved server-side via
-- public.get_product_price(); subtotal/total/line_total are computed in SQL.
--
-- Stock: this RPC checks product status + price only. It does NOT verify
-- available inventory and does NOT reserve or decrement stock. Orders are
-- created with status 'new' for manual manager confirmation (V1).
--
-- No service_role. RLS stays enabled. No frontend / checkout changes here.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run supabase/migrations/005_orders.sql first.';
  end if;

  if to_regprocedure('public.get_product_price(uuid)') is null then
    raise exception
      'public.get_product_price(uuid) is missing — run supabase/migrations/002_catalog_inventory_pricing.sql first.';
  end if;

  if to_regprocedure('public.generate_order_number()') is null then
    raise exception
      'public.generate_order_number() is missing — run supabase/migrations/005_orders.sql first.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'customer_type'
  ) then
    raise exception
      'public.profiles.customer_type is missing — run supabase/migrations/004_customer_types.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. Close the direct-insert path for clients
--
-- After this migration, authenticated callers may still SELECT their own
-- orders/items (existing policies), but may no longer INSERT. Creation
-- goes only through public.create_order() below (SECURITY DEFINER).
-- Sequence / generate_order_number() are only needed by the definer path
-- (column DEFAULT during the RPC insert), so client grants from 005 are
-- revoked here.
-- ============================================================

revoke insert on public.orders from authenticated;
revoke insert on public.order_items from authenticated;

drop policy if exists orders_insert_own on public.orders;
drop policy if exists order_items_insert_own on public.order_items;

revoke execute on function public.generate_order_number() from authenticated;
revoke usage, select on sequence public.orders_order_number_seq from authenticated;

-- ============================================================
-- 2. create_order(p_items jsonb, p_comment text)
--
-- p_items: JSON array of { "product_id": "<uuid>", "quantity": <positive int> }
-- Duplicate product_id values are aggregated (quantities summed) into one
-- order_items row before pricing and insert.
--
-- Why SECURITY DEFINER:
--   - price tables (product_prices, company_product_prices) are not
--     readable by authenticated clients (by design);
--   - money fields must be written by the server, not the client;
--   - order + items must be inserted atomically as one unit.
-- The function still uses auth.uid() for ownership and never accepts
-- another user's id. search_path is locked to public, pg_temp. No
-- dynamic SQL / EXECUTE.
-- ============================================================

create or replace function public.create_order(
  p_items jsonb,
  p_comment text default null
)
returns table (
  id uuid,
  order_number text,
  total numeric,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_company_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_order_created_at timestamptz;
  v_subtotal numeric(14, 2) := 0;
  v_discount numeric(14, 2) := 0;
  v_total numeric(14, 2) := 0;
  v_comment text := nullif(trim(p_comment), '');
  v_item jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_quantity_raw text;
  v_existing_quantity integer;
  v_product public.products%rowtype;
  v_unit_price numeric(14, 2);
  v_line_total numeric(14, 2);
  v_line record;
begin
  -- --- auth + profile -------------------------------------------------
  if v_user_id is null then
    raise exception 'Требуется авторизация';
  end if;

  select * into v_profile
  from public.profiles as p
  where p.id = v_user_id;

  if not found then
    raise exception 'Профиль не найден';
  end if;

  if not v_profile.is_active then
    raise exception 'Профиль неактивен';
  end if;

  if v_profile.customer_type = 'individual' then
    v_company_id := null;
  elsif v_profile.customer_type = 'company' then
    if v_profile.company_id is null then
      raise exception 'У профиля компании отсутствует company_id';
    end if;

    if not exists (
      select 1 from public.companies as c where c.id = v_profile.company_id
    ) then
      raise exception 'Компания не найдена';
    end if;

    v_company_id := v_profile.company_id;
  else
    raise exception 'Неизвестный тип покупателя: %', v_profile.customer_type;
  end if;

  if v_comment is not null and char_length(v_comment) > 2000 then
    raise exception 'Комментарий слишком длинный (максимум 2000 символов)';
  end if;

  -- --- items payload --------------------------------------------------
  if p_items is null then
    raise exception 'Список товаров пуст';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Список товаров должен быть JSON-массивом';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'Список товаров пуст';
  end if;

  -- Normalized lines: one row per product_id (quantities aggregated).
  drop table if exists tmp_create_order_lines;
  create temporary table tmp_create_order_lines (
    product_id uuid primary key,
    product_name text,
    product_sku text,
    quantity integer not null check (quantity > 0),
    unit_price numeric(14, 2),
    line_total numeric(14, 2)
  ) on commit drop;

  for v_item in
    select value from jsonb_array_elements(p_items) as t(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Некорректный элемент заказа';
    end if;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception
      when others then
        raise exception 'Некорректный product_id';
    end;

    if v_product_id is null then
      raise exception 'product_id обязателен';
    end if;

    -- Accept only positive whole integers (reject null, 0, negatives, strings).
    v_quantity_raw := v_item ->> 'quantity';
    if v_quantity_raw is null or v_quantity_raw !~ '^[1-9][0-9]*$' then
      raise exception 'quantity должно быть положительным целым для товара %', v_product_id;
    end if;

    begin
      v_quantity := v_quantity_raw::integer;
    exception
      when others then
        raise exception 'Некорректное quantity для товара %', v_product_id;
    end;

    select l.quantity into v_existing_quantity
    from tmp_create_order_lines as l
    where l.product_id = v_product_id;

    if found then
      if v_existing_quantity > (2147483647 - v_quantity) then
        raise exception 'Слишком большое quantity для товара %', v_product_id;
      end if;

      update tmp_create_order_lines as l
      set quantity = l.quantity + v_quantity
      where l.product_id = v_product_id;
    else
      insert into tmp_create_order_lines (product_id, quantity)
      values (v_product_id, v_quantity);
    end if;
  end loop;

  if not exists (select 1 from tmp_create_order_lines) then
    raise exception 'Список товаров пуст';
  end if;

  -- Price + snapshot enrichment on the normalized set only.
  for v_line in
    select l.product_id, l.quantity
    from tmp_create_order_lines as l
  loop
    select * into v_product
    from public.products as p
    where p.id = v_line.product_id;

    if not found then
      raise exception 'Товар не найден: %', v_line.product_id;
    end if;

    -- products.status is the availability flag (draft | active | archived).
    if v_product.status is distinct from 'active' then
      raise exception 'Товар недоступен для заказа: %', v_line.product_id;
    end if;

    -- Resolved caller price (personal / price group / base_price).
    -- Never read money fields from p_items.
    v_unit_price := public.get_product_price(v_line.product_id);

    if v_unit_price is null then
      raise exception 'Цена недоступна для товара: %', v_line.product_id;
    end if;

    -- Existing catalog constraints allow price >= 0 (including 0).
    -- Reject only negative values (should not occur under those CHECKs).
    if v_unit_price < 0 then
      raise exception 'Некорректная цена для товара: %', v_line.product_id;
    end if;

    v_line_total := round(v_unit_price * v_line.quantity, 2);

    update tmp_create_order_lines as l
    set
      product_name = v_product.name,
      product_sku = v_product.sku,
      unit_price = v_unit_price,
      line_total = v_line_total
    where l.product_id = v_line.product_id;

    v_subtotal := v_subtotal + v_line_total;
  end loop;

  v_discount := 0;
  v_total := v_subtotal - v_discount;

  -- --- persist (single function call = single transaction) ------------
  insert into public.orders as o (
    user_id,
    profile_id,
    company_id,
    status,
    subtotal,
    discount,
    total,
    comment
  ) values (
    v_user_id,
    v_user_id, -- profiles.id == auth.users.id
    v_company_id,
    'new',
    v_subtotal,
    v_discount,
    v_total,
    v_comment
  )
  returning
    o.id,
    o.order_number,
    o.created_at
  into
    v_order_id,
    v_order_number,
    v_order_created_at;

  insert into public.order_items (
    order_id,
    product_id,
    product_name,
    product_sku,
    quantity,
    unit_price,
    line_total
  )
  select
    v_order_id,
    l.product_id,
    l.product_name,
    l.product_sku,
    l.quantity,
    l.unit_price,
    l.line_total
  from tmp_create_order_lines as l;

  return query
  select
    v_order_id,
    v_order_number,
    v_total,
    v_order_created_at;
end;
$$;

revoke all on function public.create_order(jsonb, text) from public;
grant execute on function public.create_order(jsonb, text) to authenticated;

-- ============================================================
-- 3. Notes
--
-- - Any RAISE inside this function aborts the whole transaction: neither
--   the orders row nor any order_items rows are committed.
-- - Duplicate product_id values in p_items are aggregated before insert.
-- - Stock is NOT checked and NOT reserved; status 'new' awaits manager
--   confirmation in V1.
-- - Clients retain SELECT on their own orders/items via existing RLS
--   policies; they can no longer INSERT directly.
-- ============================================================
