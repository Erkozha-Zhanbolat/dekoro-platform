import { supabase } from "@/lib/supabase/client";
import type {
  BulkProductPricesPayload,
  BulkProductPricesResult,
  CustomerProductPriceRow,
  PriceGroup,
  PricingMatrixRow,
  ProductGroupPriceRow,
} from "@/types/database";

/**
 * Staff/admin pricing APIs (supabase/migrations/028_customer_pricing.sql).
 * All access goes through SECURITY DEFINER RPCs — no direct table reads.
 */

export type {
  BulkProductPricesPayload,
  BulkProductPricesResult,
  CustomerProductPriceRow,
  PriceGroup,
  PricingMatrixRow,
  ProductGroupPriceRow,
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapPriceGroup(row: Record<string, unknown>): PriceGroup {
  return {
    id: String(row.id),
    name: String(row.name),
    code: String(row.code ?? ""),
    description: row.description == null ? null : String(row.description),
    sort_order: Number(row.sort_order ?? 0),
    is_default: Boolean(row.is_default),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Manager+admin: list price groups (active by default). */
export async function listStaffPriceGroups(
  includeInactive = false,
): Promise<PriceGroup[]> {
  const { data, error } = await supabase.rpc("staff_list_price_groups", {
    p_include_inactive: includeInactive,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить ценовые группы");
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapPriceGroup);
}

/** Admin-only alias with inactive included by default for settings UI. */
export async function listAdminPriceGroups(
  includeInactive = true,
): Promise<PriceGroup[]> {
  const { data, error } = await supabase.rpc("admin_list_price_groups", {
    p_include_inactive: includeInactive,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить ценовые группы");
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapPriceGroup);
}

export async function createPriceGroup(input: {
  name: string;
  code: string;
  sort_order?: number;
}): Promise<PriceGroup> {
  const { data, error } = await supabase.rpc("admin_create_price_group", {
    p_name: input.name,
    p_code: input.code,
    p_sort_order: input.sort_order ?? 0,
  });
  if (error) throw new Error(error.message || "Не удалось создать ценовую группу");
  return mapPriceGroup(data as Record<string, unknown>);
}

export async function updatePriceGroup(input: {
  id: string;
  name?: string;
  code?: string;
  sort_order?: number;
}): Promise<PriceGroup> {
  const { data, error } = await supabase.rpc("admin_update_price_group", {
    p_id: input.id,
    p_name: input.name ?? null,
    p_code: input.code ?? null,
    p_sort_order: input.sort_order ?? null,
  });
  if (error) throw new Error(error.message || "Не удалось обновить ценовую группу");
  return mapPriceGroup(data as Record<string, unknown>);
}

export async function setDefaultPriceGroup(id: string): Promise<PriceGroup> {
  const { data, error } = await supabase.rpc("admin_set_default_price_group", {
    p_id: id,
  });
  if (error) throw new Error(error.message || "Не удалось назначить группу по умолчанию");
  return mapPriceGroup(data as Record<string, unknown>);
}

export async function archivePriceGroup(id: string): Promise<PriceGroup> {
  const { data, error } = await supabase.rpc("admin_archive_price_group", {
    p_id: id,
  });
  if (error) throw new Error(error.message || "Не удалось архивировать группу");
  return mapPriceGroup(data as Record<string, unknown>);
}

export async function restorePriceGroup(id: string): Promise<PriceGroup> {
  const { data, error } = await supabase.rpc("admin_restore_price_group", {
    p_id: id,
  });
  if (error) throw new Error(error.message || "Не удалось восстановить группу");
  return mapPriceGroup(data as Record<string, unknown>);
}

export async function reorderPriceGroups(
  items: Array<{ id: string; sort_order: number }>,
): Promise<void> {
  const { error } = await supabase.rpc("admin_reorder_price_groups", {
    p_items: items,
  });
  if (error) throw new Error(error.message || "Не удалось изменить порядок");
}

export async function getProductGroupPrices(
  productId: string,
): Promise<ProductGroupPriceRow[]> {
  const { data, error } = await supabase.rpc("staff_get_product_prices", {
    p_product_id: productId,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить цены товара");
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    price_group_id: String(row.price_group_id),
    price_group_name: String(row.price_group_name),
    price_group_code: String(row.price_group_code ?? ""),
    sort_order: Number(row.sort_order ?? 0),
    is_active: Boolean(row.is_active),
    is_default: Boolean(row.is_default),
    price: asNumber(row.price),
    has_explicit_price: Boolean(row.has_explicit_price),
  }));
}

export async function upsertProductGroupPrice(input: {
  productId: string;
  priceGroupId: string;
  price: number;
}): Promise<void> {
  const { error } = await supabase.rpc("admin_upsert_product_group_price", {
    p_product_id: input.productId,
    p_price_group_id: input.priceGroupId,
    p_price: input.price,
  });
  if (error) throw new Error(error.message || "Не удалось сохранить цену");
}

export async function deleteProductGroupPrice(input: {
  productId: string;
  priceGroupId: string;
}): Promise<void> {
  const { error } = await supabase.rpc("admin_delete_product_group_price", {
    p_product_id: input.productId,
    p_price_group_id: input.priceGroupId,
  });
  if (error) throw new Error(error.message || "Не удалось удалить цену группы");
}

export async function batchUpsertProductGroupPrices(
  rows: Array<{ product_id: string; price_group_id: string; price: number | null }>,
): Promise<number> {
  const { data, error } = await supabase.rpc("admin_batch_upsert_product_group_prices", {
    p_rows: rows,
  });
  if (error) throw new Error(error.message || "Не удалось сохранить цены");
  return Number(data ?? 0);
}

/**
 * Transactional bulk price update for many products.
 * Payload actions: keep | set | reset (empty UI field → keep, never reset).
 */
export async function bulkUpdateProductPrices(
  productIds: string[],
  payload: BulkProductPricesPayload,
): Promise<BulkProductPricesResult> {
  const { data, error } = await supabase.rpc("admin_bulk_update_product_prices", {
    p_product_ids: productIds,
    p_payload: payload,
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

export async function listPricingMatrix(input?: {
  query?: string;
  categoryId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<PricingMatrixRow[]> {
  const { data, error } = await supabase.rpc("admin_list_pricing_matrix", {
    p_query: input?.query?.trim() ? input.query.trim() : null,
    p_category_id: input?.categoryId ?? null,
    p_limit: input?.limit ?? 50,
    p_offset: input?.offset ?? 0,
  });
  if (error) throw new Error(error.message || "Не удалось загрузить матрицу цен");
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => {
    const rawGroups = (row.group_prices ?? {}) as Record<string, unknown>;
    const group_prices: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawGroups)) {
      const n = asNumber(value);
      if (n != null) group_prices[key] = n;
    }
    return {
      product_id: String(row.product_id),
      sku: String(row.sku),
      name: String(row.name),
      category_name: row.category_name == null ? null : String(row.category_name),
      base_price: asNumber(row.base_price),
      group_prices,
    };
  });
}

export async function setCustomerPriceGroup(
  customerId: string,
  priceGroupId: string,
): Promise<void> {
  const { error } = await supabase.rpc("admin_set_customer_price_group", {
    p_customer_id: customerId,
    p_price_group_id: priceGroupId,
  });
  if (error) throw new Error(error.message || "Не удалось сменить ценовую группу");
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
