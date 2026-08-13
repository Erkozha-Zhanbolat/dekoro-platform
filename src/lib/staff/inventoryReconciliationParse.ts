/**
 * Client-side 1C Excel parse / column mapping / validation.
 * Inventory is never written here — rows go to staff_create_inventory_reconciliation.
 */

export const RECONCILIATION_MAX_ROWS = 10_000;
export const RECONCILIATION_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const RECONCILIATION_MAX_QUANTITY = 1_000_000_000;

export type ExcelCell = string | number | boolean | Date | null | undefined;

export type ParsedWorkbook = {
  fileName: string;
  sheetName: string;
  headers: string[];
  headerRowIndex: number;
  rows: ExcelCell[][];
  totalDataRows: number;
};

export type ColumnMapping = {
  skuColumn: string;
  nameColumn: string;
  quantityColumn: string;
};

export type SourceRowPayload = {
  row_number: number;
  sku: string;
  name: string | null;
  quantity: number | null;
};

export type PreviewRowIssue = {
  rowNumber: number;
  sku: string;
  message: string;
};

export type MappingPreview = {
  recognized: number;
  errorCount: number;
  duplicateCount: number;
  issues: PreviewRowIssue[];
  payload: SourceRowPayload[];
};

const SKU_HEADER_HINTS = new Set([
  "артикул",
  "код",
  "sku",
  "номенклатура.код",
  "код номенклатуры",
  "артикул номенклатуры",
  "кодтовара",
  "article",
]);

const NAME_HEADER_HINTS = new Set([
  "наименование",
  "номенклатура",
  "название",
  "товар",
  "name",
  "номенклатура.наименование",
]);

const QTY_HEADER_HINTS = new Set([
  "остаток",
  "количество",
  "конечный остаток",
  "остаток конечный",
  "qty",
  "quantity",
  "кол-во",
  "колво",
  "количество остаток",
  "конечныйостаток",
]);

export function safeExcelFileName(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const cleaned = base.replace(/\u0000/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "ostatki.xlsx";
  }
  return cleaned.slice(0, 255);
}

export function isExcelFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

export function normalizeHeader(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Conservative SKU key: trim only. No hyphen stripping, no J-01 → J01. */
export function normalizeSku(value: string): string {
  return value.replace(/\u00a0/g, " ").trim();
}

export function cellToDisplay(value: ExcelCell): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-9) {
      return String(Math.round(value));
    }
    return String(value);
  }
  return String(value).replace(/\u00a0/g, " ").trim();
}

export function parseQuantityCell(value: ExcelCell): {
  ok: boolean;
  value: number | null;
  error: string | null;
} {
  if (value == null || value === "") {
    return { ok: false, value: null, error: "Пустое количество" };
  }
  if (typeof value === "boolean") {
    return { ok: false, value: null, error: "Некорректное количество" };
  }
  if (value instanceof Date) {
    return { ok: false, value: null, error: "Некорректное количество" };
  }

  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else {
    const asText = String(value).replace(/\u00a0/g, " ").trim();
    if (asText.startsWith("=")) {
      return { ok: false, value: null, error: "Формула без вычисленного значения" };
    }
    const raw = asText.replace(/\s/g, "").replace(",", ".");
    if (!raw) return { ok: false, value: null, error: "Пустое количество" };
    const lower = raw.toLowerCase();
    if (
      lower === "nan" ||
      lower === "infinity" ||
      lower === "+infinity" ||
      lower === "-infinity" ||
      lower === "inf" ||
      lower === "+inf" ||
      lower === "-inf"
    ) {
      return { ok: false, value: null, error: "Некорректное количество" };
    }
    if (!/^[+-]?[0-9]+(\.[0-9]+)?$/.test(raw)) {
      return { ok: false, value: null, error: "Некорректное количество" };
    }
    numeric = Number(raw);
  }

  if (!Number.isFinite(numeric)) {
    return { ok: false, value: null, error: "Некорректное количество" };
  }
  if (numeric < 0) {
    return { ok: false, value: null, error: "Отрицательный остаток" };
  }
  if (numeric > RECONCILIATION_MAX_QUANTITY) {
    return { ok: false, value: null, error: "Слишком большое количество" };
  }
  const scaled = Math.round(numeric * 1000) / 1000;
  return { ok: true, value: scaled, error: null };
}

/** Prevent Excel from treating exported SKU/name as a formula. */
export function excelSafeText(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (text !== "" && /^[=+\-@\t\r]/.test(text)) {
    return `'${text}`;
  }
  return text;
}

export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map((h) => normalizeHeader(h));
  const skuIndex = normalized.findIndex((h) => SKU_HEADER_HINTS.has(h));
  const qtyIndex = normalized.findIndex((h) => QTY_HEADER_HINTS.has(h));
  let nameIndex = normalized.findIndex((h) => NAME_HEADER_HINTS.has(h));
  if (nameIndex >= 0 && (nameIndex === skuIndex || nameIndex === qtyIndex)) {
    nameIndex = normalized.findIndex(
      (h, i) => NAME_HEADER_HINTS.has(h) && i !== skuIndex && i !== qtyIndex,
    );
  }

  return {
    skuColumn: skuIndex >= 0 ? headers[skuIndex] : "",
    nameColumn: nameIndex >= 0 ? headers[nameIndex] : "",
    quantityColumn: qtyIndex >= 0 ? headers[qtyIndex] : "",
  };
}

