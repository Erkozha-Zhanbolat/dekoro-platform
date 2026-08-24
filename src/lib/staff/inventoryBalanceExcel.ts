import * as XLSX from "xlsx";
import {
  almatyDateStamp,
  excelSafeText,
} from "@/lib/staff/inventoryReconciliationParse";
import type { InventoryBalanceProduct, InventoryBalanceReport } from "@/lib/staff/inventoryBalance";
import {
  PRODUCT_SUPPLY_LOGISTICS_LABELS,
  PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS,
  type ProductSupplyLogisticsStatus,
  type ProductSupplyReceivingStatus,
} from "@/types/database";

function num(n: number | null | undefined): number | "" {
  if (n == null || !Number.isFinite(n)) return "";
  return n;
}

function logisticsLabel(status: string): string {
  return (
    PRODUCT_SUPPLY_LOGISTICS_LABELS[status as ProductSupplyLogisticsStatus] ??
    status
  );
}

function receivingLabel(status: string): string {
  return (
    PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS[status as ProductSupplyReceivingStatus] ??
    status
  );
}

function applySheetLayout(
  sheet: XLSX.WorkSheet,
  colWidths: number[],
  freezeRow = 1,
): void {
  sheet["!cols"] = colWidths.map((wch) => ({ wch }));
  sheet["!freeze"] = {
    xSplit: 0,
    ySplit: freezeRow,
    topLeftCell: `A${freezeRow + 1}`,
    view: "frozen",
  };
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

export function inventoryBalanceExcelFileName(date = new Date()): string {
  return `DEKORO_Остатки_${almatyDateStamp(date)}.xlsx`;
}

export function buildInventoryBalanceWorkbook(input: {
  report: InventoryBalanceReport;
  products: InventoryBalanceProduct[];
}): { workbook: XLSX.WorkBook; fileName: string } {
  const { report, products } = input;
  const today = almatyDateStamp();
  const warehouseCode = report.warehouse.code || "ALMATY-01";

  const header: (string | number)[][] = [
    ["DEKORO"],
    ["Отчёт по остаткам"],
    ["Дата формирования", today],
    ["Склад", warehouseCode],
    ["Позиций", products.length],
    [],
    [
      "№",
      "SKU DEKORO",
      "SKU поставщика",
      "Товар",
      "Категория",
      "Подкатегория",
      "Физический остаток",
      "Резерв",
      "Доступно",
      "В пути",
      "Ожидаемо доступно",
      "Вес единицы, кг",
      "Заводской каталог",
      "Примечание",
    ],
  ];

  const balanceRows = products.map((p, index) => {
    const notes: string[] = [];
    if (p.available_qty <= 0) notes.push("Нет в наличии");
    if (p.reserved_qty > 0) notes.push("Есть резерв");
    if (p.incoming_qty > 0) notes.push("В пути");
    return [
      index + 1,
      excelSafeText(p.sku),
      excelSafeText(p.original_sku ?? ""),
      excelSafeText(p.name),
      excelSafeText(p.category_name ?? ""),
      excelSafeText(p.subcategory_name ?? ""),
      p.physical_qty,
      p.reserved_qty,
      p.available_qty,
      p.incoming_qty,
      p.expected_available_qty,
      num(p.weight_kg),
      excelSafeText(p.catalogs.map((c) => c.name).join(", ")),
      excelSafeText(notes.join("; ")),
    ];
  });

  const balanceSheet = XLSX.utils.aoa_to_sheet([...header, ...balanceRows]);
  applySheetLayout(
    balanceSheet,
    [6, 14, 16, 36, 18, 18, 14, 10, 10, 10, 14, 12, 28, 24],
    7,
  );

  // Bold title rows (best-effort via cell style is limited in community xlsx;
  // freeze + autofilter already applied).
  const titleCell = balanceSheet["A1"];
  if (titleCell) titleCell.s = { font: { bold: true } };
  const subtitleCell = balanceSheet["A2"];
  if (subtitleCell) subtitleCell.s = { font: { bold: true } };

  const incomingHeader = [
    [
      "№",
      "Supply / поставка",
      "SKU",
      "Товар",
      "Количество",
      "Logistics status",
      "Receiving status",
      "Маршрут / label",
      "ETA",
    ],
  ];

  const incomingRows: (string | number)[][] = [];
  let incomingIndex = 0;
  for (const product of products) {
    if (product.incoming_qty <= 0) continue;
    for (const line of product.incoming_breakdown) {
      incomingIndex += 1;
      incomingRows.push([
        incomingIndex,
        excelSafeText(line.supply_number),
        excelSafeText(product.sku),
        excelSafeText(product.name),
        line.quantity,
        excelSafeText(logisticsLabel(String(line.logistics_status))),
        excelSafeText(receivingLabel(String(line.receiving_status))),
        excelSafeText(line.label || logisticsLabel(String(line.logistics_status))),
        // ETA is not stored on supplies — do not invent.
        "",
      ]);
    }
  }

  const incomingSheet = XLSX.utils.aoa_to_sheet([
    ["DEKORO"],
    ["В пути — расшифровка"],
    ["Дата формирования", today],
    ["Склад", warehouseCode],
    ["Строк", incomingRows.length],
    [],
    ...incomingHeader,
    ...incomingRows,
  ]);
  applySheetLayout(incomingSheet, [6, 16, 14, 36, 12, 22, 16, 22, 12], 7);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, balanceSheet, "Остатки");
  XLSX.utils.book_append_sheet(workbook, incomingSheet, "В пути");

  return {
    workbook,
    fileName: inventoryBalanceExcelFileName(),
  };
}

export function downloadInventoryBalanceExcel(input: {
  report: InventoryBalanceReport;
  products: InventoryBalanceProduct[];
}): string {
  const { workbook, fileName } = buildInventoryBalanceWorkbook(input);
  XLSX.writeFile(workbook, fileName);
  return fileName;
}
