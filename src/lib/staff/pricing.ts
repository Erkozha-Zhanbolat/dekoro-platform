import { supabase } from "@/lib/supabase/client";
import type {
  BulkProductPricesPayload,
  BulkProductPricesResult,
  BulkProductPricingPayload,
  BulkProductPricingResult,
  CustomerProductPriceRow,
  PricingGuardSettings,
  ProductPricingOverviewRow,
  ProductQuantityPriceRow,
} from "@/types/database";

/**
 * Staff/admin pricing APIs. As of Stage 42
 * (supabase/migrations/042_remove_legacy_price_groups.sql) the pricing model
 * is: base/retail price -> quantity tier -> customer individual price ->
 * manager override. Price-group management (creating/editing groups, the
 * per-group pricing matrix, assigning a customer to a group) is retired —
 * those wrapper functions were removed from this file along with the UI
 * that called them. The underlying DB objects are still physically present
 * (unused) — see migration 042 section 8.
 * All access goes through SECURITY DEFINER RPCs — no direct table reads.
 */

export type {
  BulkProductPricesPayload,
  BulkProductPricesResult,
  BulkProductPricingPayload,
  BulkProductPricingResult,
  CustomerProductPriceRow,
  ProductPricingOverviewRow,
  ProductQuantityPriceRow,
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Transactional bulk retail-price update for many products (base price
 * only as of Stage 42 — the "groups" branch is no longer exercised by this
 * client; the RPC itself still accepts it for backward compatibility).
 */
export async function bulkUpdateProductPrices(
  productIds: string[],
  payload: BulkProductPricesPayload,
): Promise<BulkProductPricesResult> {
  const { data, error } = await supabase.rpc("admin_bulk_update_product_prices", {
    p_product_ids: productIds,
    p_payload: { base: payload.base, groups: [] },
  });
  if (error) throw new Error(error.message || "Не удалось применить цены");
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    updated_products: Number(row.updated_products ?? 0),
    base_updates: Number(row.base_updates ?? 0),
    group_sets: Number(row.group_sets ?? 0),
    group_resets: Number(row.group_resets ?? 0),
  };
}

/** Admin: list products with retail price + quantity tiers (042). */
export async function listProductPricingOverview(input?: {
  query?: string;
  categoryId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ProductPricingOverviewRow[]> {
  const { data, error } = await supabase.rpc("admin_list_product_pricing_overview", {
    p_query: input?.query?.trim() ? input.query.trim() : null,
    p_category_id: input?.categoryId ?? null,
    p_limit: input?.limit ?? 50,
    p_offset: input?.offset ?? 0,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить список цен");
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => {
    const rawTiers = Array.isArray(row.quantity_tiers) ? row.quantity_tiers : [];
    const quantity_tiers = (rawTiers as Record<string, unknown>[])
      .map((tier) => ({
        min_quantity: Number(tier.min_quantity ?? 0),
        price: Number(tier.price ?? 0),
      }))
      .filter((tier) => Number.isFinite(tier.min_quantity) && Number.isFinite(tier.price));
    return {
      product_id: String(row.product_id),
      sku: String(row.sku),
      name: String(row.name),
      category_name: row.category_name == null ? null : String(row.category_name),
      base_price: asNumber(row.base_price),
      quantity_tiers,
    };
  });
}

/**
 * Admin: all product_ids matching the same filter as
 * listProductPricingOverview(), uncapped by page size (043). Used to know
 * the exact "Найдено N товаров" count and to build the id list for
 * "Выбрать все N найденных товаров".
 */
export async function listProductPricingIds(input?: {
  query?: string;
  categoryId?: string | null;
}): Promise<string[]> {
  const { data, error } = await supabase.rpc("admin_list_product_pricing_ids", {
    p_query: input?.query?.trim() ? input.query.trim() : null,
    p_category_id: input?.categoryId ?? null,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить список товаров");
  return ((data as { id: string }[] | string[] | null) ?? []).map((row) =>
    typeof row === "string" ? row : String((row as { id: string }).id),
  );
}

/**
 * Admin-only, transactional bulk update of retail price and/or quantity
 * tiers for many products at once (043_bulk_product_pricing.sql). Never
 * touches customer_product_prices or order_items.
 */
export async function bulkUpdateProductPricing(
  productIds: string[],
  payload: BulkProductPricingPayload,
): Promise<BulkProductPricingResult> {
  const { data, error } = await supabase.rpc("admin_bulk_update_product_pricing", {
    p_product_ids: productIds,
    p_update_base: payload.updateBase,
    p_base_price: payload.updateBase ? payload.basePrice ?? null : null,
    p_tiers:
      payload.tiers.length > 0
        ? payload.tiers.map((tier) => ({ min_quantity: tier.minQuantity, price: tier.price }))
        : null,
    p_tier_mode: payload.tierMode,
  });
  if (error) throw new Error(error.message || "Не удалось применить массовое изменение цен");
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    updated_products: Number(row.updated_products ?? 0),
    base_price_changed: Boolean(row.base_price_changed),
    base_price: row.base_price == null ? null : asNumber(row.base_price),
    tiers_changed: Boolean(row.tiers_changed),
    tier_mode: (row.tier_mode ?? null) as BulkProductPricingResult["tier_mode"],
    tiers_count: Number(row.tiers_count ?? 0),
    tier_rows_written: Number(row.tier_rows_written ?? 0),
  };
}

export async function listCustomerProductPrices(
  customerId: string,
): Promise<CustomerProductPriceRow[]> {
  const { data, error } = await supabase.rpc("staff_list_customer_product_prices", {
    p_customer_id: customerId,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить индивидуальные цены");
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    product_id: String(row.product_id),
    sku: String(row.sku),
    name: String(row.name),
    base_price: asNumber(row.base_price),
    group_price: asNumber(row.group_price),
    individual_price: asNumber(row.individual_price),
    effective_price: asNumber(row.effective_price),
    price_source: String(row.price_source ?? "base") as CustomerProductPriceRow["price_source"],
  }));
}

export async function upsertCustomerProductPrice(input: {
  customerId: string;
  productId: string;
  price: number;
}): Promise<void> {
  const { error } = await supabase.rpc("admin_upsert_customer_product_price", {
    p_customer_id: input.customerId,
    p_product_id: input.productId,
    p_price: input.price,
  });
  if (error) throw new Error(error.message || "Не удалось сохранить индивидуальную цену");
}

export async function deleteCustomerProductPrice(input: {
  customerId: string;
  productId: string;
}): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_customer_product_price", {
    p_customer_id: input.customerId,
    p_product_id: input.productId,
  });
  if (error) throw new Error(error.message || "Не удалось удалить индивидуальную цену");
}

