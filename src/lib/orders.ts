import { supabase } from "@/lib/supabase/client";
import type { CreateOrderInput, CreateOrderResult } from "@/types/database";

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
