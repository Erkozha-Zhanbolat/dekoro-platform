"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DELIVERY_TYPE_LABELS } from "@/lib/orders";
import { isDeadlineOverdue } from "@/lib/staff/orders";
import {
  completeOrderPicking,
  getWarehouseOrderPicking,
  listWarehouseOrderActivity,
  setPickingItemCompleted,
  shipOrder,
  startOrderPicking,
} from "@/lib/staff/warehouse";
import type {
  WarehouseOrderActivityItem,
  WarehouseOrderPickingDetails,
} from "@/types/database";
import {
  ORDER_STATUS_LABELS,
  WAREHOUSE_ACTIVITY_EVENT_LABELS,
  canAccessWarehouseOps,
} from "@/types/database";
import { useProfile } from "@/context/ProfileContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function StaffWarehouseOrderPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const router = useRouter();
  const { profile } = useProfile();
  const allowed = canAccessWarehouseOps(profile?.role);

  const [details, setDetails] = useState<WarehouseOrderPickingDetails | null>(null);
  const [activity, setActivity] = useState<WarehouseOrderActivityItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [togglingItemId, setTogglingItemId] = useState<string | null>(null);

  useEffect(() => {
    if (profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, allowed, router]);

  async function refetch() {
    const [result, activityRows] = await Promise.all([
      getWarehouseOrderPicking(orderId),
      listWarehouseOrderActivity(orderId),
    ]);
    setDetails(result);
    setActivity(activityRows);
    setLoadError(null);
  }

  useEffect(() => {
    if (!allowed || loadedId === orderId) {
      return;
    }

    let ignore = false;

    Promise.all([getWarehouseOrderPicking(orderId), listWarehouseOrderActivity(orderId)])
      .then(([result, activityRows]) => {
        if (ignore) {
          return;
        }
        setDetails(result);
        setActivity(activityRows);
        setLoadError(null);
        setLoadedId(orderId);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setDetails(null);
        setActivity([]);
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить карточку сборки",
        );
        setLoadedId(orderId);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, orderId, loadedId]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const loading = loadedId !== orderId;

  async function runAction(action: () => Promise<void>) {
    setActionBusy(true);
    setActionError(null);
    try {
      await action();
      await refetch();
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "Операция не выполнена");
    } finally {
      setActionBusy(false);
    }
  }

  async function toggleItem(itemId: string, completed: boolean) {
    setTogglingItemId(itemId);
    setActionError(null);
    try {
      await setPickingItemCompleted(itemId, completed);
      await refetch();
    } catch (error: unknown) {
      setActionError(
        error instanceof Error ? error.message : "Не удалось обновить позицию",
      );
    } finally {
      setTogglingItemId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          href="/staff/warehouse"
          className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
        >
          ← К очереди склада
        </Link>
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (loadError || !details) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          href="/staff/warehouse"
          className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
        >
          ← К очереди склада
        </Link>
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError ?? "Заказ не найден"}
        </p>
      </div>
    );
  }

  const { order, customer, manager, picking_task, picking_items, order_items, delivery_note, progress } =
    details;

  const reservationOverdue = isDeadlineOverdue(order.reservation_expires_at);
  const allCompleted =
    progress.total > 0 && progress.completed === progress.total && picking_items.length > 0;
  const canStart = order.status === "paid";
  const canToggleItems =
    order.status === "picking" && picking_task?.status === "in_progress";
  const canComplete =
    order.status === "picking" && picking_task?.status === "in_progress" && allCompleted;
  const canShip =
    order.status === "ready_for_shipment" &&
    picking_task?.status === "completed" &&
    delivery_note != null &&
    delivery_note.status === "generated";
  const printHref = delivery_note
    ? `/staff/orders/${order.id}/documents/${delivery_note.id}/print`
    : null;

  const lines =
    picking_items.length > 0
      ? picking_items.map((item) => ({
          key: item.id,
          name: item.product_name,
          sku: item.product_sku,
          qty: item.required_quantity,
          completed: item.is_completed,
          pickingItemId: item.id as string | null,
        }))
      : order_items.map((item) => ({
          key: item.id,
          name: item.product_name,
          sku: item.product_sku,
          qty: item.quantity,
          completed: false,
          pickingItemId: null as string | null,
        }));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 pb-28">
      <Link
        href="/staff/warehouse"
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
      >
        ← К очереди склада
      </Link>

      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold text-neutral-800">{order.order_number}</h1>
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
            {ORDER_STATUS_LABELS[order.status]}
          </span>
        </div>
        <p className="mt-2 text-base text-neutral-700">
          {customer?.display_name ?? order.contact_name}
        </p>
        <p className="mt-1 text-sm text-neutral-500">{order.contact_phone}</p>
      </div>

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-neutral-400">Получение</dt>
            <dd className="mt-0.5 font-medium text-neutral-800">
              {DELIVERY_TYPE_LABELS[order.delivery_type]}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Менеджер</dt>
            <dd className="mt-0.5 font-medium text-neutral-800">
              {manager?.full_name ?? "Не назначен"}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Сборщик</dt>
            <dd className="mt-0.5 font-medium text-neutral-800">
              {picking_task?.assigned_to_name ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-400">Накладная</dt>
            <dd className="mt-0.5 font-medium text-neutral-800">
              {delivery_note ? delivery_note.number : "Не создана"}
            </dd>
          </div>
          {order.delivery_address && (
            <div className="sm:col-span-2">
              <dt className="text-neutral-400">Адрес</dt>
              <dd className="mt-0.5 font-medium text-neutral-800">{order.delivery_address}</dd>
            </div>
          )}
        </dl>

        {reservationOverdue && (
          <p className="mt-3 text-sm font-medium text-red-600">Резерв просрочен</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-neutral-800">Позиции</h2>
          <p className="text-sm font-medium text-neutral-600">
            {progress.completed}/{progress.total}
          </p>
        </div>

        <ul className="flex flex-col gap-3">
          {lines.map((line) => {
            const busy = line.pickingItemId != null && togglingItemId === line.pickingItemId;
            return (
              <li key={line.key}>
                <button
                  type="button"
                  disabled={!canToggleItems || line.pickingItemId == null || busy || actionBusy}
                  onClick={() => {
                    if (line.pickingItemId == null) {
                      return;
                    }
                    void toggleItem(line.pickingItemId, !line.completed);
                  }}
                  className={`flex w-full items-start gap-4 rounded-xl border px-4 py-4 text-left transition-colors ${focusRing} ${
                    line.completed
                      ? "border-[#0F766E] bg-[#0F766E]/[0.06]"
                      : "border-neutral-200 bg-white"
                  } ${
                    canToggleItems && line.pickingItemId
                      ? "hover:border-[#0F766E]"
                      : "cursor-default"
                  } disabled:opacity-70`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-2 text-sm font-bold ${
                      line.completed
                        ? "border-[#0F766E] bg-[#0F766E] text-white"
                        : "border-neutral-300 bg-white text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-semibold text-neutral-800">
                      {line.name}
                    </span>
                    <span className="mt-1 block text-sm text-neutral-500">
                      {line.sku ? `SKU ${line.sku} · ` : ""}
                      {line.qty} шт.
                      {line.completed ? " · Собрано" : " · Не собрано"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-neutral-800">История склада</h2>
        <p className="mt-1 text-xs text-neutral-400">
          Только складские действия — отдельно от истории статусов и заметок менеджера
        </p>
        {activity.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">Пока нет складских событий</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {activity.map((entry) => (
              <li
                key={entry.id}
                className="border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0"
              >
                <p className="text-sm font-medium text-neutral-800">
                  {entry.description?.trim() ||
                    WAREHOUSE_ACTIVITY_EVENT_LABELS[entry.event_type] ||
                    entry.event_type}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {new Date(entry.created_at).toLocaleString("ru-RU")}
                  {" · "}
                  {entry.created_by_name ?? "Сотрудник"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {actionError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {actionError}
        </p>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
          {canStart && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction(() => startOrderPicking(order.id))}
              className={`w-full rounded-md bg-[#0F766E] px-4 py-3.5 text-base font-semibold text-white transition-colors hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
            >
              Начать сборку
            </button>
          )}

          {order.status === "picking" && (
            <button
              type="button"
              disabled={actionBusy || !canComplete}
              onClick={() => void runAction(() => completeOrderPicking(order.id))}
              className={`w-full rounded-md bg-[#0F766E] px-4 py-3.5 text-base font-semibold text-white transition-colors hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
            >
              Завершить сборку
            </button>
          )}

          {order.status === "ready_for_shipment" && (
            <>
              {!delivery_note && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  Для отгрузки нужна накладная. Попросите менеджера создать её в карточке заказа.
                </p>
              )}
              <button
                type="button"
                disabled={actionBusy || !canShip}
                onClick={() => void runAction(() => shipOrder(order.id))}
                className={`w-full rounded-md bg-[#0F766E] px-4 py-3.5 text-base font-semibold text-white transition-colors hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
              >
                Отгрузить
              </button>
            </>
          )}

          {printHref && (
            <Link
              href={printHref}
              className={`block w-full rounded-md border border-neutral-200 bg-white px-4 py-3.5 text-center text-base font-semibold text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
            >
              Печать накладной
            </Link>
          )}

          {(order.status === "shipped" || order.status === "completed") && (
            <p className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
              Заказ отгружен. Складские действия завершены.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
