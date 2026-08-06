import { supabase } from "@/lib/supabase/client";
import type { CustomerType, OrderStatus } from "@/types/database";

/**
 * Admin director dashboard (supabase/migrations/025_admin_dashboard.sql).
 * Active admin only — other roles receive RPC denial.
 */

export type DashboardPeriod = {
  date_from: string;
  date_to: string;
  day_span: number;
};

export type DashboardKpi = {
  sales_amount: number;
  sales_orders_count: number;
  payments_amount: number;
  receivables_amount: number;
  overdue_receivables_amount: number;
  new_orders_count: number;
  average_order_value: number;
};

export type DashboardStatusRow = {
  status: OrderStatus;
  orders_count: number;
  amount_total: number;
};

export type DashboardOpsMetric = {
  orders_count: number;
  amount_total?: number;
  amount_remaining?: number;
};

export type DashboardOperational = {
  awaiting_payment: DashboardOpsMetric;
  partially_paid: DashboardOpsMetric;
  fully_paid_not_moved: DashboardOpsMetric;
  picking: DashboardOpsMetric;
  ready_for_shipment: DashboardOpsMetric;
  shipped_not_completed: DashboardOpsMetric;
  payment_overdue: DashboardOpsMetric;
  reservation_overdue: DashboardOpsMetric;
  unassigned_manager: DashboardOpsMetric;
};

export type DashboardSummary = {
  timezone: string;
  period: DashboardPeriod;
  kpi: DashboardKpi;
  statuses: DashboardStatusRow[];
  operational: DashboardOperational;
};

export type DashboardChartPoint = {
  bucket_date: string;
  bucket_label: string;
  granularity: "day" | "week" | "month";
  sales_amount: number;
  payments_amount: number;
  orders_count: number;
};

export type DashboardTopProduct = {
  product_id: string;
  product_sku: string;
  product_name: string;
  main_photo_path: string | null;
  quantity_sold: number;
  sales_amount: number;
  orders_count: number;
};

export type DashboardInventoryProduct = {
  product_id: string;
  sku: string;
  name: string;
  main_photo_path: string | null;
  available_quantity: number;
  reserved_quantity?: number;
  min_order_qty: number;
};

export type DashboardInventoryAlerts = {
  zero_available: DashboardInventoryProduct[];
  below_min_order: DashboardInventoryProduct[];
  lowest_stock: DashboardInventoryProduct[];
  reserved_quantity_total: number;
  products_with_active_reserves: number;
};

export type DashboardTopCustomer = {
  customer_id: string;
  customer_type: CustomerType;
  display_name: string;
  orders_count: number;
  sales_amount: number;
  payments_amount: number;
  receivables_amount: number;
  last_order_at: string | null;
};

export type DashboardManagerRow = {
  manager_id: string;
  full_name: string;
  email: string | null;
  role: string;
  assigned_open_orders: number;
  completed_in_period: number;
  sales_amount: number;
  awaiting_payment: number;
  payment_overdue: number;
  stale_orders: number;
  stale_days_threshold: number;
};

export type DashboardManagers = {
  stale_days_threshold: number;
  managers: DashboardManagerRow[];
  unassigned: {
    orders_count: number;
    amount_total: number;
    awaiting_payment: number;
    payment_overdue: number;
    stale_orders: number;
  };
};

export type DashboardActivityItem = {
  event_id: string;
  event_type: string;
  event_label: string;
  order_id: string;
  order_number: string;
  description: string;
  created_at: string;
};

export type DashboardDateRange = {
  dateFrom: string | null;
  dateTo: string | null;
};

function num(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value);
}

function int(value: unknown): number {
  return Math.trunc(num(value));
}

function opsMetric(raw: unknown): DashboardOpsMetric {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    orders_count: int(row.orders_count),
    amount_total: row.amount_total != null ? num(row.amount_total) : undefined,
    amount_remaining:
      row.amount_remaining != null ? num(row.amount_remaining) : undefined,
  };
}

