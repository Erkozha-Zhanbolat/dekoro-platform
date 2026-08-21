/**
 * Deterministic pricing self-check (ТЗ Stage 41, §29 test cases A–F).
 * No test runner in package.json — run: npx --yes tsx src/lib/pricing.selfcheck.ts
 *
 * This exercises `resolveAutomaticPrice`, the pure TypeScript mirror of the
 * SQL priority algorithm in public.resolve_order_item_price() (see
 * supabase/migrations/041_order_pricing_engine.sql, section 8). Cases G/H/I
 * from the ТЗ (snapshot immutability, price-tampering rejection, VAT
 * extraction) are DB/security properties, not pure functions — see the
 * "Snapshots" / "Security" / "VAT" sections of the Stage 41 report instead.
 */
import { computeDiscountPercent, computeSavingsPerUnit, resolveAutomaticPrice } from "./pricing";

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Case A: base 10 000, qty 4, no tier, no customer price -> 10 000 (base).
{
  const r = resolveAutomaticPrice({
    basePrice: 10_000,
    customerPrice: null,
    customerSource: null,
    tierPrice: null,
    tierMinQuantity: null,
  });
  assertEq("A resolvedPrice", r.resolvedPrice, null);
  // No tier/customer price resolved -> caller falls back to base/list price itself.
  assertEq("A listPrice", r.listPrice, 10_000);
}

// Case B: base 10 000, tier(10+) = 9 500, qty 10 -> 9 500, source quantity_tier.
{
  const r = resolveAutomaticPrice({
    basePrice: 10_000,
    customerPrice: null,
    customerSource: null,
    tierPrice: 9_500,
    tierMinQuantity: 10,
  });
  assertEq("B resolvedPrice", r.resolvedPrice, 9_500);
  assertEq("B resolvedSource", r.resolvedSource, "quantity_tier");
  assertEq("B tierMinQuantity", r.tierMinQuantity, 10);
}

// Case C: tiers 10=9500, 50=9000, 100=8600; qty 120 -> largest min_quantity <= 120 is 100 -> 8 600.
{
  // pricing_resolve_quantity_tier() already picks the winning tier in SQL —
  // here we just feed the already-resolved tier (8600 @ 100) into the
  // customer/tier "most favorable" comparison, which is what this helper covers.
  const r = resolveAutomaticPrice({
    basePrice: 10_000,
    customerPrice: null,
    customerSource: null,
    tierPrice: 8_600,
    tierMinQuantity: 100,
  });
  assertEq("C resolvedPrice", r.resolvedPrice, 8_600);
  assertEq("C tierMinQuantity", r.tierMinQuantity, 100);
}

// Case D: customer price = 9 000, qty 4 (no tier applies) -> 9 000, source individual.
{
  const r = resolveAutomaticPrice({
    basePrice: 10_000,
    customerPrice: 9_000,
    customerSource: "individual",
    tierPrice: null,
    tierMinQuantity: null,
  });
  assertEq("D resolvedPrice", r.resolvedPrice, 9_000);
  assertEq("D resolvedSource", r.resolvedSource, "individual");
}

// Case E: customer = 9 000, qty 120 tier = 8 600 -> most favorable wins -> 8 600, quantity_tier.
{
  const r = resolveAutomaticPrice({
    basePrice: 10_000,
    customerPrice: 9_000,
    customerSource: "individual",
    tierPrice: 8_600,
    tierMinQuantity: 100,
  });
  assertEq("E resolvedPrice", r.resolvedPrice, 8_600);
  assertEq("E resolvedSource", r.resolvedSource, "quantity_tier");
}

// E': customer price cheaper than tier -> customer wins (never loses a better deal).
{
  const r = resolveAutomaticPrice({
    basePrice: 10_000,
    customerPrice: 8_000,
    customerSource: "individual",
    tierPrice: 8_600,
    tierMinQuantity: 100,
  });
  assertEq("E' resolvedPrice", r.resolvedPrice, 8_000);
  assertEq("E' resolvedSource", r.resolvedSource, "individual");
}

// Case F: automatic 10 000 (qty 4) + manager override 8 600 -> handled entirely by
// staff_set_order_item_price() server-side, not this pure helper. Verify only the
// discount/savings math the UI shows after such an override.
{
  assertEq("F discountPercent", computeDiscountPercent(10_000, 8_600), 14);
  assertEq("F savingsPerUnit", computeSavingsPerUnit(10_000, 8_600), 1_400);
}

// Discount helpers: no discount when price >= listPrice, or missing inputs.
{
  assertEq("no-discount equal", computeDiscountPercent(10_000, 10_000), null);
  assertEq("no-discount higher", computeDiscountPercent(10_000, 11_000), null);
  assertEq("no-discount null list", computeDiscountPercent(null, 8_600), null);
  assertEq("no-savings equal", computeSavingsPerUnit(10_000, 10_000), null);
}

console.log("pricing.selfcheck: all cases passed");
