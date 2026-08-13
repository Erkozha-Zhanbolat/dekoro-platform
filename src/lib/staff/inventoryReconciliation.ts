import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";
import type {
  InventoryReconciliationApplyResult,
  InventoryReconciliationItem,
  InventoryReconciliationListItem,
  InventoryReconciliationMatchStatus,
  InventoryReconciliationPayload,
  InventoryReconciliationStatus,
} from "@/types/database";
import {
  RECONCILIATION_MAX_FILE_BYTES,
  RECONCILIATION_MAX_ROWS,
  almatyDateStamp,
  cellToDisplay,
  excelSafeText,
  findHeaderRowIndex,
  isExcelFileName,
  safeExcelFileName,
  type ColumnMapping,
  type ExcelCell,
  type ParsedWorkbook,
  type SourceRowPayload,
} from "@/lib/staff/inventoryReconciliationParse";

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asInt(value: unknown, fallback = 0): number {
  const n = asNumber(value);
  return n == null ? fallback : Math.trunc(n);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapItem(row: Record<string, unknown>): InventoryReconciliationItem {
  return {
    id: String(row.id),
    reconciliation_id: String(row.reconciliation_id),
    product_id: row.product_id == null ? null : String(row.product_id),
    product_name: row.product_name == null ? null : String(row.product_name),
    product_sku: row.product_sku == null ? null : String(row.product_sku),
    source_sku: row.source_sku == null ? null : String(row.source_sku),
    source_name: row.source_name == null ? null : String(row.source_name),
    source_quantity: asNumber(row.source_quantity),
    platform_quantity: asNumber(row.platform_quantity),
    reserved_quantity: asNumber(row.reserved_quantity),
    available_quantity: asNumber(row.available_quantity),
    difference: asNumber(row.difference),
    match_status: row.match_status as InventoryReconciliationItem["match_status"],
    apply_status: row.apply_status as InventoryReconciliationItem["apply_status"],
    conflict_code:
      row.conflict_code == null
        ? null
        : (row.conflict_code as InventoryReconciliationItem["conflict_code"]),
    conflict_message: row.conflict_message == null ? null : String(row.conflict_message),
    applied_quantity: asNumber(row.applied_quantity),
    applied_adjustment_id:
      row.applied_adjustment_id == null ? null : String(row.applied_adjustment_id),
    source_row_number: row.source_row_number == null ? null : asInt(row.source_row_number, 0),
    duplicate_count: row.duplicate_count == null ? null : asInt(row.duplicate_count, 0),
    error_message: row.error_message == null ? null : String(row.error_message),
    created_at: String(row.created_at ?? ""),
  };
}

function mapReconciliation(row: Record<string, unknown>): InventoryReconciliationPayload["reconciliation"] {
  return {
    id: String(row.id),
    reconciliation_number: String(row.reconciliation_number),
    source_type: "1c_excel",
    source_file_name: String(row.source_file_name),
    warehouse_id: String(row.warehouse_id ?? ""),
    status: row.status as InventoryReconciliationStatus,
    total_rows: asInt(row.total_rows),
    matched_rows: asInt(row.matched_rows),
    equal_rows: asInt(row.equal_rows),
    different_rows: asInt(row.different_rows),
    missing_in_dekoro_rows: asInt(row.missing_in_dekoro_rows),
    missing_in_source_rows: asInt(row.missing_in_source_rows),
    duplicate_rows: asInt(row.duplicate_rows),
    invalid_rows: asInt(row.invalid_rows),
    applied_rows: asInt(row.applied_rows),
    created_by: String(row.created_by ?? ""),
    created_by_name: row.created_by_name == null ? null : String(row.created_by_name),
    created_at: String(row.created_at ?? ""),
    applied_by: row.applied_by == null ? null : String(row.applied_by),
    applied_by_name: row.applied_by_name == null ? null : String(row.applied_by_name),
    applied_at: row.applied_at == null ? null : String(row.applied_at),
    cancelled_by: row.cancelled_by == null ? null : String(row.cancelled_by),
    cancelled_at: row.cancelled_at == null ? null : String(row.cancelled_at),
    metadata: asRecord(row.metadata),
  };
}

function mapPayload(raw: unknown): InventoryReconciliationPayload {
  const data = asRecord(raw);
  const header = asRecord(data.reconciliation);
  const items = Array.isArray(data.items) ? data.items : [];
  const applyRaw = data.apply_result == null ? null : asRecord(data.apply_result);
  const apply_result: InventoryReconciliationApplyResult | undefined = applyRaw
    ? {
        applied_count: asInt(applyRaw.applied_count),
        stale_count: asInt(applyRaw.stale_count),
        reservation_conflict_count: asInt(applyRaw.reservation_conflict_count),
        already_applied_count: asInt(applyRaw.already_applied_count),
        skipped_count: asInt(applyRaw.skipped_count),
        increased_count: asInt(applyRaw.increased_count),
        decreased_count: asInt(applyRaw.decreased_count),
      }
    : undefined;

  return {
    reconciliation: mapReconciliation(header),
    items: items.map((item) => mapItem(asRecord(item))),
    apply_result,
  };
}

function rpcError(error: { message?: string }, fallback: string): Error {
  return new Error(error.message || fallback);
}

export async function parseExcelFile(file: File): Promise<ParsedWorkbook> {
  if (file.size > RECONCILIATION_MAX_FILE_BYTES) {
    throw new Error("Файл слишком большой (максимум 8 МБ)");
  }

  const fileName = safeExcelFileName(file.name);
  if (!isExcelFileName(fileName)) {
    throw new Error("Нужен файл Excel (.xlsx или .xls)");
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: true, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("В файле нет листов");
  }

  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<ExcelCell[]>(sheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  });

  if (matrix.length === 0) {
    throw new Error("Файл пустой");
  }

  const headerRowIndex = findHeaderRowIndex(matrix);
  const headerCells = matrix[headerRowIndex] ?? [];
  const headers = headerCells.map((cell, index) => {
    const label = cellToDisplay(cell);
    return label || `Колонка ${index + 1}`;
  });

  const dataRows = matrix.slice(headerRowIndex + 1);
  if (dataRows.length > RECONCILIATION_MAX_ROWS) {
    throw new Error("Слишком много строк (максимум 10 000)");
  }

  return {
    fileName,
    sheetName,
    headers,
    headerRowIndex,
    rows: dataRows,
    totalDataRows: dataRows.length,
  };
}

