import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSupplyExcelBuffer } from "./index";
import { runSupplyImportSelfCheck } from "./selfCheck";
import { runSupplyStorageNameSelfCheck } from "../supplyDocumentStorage";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "sample_cn_supply.xlsx");

function main() {
  const self = runSupplyImportSelfCheck();
  if (self.length > 0) {
    console.error("self-check failed:", self.join(", "));
    process.exit(1);
  }
  console.log("self-check: ok");

  const storageCheck = runSupplyStorageNameSelfCheck();
  if (storageCheck.length > 0) {
    console.error("storage-name self-check failed:", storageCheck.join(", "));
    process.exit(1);
  }
  console.log("storage-name self-check: ok");

  const buffer = readFileSync(fixturePath);
  const parsed = parseSupplyExcelBuffer(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    "sample_cn_supply.xlsx",
  );

  const expectedRows = 5;
  const expectedIgnored = 3;
  if (parsed.rows.length !== expectedRows || parsed.ignored.length !== expectedIgnored) {
    console.error(
      `synthetic fixture mismatch: rows=${parsed.rows.length} ignored=${parsed.ignored.length}`,
    );
    process.exit(1);
  }
  if (!parsed.duplicateOwnCodes.includes("DK-S-001")) {
    console.error("synthetic fixture should flag duplicate DK-S-001");
    process.exit(1);
  }

  console.log(JSON.stringify({
    profile: parsed.profileId,
    sheet: parsed.sheetName,
    headerRowIndex: parsed.headerRowIndex,
    headers: parsed.headers,
    parsedRows: parsed.rows.length,
    ignoredRows: parsed.ignored.length,
    duplicateOwnCodes: parsed.duplicateOwnCodes,
    totals: parsed.totals,
    rows: parsed.rows.map((row) => ({
      rowNumber: row.rowNumber,
      ownCode: row.ownCode,
      supplierCode: row.supplierCode,
      name: row.name,
      spec: row.spec,
      unit: row.unit,
      quantity: row.quantity,
      price: row.price,
      amount: row.amount,
      issues: row.issues,
    })),
    ignored: parsed.ignored,
  }, null, 2));
}

main();
