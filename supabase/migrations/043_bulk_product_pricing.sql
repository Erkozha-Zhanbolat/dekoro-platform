-- DEKORO Platform — Stage 42 (follow-up): bulk product pricing
-- Migration: multi-product retail price + quantity tier bulk update
--
-- NOT applied automatically — run once in Supabase SQL Editor when ready.
-- Does NOT modify migrations 001–042 (042_remove_legacy_price_groups.sql is
-- already applied and is treated as immutable — this is a brand-new file).
--
-- Purpose: /staff/settings/pricing currently only lets an admin edit one
-- product's retail price or quantity tiers at a time. This migration adds
-- one atomic, admin-only RPC so a whole filtered/selected set of products
-- can have their retail price and/or quantity tiers updated in a single
-- transaction — WITHOUT touching:
--   - customer_product_prices (individual customer prices, 028) — never
--     read or written by this migration;
--   - order_items snapshots (unit_price/list_price/auto_price/... , 041) —
--     never read or written by this migration, exactly like every other
--     admin pricing RPC (see 041 section 20 "Snapshots" note);
--   - price_groups / product_prices / company_product_prices — Stage 42
--     already removed these from the runtime resolution path; this
--     migration does not resurrect them.
--
-- Safe to re-run: both functions below are CREATE OR REPLACE with an
-- unchanged/new signature (no DROP FUNCTION needed — see guard checks).
--
-- ============================================================
-- 0. Guards
-- ============================================================

do $$
begin
  if to_regclass('public.products') is null
     or to_regclass('public.product_quantity_prices') is null
  then
    raise exception
      'public.products / product_quantity_prices missing — run 002_catalog_inventory_pricing.sql and 041_order_pricing_engine.sql first.';
  end if;

  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'public.has_staff_role(...) missing — run 010_staff_role_access.sql first.';
  end if;

  if to_regprocedure('public.staff_escape_ilike_term(text)') is null then
    raise exception 'public.staff_escape_ilike_term(text) missing — run an earlier migration first.';
  end if;

  if to_regprocedure('public.admin_list_product_pricing_overview(text, uuid, integer, integer)') is null then
    raise exception
      'public.admin_list_product_pricing_overview(...) missing — run 042_remove_legacy_price_groups.sql first.';
  end if;
end
$$;

-- ============================================================
-- 1. admin_list_product_pricing_ids() — "select all N found" support
--
-- Same filter (query/category) as admin_list_product_pricing_overview(),
-- but returns only product_id, uncapped by the 200-row page-size limit of
-- that function (still capped at a generous ceiling to bound one request).
-- Lets the /staff/settings/pricing UI (a) show an exact "Найдено N товаров"
-- count for the current filter and (b) build the id list for "Выбрать все
-- N найденных товаров" without guessing at what the admin currently sees
-- on-screen (ТЗ §4).
-- ============================================================

create or replace function public.admin_list_product_pricing_ids(
  p_query text default null,
  p_category_id uuid default null,
  p_limit integer default 2000
)
returns setof uuid
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_term text;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 2000), 1), 2000);
  v_term := nullif(trim(p_query), '');
  if v_term is not null then
    v_term := public.staff_escape_ilike_term(v_term);
  end if;

  return query
  select p.id
  from public.products as p
  where (p_category_id is null or p.category_id = p_category_id)
    and (
      v_term is null
      or p.name ilike ('%' || v_term || '%') escape '\'
      or p.sku ilike ('%' || v_term || '%') escape '\'
    )
  order by p.name
  limit v_limit;
end;
$$;

comment on function public.admin_list_product_pricing_ids(text, uuid, integer) is
  'Stage 42 follow-up: admin-only — all product_ids matching the /staff/settings/pricing '
  'filter (same predicate as admin_list_product_pricing_overview), capped at 2000, for the '
  '"select all N found" bulk-pricing flow. Does not return pricing data itself.';

