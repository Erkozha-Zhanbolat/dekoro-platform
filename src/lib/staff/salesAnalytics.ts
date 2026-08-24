import { supabase } from "@/lib/supabase/client";
import type { CustomerType } from "@/types/database";
import type { DashboardDateRange } from "@/lib/staff/dashboard";

/**
 * Admin sales analytics (supabase/migrations/048_sales_analytics.sql).
 * Active admin only — web traffic metrics are intentionally not exposed here.
 */

export type SalesComparisonMetric = {
  current: number;
  previous: number;
  delta: number;
  pct_change: number | null;
  has_baseline: boolean;
};

export type SalesAnalyticsSummary = {
  timezone: string;
  period: { date_from: string; date_to: string; day_span: number };
  previous_period: { date_from: string; date_to: string; day_span: number };
  kpi: {
    sales_net: number;
    sales_vat: number;
    sales_gross: number;
    completed_orders_count: number;
    quantity_sold: number;
    average_order_value: number;
    payments_amount: number;
  };
  comparison: {
    sales_gross: SalesComparisonMetric;
    completed_orders: SalesComparisonMetric;
    quantity_sold: SalesComparisonMetric;
    average_order_value: SalesComparisonMetric;
  };
};

export type SalesAnalyticsChartPoint = {
  bucket_date: string;
  bucket_label: string;
  granularity: "day" | "week" | "month";
  sales_net: number;
  sales_vat: number;
  sales_gross: number;
  orders_count: number;
  quantity_sold: number;
};

export type SalesAnalyticsProduct = {
  product_id: string;
  product_sku: string;
  product_name: string;
  category_id: string | null;
  category_name: string;
  quantity_sold: number;
  orders_count: number;
  sales_net: number;
  sales_vat: number;
  sales_gross: number;
  share_pct: number;
};

export type SalesAnalyticsCategory = {
  category_id: string | null;
  category_name: string;
  quantity_sold: number;
  sales_net: number;
  sales_vat: number;
  sales_gross: number;
  share_pct: number;
};

export type SalesAnalyticsCustomer = {
  customer_id: string;
  customer_type: CustomerType;
  display_name: string;
  orders_count: number;
  sales_net: number;
  sales_vat: number;
  sales_gross: number;
  average_order_value: number;
  receivables_amount: number;
};

function num(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

function int(value: unknown): number {
  return Math.trunc(num(value));
}

function comparisonMetric(raw: unknown): SalesComparisonMetric {
  const row = (raw ?? {}) as Record<string, unknown>;
  const pct = row.pct_change;
  return {
    current: num(row.current),
    previous: num(row.previous),
    delta: num(row.delta),
    pct_change: pct == null ? null : num(pct),
    has_baseline: Boolean(row.has_baseline),
  };
}

function rpcError(error: { message?: string }, fallback: string): Error {
  return new Error(error.message || fallback);
}

export async function getSalesAnalyticsSummary(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
): Promise<SalesAnalyticsSummary> {
  const { data, error } = await supabase.rpc("admin_get_sales_analytics_summary", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить сводку аналитики продаж");
  }

  const raw = (data ?? {}) as Record<string, unknown>;
  const period = (raw.period ?? {}) as Record<string, unknown>;
  const previous = (raw.previous_period ?? {}) as Record<string, unknown>;
  const kpi = (raw.kpi ?? {}) as Record<string, unknown>;
  const comparison = (raw.comparison ?? {}) as Record<string, unknown>;

  return {
    timezone: String(raw.timezone ?? "Asia/Almaty"),
    period: {
      date_from: String(period.date_from ?? ""),
      date_to: String(period.date_to ?? ""),
      day_span: int(period.day_span),
    },
    previous_period: {
      date_from: String(previous.date_from ?? ""),
      date_to: String(previous.date_to ?? ""),
      day_span: int(previous.day_span),
    },
    kpi: {
      sales_net: num(kpi.sales_net),
      sales_vat: num(kpi.sales_vat),
      sales_gross: num(kpi.sales_gross),
      completed_orders_count: int(kpi.completed_orders_count),
      quantity_sold: num(kpi.quantity_sold),
      average_order_value: num(kpi.average_order_value),
      payments_amount: num(kpi.payments_amount),
    },
    comparison: {
      sales_gross: comparisonMetric(comparison.sales_gross),
      completed_orders: comparisonMetric(comparison.completed_orders),
      quantity_sold: comparisonMetric(comparison.quantity_sold),
      average_order_value: comparisonMetric(comparison.average_order_value),
    },
  };
}

export async function getSalesAnalyticsChart(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
): Promise<SalesAnalyticsChartPoint[]> {
  const { data, error } = await supabase.rpc("admin_get_sales_analytics_chart", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить динамику продаж");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    bucket_date: String(row.bucket_date),
    bucket_label: String(row.bucket_label ?? ""),
    granularity: row.granularity as SalesAnalyticsChartPoint["granularity"],
    sales_net: num(row.sales_net),
    sales_vat: num(row.sales_vat),
    sales_gross: num(row.sales_gross),
    orders_count: int(row.orders_count),
    quantity_sold: num(row.quantity_sold),
  }));
}

