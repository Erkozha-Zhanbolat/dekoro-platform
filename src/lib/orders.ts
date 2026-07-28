import { supabase } from "@/lib/supabase/client";
import type { CreateOrderInput, CreateOrderResult } from "@/types/database";

/**
 * Creates an order via public.create_order() — the only server-side entry
 * point for order creation (supabase/migrations/006_create_order_rpc.sql).
 *
 * Only product_id/quantity and an optional comment are ever sent. Prices,
 * subtotal, discount and total are resolved and computed server-side; the
 * client never supplies or derives money figures here.
 *
 * No UI — data access only.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const comment = input.comment?.trim();

  const { data, error } = await supabase.rpc("create_order", {
    p_items: input.items,
    p_comment: comment ? comment : null,
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
