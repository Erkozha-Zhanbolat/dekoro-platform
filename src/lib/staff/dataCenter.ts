import { supabase } from "@/lib/supabase/client";

/**
 * Data Center / lifecycle (supabase/migrations/027_data_lifecycle.sql).
 * Active admin only. Archives: compact Postgres manifest + ZIP in Storage.
 */

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

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Требуется авторизация");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export type DataUsage = {
  timezone: string;
  counts: Record<string, number>;
  growth: Record<string, number>;
  largest_tables: Array<{
    table_name: string;
    row_estimate: number;
    total_bytes: number;
    bytes_is_estimate: boolean;
  }>;
  database: {
    approx_bytes: number;
    approx_mb: number;
    bytes_is_estimate: boolean;
    label: string;
  };
  storage: { note: string; buckets: string[]; bytes_is_estimate: boolean };
  retention: {
    raw_analytics_days: number;
    raw_analytics_expired_events: number;
    last_aggregated_at: string | null;
    last_cleanup_at: string | null;
    last_cleanup_cutoff: string | null;
  };
};

export type DashboardDataUsage = {
  orders: number;
  analytics_events: number;
  aggregates_daily: number;
  database_mb_estimate: number;
  database_bytes_estimate: number;
  bytes_is_estimate: boolean;
  raw_analytics_expired: number;
  raw_analytics_days: number;
  documents: number;
  data_archives: number;
  test_orders: number;
  last_aggregated_at: string | null;
  last_cleanup_at: string | null;
  last_cleanup_cutoff: string | null;
};

export type RetentionSettings = {
  raw_analytics_days: 30 | 90 | 180 | 365;
  snapshots_days: number;
  test_archives_days: number | null;
  last_aggregated_at: string | null;
  last_cleanup_at: string | null;
  last_cleanup_cutoff: string | null;
  auto_cleanup_enabled: boolean;
};

export type DataArchiveListItem = {
  id: string;
  archive_number: string;
  archive_type: string;
  period_from: string | null;
  period_to: string | null;
  title: string;
  status: string;
  schema_version: number;
  manifest: Record<string, unknown>;
  checksum: string | null;
  export_file_path: string | null;
  export_bytes: number | null;
  created_at: string;
  exported_at: string | null;
  db_cleaned_at: string | null;
  storage_cleaned_at: string | null;
  notes: string | null;
  approx_db_row_bytes?: number;
};

export type TestOrderRow = {
  id: string;
  order_number: string;
  status: string;
  total: number;
  customer_id: string | null;
  created_at: string;
  is_test: boolean;
  active_reserved_qty: number;
  fulfilled_reservations: number;
  released_reservations: number;
};

export type ArchiveSchedule = {
  id: string;
  schedule_key: string;
  label: string;
  cadence: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  metadata: Record<string, unknown>;
};

export type LifecycleActivity = {
  id: string;
  event_type: string;
  description: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ExportDatasetName =
  | "orders"
  | "customers"
  | "products"
  | "payments"
  | "analytics"
  | "inventory"
  | "dashboard";

function mapArchive(raw: Record<string, unknown>): DataArchiveListItem {
  return {
    id: String(raw.id),
    archive_number: String(raw.archive_number ?? ""),
    archive_type: String(raw.archive_type ?? ""),
    period_from: raw.period_from == null ? null : String(raw.period_from),
    period_to: raw.period_to == null ? null : String(raw.period_to),
    title: String(raw.title ?? ""),
    status: String(raw.status ?? ""),
    schema_version: int(raw.schema_version) || 1,
    manifest: asRecord(raw.manifest),
    checksum: raw.checksum == null ? null : String(raw.checksum),
    export_file_path:
      raw.export_file_path == null ? null : String(raw.export_file_path),
    export_bytes: raw.export_bytes == null ? null : int(raw.export_bytes),
    created_at: String(raw.created_at ?? ""),
    exported_at: raw.exported_at == null ? null : String(raw.exported_at),
    db_cleaned_at: raw.db_cleaned_at == null ? null : String(raw.db_cleaned_at),
    storage_cleaned_at:
      raw.storage_cleaned_at == null ? null : String(raw.storage_cleaned_at),
    notes: raw.notes == null ? null : String(raw.notes),
    approx_db_row_bytes:
      raw.approx_db_row_bytes == null ? undefined : int(raw.approx_db_row_bytes),
  };
}

export async function getDataUsage(): Promise<DataUsage> {
  const { data, error } = await supabase.rpc("admin_get_data_usage");
  if (error) throw rpcError(error, "Не удалось загрузить использование данных");
  const raw = asRecord(data);
  const counts = asRecord(raw.counts);
  const growth = asRecord(raw.growth);
  const database = asRecord(raw.database);
  const storage = asRecord(raw.storage);
  const retention = asRecord(raw.retention);
  const tables = Array.isArray(raw.largest_tables) ? raw.largest_tables : [];

  const countMap: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) countMap[k] = int(v);
  const growthMap: Record<string, number> = {};
  for (const [k, v] of Object.entries(growth)) growthMap[k] = int(v);

  return {
    timezone: String(raw.timezone ?? "Asia/Almaty"),
    counts: countMap,
    growth: growthMap,
    largest_tables: tables.map((item) => {
      const row = asRecord(item);
      return {
        table_name: String(row.table_name ?? ""),
        row_estimate: int(row.row_estimate),
        total_bytes: int(row.total_bytes),
        bytes_is_estimate: row.bytes_is_estimate !== false,
      };
    }),
    database: {
      approx_bytes: int(database.approx_bytes),
      approx_mb: num(database.approx_mb),
      bytes_is_estimate: true,
      label: String(database.label ?? "оценка"),
    },
    storage: {
      note: String(storage.note ?? ""),
      buckets: Array.isArray(storage.buckets)
        ? storage.buckets.map(String)
        : [],
      bytes_is_estimate: true,
    },
    retention: {
      raw_analytics_days: int(retention.raw_analytics_days) || 90,
      raw_analytics_expired_events: int(retention.raw_analytics_expired_events),
      last_aggregated_at:
        retention.last_aggregated_at == null
          ? null
          : String(retention.last_aggregated_at),
      last_cleanup_at:
        retention.last_cleanup_at == null
          ? null
          : String(retention.last_cleanup_at),
      last_cleanup_cutoff:
        retention.last_cleanup_cutoff == null
          ? null
          : String(retention.last_cleanup_cutoff),
    },
  };
}