export async function createInventoryReconciliation(input: {
  fileName: string;
  mapping: ColumnMapping;
  sheetName: string;
  rows: SourceRowPayload[];
}): Promise<InventoryReconciliationPayload> {
  if (input.rows.length > RECONCILIATION_MAX_ROWS) {
    throw new Error("Слишком много строк (максимум 10 000)");
  }

  const { data, error } = await supabase.rpc("staff_create_inventory_reconciliation", {
    p_source_file_name: safeExcelFileName(input.fileName),
    p_rows: input.rows,
    p_column_mapping: {
      sku_column: input.mapping.skuColumn,
      name_column: input.mapping.nameColumn,
      quantity_column: input.mapping.quantityColumn,
      sheet_name: input.sheetName.slice(0, 80),
    },
  });

  if (error) throw rpcError(error, "Не удалось выполнить сверку");
  return mapPayload(data);
}

export async function getInventoryReconciliation(
  id: string,
): Promise<InventoryReconciliationPayload> {
  const { data, error } = await supabase.rpc("staff_get_inventory_reconciliation", {
    p_reconciliation_id: id,
  });
  if (error) throw rpcError(error, "Не удалось загрузить сверку");
  return mapPayload(data);
}

export async function listInventoryReconciliations(
  limit = 50,
): Promise<InventoryReconciliationListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_inventory_reconciliations", {
    p_limit: limit,
  });
  if (error) throw rpcError(error, "Не удалось загрузить историю сверок");

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => {
    const r = asRecord(row);
    return {
      id: String(r.id),
      reconciliation_number: String(r.reconciliation_number),
      source_file_name: String(r.source_file_name),
      status: r.status as InventoryReconciliationStatus,
      total_rows: asInt(r.total_rows),
      matched_rows: asInt(r.matched_rows),
      equal_rows: asInt(r.equal_rows),
      different_rows: asInt(r.different_rows),
      missing_in_dekoro_rows: asInt(r.missing_in_dekoro_rows),
      missing_in_source_rows: asInt(r.missing_in_source_rows),
      duplicate_rows: asInt(r.duplicate_rows),
      invalid_rows: asInt(r.invalid_rows),
      applied_rows: asInt(r.applied_rows),
      created_by: String(r.created_by ?? ""),
      created_by_name: r.created_by_name == null ? null : String(r.created_by_name),
      created_at: String(r.created_at ?? ""),
      applied_by: r.applied_by == null ? null : String(r.applied_by),
      applied_by_name: r.applied_by_name == null ? null : String(r.applied_by_name),
      applied_at: r.applied_at == null ? null : String(r.applied_at),
    };
  });
}

