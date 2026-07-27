"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FULFILLMENT_LABELS, useOrders } from "@/context/OrderContext";
import { OrderSummaryPanel } from "@/components/OrderSummaryPanel";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const { getOrderById } = useOrders();
  const order = getOrderById(params.id);

  if (!order) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">
          Заказ не найден
        </h1>
        <p className="mt-4 text-neutral-600">
          Возможно, заказ был создан в другой сессии и больше не хранится в
          памяти браузера.
        </p>
        <Link
          href="/orders"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          К списку заказов
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Link
        href="/orders"
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
      >
        ← К списку заказов
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-neutral-800">
          Заказ {order.orderNumber}
        </h1>
        <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm font-medium text-neutral-600">
          {order.status}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        от {new Date(order.createdAt).toLocaleString("ru-RU")}
      </p>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Данные компании
            </h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <Row label="Компания" value={order.companyName} />
              <Row label="БИН" value={order.bin} />
              <Row label="Контактное лицо" value={order.contactPerson} />
              <Row label="Телефон" value={order.phone} />
              <Row label="Email" value={order.email} />
            </dl>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Получение заказа
            </h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <Row
                label="Способ получения"
                value={FULFILLMENT_LABELS[order.fulfillmentType]}
              />
              {order.fulfillmentType === "customer_transport" && (
                <Row
                  label="Комментарий по забору"
                  value={order.pickupComment || "—"}
                />
              )}
            </dl>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Дополнительно
            </h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <Row label="Комментарий" value={order.comment || "—"} />
            </dl>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
            <div className="mt-3 rounded-md border border-neutral-200 p-4">
              {order.paymentStatus === "not_invoiced" && (
                <p className="text-sm text-neutral-600">
                  Заказ проверяется менеджером. Счёт будет доступен после
                  подтверждения цен и наличия.
                </p>
              )}

              {order.paymentStatus === "awaiting_payment" && (
                <div className="flex flex-col gap-3">
                  <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                    <Row
                      label="Номер счёта"
                      value={order.invoiceNumber ?? "—"}
                    />
                    <Row
                      label="Дата счёта"
                      value={
                        order.invoiceDate
                          ? new Date(order.invoiceDate).toLocaleDateString(
                              "ru-RU",
                            )
                          : "—"
                      }
                    />
                  </dl>
                  <p className="text-sm font-medium text-neutral-800">
                    Статус: Ожидает оплаты
                  </p>
                  <button
                    type="button"
                    className={`self-start rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
                  >
                    Скачать счёт
                  </button>
                </div>
              )}

              {order.paymentStatus === "paid" && (
                <p className="text-sm text-neutral-600">
                  Оплата подтверждена. Заказ может быть передан на склад.
                </p>
              )}
            </div>
          </section>
        </div>

        <OrderSummaryPanel
          items={order.items}
          knownTotal={order.knownTotal}
          hasUnpricedItems={order.hasUnpricedItems}
          title="Состав заказа"
        />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-neutral-100 py-2 text-sm">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right text-neutral-800">{value}</dd>
    </div>
  );
}