export async function getDashboardDataUsage(): Promise<DashboardDataUsage> {
  const { data, error } = await supabase.rpc("admin_get_dashboard_data_usage");
  if (error) throw rpcError(error, "Не удалось загрузить блок использования данных");
  const raw = asRecord(data);
  return {
    orders: int(raw.orders),
    analytics_events: int(raw.analytics_events),
    aggregates_daily: int(raw.aggregates_daily),
    database_mb_estimate: num(raw.database_mb_estimate),
    database_bytes_estimate: int(raw.database_bytes_estimate),
    bytes_is_estimate: true,
    raw_analytics_expired: int(raw.raw_analytics_expired),
    raw_analytics_days: int(raw.raw_analytics_days) || 90,
    documents: int(raw.documents),
    data_archives: int(raw.data_archives),
    test_orders: int(raw.test_orders),
    last_aggregated_at:
      raw.last_aggregated_at == null ? null : String(raw.last_aggregated_at),
    last_cleanup_at:
      raw.last_cleanup_at == null ? null : String(raw.last_cleanup_at),
    last_cleanup_cutoff:
      raw.last_cleanup_cutoff == null ? null : String(raw.last_cleanup_cutoff),
  };
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  const { data, error } = await supabase.rpc("admin_get_data_retention_settings");
  if (error) throw rpcError(error, "Не удалось загрузить настройки хранения");
  const raw = asRecord(data);
  const days = int(raw.raw_analytics_days);
  return {
    raw_analytics_days: ([30, 90, 180, 365].includes(days) ? days : 90) as
      | 30
      | 90
      | 180
      | 365,
    snapshots_days: int(raw.snapshots_days) || 365,
    test_archives_days:
      raw.test_archives_days == null ? null : int(raw.test_archives_days),
    last_aggregated_at:
      raw.last_aggregated_at == null ? null : String(raw.last_aggregated_at),
    last_cleanup_at:
      raw.last_cleanup_at == null ? null : String(raw.last_cleanup_at),
    last_cleanup_cutoff:
      raw.last_cleanup_cutoff == null ? null : String(raw.last_cleanup_cutoff),
    auto_cleanup_enabled: false,
  };
}

export async function saveRetentionSettings(input: {
  raw_analytics_days: number;
  snapshots_days: number;
  test_archives_days: number | null;
}): Promise<RetentionSettings> {
  const { error } = await supabase.rpc("admin_upsert_data_retention_settings", {
    p_raw_analytics_days: input.raw_analytics_days,
    p_snapshots_days: input.snapshots_days,
    p_test_archives_days: input.test_archives_days,
  });
  if (error) throw rpcError(error, "Не удалось сохранить настройки хранения");
  return getRetentionSettings();
}

