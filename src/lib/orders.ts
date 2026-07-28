import { supabase } from "@/lib/supabase/client";
import type {
  CreateOrderInput,
  CreateOrderResult,
  DeliveryType,
  OrderStatus,
} from "@/types/database";

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
