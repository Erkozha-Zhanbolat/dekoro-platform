"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import { formatPrice } from "@/lib/formatPrice";
import {
  resolvePeriodPreset,
  type PeriodPreset,
} from "@/lib/staff/dashboard";
import {
  formatComparisonPct,
  getSalesAnalyticsCategories,
  getSalesAnalyticsChart,
  getSalesAnalyticsCustomers,
  getSalesAnalyticsProducts,
  getSalesAnalyticsSummary,
  type SalesAnalyticsCategory,
  type SalesAnalyticsChartPoint,
  type SalesAnalyticsCustomer,
  type SalesAnalyticsProduct,
  type SalesAnalyticsSummary,
  type SalesComparisonMetric,
} from "@/lib/staff/salesAnalytics";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: "today", label: "Сегодня" },
  { value: "7d", label: "7 дней" },
  { value: "30d", label: "30 дней" },
  { value: "this_month", label: "Текущий месяц" },
  { value: "last_month", label: "Прошлый месяц" },
  { value: "custom", label: "Произвольный" },
];

type ProductSortKey = "sales_gross" | "quantity_sold" | "orders_count";

function formatRuDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, day] = iso.split("-");
    return `${day}.${m}.${y}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" });
}

function formatQty(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatSharePct(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(value)}%`;
}

/** Primary gross sales + muted VAT (and optional share) breakdown. */
function SalesAmount({
  gross,
  vat,
  sharePct,
  shareSuffix,
  align = "right",
}: {
  gross: number;
  vat: number;
  sharePct?: number;
  shareSuffix?: string;
  align?: "left" | "right";
}) {
  const vatParts = [`в т.ч. НДС ${formatPrice(vat)}`];
  if (sharePct != null && shareSuffix) {
    vatParts.push(`${formatSharePct(sharePct)} ${shareSuffix}`);
  }

  return (
    <div className={align === "right" ? "text-right" : "text-left"}>
      <p className="font-semibold tabular-nums text-neutral-800">
        {formatPrice(gross)}
      </p>
      <p className="mt-0.5 text-xs tabular-nums text-neutral-500">
        {vatParts.join(" · ")}
      </p>
    </div>
  );
}

function ComparisonChip({
  metric,
  formatValue,
}: {
  metric: SalesComparisonMetric;
  formatValue: (n: number) => string;
}) {
  const pct = formatComparisonPct(metric);
  const positive = metric.has_baseline && (metric.pct_change ?? 0) > 0;
  const negative = metric.has_baseline && (metric.pct_change ?? 0) < 0;
  return (
    <div
      className={`mt-2 inline-flex flex-col gap-0.5 rounded-md px-2 py-1 text-xs ${
        positive
          ? "bg-emerald-50 text-emerald-800"
          : negative
            ? "bg-red-50 text-red-700"
            : "bg-neutral-50 text-neutral-600"
      }`}
    >
      <span className="font-medium">{pct}</span>
      {metric.has_baseline ? (
        <span className="text-[11px] opacity-80">
          предыдущий период: {formatValue(metric.previous)}
        </span>
      ) : null}
    </div>
  );
}

function MetricCard({
  label,
  value,
  secondary,
  comparison,
  formatComparisonValue,
}: {
  label: string;
  value: string;
  secondary?: ReactNode;
  comparison?: SalesComparisonMetric;
  formatComparisonValue?: (n: number) => string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-neutral-800">{value}</p>
      {secondary ? (
        <div className="mt-1 space-y-0.5 text-xs text-neutral-500">{secondary}</div>
      ) : null}
      {comparison && formatComparisonValue ? (
        <ComparisonChip metric={comparison} formatValue={formatComparisonValue} />
      ) : null}
    </div>
  );
}

