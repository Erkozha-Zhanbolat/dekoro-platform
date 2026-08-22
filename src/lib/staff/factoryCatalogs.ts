import { supabase } from "@/lib/supabase/client";
import { parseFactoryCatalogRefs } from "@/lib/staff/factoryCatalogParse";
import type { FactoryCatalog, FactoryCatalogRef } from "@/types/database";

export { parseFactoryCatalogRefs };
export type { FactoryCatalogRef };

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function mapCatalog(row: Record<string, unknown>): FactoryCatalog {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    color: String(row.color ?? "slate"),
    description: row.description == null ? null : String(row.description),
    is_active: Boolean(row.is_active),
    sort_order: asNumber(row.sort_order, 0),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    products_count: asNumber(row.products_count, 0),
  };
}

export async function listFactoryCatalogs(
  includeInactive = false,
): Promise<FactoryCatalog[]> {
  const { data, error } = await supabase.rpc("staff_list_factory_catalogs", {
    p_include_inactive: includeInactive,
  });
  if (error) {
    throw new Error(error.message || "Не удалось загрузить заводские каталоги");
  }
  if (!Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map(mapCatalog);
}

export async function createFactoryCatalog(input: {
  name: string;
  color: string;
  description?: string | null;
  sortOrder?: number;
}): Promise<FactoryCatalog> {
  const { data, error } = await supabase.rpc("staff_create_factory_catalog", {
    p_name: input.name,
    p_color: input.color,
    p_description: input.description?.trim() || null,
    p_sort_order: input.sortOrder ?? 0,
  });
  if (error) {
    throw new Error(error.message || "Не удалось создать каталог");
  }
  return mapCatalog((data ?? {}) as Record<string, unknown>);
}

export async function updateFactoryCatalog(input: {
  id: string;
  name: string;
  color: string;
  description?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}): Promise<FactoryCatalog> {
  const { data, error } = await supabase.rpc("staff_update_factory_catalog", {
    p_id: input.id,
    p_name: input.name,
    p_color: input.color,
    p_description: input.description?.trim() || null,
    p_sort_order: input.sortOrder ?? 0,
    p_is_active: input.isActive ?? true,
  });
  if (error) {
    throw new Error(error.message || "Не удалось сохранить каталог");
  }
  return mapCatalog((data ?? {}) as Record<string, unknown>);
}

export async function archiveFactoryCatalog(id: string): Promise<FactoryCatalog> {
  const { data, error } = await supabase.rpc("staff_archive_factory_catalog", {
    p_id: id,
  });
  if (error) {
    throw new Error(error.message || "Не удалось архивировать каталог");
  }
  return mapCatalog((data ?? {}) as Record<string, unknown>);
}

export async function setProductFactoryCatalogs(
  productId: string,
  catalogIds: string[],
): Promise<FactoryCatalogRef[]> {
  const { data, error } = await supabase.rpc("staff_set_product_factory_catalogs", {
    p_product_id: productId,
    p_catalog_ids: catalogIds,
  });
  if (error) {
    throw new Error(error.message || "Не удалось сохранить каталоги товара");
  }
  return parseFactoryCatalogRefs(data);
}

export async function bulkAssignFactoryCatalogs(input: {
  productIds: string[];
  catalogIds: string[];
  mode: "add" | "replace";
}): Promise<{ mode: string; products: number; catalogs: number; rows_inserted: number }> {
  const { data, error } = await supabase.rpc("staff_bulk_assign_factory_catalogs", {
    p_product_ids: input.productIds,
    p_catalog_ids: input.catalogIds,
    p_mode: input.mode,
  });
  if (error) {
    throw new Error(error.message || "Не удалось назначить каталоги");
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    mode: String(row.mode ?? input.mode),
    products: asNumber(row.products, 0),
    catalogs: asNumber(row.catalogs, 0),
    rows_inserted: asNumber(row.rows_inserted, 0),
  };
}
