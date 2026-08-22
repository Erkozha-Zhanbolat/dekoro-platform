import * as XLSX from "xlsx";
import {
  almatyDateStamp,
  excelSafeText,
} from "@/lib/staff/inventoryReconciliationParse";
import { PROCUREMENT_STATUS_LABELS } from "@/lib/staff/procurementMath";
import type { FactoryCatalog } from "@/types/database";
import type { ProcurementAnalyzedProduct, ProcurementAnalytics } from "@/lib/staff/procurementAnalytics";

export type ProcurementReportLine = {
  product: ProcurementAnalyzedProduct;
  orderQty: number;
  included: boolean;
  allocationCatalogName: string | null;
  note: string;
};

function num(n: number | null | undefined): number | "" {
  if (n == null || !Number.isFinite(n)) return "";
  return n;
}

function daysLabel(value: number | null): string | number {
  if (value == null) return "∞";
  if (!Number.isFinite(value)) return "∞";
  return Math.round(value * 10) / 10;
}

export function procurementExcelFileName(catalogName: string, date = new Date()): string {
  const slug = catalogName
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .slice(0, 40) || "каталог";
  return `DEKORO_Закупка_${slug}_${almatyDateStamp(date)}.xlsx`;
}

function applySheetLayout(
  sheet: XLSX.WorkSheet,
  colWidths: number[],
  freezeRow = 1,
): void {
  sheet["!cols"] = colWidths.map((wch) => ({ wch }));
  sheet["!freeze"] = { xSplit: 0, ySplit: freezeRow, topLeftCell: `A${freezeRow + 1}`, view: "frozen" };
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1");
  if (range.e.r >= freezeRow) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: freezeRow - 1, c: 0 },
        e: { r: range.e.r, c: range.e.c },
      }),
    };
  }
}

