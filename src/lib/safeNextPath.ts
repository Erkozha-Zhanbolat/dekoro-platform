/**
 * Returns true only for relative in-app paths that cannot be used for open redirects.
 * Allowed: "/checkout", "/profile", "/orders/123?x=1"
 * Rejected: absolute URLs, "//evil.com", "javascript:…", "data:…", backslashes, schemes.
 */
export function isSafeNextPath(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return false;
  }

  if (value.includes("\\") || value.includes("://")) {
    return false;
  }

  if (/[\s\x00-\x1f\x7f]/.test(value)) {
    return false;
  }

  return true;
}

/**
 * Returns a safe in-app path for post-login redirects.
 * Falls back to /profile when the value is missing or unsafe.
 */
export function getSafeNextPath(
  value: string | null | undefined,
  fallback = "/profile",
): string {
  if (typeof value !== "string" || !isSafeNextPath(value)) {
    return fallback;
  }

  return value;
}