export async function createPeriodArchive(input: {
  archiveType: "weekly" | "monthly" | "export" | "manual";
  dateFrom: string;
  dateTo: string;
  title?: string | null;
}): Promise<DataArchiveListItem> {
  const { data, error } = await supabase.rpc("admin_create_period_archive", {
    p_archive_type: input.archiveType,
    p_date_from: input.dateFrom,
    p_date_to: input.dateTo,
    p_title: input.title ?? null,
  });
  if (error) throw rpcError(error, "Не удалось создать архив");
  return mapArchive(asRecord(data));
}

export async function listDataArchives(
  archiveType?: string | null,
  limit = 50,
): Promise<DataArchiveListItem[]> {
  const { data, error } = await supabase.rpc("admin_list_data_archives", {
    p_archive_type: archiveType ?? null,
    p_limit: limit,
  });
  if (error) throw rpcError(error, "Не удалось загрузить архивы");
  const raw = asRecord(data);
  const rows = Array.isArray(raw.archives) ? raw.archives : [];
  return rows.map((item) => mapArchive(asRecord(item)));
}

export async function exportArchiveToStorage(archiveId: string): Promise<{
  export_file_path: string;
  export_bytes: number;
}> {
  const headers = await authHeaders();
  const res = await fetch("/api/staff/data/archives/export", {
    method: "POST",
    headers,
    body: JSON.stringify({ archive_id: archiveId }),
  });
  const json = (await res.json()) as {
    error?: string;
    export_file_path?: string;
    export_bytes?: number;
  };
  if (!res.ok) throw new Error(json.error || "Не удалось экспортировать ZIP");
  return {
    export_file_path: String(json.export_file_path ?? ""),
    export_bytes: int(json.export_bytes),
  };
}

