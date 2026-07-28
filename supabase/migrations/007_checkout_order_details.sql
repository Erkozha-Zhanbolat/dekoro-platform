-- DEKORO Platform V1
-- Migration: checkout order details (delivery + contact snapshot)
--
-- Depends on:
--   005_orders.sql (public.orders, public.order_items)
--   006_create_order_rpc.sql (public.create_order(jsonb, text))
--
-- Run this file once in the Supabase SQL Editor after 006
-- (see supabase/README.md). Not executed automatically, not applied by
-- this change — apply by hand when ready.
--
-- Purpose: the checkout form collects a fulfillment/delivery method and
-- per-order contact details (name/phone/email, plus delivery address and
-- comment where relevant), but public.create_order() currently only
-- accepts items + a free-form comment, so none of that is persisted. This
-- migration adds the missing columns to public.orders and extends
-- create_order() to accept, validate and store them.
--
-- Naming is deliberately generic ("delivery_type"/"delivery_address"/
-- "delivery_comment", not "fulfillment_type"/"pickup_comment") so the
-- same schema covers the current pickup/customer-transport checkout and a
-- future courier-delivery option without another rename migration.
-- The frontend is NOT changed by this migration: it still only ever sends
-- 'pickup' or 'customer_transport'. 'delivery' is accepted by the schema
-- and the RPC now, ready for a future UI, but is not reachable yet.
--
-- No service_role. RLS is not weakened — no new INSERT/UPDATE/DELETE grant
-- or policy is added for authenticated/anon; orders/order_items remain
-- writable only through this SECURITY DEFINER RPC, same as after 006.

-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.order_items') is null then
    raise exception
      'public.orders / public.order_items missing — run supabase/migrations/005_orders.sql first.';
  end if;

  -- Accepts the original 006 signature, an unreleased intermediate draft
  -- of this migration (jsonb + 6 text, using fulfillment_type/pickup_comment
  -- naming — dropped below if present), or this file's own final signature
  -- (safe re-run after it already replaced everything below) — otherwise
  -- re-applying 007 would fail its own guard the second time.
  if to_regprocedure('public.create_order(jsonb, text)') is null
     and to_regprocedure('public.create_order(jsonb, text, text, text, text, text, text)') is null
     and to_regprocedure('public.create_order(jsonb, text, text, text, text, text, text, text)') is null
  then
    raise exception
      'public.create_order(...) is missing — run supabase/migrations/006_create_order_rpc.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. New columns on public.orders
--
-- contact_name / contact_phone: required per-order contact snapshot
-- (independent of profiles.full_name/phone, which they default from in
-- the UI but may be overridden for a specific order).
-- contact_email: optional (the checkout form always has a value from
-- auth.users.email, but the column stays nullable per spec).
-- delivery_type: 'pickup' | 'customer_transport' | 'delivery'. Only the
-- first two are reachable from the current checkout UI; 'delivery' is
-- reserved for a future courier-delivery flow.
-- delivery_address: required only when delivery_type = 'delivery';
-- nullable and unused for pickup / customer_transport.
-- delivery_comment: optional free text (e.g. pickup/handover notes today,
-- courier instructions once delivery ships).
-- ============================================================

alter table public.orders
  add column if not exists contact_name text,
  add column if not exists contact_phone text,
  add column if not exists contact_email text,
  add column if not exists delivery_type text,
  add column if not exists delivery_address text,
  add column if not exists delivery_comment text;

-- Backfill any orders created before this migration (e.g. while
-- create_order() only accepted items + comment) so the NOT NULL
-- constraints below can be applied without failing. Placeholder values
-- are only ever used for pre-existing rows — new inserts always go
-- through the validation in create_order() and never hit these defaults.
update public.orders
set
  delivery_type = coalesce(delivery_type, 'pickup'),
  contact_name = coalesce(nullif(trim(contact_name), ''), 'Не указано'),
  contact_phone = coalesce(nullif(trim(contact_phone), ''), 'Не указано')
where delivery_type is null
   or contact_name is null
   or contact_phone is null;

alter table public.orders
  alter column contact_name set not null,
  alter column contact_phone set not null,
  alter column delivery_type set not null;

alter table public.orders drop constraint if exists orders_contact_name_not_blank;
alter table public.orders
  add constraint orders_contact_name_not_blank
  check (length(trim(contact_name)) > 0);

alter table public.orders drop constraint if exists orders_contact_name_length;
alter table public.orders
  add constraint orders_contact_name_length
  check (char_length(contact_name) <= 200);

alter table public.orders drop constraint if exists orders_contact_phone_not_blank;
alter table public.orders
  add constraint orders_contact_phone_not_blank
  check (length(trim(contact_phone)) > 0);

alter table public.orders drop constraint if exists orders_contact_phone_length;
alter table public.orders
  add constraint orders_contact_phone_length
  check (char_length(contact_phone) <= 50);

alter table public.orders drop constraint if exists orders_contact_email_not_blank;
alter table public.orders
  add constraint orders_contact_email_not_blank
  check (contact_email is null or length(trim(contact_email)) > 0);

alter table public.orders drop constraint if exists orders_contact_email_length;
alter table public.orders
  add constraint orders_contact_email_length
  check (contact_email is null or char_length(contact_email) <= 254);

alter table public.orders drop constraint if exists orders_delivery_type_check;
alter table public.orders
  add constraint orders_delivery_type_check
  check (delivery_type in ('pickup', 'customer_transport', 'delivery'));

