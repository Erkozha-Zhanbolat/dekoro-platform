/** Client-side analytics event types (Stage 26). */

/** CLIENT_ALLOWED — accepted by analytics_track_events */
export const CLIENT_ANALYTICS_EVENT_TYPES = [
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
] as const;

/** AUTHORITATIVE — only via analytics_record_* RPCs */
export const AUTHORITATIVE_ANALYTICS_EVENT_TYPES = [
  "login",
  "register",
  "order_created",
  "order_cancelled",
  "invoice_open",
  "delivery_note_open",
  "document_download",
] as const;

export const ANALYTICS_EVENT_TYPES = [
  ...CLIENT_ANALYTICS_EVENT_TYPES,
  ...AUTHORITATIVE_ANALYTICS_EVENT_TYPES,
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];
export type ClientAnalyticsEventType = (typeof CLIENT_ANALYTICS_EVENT_TYPES)[number];

export type AnalyticsEventPayload = {
  event_type: ClientAnalyticsEventType | AnalyticsEventType;
  page?: string | null;
  product_id?: string | null;
  category_id?: string | null;
  order_id?: string | null;
  metadata?: Record<string, unknown>;
  client_event_id?: string;
};

export type AnalyticsSessionMeta = {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  referrer?: string | null;
  landing_page?: string | null;
};

export type TrafficSummary = {
  visitors_today: number;
  online_now: number;
  unique_visitors: number;
  sessions_count: number;
  new_visitors: number;
  returning_visitors: number;
  product_views: number;
  cart_adds: number;
  checkout_starts: number;
  orders_created: number;
  conversion_rate: number;
  period: { date_from: string; date_to: string };
};

export type FunnelStep = {
  step: string;
  label: string;
  count: number;
  rate_from_previous: number | null;
};

export type TrafficSourceRow = {
  traffic_source: string;
  sessions_count: number;
  visitors_count: number;
};

export type OnlineVisitor = {
  session_id: string;
  visitor_id: string;
  profile_id: string | null;
  customer_id: string | null;
  display_name: string | null;
  company_name: string | null;
  last_page: string | null;
  last_seen_at: string;
  is_authenticated: boolean;
};

export type ProductAnalytics = {
  product_id: string;
  views_today: number;
  views_7d: number;
  views_30d: number;
  views_total: number;
  cart_adds: number;
  favorite_adds: number;
  orders_count: number;
  conversion_cart: number;
  conversion_order: number;
};

export type CustomerActivity = {
  customer_id: string;
  last_visit: string | null;
  traffic_source: string | null;
  pages: { page: string; count: number; last_at: string }[];
  products_viewed: {
    product_id: string;
    product_name: string | null;
    product_sku: string | null;
    views: number;
    last_at: string;
  }[];
  searches: { query: string; count: number; last_at: string }[];
  cart_adds: {
    product_id: string;
    product_name: string | null;
    count: number;
    last_at: string;
  }[];
  cart_removes: {
    product_id: string;
    product_name: string | null;
    count: number;
    last_at: string;
  }[];
  last_activity: string | null;
  registered_at: string | null;
  visits_count: number;
  avg_session_duration_seconds: number | null;
  recent_events: {
    id: string;
    event_type: string;
    page: string | null;
    product_id: string | null;
    created_at: string;
    metadata: Record<string, unknown>;
  }[];
};
