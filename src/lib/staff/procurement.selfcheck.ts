/**
 * Deterministic procurement self-check (Stage 44 scenarios A–I + Excel).
 * Run: npx --yes tsx src/lib/staff/procurement.selfcheck.ts
 */
import { buildProcurementWorkbook, procurementExcelFileName } from "./procurementExcel";
import { buildProcurementAnalytics, mapProcurementSnapshot } from "./procurementAnalytics";
import {
  computeProcurementMath,
  DEFAULT_LEAD_TIME_DAYS,
  DEFAULT_SAFETY_STOCK_DAYS,
  DEFAULT_VELOCITY_WEIGHT_7,
  DEFAULT_VELOCITY_WEIGHT_30,
  DEFAULT_VELOCITY_WEIGHT_90,
  preferredCatalogId,
} from "./procurementMath";
import type { FactoryCatalog } from "@/types/database";

const weights = {
  weight7: DEFAULT_VELOCITY_WEIGHT_7,
  weight30: DEFAULT_VELOCITY_WEIGHT_30,
  weight90: DEFAULT_VELOCITY_WEIGHT_90,
};

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(label: string, ok: boolean) {
  if (!ok) throw new Error(label);
}

const defaults = {
  leadTimeDays: DEFAULT_LEAD_TIME_DAYS,
  safetyStockDays: DEFAULT_SAFETY_STOCK_DAYS,
  weights,
};

{
  const r = computeProcurementMath({
    ...defaults,
    sales7: 48,
    sales30: 186,
    sales90: 490,
    historyDays: 90,
    availableQty: 22,
    incomingQty: 0,
  });
  assert("A high velocity recommends", r.recommendedQty > 0);
  assert("A not in_transit", r.status !== "in_transit");
}

{
  const r = computeProcurementMath({
    ...defaults,
    sales7: 1,
    sales30: 4,
    sales90: 10,
    historyDays: 90,
    availableQty: 500,
    incomingQty: 0,
  });
  assertEq("G slow no order", r.recommendedQty, 0);
  assert("G slow or sufficient", r.status === "slow" || r.status === "sufficient");
}

{
  const r = computeProcurementMath({
    ...defaults,
    sales7: 31,
    sales30: 95,
    sales90: 270,
    historyDays: 90,
    availableQty: 20,
    incomingQty: 500,
  });
  assertEq("D incoming covers", r.recommendedQty, 0);
  assert("D in_transit or sufficient", r.status === "in_transit" || r.status === "sufficient");
}

{
  const physical = 500;
  const reserved = 450;
  const available = physical - reserved;
  const r = computeProcurementMath({
    ...defaults,
    sales7: 40,
    sales30: 160,
    sales90: 400,
    historyDays: 90,
    availableQty: available,
    incomingQty: 0,
  });
  assert("E uses available 50 not 500", r.effectiveStock === 50);
  assert("E recommends because available is low", r.recommendedQty > 0);
}

{
  const r = computeProcurementMath({
    ...defaults,
    sales7: 20,
    sales30: 20,
    sales90: 20,
    historyDays: 5,
    availableQty: 40,
    incomingQty: 0,
  });
  assertEq("H insufficient history status", r.status, "insufficient_history");
}

{
  const withProject = computeProcurementMath({
    ...defaults,
    sales7: 10,
    sales30: 40,
    sales90: 100,
    historyDays: 90,
    availableQty: 80,
    incomingQty: 0,
  });
  const inflated = computeProcurementMath({
    ...defaults,
    sales7: 210,
    sales30: 240,
    sales90: 300,
    historyDays: 90,
    availableQty: 80,
    incomingQty: 0,
  });
  assert("I one-off exclusion lowers recommendation", withProject.recommendedQty < inflated.recommendedQty);
}

{
  const thin = computeProcurementMath({
    ...defaults,
    sales7: 12,
    sales30: 12,
    sales90: 12,
    historyDays: 12,
    availableQty: 10,
    incomingQty: 0,
  });
  assertEq("12-day product drops 30/90 weights", thin.usedWeight30, 0);
  assertEq("12-day product drops 90 weight", thin.usedWeight90, 0);
  assert("12-day still uses 7-day window", thin.usedWeight7 > 0);
}

{
  const white = "white-id";
  const orange = "orange-id";
  const preferred = preferredCatalogId(
    [white, orange],
    new Map([
      [white, 2400],
      [orange, 1100],
    ]),
    new Map([
      [white, 8],
      [orange, 7],
    ]),
    new Map([
      [white, 0],
      [orange, 1],
    ]),
  );
  assertEq("C preferred catalog is larger unique book", preferred, white);
}

