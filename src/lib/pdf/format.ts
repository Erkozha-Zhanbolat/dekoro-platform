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

/** Money without currency suffix: `1 016 700,00` (ru-KZ). */
export function formatPdfMoneyPlain(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return moneyFormatter.format(n);
}

const invoiceQtyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

/** Invoice quantity: `23,000` (ru-KZ, 3 decimal places). */
export function formatPdfInvoiceQty(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "—";
  }
  return invoiceQtyFormatter.format(n);
}

/** Visible invoice date: `14 августа 2026 г.` (Asia/Almaty). */
export function formatPdfDateLong(value: unknown): string {
  if (value == null || value === "") {
    return "—";
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  const formatted = date
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Almaty",
    })
    .trim();
  if (/г\.?$/i.test(formatted)) {
    return formatted.endsWith(".") ? formatted : `${formatted}.`;
  }
  return `${formatted} г.`;
}

/** VAT percent from snapshot: `16` or `12,5`. */
export function formatPdfVatRate(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  if (Math.abs(n - Math.round(n)) < 1e-9) {
    return String(Math.round(n));
  }
  return String(n).replace(".", ",");
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
