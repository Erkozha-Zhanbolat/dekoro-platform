/**
 * Pure pricing helpers for DEKORO Stage 41 — no external dependencies
 * (mirrors the style of ./vat.ts), so they can run in a plain Node script
 * for the self-check without needing Supabase env vars.
 *
 * The SQL functions in supabase/migrations/041_order_pricing_engine.sql
 * (public.resolve_order_item_price, public.get_cart_pricing) are the single
 * source of truth for the final price shown/charged to anyone — this file
 * never decides a price that gets sent back to the server. `resolveAutomaticPrice`
 * is a pure mirror of the SQL priority algorithm, used only for:
 *   - a deterministic self-check (pricing.selfcheck.ts) that documents the
 *     ТЗ §29 test cases without needing a live database;
 *   - discount/savings display math shared by customer + staff UI.
 * For the actual client-facing batch price RPC wrapper, see ./cartPricing.ts.
 */

export type PriceSource =
  | "base"
  | "price_group"
  | "individual"
  | "legacy_company"
  | "quantity_tier"
  | "manager_override";

export type AutomaticPriceInputs = {
  /** products.base_price. */
  basePrice: number | null;
  /** resolve_product_price() result — individual/legacy_company/price_group/base. */
  customerPrice: number | null;
  customerSource: Exclude<PriceSource, "quantity_tier" | "manager_override"> | null;
  /** pricing_resolve_quantity_tier() result for the requested quantity, if any. */
  tierPrice: number | null;
  tierMinQuantity: number | null;
};

export type AutomaticPriceResult = {
  listPrice: number | null;
  resolvedPrice: number | null;
  resolvedSource: PriceSource | null;
  tierMinQuantity: number | null;
};

/**
 * Pure mirror of public.resolve_order_item_price()'s decision (ТЗ §7):
 * the customer gets whichever of "customer condition" / "quantity tier" is
 * strictly more favorable; a tier only wins on a strict `<` comparison.
 */
export function resolveAutomaticPrice(inputs: AutomaticPriceInputs): AutomaticPriceResult {
  const { basePrice, customerPrice, customerSource, tierPrice, tierMinQuantity } = inputs;

  if (tierPrice !== null && customerPrice !== null && tierPrice < customerPrice) {
    return {
      listPrice: basePrice,
      resolvedPrice: tierPrice,
      resolvedSource: "quantity_tier",
      tierMinQuantity,
    };
  }

  if (customerPrice !== null) {
    return {
      listPrice: basePrice,
      resolvedPrice: customerPrice,
      resolvedSource: customerSource,
      tierMinQuantity: null,
    };
  }

  if (tierPrice !== null) {
    return {
      listPrice: basePrice,
      resolvedPrice: tierPrice,
      resolvedSource: "quantity_tier",
      tierMinQuantity,
    };
  }

  return { listPrice: basePrice, resolvedPrice: null, resolvedSource: null, tierMinQuantity: null };
}

/** Discount percent of `price` below `listPrice`, rounded, or null if not cheaper. */
export function computeDiscountPercent(listPrice: number | null, price: number | null): number | null {
  if (listPrice == null || price == null || listPrice <= 0 || price >= listPrice) {
    return null;
  }
  return Math.round(((listPrice - price) / listPrice) * 100);
}

/** Per-unit savings, or null if there is no discount. */
export function computeSavingsPerUnit(listPrice: number | null, price: number | null): number | null {
  if (listPrice == null || price == null || price >= listPrice) {
    return null;
  }
  return Math.round((listPrice - price) * 100) / 100;
}
