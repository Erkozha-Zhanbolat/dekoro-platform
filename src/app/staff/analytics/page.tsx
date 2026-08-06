"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import {
  getOnlineVisitors,
  getTrafficFunnel,
  getTrafficSources,
  getTrafficSummary,
} from "@/lib/analytics/api";
import {
  almatyToday,
  resolvePeriodPreset,
  type PeriodPreset,
} from "@/lib/staff/dashboard";
import type {
  FunnelStep,
  OnlineVisitor,
  TrafficSourceRow,
  TrafficSummary,
} from "@/lib/analytics/types";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: "today", label: "Сегодня" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "this_month", label: "Текущий месяц" },
  { value: "custom", label: "Произвольный" },
];

const SOURCE_LABELS: Record<string, string> = {
  direct: "Прямой заход",
  instagram: "Instagram",
  google: "Google",
  whatsapp: "WhatsApp",
  referral: "Реферал",
  other: "Другое",
};

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
      <p className="mt-2 text-2xl font-bold tabular-nums text-neutral-800">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-neutral-400">{hint}</p> : null}
    </div>
  );
}

export default function StaffAnalyticsPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const isAdmin = profile?.role === "admin";

  const [preset, setPreset] = useState<PeriodPreset>("today");
  const [customFrom, setCustomFrom] = useState(almatyToday());
  const [customTo, setCustomTo] = useState(almatyToday());
  const [reloadToken, setReloadToken] = useState(0);

  const [summary, setSummary] = useState<TrafficSummary | null>(null);
  const [funnel, setFunnel] = useState<FunnelStep[]>([]);
  const [sources, setSources] = useState<TrafficSourceRow[]>([]);
  const [online, setOnline] = useState<OnlineVisitor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => {
    if (preset === "custom") {
      if (!customFrom || !customTo || customFrom > customTo) {
        return null;
      }
      return { dateFrom: customFrom, dateTo: customTo };
    }
    return resolvePeriodPreset(preset);
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    if (!profileLoading && profile && !isAdmin) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, isAdmin, router]);

  useEffect(() => {
    if (!isAdmin || !range) return;
    let ignore = false;

    Promise.all([
      getTrafficSummary(range),
      getTrafficFunnel(range),
      getTrafficSources(range),
      getOnlineVisitors(),
    ])
      .then(([s, f, src, o]) => {
        if (ignore) return;
        setSummary(s);
        setFunnel(f);
        setSources(src);
        setOnline(o);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить аналитику",
        );
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [isAdmin, range, reloadToken]);

  if (profileLoading || !isAdmin) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  const maxFunnel = Math.max(1, ...funnel.map((s) => s.count));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/staff"
            className={`text-sm font-medium text-neutral-500 hover:text-[#0F766E] ${focusRing}`}
          >
            ← Dashboard
          </Link>
          <h1 className="mt-3 text-2xl font-bold text-neutral-800">
            Аналитика поведения
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Внутренняя бизнес-аналитика DEKORO · Asia/Almaty
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setReloadToken((t) => t + 1);
          }}
          className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          Обновить
        </button>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setLoading(true);
                setPreset(option.value);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${focusRing} ${
                preset === option.value
                  ? "bg-[#0F766E] text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              С
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm ${focusRing}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              По
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm ${focusRing}`}
              />
            </label>
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
          <p className="mt-1 text-xs">
            Убедитесь, что миграция 026_customer_behavior.sql применена.
          </p>
        </div>
      ) : (
        <>
          {summary && (
            <section>
              <h2 className="mb-3 text-lg font-semibold text-neutral-800">
                Посетители и сессии
              </h2>
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
              <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
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
            </section>
          )}

          <section className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-neutral-800">Воронка</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Уникальные сессии (session_id) на каждом шаге одного визита
            </p>
            <div className="mt-5 flex flex-col gap-3">
              {funnel.map((step) => (
                <div key={step.step}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="font-medium text-neutral-800">
                      {step.label}
                    </span>
                    <span className="tabular-nums text-neutral-600">
                      {step.count}
                      {step.rate_from_previous != null && step.step !== "session"
                        ? ` · ${step.rate_from_previous}%`
                        : ""}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-neutral-100">
                    <div
                      className="h-full rounded bg-[#0F766E]"
                      style={{
                        width: `${Math.max(2, (step.count / maxFunnel) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-lg border border-neutral-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-neutral-800">
                Источники
              </h2>
              {sources.length === 0 ? (
                <p className="mt-3 text-sm text-neutral-500">Нет данных</p>
              ) : (
                <ul className="mt-3 divide-y divide-neutral-100 text-sm">
                  {sources.map((row) => (
                    <li
                      key={row.traffic_source}
                      className="flex justify-between gap-3 py-2"
                    >
                      <span>
                        {SOURCE_LABELS[row.traffic_source] ??
                          row.traffic_source}
                      </span>
                      <span className="tabular-nums text-neutral-600">
                        {row.sessions_count} сес. · {row.visitors_count} пос.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-neutral-200 bg-white p-5">
              <h2 className="text-lg font-semibold text-neutral-800">
                Онлайн сейчас
              </h2>
              {online.length === 0 ? (
                <p className="mt-3 text-sm text-neutral-500">Никого нет</p>
              ) : (
                <ul className="mt-3 divide-y divide-neutral-100 text-sm">
                  {online.map((row) => (
                    <li key={row.session_id} className="py-2">
                      <div className="font-medium text-neutral-800">
                        {formatVisitorLabel(row)}
                        {row.company_name ? (
                          <span className="ml-2 font-normal text-neutral-500">
                            · {row.company_name}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-neutral-500">
                        {row.last_page ?? "—"}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