export async function applyInventoryReconciliation(
  reconciliationId: string,
  itemIds: string[],
): Promise<InventoryReconciliationPayload> {
  const { data, error } = await supabase.rpc("staff_apply_inventory_reconciliation", {
    p_reconciliation_id: reconciliationId,
    p_item_ids: itemIds,
  });
  if (error) throw rpcError(error, "Не удалось применить сверку");
  return mapPayload(data);
}

export async function cancelInventoryReconciliation(
  reconciliationId: string,
): Promise<InventoryReconciliationPayload> {
  const { data, error } = await supabase.rpc("staff_cancel_inventory_reconciliation", {
    p_reconciliation_id: reconciliationId,
  });
  if (error) throw rpcError(error, "Не удалось отменить сверку");
  return mapPayload(data);
}

function matchLabel(status: InventoryReconciliationMatchStatus): string {
  switch (status) {
    case "matched_equal":
      return "Совпадает";
    case "matched_difference":
      return "Расхождение";
    case "missing_in_dekoro":
      return "Не найден в DEKORO";
    case "missing_in_source":
      return "Нет в загруженном файле";
    case "duplicate_source":
      return "Дубликат в файле";
    case "invalid":
      return "Ошибка";
    default:
      return status;
  }
}

function applyLabel(item: InventoryReconciliationItem): string {
  if (item.apply_status === "applied") return "Да";
  if (item.conflict_code === "stale") return "Конфликт (остаток изменился)";
  if (item.conflict_code === "reservation_conflict") return "Конфликт (резерв)";
  if (item.apply_status === "skipped") return "Пропущено";
  return "Нет";
}

function exportRow(item: InventoryReconciliationItem) {
  return {
    SKU: excelSafeText(item.product_sku ?? item.source_sku ?? ""),
    Product: excelSafeText(item.product_name ?? item.source_name ?? ""),
    "DEKORO before": item.platform_quantity,
    "1C": item.source_quantity,
    Difference: item.difference,
    Reserved: item.reserved_quantity,
    Available: item.available_quantity,
    Status: matchLabel(item.match_status),
    Applied: applyLabel(item),
    "DEKORO after":
      item.apply_status === "applied"
        ? item.applied_quantity
        : item.platform_quantity,
  };
}

export function downloadReconciliationExcel(
  payload: InventoryReconciliationPayload,
): void {
  const { reconciliation, items } = payload;
  const summary = [
    { Field: "Номер", Value: reconciliation.reconciliation_number },
    { Field: "Файл", Value: reconciliation.source_file_name },
    { Field: "Статус", Value: reconciliation.status },
    { Field: "Товаров в файле", Value: reconciliation.total_rows },
    { Field: "Совпало", Value: reconciliation.matched_rows },
    { Field: "Расхождений", Value: reconciliation.different_rows },
    { Field: "Не найдено в DEKORO", Value: reconciliation.missing_in_dekoro_rows },
    { Field: "Нет в загруженном файле", Value: reconciliation.missing_in_source_rows },
    { Field: "Ошибок/дубликатов", Value: reconciliation.duplicate_rows + reconciliation.invalid_rows },
    { Field: "Применено", Value: reconciliation.applied_rows },
  ];

  const sheets: Record<string, unknown[]> = {
    Summary: summary,
    Differences: items.filter((i) => i.match_status === "matched_difference").map(exportRow),
    "Missing in DEKORO": items.filter((i) => i.match_status === "missing_in_dekoro").map(exportRow),
    "Missing in file": items.filter((i) => i.match_status === "missing_in_source").map(exportRow),
    Errors: items
      .filter((i) => i.match_status === "invalid" || i.match_status === "duplicate_source")
      .map(exportRow),
    Applied: items.filter((i) => i.apply_status === "applied").map(exportRow),
  };

  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet =
      rows.length === 0
        ? XLSX.utils.aoa_to_sheet([["(пусто)"]])
        : XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, sheet, name.slice(0, 31));
  }

  const fileName = `DEKORO_Сверка_1С_${almatyDateStamp()}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

export function isApplyableItem(item: InventoryReconciliationItem): boolean {
  if (item.match_status !== "matched_difference") return false;
  if (item.apply_status !== "pending") return false;
  if (item.conflict_code === "reservation_conflict") return false;
  if (item.conflict_code === "stale") return false;
  const source = item.source_quantity;
  const reserved = item.reserved_quantity ?? 0;
  if (source == null || source < reserved) return false;
  return true;
}
