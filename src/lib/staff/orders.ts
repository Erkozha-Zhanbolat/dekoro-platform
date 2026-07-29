import { supabase } from "@/lib/supabase/client";
import type {
  DeliveryType,
  OrderStatus,
  StaffCreateOrderResult,
  StaffOrderMutationResult,
} from "@/types/database";

/**
 * Staff-facing order data access
 * (supabase/migrations/010_staff_role_access.sql,
 * supabase/migrations/011_staff_manual_orders.sql).
 *
 * Deliberately separate from src/lib/orders.ts (client-facing, "own orders
 * only"): the read functions below rely on the orders_select_staff /
 * order_items_select_staff RLS policies, which only manager / accountant /
 * warehouse / admin profiles satisfy. A client account calling these gets
 * exactly the same rows src/lib/orders.ts would already give them (their
 * own), never more — the staff policies are additive, not a bypass.
 *
 * The mutation functions below (createStaffOrder / addStaffOrderItem /
 * updateStaffOrderItemQuantity / removeStaffOrderItem) go through the
 * SECURITY DEFINER RPCs added in 011_staff_manual_orders.sql, restricted to
 * manager/admin internally — there is still no direct
 * INSERT/UPDATE/DELETE grant on orders/order_items/inventory for staff.
 * Order status changes beyond manual creation (confirmation, invoicing,
 * picking/shipping, etc.) remain out of scope and unimplemented.
 */

/** Row shape shared by the dashboard's "recent orders" and the /staff/orders list. */
export type StaffOrderListItem = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total: number;
  delivery_type: DeliveryType;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  itemCount: number;
  totalQuantity: number;
};

type StaffOrderListRow = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total: number;
  delivery_type: DeliveryType;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  order_items: { quantity: number }[] | null;
};

function mapListRow(row: StaffOrderListRow): StaffOrderListItem {
  const items = row.order_items ?? [];
  return {
    id: row.id,
    order_number: row.order_number,
    created_at: row.created_at,
    status: row.status,
    total: Number(row.total),
    delivery_type: row.delivery_type,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    contact_email: row.contact_email,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

/** Escapes PostgREST ilike wildcards so a user's search text is matched literally. */
function escapeIlikeValue(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

export type StaffOrdersQuery = {
  /** Matches order_number / contact_name / contact_phone / contact_email (case-insensitive, partial). */
  search?: string;
  /** Omit or pass "all" for no status filter. */
  status?: OrderStatus | "all";
  /** Defaults to 100 — a plain limit for this step, not full pagination. */
  limit?: number;
};

const DEFAULT_STAFF_ORDERS_LIMIT = 100;

/**
 * Lists orders across ALL customers (RLS-scoped to staff roles), newest
 * first. One round trip: order_items is embedded, so item/quantity counts
 * never require a separate query per order.
 */
export async function getStaffOrders(
  query: StaffOrdersQuery = {},
): Promise<StaffOrderListItem[]> {
  let request = supabase
    .from("orders")
    .select(
      "id, order_number, created_at, status, total, delivery_type, contact_name, contact_phone, contact_email, order_items(quantity)",
    )
    .order("created_at", { ascending: false })
    .limit(query.limit ?? DEFAULT_STAFF_ORDERS_LIMIT);

  if (query.status && query.status !== "all") {
    request = request.eq("status", query.status);
  }

  const search = query.search?.trim();
  if (search) {
    const escaped = escapeIlikeValue(search);
    request = request.or(
      [
        `order_number.ilike.%${escaped}%`,
        `contact_name.ilike.%${escaped}%`,
        `contact_phone.ilike.%${escaped}%`,
        `contact_email.ilike.%${escaped}%`,
      ].join(","),
    );
  }

  const { data, error } = await request;

  if (error) {
    throw new Error(error.message || "Не удалось загрузить заказы");
  }

  const rows = (data as StaffOrderListRow[] | null) ?? [];
  return rows.map(mapListRow);
}

/** A single line item as shown on the staff order detail page. */
export type StaffOrderDetailItem = {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total: number;
};

/** Full detail for a single order, as shown on /staff/orders/[id]. */
export type StaffOrderDetail = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  comment: string | null;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  delivery_type: DeliveryType;
  delivery_address: string | null;
  delivery_comment: string | null;
  items: StaffOrderDetailItem[];
};

type StaffOrderDetailRow = Omit<StaffOrderDetail, "items"> & {
  order_items: StaffOrderDetailItem[] | null;
};

/**
 * Loads a single order (with its line items) for staff, regardless of
 * which customer it belongs to (RLS-scoped to staff roles). Returns null
 * if the order does not exist, or if the caller's role isn't allowed to
 * see it (both look identical from the caller's point of view, same as
 * src/lib/orders.ts#getOrder for clients).
 */
export async function getStaffOrderById(id: string): Promise<StaffOrderDetail | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, created_at, status, subtotal, discount, total, comment, contact_name, contact_phone, contact_email, delivery_type, delivery_address, delivery_comment, order_items(id, product_id, product_name, quantity, unit_price, total:line_total)",
    )
    .eq("id", id)
    .single();

  if (error) {
    // PGRST116: .single() found no row (deleted / RLS-hidden). 22P02: id is
    // not a valid uuid. Both mean "not found" from the caller's point of view.
    if (error.code === "PGRST116" || error.code === "22P02") {
      return null;
    }
    throw new Error(error.message || "Не удалось загрузить заказ");
  }

  const row = data as StaffOrderDetailRow;
  const items = row.order_items ?? [];

  return {
    id: row.id,
    order_number: row.order_number,
    created_at: row.created_at,
    status: row.status,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    total: Number(row.total),
    comment: row.comment,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    contact_email: row.contact_email,
    delivery_type: row.delivery_type,
    delivery_address: row.delivery_address,
    delivery_comment: row.delivery_comment,
    items: items.map((item) => ({
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
      total: Number(item.total),
    })),
  };
}

