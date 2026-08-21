"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import { computeDiscountPercent, computeSavingsPerUnit } from "@/lib/pricing";
import {
  getCustomerProductPriceHistory,
  setStaffOrderItemPrice,
} from "@/lib/staff/orders";
import {
  MANUAL_PRICE_REASON_LABELS,
  type CustomerProductPriceHistoryEntry,
  type ManualPriceReason,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const REASON_OPTIONS: ManualPriceReason[] = [
  "regular_customer",
  "object_top_up",
  "approved_by_management",
  "compensation",
  "other",
];

export default function StaffOverrideOrderItemPriceModal({
  orderItemId,
  productId,
  productName,
  customerId,
  listPrice,
  autoPrice,
  currentPrice,
  onClose,
  onSaved,
}: {
  orderItemId: string;
  productId: string;
  productName: string;
  customerId: string | null;
  listPrice: number | null;
  autoPrice: number | null;
  currentPrice: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [history, setHistory] = useState<CustomerProductPriceHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [priceInput, setPriceInput] = useState(String(currentPrice));
  const [reason, setReason] = useState<ManualPriceReason | "">("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) {
      return;
    }
    let ignore = false;
    getCustomerProductPriceHistory(customerId, productId, 3)
      .then((rows) => {
        if (!ignore) setHistory(rows);
      })
      .catch((caught: unknown) => {
        if (!ignore) {
          setHistoryError(
            caught instanceof Error ? caught.message : "Не удалось загрузить историю цен",
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [customerId, productId]);

  const parsedPrice = Number(priceInput.replace(",", "."));
  const isValidPrice = Number.isFinite(parsedPrice) && parsedPrice >= 0;
  const lastPrice = history[0]?.unit_price ?? null;
  const discountPercent = isValidPrice ? computeDiscountPercent(listPrice, parsedPrice) : null;
  const savingsPerUnit = isValidPrice ? computeSavingsPerUnit(listPrice, parsedPrice) : null;

  async function handleSave() {
    if (saving || !isValidPrice || !reason) {
      return;
    }
    if (reason === "other" && !comment.trim()) {
      setError("Для причины «Другое» укажите комментарий");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await setStaffOrderItemPrice({
        orderItemId,
        newPrice: parsedPrice,
        reason,
        comment: comment.trim() || null,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось изменить цену");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Изменить цену</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 ${focusRing}`}
          >
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <p className="text-sm font-medium text-neutral-800">{productName}</p>

          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500">Розничная</dt>
              <dd className="text-neutral-800">{listPrice != null ? formatPrice(listPrice) : "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500">Автоматическая</dt>
              <dd className="text-neutral-800">{autoPrice != null ? formatPrice(autoPrice) : "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-neutral-500">Последняя цена клиенту</dt>
              <dd className="text-neutral-800">
                {lastPrice != null ? formatPrice(lastPrice) : "нет истории"}
              </dd>
            </div>
          </dl>

          {historyError && (
            <p className="mt-2 text-xs text-red-600" role="alert">
              {historyError}
            </p>
          )}

          {history.length > 0 && (
            <div className="mt-3 rounded-md border border-neutral-100 bg-neutral-50 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Последние покупки
              </p>
              <ul className="mt-1.5 space-y-1 text-xs text-neutral-600">
                {history.map((entry) => (
                  <li key={entry.order_id}>
                    {formatPrice(entry.unit_price)} × {entry.quantity} шт. —{" "}
                    {new Date(entry.ordered_at).toLocaleDateString("ru-RU")}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="mt-4 block text-sm">
            <span className="font-medium text-neutral-700">Цена для клиента</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
              disabled={saving}
              className={`mt-1.5 w-full rounded-md border border-neutral-200 px-3 py-2 text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
            />
          </label>

          {isValidPrice && discountPercent != null && savingsPerUnit != null && (
            <p className="mt-1.5 text-xs text-emerald-700">
              Скидка {discountPercent}% · экономия {formatPrice(savingsPerUnit)} со штуки
            </p>
          )}

          <label className="mt-4 block text-sm">
            <span className="font-medium text-neutral-700">Причина</span>
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as ManualPriceReason)}
              disabled={saving}
              className={`mt-1.5 w-full rounded-md border border-neutral-200 px-3 py-2 text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
            >
              <option value="">Выберите причину</option>
              {REASON_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {MANUAL_PRICE_REASON_LABELS[option]}
                </option>
              ))}
            </select>
          </label>

          {(reason === "other" || comment) && (
            <label className="mt-3 block text-sm">
              <span className="font-medium text-neutral-700">
                Комментарий{reason === "other" ? " (обязательно)" : ""}
              </span>
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                rows={2}
                disabled={saving}
                className={`mt-1.5 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
              />
            </label>
          )}

          <p className="mt-4 text-xs text-neutral-400">
            Цена применяется только к этой позиции этого заказа. Она не изменит будущие заказы
            клиента.
          </p>

          {error && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isValidPrice || !reason}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-300 ${focusRing}`}
          >
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </div>
    </div>
  );
}
