"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { listOrders } from "@/lib/orders";
import type { OrderListItem } from "@/lib/orders";
import { formatPrice } from "@/lib/formatPrice";
import { ORDER_STATUS_LABELS } from "@/types/database";
import type { DeliveryType } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const DELIVERY_TYPE_LABELS: Record<DeliveryType, string> = {
  pickup: "Самовывоз со склада DEKORO",
  customer_transport: "Забор транспортом клиента",
  delivery: "Доставка",
};

export default function OrdersPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [orders, setOrders] = useState<OrderListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // undefined = not loaded yet for this key ("<userId>:<reloadToken>").
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

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
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          {orders.map((order) => (
            <div
              key={order.id}
              className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-semibold text-neutral-800">
                  {order.order_number}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {new Date(order.created_at).toLocaleDateString("ru-RU")}
                </p>
                <p className="mt-1 text-sm text-neutral-600">
                  {order.contact_name}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {DELIVERY_TYPE_LABELS[order.delivery_type]}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-sm text-neutral-600 sm:gap-6">
                <span>
                  {order.itemCount} поз. · {order.totalQuantity} шт.
                </span>
                <span className="font-semibold text-neutral-800">
                  {formatPrice(order.total)}
                </span>
                <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                  {ORDER_STATUS_LABELS[order.status]}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
