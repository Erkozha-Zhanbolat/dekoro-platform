import { supabase } from "@/lib/supabase/client";
import type { StaffClientSearchResult } from "@/types/database";

/**
 * Staff-facing client search (supabase/migrations/011_staff_manual_orders.sql).
 *
 * Deliberately separate from src/lib/staff/orders.ts and src/lib/orders.ts:
 * this only ever calls public.staff_search_clients(), a SECURITY DEFINER
 * RPC that checks manager/admin internally. There is no direct table
 * access to public.profiles/public.companies here or anywhere in this
 * module — a client account calling this RPC gets a clear error, not rows.
 */

export type { StaffClientSearchResult };

const DEFAULT_CLIENT_SEARCH_LIMIT = 20;

/**
 * Searches existing, already-registered clients by name / company / phone /
 * email. Pass an empty query to list the first `limit` clients (still
 * capped server-side at 50 by staff_search_clients()).
 */
export async function searchStaffClients(
  query: string,
  limit: number = DEFAULT_CLIENT_SEARCH_LIMIT,
): Promise<StaffClientSearchResult[]> {
  const trimmed = query.trim();

  const { data, error } = await supabase.rpc("staff_search_clients", {
    p_query: trimmed.length > 0 ? trimmed : null,
    p_limit: limit,
  });

  if (error) {
    throw new Error(error.message || "Не удалось выполнить поиск клиентов");
  }

  return (data as StaffClientSearchResult[] | null) ?? [];
}
