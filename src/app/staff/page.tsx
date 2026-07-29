"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import { ORDER_STATUS_LABELS } from "@/types/database";
import {
  getStaffOrderStats,
  getStaffOrders,
} from "@/lib/staff/orders";
import type { StaffOrderListItem, StaffOrderStats } from "@/lib/staff/orders";

const RECENT_ORDERS_LIMIT = 8;

const STAT_CARDS: { key: keyof StaffOrderStats; label: string }[] = [
  { key: "total", label: "Всего заказов" },
  { key: "new", label: "Новые" },
  { key: "processing", label: "В обработке" },
  { key: "completed", label: "Завершённые" },
  { key: "cancelled", label: "Отменённые" },
];

export default function StaffDashboardPage() {
  const [stats, setStats] = useState<StaffOrderStats | null>(null);
  const [recentOrders, setRecentOrders] = useState<StaffOrderListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    Promise.all([getStaffOrderStats(), getStaffOrders({ limit: RECENT_ORDERS_LIMIT })])
      .then(([statsResult, ordersResult]) => {
        if (ignore) {
          return;
        }
        setStats(statsResult);
        setRecentOrders(ordersResult);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить данные панели",
        );
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-800">Главная</h1>
        <p className="mt-1 text-sm text-neutral-500">Обзор заказов DEKORO</p>
      </div>

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {STAT_CARDS.map((card) => (
          <div
            key={card.key}
            className="rounded-lg border border-neutral-200 bg-white p-4"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              {card.label}
            </p>
            <p className="mt-2 text-2xl font-bold text-neutral-800">
              {loading || !stats ? "—" : stats[card.key]}
            </p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Последние заказы</h2>
          <Link
            href="/staff/orders"
            className="text-sm font-medium text-[#0F766E] transition-colors hover:text-[#0c5f58]"
          >
            Все заказы →
          </Link>
        </div>

        {loading ? (
          <p className="px-5 py-6 text-sm text-neutral-500">Загрузка...</p>
        ) : recentOrders.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500">Заказов пока нет</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-5 py-3">№ заказа</th>
                  <th className="px-5 py-3">Дата</th>
                  <th className="px-5 py-3">Клиент</th>
                  <th className="px-5 py-3">Статус</th>
                  <th className="px-5 py-3 text-right">Сумма</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id} className="border-b border-neutral-100 last:border-b-0">
                    <td className="px-5 py-3 font-medium text-neutral-800">
                      {order.order_number}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">
                      {new Date(order.created_at).toLocaleDateString("ru-RU")}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">{order.contact_name}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                        {ORDER_STATUS_LABELS[order.status]}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-neutral-800">
                      {formatPrice(order.total)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/staff/orders/${order.id}`}
                        className="text-sm font-medium text-[#0F766E] transition-colors hover:text-[#0c5f58]"
                      >
                        Открыть
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
