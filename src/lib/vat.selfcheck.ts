/**
 * Lightweight VAT case checks (no test runner in package.json).
 * Run: npx --yes tsx src/lib/vat.selfcheck.ts
 */
import { extractVatFromInclusive } from "./vat";

function assertEq(label: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const c1 = extractVatFromInclusive(116_000, 16);
assertEq("c1 net", c1.amountWithoutVat, 100_000);
assertEq("c1 vat", c1.vatAmount, 16_000);
assertEq("c1 total", c1.finalTotal, 116_000);

const c2 = extractVatFromInclusive(58_000, 16);
assertEq("c2 net", c2.amountWithoutVat, 50_000);
assertEq("c2 vat", c2.vatAmount, 8_000);

const c3 = extractVatFromInclusive(290_000, 16);
assertEq("c3 net", c3.amountWithoutVat, 250_000);
assertEq("c3 vat", c3.vatAmount, 40_000);
assertEq("c3 total", c3.finalTotal, 290_000);

const c4 = extractVatFromInclusive(116_000, 0);
assertEq("c4 vat", c4.vatAmount, 0);
assertEq("c4 total", c4.finalTotal, 116_000);
assertEq("c4 net", c4.amountWithoutVat, 116_000);

// Case 5: VAT from post-discount taxable total (orders.total after discount).
const afterDiscount = 100_000;
const c5 = extractVatFromInclusive(afterDiscount, 16);
assertEq("c5 vat", c5.vatAmount, 13_793.1);
assertEq("c5 net", c5.amountWithoutVat, 86_206.9);
assertEq("c5 total", c5.finalTotal, 100_000);

console.log("vat.selfcheck: all cases passed");
