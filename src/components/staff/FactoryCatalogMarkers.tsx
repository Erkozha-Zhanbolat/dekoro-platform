"use client";

import { factoryCatalogStarColor } from "@/lib/staff/factoryCatalogColors";
import type { FactoryCatalogRef } from "@/types/database";

const MAX_VISIBLE = 2;

export default function FactoryCatalogMarkers({
  catalogs,
  className = "",
}: {
  catalogs: FactoryCatalogRef[] | null | undefined;
  className?: string;
}) {
  const list = [...(catalogs ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name),
  );
  if (list.length === 0) return null;

  const visible = list.slice(0, MAX_VISIBLE);
  const extra = list.length - visible.length;
  const title = list.map((c) => c.name).join(" · ");

  return (
    <span
      className={`inline-flex items-center gap-0.5 align-middle ${className}`}
      title={title}
      aria-label={title}
    >
      {visible.map((catalog) => (
        <span
          key={catalog.id}
          className="text-[11px] leading-none"
          style={{ color: factoryCatalogStarColor(catalog.color) }}
        >
          ★
        </span>
      ))}
      {extra > 0 ? (
        <span className="text-[10px] font-medium text-neutral-400">+{extra}</span>
      ) : null}
    </span>
  );
}
