"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatPrice } from "@/lib/formatPrice";
import {
  ORDER_PAYMENT_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_WORKFLOW_STATUSES,
  STAFF_PAYMENT_FILTER_OPTIONS,
  canAccessOrderPayments,
} from "@/types/database";
import type { OrderStatus, StaffPaymentListFilter } from "@/types/database";
import {
  getStaffOrders,
  STAFF_STATUS_FILTER_OPTIONS,
} from "@/lib/staff/orders";
import type {
  StaffOrderListItem,
  StaffOrdersOpsFilter,
  StaffOrdersTestFilter,
} from "@/lib/staff/orders";
import { listStaffOrdersPaymentSummaries } from "@/lib/staff/payments";
import type { StaffOrderPaymentListSummary } from "@/types/database";
import { useProfile } from "@/context/ProfileContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const STATUS_FILTERS = STAFF_STATUS_FILTER_OPTIONS;

const ORDERS_LIST_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 300;

const VALID_STATUSES = new Set<string>([
  ...ORDER_WORKFLOW_STATUSES,
  "cancelled",
]);

const VALID_PAYMENT_FILTERS = new Set<string>(
  STAFF_PAYMENT_FILTER_OPTIONS.map((option) => option.value),
);

const VALID_OPS = new Set<StaffOrdersOpsFilter>([
  "fully_paid_not_moved",
  "payment_overdue",
  "reservation_overdue",
  "unassigned",
]);

function parseOps(value: string | null): StaffOrdersOpsFilter | null {
  if (!value) return null;
  return VALID_OPS.has(value as StaffOrdersOpsFilter)
    ? (value as StaffOrdersOpsFilter)
    : null;
}

export default function StaffOrdersPage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-lg border border-neutral-200 bg-white py-12 text-center text-sm text-neutral-500">
          Загрузка заказов...
        </div>
      }
    >
      <StaffOrdersPageFromUrl />
    </Suspense>
  );
}

function StaffOrdersPageFromUrl() {
  const searchParams = useSearchParams();
  return <StaffOrdersPageContent key={searchParams.toString()} searchParams={searchParams} />;
}

