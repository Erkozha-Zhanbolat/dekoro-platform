import type { FactoryCatalogRef } from "@/types/database";

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function parseFactoryCatalogRefs(value: unknown): FactoryCatalogRef[] {
  if (!Array.isArray(value)) return [];
  const catalogs: FactoryCatalogRef[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name : "";
    if (!id || !name) continue;
    catalogs.push({
      id,
      name,
      color: typeof r.color === "string" ? r.color : "slate",
      is_active: r.is_active == null ? true : Boolean(r.is_active),
      sort_order: asNumber(r.sort_order, 0),
    });
  }
  return catalogs;
}