export async function downloadArchiveZip(archiveId: string): Promise<void> {
  const headers = await authHeaders();
  const res = await fetch("/api/staff/data/archives/download", {
    method: "POST",
    headers,
    body: JSON.stringify({ archive_id: archiveId }),
  });
  const json = (await res.json()) as {
    error?: string;
    signed_url?: string;
    archive_number?: string;
  };
  if (!res.ok || !json.signed_url) {
    throw new Error(json.error || "Не удалось получить ссылку на ZIP");
  }
  const a = document.createElement("a");
  a.href = json.signed_url;
  a.rel = "noopener";
  a.download = `${json.archive_number || "archive"}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function getExportDataset(input: {
  dataset: ExportDatasetName;
  dateFrom: string | null;
  dateTo: string | null;
}): Promise<{
  dataset: string;
  period: { date_from: string; date_to: string };
  rows: Record<string, unknown>[];
  row_count: number;
  source?: string;
}> {
  const { data, error } = await supabase.rpc("admin_get_export_dataset", {
    p_dataset: input.dataset,
    p_date_from: input.dateFrom,
    p_date_to: input.dateTo,
  });
  if (error) throw rpcError(error, "Не удалось подготовить экспорт");
  const raw = asRecord(data);
  const period = asRecord(raw.period);
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  return {
    dataset: String(raw.dataset ?? input.dataset),
    period: {
      date_from: String(period.date_from ?? ""),
      date_to: String(period.date_to ?? ""),
    },
    rows: rows.map((item) => asRecord(item)),
    row_count: int(raw.row_count),
    source: raw.source == null ? undefined : String(raw.source),
  };
}

export async function buildAnalyticsAggregates(
  dateFrom: string | null,
  dateTo: string | null,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("admin_build_analytics_aggregates", {
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  if (error) throw rpcError(error, "Не удалось построить агрегаты");
  return asRecord(data);
}

export async function cleanupRawAnalytics(input: {
  olderThanDays?: number | null;
  dryRun?: boolean;
}): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("admin_cleanup_raw_analytics", {
    p_older_than_days: input.olderThanDays ?? null,
    p_dry_run: input.dryRun ?? true,
  });
  if (error) throw rpcError(error, "Не удалось выполнить очистку analytics");
  return asRecord(data);
}

export async function listTestOrders(limit = 100): Promise<TestOrderRow[]> {
  const { data, error } = await supabase.rpc("admin_list_test_orders", {
    p_limit: limit,
  });
  if (error) throw rpcError(error, "Не удалось загрузить тестовые заказы");
  const raw = asRecord(data);
  const rows = Array.isArray(raw.orders) ? raw.orders : [];
  return rows.map((item) => {
    const row = asRecord(item);
    return {
      id: String(row.id),
      order_number: String(row.order_number ?? ""),
      status: String(row.status ?? ""),
      total: num(row.total),
      customer_id: row.customer_id == null ? null : String(row.customer_id),
      created_at: String(row.created_at ?? ""),
      is_test: Boolean(row.is_test),
      active_reserved_qty: num(row.active_reserved_qty),
      fulfilled_reservations: int(row.fulfilled_reservations),
      released_reservations: int(row.released_reservations),
    };
  });
}

export async function setOrderTestFlag(
  orderId: string,
  isTest: boolean,
): Promise<{ order_id: string; order_number: string; is_test: boolean }> {
  const { data, error } = await supabase.rpc("admin_set_order_test_flag", {
    p_order_id: orderId,
    p_is_test: isTest,
  });
  if (error) throw rpcError(error, "Не удалось изменить флаг тестового заказа");
  const raw = asRecord(data);
  return {
    order_id: String(raw.order_id),
    order_number: String(raw.order_number ?? ""),
    is_test: Boolean(raw.is_test),
  };
}

export async function prepareTestOrdersArchive(
  orderIds?: string[] | null,
): Promise<DataArchiveListItem> {
  const { data, error } = await supabase.rpc("admin_prepare_test_orders_archive", {
    p_order_ids: orderIds && orderIds.length > 0 ? orderIds : null,
  });
  if (error) throw rpcError(error, "Не удалось подготовить архив тестовых заказов");
  return mapArchive(asRecord(data));
}

export async function executeTestOrderCleanup(
  archiveId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("admin_execute_test_order_cleanup", {
    p_archive_id: archiveId,
    p_confirmation: "DELETE_TEST_ORDERS",
  });
  if (error) throw rpcError(error, "Не удалось выполнить cleanup тестовых заказов");
  return asRecord(data);
}

export async function retryArchiveStorageCleanup(
  archiveId: string,
  deleteZip = true,
): Promise<Record<string, unknown>> {
  const headers = await authHeaders();
  const res = await fetch("/api/staff/data/archives/storage-cleanup", {
    method: "POST",
    headers,
    body: JSON.stringify({ archive_id: archiveId, delete_zip: deleteZip }),
  });
  const json = (await res.json()) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(json.error || "Storage cleanup failed");
  return json;
}

export async function expireSnapshotIntents(
  dryRun = true,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("admin_expire_snapshot_intents", {
    p_dry_run: dryRun,
  });
  if (error) throw rpcError(error, "Не удалось обновить snapshot intents");
  return asRecord(data);
}

export async function listArchiveSchedules(): Promise<{
  schedules: ArchiveSchedule[];
  note: string;
}> {
  const { data, error } = await supabase.rpc("admin_list_archive_schedules");
  if (error) throw rpcError(error, "Не удалось загрузить расписание архивов");
  const raw = asRecord(data);
  const rows = Array.isArray(raw.schedules) ? raw.schedules : [];
  return {
    note: String(raw.note ?? ""),
    schedules: rows.map((item) => {
      const row = asRecord(item);
      return {
        id: String(row.id),
        schedule_key: String(row.schedule_key ?? ""),
        label: String(row.label ?? ""),
        cadence: String(row.cadence ?? ""),
        enabled: Boolean(row.enabled),
        next_run_at: row.next_run_at == null ? null : String(row.next_run_at),
        last_run_at: row.last_run_at == null ? null : String(row.last_run_at),
        metadata: asRecord(row.metadata),
      };
    }),
  };
}

export async function prepareScheduledWeeklyArchive(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(
    "admin_prepare_scheduled_weekly_archive",
  );
  if (error) throw rpcError(error, "Не удалось подготовить недельный архив");
  return asRecord(data);
}

export async function listLifecycleActivity(
  limit = 50,
): Promise<LifecycleActivity[]> {
  const { data, error } = await supabase.rpc("admin_list_lifecycle_activity", {
    p_limit: limit,
  });
  if (error) throw rpcError(error, "Не удалось загрузить журнал");
  const raw = asRecord(data);
  const rows = Array.isArray(raw.activity) ? raw.activity : [];
  return rows.map((item) => {
    const row = asRecord(item);
    return {
      id: String(row.id),
      event_type: String(row.event_type ?? ""),
      description: String(row.description ?? ""),
      metadata: asRecord(row.metadata),
      created_at: String(row.created_at ?? ""),
    };
  });
}

export const CLIENT_EXPORT_MAX_ROWS = 5000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function almatyTodayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function previousWeekRange(): { from: string; to: string } {
  const today = almatyTodayIso();
  const [y, m, d] = today.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = utc.getUTCDay();
  const toOffset = dow === 0 ? 7 : dow;
  const to = new Date(utc);
  to.setUTCDate(to.getUTCDate() - toOffset);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 6);
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export function previousMonthRange(): { from: string; to: string } {
  const today = almatyTodayIso();
  const [y, m] = today.split("-").map(Number);
  const firstThis = new Date(Date.UTC(y, m - 1, 1));
  const lastPrev = new Date(firstThis);
  lastPrev.setUTCDate(0);
  const firstPrev = new Date(
    Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1),
  );
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  return { from: iso(firstPrev), to: iso(lastPrev) };
}
