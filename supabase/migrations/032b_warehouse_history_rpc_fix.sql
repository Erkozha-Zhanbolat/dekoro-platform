-- ============================================================
-- 032b_warehouse_history_rpc_fix.sql
-- Patch after 032 is already applied.
--
-- NOT applied by this change — apply by hand when ready.
-- Does NOT modify 001–032 files.
-- No CASCADE. Same function signature — CREATE OR REPLACE only.
--
-- Symptom: PostgreSQL 42804
--   structure of query does not match function result type
-- on /staff/warehouse/history
--
-- Broken function: public.staff_list_warehouse_shipment_history
-- Column 6: total_quantity
--   RETURNS TABLE declared numeric
--   SELECT produced bigint
--   because public.order_items.quantity is integer (005)
--   and sum(integer) → bigint; coalesce(..., 0) stays bigint.
--
-- staff_get_warehouse_shipment_history_order returns jsonb and is fine.
-- ============================================================

do $$
begin
  if to_regprocedure(
    'public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer)'
  ) is null then
    raise exception
      'staff_list_warehouse_shipment_history missing — apply 032_warehouse_permissions_and_history.sql first.';
  end if;
end
$$;

create or replace function public.staff_list_warehouse_shipment_history(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  order_id uuid,
  order_number text,
  customer_display_name text,
  shipped_at timestamptz,
  line_count integer,
  total_quantity numeric,
  picked_by_name text,
  shipped_by_name text,
  status text,
  total_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_offset integer;
  v_search text;
begin
  perform public.staff_assert_warehouse_history_role();

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'Некорректный период: дата начала позже даты окончания';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  v_search := nullif(trim(coalesce(p_search, '')), '');
  if v_search is not null then
    v_search := public.staff_escape_ilike_term(v_search);
  end if;

  return query
  with shipped_events as (
    select
      a.order_id,
      a.created_at as shipped_at,
      a.created_by as shipped_by,
      row_number() over (
        partition by a.order_id
        order by a.created_at desc, a.id desc
      ) as rn
    from public.order_warehouse_activity as a
    where a.event_type = 'order_shipped'
    union all
    select
      h.order_id,
      h.created_at,
      h.changed_by,
      row_number() over (
        partition by h.order_id
        order by h.created_at desc, h.id desc
      )
    from public.order_status_history as h
    where h.to_status = 'shipped'
      and not exists (
        select 1
        from public.order_warehouse_activity as a
        where a.order_id = h.order_id
          and a.event_type = 'order_shipped'
      )
  ),
  shipped as (
    select
      e.order_id,
      e.shipped_at,
      e.shipped_by
    from shipped_events as e
    where e.rn = 1
  ),
  filtered as (
    select
      o.id as order_id,
      o.order_number,
      coalesce(c.display_name, o.contact_name) as customer_display_name,
      s.shipped_at,
      coalesce(item_stats.line_count, 0)::integer as line_count,
      coalesce(item_stats.total_quantity, 0)::numeric as total_quantity,
      picker.full_name as picked_by_name,
      shipper.full_name as shipped_by_name,
      o.status,
      count(*) over ()::integer as total_count
    from shipped as s
    join public.orders as o on o.id = s.order_id
    left join public.customers as c on c.id = o.customer_id
    left join public.order_picking_tasks as t on t.order_id = o.id
    left join public.profiles as picker on picker.id = t.assigned_to
    left join public.profiles as shipper on shipper.id = s.shipped_by
    left join lateral (
      select
        count(oi.id)::integer as line_count,
        coalesce(sum(oi.quantity), 0)::numeric as total_quantity
      from public.order_items as oi
      where oi.order_id = o.id
    ) as item_stats on true
    where (p_from is null or s.shipped_at >= p_from)
      and (p_to is null or s.shipped_at <= p_to)
      and (
        v_search is null
        or o.order_number ilike '%' || v_search || '%' escape '\'
        or o.contact_name ilike '%' || v_search || '%' escape '\'
        or coalesce(c.display_name, '') ilike '%' || v_search || '%' escape '\'
        or exists (
          select 1
          from public.order_items as oi
          where oi.order_id = o.id
            and (
              coalesce(oi.product_sku, '') ilike '%' || v_search || '%' escape '\'
              or oi.product_name ilike '%' || v_search || '%' escape '\'
            )
        )
      )
  )
  select
    f.order_id,
    f.order_number,
    f.customer_display_name,
    f.shipped_at,
    f.line_count,
    f.total_quantity,
    f.picked_by_name,
    f.shipped_by_name,
    f.status,
    f.total_count
  from filtered as f
  order by f.shipped_at desc, f.order_id desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer)
  to authenticated;

comment on function public.staff_list_warehouse_shipment_history(timestamptz, timestamptz, text, integer, integer) is
  'Warehouse/admin: paginated shipped-order history. total_quantity is numeric (sum of integer order_items.quantity). No financial fields.';