// ============================================================
// Quantity tiers (041_order_pricing_engine.sql) — manager+admin read,
// admin-only write. Thresholds are per-product and not hardcoded.
// ============================================================

function mapQuantityPriceRow(row: Record<string, unknown>): ProductQuantityPriceRow {
  return {
    id: String(row.id),
    product_id: String(row.product_id),
    min_quantity: Number(row.min_quantity),
    price: Number(row.price),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Manager+admin: list quantity tiers for a product, ascending by min_quantity. */
export async function listProductQuantityPrices(
  productId: string,
): Promise<ProductQuantityPriceRow[]> {
  const { data, error } = await supabase.rpc("staff_list_product_quantity_prices", {
    p_product_id: productId,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить уровни цен");
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapQuantityPriceRow);
}

/** Admin-only: create or update a tier (upsert by product_id + min_quantity). */
export async function upsertProductQuantityPrice(input: {
  productId: string;
  minQuantity: number;
  price: number;
}): Promise<ProductQuantityPriceRow> {
  const { data, error } = await supabase.rpc("admin_upsert_product_quantity_price", {
    p_product_id: input.productId,
    p_min_quantity: input.minQuantity,
    p_price: input.price,
  });
  if (error) throw new Error(error.message || "Не удалось сохранить уровень цены");
  return mapQuantityPriceRow(data as Record<string, unknown>);
}

/** Admin-only: delete a tier. */
export async function deleteProductQuantityPrice(id: string): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_product_quantity_price", { p_id: id });
  if (error) throw new Error(error.message || "Не удалось удалить уровень цены");
}

// ============================================================
// Pricing guard settings (041) — manager+admin read, admin-only write.
// Minimal boundary (ТЗ §22), not a full approval workflow.
// ============================================================

function mapGuardSettings(row: Record<string, unknown>): PricingGuardSettings {
  return {
    max_manager_discount_percent:
      row.max_manager_discount_percent == null ? null : Number(row.max_manager_discount_percent),
    min_margin_over_cost_percent:
      row.min_margin_over_cost_percent == null ? null : Number(row.min_margin_over_cost_percent),
    updated_by: row.updated_by == null ? null : String(row.updated_by),
    updated_at: String(row.updated_at),
  };
}

export async function getPricingGuardSettings(): Promise<PricingGuardSettings> {
  const { data, error } = await supabase.rpc("staff_get_pricing_guard_settings");
  if (error) throw new Error(error.message || "Не удалось загрузить настройки контроля цен");
  return mapGuardSettings(data as Record<string, unknown>);
}

export async function updatePricingGuardSettings(input: {
  maxManagerDiscountPercent: number | null;
  minMarginOverCostPercent: number | null;
}): Promise<PricingGuardSettings> {
  const { data, error } = await supabase.rpc("admin_update_pricing_guard_settings", {
    p_max_manager_discount_percent: input.maxManagerDiscountPercent,
    p_min_margin_over_cost_percent: input.minMarginOverCostPercent,
  });
  if (error) throw new Error(error.message || "Не удалось сохранить настройки контроля цен");
  return mapGuardSettings(data as Record<string, unknown>);
}
