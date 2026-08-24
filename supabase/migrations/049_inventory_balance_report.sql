-- ============================================================
-- 049_inventory_balance_report.sql
-- Staff Inventory Balance Report («Остатки»).
--
-- Read-only aggregating RPC for /staff/inventory.
-- Stock math: inventory.quantity / reserved_quantity @ ALMATY-01
--   available = greatest(quantity - reserved_quantity, 0)
-- Incoming: identical Stage 44 rules from staff_get_procurement_snapshot
--   receiving_status is distinct from 'completed'
--   logistics_status is distinct from 'draft'
--   qty = shipped_quantity → ordered_quantity → quantity
--
-- Does NOT change inventory writes, reservations, receiving, or
-- procurement recommendation formulas.
-- Does NOT modify migrations 001–048.
-- ============================================================

do $$
begin
  if to_regprocedure('public.staff_resolve_warehouse_id()') is null then
    raise exception 'staff_resolve_warehouse_id missing — run 011 first.';
  end if;
  if to_regprocedure('public.has_staff_role(public.user_role[])') is null then
    raise exception 'has_staff_role missing — run staff role migrations first.';
  end if;
  if to_regclass('public.inventory') is null then
    raise exception 'public.inventory missing — run 002 first.';
  end if;
  if to_regclass('public.product_supplies') is null then
    raise exception 'public.product_supplies missing — run 036 first.';
  end if;
  if to_regprocedure(
    'public.staff_procurement_logistics_label(public.product_supply_logistics_status)'
  ) is null then
    raise exception 'staff_procurement_logistics_label missing — run 044 first.';
  end if;
  if to_regprocedure('public.staff_factory_catalogs_json(uuid)') is null then
    raise exception 'staff_factory_catalogs_json missing — run 044 first.';
  end if;
end
$$;

-- ============================================================
-- 1. Role assert — read-only inventory balance report
-- ============================================================

create or replace function public.staff_assert_inventory_balance_reader()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Требуется авторизация';
  end if;
  if not public.has_staff_role(
    array['admin', 'manager', 'warehouse']::public.user_role[]
  ) then
    raise exception 'Отчёт по остаткам доступен администратору, менеджеру и складу';
  end if;
  return v_uid;
end;
$$;

revoke all on function public.staff_assert_inventory_balance_reader()
  from public, anon, authenticated;

comment on function public.staff_assert_inventory_balance_reader() is
  'Stage 49: admin + manager + warehouse may read inventory balance report.';

-- ============================================================
-- 2. staff_get_inventory_balance_report
-- One aggregating snapshot: stock + reserved + Stage 44 incoming
-- + categories + factory catalogs. No N+1. No document payloads.
-- ============================================================

create or replace function public.staff_get_inventory_balance_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_warehouse_id uuid;
  v_warehouse_code text;
  v_warehouse_name text;
  v_tz text := 'Asia/Almaty';
  v_products jsonb;
  v_catalogs jsonb;
  v_categories jsonb;
  v_summary jsonb;