/** Order counts by current status, for the /staff dashboard cards. */
export type StaffOrderStats = Record<OrderStatus, number> & { total: number };

/**
 * Computes order counts by status in a single round trip (selects only the
 * `status` column for every order visible to this caller, then reduces in
 * memory) instead of one query per status or per order.
 */
export async function getStaffOrderStats(): Promise<StaffOrderStats> {
  const { data, error } = await supabase.from("orders").select("status");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить статистику заказов");
  }

  const rows = (data as { status: OrderStatus }[] | null) ?? [];

  const stats: StaffOrderStats = {
    total: rows.length,
    new: 0,
    processing: 0,
    completed: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    stats[row.status] += 1;
  }

  return stats;
}

/**
 * Creates an empty ('new', no items, no reservation) order for an existing
 * client profile via public.staff_create_order(). manager/admin only —
 * enforced inside the RPC, not by RLS. Returns the new order's id/number so
 * the caller can redirect to /staff/orders/[id].
 */
export async function createStaffOrder(
  clientProfileId: string,
): Promise<StaffCreateOrderResult> {
  const { data, error } = await supabase.rpc("staff_create_order", {
    p_client_profile_id: clientProfileId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось создать заказ");
  }

  const [result] = (data as StaffCreateOrderResult[] | null) ?? [];

  if (!result) {
    throw new Error("Не удалось создать заказ");
  }

  return result;
}

/**
 * Adds a product to a 'new' order via public.staff_add_order_item(),
 * increasing the existing line's quantity if the product is already on the
 * order. Reserves the added quantity and recalculates the order's totals
 * atomically server-side. Throws if the requested quantity exceeds the
 * currently available stock, or the order isn't in status 'new'.
 *
 * Returns the fresh order row; callers should still re-fetch the full
 * order (getStaffOrderById) for the up-to-date item list rather than
 * trying to patch state locally (no optimistic updates in this UI).
 */
export async function addStaffOrderItem(
  orderId: string,
  productId: string,
  quantity: number,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_add_order_item", {
    p_order_id: orderId,
    p_product_id: productId,
    p_quantity: quantity,
  });

  if (error) {
    throw new Error(error.message || "Не удалось добавить товар");
  }

  return data as StaffOrderMutationResult;
}

/**
 * Changes an order item's quantity via
 * public.staff_update_order_item_quantity(), adjusting the reservation by
 * exactly the difference (increase requires enough available stock;
 * decrease releases the difference). Order must be 'new'.
 */
export async function updateStaffOrderItemQuantity(
  orderItemId: string,
  quantity: number,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_update_order_item_quantity", {
    p_order_item_id: orderItemId,
    p_quantity: quantity,
  });

  if (error) {
    throw new Error(error.message || "Не удалось изменить количество");
  }

  return data as StaffOrderMutationResult;
}

/**
 * Removes an order item via public.staff_remove_order_item(), fully
 * releasing its reservation. Order must be 'new'.
 */
export async function removeStaffOrderItem(
  orderItemId: string,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_remove_order_item", {
    p_order_item_id: orderItemId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось удалить позицию");
  }

  return data as StaffOrderMutationResult;
}
