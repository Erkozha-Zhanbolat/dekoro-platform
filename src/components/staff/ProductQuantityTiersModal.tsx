"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import {
  deleteProductQuantityPrice,
  listProductQuantityPrices,
  upsertProductQuantityPrice,
} from "@/lib/staff/pricing";
import type { ProductQuantityPriceRow } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

/**
 * Admin editor for public.product_quantity_prices (041_order_pricing_engine.sql,
 * ТЗ §4–5). Thresholds are per-product and freely chosen — no hardcoded 10/50/100.
 */
export default function ProductQuantityTiersModal({
  productId,
  productName,
  basePrice,
  onClose,
}: {
  productId: string;
  productName: string;
  basePrice: number | null;
  onClose: () => void;
}) {
  const [tiers, setTiers] = useState<ProductQuantityPriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newMinQuantity, setNewMinQuantity] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload() {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await listProductQuantityPrices(productId);
      setTiers(rows);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить уровни цен");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  async function handleAdd() {
    if (adding) return;
    const minQuantity = Number(newMinQuantity);
    const price = Number(newPrice);
    if (!Number.isInteger(minQuantity) || minQuantity <= 0) {
      setAddError("Количество «от» должно быть положительным целым числом");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setAddError("Цена должна быть неотрицательным числом");
      return;
    }

    setAdding(true);
    setAddError(null);
    try {
      await upsertProductQuantityPrice({ productId, minQuantity, price });
      setNewMinQuantity("");
      setNewPrice("");
      await reload();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "Не удалось сохранить уровень цены");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(tier: ProductQuantityPriceRow) {
    if (busyId) return;
    const confirmed = window.confirm(`Удалить уровень «от ${tier.min_quantity} шт.»?`);
    if (!confirmed) return;

    setBusyId(tier.id);
    try {
      await deleteProductQuantityPrice(tier.id);
      await reload();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось удалить уровень цены");
    } finally {
      setBusyId(null);
    }
  }

  const sortedTiers = [...tiers].sort((a, b) => a.min_quantity - b.min_quantity);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-800">Цены от количества</h2>
            <p className="mt-0.5 text-sm text-neutral-500">{productName}</p>
          </div>
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
          <div className="flex items-center justify-between rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm">
            <span className="text-neutral-500">Розничная (от 1 шт.)</span>
            <span className="font-medium text-neutral-800">
              {basePrice != null ? formatPrice(basePrice) : "—"}
            </span>
          </div>

          {loadError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {loadError}
            </p>
          )}

          {loading ? (
            <p className="mt-4 text-sm text-neutral-500">Загрузка...</p>
          ) : sortedTiers.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">Уровней пока нет</p>
          ) : (
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="py-2">От, шт.</th>
                  <th className="py-2 text-right">Цена</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {sortedTiers.map((tier) => (
                  <tr key={tier.id} className="border-b border-neutral-100 last:border-b-0">
                    <td className="py-2 text-neutral-800">{tier.min_quantity}</td>
                    <td className="py-2 text-right text-neutral-800">{formatPrice(tier.price)}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void handleDelete(tier)}
                        disabled={busyId === tier.id}
                        className={`text-xs font-medium text-red-600 hover:text-red-700 disabled:text-neutral-400 ${focusRing}`}
                      >
                        {busyId === tier.id ? "..." : "Удалить"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="mt-5 border-t border-neutral-100 pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Добавить уровень
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-sm text-neutral-600">
                От, шт.
                <input
                  type="number"
                  min={1}
                  value={newMinQuantity}
                  onChange={(event) => setNewMinQuantity(event.target.value)}
                  disabled={adding}
                  className={`mt-1 block w-24 rounded-md border border-neutral-200 px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
                />
              </label>
              <label className="text-sm text-neutral-600">
                Цена
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={newPrice}
                  onChange={(event) => setNewPrice(event.target.value)}
                  disabled={adding}
                  className={`mt-1 block w-32 rounded-md border border-neutral-200 px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
                />
              </label>
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={adding}
                className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
              >
                {adding ? "Сохранение..." : "Добавить"}
              </button>
            </div>
            {addError && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {addError}
              </p>
            )}
          </div>
        </div>

        <div className="flex justify-end border-t border-neutral-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
