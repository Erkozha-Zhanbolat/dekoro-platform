/**
 * Inventory balance report («Остатки»).
 * Source: supabase/migrations/049_inventory_balance_report.sql
 *
 * Formulas (must match Stage 44 procurement stock/incoming):
 *   physical  = inventory.quantity @ ALMATY-01
 *   reserved  = inventory.reserved_quantity
 *   available = greatest(physical - reserved, 0)
 *   incoming  = sum(shipped → ordered → quantity) where
 *               receiving_status ≠ completed AND logistics_status ≠ draft
 *   expected  = available + incoming
 */

import { parseFactoryCatalogRefs } from "@/lib/staff/factoryCatalogParse";
import type {
  FactoryCatalog,
  FactoryCatalogRef,
  ProductSupplyLogisticsStatus,
  ProductSupplyReceivingStatus,
} from "@/types/database";

export type InventoryBalanceStockState =
  | "all"
  | "in_stock"
  | "out_of_stock"
  | "has_reserve"
  | "incoming";

export type InventoryBalanceSortKey =
  | "sku"
  | "name"
  | "physical_qty"
  | "reserved_qty"
  | "available_qty"
  | "incoming_qty"
  | "expected_available_qty"
  | "catalog";

export type InventoryIncomingLine = {
  supply_id: string;
  supply_number: string;
  logistics_status: ProductSupplyLogisticsStatus | string;
  receiving_status: ProductSupplyReceivingStatus | string;
  supply_date: string | null;
  quantity: number;
  label: string;
};

export type InventoryBalanceProduct = {
  product_id: string;
  sku: string;
  original_sku: string | null;
  name: string;
  dimensions: string | null;
  unit: string;
  weight_kg: number | null;
  status: string;
  category_id: string | null;
  category_name: string | null;
  category_sort_order: number;
  subcategory_id: string | null;
  subcategory_name: string | null;
  subcategory_sort_order: number;
  physical_qty: number;
  reserved_qty: number;
  available_qty: number;
  incoming_qty: number;
  expected_available_qty: number;
  incoming_breakdown: InventoryIncomingLine[];
  catalogs: FactoryCatalogRef[];
};

export type InventoryBalanceCategory = {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
};

export type InventoryBalanceSummary = {
  total_sku: number;
  in_stock_sku: number;
  out_of_stock_sku: number;
  reserved_units: number;
  incoming_units: number;
};

export type InventoryBalanceReport = {
  generated_at: string;
  timezone: string;
  warehouse: { id: string; code: string; name: string };
  catalogs: FactoryCatalog[];
  categories: InventoryBalanceCategory[];
  summary: InventoryBalanceSummary;
  products: InventoryBalanceProduct[];
};

export type InventoryBalanceFilters = {
  search?: string;
  categoryId?: string;
  subcategoryId?: string;
  stockState?: InventoryBalanceStockState;
  catalogId?: string; // "all" | "none" | uuid
};

/** Pure Stage 44 / 49 quantity fallback for a supply line. */
export function incomingLineQuantity(item: {
  shipped_quantity?: number | null;
  ordered_quantity?: number | null;
  quantity?: number | null;
}): number {
  if (item.shipped_quantity != null) return Number(item.shipped_quantity) || 0;
  if (item.ordered_quantity != null) return Number(item.ordered_quantity) || 0;
  return Number(item.quantity) || 0;
}

/** Pure Stage 44 / 49 gate: active non-draft supply not yet received. */
export function isIncomingSupply(supply: {
  receiving_status?: string | null;
  logistics_status?: string | null;
}): boolean {
  return (
    supply.receiving_status !== "completed" &&
    supply.logistics_status !== "draft"
  );
}

/** Pure balance math — same as RPC. */
export function computeInventoryBalance(input: {
  physical: number;
  reserved: number;
  incoming: number;
}): {
  physical: number;
  reserved: number;
  available: number;
  incoming: number;
  expected_available: number;
} {
  const physical = Math.max(0, Number(input.physical) || 0);
  const reserved = Math.max(0, Number(input.reserved) || 0);
  const incoming = Math.max(0, Number(input.incoming) || 0);
  const available = Math.max(physical - reserved, 0);
  return {
    physical,
    reserved,
    available,
    incoming,
    expected_available: available + incoming,
  };
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = asNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function mapIncoming(value: unknown): InventoryIncomingLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const supplyId = asString(r.supply_id);
      if (!supplyId) return null;
      return {
        supply_id: supplyId,
        supply_number: asString(r.supply_number),
        logistics_status: asString(r.logistics_status),
        receiving_status: asString(r.receiving_status),
        supply_date: typeof r.supply_date === "string" ? r.supply_date : null,
        quantity: asNumber(r.quantity, 0),
        label: asString(r.label),
      };
    })
    .filter((row): row is InventoryIncomingLine => row != null);
}