function mapSummary(raw: Record<string, unknown>): DashboardSummary {
  const period = (raw.period ?? {}) as Record<string, unknown>;
  const kpi = (raw.kpi ?? {}) as Record<string, unknown>;
  const operational = (raw.operational ?? {}) as Record<string, unknown>;
  const statuses = Array.isArray(raw.statuses) ? raw.statuses : [];

  return {
    timezone: String(raw.timezone ?? "Asia/Almaty"),
    period: {
      date_from: String(period.date_from ?? ""),
      date_to: String(period.date_to ?? ""),
      day_span: int(period.day_span),
    },
    kpi: {
      sales_amount: num(kpi.sales_amount),
      sales_orders_count: int(kpi.sales_orders_count),
      payments_amount: num(kpi.payments_amount),
      receivables_amount: num(kpi.receivables_amount),
      overdue_receivables_amount: num(kpi.overdue_receivables_amount),
      new_orders_count: int(kpi.new_orders_count),
      average_order_value: num(kpi.average_order_value),
    },
    statuses: statuses.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        status: row.status as OrderStatus,
        orders_count: int(row.orders_count),
        amount_total: num(row.amount_total),
      };
    }),
    operational: {
      awaiting_payment: opsMetric(operational.awaiting_payment),
      partially_paid: opsMetric(operational.partially_paid),
      fully_paid_not_moved: opsMetric(operational.fully_paid_not_moved),
      picking: opsMetric(operational.picking),
      ready_for_shipment: opsMetric(operational.ready_for_shipment),
      shipped_not_completed: opsMetric(operational.shipped_not_completed),
      payment_overdue: opsMetric(operational.payment_overdue),
      reservation_overdue: opsMetric(operational.reservation_overdue),
      unassigned_manager: opsMetric(operational.unassigned_manager),
    },
  };
}

function inventoryProduct(raw: Record<string, unknown>): DashboardInventoryProduct {
  return {
    product_id: String(raw.product_id),
    sku: String(raw.sku ?? ""),
    name: String(raw.name ?? ""),
    main_photo_path: (raw.main_photo_path as string | null) ?? null,
    available_quantity: num(raw.available_quantity),
    reserved_quantity:
      raw.reserved_quantity != null ? num(raw.reserved_quantity) : undefined,
    min_order_qty: num(raw.min_order_qty),
  };
}

function mapInventory(raw: Record<string, unknown>): DashboardInventoryAlerts {
  const asList = (key: string) =>
    (Array.isArray(raw[key]) ? raw[key] : []).map((item) =>
      inventoryProduct(item as Record<string, unknown>),
    );

  return {
    zero_available: asList("zero_available"),
    below_min_order: asList("below_min_order"),
    lowest_stock: asList("lowest_stock"),
    reserved_quantity_total: num(raw.reserved_quantity_total),
    products_with_active_reserves: int(raw.products_with_active_reserves),
  };
}

function mapManagers(raw: Record<string, unknown>): DashboardManagers {
  const unassigned = (raw.unassigned ?? {}) as Record<string, unknown>;
  const managers = Array.isArray(raw.managers) ? raw.managers : [];

  return {
    stale_days_threshold: int(raw.stale_days_threshold) || 7,
    managers: managers.map((item) => {
      const row = item as Record<string, unknown>;
      return {
        manager_id: String(row.manager_id),
        full_name: String(row.full_name ?? ""),
        email: (row.email as string | null) ?? null,
        role: String(row.role ?? ""),
        assigned_open_orders: int(row.assigned_open_orders),
        completed_in_period: int(row.completed_in_period),
        sales_amount: num(row.sales_amount),
        awaiting_payment: int(row.awaiting_payment),
        payment_overdue: int(row.payment_overdue),
        stale_orders: int(row.stale_orders),
        stale_days_threshold: int(row.stale_days_threshold) || 7,
      };
    }),
    unassigned: {
      orders_count: int(unassigned.orders_count),
      amount_total: num(unassigned.amount_total),
      awaiting_payment: int(unassigned.awaiting_payment),
      payment_overdue: int(unassigned.payment_overdue),
      stale_orders: int(unassigned.stale_orders),
    },
  };
}

function rpcError(error: { message?: string }, fallback: string): Error {
  return new Error(error.message || fallback);
}

export async function getAdminDashboardSummary(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
): Promise<DashboardSummary> {
  const { data, error } = await supabase.rpc("admin_get_dashboard_summary", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить сводку dashboard");
  }

  return mapSummary((data ?? {}) as Record<string, unknown>);
}

export async function getAdminDashboardChart(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
): Promise<DashboardChartPoint[]> {
  const { data, error } = await supabase.rpc("admin_get_dashboard_chart", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить график");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    bucket_date: String(row.bucket_date),
    bucket_label: String(row.bucket_label ?? ""),
    granularity: row.granularity as DashboardChartPoint["granularity"],
    sales_amount: num(row.sales_amount),
    payments_amount: num(row.payments_amount),
    orders_count: int(row.orders_count),
  }));
}

