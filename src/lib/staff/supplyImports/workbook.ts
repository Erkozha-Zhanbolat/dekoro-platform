import * as XLSX from "xlsx";
import {
  SUPPLY_IMPORT_MAX_FILE_BYTES,
  SUPPLY_IMPORT_MAX_ROWS,
  type ExcelCell,
  type ParsedWorkbookMatrix,
} from "./types";
import { isExcelFileName, safeExcelFileName } from "./normalize";

export function assertExcelFileMeta(fileName: string, size: number): string {
  const safe = safeExcelFileName(fileName);
  if (!isExcelFileName(safe)) {
    throw new Error("Нужен файл Excel (.xlsx или .xls)");
  }
  if (size > SUPPLY_IMPORT_MAX_FILE_BYTES) {
    throw new Error("Файл слишком большой (максимум 20 МБ)");
  }
  return safe;
}

export function readWorkbookMatrix(
  buffer: ArrayBuffer,
  fileName: string,
): ParsedWorkbookMatrix {
  const safeName = assertExcelFileMeta(fileName, buffer.byteLength);
  const workbook = XLSX.read(buffer, { type: "array", raw: true, cellDates: false });
  const sheetName = workbook.SheetNames.find((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) return false;
    const matrix = XLSX.utils.sheet_to_json<ExcelCell[]>(sheet, {
      header: 1,
      defval: null,
      raw: true,
      blankrows: false,
    });
    return matrix.length > 0;
  });

  if (!sheetName) {
    throw new Error("В файле нет листов с данными");
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
  if (matrix.length > SUPPLY_IMPORT_MAX_ROWS + 30) {
    throw new Error("Слишком много строк (максимум 5 000)");
  }

  return {
    fileName: safeName,
    sheetName,
    sheets: workbook.SheetNames,
    matrix,
  };
}

export async function readWorkbookFromFile(file: File): Promise<ParsedWorkbookMatrix> {
  assertExcelFileMeta(file.name, file.size);
  const buffer = await file.arrayBuffer();
  return readWorkbookMatrix(buffer, file.name);
}
