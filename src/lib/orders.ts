import { supabase } from "@/lib/supabase/client";
import type {
  CreateOrderInput,
  CreateOrderResult,
  DeliveryType,
  OrderStatus,
} from "@/types/database";

/** Human-readable label for orders.delivery_type, shared by the list and detail pages. */
export const DELIVERY_TYPE_LABELS: Record<DeliveryType, string> = {
  pickup: "Самовывоз со склада DEKORO",
  customer_transport: "Забор транспортом клиента",
  delivery: "Доставка",
};

/** Trims a value and turns an empty/whitespace-only string into null. */
function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Creates an order via public.create_order() — the only server-side entry
 * point for order creation (supabase/migrations/007_checkout_order_details.sql).
 *
 * Only product_id/quantity, delivery details and contact info are ever
 * sent. Prices, subtotal, discount and total are resolved and computed
 * server-side; the client never supplies or derives money figures here.
 *
 * No UI — data access only.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const { data, error } = await supabase.rpc("create_order", {
    p_items: input.items,
    p_delivery_type: input.deliveryType,
    p_contact_name: input.contactName.trim(),
    p_contact_phone: input.contactPhone.trim(),
    p_comment: trimToNull(input.comment),
    p_contact_email: trimToNull(input.contactEmail),
    p_delivery_address: trimToNull(input.deliveryAddress),
    p_delivery_comment: trimToNull(input.deliveryComment),
  });

  if (error) {
    throw new Error(error.message || "Не удалось оформить заказ");
  }

  const [result] = (data as CreateOrderResult[] | null) ?? [];

  if (!result) {
    throw new Error("Не удалось оформить заказ");
  }

  return result;
}

/** Row shape returned by public.cancel_order(uuid). */
export type CancelOrderResult = {
  id: string;
  order_number: string;
  status: OrderStatus;
  updated_at: string;
};

/**
 * Cancels an order via public.cancel_order() — the only server-side entry
 * point for cancellation (supabase/migrations/009_cancel_order_release_reservation.sql).
 *
 * Only the order's own owner may call this, and only while status = 'new';
 * the RPC itself enforces both and releases the order's inventory
 * reservation atomically with the status change. No SQL/business logic is
 * duplicated here — this is a thin RPC wrapper, same shape as createOrder().
 *
 * No UI — data access only.
 */
export async function cancelOrder(orderId: string): Promise<CancelOrderResult> {
  const { data, error } = await supabase.rpc("cancel_order", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось отменить заказ");
  }

  const [result] = (data as CancelOrderResult[] | null) ?? [];

  if (!result) {
    throw new Error("Не удалось отменить заказ");
  }

  return result;
}

/** Row shape returned by the listOrders() select (own orders, RLS-scoped). */
type OrderListRow = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total: number;
  delivery_type: DeliveryType;
  contact_name: string;
  order_items: { quantity: number }[] | null;
};

/** Summary row for the /orders list — no pricing/line-item detail beyond counts. */
export type OrderListItem = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total: number;
  delivery_type: DeliveryType;
  contact_name: string;
  itemCount: number;
  totalQuantity: number;
};

/**
 * Lists the current authenticated user's own orders, newest first.
 *
 * Relies entirely on existing RLS (orders_select_own / order_items_select_own
 * from supabase/migrations/005_orders.sql — unchanged since) rather than a
 * new RPC: a plain select already only ever returns rows owned by
 * auth.uid(), for both public.orders and the embedded public.order_items.
 *
 * No UI — data access only.
 */
export async function listOrders(): Promise<OrderListItem[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, created_at, status, total, delivery_type, contact_name, order_items(quantity)",
    )
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить заказы");
  }

  const rows = (data as OrderListRow[] | null) ?? [];

  return rows.map((row) => {
    const items = row.order_items ?? [];
    return {
      id: row.id,
      order_number: row.order_number,
      created_at: row.created_at,
      status: row.status,
      total: Number(row.total),
      delivery_type: row.delivery_type,
      contact_name: row.contact_name,
      itemCount: items.length,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    };
  });
}

/** A single line item as shown on the order detail page. */
export type OrderDetailItem = {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total: number;
};

/** Full detail for a single order, as shown on /orders/[id]. */
export type OrderDetail = {
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
  items: OrderDetailItem[];
};

/** Row shape returned by the getOrder() select (own order, RLS-scoped). */
type OrderDetailRow = Omit<OrderDetail, "items"> & {
  order_items: OrderDetailItem[] | null;
};

/**
 * Loads a single order (with its line items) owned by the current
 * authenticated user, or null if it does not exist / does not belong to
 * them (RLS hides other users' orders the same way as a missing row).
 *
 * Relies entirely on existing RLS (orders_select_own / order_items_select_own
 * from supabase/migrations/005_orders.sql) rather than a new RPC.
 *
 * No UI — data access only.
 */
export async function getOrder(id: string): Promise<OrderDetail | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, created_at, status, subtotal, discount, total, comment, contact_name, contact_phone, contact_email, delivery_type, delivery_address, delivery_comment, order_items(id, product_id, product_name, quantity, unit_price, total:line_total)",
    )
    .eq("id", id)
    .single();

  if (error) {
    // PGRST116: .single() found no row (deleted / other user's order, hidden
    // by RLS). 22P02: id is not a valid uuid at all. Both mean "not found"
    // from this user's point of view, not a hard error.
    if (error.code === "PGRST116" || error.code === "22P02") {
      return null;
    }
    throw new Error(error.message || "Не удалось загрузить заказ");
  }

  const row = data as OrderDetailRow;
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
