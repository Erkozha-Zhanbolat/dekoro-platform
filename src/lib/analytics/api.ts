import { supabase } from "@/lib/supabase/client";
import type {
  CustomerActivity,
  FunnelStep,
  OnlineVisitor,
  ProductAnalytics,
  TrafficSourceRow,
  TrafficSummary,
} from "@/lib/analytics/types";

function num(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

function int(value: unknown): number {
  return Math.trunc(num(value));
}

function rpcError(error: { message?: string }, fallback: string): Error {
  return new Error(error.message || fallback);
}

export type AnalyticsDateRange = {
  dateFrom: string | null;
  dateTo: string | null;
};

export async function getTrafficSummary(
  range: AnalyticsDateRange = { dateFrom: null, dateTo: null },
): Promise<TrafficSummary> {
  const { data, error } = await supabase.rpc("admin_get_traffic_summary", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить сводку посетителей");
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    visitors_today: int(raw.visitors_today),
    online_now: int(raw.online_now),
    unique_visitors: int(raw.unique_visitors),
    sessions_count: int(raw.sessions_count),
    new_visitors: int(raw.new_visitors),
    returning_visitors: int(raw.returning_visitors),
    product_views: int(raw.product_views),
    cart_adds: int(raw.cart_adds),
    checkout_starts: int(raw.checkout_starts),
    orders_created: int(raw.orders_created),
    conversion_rate: num(raw.conversion_rate),
    period: {
      date_from: String(raw.date_from ?? ""),
      date_to: String(raw.date_to ?? ""),
    },
  };
}

export async function getTrafficFunnel(
  range: AnalyticsDateRange = { dateFrom: null, dateTo: null },
): Promise<FunnelStep[]> {
  const { data, error } = await supabase.rpc("admin_get_traffic_funnel", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить воронку");
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const steps = Array.isArray(raw.steps) ? raw.steps : Array.isArray(data) ? data : [];

  return steps.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      step: String(row.step ?? ""),
      label: String(row.label ?? row.step ?? ""),
      count: int(row.count),
      rate_from_previous:
        row.rate_from_previous == null ? null : num(row.rate_from_previous),
    };
  });
}

export async function getTrafficSources(
  range: AnalyticsDateRange = { dateFrom: null, dateTo: null },
): Promise<TrafficSourceRow[]> {
  const { data, error } = await supabase.rpc("admin_get_traffic_sources", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить источники");
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.sources)
    ? raw.sources
    : Array.isArray(data)
      ? data
      : [];

  return rows.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      traffic_source: String(row.traffic_source ?? "direct"),
      sessions_count: int(row.sessions_count ?? row.sessions ?? row.count),
      visitors_count: int(
        row.visitors_count ?? row.unique_visitors ?? row.sessions_count ?? row.sessions,
      ),
    };
  });
}

export async function getOnlineVisitors(): Promise<OnlineVisitor[]> {
  const { data, error } = await supabase.rpc("admin_get_online_visitors");

  if (error) {
    throw rpcError(error, "Не удалось загрузить онлайн");
  }

  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown> | null)?.visitors)
      ? ((data as Record<string, unknown>).visitors as unknown[])
      : [];

  return rows.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      session_id: String(row.session_id ?? ""),
      visitor_id: String(row.visitor_id ?? ""),
      profile_id: (row.profile_id as string | null) ?? null,
      customer_id: (row.customer_id as string | null) ?? null,
      display_name: (row.display_name as string | null) ?? null,
      company_name: (row.company_name as string | null) ?? null,
      last_page: (row.last_page as string | null) ?? null,
      last_seen_at: String(row.last_seen_at ?? ""),
      is_authenticated: Boolean(row.is_authenticated),
    };
  });
}

export async function getProductAnalytics(
  productId: string,
): Promise<ProductAnalytics> {
  const { data, error } = await supabase.rpc("staff_get_product_analytics", {
    p_product_id: productId,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить аналитику товара");
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    product_id: String(raw.product_id ?? productId),
    views_today: int(raw.views_today),
    views_7d: int(raw.views_7d),
    views_30d: int(raw.views_30d),
    views_total: int(raw.views_total),
    cart_adds: int(raw.cart_adds),
    favorite_adds: int(raw.favorite_adds),
    orders_count: int(raw.orders_count),
    conversion_cart: num(raw.conversion_cart),
    conversion_order: num(raw.conversion_order),
  };
}

export async function getCustomerActivity(
  customerId: string,
): Promise<CustomerActivity> {
  const { data, error } = await supabase.rpc("staff_get_customer_activity", {
    p_customer_id: customerId,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить активность клиента");
  }

  const raw = (data ?? {}) as Record<string, unknown>;

  return {
    customer_id: String(raw.customer_id ?? customerId),
    last_visit: (raw.last_visit as string | null) ?? null,
    traffic_source: (raw.traffic_source as string | null) ?? null,
    pages: (Array.isArray(raw.pages) ? raw.pages : []).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        page: String(row.page ?? ""),
        count: int(row.count ?? row.views),
        last_at: String(row.last_at ?? row.last_seen_at ?? ""),
      };
    }),
    products_viewed: (Array.isArray(raw.products_viewed) ? raw.products_viewed : []).map(
      (item) => {
        const row = item as Record<string, unknown>;
        return {
          product_id: String(row.product_id ?? ""),
          product_name: (row.product_name as string | null) ?? null,
          product_sku: (row.product_sku as string | null) ?? null,
          views: int(row.views ?? row.count),
          last_at: String(row.last_at ?? row.last_seen_at ?? ""),
        };
      },
    ),
    searches: (Array.isArray(raw.searches) ? raw.searches : []).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        query: String(row.query ?? ""),
        count: int(row.count),
        last_at: String(row.last_at ?? row.last_seen_at ?? ""),
      };
    }),
    cart_adds: (Array.isArray(raw.cart_adds) ? raw.cart_adds : []).map((item) => {
      const row = item as Record<string, unknown>;
      return {
        product_id: String(row.product_id ?? ""),
        product_name: (row.product_name as string | null) ?? null,
        count: int(row.count ?? row.views),
        last_at: String(row.last_at ?? row.last_seen_at ?? ""),
      };
    }),
    cart_removes: (Array.isArray(raw.cart_removes) ? raw.cart_removes : []).map(
      (item) => {
        const row = item as Record<string, unknown>;
        return {
          product_id: String(row.product_id ?? ""),
          product_name: (row.product_name as string | null) ?? null,
          count: int(row.count ?? row.views),
          last_at: String(row.last_at ?? row.last_seen_at ?? ""),
        };
      },
    ),
    last_activity: (raw.last_activity as string | null) ?? null,
    registered_at: (raw.registered_at as string | null) ?? null,
    visits_count: int(raw.visits_count),
    avg_session_duration_seconds:
      raw.avg_session_duration_seconds == null
        ? null
        : num(raw.avg_session_duration_seconds),
    recent_events: (Array.isArray(raw.recent_events) ? raw.recent_events : []).map(
      (item) => {
        const row = item as Record<string, unknown>;
        return {
          id: String(row.id ?? ""),
          event_type: String(row.event_type ?? ""),
          page: (row.page as string | null) ?? null,
          product_id: (row.product_id as string | null) ?? null,
          created_at: String(row.created_at ?? ""),
          metadata:
            row.metadata && typeof row.metadata === "object"
              ? (row.metadata as Record<string, unknown>)
              : {},
        };
      },
    ),
  };
}
