"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import { StaffProductPhotoThumb } from "@/components/staff/StaffProductPhotoThumb";
import {
  CUSTOMER_TYPE_LABELS,
  ORDER_STATUS_LABELS,
  USER_ROLE_LABELS,
} from "@/types/database";
import type { OrderStatus, UserRole } from "@/types/database";
import {
  getAdminDashboardChart,
  getAdminDashboardInventoryAlerts,
  getAdminDashboardManagers,
  getAdminDashboardRecentActivity,
  getAdminDashboardSummary,
  getAdminDashboardTopCustomers,
  getAdminDashboardTopProducts,
  resolvePeriodPreset,
  type DashboardActivityItem,
  type DashboardChartPoint,
  type DashboardDateRange,
  type DashboardInventoryAlerts,
  type DashboardManagers,
  type DashboardSummary,
  type DashboardTopCustomer,
  type DashboardTopProduct,
  type PeriodPreset,
} from "@/lib/staff/dashboard";
import { StaffTrafficDashboardBlock } from "@/components/staff/StaffTrafficDashboardBlock";

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

const STATUS_ORDER: OrderStatus[] = [
  "new",
  "awaiting_payment",
  "paid",
  "picking",
  "ready_for_shipment",
  "shipped",
  "completed",
  "cancelled",
];

type BlockState<T> = {
  data: T | null;
  error: string | null;
};

function formatRuDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // date-only YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      const [y, m, day] = iso.split("-");
      return `${day}.${m}.${y}`;
    }
    return iso;
  }
  return d.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" });
}

function formatRuDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-neutral-100 ${className ?? ""}`}
      aria-hidden
    />
  );
}

function BlockError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
      <p role="alert">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-2 text-sm font-medium text-red-700 underline ${focusRing}`}
        >
          Повторить
        </button>
      )}
    </div>
  );
}

