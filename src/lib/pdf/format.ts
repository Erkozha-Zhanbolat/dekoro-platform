/** Unified PDF formatters — all money/dates in documents go through here. */

/** Page size for every DEKORO document (A4 portrait). Never hardcode mm/pt page boxes. */
export const PDF_PAGE_SIZE = "A4" as const;

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const qtyFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 3,
});

/**
 * Unified money format: `1 250 000,00 ₸`
 * Always includes the tenge sign — do not append ₸ / KZT at call sites.
 */
export function formatPdfMoney(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return `${moneyFormatter.format(n)} ₸`;
}

export function formatPdfQty(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return qtyFormatter.format(n);
}

/** Unified date format: `dd.mm.yyyy` (ru-RU). */
export function formatPdfDate(value: unknown): string {
  if (value == null || value === "") {
    return "—";
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleDateString("ru-RU");
}

export function str(value: unknown, fallback = "—"): string {
  if (value == null) {
    return fallback;
  }
  const s = String(value).trim();
  return s.length > 0 ? s : fallback;
}

/** Document number strictly from metadata snapshot (never live orders). */
export function documentNumberFromMetadata(
  metadata: { document_number?: unknown } | null | undefined,
): string {
  return str(metadata?.document_number, "");
}
