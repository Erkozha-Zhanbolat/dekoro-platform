"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DELIVERY_TYPE_LABELS } from "@/lib/orders";
import {
  getStaffOrderById,
  removeStaffOrderItem,
  updateStaffOrderItemQuantity,
} from "@/lib/staff/orders";
import type { StaffOrderDetail, StaffOrderDetailItem } from "@/lib/staff/orders";
import { formatPrice } from "@/lib/formatPrice";
import { ORDER_STATUS_LABELS } from "@/types/database";
import { useProfile } from "@/context/ProfileContext";
import StaffAddOrderItemModal from "@/components/staff/StaffAddOrderItemModal";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const BackToOrdersLink = () => (
  <Link
    href="/staff/orders"
    className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
  >
    ← Назад к заказам
  </Link>
);

export default function StaffOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const { profile } = useProfile();

  const [order, setOrder] = useState<StaffOrderDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // undefined = not loaded yet for this orderId.
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [isAddItemModalOpen, setIsAddItemModalOpen] = useState(false);

  // No optimistic updates anywhere in this page (per spec): every mutation
  // just triggers this same re-fetch, so what's on screen always exactly
  // matches what the last write RPC actually committed server-side.
  async function refetchOrder() {
    try {
      const result = await getStaffOrderById(orderId);
      setOrder(result);
      setNotFound(result === null);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить заказ");
    }
  }

  useEffect(() => {
    if (loadedId === orderId) {
      return;
    }

    let ignore = false;

    getStaffOrderById(orderId)
      .then((result) => {
        if (ignore) {
          return;
        }
        setOrder(result);
        setNotFound(result === null);
        setLoadError(null);
        setLoadedId(orderId);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setOrder(null);
        setNotFound(false);
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить заказ");
        setLoadedId(orderId);
      });

    return () => {
      ignore = true;
    };
  }, [orderId, loadedId]);

  const loading = loadedId !== orderId;
  const canManageItems =
    (profile?.role === "manager" || profile?.role === "admin") && order?.status === "new";

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Не удалось загрузить заказ</h1>
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
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Заказ не найден</h1>
        <p className="mt-4 text-neutral-600">
          Проверьте ссылку или вернитесь к списку заказов.
        </p>
        <Link
          href="/staff/orders"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          К списку заказов
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <BackToOrdersLink />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-neutral-800">Заказ {order.order_number}</h1>
        <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm font-medium text-neutral-600">
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        от {new Date(order.created_at).toLocaleString("ru-RU")}
      </p>

      {/* Status actions (confirm/pay/ship/cancel etc.) are intentionally not
          implemented yet. Only manager/admin, and only while status = 'new',
          can add/change/remove items below (see canManageItems). */}

      <div className="mt-8 flex flex-col gap-8">
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Контактные данные</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row label="Контактное лицо" value={order.contact_name} />
            <Row label="Телефон" value={order.contact_phone} />
            <Row label="Email" value={order.contact_email} />
          </dl>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Получение заказа</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row label="Способ получения" value={DELIVERY_TYPE_LABELS[order.delivery_type]} />
            <Row label="Адрес доставки" value={order.delivery_address} />
            <Row label="Комментарий по получению" value={order.delivery_comment} />
          </dl>
        </section>

        {order.comment && (
          <section className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-neutral-800">Комментарий к заказу</h2>
            <p className="mt-3 text-sm text-neutral-600">{order.comment}</p>
          </section>
        )}

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-neutral-800">Состав заказа</h2>
            {canManageItems && (
              <button
                type="button"
                onClick={() => setIsAddItemModalOpen(true)}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
              >
                + Добавить товар
              </button>
            )}
          </div>

          {order.items.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">В заказе пока нет товаров</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    <th className="px-4 py-3">Товар</th>
                    <th className="px-4 py-3 text-right">Кол-во</th>
                    <th className="px-4 py-3 text-right">Цена</th>
                    <th className="px-4 py-3 text-right">Сумма</th>
                    {canManageItems && <th className="px-4 py-3" />}
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) =>
                    canManageItems ? (
                      <EditableOrderItemRow
                        key={item.id}
                        item={item}
                        orderNumber={order.order_number}
                        onChanged={refetchOrder}
                      />
                    ) : (
                      <tr key={item.id} className="border-b border-neutral-100 last:border-b-0">
                        <td className="px-4 py-3 text-neutral-800">{item.product_name}</td>
                        <td className="px-4 py-3 text-right text-neutral-600">{item.quantity}</td>
                        <td className="px-4 py-3 text-right text-neutral-600">
                          {formatPrice(item.unit_price)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-neutral-800">
                          {formatPrice(item.total)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 ml-auto flex max-w-xs flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-neutral-500">Подытог</span>
              <span className="text-neutral-800">{formatPrice(order.subtotal)}</span>
            </div>
            {order.discount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-neutral-500">Скидка</span>
                <span className="text-neutral-800">−{formatPrice(order.discount)}</span>
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
      </div>

      {isAddItemModalOpen && (
        <StaffAddOrderItemModal
          orderId={order.id}
          onClose={() => setIsAddItemModalOpen(false)}
          onAdded={() => {
            setIsAddItemModalOpen(false);
            void refetchOrder();
          }}
        />
      )}
    </div>
  );
}

function EditableOrderItemRow({
  item,
  orderNumber,
  onChanged,
}: {
  item: StaffOrderDetailItem;
  orderNumber: string;
  onChanged: () => Promise<void>;
}) {
  const [quantityInput, setQuantityInput] = useState(String(item.quantity));
  const [syncedQuantity, setSyncedQuantity] = useState(item.quantity);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  // Keep the input in sync whenever the server-confirmed quantity changes
  // (e.g. after this row's own save, or any other change that triggers a
  // re-fetch) — never derived/patched locally otherwise. Adjusted during
  // render (React's recommended pattern for "state changed because a prop
  // changed"), same approach as ProfileContext's user-switch reset.
  if (item.quantity !== syncedQuantity) {
    setSyncedQuantity(item.quantity);
    setQuantityInput(String(item.quantity));
  }

  const parsedQuantity = Number(quantityInput);
  const isValidQuantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0;
  const isDirty = isValidQuantity && parsedQuantity !== item.quantity;
  const busy = saving || removing;

  async function handleSaveQuantity() {
    // Guards against double-click / double-submit while a request for this
    // exact row is already in flight.
    if (!isDirty || busy) {
      return;
    }

    setSaving(true);
    setRowError(null);

    try {
      await updateStaffOrderItemQuantity(item.id, parsedQuantity);
      await onChanged();
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "Не удалось изменить количество");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (busy) {
      return;
    }

    const confirmed = window.confirm(
      `Удалить «${item.product_name}» из заказа ${orderNumber}? Резерв товара будет освобождён.`,
    );
    if (!confirmed) {
      return;
    }

    setRemoving(true);
    setRowError(null);

    try {
      await removeStaffOrderItem(item.id);
      await onChanged();
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "Не удалось удалить позицию");
      setRemoving(false);
    }
  }

  return (
    <tr className="border-b border-neutral-100 last:border-b-0">
      <td className="px-4 py-3 text-neutral-800">
        {item.product_name}
        {rowError && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {rowError}
          </p>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <input
            type="number"
            min={1}
            value={quantityInput}
            disabled={busy}
            onChange={(event) => setQuantityInput(event.target.value)}
            className={`w-20 rounded-md border border-neutral-200 px-2 py-1.5 text-right text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 disabled:text-neutral-400 ${focusRing}`}
          />
          {isDirty && (
            <button
              type="button"
              onClick={handleSaveQuantity}
              disabled={busy}
              className={`rounded-md bg-[#0F766E] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-300 ${focusRing}`}
            >
              {saving ? "..." : "Сохранить"}
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right text-neutral-600">{formatPrice(item.unit_price)}</td>
      <td className="px-4 py-3 text-right font-medium text-neutral-800">
        {formatPrice(item.total)}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={handleRemove}
          disabled={busy}
          className={`text-sm font-medium text-red-600 transition-colors hover:text-red-700 disabled:cursor-not-allowed disabled:text-neutral-400 rounded-sm ${focusRing}`}
        >
          {removing ? "Удаление..." : "Удалить"}
        </button>
      </td>
    </tr>
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
