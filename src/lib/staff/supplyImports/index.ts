import { extractSupplyRows } from "./extract";
import { readWorkbookFromFile, readWorkbookMatrix } from "./workbook";
import type { SupplyParseResult } from "./types";

export {
  SUPPLY_IMPORT_MAX_FILE_BYTES,
  SUPPLY_IMPORT_MAX_ROWS,
  type SupplyImportKind,
  type SupplyParseResult,
  type ParsedSupplyRow,
  type IgnoredSupplyRow,
} from "./types";
export { isExcelFileName, safeExcelFileName } from "./normalize";
export { assertExcelFileMeta, readWorkbookFromFile, readWorkbookMatrix } from "./workbook";
export { runSupplyImportSelfCheck } from "./selfCheck";
export { runSupplyStage40SelfCheck } from "./stage40SelfCheck";

export function parseSupplyExcelBuffer(
  buffer: ArrayBuffer,
  fileName: string,
): SupplyParseResult {
  const workbook = readWorkbookMatrix(buffer, fileName);
  return extractSupplyRows(workbook);
}

export async function parseSupplyExcelFile(file: File): Promise<SupplyParseResult> {
  const workbook = await readWorkbookFromFile(file);
  return extractSupplyRows(workbook);
}
