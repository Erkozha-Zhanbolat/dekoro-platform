import { extractSupplyRows } from "./extract";
import { mapHeadersByAliases, scoreHeaders } from "./headers";
import { cellToDisplay, normalizeHeader, parseNumericCell, safeExcelFileName } from "./normalize";
import type { ExcelCell, ParsedWorkbookMatrix } from "./types";

/** In-memory layout matching fixtures/sample_cn_supply.xlsx (fictional data only). */
export const SAMPLE_CN_SUPPLY_MATRIX: ExcelCell[][] = [
  ["", "", "SAMPLE BATCH", "DEMO CO"],
  ["", "", "synthetic fixture", ""],
  ["OWN CODE", "行号", "产品名称", "规格型号", "单位(*)", "实发数量(*)", "销售单价", "销售金额"],
  ["DK-S-001", "FAC-101", "Sample film A", "1.2*2.9", "张", 10, 12.5, 125],
  ["DK-S-002", "FAC-102", "Sample film B", "1.2*2.9", "张", 20, 15, 300],
  ["DK-S-003", "FAC-103", "Sample film C", "1.2*2.9", "张", 5, 20, 100],
  [null, null, "Demo section", null, null, null, null, 0],
  ["DK-S-001", "FAC-101", "Sample profile A", "148*3000", "支", 8, 4, 32],
  ["DK-S-004", "FAC-104", "Sample strip D", "148*3000", "支", 12, 4.5, 54],
  [null, null, null, "托盘", null, 2, 50, 100],
  [null, null, null, null, null, "合计", null, 611],
];

export function runSupplyImportSelfCheck(): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };

  check("normalize own code header", normalizeHeader("OWN CODE") === "own code");
  check("normalize starred qty", normalizeHeader("实发数量(*)") === "实发数量");
  check("safe filename", safeExcelFileName("/tmp/../sample_cn_supply.xlsx") === "sample_cn_supply.xlsx");
  check("qty comma", parseNumericCell("200").value === 200);
  check("price decimal", parseNumericCell("53.6").ok && parseNumericCell("53.6").value === 53.6);
  check("empty number is empty not error", parseNumericCell("").ok && parseNumericCell("").value == null);
  check("formula invalid", parseNumericCell("=A1").error === "Формула без вычисленного значения");
  check("cell display int", cellToDisplay(200) === "200");

  const headers = [
    "OWN CODE",
    "行号",
    "产品名称",
    "规格型号",
    "单位(*)",
    "实发数量(*)",
    "销售单价",
    "销售金额",
  ];
  const mapping = mapHeadersByAliases(headers);
  check("map ownCode", mapping.ownCode === 0);
  check("map supplier", mapping.supplierCode === 1);
  check("map name", mapping.name === 2);
  check("map spec", mapping.spec === 3);
  check("map unit", mapping.unit === 4);
  check("map qty", mapping.quantity === 5);
  check("map price", mapping.price === 6);
  check("map amount", mapping.amount === 7);
  check("score headers", scoreHeaders(headers) >= 16);

  const workbook: ParsedWorkbookMatrix = {
    fileName: "sample_cn_supply.xlsx",
    sheetName: "Sheet1",
    sheets: ["Sheet1"],
    matrix: SAMPLE_CN_SUPPLY_MATRIX,
  };
  const parsed = extractSupplyRows(workbook);
  check("parsed five product rows", parsed.rows.length === 5);
  check("ignored section/pallet/total", parsed.ignored.length === 3);
  check("duplicate own code flagged", parsed.duplicateOwnCodes.includes("DK-S-001"));
  const dupes = parsed.rows.filter((row) => row.ownCode === "DK-S-001");
  check("duplicate own code kept as two rows", dupes.length === 2);
  check("duplicate own code not merged", dupes[0]?.spec !== dupes[1]?.spec);
  check("first qty", parsed.rows[0]?.quantity === 10);
  check("first amount", parsed.rows[0]?.amount === 125);
  check("unit preserved", parsed.rows[0]?.unit === "张");
  check("total qty 55", parsed.totals.totalQuantity === 55);
  check("pallet ignored", parsed.ignored.some((row) => row.reason.includes("тара")));
  check("total ignored", parsed.ignored.some((row) => row.reason.includes("Итоговая")));

  return failures;
}