export async function getAdminDashboardTopProducts(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
  limit = 10,
): Promise<DashboardTopProduct[]> {
  const { data, error } = await supabase.rpc("admin_get_dashboard_top_products", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
    p_limit: limit,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить топ товаров");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    product_id: String(row.product_id),
    product_sku: String(row.product_sku ?? ""),
    product_name: String(row.product_name ?? ""),
    main_photo_path: (row.main_photo_path as string | null) ?? null,
    quantity_sold: num(row.quantity_sold),
    sales_amount: num(row.sales_amount),
    orders_count: int(row.orders_count),
  }));
}

export async function getAdminDashboardInventoryAlerts(
  limit = 20,
): Promise<DashboardInventoryAlerts> {
  const { data, error } = await supabase.rpc(
    "admin_get_dashboard_inventory_alerts",
    { p_limit: limit },
  );

  if (error) {
    throw rpcError(error, "Не удалось загрузить складские риски");
  }

  return mapInventory((data ?? {}) as Record<string, unknown>);
}

export async function getAdminDashboardTopCustomers(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
  limit = 10,
): Promise<DashboardTopCustomer[]> {
  const { data, error } = await supabase.rpc(
    "admin_get_dashboard_top_customers",
    {
      p_date_from: range.dateFrom,
      p_date_to: range.dateTo,
      p_limit: limit,
    },
  );

  if (error) {
    throw rpcError(error, "Не удалось загрузить топ клиентов");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    customer_id: String(row.customer_id),
    customer_type: row.customer_type as CustomerType,
    display_name: String(row.display_name ?? ""),
    orders_count: int(row.orders_count),
    sales_amount: num(row.sales_amount),
    payments_amount: num(row.payments_amount),
    receivables_amount: num(row.receivables_amount),
    last_order_at: (row.last_order_at as string | null) ?? null,
  }));
}

export async function getAdminDashboardManagers(
  range: DashboardDateRange = { dateFrom: null, dateTo: null },
): Promise<DashboardManagers> {
  const { data, error } = await supabase.rpc("admin_get_dashboard_managers", {
    p_date_from: range.dateFrom,
    p_date_to: range.dateTo,
  });

  if (error) {
    throw rpcError(error, "Не удалось загрузить сводку менеджеров");
  }

  return mapManagers((data ?? {}) as Record<string, unknown>);
}

export async function getAdminDashboardRecentActivity(
  limit = 20,
): Promise<DashboardActivityItem[]> {
  const { data, error } = await supabase.rpc(
    "admin_get_dashboard_recent_activity",
    { p_limit: limit },
  );

  if (error) {
    throw rpcError(error, "Не удалось загрузить активность");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    event_id: String(row.event_id),
    event_type: String(row.event_type ?? ""),
    event_label: String(row.event_label ?? ""),
    order_id: String(row.order_id),
    order_number: String(row.order_number ?? ""),
    description: String(row.description ?? ""),
    created_at: String(row.created_at),
  }));
}

/** Format YYYY-MM-DD for Asia/Almaty calendar day. */
export function formatAlmatyDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function almatyToday(): string {
  return formatAlmatyDate(new Date());
}

export function addAlmatyDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function startOfAlmatyMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function previousAlmatyMonthRange(today = almatyToday()): {
  dateFrom: string;
  dateTo: string;
} {
  const thisMonthStart = startOfAlmatyMonth(today);
  const lastDayPrev = addAlmatyDays(thisMonthStart, -1);
  return {
    dateFrom: startOfAlmatyMonth(lastDayPrev),
    dateTo: lastDayPrev,
  };
}

export type PeriodPreset =
  | "today"
  | "7d"
  | "30d"
  | "this_month"
  | "last_month"
  | "custom";

export function resolvePeriodPreset(preset: PeriodPreset): DashboardDateRange {
  const today = almatyToday();

  switch (preset) {
    case "today":
      return { dateFrom: today, dateTo: today };
    case "7d":
      return { dateFrom: addAlmatyDays(today, -6), dateTo: today };
    case "30d":
      return { dateFrom: addAlmatyDays(today, -29), dateTo: today };
    case "this_month":
      return { dateFrom: startOfAlmatyMonth(today), dateTo: today };
    case "last_month": {
      const prev = previousAlmatyMonthRange(today);
      return { dateFrom: prev.dateFrom, dateTo: prev.dateTo };
    }
    case "custom":
      return { dateFrom: null, dateTo: null };
  }
}