function mapCategory(row: Record<string, unknown>): InventoryBalanceCategory | null {
  const id = asString(row.id);
  const name = asString(row.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    parent_id: typeof row.parent_id === "string" ? row.parent_id : null,
    sort_order: asNumber(row.sort_order, 0),
    is_active: row.is_active == null ? true : Boolean(row.is_active),
  };
}

function mapProduct(row: Record<string, unknown>): InventoryBalanceProduct {
  const physical = asNumber(row.physical_qty, 0);
  const reserved = asNumber(row.reserved_qty, 0);
  const available = asNumber(row.available_qty, Math.max(physical - reserved, 0));
  const incoming = asNumber(row.incoming_qty, 0);
  const expected = asNumber(row.expected_available_qty, available + incoming);
  return {
    product_id: asString(row.product_id),
    sku: asString(row.sku),
    original_sku: typeof row.original_sku === "string" ? row.original_sku : null,
    name: asString(row.name),
    dimensions: typeof row.dimensions === "string" ? row.dimensions : null,
    unit: asString(row.unit, "шт."),
    weight_kg: asNullableNumber(row.weight_kg),
    status: asString(row.status),
    category_id: typeof row.category_id === "string" ? row.category_id : null,
    category_name: typeof row.category_name === "string" ? row.category_name : null,
    category_sort_order: asNumber(row.category_sort_order, 2147483647),
    subcategory_id: typeof row.subcategory_id === "string" ? row.subcategory_id : null,
    subcategory_name:
      typeof row.subcategory_name === "string" ? row.subcategory_name : null,
    subcategory_sort_order: asNumber(row.subcategory_sort_order, 2147483647),
    physical_qty: physical,
    reserved_qty: reserved,
    available_qty: available,
    incoming_qty: incoming,
    expected_available_qty: expected,
    incoming_breakdown: mapIncoming(row.incoming_breakdown),
    catalogs: parseFactoryCatalogRefs(row.catalogs),
  };
}

export function mapInventoryBalanceReport(raw: unknown): InventoryBalanceReport {
  const root = (raw ?? {}) as Record<string, unknown>;
  const warehouse = (root.warehouse ?? {}) as Record<string, unknown>;
  const summary = (root.summary ?? {}) as Record<string, unknown>;

  const catalogsRaw = Array.isArray(root.catalogs) ? root.catalogs : [];
  const catalogs: FactoryCatalog[] = catalogsRaw
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      const id = asString(r.id);
      const name = asString(r.name);
      if (!id || !name) return null;
      return {
        id,
        name,
        color: asString(r.color, "slate"),
        description: typeof r.description === "string" ? r.description : null,
        is_active: r.is_active == null ? true : Boolean(r.is_active),
        sort_order: asNumber(r.sort_order, 0),
        created_at: asString(r.created_at),
        updated_at: asString(r.updated_at),
        products_count: asNumber(r.products_count, 0),
      } satisfies FactoryCatalog;
    })
    .filter((c): c is FactoryCatalog => c != null);

  const categories = (Array.isArray(root.categories) ? root.categories : [])
    .map((row) =>
      row && typeof row === "object"
        ? mapCategory(row as Record<string, unknown>)
        : null,
    )
    .filter((c): c is InventoryBalanceCategory => c != null);

  const products = (Array.isArray(root.products) ? root.products : []).map((row) =>
    mapProduct((row ?? {}) as Record<string, unknown>),
  );

  return {
    generated_at: asString(root.generated_at),
    timezone: asString(root.timezone, "Asia/Almaty"),
    warehouse: {
      id: asString(warehouse.id),
      code: asString(warehouse.code, "ALMATY-01"),
      name: asString(warehouse.name, "ALMATY-01"),
    },
    catalogs,
    categories,
    summary: {
      total_sku: asNumber(summary.total_sku, products.length),
      in_stock_sku: asNumber(
        summary.in_stock_sku,
        products.filter((p) => p.available_qty > 0).length,
      ),
      out_of_stock_sku: asNumber(
        summary.out_of_stock_sku,
        products.filter((p) => p.available_qty <= 0).length,
      ),
      reserved_units: asNumber(
        summary.reserved_units,
        products.reduce((s, p) => s + p.reserved_qty, 0),
      ),
      incoming_units: asNumber(
        summary.incoming_units,
        products.reduce((s, p) => s + p.incoming_qty, 0),
      ),
    },
    products,
  };
}