revoke all on function public.admin_list_product_pricing_ids(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_product_pricing_ids(text, uuid, integer)
  to authenticated;

-- ============================================================
-- 2. admin_bulk_update_product_pricing() — the atomic bulk RPC
--
-- Admin-only. Runs as a single function invocation, so Postgres already
-- gives it all-or-nothing semantics (any raised exception aborts the
-- entire call — see ТЗ §11/§20-G); every payload field is fully validated
-- BEFORE any UPDATE/INSERT/DELETE is issued, so a bad product id or a bad
-- tier never leaves a partially-applied bulk update even in principle.
--
-- Base price: p_update_base = false (default) means "leave base_price
-- untouched" — this is NOT the same as passing 0. p_base_price is only
-- read/validated when p_update_base is true.
--
-- Tiers: p_tiers is either null/empty (no tier change at all) or a JSON
-- array of {"min_quantity": int > 0, "price": numeric >= 0} objects, no
-- duplicate min_quantity within the payload. p_tier_mode controls how the
-- payload interacts with each product's EXISTING tiers:
--   - 'merge'   (default) — upsert each payload tier by (product_id,
--     min_quantity); every other existing tier for that product is left
--     untouched. This is the safe default (ТЗ §7).
--   - 'replace' — deletes ALL existing tiers for every selected product
--     first, then inserts exactly the payload tiers. Destructive by
--     design — the frontend must get explicit admin confirmation before
--     calling with this mode (ТЗ §7, "requires additional confirmation").
--
-- Never touches customer_product_prices or order_items — see file header.
-- ============================================================

create or replace function public.admin_bulk_update_product_pricing(
  p_product_ids uuid[],
  p_update_base boolean default false,
  p_base_price numeric default null,
  p_tiers jsonb default null,
  p_tier_mode text default 'merge'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_ids uuid[];
  v_product_count integer;
  v_missing integer;
  v_base_price numeric(14, 2);
  v_tier_mode text := lower(coalesce(nullif(trim(p_tier_mode), ''), 'merge'));
  v_tiers jsonb := coalesce(p_tiers, '[]'::jsonb);
  v_tier_count integer;
  v_has_tiers boolean;
  v_tier_item jsonb;
  v_min_qty integer;
  v_price numeric(14, 2);
  v_distinct_count integer;
  v_base_updated boolean := false;
  v_tier_rows_written integer := 0;
begin
  if not public.has_staff_role(array['admin']::public.user_role[]) then
    raise exception 'Недостаточно прав';
  end if;

  -- --- product_ids ------------------------------------------------------
  if p_product_ids is null or cardinality(p_product_ids) = 0 then
    raise exception 'Не указаны товары';
  end if;

  select coalesce(array_agg(distinct pid), array[]::uuid[])
  into v_product_ids
  from unnest(p_product_ids) as pid
  where pid is not null;

  v_product_count := cardinality(v_product_ids);

  if v_product_count = 0 then
    raise exception 'Не указаны товары';
  end if;

  if v_product_count > 500 then
    raise exception 'Слишком много товаров (максимум 500 за один запрос)';
  end if;

  select count(*) into v_missing
  from unnest(v_product_ids) as pid
  where not exists (select 1 from public.products as p where p.id = pid);

  if v_missing > 0 then
    raise exception 'Один или несколько товаров не найдены';
  end if;

  -- --- base price ---------------------------------------------------------
  if p_update_base then
    if p_base_price is null or p_base_price = 'NaN'::numeric or p_base_price < 0 then
      raise exception 'Розничная цена должна быть неотрицательным числом';
    end if;
    v_base_price := round(p_base_price, 2);
  end if;

  -- --- tiers: validate the whole payload before writing anything ----------
  if v_tier_mode not in ('merge', 'replace') then
    raise exception 'Некорректный режим применения уровней количества: %', v_tier_mode;
  end if;

  if jsonb_typeof(v_tiers) <> 'array' then
    raise exception 'tiers должен быть JSON-массивом';
  end if;

  v_tier_count := jsonb_array_length(v_tiers);
  v_has_tiers := v_tier_count > 0;

  if v_tier_count > 100 then
    raise exception 'Слишком много уровней количества за один запрос (максимум 100)';
  end if;

  if v_has_tiers then
    for v_tier_item in select * from jsonb_array_elements(v_tiers)
    loop
      if jsonb_typeof(v_tier_item) <> 'object' then
        raise exception 'Некорректный элемент в списке уровней количества';
      end if;

      begin
        v_min_qty := (v_tier_item ->> 'min_quantity')::integer;
      exception
        when others then
          raise exception 'Некорректное значение «от» в уровне количества';
      end;

      if v_min_qty is null or v_min_qty <= 0 then
        raise exception 'Количество «от» должно быть положительным целым числом';
      end if;

      begin
        v_price := (v_tier_item ->> 'price')::numeric;
      exception
        when others then
          raise exception 'Некорректная цена в уровне количества';
      end;

      if v_price is null or v_price = 'NaN'::numeric or v_price < 0 then
        raise exception 'Цена уровня количества должна быть неотрицательным числом';
      end if;
    end loop;

    select count(distinct (t ->> 'min_quantity')::integer)
    into v_distinct_count
    from jsonb_array_elements(v_tiers) as t;

    if v_distinct_count <> v_tier_count then
      raise exception 'В списке уровней количества не должно быть повторяющихся значений «от»';
    end if;
  end if;

  if not p_update_base and not v_has_tiers then
    raise exception 'Не указано ни одного изменения — включите розничную цену или добавьте уровни количества';
  end if;

  -- --- apply: base price (products.base_price only — never customer/order
  -- pricing tables) ---------------------------------------------------------
  if p_update_base then
    update public.products as p
    set base_price = v_base_price
    where p.id = any (v_product_ids);
    v_base_updated := true;
  end if;

  -- --- apply: quantity tiers ------------------------------------------------
  if v_has_tiers then
    if v_tier_mode = 'replace' then
      delete from public.product_quantity_prices as t
      where t.product_id = any (v_product_ids);
    end if;

    insert into public.product_quantity_prices (product_id, min_quantity, price)
    select pid, (t ->> 'min_quantity')::integer, round((t ->> 'price')::numeric, 2)
    from unnest(v_product_ids) as pid
    cross join jsonb_array_elements(v_tiers) as t
    on conflict (product_id, min_quantity)
    do update set price = excluded.price;

    get diagnostics v_tier_rows_written = row_count;
  end if;

  return jsonb_build_object(
    'updated_products', v_product_count,
    'base_price_changed', v_base_updated,
    'base_price', v_base_price,
    'tiers_changed', v_has_tiers,
    'tier_mode', case when v_has_tiers then v_tier_mode else null end,
    'tiers_count', v_tier_count,
    'tier_rows_written', v_tier_rows_written
  );
end;
$$;

comment on function public.admin_bulk_update_product_pricing(uuid[], boolean, numeric, jsonb, text) is
  'Admin-only atomic bulk update of retail price and/or quantity tiers for many products at '
  'once. Never touches customer_product_prices (individual prices) or order_items (historical '
  'snapshots). tier_mode: merge (default, upsert by min_quantity, other tiers kept) | replace '
  '(deletes all existing tiers for the selected products first — destructive, frontend must '
  'confirm explicitly before calling with this mode).';

revoke all on function public.admin_bulk_update_product_pricing(uuid[], boolean, numeric, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.admin_bulk_update_product_pricing(uuid[], boolean, numeric, jsonb, text)
  to authenticated;

-- ============================================================
-- 3. Notes
--
-- - Individual customer prices (customer_product_prices, 028): untouched —
--   this migration adds no statement that reads or writes that table.
--   Example from ТЗ §14 (customer ABC has an individual price of 8 900):
--   a bulk retail/tier change here leaves that row exactly as it was; the
--   next order for ABC still goes through resolve_order_item_price()
--   (041), which keeps comparing individual vs. tier and picks whichever
--   is more favorable — no change needed there, it was already generic.
-- - Existing orders: order_items snapshot columns (unit_price, list_price,
--   auto_price, quantity_tier_min_quantity, ...) are populated once, at
--   order-creation/price-override time (041), and this migration contains
--   no UPDATE against public.order_items — old invoices/PDFs stay exactly
--   as they were (same guarantee 041 section 20 already documents for
--   every other pricing-table change).
-- - Audit trail: no admin/staff activity log independent of a specific
--   order currently exists in this schema — public.order_activity_log
--   (012) requires a non-null order_id, public.staff_user_activity (024)
--   is constrained to staff-account-management event types, and
--   public.data_lifecycle_activity (027) is scoped to data
--   archive/retention actions. None is a semantically correct home for a
--   "bulk product pricing changed" event, and adding a new generic audit
--   table is a bigger decision than this migration's scope — flagged in
--   the chat report instead of solved here, per instructions not to grow
--   scope.
-- ============================================================
