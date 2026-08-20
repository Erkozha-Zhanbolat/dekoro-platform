import type { ExcelCell, HeaderField, HeaderMapping, SupplyParserProfile } from "./types";
import { cellToDisplay, normalizeHeader } from "./normalize";

const FIELD_ALIASES: Record<HeaderField, readonly string[]> = {
  ownCode: ["own code", "owncode", "own_code", "артикул", "sku", "dekoro sku", "внутренний код"],
  supplierCode: [
    "行号",
    "supplier code",
    "suppliercode",
    "original sku",
    "original_sku",
    "код поставщика",
    "factory code",
    "item no",
    "itemno",
  ],
  name: ["产品名称", "наименование", "название", "name", "product name", "goods name"],
  spec: ["规格型号", "spec", "specification", "size", "размер", "модель", "规格"],
  unit: ["单位", "unit", "ед", "ед.", "ед изм", "uom"],
  quantity: [
    "实发数量",
    "数量",
    "qty",
    "quantity",
    "количество",
    "ordered qty",
    "shipped qty",
    "order qty",
  ],
  price: ["销售单价", "单价", "price", "unit price", "цена", "закупочная цена"],
  amount: ["销售金额", "金额", "amount", "total", "сумма", "amount rmb"],
  notes: ["备注", "note", "notes", "remark", "примечание"],
};

export function findHeaderRowIndex(matrix: ExcelCell[][]): number {
  const limit = Math.min(matrix.length, 25);
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const headers = (matrix[i] ?? []).map((cell) => cellToDisplay(cell));
    const score = scoreHeaders(headers);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function scoreHeaders(headers: string[]): number {
  const mapping = mapHeadersByAliases(headers);
  let score = 0;
  if (mapping.ownCode != null) score += 4;
  if (mapping.supplierCode != null) score += 3;
  if (mapping.name != null) score += 3;
  if (mapping.quantity != null) score += 4;
  if (mapping.price != null) score += 2;
  if (mapping.amount != null) score += 2;
  if (mapping.unit != null) score += 1;
  if (mapping.spec != null) score += 1;
  return score;
}

export function mapHeadersByAliases(headers: string[]): HeaderMapping {
  const normalized = headers.map((h) => normalizeHeader(h));
  const mapping: HeaderMapping = {};
  (Object.keys(FIELD_ALIASES) as HeaderField[]).forEach((field) => {
    const aliases = FIELD_ALIASES[field];
    const index = normalized.findIndex((h) => h !== "" && aliases.includes(h));
    if (index >= 0) mapping[field] = index;
  });
  return mapping;
}

export function headersFromRow(row: ExcelCell[]): string[] {
  return row.map((cell, index) => {
    const label = cellToDisplay(cell);
    return label || `Колонка ${index + 1}`;
  });
}

/** Built-in profile for Chinese factory order / packing-style Excel (OWN CODE + 行号). */
export const aslanCnOrderProfile: SupplyParserProfile = {
  id: "aslan_cn_order",
  label: "Китайский заказ / накладная (OWN CODE)",
  detect: (headers) => {
    const mapping = mapHeadersByAliases(headers);
    if (mapping.ownCode == null && mapping.supplierCode == null) return 0;
    if (mapping.quantity == null) return 0;
    return scoreHeaders(headers) + 5;
  },
  mapHeaders: mapHeadersByAliases,
};

export const SUPPLY_PARSER_PROFILES: readonly SupplyParserProfile[] = [aslanCnOrderProfile];

export function detectParserProfile(headers: string[]): SupplyParserProfile {
  let best = SUPPLY_PARSER_PROFILES[0];
  let bestScore = -1;
  for (const profile of SUPPLY_PARSER_PROFILES) {
    const score = profile.detect(headers);
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  }
  if (bestScore < 6) {
    throw new Error(
      "Не удалось распознать колонки Excel. Нужны OWN CODE / код поставщика, количество и цена.",
    );
  }
  return best;
}
