/**
 * Shared helpers for invite password setup and password recovery.
 * Passwords are never persisted or logged here — only validated client-side
 * before supabase.auth.updateUser({ password }).
 */

export const MIN_PASSWORD_LENGTH = 8;

/**
 * user_metadata flag set by inviteUserByEmail. Required because after the
 * invite link is consumed, the session looks like a normal login and
 * `type=invite` is stripped from the URL. Existing staff without this flag
 * are not forced through onboarding.
 */
export const MUST_SET_PASSWORD_METADATA_KEY = "must_set_password";

const AUTH_INTENT_STORAGE_KEY = "dekoro_auth_intent";

export type AuthRedirectIntent = "invite" | "recovery";

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

function readUrlAuthParams(): { search: URLSearchParams; hash: URLSearchParams } | null {
  if (typeof window === "undefined") {
    return null;
  }
  return {
    search: new URLSearchParams(window.location.search),
    hash: new URLSearchParams(window.location.hash.replace(/^#/, "")),
  };
}

function isTruthyMeta(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Parse Supabase auth redirect errors from query or hash.
 * Safe for client components only (uses window).
 */
export function readAuthRedirectError(
  fallbackMessage: string,
): string | null {
  const params = readUrlAuthParams();
  if (!params) {
    return null;
  }

  const error = readParam(params.search, params.hash, "error");
  const description = readParam(params.search, params.hash, "error_description");

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
 * Read `type=invite|recovery` from the current URL before supabase-js
 * strips the hash. Idempotent; safe to call during client render.
 */
export function captureAuthRedirectIntent(): AuthRedirectIntent | null {
  const params = readUrlAuthParams();
  if (!params) {
    return getStoredAuthIntent();
  }

  const type = (readParam(params.search, params.hash, "type") || "").toLowerCase();
  if (type === "invite" || type === "recovery") {
    try {
      sessionStorage.setItem(AUTH_INTENT_STORAGE_KEY, type);
    } catch {
      /* private mode */
    }
    return type;
  }

  return getStoredAuthIntent();
}

export function getStoredAuthIntent(): AuthRedirectIntent | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = sessionStorage.getItem(AUTH_INTENT_STORAGE_KEY);
    if (value === "invite" || value === "recovery") {
      return value;
    }
  } catch {
    /* private mode */
  }
  return null;
}

export function clearAuthRedirectIntent(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    sessionStorage.removeItem(AUTH_INTENT_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

export function userHasMustSetPasswordFlag(
  user: { user_metadata?: Record<string, unknown> } | null | undefined,
): boolean {
  return isTruthyMeta(user?.user_metadata?.[MUST_SET_PASSWORD_METADATA_KEY]);
}

/**
 * True while an invited user still has to choose a first password.
 * Derived only from user_metadata so it is SSR-safe.
 */
export function userNeedsPasswordSetup(
  user: { user_metadata?: Record<string, unknown> } | null | undefined,
): boolean {
  return userHasMustSetPasswordFlag(user);
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
