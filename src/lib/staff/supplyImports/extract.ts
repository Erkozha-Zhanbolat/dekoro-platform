import {
  SUPPLY_IMPORT_MAX_QUANTITY,
  type ExcelCell,
  type IgnoredSupplyRow,
  type ParsedSupplyRow,
  type ParsedWorkbookMatrix,
  type SupplyParseIssue,
  type SupplyParseResult,
} from "./types";
import { detectParserProfile, findHeaderRowIndex, headersFromRow } from "./headers";
import { cellToDisplay, parseNumericCell, rowPreview } from "./normalize";

const TOTAL_TOKENS = new Set([
  "合计",
  "小计",
  "总计",
  "total",
  "sum",
  "итого",
  "всего",
]);

const NON_PRODUCT_TOKENS = new Set([
  "托盘",
  "pallet",
  "pallets",
  "паллет",
  "паллеты",
  "тара",
]);

function isTotalToken(value: string | null): boolean {
  if (!value) return false;
  const n = value.trim().toLowerCase();
  return TOTAL_TOKENS.has(n);
}

function isNonProductToken(value: string | null): boolean {
  if (!value) return false;
  return NON_PRODUCT_TOKENS.has(value.trim().toLowerCase());
}

function pick(row: ExcelCell[], index: number | undefined): ExcelCell {
  if (index == null || index < 0) return null;
  return row[index] ?? null;
}

function textAt(row: ExcelCell[], index: number | undefined): string | null {
  const text = cellToDisplay(pick(row, index));
  return text || null;
}

function looksLikeCode(value: string | null): boolean {
  if (!value) return false;
  if (isTotalToken(value) || isNonProductToken(value)) return false;
  if (value.length > 40) return false;
  return /[A-Za-z0-9]/.test(value);
}