export function buildProcurementWorkbook(input: {
  analytics: ProcurementAnalytics;
  catalog: FactoryCatalog;
  lines: ProcurementReportLine[];
}): { workbook: XLSX.WorkBook; fileName: string } {
  const { analytics, catalog, lines } = input;
  const included = lines.filter((line) => line.included && line.orderQty > 0);
  const settings = analytics.snapshot.settings;
  const today = almatyDateStamp();
  const missingWeight = included.filter(
    (line) => line.product.weight_kg == null || line.product.weight_kg <= 0,
  ).length;
  const netWeight = included.reduce((sum, line) => {
    if (line.product.weight_kg == null || line.product.weight_kg <= 0) return sum;
    return sum + line.product.weight_kg * line.orderQty;
  }, 0);

  const header: (string | number)[][] = [
    ["DEKORO"],
    ["Рекомендуемый заказ"],
    ["Каталог", excelSafeText(catalog.name)],
    ["Дата формирования", today],
    ["Период анализа", `${analytics.snapshot.period.sales_90_from} — ${analytics.snapshot.period.today}`],
    ["Плановый срок поставки, дн.", settings.lead_time_days],
    ["Страховой запас, дн.", settings.safety_stock_days],
    [
      "Веса скорости 7/30/90",
      `${settings.velocity_weight_7} / ${settings.velocity_weight_30} / ${settings.velocity_weight_90}`,
    ],
    ["Позиций в заказе", included.length],
    ["Итого заказать, шт.", included.reduce((sum, line) => sum + line.orderQty, 0)],
    [
      "Ориентировочный вес, кг",
      missingWeight === included.length && included.length > 0 ? "" : Math.round(netWeight * 1000) / 1000,
    ],
    missingWeight > 0 ? ["Внимание", `Для ${missingWeight} SKU вес не задан`] : ["Внимание", ""],
    [],
    [
      "№",
      "SKU DEKORO",
      "SKU поставщика",
      "Наименование",
      "Спецификация",
      "Остаток",
      "Резерв",
      "Доступно",
      "В пути",
      "Продажи 7д",
      "Продажи 30д",
      "Продажи 90д",
      "Дней запаса",
      "Рекомендовано системой",
      "Заказать",
      "Примечание",
    ],
  ];

  const orderRows = included.map((line, index) => [
    index + 1,
    excelSafeText(line.product.sku),
    excelSafeText(line.product.original_sku ?? ""),
    excelSafeText(line.product.name),
    excelSafeText(line.product.dimensions ?? ""),
    line.product.physical_qty,
    line.product.reserved_qty,
    line.product.available_qty,
    line.product.incoming_qty,
    line.product.sales_7,
    line.product.sales_30,
    line.product.sales_90,
    daysLabel(line.product.daysOfStock),
    line.product.recommendedQty,
    line.orderQty,
    excelSafeText(line.note),
  ]);

  const orderSheet = XLSX.utils.aoa_to_sheet([...header, ...orderRows]);
  applySheetLayout(orderSheet, [6, 14, 16, 36, 18, 10, 10, 10, 10, 10, 12, 12, 12, 16, 12, 28], 14);

  const analyticsHeader = [
    [
      "SKU",
      "Наименование",
      "Каталоги",
      "Универсальный",
      "Можно заказать у",
      "Предпочтительный каталог",
      "Остаток",
      "Резерв",
      "Доступно",
      "В пути",
      "Расшифровка в пути",
      "7д",
      "30д",
      "90д",
      "История, дн.",
      "Ср. в день (7)",
      "Ср. в день (30)",
      "Ср. в день (90)",
      "Ср. в день (взвеш.)",
      "Целевой запас",
      "Эффективный остаток",
      "Дней запаса",
      "Рекомендовано",
      "Заказать",
      "Статус",
      "Причина",
      "Вес 1 шт, кг",
      "Вес заказа, кг",
    ],
  ];

  const analyticsRows = lines.map((line) => [
    excelSafeText(line.product.sku),
    excelSafeText(line.product.name),
    excelSafeText(line.product.catalogs.map((c) => c.name).join(" / ")),
    line.product.is_universal ? "да" : "нет",
    excelSafeText(line.allocationCatalogName ?? line.product.catalogs.map((c) => c.name).join(" / ")),
    excelSafeText(
      line.product.catalogs.find((c) => c.id === line.product.preferred_catalog_id)?.name ?? "",
    ),
    line.product.physical_qty,
    line.product.reserved_qty,
    line.product.available_qty,
    line.product.incoming_qty,
    excelSafeText(line.product.incoming_breakdown.map((b) => b.label).join("; ")),
    line.product.sales_7,
    line.product.sales_30,
    line.product.sales_90,
    line.product.history_days,
    Math.round(line.product.daily7 * 1000) / 1000,
    Math.round(line.product.daily30 * 1000) / 1000,
    Math.round(line.product.daily90 * 1000) / 1000,
    Math.round(line.product.avgDailySales * 1000) / 1000,
    line.product.targetStock,
    line.product.effectiveStock,
    daysLabel(line.product.daysOfStock),
    line.product.recommendedQty,
    line.included ? line.orderQty : 0,
    PROCUREMENT_STATUS_LABELS[line.product.status],
    excelSafeText(line.product.reason),
    num(line.product.weight_kg),
    line.product.weight_kg != null ? Math.round(line.product.weight_kg * line.orderQty * 1000) / 1000 : "",
  ]);

  const formulaSheet = XLSX.utils.aoa_to_sheet([
    ["Формула рекомендации"],
    [analytics.formula_text],
    [],
    ["Лист «Заказ» можно отправлять поставщику. Лист «Аналитика» — внутренний."],
    ...analyticsHeader,
    ...analyticsRows,
  ]);
  applySheetLayout(formulaSheet, [14, 36, 24, 12, 24, 22, 10, 10, 10, 10, 40, 8, 8, 8, 12, 12, 12, 12, 14, 12, 14, 12, 14, 10, 22, 40, 12, 14], 5);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, orderSheet, "Заказ");
  XLSX.utils.book_append_sheet(workbook, formulaSheet, "Аналитика");

  return {
    workbook,
    fileName: procurementExcelFileName(catalog.name),
  };
}

export function downloadProcurementExcel(input: {
  analytics: ProcurementAnalytics;
  catalog: FactoryCatalog;
  lines: ProcurementReportLine[];
}): string {
  const { workbook, fileName } = buildProcurementWorkbook(input);
  XLSX.writeFile(workbook, fileName);
  return fileName;
}
