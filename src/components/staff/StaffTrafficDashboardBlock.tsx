"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getOnlineVisitors,
  getTrafficSummary,
} from "@/lib/analytics/api";
import type { OnlineVisitor, TrafficSummary } from "@/lib/analytics/types";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function formatVisitorLabel(row: OnlineVisitor): string {
  if (row.is_authenticated && row.display_name) {
    return row.display_name;
  }
  const short = row.visitor_id.replace(/-/g, "").slice(0, 4).toUpperCase();
  return `Visitor ${short}`;
}

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
 * Traffic block for the director dashboard (admin only).
 * Requires migration 026 applied.
 */
export function StaffTrafficDashboardBlock() {
  const [summary, setSummary] = useState<TrafficSummary | null>(null);
  const [online, setOnline] = useState<OnlineVisitor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    Promise.all([
      getTrafficSummary({ dateFrom: null, dateTo: null }),
      getOnlineVisitors(),
    ])
      .then(([s, o]) => {
        if (ignore) return;
        setSummary(s);
        setOnline(o);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setSummary(null);
        setOnline([]);
        setError(
          err instanceof Error
            ? err.message
            : "Не удалось загрузить аналитику посетителей",
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
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">
            Поведение клиентов
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Внутренняя аналитика DEKORO · сегодня (Asia/Almaty)
          </p>
        </div>
        <Link
          href="/staff/analytics"
          className={`text-sm font-medium text-[#0F766E] hover:text-[#0c5f58] ${focusRing}`}
        >
          Полная аналитика →
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
          <p className="mt-1 text-xs text-amber-700">
            Если миграция 026 ещё не применена — примените её вручную.
          </p>
        </div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <Metric
              label="Посетители сегодня"
              value={summary.visitors_today}
              hint="distinct visitor_id"
            />
            <Metric label="Онлайн сейчас" value={summary.online_now} />
            <Metric
              label="Уникальные посетители"
              value={summary.unique_visitors}
              hint="distinct visitor_id"
            />
            <Metric
              label="Сессии"
              value={summary.sessions_count}
              hint="distinct session_id"
            />
            <Metric label="Новые" value={summary.new_visitors} />
            <Metric label="Вернувшиеся" value={summary.returning_visitors} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Metric label="Просмотров товаров" value={summary.product_views} />
            <Metric label="В корзину" value={summary.cart_adds} />
            <Metric label="Начали оформление" value={summary.checkout_starts} />
            <Metric label="Создали заказ" value={summary.orders_created} />
            <Metric
              label="Конверсия"
              value={`${summary.conversion_rate}%`}
              hint="заказы / посетители"
            />
          </div>

          {online.length > 0 && (
            <div className="rounded-lg border border-neutral-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-neutral-800">
                Сейчас на сайте
              </h3>
              <ul className="mt-3 divide-y divide-neutral-100">
                {online.slice(0, 8).map((row) => (
                  <li
                    key={row.session_id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
                  >
                    <div>
                      <span className="font-medium text-neutral-800">
                        {formatVisitorLabel(row)}
                      </span>
                      {row.company_name ? (
                        <span className="ml-2 text-neutral-500">
                          · {row.company_name}
                        </span>
                      ) : null}
                    </div>
                    <span className="truncate text-neutral-500">
                      {row.last_page ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
