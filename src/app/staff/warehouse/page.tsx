"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DELIVERY_TYPE_LABELS } from "@/lib/orders";
import { isDeadlineOverdue } from "@/lib/staff/orders";
import { listWarehouseOrders } from "@/lib/staff/warehouse";
import type { WarehouseOrderListItem } from "@/types/database";
import {
  ORDER_STATUS_LABELS,
  canAccessWarehouseOps,
  type WarehouseQueueStatus,
} from "@/types/database";
import { useProfile } from "@/context/ProfileContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const TABS: { key: WarehouseQueueStatus; label: string }[] = [
  { key: "paid", label: "Ожидают сборки" },
  { key: "picking", label: "Собираются" },
  { key: "ready_for_shipment", label: "Готовы к отгрузке" },
];

const SEARCH_DEBOUNCE_MS = 300;
const LIST_LIMIT = 50;

export default function StaffWarehouseQueuePage() {
  const router = useRouter();
  const { profile } = useProfile();
  const allowed = canAccessWarehouseOps(profile?.role);

  const [tab, setTab] = useState<WarehouseQueueStatus>("paid");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [orders, setOrders] = useState<WarehouseOrderListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, allowed, router]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const currentKey = `${tab}:${debouncedSearch}:${reloadToken}`;

  useEffect(() => {
    if (!allowed || loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    listWarehouseOrders({ status: tab, search: debouncedSearch, limit: LIST_LIMIT })
      .then((result) => {
        if (ignore) {
          return;
        }
        setOrders(result);
        setLoadError(null);
        setLoadedKey(currentKey);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить складскую очередь",
        );
        setLoadedKey(currentKey);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, tab, debouncedSearch, currentKey, loadedKey]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const loading = loadedKey !== currentKey;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Склад</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Очередь сборки и отгрузки оплаченных заказов
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadToken((token) => token + 1)}
          className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          Обновить
        </button>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-1">
        {TABS.map((item) => {
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`min-w-[8.5rem] flex-1 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${focusRing} ${
                active
                  ? "bg-white text-[#0F766E] shadow-sm"
                  : "text-neutral-600 hover:text-neutral-800"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <input
        type="search"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        placeholder="Поиск по номеру заказа или клиенту"
        className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-3 text-base text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:max-w-md sm:text-sm ${focusRing}`}
      />

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : orders.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">
          В этой вкладке заказов нет
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => {
            const reservationOverdue = isDeadlineOverdue(order.reservation_expires_at);
            const progressLabel =
              order.status === "paid"
                ? `${order.total_item_count} поз.`
                : `${order.completed_item_count}/${order.total_item_count}`;

            return (
              <li key={order.order_id}>
                <Link
                  href={`/staff/warehouse/${order.order_id}`}
                  className={`block rounded-lg border border-neutral-200 bg-white p-4 transition-colors hover:border-[#0F766E] ${focusRing}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-neutral-800">
                        {order.order_number}
                      </p>
                      <p className="mt-1 truncate text-sm text-neutral-600">
                        {order.customer_display_name}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                      {ORDER_STATUS_LABELS[order.status]}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-500">
                    <span>{DELIVERY_TYPE_LABELS[order.delivery_type]}</span>
                    <span>Позиции: {progressLabel}</span>
                    <span>
                      {order.assigned_to_name
                        ? `Отв.: ${order.assigned_to_name}`
                        : "Не назначен"}
                    </span>
                    <span>
                      {new Date(order.created_at).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  {reservationOverdue && (
                    <p className="mt-2 text-sm font-medium text-red-600">
                      Резерв просрочен
                    </p>
                  )}

                  <p className="mt-3 text-sm font-medium text-[#0F766E]">Открыть →</p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
