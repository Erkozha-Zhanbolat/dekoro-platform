import { supabase } from "@/lib/supabase/client";
import type { PriceSource } from "@/lib/pricing";

/**
 * Client-facing batch pricing preview — wraps public.get_cart_pricing()
 * (supabase/migrations/041_order_pricing_engine.sql). Used by the cart and
 * product page to show quantity-tier-aware prices for multiple lines in one
 * request. Anonymous callers get null pricing fields for every line (mirrors
 * get_product_price()'s own guest behaviour) — checkout still re-resolves
 * the authoritative price server-side via create_order(); this preview is
 * never trusted for the final charge.
 */

export type CartPricingItem = { productId: string; quantity: number };

export type CartPricingRow = {
  productId: string;
  quantity: number;
  listPrice: number | null;
  resolvedPrice: number | null;
  priceSource: PriceSource | null;
  quantityTierMinQuantity: number | null;
  nextTierMinQuantity: number | null;
  nextTierPrice: number | null;
};

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function getCartPricing(items: CartPricingItem[]): Promise<CartPricingRow[]> {
  if (items.length === 0) {
    return [];
  }

  const { data, error } = await supabase.rpc("get_cart_pricing", {
    p_items: items.map((item) => ({ product_id: item.productId, quantity: item.quantity })),
  });

  if (error) {
    throw new Error(error.message || "Не удалось рассчитать цены");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    productId: String(row.product_id),
    quantity: Number(row.quantity ?? 0),
    listPrice: asNullableNumber(row.list_price),
    resolvedPrice: asNullableNumber(row.resolved_price),
    priceSource: (row.price_source as PriceSource | null) ?? null,
    quantityTierMinQuantity: asNullableNumber(row.quantity_tier_min_quantity),
    nextTierMinQuantity: asNullableNumber(row.next_tier_min_quantity),
    nextTierPrice: asNullableNumber(row.next_tier_price),
  }));
}
