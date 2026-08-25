/**
 * Safe internal return path for product detail → catalog navigation.
 * Rejects open redirects; only `/catalog` and `/catalog?...` are allowed.
 */

export const DEFAULT_CATALOG_PATH = "/catalog";

/** True only for `/catalog` or `/catalog?<query>` (same-origin relative path). */
export function isSafeCatalogReturnPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (
    trimmed.includes("://")
    || trimmed.startsWith("//")
    || trimmed.includes("\\")
    || /[\u0000-\u001F\u007F]/.test(trimmed)
  ) {
    return false;
  }

  if (trimmed === DEFAULT_CATALOG_PATH) {
    return true;
  }

  if (!trimmed.startsWith(`${DEFAULT_CATALOG_PATH}?`)) {
    return false;
  }

  const withoutQuery = trimmed.slice(0, trimmed.indexOf("?"));
  return withoutQuery === DEFAULT_CATALOG_PATH;
}

/**
 * Normalize and validate a candidate return URL.
 * Accepts values as stored in `?from=` (decoded by URLSearchParams).
 */
export function safeCatalogReturnPath(
  value: string | null | undefined,
): string {
  if (value == null) {
    return DEFAULT_CATALOG_PATH;
  }
  const trimmed = value.trim();
  return isSafeCatalogReturnPath(trimmed) ? trimmed : DEFAULT_CATALOG_PATH;
}

/** Build `/product/{id}?from=...` when a safe catalog return path is known. */
export function buildProductHref(
  productId: string,
  catalogReturnHref?: string | null,
): string {
  const base = `/product/${productId}`;
  if (!catalogReturnHref || !isSafeCatalogReturnPath(catalogReturnHref)) {
    return base;
  }
  return `${base}?from=${encodeURIComponent(catalogReturnHref.trim())}`;
}