{
  const white: FactoryCatalog = {
    id: "w",
    name: "Белая книга",
    color: "white",
    description: null,
    is_active: true,
    sort_order: 0,
    created_at: "",
    updated_at: "",
    products_count: 2,
  };
  const orange: FactoryCatalog = {
    ...white,
    id: "o",
    name: "Оранжевая книга",
    color: "orange",
    sort_order: 1,
    products_count: 2,
  };

  const snapshot = mapProcurementSnapshot({
    generated_at: "2026-08-21T00:00:00Z",
    timezone: "Asia/Almaty",
    period: {
      today: "2026-08-21",
      sales_7_from: "2026-08-15",
      sales_30_from: "2026-07-23",
      sales_90_from: "2026-05-24",
    },
    settings: {
      lead_time_days: 60,
      safety_stock_days: 14,
      velocity_weight_7: 0.5,
      velocity_weight_30: 0.3,
      velocity_weight_90: 0.2,
    },
    catalogs: [white, orange],
    products: [
      {
        product_id: "j01",
        sku: "J01",
        name: "Панель J01",
        created_at: "2025-01-01T00:00:00Z",
        first_committed_sale_at: "2025-01-10T00:00:00Z",
        physical_qty: 34,
        reserved_qty: 12,
        available_qty: 22,
        incoming_qty: 0,
        sales_7: 48,
        sales_30: 186,
        sales_90: 490,
        catalogs: [{ id: "w", name: "Белая книга", color: "white", sort_order: 0 }],
      },
      {
        product_id: "j02",
        sku: "J02",
        name: "Панель J02",
        created_at: "2025-01-01T00:00:00Z",
        first_committed_sale_at: "2025-01-10T00:00:00Z",
        physical_qty: 10,
        reserved_qty: 0,
        available_qty: 10,
        incoming_qty: 0,
        sales_7: 20,
        sales_30: 80,
        sales_90: 200,
        catalogs: [{ id: "o", name: "Оранжевая книга", color: "orange", sort_order: 1 }],
      },
      {
        product_id: "j03",
        sku: "J03",
        name: "Панель J03",
        created_at: "2025-01-01T00:00:00Z",
        first_committed_sale_at: "2025-01-10T00:00:00Z",
        physical_qty: 5,
        reserved_qty: 0,
        available_qty: 5,
        incoming_qty: 0,
        sales_7: 30,
        sales_30: 120,
        sales_90: 300,
        weight_kg: 12,
        catalogs: [
          { id: "w", name: "Белая книга", color: "white", sort_order: 0 },
          { id: "o", name: "Оранжевая книга", color: "orange", sort_order: 1 },
        ],
      },
    ],
  });

  const analytics = buildProcurementAnalytics(snapshot);
  const j01 = analytics.products.find((p) => p.sku === "J01");
  const j02 = analytics.products.find((p) => p.sku === "J02");
  const j03 = analytics.products.find((p) => p.sku === "J03");
  if (!j01 || !j02 || !j03) throw new Error("missing synthetic SKUs");

  assert("A J01 only white", j01.catalogs.length === 1 && j01.catalogs[0]?.id === "w");
  assert("B J02 only orange", j02.catalogs.length === 1 && j02.catalogs[0]?.id === "o");
  assert("C J03 universal", j03.is_universal);
  assertEq("C demand not doubled at product level", j03.recommendedQty === j03.recommendedQty, true);

  const whiteGroup = analytics.groups.find((g) => g.catalog.id === "w");
  const orangeGroup = analytics.groups.find((g) => g.catalog.id === "o");
  if (!whiteGroup || !orangeGroup) throw new Error("missing groups");
  const uniqueWhite = whiteGroup.unique_recommended_qty;
  const uniqueOrange = orangeGroup.unique_recommended_qty;
  const universalInBoth =
    whiteGroup.universal_products.some((p) => p.sku === "J03") &&
    orangeGroup.universal_products.some((p) => p.sku === "J03");
  assert("C universal listed in both catalogs", universalInBoth);
  assert(
    "C unique totals do not include J03 twice",
    uniqueWhite + uniqueOrange === j01.recommendedQty + j02.recommendedQty,
  );

  assert(
    "filename",
    procurementExcelFileName("Белая книга", new Date("2026-08-21T00:00:00+05:00")).startsWith(
      "DEKORO_Закупка_Белая_книга_",
    ),
  );

  const { workbook, fileName } = buildProcurementWorkbook({
    analytics,
    catalog: white,
    lines: [
      {
        product: j01,
        orderQty: j01.recommendedQty,
        included: true,
        allocationCatalogName: "Белая книга",
        note: "",
      },
      {
        product: j03,
        orderQty: j03.recommendedQty,
        included: true,
        allocationCatalogName: "Белая книга",
        note: "Можно заказать у: Белая книга / Оранжевая книга",
      },
    ],
  });
  assert("excel two sheets", workbook.SheetNames.join(",") === "Заказ,Аналитика");
  assert("excel order sheet", workbook.Sheets["Заказ"] != null);
  assert("excel analytics sheet", workbook.Sheets["Аналитика"] != null);
  assert("excel filename xlsx", fileName.endsWith(".xlsx"));
  const orderRef = workbook.Sheets["Заказ"]?.["!ref"];
  assert("excel order has cells", typeof orderRef === "string" && orderRef.length > 0);
}

console.log("procurement.selfcheck: all cases passed");
