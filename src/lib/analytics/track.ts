import { supabase } from "@/lib/supabase/client";
import {
  BEHAVIORAL_EVENT_TYPES,
  canTrackEventType,
  setAnalyticsConsent,
} from "@/lib/analytics/consent";
import {
  createClientEventId,
  getOrCreateSessionId,
  getOrCreateVisitorId,
  readUtmFromLocation,
  sanitizeReferrer,
  touchSessionActivity,
} from "@/lib/analytics/identity";
import type {
  AnalyticsEventPayload,
  AnalyticsSessionMeta,
} from "@/lib/analytics/types";

const FLUSH_MS = 2000;
const MAX_BATCH = 40;
/** Cap queue so failed flushes cannot grow forever. */
const MAX_QUEUE = 80;
/** Max requeues for a dropped batch (then discard). */
const MAX_REQUEUE_ROUNDS = 1;

type QueuedEvent = {
  event_type: string;
  page?: string | null;
  product_id?: string | null;
  category_id?: string | null;
  metadata?: Record<string, unknown>;
  client_event_id: string;
};

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let sessionMetaSent = false;
let sessionMeta: AnalyticsSessionMeta | null = null;
let listenersBound = false;
let requeueRounds = 0;

/** Clear queue/meta after logout identity rotation. */
export function resetAnalyticsClientState(): void {
  queue = [];
  sessionMetaSent = false;
  sessionMeta = null;
  requeueRounds = 0;
  if (flushTimer != null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * Persist consent and apply side effects:
 * - granted → ensure visitor/session, keep queue
 * - denied → drop queued behavioral events
 */
export function applyAnalyticsConsentDecision(
  value: "granted" | "denied",
): void {
  setAnalyticsConsent(value);
  if (value === "denied") {
    queue = queue.filter((e) => !BEHAVIORAL_EVENT_TYPES.has(e.event_type));
    if (flushTimer != null && queue.length === 0) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return;
  }
  // granted: start/continue session identity for upcoming behavioral events
  getOrCreateVisitorId();
  getOrCreateSessionId();
  sessionMetaSent = false;
  sessionMeta = null;
}

function ensureSessionMeta(): AnalyticsSessionMeta {
  if (sessionMeta) return sessionMeta;
  const utm = readUtmFromLocation();
  sessionMeta = {
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    referrer: sanitizeReferrer(),
    landing_page:
      typeof window !== "undefined"
        ? window.location.pathname.slice(0, 300)
        : null,
  };
  return sessionMeta;
}

async function flushQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  if (typeof window === "undefined") return;

  flushing = true;
  const batch = queue.splice(0, MAX_BATCH);
  const visitorId = getOrCreateVisitorId();
  const sessionId = getOrCreateSessionId();
  const meta = !sessionMetaSent ? ensureSessionMeta() : null;

  try {
    // Never send profile_id / customer_id / created_at / order_id —
    // server derives identity and timestamps.
    const { error } = await supabase.rpc("analytics_track_events", {
      p_visitor_id: visitorId,
      p_session_id: sessionId,
      p_events: batch,
      p_session: meta,
    });

    if (error) {
      console.warn("[analytics] track failed:", error.message);
      if (
        requeueRounds < MAX_REQUEUE_ROUNDS &&
        !/Слишком много событий|Максимум 40|Слишком большой/i.test(
          error.message,
        )
      ) {
        requeueRounds += 1;
        queue = [...batch, ...queue].slice(0, MAX_QUEUE);
      } else {
        requeueRounds = 0;
        // Drop batch — never break UX over analytics.
      }
    } else {
      requeueRounds = 0;
      if (meta) sessionMetaSent = true;
      touchSessionActivity();
    }
  } catch (err) {
    console.warn("[analytics] track error:", err);
    if (requeueRounds < MAX_REQUEUE_ROUNDS) {
      requeueRounds += 1;
      queue = [...batch, ...queue].slice(0, MAX_QUEUE);
    } else {
      requeueRounds = 0;
    }
  } finally {
    flushing = false;
    if (queue.length > 0) {
      scheduleFlush(FLUSH_MS);
    }
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, delayMs);
}

function bindLifecycleListeners(): void {
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;

  const flushNow = () => {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flushQueue();
  };

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  window.addEventListener("pagehide", flushNow);
}

/**
 * Queue a CLIENT behavioral event. Never throws.
 * Skips staff routes, opt-out behavioral types, and authoritative types.
 */
export function trackEvent(payload: AnalyticsEventPayload): void {
  if (typeof window === "undefined") return;

  if (!canTrackEventType(payload.event_type)) return;

  // Authoritative types must use record* helpers — never client track.
  const authoritative = new Set([
    "login",
    "register",
    "order_created",
    "order_cancelled",
    "invoice_open",
    "delivery_note_open",
    "document_download",
  ]);
  if (authoritative.has(payload.event_type)) return;

  const page =
    payload.page ??
    (typeof window !== "undefined" ? window.location.pathname : "/");

  if (page.startsWith("/staff")) return;

  if (queue.length >= MAX_QUEUE) return;

  bindLifecycleListeners();

  queue.push({
    event_type: payload.event_type,
    page: page.slice(0, 300),
    product_id: payload.product_id ?? null,
    category_id: payload.category_id ?? null,
    metadata: payload.metadata ?? {},
    client_event_id: payload.client_event_id ?? createClientEventId(),
  });

  if (queue.length >= MAX_BATCH) {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    void flushQueue();
  } else {
    scheduleFlush(FLUSH_MS);
  }
}

/** Force flush (best-effort; never throws to callers). */
export async function flushAnalytics(): Promise<void> {
  try {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushQueue();
  } catch {
    /* swallow */
  }
}

/** Link anonymous visitor history to the authenticated profile. */
export async function linkVisitorToProfile(): Promise<void> {
  if (typeof window === "undefined") return;
  const visitorId = getOrCreateVisitorId();
  try {
    const { error } = await supabase.rpc("analytics_link_visitor", {
      p_visitor_id: visitorId,
    });
    if (error) {
      console.warn("[analytics] link visitor failed:", error.message);
    }
  } catch (err) {
    console.warn("[analytics] link visitor failed:", err);
  }
}

async function withIdentity<T>(
  fn: (visitorId: string, sessionId: string) => Promise<T>,
): Promise<T | null> {
  try {
    const visitorId = getOrCreateVisitorId();
    const sessionId = getOrCreateSessionId();
    return await fn(visitorId, sessionId);
  } catch (err) {
    console.warn("[analytics] authoritative call failed:", err);
    return null;
  }
}

/** Authoritative login/register (server RPC). */
export async function recordAuthEvent(
  eventType: "login" | "register",
): Promise<void> {
  await withIdentity(async (visitorId, sessionId) => {
    const { error } = await supabase.rpc("analytics_record_auth_event", {
      p_visitor_id: visitorId,
      p_session_id: sessionId,
      p_event_type: eventType,
    });
    if (error) {
      console.warn("[analytics] auth event failed:", error.message);
    }
  });
}

/** Authoritative order_created / order_cancelled (server validates ownership). */
export async function recordOrderEvent(
  orderId: string,
  eventType: "order_created" | "order_cancelled",
): Promise<void> {
  await withIdentity(async (visitorId, sessionId) => {
    const { error } = await supabase.rpc("analytics_record_order_event", {
      p_order_id: orderId,
      p_visitor_id: visitorId,
      p_session_id: sessionId,
      p_event_type: eventType,
    });
    if (error) {
      console.warn("[analytics] order event failed:", error.message);
    }
  });
}

/** Authoritative document open/download (server validates order+document). */
export async function recordDocumentEvent(
  orderId: string,
  documentId: string,
  eventType: "invoice_open" | "delivery_note_open" | "document_download",
): Promise<void> {
  await withIdentity(async (visitorId, sessionId) => {
    const { error } = await supabase.rpc("analytics_record_document_event", {
      p_order_id: orderId,
      p_document_id: documentId,
      p_visitor_id: visitorId,
      p_session_id: sessionId,
      p_event_type: eventType,
    });
    if (error) {
      console.warn("[analytics] document event failed:", error.message);
    }
  });
}
