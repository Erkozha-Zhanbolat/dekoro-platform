"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import {
  ORDER_PAYMENT_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  STAFF_PAYMENT_FILTER_OPTIONS,
  canAccessOrderPayments,
} from "@/types/database";
import type { OrderStatus, StaffPaymentListFilter } from "@/types/database";
import { getStaffOrders, STAFF_STATUS_FILTER_OPTIONS } from "@/lib/staff/orders";
import type { StaffOrderListItem } from "@/lib/staff/orders";
import { listStaffOrdersPaymentSummaries } from "@/lib/staff/payments";
import type { StaffOrderPaymentListSummary } from "@/types/database";
import { useProfile } from "@/context/ProfileContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const STATUS_FILTERS = STAFF_STATUS_FILTER_OPTIONS;

const ORDERS_LIST_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 300;

export default function StaffOrdersPage() {
  const { profile } = useProfile();
  const canCreateOrder = profile?.role === "manager" || profile?.role === "admin";
  const canSeePayments = canAccessOrderPayments(profile?.role);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">("all");
  const [paymentFilter, setPaymentFilter] = useState<StaffPaymentListFilter>("all");

  const [orders, setOrders] = useState<StaffOrderListItem[]>([]);
  const [paymentByOrderId, setPaymentByOrderId] = useState<
    Record<string, StaffOrderPaymentListSummary>
  >({});
  const [loadError, setLoadError] = useState<string | null>(null);
  // undefined = not loaded yet for this key ("<search>:<status>:<reloadToken>").
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  // Debounce free-text search so every keystroke doesn't trigger a request.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const currentKey = `${debouncedSearch}:${statusFilter}:${reloadToken}:${canSeePayments ? "pay" : "nopay"}`;

  useEffect(() => {
    if (loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    getStaffOrders({ search: debouncedSearch, status: statusFilter, limit: ORDERS_LIST_LIMIT })
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
  }, [debouncedSearch, statusFilter, currentKey, loadedKey, canSeePayments]);

  const loading = loadedKey !== currentKey;

  const visibleOrders = useMemo(() => {
    if (!canSeePayments || paymentFilter === "all") {
      return orders;
    }
    return orders.filter((order) => {
      const summary = paymentByOrderId[order.id];
      if (!summary) {
        return false;
      }
      if (paymentFilter === "shortfall_after_reversal") {
        return summary.has_payment_shortfall;
      }
      return summary.payment_status === paymentFilter;
    });
  }, [orders, paymentByOrderId, paymentFilter, canSeePayments]);

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
          onChange={(event) => setStatusFilter(event.target.value as OrderStatus | "all")}
          className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:w-56 ${focusRing}`}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
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

          {/* Desktop table */}
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
                        {order.order_number}
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

          {/* Mobile cards */}
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
                      <p className="font-medium text-neutral-800">{order.order_number}</p>
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