export function extractSupplyRows(workbook: ParsedWorkbookMatrix): SupplyParseResult {
  const headerRowIndex = findHeaderRowIndex(workbook.matrix);
  const headerCells = workbook.matrix[headerRowIndex] ?? [];
  const headers = headersFromRow(headerCells);
  const profile = detectParserProfile(headers);
  const mapping = profile.mapHeaders(headers);

  const rows: ParsedSupplyRow[] = [];
  const ignored: IgnoredSupplyRow[] = [];
  const issues: SupplyParseIssue[] = [];

  const dataRows = workbook.matrix.slice(headerRowIndex + 1);
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i] ?? [];
    const rowNumber = headerRowIndex + 2 + i;
    const ownCode = textAt(row, mapping.ownCode);
    const supplierCode = textAt(row, mapping.supplierCode);
    const name = textAt(row, mapping.name);
    const spec = textAt(row, mapping.spec);
    const unit = textAt(row, mapping.unit);
    const notes = textAt(row, mapping.notes);
    const qtyParsed = parseNumericCell(pick(row, mapping.quantity));
    const priceParsed = parseNumericCell(pick(row, mapping.price));
    const amountParsed = parseNumericCell(pick(row, mapping.amount));
    const qtyText = textAt(row, mapping.quantity);
    const priceText = textAt(row, mapping.price);

    const allText = [ownCode, supplierCode, name, spec, unit, notes, qtyText, priceText]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (
      !ownCode &&
      !supplierCode &&
      !name &&
      !spec &&
      qtyParsed.value == null &&
      priceParsed.value == null &&
      amountParsed.value == null &&
      !qtyText &&
      !priceText
    ) {
      continue;
    }

    if (
      isTotalToken(ownCode) ||
      isTotalToken(supplierCode) ||
      isTotalToken(name) ||
      isTotalToken(spec) ||
      isTotalToken(unit) ||
      isTotalToken(qtyText) ||
      [...TOTAL_TOKENS].some((token) => allText === token)
    ) {
      ignored.push({
        rowNumber,
        reason: "Итоговая строка",
        preview: rowPreview(row),
      });
      continue;
    }

    if (
      !looksLikeCode(ownCode) &&
      !looksLikeCode(supplierCode) &&
      isNonProductToken(spec || name)
    ) {
      ignored.push({
        rowNumber,
        reason: "Служебная позиция (тара / паллет)",
        preview: rowPreview(row),
      });
      continue;
    }

    if (!looksLikeCode(ownCode) && !looksLikeCode(supplierCode)) {
      ignored.push({
        rowNumber,
        reason: "Нет OWN CODE и кода поставщика — не товар",
        preview: rowPreview(row),
      });
      continue;
    }

    const rowIssues: string[] = [];
    if (!qtyParsed.ok) rowIssues.push(qtyParsed.error || "Некорректное количество");
    if (qtyParsed.ok && qtyParsed.value == null) rowIssues.push("Пустое количество");
    if (qtyParsed.value != null && qtyParsed.value <= 0) rowIssues.push("Количество должно быть больше 0");
    if (qtyParsed.value != null && qtyParsed.value > SUPPLY_IMPORT_MAX_QUANTITY) {
      rowIssues.push("Слишком большое количество");
    }
    if (!priceParsed.ok) rowIssues.push(priceParsed.error || "Некорректная цена");
    if (priceParsed.value != null && priceParsed.value < 0) rowIssues.push("Цена не может быть отрицательной");
    if (!amountParsed.ok) rowIssues.push(amountParsed.error || "Некорректная сумма");
    if (amountParsed.value != null && amountParsed.value < 0) rowIssues.push("Сумма не может быть отрицательной");
    if (!name && !spec) rowIssues.push("Нет названия и спецификации");

    const quantity =
      qtyParsed.ok && qtyParsed.value != null && qtyParsed.value > 0
        ? Math.round(qtyParsed.value * 1000) / 1000
        : null;
    const price =
      priceParsed.ok && priceParsed.value != null && priceParsed.value >= 0
        ? Math.round(priceParsed.value * 1_000_000) / 1_000_000
        : null;
    let amount =
      amountParsed.ok && amountParsed.value != null && amountParsed.value >= 0
        ? Math.round(amountParsed.value * 1_000_000) / 1_000_000
        : null;
    if (amount == null && quantity != null && price != null) {
      amount = Math.round(quantity * price * 1_000_000) / 1_000_000;
    }

    const parsed: ParsedSupplyRow = {
      rowNumber,
      ownCode,
      supplierCode,
      name,
      spec,
      unit,
      quantity,
      price,
      amount,
      notes,
      issues: rowIssues,
    };
    rows.push(parsed);

    for (const message of rowIssues) {
      issues.push({
        rowNumber,
        code: message.includes("количество")
          ? "invalid_quantity"
          : message.includes("цена") || message.includes("сумма")
            ? "invalid_price"
            : "invalid_row",
        message,
      });
    }
  }

  const ownCodeCounts = new Map<string, number>();
  for (const row of rows) {
    if (!row.ownCode) continue;
    ownCodeCounts.set(row.ownCode, (ownCodeCounts.get(row.ownCode) ?? 0) + 1);
  }
  const duplicateOwnCodes = [...ownCodeCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([code]) => code);

  for (const row of rows) {
    if (row.ownCode && (ownCodeCounts.get(row.ownCode) ?? 0) > 1) {
      const message = `OWN CODE «${row.ownCode}» повторяется в файле — строки не объединяются, каждая остаётся отдельной`;
      row.issues.push(message);
      issues.push({ rowNumber: row.rowNumber, code: "duplicate_sku", message });
    }
  }

  const validQty = rows.filter((r) => r.quantity != null);
  const totalQuantity = validQty.reduce((sum, r) => sum + (r.quantity ?? 0), 0);
  const totalAmount = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  return {
    profileId: profile.id,
    profileLabel: profile.label,
    fileName: workbook.fileName,
    sheetName: workbook.sheetName,
    headerRowIndex,
    headers,
    rows,
    ignored,
    issues,
    duplicateOwnCodes,
    totals: {
      parsedRows: rows.length,
      ignoredRows: ignored.length,
      invalidQuantityRows: rows.filter((r) => r.issues.some((m) => m.toLowerCase().includes("количество"))).length,
      invalidPriceRows: rows.filter((r) =>
        r.issues.some((m) => m.toLowerCase().includes("цена") || m.toLowerCase().includes("сумма")),
      ).length,
      unmatchedHintRows: 0,
      totalQuantity: Math.round(totalQuantity * 1000) / 1000,
      totalAmount: Math.round(totalAmount * 1_000_000) / 1_000_000,
    },
  };
}
