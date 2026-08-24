/**
 * Catalog LIMIT/OFFSET pagination self-check (Stage 46).
 * Run: npx --yes tsx src/lib/catalog.pagination.selfcheck.ts
 *
 * 1) Pure math — OFFSET pages over a deterministic ordered list.
 * 2) Live — if get_catalog_page is deployed, walk pages vs get_catalog() oracle.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type Row = {
  product_id: string;
  name: string;
  sku: string;
  category: string | null;
  total_count?: number;
};

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function assert(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(detail ? `${label}: ${detail}` : label);
  }
}

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Same cut the SQL LIMIT/OFFSET page applies to an already-ordered list. */
function pageSlice<T>(rows: T[], limit: number, offset: number): T[] {
  return rows.slice(offset, offset + limit);
}

function collectPages<T extends { product_id: string }>(
  ordered: T[],
  pageSize: number,
): { ids: string[]; pages: T[][] } {
  const pages: T[][] = [];
  const ids: string[] = [];
  for (let offset = 0; offset < ordered.length; offset += pageSize) {
    const page = pageSlice(ordered, pageSize, offset);
    pages.push(page);
    for (const row of page) ids.push(row.product_id);
  }
  return { ids, pages };
}

function analyzeIds(ids: string[], expectedCount: number, label: string) {
  const unique = new Set(ids);
  assertEq(`${label} duplicates`, ids.length - unique.size, 0);
  assertEq(`${label} unique count`, unique.size, expectedCount);
  assertEq(`${label} collected length`, ids.length, expectedCount);
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

{
  const pageSize = 32;
  // Synthetic Stage-45-ish order: categories A then B; duplicate names/skus possible.
  const ordered: Row[] = [];
  for (let i = 0; i < 100; i++) {
    const category = i < 40 ? "CatA" : i < 70 ? "CatB" : "CatC";
    ordered.push({
      product_id: `id-${String(i).padStart(3, "0")}`,
      name: i % 7 === 0 ? "SameName" : `Name-${i}`,
      sku: i % 11 === 0 ? "SAME-SKU" : `SKU-${i}`,
      category,
    });
  }

  const { ids, pages } = collectPages(ordered, pageSize);
  analyzeIds(ids, ordered.length, "pure full walk");

  // Page boundaries must preserve global order (concat pages === ordered).
  assertEq(
    "pure concat equals ordered",
    pages.flat().map((r) => r.product_id).join(","),
    ordered.map((r) => r.product_id).join(","),
  );

  // Category transition across page boundary (CatA ends at index 39 → page 2 starts at 32).
  const page0 = pages[0];
  const page1 = pages[1];
  assert("pure page0 ends in CatA", page0[page0.length - 1].category === "CatA");
  assert("pure page1 starts in CatA", page1[0].category === "CatA");
  assert("pure page1 contains CatA→CatB", page1.some((r) => r.category === "CatB"));
  const boundaryIdx = page0.length; // 32
  assertEq("pure boundary index product", ordered[boundaryIdx].product_id, page1[0].product_id);
  assertEq("pure pre-boundary product", ordered[boundaryIdx - 1].product_id, page0[page0.length - 1].product_id);

  // Same name / SKU still distinct by id; no skips between pages.
  const sameNameIds = ordered.filter((r) => r.name === "SameName").map((r) => r.product_id);
  for (const id of sameNameIds) {
    assert(`pure SameName ${id} present`, ids.includes(id));
  }

  // Filtered subset pagination (category).
  const catB = ordered.filter((r) => r.category === "CatB");
  const catBWalk = collectPages(catB, pageSize);
  analyzeIds(catBWalk.ids, catB.length, "pure category CatB");

  // Search subset (name/sku contains).
  const searchNeedle = "SAME-SKU";
  const searched = ordered.filter(
    (r) =>
      r.name.toLowerCase().includes(searchNeedle.toLowerCase())
      || r.sku.toLowerCase().includes(searchNeedle.toLowerCase()),
  );
  const searchWalk = collectPages(searched, pageSize);
  analyzeIds(searchWalk.ids, searched.length, "pure search SAME-SKU");

  console.log("catalog.pagination.selfcheck: pure OFFSET math passed");
}

// ---------------------------------------------------------------------------
// Live (optional) — requires migration 046 applied
// ---------------------------------------------------------------------------

async function liveCheck() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log("catalog.pagination.selfcheck: skip live (no env)");
    return;
  }

  const supabase = createClient(url, key);
  const pageSize = 32;

  // Oracle: full get_catalog() in Stage 45 server order (do NOT client-resort).
  const full = await supabase.rpc("get_catalog");
  if (full.error) {
    throw new Error(`get_catalog failed: ${full.error.message}`);
  }
  const oracle = (full.data as Row[] | null) ?? [];
  assert("live oracle non-empty or empty ok", Array.isArray(oracle));

  function filterOracle(search: string | null, category: string | null): Row[] {
    const q = (search ?? "").trim().toLowerCase();
    return oracle.filter((row) => {
      const matchesCategory = !category || row.category === category;
      const matchesSearch =
        q.length === 0
        || row.name.toLowerCase().includes(q)
        || row.sku.toLowerCase().includes(q)
        || (row as { original_sku?: string | null }).original_sku
          ?.toLowerCase()
          .includes(q);
      return matchesCategory && matchesSearch;
    });
  }

  /** Simulate SQL LIMIT/OFFSET over an already-ordered filtered list. */
  function walkSimulated(label: string, filtered: Row[]) {
    const { ids, pages } = collectPages(filtered, pageSize);
    analyzeIds(ids, filtered.length, `${label} simulated`);
    assertEq(
      `${label} simulated concat`,
      pages.flat().map((r) => r.product_id).join(","),
      filtered.map((r) => r.product_id).join(","),
    );

    // Category transition across a page boundary (if any).
    for (let p = 0; p < pages.length - 1; p++) {
      const end = pages[p][pages[p].length - 1];
      const start = pages[p + 1][0];
      const globalIdx = (p + 1) * pageSize;
      assertEq(
        `${label} boundary continuity page ${p}`,
        start.product_id,
        filtered[globalIdx]?.product_id,
      );
      assertEq(
        `${label} pre-boundary continuity page ${p}`,
        end.product_id,
        filtered[globalIdx - 1]?.product_id,
      );
    }

    console.log(`  ${label} (simulated OFFSET): ok (n=${filtered.length})`);
  }

  async function walkRpc(label: string, search: string | null, category: string | null) {
    const collected: Row[] = [];
    let offset = 0;
    let totalCount = -1;
    let guard = 0;

    while (guard++ < 500) {
      const { data, error } = await supabase.rpc("get_catalog_page", {
        p_limit: pageSize,
        p_search: search,
        p_category: category,
        p_offset: offset,
      });
      if (error) throw new Error(`${label}: ${error.message}`);
      const rows = (data as (Row & { total_count: number })[] | null) ?? [];
      if (rows.length === 0) break;
      if (totalCount < 0) totalCount = Number(rows[0].total_count) || 0;
      collected.push(...rows);
      offset += rows.length;
      if (offset >= totalCount || rows.length < pageSize) break;
    }

    const ids = collected.map((r) => r.product_id);
    analyzeIds(ids, totalCount < 0 ? 0 : totalCount, `${label} page walk`);

    const expected = filterOracle(search, category);
    assertEq(`${label} vs oracle count`, collected.length, expected.length);
    assertEq(
      `${label} vs oracle order`,
      collected.map((r) => r.product_id).join(","),
      expected.map((r) => r.product_id).join(","),
    );

    console.log(`  ${label} (RPC): ok (n=${collected.length})`);
  }

  // --- Always: simulated OFFSET on real DEKORO catalog order ---
  console.log("catalog.pagination.selfcheck: live oracle OFFSET simulation…");
  walkSimulated("all", filterOracle(null, null));

  const categories = [...new Set(oracle.map((r) => r.category).filter(Boolean))] as string[];
  if (categories.length > 0) {
    // Prefer first *business* category when present; else any.
    const filterCat =
      categories.find((c) => c === "Бамбуковые панели") ?? categories[0];
    walkSimulated(`category:${filterCat}`, filterOracle(null, filterCat));
  }

  const skuNeedle = oracle.find((r) => r.sku && r.sku.length >= 2)?.sku ?? null;
  if (skuNeedle) {
    // Full SKU search must find that single product (and any duplicates sharing the token).
    walkSimulated(`search-sku:${skuNeedle}`, filterOracle(skuNeedle, null));
  }

  const nameCounts = new Map<string, number>();
  for (const row of oracle) {
    nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  }
  const dupName = [...nameCounts.entries()].find(([, n]) => n > 1);
  if (dupName) {
    walkSimulated(`search-dup-name`, filterOracle(dupName[0], null));
  }

  const skuCounts = new Map<string, number>();
  for (const row of oracle) {
    skuCounts.set(row.sku, (skuCounts.get(row.sku) ?? 0) + 1);
  }
  const dupSku = [...skuCounts.entries()].find(([, n]) => n > 1);
  if (dupSku) {
    walkSimulated(`search-dup-sku`, filterOracle(dupSku[0], null));
  }

  // --- Optional: real RPC once migration 046 is applied ---
  const probe = await supabase.rpc("get_catalog_page", {
    p_limit: 1,
    p_search: null,
    p_category: null,
    p_offset: 0,
  });

  if (probe.error) {
    console.log(
      `catalog.pagination.selfcheck: RPC not deployed yet (${probe.error.message}). Simulated live checks still passed.`,
    );
    return;
  }

  console.log("catalog.pagination.selfcheck: live RPC checks…");
  await walkRpc("all", null, null);
  if (categories.length > 0) {
    const filterCat =
      categories.find((c) => c === "Бамбуковые панели") ?? categories[0];
    await walkRpc(`category:${filterCat}`, null, filterCat);
  }
  if (skuNeedle) {
    await walkRpc(`search-sku:${skuNeedle}`, skuNeedle, null);
  }

  // --- Business category order (migration 047) ---
  const expectedChipOrder = [
    "Бамбуковые панели",
    "Луверы",
    "Плинтусы",
    "Алюминиевые профили",
    "Клей",
  ];
  const appearanceOrder: string[] = [];
  for (const row of oracle) {
    if (row.category && !appearanceOrder.includes(row.category)) {
      appearanceOrder.push(row.category);
    }
  }
  const expectedCore = expectedChipOrder.filter((c) => appearanceOrder.includes(c));
  const actualCore = appearanceOrder.filter((c) => expectedChipOrder.includes(c));
  console.log("  catalog category appearance:", appearanceOrder.join(" | "));

  const chipsRpc = await supabase.rpc("get_catalog_categories");
  if (!chipsRpc.error && Array.isArray(chipsRpc.data)) {
    const chipNames = (chipsRpc.data as { category: string }[]).map((r) => r.category);
    console.log("  chips order:", chipNames.join(" | "));
    const chipCore = chipNames.filter((c) => expectedChipOrder.includes(c));
    assertEq(
      "get_catalog_categories core order (apply 047 if failing)",
      chipCore.join(" > "),
      expectedCore.join(" > "),
    );
  }

  assertEq(
    "get_catalog / page business category order (apply 047 if failing)",
    actualCore.join(" > "),
    expectedCore.join(" > "),
  );
  if (oracle.length > 0 && appearanceOrder.includes("Бамбуковые панели")) {
    assertEq("first product category", oracle[0]?.category, "Бамбуковые панели");
  }

  console.log("catalog.pagination.selfcheck: live OFFSET + category order checks passed");
}

liveCheck()
  .then(() => {
    console.log("catalog.pagination.selfcheck: all cases passed");
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
