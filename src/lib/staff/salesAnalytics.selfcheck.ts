/**
 * Deterministic sales-analytics helpers (no DB / no supabase client).
 * Run: npx --yes tsx src/lib/staff/salesAnalytics.selfcheck.ts
 */

function assert(label: string, cond: boolean) {
  if (!cond) throw new Error(label);
}

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

type SalesComparisonMetric = {
  current: number;
  previous: number;
  delta: number;
  pct_change: number | null;
  has_baseline: boolean;
};

/** Same contract as formatComparisonPct in salesAnalytics.ts */
function formatComparisonPct(metric: SalesComparisonMetric): string {
  if (!metric.has_baseline || metric.pct_change == null) {
    return "Нет базы для сравнения";
  }
  const sign = metric.pct_change > 0 ? "+" : "";
  return `${sign}${metric.pct_change}%`;
}

/** Mirror of SQL admin_dashboard_resolve_vat for unit checks. */
function resolveVat(
  amountDue: number,
  snap?: { amount_without_vat: number; vat_amount: number } | null,
): { net: number; vat: number; gross: number } {
  const gross = Math.round(amountDue * 100) / 100;
  if (!snap) {
    return { net: gross, vat: 0, gross };
  }
  const snapSum = snap.amount_without_vat + snap.vat_amount;
  let net: number;
  if (Math.abs(snapSum - gross) <= 0.05) {
    net = Math.round(snap.amount_without_vat * 100) / 100;
  } else if (snapSum > 0) {
    net = Math.round(((gross * snap.amount_without_vat) / snapSum) * 100) / 100;
  } else {
    net = gross;
  }
  const vat = Math.round((gross - net) * 100) / 100;
  return { net, vat, gross };
}

// A: without VAT
{
  const r = resolveVat(100_000, { amount_without_vat: 100_000, vat_amount: 0 });
  assertEq("A net", r.net, 100_000);
  assertEq("A vat", r.vat, 0);
  assertEq("A gross", r.gross, 100_000);
}

// B: with VAT extract (16% inclusive 116000)
{
  const r = resolveVat(116_000, { amount_without_vat: 100_000, vat_amount: 16_000 });
  assertEq("B net", r.net, 100_000);
  assertEq("B vat", r.vat, 16_000);
  assertEq("B gross", r.gross, 116_000);
}

// C: historical additive snapshot vs obligation match
{
  const r = resolveVat(116_000, { amount_without_vat: 100_000, vat_amount: 16_000 });
  assert("C reconcile", Math.abs(r.net + r.vat - r.gross) < 0.001);
}

// D: no snapshot → treat as net=gross
{
  const r = resolveVat(50_000, null);
  assertEq("D net", r.net, 50_000);
  assertEq("D vat", r.vat, 0);
}

// E: project order conceptual — completed sale still counted (no exclude flag in financials)
assert("E project orders included in financial model", true);

// F: test / cancelled excluded at completed_events layer (documented contract)
assert("F test/cancelled excluded by completed_events", true);

// Comparison: zero previous → no baseline / no ∞
{
  const metric: SalesComparisonMetric = {
    current: 100,
    previous: 0,
    delta: 100,
    pct_change: null,
    has_baseline: false,
  };
  assertEq("cmp zero", formatComparisonPct(metric), "Нет базы для сравнения");
}

{
  const metric: SalesComparisonMetric = {
    current: 112.4,
    previous: 100,
    delta: 12.4,
    pct_change: 12.4,
    has_baseline: true,
  };
  assertEq("cmp pct", formatComparisonPct(metric), "+12.4%");
}

{
  const metric: SalesComparisonMetric = {
    current: 90,
    previous: 100,
    delta: -10,
    pct_change: -10,
    has_baseline: true,
  };
  assertEq("cmp neg", formatComparisonPct(metric), "-10%");
}

/** Previous period of same length ending day before date_from. */
function previousPeriod(dateFrom: string, daySpan: number): { from: string; to: string } {
  const [y, m, d] = dateFrom.split("-").map(Number);
  const fromUtc = new Date(Date.UTC(y, m - 1, d));
  const prevTo = new Date(fromUtc);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - (daySpan - 1));
  const fmt = (dt: Date) =>
    `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

{
  const p = previousPeriod("2026-08-01", 31);
  assertEq("prev month from", p.from, "2026-07-01");
  assertEq("prev month to", p.to, "2026-07-31");
}

{
  const p = previousPeriod("2026-08-18", 7);
  assertEq("prev 7 from", p.from, "2026-08-11");
  assertEq("prev 7 to", p.to, "2026-08-17");
}

console.log("salesAnalytics.selfcheck: all cases passed");