function SalesPaymentsChart({ points }: { points: DashboardChartPoint[] }) {
  if (points.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-neutral-500">Нет данных за период</p>
    );
  }

  const maxValue = Math.max(
    1,
    ...points.map((p) => Math.max(p.sales_amount, p.payments_amount)),
  );
  const chartHeight = 160;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4 text-xs text-neutral-500">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#0F766E]" />
          Продажи
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" />
          Оплаты
        </span>
      </div>
      <div className="overflow-x-auto">
        <div
          className="flex items-end gap-1.5 sm:gap-2"
          style={{ minWidth: Math.max(points.length * 36, 280), height: chartHeight + 36 }}
        >
          {points.map((point) => {
            const salesH = Math.round((point.sales_amount / maxValue) * chartHeight);
            const payH = Math.round((point.payments_amount / maxValue) * chartHeight);
            return (
              <div
                key={point.bucket_date}
                className="flex flex-1 flex-col items-center gap-1"
                title={`${point.bucket_label}: продажи ${formatPrice(point.sales_amount)}, оплаты ${formatPrice(point.payments_amount)}`}
              >
                <div
                  className="flex w-full items-end justify-center gap-0.5"
                  style={{ height: chartHeight }}
                >
                  <div
                    className="w-[45%] max-w-4 rounded-t-sm bg-[#0F766E]"
                    style={{ height: Math.max(salesH, point.sales_amount > 0 ? 2 : 0) }}
                  />
                  <div
                    className="w-[45%] max-w-4 rounded-t-sm bg-sky-500"
                    style={{ height: Math.max(payH, point.payments_amount > 0 ? 2 : 0) }}
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
    </div>
  );
}

export default function AdminDirectorDashboard() {
  const [preset, setPreset] = useState<PeriodPreset>("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const [summary, setSummary] = useState<BlockState<DashboardSummary>>({
    data: null,
    error: null,
  });
  const [chart, setChart] = useState<BlockState<DashboardChartPoint[]>>({
    data: null,
    error: null,
  });
  const [products, setProducts] = useState<BlockState<DashboardTopProduct[]>>({
    data: null,
    error: null,
  });
  const [inventory, setInventory] = useState<BlockState<DashboardInventoryAlerts>>({
    data: null,
    error: null,
  });
  const [customers, setCustomers] = useState<BlockState<DashboardTopCustomer[]>>({
    data: null,
    error: null,
  });
  const [managers, setManagers] = useState<BlockState<DashboardManagers>>({
    data: null,
    error: null,
  });
  const [activity, setActivity] = useState<BlockState<DashboardActivityItem[]>>({
    data: null,
    error: null,
  });

  const [loadedSummaryKey, setLoadedSummaryKey] = useState<string | undefined>();
  const [loadedChartKey, setLoadedChartKey] = useState<string | undefined>();
  const [loadedProductsKey, setLoadedProductsKey] = useState<string | undefined>();
  const [loadedInventoryKey, setLoadedInventoryKey] = useState<string | undefined>();
  const [loadedCustomersKey, setLoadedCustomersKey] = useState<string | undefined>();
  const [loadedManagersKey, setLoadedManagersKey] = useState<string | undefined>();
  const [loadedActivityKey, setLoadedActivityKey] = useState<string | undefined>();

  const range: DashboardDateRange =
    preset === "custom"
      ? { dateFrom: customFrom || null, dateTo: customTo || null }
      : resolvePeriodPreset(preset);

  const rangeReady =
    preset !== "custom" ||
    (Boolean(customFrom) && Boolean(customTo) && customFrom <= customTo);

  const activeRange: DashboardDateRange | null = !rangeReady
    ? null
    : preset === "custom"
      ? { dateFrom: customFrom, dateTo: customTo }
      : resolvePeriodPreset(preset);

  const dateFrom = activeRange?.dateFrom ?? null;
  const dateTo = activeRange?.dateTo ?? null;

  const periodKey =
    dateFrom && dateTo
      ? `${dateFrom}:${dateTo}:${reloadToken}`
      : `idle:${reloadToken}`;

  useEffect(() => {
    if (!dateFrom || !dateTo) {
      return;
    }

    let ignore = false;
    const key = periodKey;
    const rangeForRpc: DashboardDateRange = { dateFrom, dateTo };

    getAdminDashboardSummary(rangeForRpc)
      .then((data) => {
        if (ignore) return;
        setSummary({ data, error: null });
        setLoadedSummaryKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setSummary({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка сводки",
        });
        setLoadedSummaryKey(key);
      });

    getAdminDashboardChart(rangeForRpc)
      .then((data) => {
        if (ignore) return;
        setChart({ data, error: null });
        setLoadedChartKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setChart({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка графика",
        });
        setLoadedChartKey(key);
      });

    getAdminDashboardTopProducts(rangeForRpc)
      .then((data) => {
        if (ignore) return;
        setProducts({ data, error: null });
        setLoadedProductsKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setProducts({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка топа товаров",
        });
        setLoadedProductsKey(key);
      });

    getAdminDashboardInventoryAlerts()
      .then((data) => {
        if (ignore) return;
        setInventory({ data, error: null });
        setLoadedInventoryKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setInventory({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка склада",
        });
        setLoadedInventoryKey(key);
      });

    getAdminDashboardTopCustomers(rangeForRpc)
      .then((data) => {
        if (ignore) return;
        setCustomers({ data, error: null });
        setLoadedCustomersKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setCustomers({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка топа клиентов",
        });
        setLoadedCustomersKey(key);
      });

    getAdminDashboardManagers(rangeForRpc)
      .then((data) => {
        if (ignore) return;
        setManagers({ data, error: null });
        setLoadedManagersKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setManagers({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка менеджеров",
        });
        setLoadedManagersKey(key);
      });

    getAdminDashboardRecentActivity()
      .then((data) => {
        if (ignore) return;
        setActivity({ data, error: null });
        setLoadedActivityKey(key);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setActivity({
          data: null,
          error: error instanceof Error ? error.message : "Ошибка активности",
        });
        setLoadedActivityKey(key);
      });

    return () => {
      ignore = true;
    };
  }, [dateFrom, dateTo, periodKey]);

  const summaryLoading = loadedSummaryKey !== periodKey;
  const chartLoading = loadedChartKey !== periodKey;
  const productsLoading = loadedProductsKey !== periodKey;
  const inventoryLoading = loadedInventoryKey !== periodKey;
  const customersLoading = loadedCustomersKey !== periodKey;
  const managersLoading = loadedManagersKey !== periodKey;
  const activityLoading = loadedActivityKey !== periodKey;

  const retry = () => setReloadToken((t) => t + 1);

  const periodLabel =
    summary.data?.period != null
      ? `${formatRuDate(summary.data.period.date_from)} — ${formatRuDate(summary.data.period.date_to)}`
      : range.dateFrom && range.dateTo
        ? `${formatRuDate(range.dateFrom)} — ${formatRuDate(range.dateTo)}`
        : "—";

  const kpiCards = summary.data
    ? [
        {
          key: "sales",
          label: "Продажи",
          value: formatPrice(summary.data.kpi.sales_amount),
          hint: `${summary.data.kpi.sales_orders_count} заказов · сумма завершённых заказов по обязательству клиента, включая НДС, если выставлен счёт с НДС`,
        },
        {
          key: "paid",
          label: "Оплачено",
          value: formatPrice(summary.data.kpi.payments_amount),
          hint: "по дате оплаты",
        },
        {
          key: "ar",
          label: "Дебиторка",
          value: formatPrice(summary.data.kpi.receivables_amount),
          hint: "текущая",
        },
        {
          key: "overdue",
          label: "Просрочено",
          value: formatPrice(summary.data.kpi.overdue_receivables_amount),
          hint: "payment_due_at",
        },
        {
          key: "new",
          label: "Новые заказы",
          value: String(summary.data.kpi.new_orders_count),
          hint: "созданы в периоде",
        },
        {
          key: "aov",
          label: "Средний чек",
          value: formatPrice(summary.data.kpi.average_order_value),
          hint: "продажи / заказы",
        },
      ]
    : [];

  const statusByKey = new Map(
    (summary.data?.statuses ?? []).map((row) => [row.status, row]),
  );

  const ops = summary.data?.operational;

  const opsCards: {
    key: string;
    label: string;
    count: number;
    amount?: number;
    href: string;
  }[] = ops
    ? [
        {
          key: "awaiting_payment",
          label: "Ждут оплаты",
          count: ops.awaiting_payment.orders_count,
          amount: ops.awaiting_payment.amount_total,
          href: "/staff/orders?status=awaiting_payment",
        },
        {
          key: "partially_paid",
          label: "Частично оплачены",
          count: ops.partially_paid.orders_count,
          amount: ops.partially_paid.amount_remaining,
          href: "/staff/orders?payment=partially_paid",
        },
        {
          key: "fully_paid_not_moved",
          label: "Оплачены, статус не сменён",
          count: ops.fully_paid_not_moved.orders_count,
          amount: ops.fully_paid_not_moved.amount_total,
          href: "/staff/orders?ops=fully_paid_not_moved",
        },
        {
          key: "picking",
          label: "Собираются",
          count: ops.picking.orders_count,
          amount: ops.picking.amount_total,
          href: "/staff/orders?status=picking",
        },
        {
          key: "ready",
          label: "Готовы к отгрузке",
          count: ops.ready_for_shipment.orders_count,
          amount: ops.ready_for_shipment.amount_total,
          href: "/staff/orders?status=ready_for_shipment",
        },
        {
          key: "shipped",
          label: "Отгружены, не завершены",
          count: ops.shipped_not_completed.orders_count,
          amount: ops.shipped_not_completed.amount_total,
          href: "/staff/orders?status=shipped",
        },
        {
          key: "pay_overdue",
          label: "Просрочен срок оплаты",
          count: ops.payment_overdue.orders_count,
          amount: ops.payment_overdue.amount_remaining,
          href: "/staff/orders?ops=payment_overdue",
        },
        {
          key: "res_overdue",
          label: "Просрочен срок резерва",
          count: ops.reservation_overdue.orders_count,
          amount: ops.reservation_overdue.amount_total,
          href: "/staff/orders?ops=reservation_overdue",
        },
        {
          key: "unassigned",
          label: "Без менеджера",
          count: ops.unassigned_manager.orders_count,
          amount: ops.unassigned_manager.amount_total,
          href: "/staff/orders?ops=unassigned",
        },
      ]
    : [];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">
            Dashboard руководителя
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Мониторинг продаж, оплат и операций DEKORO · {periodLabel} · Asia/Almaty
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadToken((t) => t + 1)}
          className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
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
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 ${focusRing}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              По
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 ${focusRing}`}
              />
            </label>
            {!rangeReady && customFrom && customTo && customFrom > customTo && (
              <p className="text-sm text-red-600">Дата «с» не может быть позже «по»</p>
            )}
          </div>
        )}
      </div>

      <StaffTrafficDashboardBlock />

      {/* KPI */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-neutral-800">Ключевые показатели</h2>
        {summaryLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : summary.error ? (
          <BlockError message={summary.error} onRetry={retry} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {kpiCards.map((card) => (
              <div
                key={card.key}
                className="rounded-lg border border-neutral-200 bg-white p-4"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  {card.label}
                </p>
                <p className="mt-2 text-2xl font-bold text-neutral-800">{card.value}</p>
                <p className="mt-1 text-xs text-neutral-400">{card.hint}</p>
              </div>
            ))}
          </div>
        )}
        {!summaryLoading && !summary.error && (
          <p className="mt-3 text-xs text-neutral-400">
            В продажи периода входят только заказы с записью перехода в «Завершён» в истории
            статусов. Старые completed без history не учитываются (ограничение исторических
            данных).
          </p>
        )}
      </section>

      {/* Chart */}
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-neutral-800">
          Продажи и оплаты
        </h2>
        {chartLoading ? (
          <Skeleton className="h-48" />
        ) : chart.error ? (
          <BlockError message={chart.error} onRetry={retry} />
        ) : (
          <SalesPaymentsChart points={chart.data ?? []} />
        )}
      </section>

      {/* Statuses */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-neutral-800">Заказы по статусам</h2>
        {summaryLoading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : summary.error ? (
          <BlockError message={summary.error} />
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {STATUS_ORDER.map((status) => {
              const row = statusByKey.get(status);
              return (
                <Link
                  key={status}
                  href={`/staff/orders?status=${status}`}
                  className={`rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-[#0F766E] ${focusRing}`}
                >
                  <p className="text-xs font-medium text-neutral-400">
                    {ORDER_STATUS_LABELS[status]}
                  </p>
                  <p className="mt-1 text-xl font-bold text-neutral-800">
                    {row?.orders_count ?? 0}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {formatPrice(row?.amount_total ?? 0)}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Operational */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-neutral-800">
          Операционные предупреждения
        </h2>
        {summaryLoading ? (
          <Skeleton className="h-40" />
        ) : summary.error ? (
          <BlockError message={summary.error} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {opsCards.map((card) => (
              <Link
                key={card.key}
                href={card.href}
                className={`rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-[#0F766E] ${focusRing}`}
              >
                <p className="text-sm font-medium text-neutral-700">{card.label}</p>
                <p className="mt-2 text-2xl font-bold text-neutral-800">{card.count}</p>
                {card.amount != null && (
                  <p className="mt-1 text-xs text-neutral-500">{formatPrice(card.amount)}</p>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Top products */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Топ товаров</h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            Продажи товаров без НДС · сумма по позициям заказа (order_items.line_total),
            без распределения НДС со счёта
          </p>
        </div>
        <div className="p-5">
          {productsLoading ? (
            <Skeleton className="h-40" />
          ) : products.error ? (
            <BlockError message={products.error} onRetry={retry} />
          ) : !products.data?.length ? (
            <p className="text-sm text-neutral-500">Нет продаж за период</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                    <th className="pb-2 pr-3">Товар</th>
                    <th className="pb-2 pr-3">SKU</th>
                    <th className="pb-2 pr-3 text-right">Кол-во</th>
                    <th className="pb-2 pr-3 text-right">Сумма</th>
                    <th className="pb-2 text-right">Заказы</th>
                  </tr>
                </thead>
                <tbody>
                  {products.data.map((product) => (
                    <tr key={product.product_id} className="border-b border-neutral-100 last:border-0">
                      <td className="py-3 pr-3">
                        <Link
                          href={`/staff/products/${product.product_id}`}
                          className={`flex items-center gap-3 font-medium text-neutral-800 hover:text-[#0F766E] ${focusRing}`}
                        >
                          <StaffProductPhotoThumb
                            path={product.main_photo_path}
                            alt={product.product_name}
                            className="h-10 w-10 shrink-0 rounded"
                          />
                          <span className="line-clamp-2">{product.product_name}</span>
                        </Link>
                      </td>
                      <td className="py-3 pr-3 text-neutral-500">{product.product_sku}</td>
                      <td className="py-3 pr-3 text-right text-neutral-700">
                        {product.quantity_sold}
                      </td>
                      <td className="py-3 pr-3 text-right font-medium">
                        {formatPrice(product.sales_amount)}
                      </td>
                      <td className="py-3 text-right text-neutral-600">
                        {product.orders_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Inventory */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Остатки и риски</h2>
        </div>
        <div className="flex flex-col gap-6 p-5">
          {inventoryLoading ? (
            <Skeleton className="h-40" />
          ) : inventory.error ? (
            <BlockError message={inventory.error} onRetry={retry} />
          ) : inventory.data ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-md bg-neutral-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-neutral-400">
                    Зарезервировано
                  </p>
                  <p className="mt-1 text-xl font-bold text-neutral-800">
                    {inventory.data.reserved_quantity_total}
                  </p>
                </div>
                <div className="rounded-md bg-neutral-50 p-4">
                  <p className="text-xs uppercase tracking-wide text-neutral-400">
                    Товары с резервами
                  </p>
                  <p className="mt-1 text-xl font-bold text-neutral-800">
                    {inventory.data.products_with_active_reserves}
                  </p>
                </div>
              </div>
              <InventoryList
                title="Нулевой доступный остаток"
                items={inventory.data.zero_available}
              />
              <InventoryList
                title="Ниже минимального заказа"
                items={inventory.data.below_min_order}
              />
              <InventoryList
                title="Самые низкие остатки"
                items={inventory.data.lowest_stock}
                showReserved
              />
            </>
          ) : null}
        </div>
      </section>

      {/* Top customers */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Топ клиентов</h2>
        </div>
        <div className="p-5">
          {customersLoading ? (
            <Skeleton className="h-40" />
          ) : customers.error ? (
            <BlockError message={customers.error} onRetry={retry} />
          ) : !customers.data?.length ? (
            <p className="text-sm text-neutral-500">Нет завершённых заказов за период</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                    <th className="pb-2 pr-3">Клиент</th>
                    <th className="pb-2 pr-3">Тип</th>
                    <th className="pb-2 pr-3 text-right">Заказы</th>
                    <th className="pb-2 pr-3 text-right">Продажи</th>
                    <th className="pb-2 pr-3 text-right">Оплачено</th>
                    <th className="pb-2 pr-3 text-right">Долг</th>
                    <th className="pb-2">Последний</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.data.map((customer) => (
                    <tr key={customer.customer_id} className="border-b border-neutral-100 last:border-0">
                      <td className="py-3 pr-3">
                        <Link
                          href={`/staff/customers/${customer.customer_id}`}
                          className={`font-medium text-neutral-800 hover:text-[#0F766E] ${focusRing}`}
                        >
                          {customer.display_name}
                        </Link>
                      </td>
                      <td className="py-3 pr-3 text-neutral-500">
                        {CUSTOMER_TYPE_LABELS[customer.customer_type]}
                      </td>
                      <td className="py-3 pr-3 text-right">{customer.orders_count}</td>
                      <td className="py-3 pr-3 text-right font-medium">
                        {formatPrice(customer.sales_amount)}
                      </td>
                      <td className="py-3 pr-3 text-right">
                        {formatPrice(customer.payments_amount)}
                      </td>
                      <td className="py-3 pr-3 text-right">
                        {formatPrice(customer.receivables_amount)}
                      </td>
                      <td className="py-3 text-neutral-500">
                        {formatRuDate(customer.last_order_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Managers */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Менеджеры</h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            Операционный обзор, не KPI для зарплаты
            {managers.data
              ? ` · без движения > ${managers.data.stale_days_threshold} дн.`
              : ""}
          </p>
        </div>
        <div className="flex flex-col gap-4 p-5">
          {managersLoading ? (
            <Skeleton className="h-40" />
          ) : managers.error ? (
            <BlockError message={managers.error} onRetry={retry} />
          ) : managers.data ? (
            <>
              {managers.data.unassigned.orders_count > 0 && (
                <Link
                  href="/staff/orders?ops=unassigned"
                  className={`rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${focusRing}`}
                >
                  Без менеджера: {managers.data.unassigned.orders_count} заказов ·{" "}
                  {formatPrice(managers.data.unassigned.amount_total)}
                </Link>
              )}
              {!managers.data.managers.length ? (
                <p className="text-sm text-neutral-500">Нет активных менеджеров</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400">
                        <th className="pb-2 pr-3">Менеджер</th>
                        <th className="pb-2 pr-3 text-right">Открытые</th>
                        <th className="pb-2 pr-3 text-right">Завершено</th>
                        <th className="pb-2 pr-3 text-right">Продажи</th>
                        <th className="pb-2 pr-3 text-right">Ждут оплаты</th>
                        <th className="pb-2 pr-3 text-right">Просрочено</th>
                        <th className="pb-2 text-right">Без движения</th>
                      </tr>
                    </thead>
                    <tbody>
                      {managers.data.managers.map((manager) => (
                        <tr
                          key={manager.manager_id}
                          className="border-b border-neutral-100 last:border-0"
                        >
                          <td className="py-3 pr-3">
                            <p className="font-medium text-neutral-800">
                              {manager.full_name}
                            </p>
                            <p className="text-xs text-neutral-400">
                              {USER_ROLE_LABELS[manager.role as UserRole] ?? manager.role}
                              {manager.email ? ` · ${manager.email}` : ""}
                            </p>
                          </td>
                          <td className="py-3 pr-3 text-right">
                            {manager.assigned_open_orders}
                          </td>
                          <td className="py-3 pr-3 text-right">
                            {manager.completed_in_period}
                          </td>
                          <td className="py-3 pr-3 text-right font-medium">
                            {formatPrice(manager.sales_amount)}
                          </td>
                          <td className="py-3 pr-3 text-right">
                            {manager.awaiting_payment}
                          </td>
                          <td className="py-3 pr-3 text-right">
                            {manager.payment_overdue}
                          </td>
                          <td className="py-3 text-right">{manager.stale_orders}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
      </section>

      {/* Activity */}
      <section className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Недавняя активность</h2>
        </div>
        <div className="p-5">
          {activityLoading ? (
            <Skeleton className="h-40" />
          ) : activity.error ? (
            <BlockError message={activity.error} onRetry={retry} />
          ) : !activity.data?.length ? (
            <p className="text-sm text-neutral-500">Событий пока нет</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {activity.data.map((item) => (
                <li
                  key={item.event_id}
                  className="flex flex-col gap-1 border-b border-neutral-100 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-neutral-800">
                      {item.event_label}
                    </p>
                    <p className="mt-0.5 text-sm text-neutral-500">{item.description}</p>
                    <Link
                      href={`/staff/orders/${item.order_id}`}
                      className={`mt-1 inline-block text-sm font-medium text-[#0F766E] hover:text-[#0c5f58] ${focusRing}`}
                    >
                      {item.order_number}
                    </Link>
                  </div>
                  <time className="shrink-0 text-xs text-neutral-400">
                    {formatRuDateTime(item.created_at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function InventoryList({
  title,
  items,
  showReserved,
}: {
  title: string;
  items: DashboardInventoryAlerts["zero_available"];
  showReserved?: boolean;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-neutral-700">{title}</h3>
      {!items.length ? (
        <p className="text-sm text-neutral-500">Нет позиций</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.slice(0, 8).map((item) => (
            <li key={`${title}-${item.product_id}`}>
              <Link
                href={`/staff/products/${item.product_id}`}
                className={`flex items-center gap-3 rounded-md border border-neutral-100 px-3 py-2 transition-colors hover:border-[#0F766E] ${focusRing}`}
              >
                <StaffProductPhotoThumb
                  path={item.main_photo_path}
                  alt={item.name}
                  className="h-9 w-9 shrink-0 rounded"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-800">
                    {item.name}
                  </p>
                  <p className="text-xs text-neutral-400">{item.sku}</p>
                </div>
                <div className="shrink-0 text-right text-xs text-neutral-600">
                  <p>дост. {item.available_quantity}</p>
                  {showReserved && item.reserved_quantity != null && (
                    <p className="text-neutral-400">рез. {item.reserved_quantity}</p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