alter table public.orders drop constraint if exists orders_delivery_address_length;
alter table public.orders
  add constraint orders_delivery_address_length
  check (delivery_address is null or char_length(delivery_address) <= 1000);

-- delivery_address is required (non-blank) only for delivery_type = 'delivery';
-- pickup / customer_transport may leave it null.
alter table public.orders drop constraint if exists orders_delivery_address_required_for_delivery;
alter table public.orders
  add constraint orders_delivery_address_required_for_delivery
  check (
    delivery_type <> 'delivery'
    or (delivery_address is not null and length(trim(delivery_address)) > 0)
  );

alter table public.orders drop constraint if exists orders_delivery_comment_length;
alter table public.orders
  add constraint orders_delivery_comment_length
  check (delivery_comment is null or char_length(delivery_comment) <= 2000);

-- ============================================================
-- 2. create_order(): new signature
--
-- Postgres requires parameters without a default to precede parameters
-- with a default, so the new required arguments (p_delivery_type,
-- p_contact_name, p_contact_phone) are inserted right after p_items, and
-- all optional arguments (existing p_comment, new p_contact_email,
-- p_delivery_address, p_delivery_comment) stay at the end.
--
-- Both prior overloads are dropped by their exact signature first —
-- otherwise "create or replace" would add another separately-callable
-- overload with different required arguments, and an older call shape
-- would still silently succeed without full contact/delivery data.
-- create_order() must stay the single, unambiguous entry point:
--   - public.create_order(jsonb, text)
--       the original 006 shape (p_items, p_comment).
--   - public.create_order(jsonb, text, text, text, text, text, text)
--       an unreleased intermediate draft of this migration that used
--       p_fulfillment_type/p_pickup_comment naming — dropped here in case
--       it was ever applied before this rewrite.
-- ============================================================

drop function if exists public.create_order(jsonb, text);
drop function if exists public.create_order(jsonb, text, text, text, text, text, text);

create or replace function public.create_order(
  p_items jsonb,
  p_delivery_type text,
  p_contact_name text,
  p_contact_phone text,
  p_comment text default null,
  p_contact_email text default null,
  p_delivery_address text default null,
  p_delivery_comment text default null
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
  v_contact_name text := nullif(trim(p_contact_name), '');
  v_contact_phone text := nullif(trim(p_contact_phone), '');
  v_contact_email text := nullif(trim(p_contact_email), '');
  v_delivery_address text := nullif(trim(p_delivery_address), '');
  v_delivery_comment text := nullif(trim(p_delivery_comment), '');
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

  -- --- delivery + contact validation -----------------------------------
  -- delivery_type covers today's checkout ('pickup', 'customer_transport')
  -- plus 'delivery', reserved for a future courier-delivery UI.
  if p_delivery_type is null or p_delivery_type not in ('pickup', 'customer_transport', 'delivery') then
    raise exception 'Некорректный способ получения заказа';
  end if;

  if v_contact_name is null then
    raise exception 'Укажите контактное лицо';
  end if;

  if char_length(v_contact_name) > 200 then
    raise exception 'Имя контактного лица слишком длинное (максимум 200 символов)';
  end if;

  if v_contact_phone is null then
    raise exception 'Укажите телефон для связи';
  end if;

  if char_length(v_contact_phone) > 50 then
    raise exception 'Телефон слишком длинный (максимум 50 символов)';
  end if;

  if v_contact_email is not null and char_length(v_contact_email) > 254 then
    raise exception 'Email слишком длинный (максимум 254 символа)';
  end if;

  if p_delivery_type = 'delivery' and v_delivery_address is null then
    raise exception 'Укажите адрес доставки';
  end if;

  if v_delivery_address is not null and char_length(v_delivery_address) > 1000 then
    raise exception 'Адрес доставки слишком длинный (максимум 1000 символов)';
  end if;

  if v_delivery_comment is not null and char_length(v_delivery_comment) > 2000 then
    raise exception 'Комментарий к доставке слишком длинный (максимум 2000 символов)';
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
    comment,
    delivery_type,
    contact_name,
    contact_phone,
    contact_email,
    delivery_address,
    delivery_comment
  ) values (
    v_user_id,
    v_user_id, -- profiles.id == auth.users.id
    v_company_id,
    'new',
    v_subtotal,
    v_discount,
    v_total,
    v_comment,
    p_delivery_type,
    v_contact_name,
    v_contact_phone,
    v_contact_email,
    v_delivery_address,
    v_delivery_comment
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

revoke all on function public.create_order(jsonb, text, text, text, text, text, text, text) from public;
grant execute on function public.create_order(jsonb, text, text, text, text, text, text, text) to authenticated;

-- ============================================================
-- 3. Notes
--
-- - Any RAISE inside this function aborts the whole transaction: neither
--   the orders row nor any order_items rows are committed.
-- - Duplicate product_id values in p_items are still aggregated before
--   insert (unchanged from 006).
-- - Stock is still NOT checked and NOT reserved; status 'new' awaits
--   manager confirmation in V1 (unchanged from 006).
-- - Clients still cannot INSERT into orders/order_items directly — no RLS
--   policy or grant is added for that; create_order() remains the only
--   entry point (unchanged from 006).
-- - No service_role used anywhere in this migration.
-- - 'delivery' is a valid delivery_type at the schema/RPC level but is not
--   reachable from the current checkout UI (unchanged by this migration).
-- ============================================================
