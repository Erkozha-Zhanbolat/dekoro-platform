"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCart } from "@/context/CartContext";
import { getCatalog, mapCatalogProductToProduct } from "@/lib/catalog";
import { DELIVERY_TYPE_LABELS } from "@/lib/orders";
import type { OrderListItem } from "@/lib/orders";
import {
  getOrder,
  planRepeatOrder,
  repeatOrderSkipReasonLabel,
} from "@/lib/orders";
import { formatPrice } from "@/lib/formatPrice";
import { CLIENT_ORDER_STATUS_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

type Props = {
  order: OrderListItem;
  variant: "active" | "history";
};

export function ClientOrderCard({ order, variant }: Props) {
  const router = useRouter();
  const { addManyToCart } = useCart();
  const [repeating, setRepeating] = useState(false);
  const [repeatMessage, setRepeatMessage] = useState<string | null>(null);

  async function handleRepeat() {
    if (repeating) {
      return;
    }
    setRepeating(true);
    setRepeatMessage(null);

    try {
      const detail = await getOrder(order.id);
      if (!detail) {
        setRepeatMessage("Не удалось загрузить заказ для повтора");
        return;
      }

      const catalog = (await getCatalog()).map(mapCatalogProductToProduct);
      const plan = planRepeatOrder(detail.items, catalog);

      if (plan.entries.length === 0) {
        const lines = plan.skipped.map(
          (s) => `· ${s.productName} — ${repeatOrderSkipReasonLabel(s.reason)}`,
        );
        setRepeatMessage(
          lines.length > 0
            ? `Не удалось добавить товары:\n${lines.join("\n")}`
            : "Нет доступных товаров для повтора",
        );
        return;
      }

      addManyToCart(plan.entries);

      const notices: string[] = [];
      for (const s of plan.skipped) {
        notices.push(
          `${s.productName} — ${repeatOrderSkipReasonLabel(s.reason)}`,
        );
      }
      for (const r of plan.reduced) {
        notices.push(
          `${r.productName} — добавлено ${r.addedQuantity} из ${r.requestedQuantity} (по остатку)`,
        );
      }

      if (notices.length > 0) {
        window.sessionStorage.setItem(
          "dekoro_repeat_order_notice",
          notices.join("\n"),
        );
      }

      router.push("/cart");
    } catch (error: unknown) {
      setRepeatMessage(
        error instanceof Error ? error.message : "Не удалось повторить заказ",
      );
    } finally {
      setRepeating(false);
    }
  }

  const statusLabel = CLIENT_ORDER_STATUS_LABELS[order.status];

  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-semibold text-neutral-800">
            {order.order_number}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            {new Date(order.created_at).toLocaleDateString("ru-RU")}
          </p>
          <p
            className={`mt-2 inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${
              order.status === "cancelled"
                ? "bg-red-50 text-red-700"
                : order.status === "completed"
                  ? "bg-neutral-100 text-neutral-700"
                  : "bg-teal-50 text-[#0F766E]"
            }`}
          >
            {statusLabel}
          </p>
        </div>

        <div className="text-sm text-neutral-600 sm:text-right">
          <p className="text-lg font-bold text-neutral-800">
            {formatPrice(order.total)}
          </p>
          <p className="mt-1">
            {order.itemCount} поз. · {order.totalQuantity} шт.
          </p>
        </div>
      </div>

      {variant === "active" && (
        <div className="mt-3 space-y-1 text-sm text-neutral-600">
          <p>{DELIVERY_TYPE_LABELS[order.delivery_type]}</p>
          {order.payment_due_at && (
            <p>
              Срок оплаты:{" "}
              {new Date(order.payment_due_at).toLocaleString("ru-RU")}
            </p>
          )}
          {order.reservation_expires_at && (
            <p>
              Срок резерва:{" "}
              {new Date(order.reservation_expires_at).toLocaleString("ru-RU")}
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Link
          href={`/orders/${order.id}`}
          className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] sm:flex-none ${focusRing}`}
        >
          Подробнее
        </Link>

        {variant === "history" && order.status === "completed" && (
          <button
            type="button"
            onClick={handleRepeat}
            disabled={repeating}
            className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-md border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none ${focusRing}`}
          >
            {repeating ? "Добавление…" : "Повторить заказ"}
          </button>
        )}
      </div>

      {repeatMessage && (
        <p
          className="mt-3 whitespace-pre-line text-sm text-amber-800"
          role="status"
        >
          {repeatMessage}
        </p>
      )}
    </article>
  );
}
