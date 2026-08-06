"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ClientOrderDocuments } from "@/components/ClientOrderDocuments";
import { OrderStatusTimeline } from "@/components/OrderStatusTimeline";
import { useAuth } from "@/context/AuthContext";
import { useCart } from "@/context/CartContext";
import { useCatalog } from "@/context/CatalogContext";
import { getCatalog, mapCatalogProductToProduct } from "@/lib/catalog";
import {
  DELIVERY_TYPE_LABELS,
  cancelOrder,
  getOrder,
  listClientOrderStatusHistory,
  planRepeatOrder,
  repeatOrderSkipReasonLabel,
} from "@/lib/orders";
import type { OrderDetail } from "@/lib/orders";
import { formatPrice } from "@/lib/formatPrice";
import type { ClientOrderStatusHistoryEntry } from "@/types/database";
import { CLIENT_ORDER_STATUS_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const BackToOrdersLink = () => (
  <Link
    href="/orders"
    className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
  >
    ← Назад к заказам
  </Link>
);

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { refreshCatalog } = useCatalog();
  const { addManyToCart } = useCart();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [history, setHistory] = useState<ClientOrderStatusHistoryEntry[]>([]);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [repeating, setRepeating] = useState(false);
  const [repeatMessage, setRepeatMessage] = useState<string | null>(null);

  const currentKey = user ? `${user.id}:${orderId}` : undefined;

  useEffect(() => {
    if (authLoading) {
      return;
    }
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent(`/orders/${orderId}`)}`);
    }
  }, [authLoading, user, orderId, router]);

  useEffect(() => {
    if (authLoading || !user || loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    // Core order via RLS — must succeed for the page to render.
    // Timeline is optional (021); failure must not blank the page.
    getOrder(orderId)
      .then((result) => {
        if (ignore) {
          return;
        }
        setOrder(result);
        setNotFound(result === null);
        setLoadError(null);
        setLoadedKey(currentKey);

        if (!result) {
          setHistory([]);
          setTimelineError(null);
          return;
        }

        listClientOrderStatusHistory(orderId)
          .then((statusHistory) => {
            if (ignore) {
              return;
            }
            setHistory(statusHistory);
            setTimelineError(null);
          })
          .catch((error: unknown) => {
            if (ignore) {
              return;
            }
            setHistory([]);
            setTimelineError(friendlyTimelineError(error));
          });
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setOrder(null);
        setNotFound(false);
        setHistory([]);
        setTimelineError(null);
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить заказ",
        );
        setLoadedKey(currentKey);
      });

    return () => {
      ignore = true;
    };
  }, [authLoading, user, orderId, currentKey, loadedKey]);

  const loading = !authLoading && !!user && loadedKey !== currentKey;

  async function handleCancelOrder() {
    if (!order || order.status !== "new" || cancelling) {
      return;
    }

    const confirmed = window.confirm(
      `Отменить заказ ${order.order_number}? Зарезервированный товар будет освобождён.`,
    );
    if (!confirmed) {
      return;
    }

    setCancelling(true);
    setCancelError(null);

    try {
      await cancelOrder(order.id);
      const refreshed = await getOrder(orderId);
      setOrder(refreshed);
      setNotFound(refreshed === null);
      void refreshCatalog();

      if (refreshed) {
        try {
          const statusHistory = await listClientOrderStatusHistory(orderId);
          setHistory(statusHistory);
          setTimelineError(null);
        } catch (error: unknown) {
          setHistory([]);
          setTimelineError(friendlyTimelineError(error));
        }
      }
    } catch (error) {
      setCancelError(
        error instanceof Error ? error.message : "Не удалось отменить заказ",
      );
    } finally {
      setCancelling(false);
    }
  }

  async function handleRepeatOrder() {
    if (!order || repeating) {
      return;
    }
    setRepeating(true);
    setRepeatMessage(null);

    try {
      const catalog = (await getCatalog()).map(mapCatalogProductToProduct);
      const plan = planRepeatOrder(order.items, catalog);

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

  if (authLoading || !user || loading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-neutral-600">Загрузка...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">
          Не удалось загрузить заказ
        </h1>
        <p className="mt-4 text-red-600" role="alert">
          {loadError}
        </p>
        <div className="mt-6">
          <BackToOrdersLink />
        </div>
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">
          Заказ не найден
        </h1>
        <p className="mt-4 text-neutral-600">
          Проверьте ссылку или вернитесь к списку своих заказов.
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
      <BackToOrdersLink />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-neutral-800">
          Заказ {order.order_number}
        </h1>
        <span
          className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
            order.status === "cancelled"
              ? "bg-red-50 text-red-700"
              : "bg-teal-50 text-[#0F766E]"
          }`}
        >
          {CLIENT_ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        от {new Date(order.created_at).toLocaleString("ru-RU")}
      </p>

      {(order.payment_due_at || order.reservation_expires_at) && (
        <div className="mt-3 space-y-1 text-sm text-neutral-600">
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
        {order.status === "new" && (
          <button
            type="button"
            onClick={handleCancelOrder}
            disabled={cancelling}
            className={`min-h-11 rounded-md border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 transition-colors hover:border-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-400 disabled:hover:bg-transparent ${focusRing}`}
          >
            {cancelling ? "Отмена..." : "Отменить заказ"}
          </button>
        )}

        <button
          type="button"
          onClick={handleRepeatOrder}
          disabled={repeating}
          className={`min-h-11 rounded-md border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
        >
          {repeating ? "Добавление…" : "Повторить заказ"}
        </button>
      </div>

      {cancelError && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {cancelError}
        </p>
      )}
      {repeatMessage && (
        <p
          className="mt-2 whitespace-pre-line text-sm text-amber-800"
          role="status"
        >
          {repeatMessage}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-8">
        <OrderStatusTimeline
          currentStatus={order.status}
          createdAt={order.created_at}
          history={history}
          loadError={timelineError}
        />

        <section>
          <h2 className="text-lg font-semibold text-neutral-800">
            Контактные данные
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row label="Контактное лицо" value={order.contact_name} />
            <Row label="Телефон" value={order.contact_phone} />
            <Row label="Email" value={order.contact_email} />
          </dl>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-neutral-800">
            Получение заказа
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row
              label="Способ получения"
              value={DELIVERY_TYPE_LABELS[order.delivery_type]}
            />
            <Row label="Адрес доставки" value={order.delivery_address} />
            <Row
              label="Комментарий по получению"
              value={order.delivery_comment}
            />
          </dl>
        </section>

        {order.comment && (
          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Комментарий к заказу
            </h2>
            <p className="mt-3 text-sm text-neutral-600">{order.comment}</p>
          </section>
        )}

        <section>
          <h2 className="text-lg font-semibold text-neutral-800">
            Состав заказа
          </h2>
          <div className="mt-3 space-y-3 sm:hidden">
            {order.items.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-neutral-200 p-3 text-sm"
              >
                <p className="font-medium text-neutral-800">
                  {item.product_name}
                </p>
                <div className="mt-2 flex justify-between text-neutral-600">
                  <span>
                    {item.quantity} × {formatPrice(item.unit_price)}
                  </span>
                  <span className="font-medium text-neutral-800">
                    {formatPrice(item.total)}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 hidden overflow-x-auto rounded-lg border border-neutral-200 sm:block">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-4 py-3">Товар</th>
                  <th className="px-4 py-3 text-right">Кол-во</th>
                  <th className="px-4 py-3 text-right">Цена</th>
                  <th className="px-4 py-3 text-right">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-neutral-100 last:border-b-0"
                  >
                    <td className="px-4 py-3 text-neutral-800">
                      {item.product_name}
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-600">
                      {item.quantity}
                    </td>
                    <td className="px-4 py-3 text-right text-neutral-600">
                      {formatPrice(item.unit_price)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-neutral-800">
                      {formatPrice(item.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 ml-auto flex max-w-xs flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-neutral-500">Подытог</span>
              <span className="text-neutral-800">
                {formatPrice(order.subtotal)}
              </span>
            </div>
            {order.discount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-neutral-500">Скидка</span>
                <span className="text-neutral-800">
                  −{formatPrice(order.discount)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-neutral-200 pt-2">
              <span className="font-semibold text-neutral-800">Итого</span>
              <span className="text-lg font-bold text-neutral-800">
                {formatPrice(order.total)}
              </span>
            </div>
          </div>
        </section>

        <section>
          <ClientOrderDocuments orderId={order.id} />
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null;
  }

  return (
    <div className="flex justify-between gap-2 border-b border-neutral-100 py-2 text-sm">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right text-neutral-800">{value}</dd>
    </div>
  );
}

function friendlyTimelineError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /Could not find the function|PGRST202|function .* does not exist/i.test(
      message,
    )
  ) {
    return "История статусов временно недоступна. Обновите страницу позже.";
  }
  return message || "Не удалось загрузить историю статусов";
}