export async function getSalesAnalyticsProducts(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
  limit = 500,
): Promise<SalesAnalyticsProduct[]> {
  const { data, error } = await supabase.rpc("admin_get_sales_analytics_products", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
    p_limit: limit,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить продажи по товарам");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    product_id: String(row.product_id),
    product_sku: String(row.product_sku ?? ""),
    product_name: String(row.product_name ?? ""),
    category_id: (row.category_id as string | null) ?? null,
    category_name: String(row.category_name ?? "Без категории"),
    quantity_sold: num(row.quantity_sold),
    orders_count: int(row.orders_count),
    sales_net: num(row.sales_net),
    sales_vat: num(row.sales_vat),
    sales_gross: num(row.sales_gross),
    share_pct: num(row.share_pct),
  }));
}

export async function getSalesAnalyticsCategories(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
): Promise<SalesAnalyticsCategory[]> {
  const { data, error } = await supabase.rpc(
    "admin_get_sales_analytics_categories",
    {
      p_date_from: range.dateFrom,
      p_date_to: range.dateTo,
    },
  );

  if (error) {
    throw rpcError(error, "Не удалось загрузить продажи по категориям");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    category_id: (row.category_id as string | null) ?? null,
    category_name: String(row.category_name ?? "Без категории"),
    quantity_sold: num(row.quantity_sold),
    sales_net: num(row.sales_net),
    sales_vat: num(row.sales_vat),
    sales_gross: num(row.sales_gross),
    share_pct: num(row.share_pct),
  }));
}

export async function getSalesAnalyticsCustomers(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
  limit = 500,
): Promise<SalesAnalyticsCustomer[]> {
  const { data, error } = await supabase.rpc(
    "admin_get_sales_analytics_customers",
    {
      p_date_from: range.dateFrom,
      p_date_to: range.dateTo,
      p_limit: limit,
    },
  );

  if (error) {
    throw rpcError(error, "Не удалось загрузить продажи по клиентам");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    customer_id: String(row.customer_id),
    customer_type: row.customer_type as CustomerType,
    display_name: String(row.display_name ?? ""),
    orders_count: int(row.orders_count),
    sales_net: num(row.sales_net),
    sales_vat: num(row.sales_vat),
    sales_gross: num(row.sales_gross),
    average_order_value: num(row.average_order_value),
    receivables_amount: num(row.receivables_amount),
  }));
}

/** Format comparison pct for UI; never shows ∞. */
export function formatComparisonPct(metric: SalesComparisonMetric): string {
  if (!metric.has_baseline || metric.pct_change == null) {
    return "Нет базы для сравнения";
  }
  const sign = metric.pct_change > 0 ? "+" : "";
  return `${sign}${metric.pct_change}%`;
}
