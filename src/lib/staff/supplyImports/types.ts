/**
 * Supply document import — shared types.
 * Parser stays layout-agnostic; profiles map headers. Matching is server-side.
 */

export const SUPPLY_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const SUPPLY_IMPORT_MAX_ROWS = 5_000;
export const SUPPLY_IMPORT_MAX_QUANTITY = 1_000_000_000;

export type SupplyImportKind = "factory_order" | "factory_shipment";

export type ExcelCell = string | number | boolean | Date | null | undefined;

export type ParsedWorkbookMatrix = {
  fileName: string;
  sheetName: string;
  sheets: string[];
  matrix: ExcelCell[][];
};

export type HeaderField =
  | "ownCode"
  | "supplierCode"
  | "name"
  | "spec"
  | "unit"
  | "quantity"
  | "price"
  | "amount"
  | "notes";

export type HeaderMapping = Partial<Record<HeaderField, number>>;

export type SupplyParserProfile = {
  id: string;
  label: string;
  detect: (headers: string[]) => number;
  mapHeaders: (headers: string[]) => HeaderMapping;
};

export type ParsedSupplyRow = {
  rowNumber: number;
  ownCode: string | null;
  supplierCode: string | null;
  name: string | null;
  spec: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  notes: string | null;
  issues: string[];
};

export type IgnoredSupplyRow = {
  rowNumber: number;
  reason: string;
  preview: string;
};

export type SupplyParseIssue = {
  rowNumber: number;
  code: string;
  message: string;
};

export type SupplyParseResult = {
  profileId: string;
  profileLabel: string;
  fileName: string;
  sheetName: string;
  headerRowIndex: number;
  headers: string[];
  rows: ParsedSupplyRow[];
  ignored: IgnoredSupplyRow[];
  issues: SupplyParseIssue[];
  duplicateOwnCodes: string[];
  totals: {
    parsedRows: number;
    ignoredRows: number;
    invalidQuantityRows: number;
    invalidPriceRows: number;
    unmatchedHintRows: number;
    totalQuantity: number;
    totalAmount: number;
  };
};