export function productMatchesStockState(
  product: InventoryBalanceProduct,
  state: InventoryBalanceStockState | undefined,
): boolean {
  if (!state || state === "all") return true;
  switch (state) {
    case "in_stock":
      return product.available_qty > 0;
    case "out_of_stock":
      return product.available_qty <= 0;
    case "has_reserve":
      return product.reserved_qty > 0;
    case "incoming":
      return product.incoming_qty > 0;
    default:
      return true;
  }
}

export function filterInventoryBalanceProducts(
  products: InventoryBalanceProduct[],
  filters: InventoryBalanceFilters,
): InventoryBalanceProduct[] {
  const q = (filters.search ?? "").trim().toLowerCase();
  const catalogId = filters.catalogId ?? "all";

  return products.filter((p) => {
    if (filters.categoryId && p.category_id !== filters.categoryId) return false;
    if (filters.subcategoryId && p.subcategory_id !== filters.subcategoryId) {
      return false;
    }
    if (!productMatchesStockState(p, filters.stockState)) return false;
    if (catalogId === "none" && p.catalogs.length > 0) return false;
    if (catalogId !== "all" && catalogId !== "none") {
      if (!p.catalogs.some((c) => c.id === catalogId)) return false;
    }
    if (q) {
      const hay = [
        p.sku,
        p.original_sku ?? "",
        p.name,
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function compareNullableString(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? "").localeCompare(b ?? "", "ru", { sensitivity: "base" });
}

/** Default catalog order: category → subcategory → name → sku → id. */
export function compareInventoryBalanceDefault(
  a: InventoryBalanceProduct,
  b: InventoryBalanceProduct,
): number {
  return (
    a.category_sort_order - b.category_sort_order ||
    compareNullableString(a.category_name, b.category_name) ||
    a.subcategory_sort_order - b.subcategory_sort_order ||
    compareNullableString(a.subcategory_name, b.subcategory_name) ||
    a.name.localeCompare(b.name, "ru", { sensitivity: "base" }) ||
    a.sku.localeCompare(b.sku, "ru", { sensitivity: "base" }) ||
    a.product_id.localeCompare(b.product_id)
  );
}

export function sortInventoryBalanceProducts(
  products: InventoryBalanceProduct[],
  sortKey: InventoryBalanceSortKey | null | undefined,
  direction: "asc" | "desc" = "asc",
): InventoryBalanceProduct[] {
  const dir = direction === "desc" ? -1 : 1;
  const sorted = [...products];

  if (!sortKey || sortKey === "catalog") {
    sorted.sort(compareInventoryBalanceDefault);
    if (sortKey === "catalog" && direction === "desc") sorted.reverse();
    return sorted;
  }

  sorted.sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "sku":
        cmp = a.sku.localeCompare(b.sku, "ru", { sensitivity: "base" });
        break;
      case "name":
        cmp = a.name.localeCompare(b.name, "ru", { sensitivity: "base" });
        break;
      case "physical_qty":
        cmp = a.physical_qty - b.physical_qty;
        break;
      case "reserved_qty":
        cmp = a.reserved_qty - b.reserved_qty;
        break;
      case "available_qty":
        cmp = a.available_qty - b.available_qty;
        break;
      case "incoming_qty":
        cmp = a.incoming_qty - b.incoming_qty;
        break;
      case "expected_available_qty":
        cmp = a.expected_available_qty - b.expected_available_qty;
        break;
      default:
        cmp = compareInventoryBalanceDefault(a, b);
    }
    if (cmp !== 0) return cmp * dir;
    return compareInventoryBalanceDefault(a, b);
  });

  return sorted;
}

export function summarizeFilteredProducts(
  products: InventoryBalanceProduct[],
): InventoryBalanceSummary {
  return {
    total_sku: products.length,
    in_stock_sku: products.filter((p) => p.available_qty > 0).length,
    out_of_stock_sku: products.filter((p) => p.available_qty <= 0).length,
    reserved_units: products.reduce((s, p) => s + p.reserved_qty, 0),
    incoming_units: products.reduce((s, p) => s + p.incoming_qty, 0),
  };
}

export function inventoryBalanceBadges(product: InventoryBalanceProduct): string[] {
  const badges: string[] = [];
  if (product.available_qty <= 0) badges.push("Нет в наличии");
  else badges.push("Доступно");
  if (product.reserved_qty > 0) badges.push("Есть резерв");
  if (product.incoming_qty > 0) badges.push("В пути");
  return badges;
}
