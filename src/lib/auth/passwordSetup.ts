/**
 * Shared helpers for invite password setup and password recovery.
 * Passwords are never persisted or logged here — only validated client-side
 * before supabase.auth.updateUser({ password }).
 */

export const MIN_PASSWORD_LENGTH = 8;

export function validateNewPassword(
  password: string,
  confirmPassword: string,
): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен содержать не менее ${MIN_PASSWORD_LENGTH} символов`;
  }
  if (password !== confirmPassword) {
    return "Пароли не совпадают";
  }
  return null;
}

function readParam(
  search: URLSearchParams,
  hash: URLSearchParams,
  key: string,
): string | null {
  return search.get(key) || hash.get(key);
}

/**
 * Parse Supabase auth redirect errors from query or hash.
 * Safe for client components only (uses window).
 */
export function readAuthRedirectError(
  fallbackMessage: string,
): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const error = readParam(search, hash, "error");
  const description = readParam(search, hash, "error_description");

  if (!error && !description) {
    return null;
  }

  const raw = (description || error || "").replace(/\+/g, " ");
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }

  const lower = decoded.toLowerCase();
  if (
    lower.includes("expired") ||
    lower.includes("otp_expired") ||
    lower.includes("flow_state")
  ) {
    return "Ссылка недействительна или устарела. Запросите новую.";
  }

  return fallbackMessage;
}

/**
 * Absolute origin for client-side recovery redirectTo.
 * Prefer NEXT_PUBLIC_APP_URL (public mirror of APP_URL); fall back to window origin.
 */
export function getClientAppOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "http://localhost:3000";
}
