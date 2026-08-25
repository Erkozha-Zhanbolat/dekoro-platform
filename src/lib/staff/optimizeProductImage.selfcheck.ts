/**
 * Pure product-image optimization checks (no Canvas / DOM).
 * Run: npx --yes tsx src/lib/staff/optimizeProductImage.selfcheck.ts
 */
import {
  PRODUCT_IMAGE_MAX_LONG_SIDE,
  computeTargetDimensions,
  shouldUseOptimizedFile,
} from "./optimizeProductImage";

function assert(label: string, condition: boolean) {
  if (!condition) {
    throw new Error(`FAIL: ${label}`);
  }
}

function assertEq<T>(label: string, actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// A/B — oversized long side shrinks, aspect preserved
{
  const t = computeTargetDimensions(1672, 941);
  assertEq("1672 long → 1200", t.width, 1200);
  assertEq("1672 height scaled", t.height, Math.round(941 * (1200 / 1672)));
  assert("1672 resized", t.resized);
  assertEq("max long side constant", PRODUCT_IMAGE_MAX_LONG_SIDE, 1200);
}

{
  const t = computeTargetDimensions(941, 1672);
  assertEq("portrait long → 1200", t.height, 1200);
  assertEq("portrait width scaled", t.width, Math.round(941 * (1200 / 1672)));
  assert("portrait resized", t.resized);
}

// C — no upscale
{
  const t = computeTargetDimensions(500, 1000);
  assertEq("small w", t.width, 500);
  assertEq("small h", t.height, 1000);
  assert("small not resized", !t.resized);
}

{
  const t = computeTargetDimensions(1200, 800);
  assertEq("exact max", t.width, 1200);
  assertEq("exact max h", t.height, 800);
  assert("exact max not resized", !t.resized);
}

// Square crop must NOT happen
{
  const t = computeTargetDimensions(800, 1600);
  assert("not square", t.width !== t.height);
  assertEq("square-avoid h", t.height, 1200);
  assertEq("square-avoid w", t.width, 600);
}

// D/E — use WebP only when strictly smaller
assert("smaller webp", shouldUseOptimizedFile(1_000_000, 200_000));
assert("equal not used", !shouldUseOptimizedFile(200_000, 200_000));
assert("larger not used", !shouldUseOptimizedFile(200_000, 250_000));
assert("zero optimized rejected", !shouldUseOptimizedFile(100, 0));
assert("zero original rejected", !shouldUseOptimizedFile(0, 50));

// Invalid dims
let threw = false;
try {
  computeTargetDimensions(0, 100);
} catch {
  threw = true;
}
assert("rejects zero width", threw);

console.log("optimizeProductImage.selfcheck: all cases passed");
