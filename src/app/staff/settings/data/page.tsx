"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import { supabase } from "@/lib/supabase/client";
import {
  almatyTodayIso,
  buildAnalyticsAggregates,
  cleanupRawAnalytics,
  CLIENT_EXPORT_MAX_ROWS,
  createPeriodArchive,
  downloadArchiveZip,
  executeTestOrderCleanup,
  expireSnapshotIntents,
  exportArchiveToStorage,
  formatBytes,
  getDataUsage,
  getExportDataset,
  getRetentionSettings,
  listArchiveSchedules,
  listDataArchives,
  listLifecycleActivity,
  listTestOrders,
  prepareScheduledWeeklyArchive,
  prepareTestOrdersArchive,
  previousMonthRange,
  previousWeekRange,
  retryArchiveStorageCleanup,
  saveRetentionSettings,
  setOrderTestFlag,
  type ArchiveSchedule,
  type DataArchiveListItem,
  type DataUsage,
  type ExportDatasetName,
  type LifecycleActivity,
  type RetentionSettings,
  type TestOrderRow,
} from "@/lib/staff/dataCenter";
import {
  buildDatasetExportZip,
  downloadBlob,
  slugFilename,
} from "@/lib/dataLifecycle/exportZip";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass =
  `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

const btnPrimary =
  `rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0d6a63] disabled:opacity-50 ${focusRing}`;

const btnSecondary =
  `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 ${focusRing}`;

const btnDanger =
  `rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 ${focusRing}`;

type StorageScan = {
  totals: {
    files: number;
    bytes: number;
    orphan_files: number;
    orphan_bytes: number;
  };
  orphans: Record<string, { path: string; size: number }[]>;
  buckets: Record<string, { files: number; bytes: number; orphans: number }>;
};

const EXPORT_DATASETS: { value: ExportDatasetName; label: string }[] = [
  { value: "orders", label: "Заказы" },
  { value: "customers", label: "Клиенты" },
  { value: "products", label: "Товары" },
  { value: "payments", label: "Оплаты" },
  { value: "analytics", label: "Analytics" },
  { value: "inventory", label: "Inventory" },
  { value: "dashboard", label: "Dashboard KPI" },
];

function formatRuDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }
  return new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" });
}

function canDownloadArchive(row: DataArchiveListItem): boolean {
  return Boolean(row.export_file_path) && row.status !== "storage_cleaned";
}

function needsStorageCleanupRetry(row: DataArchiveListItem): boolean {
  return row.status === "storage_cleanup_pending";
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

export default function StaffDataCenterPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const isAdmin = profile?.role === "admin";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<DataUsage | null>(null);
  const [archives, setArchives] = useState<DataArchiveListItem[]>([]);
  const [retention, setRetention] = useState<RetentionSettings | null>(null);
  const [testOrders, setTestOrders] = useState<TestOrderRow[]>([]);
  const [schedules, setSchedules] = useState<ArchiveSchedule[]>([]);
  const [scheduleNote, setScheduleNote] = useState("");
  const [activity, setActivity] = useState<LifecycleActivity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [weeklyFrom, setWeeklyFrom] = useState(previousWeekRange().from);
  const [weeklyTo, setWeeklyTo] = useState(previousWeekRange().to);
  const [monthlyFrom, setMonthlyFrom] = useState(previousMonthRange().from);
  const [monthlyTo, setMonthlyTo] = useState(previousMonthRange().to);

  const [exportDataset, setExportDataset] = useState<ExportDatasetName>("orders");
  const [exportFrom, setExportFrom] = useState(almatyTodayIso());
  const [exportTo, setExportTo] = useState(almatyTodayIso());

  const [markOrderId, setMarkOrderId] = useState("");
  const [pendingTestArchiveId, setPendingTestArchiveId] = useState<string | null>(
    null,
  );
  const [storageScan, setStorageScan] = useState<StorageScan | null>(null);

  const [retentionDraft, setRetentionDraft] = useState({
    raw_analytics_days: 90 as 30 | 90 | 180 | 365,
    snapshots_days: 365,
    test_archives_never: true,
    test_archives_days: 365,
  });

  useEffect(() => {
    if (profile && profile.role !== "admin") {
      router.replace("/staff");
    }
  }, [profile, router]);

  async function reloadAll() {
    const [u, a, r, t, s, act] = await Promise.all([
      getDataUsage(),
      listDataArchives(null, 40),
      getRetentionSettings(),
      listTestOrders(100),
      listArchiveSchedules(),
      listLifecycleActivity(30),
    ]);
    setUsage(u);
    setArchives(a);
    setRetention(r);
    setTestOrders(t);
    setSchedules(s.schedules);
    setScheduleNote(s.note);
    setActivity(act);
    setRetentionDraft({
      raw_analytics_days: r.raw_analytics_days,
      snapshots_days: r.snapshots_days,
      test_archives_never: r.test_archives_days == null,
      test_archives_days: r.test_archives_days ?? 365,
    });
  }

  useEffect(() => {
    if (!isAdmin) return;
    let ignore = false;

    Promise.all([
      getDataUsage(),
      listDataArchives(null, 40),
      getRetentionSettings(),
      listTestOrders(100),
      listArchiveSchedules(),
      listLifecycleActivity(30),
    ])
      .then(([u, a, r, t, s, act]) => {
        if (ignore) return;
        setUsage(u);
        setArchives(a);
        setRetention(r);
        setTestOrders(t);
        setSchedules(s.schedules);
        setScheduleNote(s.note);
        setActivity(act);
        setRetentionDraft({
          raw_analytics_days: r.raw_analytics_days,
          snapshots_days: r.snapshots_days,
          test_archives_never: r.test_archives_days == null,
          test_archives_days: r.test_archives_days ?? 365,
        });
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить Data Center",
        );
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [isAdmin]);

  async function runAction(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setMessage(null);
    setError(null);
    try {
      await fn();
      await reloadAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ошибка операции");
    } finally {
      setBusy(null);
    }
  }

  async function createExportAndDownload(
    archiveType: "weekly" | "monthly",
    dateFrom: string,
    dateTo: string,
  ) {
    const created = await createPeriodArchive({
      archiveType,
      dateFrom,
      dateTo,
    });
    await exportArchiveToStorage(created.id);
    await downloadArchiveZip(created.id);
    setMessage(`Создан, экспортирован и скачан архив: ${created.title}`);
  }

  if (profile && !isAdmin) {
    return (
      <div className="py-16 text-center text-sm text-neutral-500">
        Перенаправление...
      </div>
    );
  }

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-neutral-500">
        Загрузка Data Center...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-10 pb-16">
      <div>
        <h1 className="text-2xl font-bold text-neutral-800">Управление данными</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Архивирование, экспорт, retention и безопасная очистка. Production-заказы
          никогда не удаляются автоматически.
        </p>
        <div className="mt-4 flex flex-wrap gap-2 border-b border-neutral-200 pb-3">
          <Link
            href="/staff/settings"
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
          >
            Организация
          </Link>
          <Link
            href="/staff/settings/users"
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
          >
            Сотрудники
          </Link>
          <Link
            href="/staff/settings/pricing"
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
          >
            Цены
          </Link>
          <span className="rounded-md bg-[#0F766E]/10 px-3 py-1.5 text-sm font-medium text-[#0F766E]">
            Data Center
          </span>
        </div>
      </div>

      {error ? (
        <div
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-md border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">
          {message}
        </div>
      ) : null}

      {/* Usage */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Использование данных</h2>
        {usage ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {(
                [
                  ["Товары", usage.counts.products],
                  ["Категории", usage.counts.categories],
                  ["Клиенты", usage.counts.customers],
                  ["Заказы", usage.counts.orders],
                  ["Позиции", usage.counts.order_items],
                  ["Оплаты", usage.counts.payments],
                  ["Документы", usage.counts.documents],
                  ["Sessions", usage.counts.analytics_sessions],
                  ["Events", usage.counts.analytics_events],
                  ["Snapshots", usage.counts.storage_snapshots],
                  ["Архивы", usage.counts.data_archives],
                  ["Test orders", usage.counts.test_orders],
                  ["Уведомления", usage.counts.staff_notifications],
                  ["Клиент. уведомления", usage.counts.client_notifications],
                  ["Поступления", usage.counts.stock_receipts],
                  ["Сверки с 1С", usage.counts.inventory_reconciliations],
                  ["Позиции сверок", usage.counts.inventory_reconciliation_items],
                ] as const
              ).map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-lg border border-neutral-200 bg-white p-3"
                >
                  <p className="text-xs text-neutral-400">{label}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-neutral-800">
                    {(value ?? 0).toLocaleString("ru-RU")}
                  </p>
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-neutral-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-neutral-400">
                  PostgreSQL (оценка)
                </p>
                <p className="mt-2 text-2xl font-bold text-neutral-800">
                  {usage.database.approx_mb.toLocaleString("ru-RU")} MB
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  {formatBytes(usage.database.approx_bytes)} ·{" "}
                  {usage.database.label || "оценка"}
                </p>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-neutral-400">
                  Рост за неделю
                </p>
                <p className="mt-2 text-sm text-neutral-700">
                  Заказы: {(usage.growth.orders_week ?? 0).toLocaleString("ru-RU")}
                  <br />
                  Events:{" "}
                  {(usage.growth.analytics_events_week ?? 0).toLocaleString("ru-RU")}
                  <br />
                  Документы:{" "}
                  {(usage.growth.documents_week ?? 0).toLocaleString("ru-RU")}
                </p>
              </div>
              <div className="rounded-lg border border-neutral-200 bg-white p-4">
                <p className="text-xs uppercase tracking-wide text-neutral-400">
                  Рост за месяц
                </p>
                <p className="mt-2 text-sm text-neutral-700">
                  Заказы: {(usage.growth.orders_month ?? 0).toLocaleString("ru-RU")}
                  <br />
                  Events:{" "}
                  {(usage.growth.analytics_events_month ?? 0).toLocaleString("ru-RU")}
                  <br />
                  Клиенты:{" "}
                  {(usage.growth.customers_month ?? 0).toLocaleString("ru-RU")}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-neutral-100 text-xs uppercase text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Таблица</th>
                    <th className="px-3 py-2">Строки ≈</th>
                    <th className="px-3 py-2">Размер (оценка)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.largest_tables.map((row) => (
                    <tr key={row.table_name} className="border-b border-neutral-50">
                      <td className="px-3 py-2 font-mono text-xs">{row.table_name}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {row.row_estimate.toLocaleString("ru-RU")}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatBytes(row.total_bytes)}
                        {row.bytes_is_estimate ? " · оценка" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
              <p className="text-xs uppercase tracking-wide text-neutral-400">
                Analytics lifecycle
              </p>
              <p className="mt-2">
                last_aggregated_at:{" "}
                {formatRuDate(usage.retention.last_aggregated_at)}
              </p>
              <p>last_cleanup_at: {formatRuDate(usage.retention.last_cleanup_at)}</p>
              <p>
                cutoff: {formatRuDate(usage.retention.last_cleanup_cutoff)}
              </p>
              {usage.retention.raw_analytics_expired_events > 0 ? (
                <p className="mt-2 text-amber-800">
                  Raw analytics старше {usage.retention.raw_analytics_days} дн.:{" "}
                  {usage.retention.raw_analytics_expired_events.toLocaleString("ru-RU")}{" "}
                  — можно очистить ниже.
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      {/* Weekly / Monthly */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-neutral-800">Архивы отчётов</h2>
        <p className="text-sm text-neutral-500">
          Еженедельный/месячный архив создаёт отчёт и НЕ удаляет рабочие заказы.
          Архивы хранят компактный manifest в Postgres; ZIP — в private Storage
          bucket data-archives.
        </p>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <h3 className="font-medium text-neutral-800">Еженедельный архив</h3>
            <p className="mt-1 text-xs text-neutral-500">
              Период: {formatRuDate(weeklyFrom)}–{formatRuDate(weeklyTo)}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-xs text-neutral-500">
                С
                <input
                  type="date"
                  className={inputClass}
                  value={weeklyFrom}
                  onChange={(e) => setWeeklyFrom(e.target.value)}
                />
              </label>
              <label className="text-xs text-neutral-500">
                По
                <input
                  type="date"
                  className={inputClass}
                  value={weeklyTo}
                  onChange={(e) => setWeeklyTo(e.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              className={`${btnPrimary} mt-3`}
              disabled={!!busy}
              onClick={() =>
                void runAction("weekly", async () => {
                  await createExportAndDownload("weekly", weeklyFrom, weeklyTo);
                })
              }
            >
              {busy === "weekly" ? "Формирование..." : "Создать → Storage → ZIP"}
            </button>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-white p-4">
            <h3 className="font-medium text-neutral-800">Ежемесячный архив</h3>
            <p className="mt-1 text-xs text-neutral-500">
              Период: {formatRuDate(monthlyFrom)}–{formatRuDate(monthlyTo)}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-xs text-neutral-500">
                С
                <input
                  type="date"
                  className={inputClass}
                  value={monthlyFrom}
                  onChange={(e) => setMonthlyFrom(e.target.value)}
                />
              </label>
              <label className="text-xs text-neutral-500">
                По
                <input
                  type="date"
                  className={inputClass}
                  value={monthlyTo}
                  onChange={(e) => setMonthlyTo(e.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              className={`${btnPrimary} mt-3`}
              disabled={!!busy}
              onClick={() =>
                void runAction("monthly", async () => {
                  await createExportAndDownload("monthly", monthlyFrom, monthlyTo);
                })
              }
            >
              {busy === "monthly" ? "Формирование..." : "Создать → Storage → ZIP"}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-neutral-100 text-xs uppercase text-neutral-400">
              <tr>
                <th className="px-3 py-2">Архив</th>
                <th className="px-3 py-2">Тип</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2">Период</th>
                <th className="px-3 py-2">DB ≈</th>
                <th className="px-3 py-2">ZIP</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {archives.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-neutral-400">
                    Архивов пока нет
                  </td>
                </tr>
              ) : (
                archives.map((row) => (
                  <tr key={row.id} className="border-b border-neutral-50">
                    <td className="px-3 py-2">
                      <div>{row.title}</div>
                      <div className="font-mono text-xs text-neutral-400">
                        {row.archive_number}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{row.archive_type}</td>
                    <td className="px-3 py-2 text-neutral-500">{row.status}</td>
                    <td className="px-3 py-2 text-neutral-500">
                      {row.period_from
                        ? `${formatRuDate(row.period_from)}–${formatRuDate(row.period_to)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-neutral-500">
                      {row.approx_db_row_bytes != null
                        ? `${formatBytes(row.approx_db_row_bytes)} · оценка`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-neutral-500">
                      {row.export_bytes != null ? formatBytes(row.export_bytes) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {canDownloadArchive(row) ? (
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={!!busy}
                            onClick={() =>
                              void runAction(`dl-${row.id}`, async () => {
                                await downloadArchiveZip(row.id);
                                setMessage(`Скачан архив: ${row.title}`);
                              })
                            }
                          >
                            ZIP
                          </button>
                        ) : null}
                        {!row.export_file_path &&
                        row.status !== "storage_cleaned" ? (
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={!!busy}
                            onClick={() =>
                              void runAction(`export-${row.id}`, async () => {
                                await exportArchiveToStorage(row.id);
                                await downloadArchiveZip(row.id);
                                setMessage(`Экспортирован и скачан: ${row.title}`);
                              })
                            }
                          >
                            Export + ZIP
                          </button>
                        ) : null}
                        {needsStorageCleanupRetry(row) ? (
                          <button
                            type="button"
                            className={btnDanger}
                            disabled={!!busy}
                            onClick={() =>
                              void runAction(`cleanup-${row.id}`, async () => {
                                await retryArchiveStorageCleanup(row.id, true);
                                setMessage(
                                  `Storage cleanup выполнен: ${row.archive_number}`,
                                );
                              })
                            }
                          >
                            Retry Storage cleanup
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Analytics retention */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Analytics retention</h2>
        <p className="text-sm text-neutral-500">
          Агрегаты (день / неделя / месяц) хранятся постоянно. Удаляются только raw
          analytics_events после построения агрегатов. Production-заказы никогда не
          удаляются автоматически.
        </p>
        {retention ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            <p>
              last_aggregated_at: {formatRuDate(retention.last_aggregated_at)}
            </p>
            <p>last_cleanup_at: {formatRuDate(retention.last_cleanup_at)}</p>
            <p>cutoff: {formatRuDate(retention.last_cleanup_cutoff)}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnSecondary}
            disabled={!!busy}
            onClick={() =>
              void runAction("agg", async () => {
                const res = await buildAnalyticsAggregates(null, null);
                setMessage(
                  `Агрегаты: дней ${String(res.days_built)}, недель ${String(res.weeks_built)}, месяцев ${String(res.months_built)}`,
                );
              })
            }
          >
            Построить агрегаты
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={!!busy}
            onClick={() =>
              void runAction("cleanup-dry", async () => {
                const res = await cleanupRawAnalytics({ dryRun: true });
                setMessage(
                  `Dry-run: к удалению events=${String(res.events_to_delete)}, orphan sessions=${String(res.orphan_sessions_to_delete)}`,
                );
              })
            }
          >
            Проверить очистку
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!!busy}
            onClick={() => {
              if (
                !window.confirm(
                  "Удалить raw analytics старше retention? Агрегаты будут построены и сохранены.",
                )
              ) {
                return;
              }
              void runAction("cleanup", async () => {
                const res = await cleanupRawAnalytics({ dryRun: false });
                setMessage(
                  `Удалено events=${String(res.events_deleted)}, sessions=${String(res.sessions_deleted)}`,
                );
              });
            }}
          >
            Очистить raw analytics
          </button>
        </div>
      </section>

      {/* Retention settings */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">
          Настройки хранения
        </h2>
        <p className="text-sm text-neutral-500">
          Только сохранение. Автоочистка по cron пока выключена.
        </p>
        <form
          className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void runAction("retention", async () => {
              await saveRetentionSettings({
                raw_analytics_days: retentionDraft.raw_analytics_days,
                snapshots_days: retentionDraft.snapshots_days,
                test_archives_days: retentionDraft.test_archives_never
                  ? null
                  : retentionDraft.test_archives_days,
              });
              setMessage("Настройки хранения сохранены");
            });
          }}
        >
          <label className="text-xs text-neutral-500">
            Raw analytics (дни)
            <select
              className={inputClass}
              value={retentionDraft.raw_analytics_days}
              onChange={(e) =>
                setRetentionDraft((prev) => ({
                  ...prev,
                  raw_analytics_days: Number(e.target.value) as 30 | 90 | 180 | 365,
                }))
              }
            >
              <option value={30}>30</option>
              <option value={90}>90</option>
              <option value={180}>180</option>
              <option value={365}>365</option>
            </select>
          </label>
          <label className="text-xs text-neutral-500">
            Snapshots (дни)
            <input
              type="number"
              min={30}
              max={3660}
              className={inputClass}
              value={retentionDraft.snapshots_days}
              onChange={(e) =>
                setRetentionDraft((prev) => ({
                  ...prev,
                  snapshots_days: Number(e.target.value) || 365,
                }))
              }
            />
          </label>
          <div className="text-xs text-neutral-500">
            Test archives
            <div className="mt-2 space-y-2">
              <label className="flex items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={retentionDraft.test_archives_never}
                  onChange={(e) =>
                    setRetentionDraft((prev) => ({
                      ...prev,
                      test_archives_never: e.target.checked,
                    }))
                  }
                />
                Никогда не истекают
              </label>
              {!retentionDraft.test_archives_never ? (
                <input
                  type="number"
                  min={30}
                  max={3660}
                  className={inputClass}
                  value={retentionDraft.test_archives_days}
                  onChange={(e) =>
                    setRetentionDraft((prev) => ({
                      ...prev,
                      test_archives_days: Number(e.target.value) || 365,
                    }))
                  }
                />
              ) : null}
            </div>
          </div>
          <div className="sm:col-span-3">
            <button type="submit" className={btnPrimary} disabled={!!busy}>
              Сохранить настройки
            </button>
          </div>
        </form>
      </section>

      {/* Export Center */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Export Center</h2>
        <p className="text-sm text-neutral-500">
          Небольшие выгрузки в браузере (до {CLIENT_EXPORT_MAX_ROWS.toLocaleString("ru-RU")}{" "}
          строк). Analytics — из агрегатов.
        </p>
        <div className="rounded-lg border border-neutral-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-xs text-neutral-500 sm:col-span-2">
              Набор
              <select
                className={inputClass}
                value={exportDataset}
                onChange={(e) =>
                  setExportDataset(e.target.value as ExportDatasetName)
                }
              >
                {EXPORT_DATASETS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-500">
              С
              <input
                type="date"
                className={inputClass}
                value={exportFrom}
                onChange={(e) => setExportFrom(e.target.value)}
              />
            </label>
            <label className="text-xs text-neutral-500">
              По
              <input
                type="date"
                className={inputClass}
                value={exportTo}
                onChange={(e) => setExportTo(e.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {(
              [
                [
                  "day",
                  () => {
                    const d = almatyTodayIso();
                    setExportFrom(d);
                    setExportTo(d);
                  },
                ],
                [
                  "week",
                  () => {
                    const w = previousWeekRange();
                    setExportFrom(w.from);
                    setExportTo(w.to);
                  },
                ],
                [
                  "month",
                  () => {
                    const m = previousMonthRange();
                    setExportFrom(m.from);
                    setExportTo(m.to);
                  },
                ],
              ] as const
            ).map(([label, fn]) => (
              <button key={label} type="button" className={btnSecondary} onClick={fn}>
                {label === "day" ? "День" : label === "week" ? "Неделя" : "Месяц"}
              </button>
            ))}
            <button
              type="button"
              className={btnPrimary}
              disabled={!!busy}
              onClick={() =>
                void runAction("export", async () => {
                  const dataset = await getExportDataset({
                    dataset: exportDataset,
                    dateFrom: exportFrom,
                    dateTo: exportTo,
                  });
                  if (dataset.row_count > CLIENT_EXPORT_MAX_ROWS) {
                    throw new Error(
                      `Слишком много строк (${dataset.row_count.toLocaleString("ru-RU")}). Лимит клиентского экспорта: ${CLIENT_EXPORT_MAX_ROWS.toLocaleString("ru-RU")}. Сузьте период или используйте архив периода.`,
                    );
                  }
                  const blob = await buildDatasetExportZip(
                    dataset.dataset,
                    dataset.period,
                    dataset.rows,
                  );
                  downloadBlob(
                    blob,
                    `${slugFilename(dataset.dataset)}_${dataset.period.date_from}_${dataset.period.date_to}.zip`,
                  );
                  setMessage(
                    `Экспорт ${dataset.dataset}: ${dataset.row_count} строк${
                      dataset.source ? ` (${dataset.source})` : ""
                    }`,
                  );
                })
              }
            >
              Скачать ZIP / Excel
            </button>
          </div>
        </div>
      </section>

      {/* Test orders */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Тестовые заказы</h2>
        <p className="text-sm text-neutral-500">
          Пометить → подготовить архив → экспорт ZIP → одна кнопка cleanup (
          admin_execute_test_order_cleanup). Отдельных restore/delete нет.
          Production-заказы никогда не удаляются автоматически.
        </p>
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-neutral-200 bg-white p-4">
          <label className="min-w-[240px] flex-1 text-xs text-neutral-500">
            UUID заказа → пометить как test
            <input
              className={inputClass}
              value={markOrderId}
              onChange={(e) => setMarkOrderId(e.target.value)}
              placeholder="order uuid"
            />
          </label>
          <button
            type="button"
            className={btnSecondary}
            disabled={!!busy || !markOrderId.trim()}
            onClick={() =>
              void runAction("mark-test", async () => {
                const res = await setOrderTestFlag(markOrderId.trim(), true);
                setMessage(`Заказ ${res.order_number} помечен как тестовый`);
                setMarkOrderId("");
              })
            }
          >
            Пометить test
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!!busy || testOrders.length === 0}
            onClick={() =>
              void runAction("prepare-test", async () => {
                const created = await prepareTestOrdersArchive();
                await exportArchiveToStorage(created.id);
                await downloadArchiveZip(created.id);
                setPendingTestArchiveId(created.id);
                setMessage(
                  `Архив тестовых заказов готов: ${created.title}. Проверьте ZIP, затем выполните cleanup.`,
                );
              })
            }
          >
            Архив → Storage → ZIP
          </button>
          <button
            type="button"
            className={btnDanger}
            disabled={!!busy || !pendingTestArchiveId}
            onClick={() => {
              if (!pendingTestArchiveId) return;
              if (
                !window.confirm(
                  "DELETE: выполнить admin_execute_test_order_cleanup? Тестовые заказы из архива будут удалены атомарно (inventory восстанавливается внутри RPC). Production-заказы не затрагиваются.",
                )
              ) {
                return;
              }
              void runAction("test-cleanup", async () => {
                const archiveId = pendingTestArchiveId;
                const res = await executeTestOrderCleanup(archiveId);
                try {
                  await retryArchiveStorageCleanup(archiveId, true);
                } catch {
                  // storage cleanup может остаться pending — покажем в списке архивов
                }
                setPendingTestArchiveId(null);
                setMessage(
                  `Cleanup выполнен: deleted=${String(res.deleted_orders ?? res.orders_deleted ?? "ok")}`,
                );
              });
            }}
          >
            Cleanup (DELETE)
          </button>
        </div>
        {pendingTestArchiveId ? (
          <p className="text-sm text-amber-800">
            Ожидает cleanup archive_id:{" "}
            <span className="font-mono text-xs">{pendingTestArchiveId}</span>
          </p>
        ) : null}
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-neutral-100 text-xs uppercase text-neutral-400">
              <tr>
                <th className="px-3 py-2">Номер</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2">Сумма</th>
                <th className="px-3 py-2">Резерв / fulfilled</th>
              </tr>
            </thead>
            <tbody>
              {testOrders.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-neutral-400">
                    Нет тестовых заказов
                  </td>
                </tr>
              ) : (
                testOrders.map((row) => (
                  <tr key={row.id} className="border-b border-neutral-50">
                    <td className="px-3 py-2">
                      <Link
                        href={`/staff/orders/${row.id}`}
                        className={`text-[#0F766E] hover:underline ${focusRing}`}
                      >
                        {row.order_number}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{row.status}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.total.toLocaleString("ru-RU")}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-neutral-500">
                      {row.active_reserved_qty} / {row.fulfilled_reservations}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Storage */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Storage</h2>
        <p className="text-sm text-neutral-500">
          Скан показывает число объектов и listed size (не биллинг Supabase). Orphan
          cleanup — только server API (active admin + service role).
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnSecondary}
            disabled={!!busy}
            onClick={() =>
              void runAction("storage-scan", async () => {
                const headers = await authHeaders();
                const res = await fetch("/api/staff/data/storage", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ action: "scan" }),
                });
                const json = (await res.json()) as StorageScan & { error?: string };
                if (!res.ok) throw new Error(json.error || "Scan failed");
                setStorageScan(json);
                setMessage(
                  `Storage scan: объектов ${json.totals.files}, listed size ${formatBytes(json.totals.bytes)}, orphan ${json.totals.orphan_files} (${formatBytes(json.totals.orphan_bytes)})`,
                );
              })
            }
          >
            Проверить orphan
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!!busy || !storageScan || storageScan.totals.orphan_files === 0}
            onClick={() => {
              if (
                !window.confirm(
                  `Удалить ${storageScan?.totals.orphan_files ?? 0} orphan файлов?`,
                )
              ) {
                return;
              }
              void runAction("storage-del", async () => {
                const headers = await authHeaders();
                const res = await fetch("/api/staff/data/storage", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ action: "delete_orphans" }),
                });
                const json = (await res.json()) as {
                  deleted?: number;
                  error?: string;
                };
                if (!res.ok) throw new Error(json.error || "Delete failed");
                setMessage(`Удалено orphan файлов: ${json.deleted ?? 0}`);
                setStorageScan(null);
              });
            }}
          >
            Удалить orphan
          </button>
          <button
            type="button"
            className={btnSecondary}
            disabled={!!busy}
            onClick={() =>
              void runAction("expire-intents", async () => {
                const res = await expireSnapshotIntents(false);
                setMessage(
                  `Истекло snapshot intents: ${String(res.expired_count)}`,
                );
              })
            }
          >
            Expire pending snapshots
          </button>
        </div>
        {storageScan ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            <p>
              product-images: {storageScan.buckets["product-images"]?.files ?? 0}{" "}
              объектов / orphan {storageScan.buckets["product-images"]?.orphans ?? 0}{" "}
              / listed size{" "}
              {formatBytes(storageScan.buckets["product-images"]?.bytes ?? 0)}
            </p>
            <p>
              organization-assets:{" "}
              {storageScan.buckets["organization-assets"]?.files ?? 0} объектов /
              orphan {storageScan.buckets["organization-assets"]?.orphans ?? 0} /
              listed size{" "}
              {formatBytes(storageScan.buckets["organization-assets"]?.bytes ?? 0)}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              Всего: {storageScan.totals.files} объектов · listed size{" "}
              {formatBytes(storageScan.totals.bytes)}
            </p>
          </div>
        ) : null}
      </section>

      {/* Schedules */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Scheduled archives</h2>
        <p className="text-sm text-neutral-500">
          {scheduleNote ||
            "Архитектура готова (воскресенье / 1-е число). Автоматизация и Cron пока не подключены."}
        </p>
        <div className="space-y-2">
          {schedules.map((row) => (
            <div
              key={row.id}
              className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm"
            >
              <p className="font-medium text-neutral-800">{row.label}</p>
              <p className="text-neutral-500">
                {row.cadence} · enabled={String(row.enabled)} · next={" "}
                {formatRuDate(row.next_run_at)}
                {row.last_run_at
                  ? ` · last ${formatRuDate(row.last_run_at)}`
                  : ""}
                {row.metadata?.cron_hint
                  ? ` · cron ${String(row.metadata.cron_hint)}`
                  : ""}
              </p>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={btnSecondary}
          disabled={!!busy}
          onClick={() =>
            void runAction("prepare-weekly", async () => {
              const res = await prepareScheduledWeeklyArchive();
              const archiveId =
                typeof res.archive_id === "string" ? res.archive_id : null;
              if (archiveId) {
                await exportArchiveToStorage(archiveId);
                await downloadArchiveZip(archiveId);
              }
              setMessage(
                `Подготовлен недельный архив ${String(res.period_from)}–${String(res.period_to)}`,
              );
            })
          }
        >
          Сформировать недельный архив сейчас
        </button>
      </section>

      {/* Activity */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-800">Журнал операций</h2>
        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white">
          {activity.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-neutral-400">
              Пока пусто
            </li>
          ) : (
            activity.map((row) => (
              <li key={row.id} className="px-4 py-3 text-sm">
                <p className="font-medium text-neutral-800">{row.description}</p>
                <p className="text-xs text-neutral-400">
                  {row.event_type} · {formatRuDate(row.created_at)}
                </p>
              </li>
            ))
          )}
        </ul>
      </section>
    </div>
  );
}
