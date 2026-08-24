/**
 * One-shot audit of storefront category order (anon RPCs only).
 * Run: npx --yes tsx scripts/audit-category-order.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const supabase = createClient(url, anon);

  const full = await supabase.rpc("get_catalog");
  if (full.error) throw new Error(`get_catalog: ${full.error.message}`);
  const rows = (full.data as { category: string | null; name: string; sku: string }[]) ?? [];
  const order: string[] = [];
  for (const row of rows) {
    const cat = row.category ?? "(null)";
    if (!order.includes(cat)) order.push(cat);
  }
  console.log("get_catalog category appearance order:", order);
  console.log("get_catalog first 8:", rows.slice(0, 8).map((r) => `${r.category} | ${r.sku}`));

  const chips = await supabase.rpc("get_catalog_categories");
  console.log("get_catalog_categories:", chips.error?.message ?? chips.data);

  const page = await supabase.rpc("get_catalog_page", {
    p_limit: 8,
    p_search: null,
    p_category: null,
    p_offset: 0,
  });
  console.log(
    "get_catalog_page first 8:",
    page.error?.message
      ?? ((page.data as { category: string; sku: string }[]) ?? []).map(
        (r) => `${r.category} | ${r.sku}`,
      ),
  );

  // Infer relative sort: if chips match name order with equal sort_order, names sort alphabetically (ru).
  if (Array.isArray(chips.data)) {
    const names = chips.data.map((r: { category: string }) => r.category);
    const alpha = [...names].sort((a, b) => a.localeCompare(b, "ru"));
    console.log("chips == russian alpha?", JSON.stringify(names) === JSON.stringify(alpha));
    console.log("russian alpha would be:", alpha);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
