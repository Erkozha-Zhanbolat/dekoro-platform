-- ============================================================
-- Functional test for 043_bulk_product_pricing.sql —
-- admin_bulk_update_product_pricing(), scenarios A–G (ТЗ Stage 42
-- follow-up §20). Run the WHOLE file at once in the Supabase SQL Editor
-- AFTER applying 043_bulk_product_pricing.sql.
--
-- Everything below runs inside one transaction ending in ROLLBACK — no
-- test product/customer/order, and no change to any real data, is ever
-- left behind, even if an assertion fails midway (a RAISE EXCEPTION
-- aborts the transaction exactly like ROLLBACK would).
--
-- Requires at least one active admin profile in public.profiles — it is
-- impersonated (via request.jwt.claim(s)) so has_staff_role('admin')
-- inside the RPC evaluates true. Calling as the raw postgres/service role
-- has no auth.uid() and the RPC would (correctly) reject that.
-- ============================================================

begin;

do $$
declare
  v_admin_id uuid;
  v_p1 uuid;
  v_p2 uuid;
  v_p3 uuid;
  v_customer_id uuid;
  v_order_id uuid;
  v_result jsonb;
  v_price numeric;
  v_min_qty integer;
  v_count integer;
  v_error_caught boolean := false;
begin
  -- --- best-effort cleanup of any stale run's fixtures ---------------------
  delete from public.order_items where product_sku like 'BULKTEST-%' or product_name like 'BULKTEST%';
  delete from public.orders where contact_name = 'BULKTEST contact';
  delete from public.customer_product_prices
    where customer_id in (select id from public.customers where display_name = 'BULKTEST customer');
  delete from public.customers where display_name = 'BULKTEST customer';
  delete from public.product_quantity_prices
    where product_id in (select id from public.products where sku like 'BULKTEST-%');
  delete from public.products where sku like 'BULKTEST-%';

  -- --- impersonate an admin ------------------------------------------------
  select id into v_admin_id from public.profiles where role = 'admin' and is_active limit 1;
  if v_admin_id is null then
    raise exception 'No active admin profile found in public.profiles — cannot run this test.';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text,
    true
  );

  if public.has_staff_role(array['admin']::public.user_role[]) is not true then
    raise exception 'Impersonation failed — has_staff_role(admin) still false for profile %', v_admin_id;
  end if;

  -- --- fixtures: 3 test products, retail 10000 / 11000 / 12000 ------------
  insert into public.products (name, slug, sku, base_price, status)
  values (
    'BULKTEST J01', 'bulktest-j01-' || gen_random_uuid(),
    'BULKTEST-J01-' || substr(gen_random_uuid()::text, 1, 8), 10000, 'active'
  ) returning id into v_p1;

  insert into public.products (name, slug, sku, base_price, status)
  values (
    'BULKTEST J02', 'bulktest-j02-' || gen_random_uuid(),
    'BULKTEST-J02-' || substr(gen_random_uuid()::text, 1, 8), 11000, 'active'
  ) returning id into v_p2;

  insert into public.products (name, slug, sku, base_price, status)
  values (
    'BULKTEST J03', 'bulktest-j03-' || gen_random_uuid(),
    'BULKTEST-J03-' || substr(gen_random_uuid()::text, 1, 8), 12000, 'active'
  ) returning id into v_p3;

  raise notice 'Fixtures created: p1=%, p2=%, p3=%', v_p1, v_p2, v_p3;

  -- ============================================================
  -- A — retail only: 10 000 / 11 000 / 12 000 -> all 9 900
  -- ============================================================
  v_result := public.admin_bulk_update_product_pricing(
    array[v_p1, v_p2, v_p3], true, 9900, null, 'merge'
  );

  select base_price into v_price from public.products where id = v_p1;
  if v_price <> 9900 then raise exception 'A failed: p1 base_price = %, expected 9900', v_price; end if;
  select base_price into v_price from public.products where id = v_p2;
  if v_price <> 9900 then raise exception 'A failed: p2 base_price = %, expected 9900', v_price; end if;
  select base_price into v_price from public.products where id = v_p3;
  if v_price <> 9900 then raise exception 'A failed: p3 base_price = %, expected 9900', v_price; end if;
  raise notice 'A PASSED: retail-only bulk update -> all three products = 9900';

  -- ============================================================
  -- B — tier only, merge: existing 10+=9500, 50+=9000; add 100+=8600
  -- ============================================================
  insert into public.product_quantity_prices (product_id, min_quantity, price)
  values (v_p1, 10, 9500), (v_p1, 50, 9000);

  v_result := public.admin_bulk_update_product_pricing(
    array[v_p1], false, null, '[{"min_quantity": 100, "price": 8600}]'::jsonb, 'merge'
  );

  select count(*) into v_count from public.product_quantity_prices where product_id = v_p1;
  if v_count <> 3 then raise exception 'B failed: expected 3 tiers for p1, got %', v_count; end if;

  select price into v_price from public.product_quantity_prices where product_id = v_p1 and min_quantity = 10;
  if v_price <> 9500 then raise exception 'B failed: 10+ tier changed to %, expected 9500', v_price; end if;
  select price into v_price from public.product_quantity_prices where product_id = v_p1 and min_quantity = 50;
  if v_price <> 9000 then raise exception 'B failed: 50+ tier changed to %, expected 9000', v_price; end if;
  select price into v_price from public.product_quantity_prices where product_id = v_p1 and min_quantity = 100;
  if v_price <> 8600 then raise exception 'B failed: 100+ tier = %, expected 8600', v_price; end if;
  raise notice 'B PASSED: merge added 100+ = 8600, kept 10+/50+ untouched';

  -- ============================================================
  -- C — update existing threshold via merge: 100+ 8800 -> 8600, no dup row
  -- ============================================================
  update public.product_quantity_prices set price = 8800 where product_id = v_p1 and min_quantity = 100;

  v_result := public.admin_bulk_update_product_pricing(
    array[v_p1], false, null, '[{"min_quantity": 100, "price": 8600}]'::jsonb, 'merge'
  );

  select count(*) into v_count from public.product_quantity_prices where product_id = v_p1 and min_quantity = 100;
  if v_count <> 1 then raise exception 'C failed: expected exactly 1 row for min_quantity=100, got %', v_count; end if;
  select price into v_price from public.product_quantity_prices where product_id = v_p1 and min_quantity = 100;
  if v_price <> 8600 then raise exception 'C failed: 100+ tier = %, expected 8600', v_price; end if;
  raise notice 'C PASSED: merge updated existing 100+ threshold to 8600, no duplicate row';

  -- ============================================================
  -- D — replace: 10+=9500, 50+=9000, 100+=8600 -> replace with only 100+=8600
  -- ============================================================
  v_result := public.admin_bulk_update_product_pricing(
    array[v_p1], false, null, '[{"min_quantity": 100, "price": 8600}]'::jsonb, 'replace'
  );

  select count(*) into v_count from public.product_quantity_prices where product_id = v_p1;
  if v_count <> 1 then raise exception 'D failed: expected exactly 1 tier row after replace, got %', v_count; end if;

  select min_quantity, price into v_min_qty, v_price from public.product_quantity_prices where product_id = v_p1;
  if v_min_qty <> 100 or v_price <> 8600 then
    raise exception 'D failed: remaining tier is %+/%, expected 100+/8600', v_min_qty, v_price;
  end if;
  raise notice 'D PASSED: replace left only 100+ = 8600 for p1 (10+/50+ removed)';

  -- ============================================================
  -- E — individual customer price preserved by bulk product pricing ops
  -- ============================================================
  -- public.customers_contact_required (013_customers_foundation.sql) needs
  -- at least one of phone / email / profile_id for customer_type =
  -- 'individual'. A synthetic email on the IANA-reserved "invalid" TLD
  -- (RFC 2606 — guaranteed never a real, resolvable address) satisfies it
  -- without using or resembling any real customer's contact data.
  insert into public.customers (customer_type, display_name, email)
  values ('individual', 'BULKTEST customer', 'bulktest@example.invalid')
  returning id into v_customer_id;

  insert into public.customer_product_prices (customer_id, product_id, price)
  values (v_customer_id, v_p1, 8900);

  v_result := public.admin_bulk_update_product_pricing(
    array[v_p1, v_p2, v_p3], true, 10500,
    '[{"min_quantity": 100, "price": 8600}]'::jsonb, 'merge'
  );

  select price into v_price from public.customer_product_prices
  where customer_id = v_customer_id and product_id = v_p1;
  if v_price <> 8900 then
    raise exception 'E failed: individual price changed to %, expected unchanged 8900', v_price;
  end if;
  raise notice 'E PASSED: individual customer price (8900) untouched by bulk product pricing';

  -- ============================================================
  -- F — historical order_items snapshot untouched by later bulk changes
  -- ============================================================
  insert into public.orders (
    customer_id, status, subtotal, discount, total,
    contact_name, contact_phone, delivery_type, is_test
  ) values (
    v_customer_id, 'new', 8600, 0, 8600,
    'BULKTEST contact', '+70000000000', 'pickup', true
  ) returning id into v_order_id;

  insert into public.order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, line_total)
  values (v_order_id, v_p1, 'BULKTEST J01 (snapshot)', 'BULKTEST-J01-SNAPSHOT', 1, 8600, 8600);

  v_result := public.admin_bulk_update_product_pricing(
    array[v_p1], true, 7000, '[{"min_quantity": 100, "price": 5000}]'::jsonb, 'replace'
  );

  select unit_price into v_price from public.order_items where order_id = v_order_id and product_id = v_p1;
  if v_price <> 8600 then
    raise exception 'F failed: historical order_items.unit_price changed to %, expected unchanged 8600', v_price;
  end if;
  raise notice 'F PASSED: historical order_items.unit_price (8600) untouched by later bulk changes';

  -- ============================================================
  -- G — transaction: one invalid product id in the payload aborts everything
  -- p2/p3 are 10500 at this point (from scenario E); nothing since then
  -- has touched them.
  -- ============================================================
  begin
    perform public.admin_bulk_update_product_pricing(
      array[v_p2, '00000000-0000-0000-0000-000000000000'::uuid],
      true, 1234, null, 'merge'
    );
    raise exception 'G failed: expected an exception for a nonexistent product id, none was raised';
  exception
    when others then
      if sqlerrm like 'G failed:%' then
        raise;
      end if;
      -- expected path: the RPC raised "товары не найдены" (or similar) — swallow it here.
      v_error_caught := true;
  end;

  if not v_error_caught then
    raise exception 'G failed: no exception was caught from the invalid bulk call';
  end if;

  select base_price into v_price from public.products where id = v_p2;
  if v_price <> 10500 then
    raise exception 'G failed: p2 base_price changed to % despite the batch failing (expected unchanged 10500)', v_price;
  end if;
  raise notice 'G PASSED: invalid product id in payload aborted the whole batch, p2 untouched (10500)';

  raise notice '=== All bulk pricing scenarios A-G PASSED ===';
end;
$$;

-- Nothing above is meant to persist — this is a functional test, not a
-- data migration. If you see "All bulk pricing scenarios A-G PASSED"
-- above with no earlier ERROR, the RPC behaves as specified.
rollback;
