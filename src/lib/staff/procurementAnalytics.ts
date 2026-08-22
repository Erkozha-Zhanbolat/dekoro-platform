import { almatyDateStamp } from "@/lib/staff/inventoryReconciliationParse";
import { parseFactoryCatalogRefs } from "@/lib/staff/factoryCatalogParse";
import {
  computeProcurementMath,
  preferredCatalogId,
  type ProcurementMathResult,
  type ProcurementRecommendationStatus,
  type ProcurementWeights,
} from "@/lib/staff/procurementMath";
import type { FactoryCatalog, FactoryCatalogRef } from "@/types/database";

export type ProcurementSettings = {
  lead_time_days: number;
  safety_stock_days: number;
  velocity_weight_7: number;
  velocity_weight_30: number;
  velocity_weight_90: number;
  updated_at: string | null;
};

export type ProcurementIncomingLine = {
  supply_id: string;
  supply_number: string;
  logistics_status: string;
  quantity: number;
  label: string;
};

export type ProcurementSnapshotProduct = {
  product_id: string;
  sku: string;
  original_sku: string | null;
  name: string;
  dimensions: string | null;
  unit: string;
  weight_kg: number | null;
  min_order_qty: number;
  status: string;
  created_at: string;
  physical_qty: number;
  reserved_qty: number;
  available_qty: number;
  sales_7: number;
  sales_30: number;
  sales_90: number;
  first_committed_sale_at: string | null;
  incoming_qty: number;
  incoming_breakdown: ProcurementIncomingLine[];
  catalogs: FactoryCatalogRef[];
};

export type ProcurementSnapshot = {
  generated_at: string;
  timezone: string;
  period: {
    today: string;
    sales_7_from: string;
    sales_30_from: string;
    sales_90_from: string;
  };
  settings: ProcurementSettings;
  catalogs: FactoryCatalog[];
  products: ProcurementSnapshotProduct[];
};

export type ProcurementAnalyzedProduct = ProcurementSnapshotProduct &
  ProcurementMathResult & {
    history_days: number;
    is_universal: boolean;
    preferred_catalog_id: string | null;
    estimated_weight_kg: number | null;
  };

export type ProcurementCatalogGroup = {
  catalog: FactoryCatalog;
  unique_products: ProcurementAnalyzedProduct[];
  universal_products: ProcurementAnalyzedProduct[];
  unique_recommended_qty: number;
  unique_recommended_sku: number;
  preferred_universal_qty: number;
};

export type ProcurementAnalytics = {
  snapshot: ProcurementSnapshot;
  products: ProcurementAnalyzedProduct[];
  groups: ProcurementCatalogGroup[];
  unassigned: ProcurementAnalyzedProduct[];
  formula_text: string;
  weight_missing_sku: number;
};

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

export function almatyCalendarDaysBetween(fromIso: string, toDate = new Date()): number {
  const fromDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(fromIso));
  const toDay = almatyDateStamp(toDate);
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

function historyDaysForProduct(product: ProcurementSnapshotProduct): number {
  const start = product.first_committed_sale_at ?? product.created_at;
  if (!start) return 0;
  return Math.min(90, almatyCalendarDaysBetween(start));
}

function mapIncoming(value: unknown): ProcurementIncomingLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const r = row as Record<string, unknown>;
      return {
        supply_id: String(r.supply_id ?? ""),
        supply_number: String(r.supply_number ?? ""),
        logistics_status: String(r.logistics_status ?? ""),
        quantity: asNumber(r.quantity, 0),
        label: String(r.label ?? ""),
      };
    })
    .filter((row): row is ProcurementIncomingLine => row != null && row.supply_id !== "");
}

export function mapProcurementSettings(row: Record<string, unknown>): ProcurementSettings {
  return {
    lead_time_days: asNumber(row.lead_time_days, 60),
    safety_stock_days: asNumber(row.safety_stock_days, 14),
    velocity_weight_7: asNumber(row.velocity_weight_7, 0.5),
    velocity_weight_30: asNumber(row.velocity_weight_30, 0.3),
    velocity_weight_90: asNumber(row.velocity_weight_90, 0.2),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
  };
}

function mapCatalog(row: Record<string, unknown>): FactoryCatalog {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    color: String(row.color ?? "slate"),
    description: row.description == null ? null : String(row.description),
    is_active: row.is_active == null ? true : Boolean(row.is_active),
    sort_order: asNumber(row.sort_order, 0),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    products_count: asNumber(row.products_count, 0),
  };
}

function mapSnapshotProduct(row: Record<string, unknown>): ProcurementSnapshotProduct {
  return {
    product_id: String(row.product_id ?? ""),
    sku: String(row.sku ?? ""),
    original_sku: row.original_sku == null ? null : String(row.original_sku),
    name: String(row.name ?? ""),
    dimensions: row.dimensions == null ? null : String(row.dimensions),
    unit: String(row.unit ?? "шт."),
    weight_kg: asNullableNumber(row.weight_kg),
    min_order_qty: asNumber(row.min_order_qty, 1),
    status: String(row.status ?? "active"),
    created_at: String(row.created_at ?? ""),
    physical_qty: asNumber(row.physical_qty, 0),
    reserved_qty: asNumber(row.reserved_qty, 0),
    available_qty: asNumber(row.available_qty, 0),
    sales_7: asNumber(row.sales_7, 0),
    sales_30: asNumber(row.sales_30, 0),
    sales_90: asNumber(row.sales_90, 0),
    first_committed_sale_at:
      row.first_committed_sale_at == null ? null : String(row.first_committed_sale_at),
    incoming_qty: asNumber(row.incoming_qty, 0),
    incoming_breakdown: mapIncoming(row.incoming_breakdown),
    catalogs: parseFactoryCatalogRefs(row.catalogs),
  };
}

