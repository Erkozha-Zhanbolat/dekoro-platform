/**
 * Analytics consent (Stage 26).
 * Storage key: dekoro_analytics_consent → "granted" | "denied"
 * Missing key = "unset" → NO behavioral client events.
 */

const CONSENT_KEY = "dekoro_analytics_consent";

export type AnalyticsConsent = "granted" | "denied" | "unset";

/**
 * Client-side behavioral events — require consent === "granted".
 * page_view / checkout_start also gated: not sent until the user allows analytics.
 */
export const BEHAVIORAL_EVENT_TYPES = new Set([
  "page_view",
  "catalog_open",
  "category_open",
  "product_view",
  "search",
  "favorite_add",
  "favorite_remove",
  "cart_add",
  "cart_remove",
  "checkout_start",
]);

/**
 * Authoritative business events — recorded via analytics_record_* RPCs only.
 * Not gated by cookie consent (authenticated business audit).
 */
export const AUTHORITATIVE_EVENT_TYPES = new Set([
  "login",
  "register",
  "order_created",
  "order_cancelled",
  "invoice_open",
  "delivery_note_open",
  "document_download",
]);

type ConsentListener = (consent: AnalyticsConsent) => void;
const listeners = new Set<ConsentListener>();

export function getAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === "undefined") return "unset";
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (raw === "granted" || raw === "denied") return raw;
  } catch {
    /* private mode */
  }
  return "unset";
}

export function setAnalyticsConsent(value: "granted" | "denied"): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) {
    listener(value);
  }
}

/** Subscribe to consent changes (banner / settings). */
export function subscribeAnalyticsConsent(listener: ConsentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Behavioral client tracking only when explicitly granted. */
export function isBehavioralTrackingAllowed(): boolean {
  return getAnalyticsConsent() === "granted";
}

export function canTrackEventType(eventType: string): boolean {
  if (AUTHORITATIVE_EVENT_TYPES.has(eventType)) {
    // Must use record* helpers — never client trackEvent.
    return false;
  }
  if (BEHAVIORAL_EVENT_TYPES.has(eventType)) {
    return isBehavioralTrackingAllowed();
  }
  return false;
}