function SalesChart({ points }: { points: SalesAnalyticsChartPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-neutral-500">Нет данных за период</p>
    );
  }

  const maxValue = Math.max(1, ...points.map((p) => p.sales_gross));
  const chartHeight = 180;

  return (
    <div className="overflow-x-auto">
      <div
        className="flex items-end gap-1.5 sm:gap-2"
        style={{ minWidth: Math.max(points.length * 28, 280), height: chartHeight + 36 }}
      >
        {points.map((point) => {
          const h = Math.round((point.sales_gross / maxValue) * chartHeight);
          const tooltip = [
            point.bucket_label,
            `Продажи: ${formatPrice(point.sales_gross)}`,
            `в т.ч. НДС: ${formatPrice(point.sales_vat)}`,
            `Заказов: ${point.orders_count}`,
            `Продано: ${formatQty(point.quantity_sold)} шт.`,
          ].join("\n");
          return (
            <div
              key={point.bucket_date}
              className="flex flex-1 flex-col items-center gap-1"
              title={tooltip}
            >
              <div className="flex w-full items-end justify-center" style={{ height: chartHeight }}>
                <div
                  className="w-full max-w-5 rounded-t-sm bg-[#0F766E]"
                  style={{ height: Math.max(h, point.sales_gross > 0 ? 2 : 0) }}
                />
              </div>
              <span className="truncate text-[10px] text-neutral-400">
                {point.bucket_label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  active,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`pb-2 ${align === "right" ? "pr-3 text-right" : "pr-3 text-left"} last:pr-0`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`text-xs font-medium uppercase tracking-wide transition-colors ${focusRing} ${
          active ? "text-[#0F766E]" : "text-neutral-400 hover:text-neutral-600"
        }`}
      >
        {label}
        {active ? " ↓" : ""}
      </button>
    </th>
  );
}

export default function StaffAnalyticsPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const isAdmin = profile?.role === "admin";

  const [preset, setPreset] = useState<PeriodPreset>("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [productSort, setProductSort] = useState<ProductSortKey>("sales_gross");

  const [summary, setSummary] = useState<SalesAnalyticsSummary | null>(null);
  const [chart, setChart] = useState<SalesAnalyticsChartPoint[]>([]);
  const [products, setProducts] = useState<SalesAnalyticsProduct[]>([]);
  const [categories, setCategories] = useState<SalesAnalyticsCategory[]>([]);
  const [customers, setCustomers] = useState<SalesAnalyticsCustomer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>();

  const range = useMemo(() => {
    if (preset === "custom") {
      if (!customFrom || !customTo || customFrom > customTo) {
        return null;
      }
      return { dateFrom: customFrom, dateTo: customTo };
    }
    return resolvePeriodPreset(preset);
  }, [preset, customFrom, customTo]);

  const periodKey =
    range?.dateFrom && range.dateTo
      ? `${range.dateFrom}:${range.dateTo}:${reloadToken}`
      : `idle:${reloadToken}`;
  const loading = loadedKey !== periodKey;

  useEffect(() => {
    if (!profileLoading && profile && !isAdmin) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, isAdmin, router]);

  useEffect(() => {
    if (!isAdmin || !range?.dateFrom || !range.dateTo) return;
    let ignore = false;
    const key = periodKey;

    Promise.all([
      getSalesAnalyticsSummary(range),
      getSalesAnalyticsChart(range),
      getSalesAnalyticsProducts(range),
      getSalesAnalyticsCategories(range),
      getSalesAnalyticsCustomers(range),
    ])
      .then(([s, c, p, cat, cust]) => {
        if (ignore) return;
        setSummary(s);
        setChart(c);
        setProducts(p);
        setCategories(cat);
        setCustomers(cust);
        setError(null);
        setLoadedKey(key);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить аналитику продаж",
        );
        setLoadedKey(key);
      });

    return () => {
      ignore = true;
    };
  }, [isAdmin, range, periodKey]);

  const sortedProducts = useMemo(() => {
    const list = [...products];
    list.sort((a, b) => b[productSort] - a[productSort]);
    return list;
  }, [products, productSort]);

  if (profileLoading || !isAdmin) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  const periodLabel =
    summary != null
      ? `${formatRuDate(summary.period.date_from)} — ${formatRuDate(summary.period.date_to)}`
      : range?.dateFrom && range.dateTo
        ? `${formatRuDate(range.dateFrom)} — ${formatRuDate(range.dateTo)}`
        : "—";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/staff"
            className={`text-sm font-medium text-neutral-500 hover:text-[#0F766E] ${focusRing}`}
          >
            ← Главная
          </Link>
          <h1 className="mt-3 text-2xl font-bold text-neutral-800">
            Аналитика продаж
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Продажи, товары и клиенты · {periodLabel} · Asia/Almaty
          </p>
          <p
            className="mt-1.5 text-xs text-neutral-400"
            title="Продажи показаны с НДС. Сумма НДС указана отдельно."
          >
            Продажи показаны с НДС. Сумма НДС указана отдельно.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadToken((t) => t + 1)}
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
              onClick={() => setPreset(option.value)}
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
            {customFrom && customTo && customFrom > customTo && (
              <p className="text-sm text-red-600">Дата «с» не может быть позже «по»</p>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : error ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {error}
        </div>
      ) : summary ? (
        <>
          <section>
            <h2 className="mb-3 text-lg font-semibold text-neutral-800">
              Ключевые показатели
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <MetricCard
                label="Продажи"
                value={formatPrice(summary.kpi.sales_gross)}
                secondary={
                  <>
                    <p>без НДС {formatPrice(summary.kpi.sales_net)}</p>
                    <p>в т.ч. НДС {formatPrice(summary.kpi.sales_vat)}</p>
                  </>
                }
                comparison={summary.comparison.sales_gross}
                formatComparisonValue={formatPrice}
              />
              <MetricCard
                label="Завершённые заказы"
                value={String(summary.kpi.completed_orders_count)}
                comparison={summary.comparison.completed_orders}
                formatComparisonValue={(n) => String(Math.trunc(n))}
              />
              <MetricCard
                label="Продано"
                value={`${formatQty(summary.kpi.quantity_sold)} шт.`}
                comparison={summary.comparison.quantity_sold}
                formatComparisonValue={(n) => `${formatQty(n)} шт.`}
              />
              <MetricCard
                label="Средний чек"
                value={formatPrice(summary.kpi.average_order_value)}
                comparison={summary.comparison.average_order_value}
                formatComparisonValue={formatPrice}
              />
              <MetricCard
                label="Оплачено"
                value={formatPrice(summary.kpi.payments_amount)}
              />
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="mb-4 text-lg font-semibold text-neutral-800">
              Динамика продаж
            </h2>
            <SalesChart points={chart} />
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white">
            <div className="border-b border-neutral-200 px-5 py-4">
              <h2 className="text-lg font-semibold text-neutral-800">
                Продажи по товарам
              </h2>
            </div>
            <div className="overflow-x-auto p-5">
              {sortedProducts.length === 0 ? (
                <p className="text-sm text-neutral-500">Нет продаж за период</p>
              ) : (
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      <th className="pb-2 pr-3 text-left text-xs uppercase tracking-wide text-neutral-400">
                        SKU
                      </th>
                      <th className="pb-2 pr-3 text-left text-xs uppercase tracking-wide text-neutral-400">
                        Товар
                      </th>
                      <th className="pb-2 pr-3 text-left text-xs uppercase tracking-wide text-neutral-400">
                        Категория
                      </th>
                      <SortHeader
                        label="Продано"
                        active={productSort === "quantity_sold"}
                        onClick={() => setProductSort("quantity_sold")}
                        align="right"
                      />
                      <SortHeader
                        label="Заказов"
                        active={productSort === "orders_count"}
                        onClick={() => setProductSort("orders_count")}
                        align="right"
                      />
                      <SortHeader
                        label="Продажи"
                        active={productSort === "sales_gross"}
                        onClick={() => setProductSort("sales_gross")}
                        align="right"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProducts.map((row) => (
                      <tr
                        key={row.product_id}
                        className="border-b border-neutral-100 last:border-0"
                      >
                        <td className="py-3 pr-3 text-neutral-500">{row.product_sku}</td>
                        <td className="py-3 pr-3">
                          <Link
                            href={`/staff/products/${row.product_id}`}
                            className={`font-medium text-neutral-800 hover:text-[#0F766E] ${focusRing}`}
                          >
                            {row.product_name}
                          </Link>
                        </td>
                        <td className="py-3 pr-3 text-neutral-500">{row.category_name}</td>
                        <td className="py-3 pr-3 text-right tabular-nums text-neutral-800">
                          {formatQty(row.quantity_sold)} шт.
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-neutral-800">
                          {row.orders_count}
                        </td>
                        <td className="py-3">
                          <SalesAmount
                            gross={row.sales_gross}
                            vat={row.sales_vat}
                            sharePct={row.share_pct}
                            shareSuffix="продаж"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white">
            <div className="border-b border-neutral-200 px-5 py-4">
              <h2 className="text-lg font-semibold text-neutral-800">Категории</h2>
            </div>
            <div className="overflow-x-auto p-5">
              {categories.length === 0 ? (
                <p className="text-sm text-neutral-500">Нет данных</p>
              ) : (
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                      <th className="pb-2 pr-3">Категория</th>
                      <th className="pb-2 pr-3 text-right">Продано</th>
                      <th className="pb-2 text-right">Продажи</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((row) => (
                      <tr
                        key={row.category_id ?? row.category_name}
                        className="border-b border-neutral-100 last:border-0"
                      >
                        <td className="py-3 pr-3 font-medium text-neutral-800">
                          {row.category_name}
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-neutral-800">
                          {formatQty(row.quantity_sold)} шт.
                        </td>
                        <td className="py-3">
                          <SalesAmount
                            gross={row.sales_gross}
                            vat={row.sales_vat}
                            sharePct={row.share_pct}
                            shareSuffix="всех продаж"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 bg-white">
            <div className="border-b border-neutral-200 px-5 py-4">
              <h2 className="text-lg font-semibold text-neutral-800">Клиенты</h2>
            </div>
            <div className="overflow-x-auto p-5">
              {customers.length === 0 ? (
                <p className="text-sm text-neutral-500">Нет данных</p>
              ) : (
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                      <th className="pb-2 pr-3">Клиент</th>
                      <th className="pb-2 pr-3 text-right">Заказов</th>
                      <th className="pb-2 pr-3 text-right">Продажи</th>
                      <th className="pb-2 pr-3 text-right">Средний чек</th>
                      <th className="pb-2 text-right">Долг</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((row) => (
                      <tr
                        key={row.customer_id}
                        className="border-b border-neutral-100 last:border-0"
                      >
                        <td className="py-3 pr-3">
                          <Link
                            href={`/staff/customers/${row.customer_id}`}
                            className={`font-medium text-neutral-800 hover:text-[#0F766E] ${focusRing}`}
                          >
                            {row.display_name}
                          </Link>
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-neutral-800">
                          {row.orders_count}
                        </td>
                        <td className="py-3 pr-3">
                          <SalesAmount
                            gross={row.sales_gross}
                            vat={row.sales_vat}
                          />
                        </td>
                        <td className="py-3 pr-3 text-right tabular-nums text-neutral-800">
                          {formatPrice(row.average_order_value)}
                        </td>
                        <td className="py-3 text-right tabular-nums text-neutral-800">
                          {row.receivables_amount > 0
                            ? formatPrice(row.receivables_amount)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