export function mapProcurementSnapshot(raw: unknown): ProcurementSnapshot {
  const row = (raw ?? {}) as Record<string, unknown>;
  const period = (row.period ?? {}) as Record<string, unknown>;
  const settings = mapProcurementSettings((row.settings ?? {}) as Record<string, unknown>);
  const catalogs = Array.isArray(row.catalogs)
    ? row.catalogs.map((c) => mapCatalog(c as Record<string, unknown>))
    : [];
  const products = Array.isArray(row.products)
    ? row.products.map((p) => mapSnapshotProduct(p as Record<string, unknown>))
    : [];
  return {
    generated_at: String(row.generated_at ?? ""),
    timezone: String(row.timezone ?? "Asia/Almaty"),
    period: {
      today: String(period.today ?? ""),
      sales_7_from: String(period.sales_7_from ?? ""),
      sales_30_from: String(period.sales_30_from ?? ""),
      sales_90_from: String(period.sales_90_from ?? ""),
    },
    settings,
    catalogs,
    products,
  };
}

export function formulaText(settings: ProcurementSettings): string {
  return (
    `Среднесуточные продажи = (` +
    `${settings.velocity_weight_7}×(продажи 7д / мин(7, история)) + ` +
    `${settings.velocity_weight_30}×(продажи 30д / мин(30, история)) + ` +
    `${settings.velocity_weight_90}×(продажи 90д / мин(90, история))) ` +
    `/ сумма весов полных окон. ` +
    `Окно 30д включается только при истории ≥ 30 дней, окно 90д — при ≥ 90. ` +
    `Целевой запас = ceil(среднесуточные × (${settings.lead_time_days} + ${settings.safety_stock_days})). ` +
    `Эффективный остаток = доступно + в пути. ` +
    `Рекомендация = max(0, целевой − эффективный). ` +
    `Продажи: оплаченные и далее по складу, без отменённых, тестовых и проектных заказов. ` +
    `new/awaiting_payment учитываются как резерв (доступно), не как продажа. ` +
    `В пути: поставки со статусом логистики после черновика и без завершённой приёмки.`
  );
}

export function buildProcurementAnalytics(snapshot: ProcurementSnapshot): ProcurementAnalytics {
  const weights: ProcurementWeights = {
    weight7: snapshot.settings.velocity_weight_7,
    weight30: snapshot.settings.velocity_weight_30,
    weight90: snapshot.settings.velocity_weight_90,
  };

  const analyzed: ProcurementAnalyzedProduct[] = snapshot.products.map((product) => {
    const history_days = historyDaysForProduct(product);
    const math = computeProcurementMath({
      sales7: product.sales_7,
      sales30: product.sales_30,
      sales90: product.sales_90,
      historyDays: history_days,
      availableQty: product.available_qty,
      incomingQty: product.incoming_qty,
      leadTimeDays: snapshot.settings.lead_time_days,
      safetyStockDays: snapshot.settings.safety_stock_days,
      weights,
    });
    const estimated_weight_kg =
      product.weight_kg != null && Number.isFinite(product.weight_kg)
        ? product.weight_kg * math.recommendedQty
        : null;
    return {
      ...product,
      ...math,
      history_days,
      is_universal: product.catalogs.length > 1,
      preferred_catalog_id: product.catalogs[0]?.id ?? null,
      estimated_weight_kg,
    };
  });

  const uniqueQty = new Map<string, number>();
  const uniqueSku = new Map<string, number>();
  const sortOrder = new Map<string, number>();
  for (const catalog of snapshot.catalogs) {
    uniqueQty.set(catalog.id, 0);
    uniqueSku.set(catalog.id, 0);
    sortOrder.set(catalog.id, catalog.sort_order);
  }
  for (const product of analyzed) {
    if (product.catalogs.length !== 1) continue;
    const id = product.catalogs[0]?.id;
    if (!id) continue;
    uniqueQty.set(id, (uniqueQty.get(id) ?? 0) + product.recommendedQty);
    uniqueSku.set(id, (uniqueSku.get(id) ?? 0) + (product.recommendedQty > 0 ? 1 : 0));
  }

  for (const product of analyzed) {
    product.preferred_catalog_id = preferredCatalogId(
      product.catalogs.map((c) => c.id),
      uniqueQty,
      uniqueSku,
      sortOrder,
    );
  }

  const groups: ProcurementCatalogGroup[] = snapshot.catalogs.map((catalog) => {
    const members = analyzed.filter((p) => p.catalogs.some((c) => c.id === catalog.id));
    const unique_products = members.filter((p) => p.catalogs.length === 1);
    const universal_products = members.filter((p) => p.catalogs.length > 1);
    return {
      catalog,
      unique_products,
      universal_products,
      unique_recommended_qty: unique_products.reduce((sum, p) => sum + p.recommendedQty, 0),
      unique_recommended_sku: unique_products.filter((p) => p.recommendedQty > 0).length,
      preferred_universal_qty: universal_products
        .filter((p) => p.preferred_catalog_id === catalog.id)
        .reduce((sum, p) => sum + p.recommendedQty, 0),
    };
  });

  return {
    snapshot,
    products: analyzed,
    groups,
    unassigned: analyzed.filter((p) => p.catalogs.length === 0),
    formula_text: formulaText(snapshot.settings),
    weight_missing_sku: analyzed.filter(
      (p) => p.recommendedQty > 0 && (p.weight_kg == null || p.weight_kg <= 0),
    ).length,
  };
}

export const PROCUREMENT_STATUS_ORDER: ProcurementRecommendationStatus[] = [
  "critical",
  "recommend",
  "order_soon",
  "in_transit",
  "watch",
  "insufficient_history",
  "slow",
  "sufficient",
];
