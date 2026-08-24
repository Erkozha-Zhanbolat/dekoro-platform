/**
 * Apply migration 047 category sort_order (service role, no secret logging).
 * Run: npx --yes tsx scripts/apply-047-category-order.ts
 *
 * Prefer running the SQL file in Supabase SQL Editor in production;
 * this script mirrors 047 for local/dev verification.
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

const CORE = new Map<string, number>([
  ["Бамбуковые панели", 10],
  ["Луверы", 20],
  ["Плинтусы", 30],
  ["Алюминиевые профили", 40],
  ["Клей", 50],
]);

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, parent_id, sort_order")
    .is("parent_id", null)
    .order("sort_order")
    .order("name");

  if (error) throw new Error(`read categories: ${error.message}`);

  const rows = data ?? [];
  console.log(
    "BEFORE top-level:",
    rows.map((r) => `${r.sort_order}:${r.name}`),
  );

  const others = rows
    .filter((r) => !CORE.has(r.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  for (const row of rows) {
    const next = CORE.get(row.name);
    if (next === undefined) continue;
    if (row.sort_order === next) continue;
    const { error: upErr } = await supabase
      .from("categories")
      .update({ sort_order: next })
      .eq("id", row.id);
    if (upErr) throw new Error(`update ${row.name}: ${upErr.message}`);
    console.log(`set ${row.name}: ${row.sort_order} -> ${next}`);
  }

  for (let i = 0; i < others.length; i++) {
    const sort_order = 100 + i * 10;
    if (others[i].sort_order === sort_order) continue;
    const { error: upErr } = await supabase
      .from("categories")
      .update({ sort_order })
      .eq("id", others[i].id);
    if (upErr) throw new Error(`update ${others[i].name}: ${upErr.message}`);
    console.log(`set ${others[i].name}: ${others[i].sort_order} -> ${sort_order}`);
  }

  const after = await supabase
    .from("categories")
    .select("name, sort_order")
    .is("parent_id", null)
    .order("sort_order")
    .order("name");

  if (after.error) throw new Error(`read after: ${after.error.message}`);
  console.log(
    "AFTER top-level:",
    (after.data ?? []).map((r) => `${r.sort_order}:${r.name}`),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
