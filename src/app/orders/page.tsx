"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ClientOrderCard } from "@/components/ClientOrderCard";
import { OrdersTabs } from "@/components/OrdersTabs";
import type { OrdersTab } from "@/components/OrdersTabs";
import { useAuth } from "@/context/AuthContext";
import {
  isClientActiveOrderStatus,
  isClientHistoryOrderStatus,
  listOrders,
  summarizeActiveOrders,
} from "@/lib/orders";
import type { OrderListItem } from "@/lib/orders";
import type { OrderStatus } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

type HistoryStatusFilter = "all" | "completed" | "cancelled";
type ActiveStatusFilter = "all" | OrderStatus;

export default function OrdersPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  const [tab, setTab] = useState<OrdersTab>("active");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyStatus, setHistoryStatus] =
    useState<HistoryStatusFilter>("all");
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [activeStatus, setActiveStatus] = useState<ActiveStatusFilter>("all");

  const currentKey = user ? `${user.id}:${reloadToken}` : undefined;

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent("/orders")}`);
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (authLoading || !user || loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    listOrders()
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
          error instanceof Error ? error.message : "Не удалось загрузить заказы",
        );
        setLoadedKey(currentKey);
      });

    return () => {
      ignore = true;
    };
  }, [authLoading, user, currentKey, loadedKey]);

  const ordersLoading = !authLoading && !!user && loadedKey !== currentKey;

  const activeOrders = useMemo(
    () => orders.filter((o) => isClientActiveOrderStatus(o.status)),
    [orders],
  );

  const historyOrders = useMemo(
    () => orders.filter((o) => isClientHistoryOrderStatus(o.status)),
    [orders],
  );

  const activeSummary = useMemo(
    () => summarizeActiveOrders(orders),
    [orders],
  );

  const filteredActive = useMemo(() => {
    let list = activeOrders;
    if (activeStatus !== "all") {
      list = list.filter((o) => o.status === activeStatus);
    }
    return list;
  }, [activeOrders, activeStatus]);

  const filteredHistory = useMemo(() => {
    let list = historyOrders;

    if (historyStatus !== "all") {
      list = list.filter((o) => o.status === historyStatus);
    }

    const q = historyQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((o) =>
        o.order_number.toLowerCase().includes(q),
      );
    }

    if (historyDateFrom) {
      const fromMs = Date.parse(`${historyDateFrom}T00:00:00`);
      if (Number.isFinite(fromMs)) {
        list = list.filter((o) => Date.parse(o.created_at) >= fromMs);
      }
    }

    if (historyDateTo) {
      const toMs = Date.parse(`${historyDateTo}T23:59:59.999`);
      if (Number.isFinite(toMs)) {
        list = list.filter((o) => Date.parse(o.created_at) <= toMs);
      }
    }

    return list;
  }, [
    historyOrders,
    historyStatus,
    historyQuery,
    historyDateFrom,
    historyDateTo,
  ]);

  if (authLoading || !user) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="text-3xl font-bold text-neutral-800">Мои заказы</h1>
        <p className="mt-6 text-neutral-600">Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">Мои заказы</h1>

      <div className="mt-6">
        <OrdersTabs
          activeTab={tab}
          onChange={setTab}
          activeCount={activeOrders.length}
          historyCount={historyOrders.length}
        />
      </div>

      {ordersLoading ? (
        <p className="mt-6 text-neutral-600">Загрузка заказов...</p>
      ) : loadError ? (
        <div className="mt-10 flex flex-col items-center gap-4 text-center">
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
      ) : orders.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-4 text-center">
          <p className="text-neutral-600">У вас пока нет заказов</p>
          <Link
            href="/catalog"
            className={`rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Перейти в каталог
          </Link>
        </div>
      ) : tab === "active" ? (
        <div className="mt-6 space-y-6">
          <ActiveSummaryBar summary={activeSummary} />

          <div className="flex flex-wrap gap-2">
            <FilterChip
              selected={activeStatus === "all"}
              onClick={() => setActiveStatus("all")}
              label="Все"
            />
            <FilterChip
              selected={activeStatus === "awaiting_payment"}
              onClick={() => setActiveStatus("awaiting_payment")}
              label="Ожидают оплаты"
            />
            <FilterChip
              selected={activeStatus === "picking"}
              onClick={() => setActiveStatus("picking")}
              label="Собираются"
            />
            <FilterChip
              selected={activeStatus === "ready_for_shipment"}
              onClick={() => setActiveStatus("ready_for_shipment")}
              label="К отгрузке"
            />
            <FilterChip
              selected={activeStatus === "shipped"}
              onClick={() => setActiveStatus("shipped")}
              label="Отгружены"
            />
          </div>

          {filteredActive.length === 0 ? (
            <p className="text-neutral-600">Нет активных заказов</p>
          ) : (
            <div className="flex flex-col gap-4">
              {filteredActive.map((order) => (
                <ClientOrderCard
                  key={order.id}
                  order={order}
                  variant="active"
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs font-medium text-neutral-500">
              Номер заказа
              <input
                type="search"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Поиск…"
                className={`min-h-11 rounded-md border border-neutral-200 px-3 text-sm text-neutral-800 ${focusRing}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-500">
              С
              <input
                type="date"
                value={historyDateFrom}
                onChange={(e) => setHistoryDateFrom(e.target.value)}
                className={`min-h-11 rounded-md border border-neutral-200 px-3 text-sm text-neutral-800 ${focusRing}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-500">
              По
              <input
                type="date"
                value={historyDateTo}
                onChange={(e) => setHistoryDateTo(e.target.value)}
                className={`min-h-11 rounded-md border border-neutral-200 px-3 text-sm text-neutral-800 ${focusRing}`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-500">
              Статус
              <select
                value={historyStatus}
                onChange={(e) =>
                  setHistoryStatus(e.target.value as HistoryStatusFilter)
                }
                className={`min-h-11 rounded-md border border-neutral-200 px-3 text-sm text-neutral-800 ${focusRing}`}
              >
                <option value="all">Все</option>
                <option value="completed">Завершённые</option>
                <option value="cancelled">Отменённые</option>
              </select>
            </label>
          </div>

          {filteredHistory.length === 0 ? (
            <p className="text-neutral-600">В истории пока ничего нет</p>
          ) : (
            <div className="flex flex-col gap-4">
              {filteredHistory.map((order) => (
                <ClientOrderCard
                  key={order.id}
                  order={order}
                  variant="history"
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActiveSummaryBar({
  summary,
}: {
  summary: ReturnType<typeof summarizeActiveOrders>;
}) {
  const items = [
    { label: "Всего активных", value: summary.total },
    { label: "Ожидают оплаты", value: summary.awaitingPayment },
    { label: "Собираются", value: summary.picking },
    { label: "К отгрузке", value: summary.readyForShipment },
    { label: "Отгружены", value: summary.shipped },
  ];

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3"
        >
          <dt className="text-xs text-neutral-500">{item.label}</dt>
          <dd className="mt-1 text-xl font-bold tabular-nums text-neutral-800">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FilterChip({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-10 rounded-md px-3 text-sm font-medium transition-colors ${focusRing} ${
        selected
          ? "bg-[#0F766E] text-white"
          : "border border-neutral-200 bg-white text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
      }`}
    >
      {label}
    </button>
  );
}
