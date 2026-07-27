"use client";

import Link from "next/link";
import {
  FULFILLMENT_LABELS,
  PAYMENT_STATUS_LABELS,
  useOrders,
} from "@/context/OrderContext";
import { formatPrice } from "@/lib/formatPrice";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function OrdersPage() {
  const { orders } = useOrders();
  const sortedOrders = [...orders].reverse();

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">Мои заказы</h1>

      {sortedOrders.length === 0 ? (
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
          {sortedOrders.map((order) => (
            <div
              key={order.id}
              className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-semibold text-neutral-800">
                  {order.orderNumber}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {new Date(order.createdAt).toLocaleDateString("ru-RU")}
                </p>
                <p className="mt-1 text-sm text-neutral-600">
                  {order.companyName}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {FULFILLMENT_LABELS[order.fulfillmentType]}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-sm text-neutral-600 sm:gap-6">
                <span>{order.items.length} поз.</span>
                <span className="font-semibold text-neutral-800">
                  {formatPrice(order.knownTotal)}
                </span>
                <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                  {order.status}
                </span>
                <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                  {PAYMENT_STATUS_LABELS[order.paymentStatus]}
                </span>
                <Link
                  href={`/orders/${order.id}`}
                  className={`rounded-sm text-sm font-medium text-[#0F766E] transition-colors hover:text-[#0c5f58] ${focusRing}`}
                >
                  Подробнее
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