begin
  perform public.staff_assert_inventory_balance_reader();

  v_warehouse_id := public.staff_resolve_warehouse_id();

  select w.code, w.name
  into v_warehouse_code, v_warehouse_name
  from public.warehouses as w
  where w.id = v_warehouse_id;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sort_order, x.name), '[]'::jsonb)
  into v_catalogs
  from (
    select id, name, color, description, is_active, sort_order
    from public.factory_catalogs
    where is_active
    order by sort_order, name
  ) as x;

  select coalesce(jsonb_agg(row_to_json(c)::jsonb order by c.sort_order, c.name), '[]'::jsonb)
  into v_categories
  from (
    select
      cat.id,
      cat.name,
      cat.parent_id,
      cat.sort_order,
      cat.is_active
    from public.categories as cat
    where cat.is_active
    order by cat.parent_id nulls first, cat.sort_order, cat.name
  ) as c;

  with stock as (
    select
      p.id as product_id,
      coalesce(i.quantity, 0)::numeric(14, 3) as physical_qty,
      coalesce(i.reserved_quantity, 0)::numeric(14, 3) as reserved_qty,
      greatest(
        coalesce(i.quantity, 0) - coalesce(i.reserved_quantity, 0),
        0
      )::numeric(14, 3) as available_qty
    from public.products as p
    left join public.inventory as i
      on i.product_id = p.id and i.warehouse_id = v_warehouse_id
    where p.status is distinct from 'archived'
  ),
  incoming as (
    select
      si.product_id,
      coalesce(sum(
        case
          when si.shipped_quantity is not null then si.shipped_quantity
          when si.ordered_quantity is not null then si.ordered_quantity
          else si.quantity
        end
      ), 0)::numeric(14, 3) as incoming_qty,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'supply_id', s.id,
            'supply_number', s.supply_number,
            'logistics_status', s.logistics_status,
            'receiving_status', s.receiving_status,
            'supply_date', s.supply_date,
            'quantity',
              case
                when si.shipped_quantity is not null then si.shipped_quantity
                when si.ordered_quantity is not null then si.ordered_quantity
                else si.quantity
              end,
            'label',
              public.staff_procurement_logistics_label(s.logistics_status)
          )
          order by s.supply_date desc, s.supply_number
        ),
        '[]'::jsonb
      ) as incoming_breakdown
    from public.product_supply_items as si
    join public.product_supplies as s on s.id = si.supply_id
    where s.receiving_status is distinct from 'completed'
      and s.logistics_status is distinct from 'draft'
    group by si.product_id
  ),
  catalog_map as (
    select
      m.product_id,
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'color', c.color,
          'is_active', c.is_active,
          'sort_order', c.sort_order
        )
        order by c.sort_order, c.name
      ) as catalogs
    from public.product_factory_catalogs as m
    join public.factory_catalogs as c on c.id = m.factory_catalog_id
    where c.is_active
    group by m.product_id
  ),
  rows as (
    select
      p.id as product_id,
      p.sku,
      p.original_sku,
      p.name,
      p.dimensions,
      p.unit,
      p.weight_kg,
      p.status,
      parent.id as category_id,
      parent.name as category_name,
      coalesce(parent.sort_order, 2147483647) as category_sort_order,
      sub.id as subcategory_id,
      sub.name as subcategory_name,
      coalesce(sub.sort_order, 2147483647) as subcategory_sort_order,
      st.physical_qty,
      st.reserved_qty,
      st.available_qty,
      coalesce(inc.incoming_qty, 0)::numeric(14, 3) as incoming_qty,
      (st.available_qty + coalesce(inc.incoming_qty, 0))::numeric(14, 3)
        as expected_available_qty,
      coalesce(inc.incoming_breakdown, '[]'::jsonb) as incoming_breakdown,
      coalesce(cm.catalogs, '[]'::jsonb) as catalogs
    from public.products as p
    join stock as st on st.product_id = p.id
    left join public.categories as parent on parent.id = p.category_id
    left join public.categories as sub on sub.id = p.subcategory_id
    left join incoming as inc on inc.product_id = p.id
    left join catalog_map as cm on cm.product_id = p.id
    where p.status is distinct from 'archived'
  ),
  packed as (
    select
      coalesce(
        jsonb_agg(
          row_to_json(r)::jsonb
          order by
            r.category_sort_order,
            r.category_name nulls last,
            r.subcategory_sort_order,
            r.subcategory_name nulls last,
            r.name,
            r.sku,
            r.product_id
        ),
        '[]'::jsonb
      ) as products,
      jsonb_build_object(
        'total_sku', coalesce(count(*), 0),
        'in_stock_sku', coalesce(count(*) filter (where r.available_qty > 0), 0),
        'out_of_stock_sku', coalesce(count(*) filter (where r.available_qty <= 0), 0),
        'reserved_units', coalesce(sum(r.reserved_qty), 0),
        'incoming_units', coalesce(sum(r.incoming_qty), 0)
      ) as summary
    from rows as r
  )
  select products, summary
  into v_products, v_summary
  from packed;

  return jsonb_build_object(
    'generated_at', now(),
    'timezone', v_tz,
    'warehouse', jsonb_build_object(
      'id', v_warehouse_id,
      'code', v_warehouse_code,
      'name', v_warehouse_name
    ),
    'catalogs', coalesce(v_catalogs, '[]'::jsonb),
    'categories', coalesce(v_categories, '[]'::jsonb),
    'summary', coalesce(v_summary, jsonb_build_object(
      'total_sku', 0,
      'in_stock_sku', 0,
      'out_of_stock_sku', 0,
      'reserved_units', 0,
      'incoming_units', 0
    )),
    'products', coalesce(v_products, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.staff_get_inventory_balance_report()
  from public, anon, authenticated;
grant execute on function public.staff_get_inventory_balance_report()
  to authenticated;

comment on function public.staff_get_inventory_balance_report() is
  'Stage 49: inventory balance report (Остатки). Reads inventory @ ALMATY-01 '
  'and Stage 44 incoming rules. Admin + manager + warehouse. Read-only.';
