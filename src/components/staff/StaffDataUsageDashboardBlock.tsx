"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  formatBytes,
  getDashboardDataUsage,
  type DashboardDataUsage,
} from "@/lib/staff/dataCenter";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-neutral-800">{value}</p>
      {hint ? <p className="mt-1 text-xs text-neutral-400">{hint}</p> : null}
    </div>
  );
}

/**
 * Data usage summary for director dashboard (admin only).
 * Requires migration 027 applied.
 */
export function StaffDataUsageDashboardBlock() {
  const [data, setData] = useState<DashboardDataUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;
    getDashboardDataUsage()
      .then((row) => {
        if (ignore) return;
        setData(row);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setData(null);
        setError(
          err instanceof Error
            ? err.message
            : "Не удалось загрузить использование данных",
        );
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">Использование данных</h2>
          <p className="text-sm text-neutral-500">
            Объём базы, аналитика и безопасная очистка — Data Center
          </p>
        </div>
        <Link
          href="/staff/settings/data"
          className={`text-sm font-medium text-[#0F766E] hover:underline ${focusRing}`}
        >
          Управление данными →
        </Link>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg bg-neutral-100"
              aria-hidden
            />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {error}
          <p className="mt-1 text-xs text-amber-700">
            Нужна миграция 027_data_lifecycle.sql, если RPC ещё не применены.
          </p>
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Orders" value={data.orders.toLocaleString("ru-RU")} />
            <Metric
              label="Analytics events (raw)"
              value={data.analytics_events.toLocaleString("ru-RU")}
              hint={`Агрегаты (дни): ${data.aggregates_daily.toLocaleString("ru-RU")}`}
            />
            <Metric
              label="Database"
              value={`~${data.database_mb_estimate.toLocaleString("ru-RU")} MB`}
              hint={`оценка · ${formatBytes(data.database_bytes_estimate)}`}
            />
            <Metric
              label="Documents"
              value={data.documents.toLocaleString("ru-RU")}
              hint={`Архивов: ${data.data_archives}`}
            />
          </div>
          {data.raw_analytics_expired > 0 ? (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              Raw analytics старше retention ({data.raw_analytics_days} дн.):{" "}
              <span className="font-semibold tabular-nums">
                {data.raw_analytics_expired.toLocaleString("ru-RU")}
              </span>
              . Можно очистить в Data Center (сначала строятся агрегаты).
              {data.test_orders > 0 ? (
                <span className="ml-2 text-neutral-500">
                  Тестовых заказов: {data.test_orders}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