function StaffOrdersPageContent({
  searchParams,
}: {
  searchParams: ReturnType<typeof useSearchParams>;
}) {
  const router = useRouter();
  const { profile } = useProfile();
  const canCreateOrder = profile?.role === "manager" || profile?.role === "admin";
  const canSeePayments = canAccessOrderPayments(profile?.role);

  useEffect(() => {
    if (profile?.role === "warehouse") {
      router.replace("/staff/warehouse");
    }
  }, [profile?.role, router]);

  const urlOps = parseOps(searchParams.get("ops"));
  const urlStatusRaw = searchParams.get("status");
  const urlStatus =
    !urlOps && urlStatusRaw && VALID_STATUSES.has(urlStatusRaw)
      ? (urlStatusRaw as OrderStatus)
      : "all";
  const urlPaymentRaw = searchParams.get("payment");
  const urlPayment =
    urlPaymentRaw && VALID_PAYMENT_FILTERS.has(urlPaymentRaw)
      ? (urlPaymentRaw as StaffPaymentListFilter)
      : "all";

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">(urlStatus);
  const [paymentFilter, setPaymentFilter] = useState<StaffPaymentListFilter>(urlPayment);
  const [opsFilter, setOpsFilter] = useState<StaffOrdersOpsFilter | null>(urlOps);
  const [testFilter, setTestFilter] = useState<StaffOrdersTestFilter>("all");

  const [orders, setOrders] = useState<StaffOrderListItem[]>([]);
  const [paymentByOrderId, setPaymentByOrderId] = useState<
    Record<string, StaffOrderPaymentListSummary>
  >({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const currentKey = `${debouncedSearch}:${statusFilter}:${opsFilter ?? ""}:${testFilter}:${reloadToken}:${canSeePayments ? "pay" : "nopay"}`;

  useEffect(() => {
    if (profile?.role === "warehouse" || loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    getStaffOrders({
      search: debouncedSearch,
      status: statusFilter,
      ops: opsFilter,
      testFilter,
      limit: ORDERS_LIST_LIMIT,
    })
      .then(async (result) => {
        if (ignore) {
          return;
        }
        setOrders(result);

        if (canSeePayments && result.length > 0) {
          try {
            const summaries = await listStaffOrdersPaymentSummaries(
              result.map((order) => order.id),
            );
            if (ignore) {
              return;
            }
            const map: Record<string, StaffOrderPaymentListSummary> = {};
            for (const summary of summaries) {
              map[summary.order_id] = summary;
            }
            setPaymentByOrderId(map);
          } catch (error: unknown) {
            if (ignore) {
              return;
            }
            setLoadError(
              error instanceof Error
                ? error.message
                : "Не удалось загрузить сводки оплат",
            );
            setLoadedKey(currentKey);
            return;
          }
        } else {
          setPaymentByOrderId({});
        }

        setLoadError(null);
        setLoadedKey(currentKey);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить заказы");
        setLoadedKey(currentKey);
      });

    return () => {
      ignore = true;
    };
  }, [profile?.role, debouncedSearch, statusFilter, opsFilter, testFilter, currentKey, loadedKey, canSeePayments]);

  const loading = loadedKey !== currentKey;

  const visibleOrders = useMemo(() => {
    let list = orders;

    if (opsFilter === "fully_paid_not_moved" && canSeePayments) {
      list = list.filter((order) => {
        const summary = paymentByOrderId[order.id];
        return (
          summary != null &&
          (summary.payment_status === "paid" || summary.payment_status === "overpaid")
        );
      });
    }

    if (opsFilter === "payment_overdue" && canSeePayments) {
      list = list.filter((order) => {
        const summary = paymentByOrderId[order.id];
        return summary != null && summary.amount_remaining > 0.01;
      });
    }

    if (!canSeePayments || paymentFilter === "all") {
      return list;
    }

    return list.filter((order) => {
      const summary = paymentByOrderId[order.id];
      if (!summary) {
        return false;
      }
      if (paymentFilter === "shortfall_after_reversal") {
        return summary.has_payment_shortfall;
      }
      return summary.payment_status === paymentFilter;
    });
  }, [orders, paymentByOrderId, paymentFilter, canSeePayments, opsFilter]);

  const opsLabel =
    opsFilter === "fully_paid_not_moved"
      ? "Оплачены, но статус не сменён"
      : opsFilter === "payment_overdue"
        ? "Просрочен срок оплаты"
        : opsFilter === "reservation_overdue"
          ? "Просрочен срок резерва"
          : opsFilter === "unassigned"
            ? "Без менеджера"
            : null;

  if (profile?.role === "warehouse") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Заказы</h1>
          <p className="mt-1 text-sm text-neutral-500">Все заказы клиентов DEKORO</p>
        </div>
        {canCreateOrder && (
          <Link
            href="/staff/orders/new"
            className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            + Создать заказ
          </Link>
        )}
      </div>

      {opsLabel && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <span>Фильтр dashboard: {opsLabel}</span>
          <button
            type="button"
            onClick={() => setOpsFilter(null)}
            className={`font-medium underline ${focusRing}`}
          >
            Сбросить
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Поиск по номеру, имени, телефону или email"
          className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:max-w-md ${focusRing}`}
        />
        <select
          value={statusFilter}
          onChange={(event) => {
            setOpsFilter(null);
            setStatusFilter(event.target.value as OrderStatus | "all");
          }}
          className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:w-56 ${focusRing}`}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={testFilter}
          onChange={(event) =>
            setTestFilter(event.target.value as StaffOrdersTestFilter)
          }
          className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:w-56 ${focusRing}`}
          aria-label="Фильтр тестовых заказов"
        >
          <option value="all">Все</option>
          <option value="production">Рабочие</option>
          <option value="test">Тестовые</option>
        </select>
        {canSeePayments && (
          <select
            value={paymentFilter}
            onChange={(event) =>
              setPaymentFilter(event.target.value as StaffPaymentListFilter)
            }
            className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:w-56 ${focusRing}`}
          >
            {STAFF_PAYMENT_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {loadError ? (
        <div className="flex flex-col items-center gap-4 rounded-lg border border-neutral-200 bg-white py-12 text-center">
          <p className="text-red-600" role="alert">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setReloadToken((token) => token + 1);
            }}
            className={`rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Попробовать снова
          </button>
        </div>
      ) : loading ? (
        <div className="rounded-lg border border-neutral-200 bg-white py-12 text-center text-sm text-neutral-500">
          Загрузка заказов...
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white py-12 text-center text-sm text-neutral-500">
          Заказы не найдены
        </div>
      ) : (
        <>
          {orders.length === ORDERS_LIST_LIMIT && (
            <p className="text-xs text-neutral-400">
              Показаны последние {ORDERS_LIST_LIMIT} заказов. Уточните поиск или фильтр, чтобы
              увидеть больше.
            </p>
          )}

          <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 bg-white md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-5 py-3">№ заказа</th>
                  <th className="px-5 py-3">Дата</th>
                  <th className="px-5 py-3">Клиент / контакт</th>
                  <th className="px-5 py-3">Телефон</th>
                  <th className="px-5 py-3">Статус</th>
                  {canSeePayments && <th className="px-5 py-3">Оплата</th>}
                  {canSeePayments && (
                    <th className="px-5 py-3 text-right">Оплачено / остаток</th>
                  )}
                  <th className="px-5 py-3 text-right">Сумма</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map((order) => {
                  const pay = paymentByOrderId[order.id];
                  return (
                    <tr key={order.id} className="border-b border-neutral-100 last:border-b-0">
                      <td className="px-5 py-3 font-medium text-neutral-800">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {order.order_number}
                          {order.is_test ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                              Тестовый
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-neutral-600">
                        {new Date(order.created_at).toLocaleDateString("ru-RU")}
                      </td>
                      <td className="px-5 py-3 text-neutral-600">{order.contact_name}</td>
                      <td className="px-5 py-3 text-neutral-600">{order.contact_phone}</td>
                      <td className="px-5 py-3">
                        <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                          {ORDER_STATUS_LABELS[order.status]}
                        </span>
                      </td>
                      {canSeePayments && (
                        <td className="px-5 py-3">
                          {pay ? (
                            <span
                              className={`text-xs font-medium ${
                                pay.has_payment_shortfall
                                  ? "text-red-700"
                                  : "text-neutral-600"
                              }`}
                            >
                              {pay.has_payment_shortfall
                                ? "Задолженность после сторно"
                                : ORDER_PAYMENT_STATUS_LABELS[pay.payment_status]}
                            </span>
                          ) : (
                            <span className="text-xs text-neutral-400">—</span>
                          )}
                        </td>
                      )}
                      {canSeePayments && (
                        <td className="px-5 py-3 text-right text-neutral-600">
                          {pay
                            ? `${formatPrice(pay.amount_paid)} / ${formatPrice(Math.max(pay.amount_remaining, 0))}`
                            : "—"}
                        </td>
                      )}
                      <td className="px-5 py-3 text-right font-medium text-neutral-800">
                        {formatPrice(order.total)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/staff/orders/${order.id}`}
                          className={`text-sm font-medium text-[#0F766E] transition-colors hover:text-[#0c5f58] rounded-sm ${focusRing}`}
                        >
                          Открыть
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 md:hidden">
            {visibleOrders.map((order) => {
              const pay = paymentByOrderId[order.id];
              return (
                <Link
                  key={order.id}
                  href={`/staff/orders/${order.id}`}
                  className={`flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-[#0F766E] ${focusRing}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-neutral-800">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {order.order_number}
                          {order.is_test ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                              Тестовый
                            </span>
                          ) : null}
                        </span>
                      </p>
                      <p className="mt-0.5 text-sm text-neutral-500">{order.contact_name}</p>
                    </div>
                    <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                      {ORDER_STATUS_LABELS[order.status]}
                    </span>
                  </div>
                  {canSeePayments && pay && (
                    <p className="text-sm text-neutral-600">
                      {pay.has_payment_shortfall
                        ? "Задолженность после сторно"
                        : ORDER_PAYMENT_STATUS_LABELS[pay.payment_status]}
                      {" · "}
                      {formatPrice(pay.amount_paid)} /{" "}
                      {formatPrice(Math.max(pay.amount_remaining, 0))}
                    </p>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-neutral-500">
                      {new Date(order.created_at).toLocaleDateString("ru-RU")}
                    </span>
                    <span className="font-medium text-neutral-800">
                      {formatPrice(order.total)}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
