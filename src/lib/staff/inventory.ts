import { supabase } from "@/lib/supabase/client";
import type { StaffProductSearchResult } from "@/types/database";

/**
 * Staff-facing product/stock search (supabase/migrations/011_staff_manual_orders.sql).
 *
 * This is the ONLY way staff code ever reads inventory: public.inventory
 * has no SELECT policy for authenticated (same as the client-facing
 * catalog), so this goes entirely through the SECURITY DEFINER
 * staff_search_products() RPC, which checks
 * manager/admin/accountant/warehouse internally.
 */

export type { StaffProductSearchResult };

const DEFAULT_PRODUCT_SEARCH_LIMIT = 50;

/**
 * Searches active products by name/SKU, together with their current stock
 * at the single active warehouse (physical / reserved / available) and the
 * effective price for the optional customer (Stage 28). Pass an empty query
 * to list the first `limit` active products.
 */
export async function searchStaffProducts(
  query: string,
  limit: number = DEFAULT_PRODUCT_SEARCH_LIMIT,
  customerId: string | null = null,
): Promise<StaffProductSearchResult[]> {
  const trimmed = query.trim();

  const { data, error } = await supabase.rpc("staff_search_products", {
    p_query: trimmed.length > 0 ? trimmed : null,
    p_limit: limit,
    p_customer_id: customerId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить товары");
  }

  return (data as StaffProductSearchResult[] | null) ?? [];
}
