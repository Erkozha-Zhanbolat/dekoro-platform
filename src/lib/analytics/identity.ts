/**
 * First-party visitor/session cookies for Stage 26 analytics.
 * Not HttpOnly — readable by the SPA; never store secrets/PII/JWT here.
 *
 * Cookie flags: Path=/; SameSite=Lax; Secure on https.
 * dekoro_vid: 1 year. dekoro_sid / dekoro_sid_at: ~30 min idle.
 */

const VISITOR_COOKIE = "dekoro_vid";
const SESSION_COOKIE = "dekoro_sid";
const SESSION_AT_COOKIE = "dekoro_sid_at";

/** 30 minutes idle → new analytics session */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Visitor cookie lifetime: 1 year */
const VISITOR_MAX_AGE_SEC = 365 * 24 * 60 * 60;

function isBrowser(): boolean {
  return typeof document !== "undefined";
}

function readCookie(name: string): string | null {
  if (!isBrowser()) return null;
  const prefix = `${name}=`;
  const parts = document.cookie.split("; ");
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function writeCookie(name: string, value: string, maxAgeSec: number): void {
  if (!isBrowser()) return;
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "; Secure"
      : "";
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${secure}`;
}

function clearCookie(name: string): void {
  if (!isBrowser()) return;
  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:"
      ? "; Secure"
      : "";
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function isUuid(value: string | null): value is string {
  return (
    !!value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getOrCreateVisitorId(): string {
  const existing = readCookie(VISITOR_COOKIE);
  if (isUuid(existing)) {
    writeCookie(VISITOR_COOKIE, existing, VISITOR_MAX_AGE_SEC);
    return existing;
  }
  const id = newId();
  writeCookie(VISITOR_COOKIE, id, VISITOR_MAX_AGE_SEC);
  return id;
}

export function getVisitorId(): string | null {
  const existing = readCookie(VISITOR_COOKIE);
  return isUuid(existing) ? existing : null;
}

/**
 * Returns current analytics session_id, rotating after 30 min idle.
 * Touches last-activity cookie on every call.
 */
export function getOrCreateSessionId(): string {
  const now = Date.now();
  const existing = readCookie(SESSION_COOKIE);
  const atRaw = readCookie(SESSION_AT_COOKIE);
  const at = atRaw ? Number(atRaw) : NaN;

  const stillValid =
    isUuid(existing) &&
    Number.isFinite(at) &&
    now - at < SESSION_IDLE_MS;

  const sessionId = stillValid ? existing : newId();
  const maxAgeSec = Math.ceil(SESSION_IDLE_MS / 1000) + 60;
  writeCookie(SESSION_COOKIE, sessionId, maxAgeSec);
  writeCookie(SESSION_AT_COOKIE, String(now), maxAgeSec);
  return sessionId;
}

/** Touch session activity without rotating (after successful track). */
export function touchSessionActivity(): void {
  const existing = readCookie(SESSION_COOKIE);
  if (!isUuid(existing)) return;
  const maxAgeSec = Math.ceil(SESSION_IDLE_MS / 1000) + 60;
  writeCookie(SESSION_COOKIE, existing, maxAgeSec);
  writeCookie(SESSION_AT_COOKIE, String(Date.now()), maxAgeSec);
}

/**
 * Identity boundary on logout / account switch:
 * rotate visitor_id so the next user on a shared computer does not inherit
 * the previous account's anonymous history for linking.
 * Also starts a fresh session.
 */
export function rotateAnalyticsIdentity(): void {
  clearCookie(VISITOR_COOKIE);
  clearCookie(SESSION_COOKIE);
  clearCookie(SESSION_AT_COOKIE);
  getOrCreateVisitorId();
  getOrCreateSessionId();
}

export function createClientEventId(): string {
  return newId();
}

export type UtmParams = {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
};

export function readUtmFromLocation(): UtmParams {
  if (typeof window === "undefined") {
    return { utm_source: null, utm_medium: null, utm_campaign: null };
  }
  const params = new URLSearchParams(window.location.search);
  const pick = (key: string) => {
    const v = params.get(key)?.trim();
    return v ? v.slice(0, 200) : null;
  };
  return {
    utm_source: pick("utm_source"),
    utm_medium: pick("utm_medium"),
    utm_campaign: pick("utm_campaign"),
  };
}

export function sanitizeReferrer(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.referrer?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (
      typeof window !== "undefined" &&
      url.hostname === window.location.hostname
    ) {
      return null;
    }
    return `${url.hostname}${url.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}
