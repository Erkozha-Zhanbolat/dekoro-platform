"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FULFILLMENT_LABELS } from "@/lib/fulfillment";
import type { FulfillmentType } from "@/lib/fulfillment";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function isFulfillmentType(value: string | null): value is FulfillmentType {
  return value === "pickup" || value === "customer_transport";
}

export default function OrderSuccessContent() {
  const searchParams = useSearchParams();
  const orderNumber = searchParams.get("orderNumber");
  const fulfillmentParam = searchParams.get("fulfillment");
  const fulfillmentType = isFulfillmentType(fulfillmentParam)
    ? fulfillmentParam
    : null;

  if (!orderNumber) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">
          Заказ не найден
        </h1>
        <p className="mt-4 text-neutral-600">
          Возможно, страница была обновлена и данные заказа не сохранились.
        </p>
        <Link
          href="/catalog"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          Перейти в каталог
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <h1 className="text-3xl font-bold text-neutral-800">
        Заказ отправлен на проверку
      </h1>
      <p className="mt-4 text-lg font-semibold text-[#0F766E]">
        {orderNumber}
      </p>
      {fulfillmentType && (
        <p className="mt-2 text-sm text-neutral-500">
          Способ получения:{" "}
          <span className="font-medium text-neutral-700">
            {FULFILLMENT_LABELS[fulfillmentType]}
          </span>
        </p>
      )}
      <p className="mt-4 text-neutral-600">
        Менеджер DEKORO проверит наличие и цены, после чего сформирует счёт
        на оплату. Сборка заказа начнётся только после подтверждения 100%
        оплаты.
      </p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          href="/orders"
          className={`rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          Мои заказы
        </Link>
        <Link
          href="/catalog"
          className={`rounded-md border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-600 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          Вернуться в каталог
        </Link>
      </div>
    </div>
  );
}