export function findHeaderRowIndex(matrix: ExcelCell[][]): number {
  const limit = Math.min(matrix.length, 20);
  for (let i = 0; i < limit; i++) {
    const cells = (matrix[i] ?? []).map((c) => normalizeHeader(cellToDisplay(c)));
    const hasSku = cells.some((c) => SKU_HEADER_HINTS.has(c));
    const hasQty = cells.some((c) => QTY_HEADER_HINTS.has(c));
    if (hasSku || hasQty) return i;
  }
  return 0;
}

export function buildMappingPreview(
  headers: string[],
  dataRows: ExcelCell[][],
  mapping: ColumnMapping,
  headerRowIndex: number,
): MappingPreview {
  const skuIdx = headers.indexOf(mapping.skuColumn);
  const qtyIdx = headers.indexOf(mapping.quantityColumn);
  const nameIdx = mapping.nameColumn ? headers.indexOf(mapping.nameColumn) : -1;

  const issues: PreviewRowIssue[] = [];
  const payload: SourceRowPayload[] = [];
  const skuCounts = new Map<string, number>();

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i] ?? [];
    const sku = skuIdx >= 0 ? normalizeSku(cellToDisplay(row[skuIdx])) : "";
    const nameRaw = nameIdx >= 0 ? cellToDisplay(row[nameIdx]) : "";
    const qtyCell = qtyIdx >= 0 ? row[qtyIdx] : null;
    const rowNumber = headerRowIndex + 2 + i;

    if (!sku && (qtyCell == null || qtyCell === "") && !nameRaw) {
      continue;
    }

    const qty = parseQuantityCell(qtyCell);
    let error: string | null = null;
    if (!sku) error = "Пустой артикул";
    else if (!qty.ok) error = qty.error;

    if (sku) {
      skuCounts.set(sku, (skuCounts.get(sku) ?? 0) + 1);
    }

    payload.push({
      row_number: rowNumber,
      sku,
      name: nameRaw || null,
      quantity: qty.ok ? qty.value : null,
    });

    if (error) {
      issues.push({ rowNumber, sku, message: error });
    }
  }

  let duplicateCount = 0;
  for (const [sku, count] of skuCounts) {
    if (count > 1) {
      duplicateCount += count;
      for (const row of payload) {
        if (row.sku === sku) {
          issues.push({
            rowNumber: row.row_number,
            sku,
            message: `Артикул встречается в файле ${count} раз`,
          });
        }
      }
    }
  }

  const errorCount = issues.length;
  const recognized = payload.filter((row) => {
    const count = skuCounts.get(row.sku) ?? 0;
    return row.sku !== "" && row.quantity != null && count === 1;
  }).length;

  return { recognized, errorCount, duplicateCount, issues, payload };
}

export function formatQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

export function formatSignedQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = formatQty(Math.abs(value));
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

export function almatyDateStamp(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Lightweight checks used by the Stage 31 test matrix (parse layer). */
export function runParseSelfCheck(): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };

  check("trim-only sku", normalizeSku("  J-01  ") === "J-01");
  check("keep hyphen", normalizeSku("J-01") !== "J01");
  check("negative qty", parseQuantityCell(-5).error === "Отрицательный остаток");
  check("nan qty", parseQuantityCell("NaN").error === "Некорректное количество");
  check("inf qty", parseQuantityCell(Number.POSITIVE_INFINITY).error === "Некорректное количество");
  check("empty qty", parseQuantityCell("").error === "Пустое количество");
  check("ok qty comma", parseQuantityCell("125,5").ok && parseQuantityCell("125,5").value === 125.5);

  const preview = buildMappingPreview(
    ["Артикул", "Остаток"],
    [
      ["J01", 100],
      ["J01", 120],
    ],
    { skuColumn: "Артикул", nameColumn: "", quantityColumn: "Остаток" },
    0,
  );
  check("duplicate not summed", preview.duplicateCount === 2 && preview.recognized === 0);

  const mapping = suggestColumnMapping(["Номенклатура.Код", "Наименование", "Конечный остаток"]);
  check("auto sku", mapping.skuColumn === "Номенклатура.Код");
  check("auto qty", mapping.quantityColumn === "Конечный остаток");

  check("safe filename", safeExcelFileName("/tmp/../Остатки_1С.xlsx") === "Остатки_1С.xlsx");
  check("case-sensitive sku", normalizeSku("J01") === "J01" && normalizeSku("j01") === "j01");
  check("formula qty invalid", parseQuantityCell("=A1+2").error === "Формула без вычисленного значения");
  check("excel formula injection", excelSafeText("=CMD()") === "'=CMD()");
  check("excel plus injection", excelSafeText("+123") === "'+123");

  const sameQtyDup = buildMappingPreview(
    ["Артикул", "Остаток"],
    [
      ["J01", 100],
      ["J01", 100],
    ],
    { skuColumn: "Артикул", nameColumn: "", quantityColumn: "Остаток" },
    0,
  );
  check("duplicate same qty still duplicate", sameQtyDup.duplicateCount === 2 && sameQtyDup.recognized === 0);

  return failures;
}
