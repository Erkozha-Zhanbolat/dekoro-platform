"use client";

import { useMemo, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import { bulkUpdateProductPricing } from "@/lib/staff/pricing";
import type {
  BulkProductPricingResult,
  BulkProductPricingTierMode,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".").replace(/\s/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

type TierRow = {
  key: string;
  minQuantity: string;
  price: string;
};

let tierRowSeq = 0;
function newTierRow(): TierRow {
  tierRowSeq += 1;
  return { key: `t${tierRowSeq}`, minQuantity: "", price: "" };
}

/**
 * Bulk-edit retail (base) price and/or quantity tiers for the selected
 * products (043_bulk_product_pricing.sql). Each section is independently
 * toggled so an admin can change only the retail price, only the tiers, or
 * both — individual customer prices and order-item overrides are never
 * touched by this modal (ТЗ §14–15).
 */
export default function StaffBulkSetPricesModal({
  productIds,
  onClose,
  onApplied,
}: {
  productIds: string[];
  onClose: () => void;
  onApplied: (result: BulkProductPricingResult) => void;
}) {
  const [retailEnabled, setRetailEnabled] = useState(false);
  const [basePrice, setBasePrice] = useState("");

  const [tierRows, setTierRows] = useState<TierRow[]>([]);
  const [tierMode, setTierMode] = useState<BulkProductPricingTierMode>("merge");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedBasePrice = parseNumber(basePrice);
  const activeTierRows = tierRows.filter((row) => row.minQuantity.trim() !== "" || row.price.trim() !== "");

  const parsedTiers = useMemo(() => {
    return activeTierRows.map((row) => {
      const minQuantityRaw = row.minQuantity.trim();
      const minQuantity = Number(minQuantityRaw);
      const price = parseNumber(row.price);
      return {
        key: row.key,
        minQuantity: Number.isInteger(minQuantity) ? minQuantity : null,
        minQuantityValid: /^[1-9][0-9]*$/.test(minQuantityRaw),
        price,
      };
    });
  }, [activeTierRows]);

  const hasTiers = parsedTiers.length > 0;
  const hasChange = retailEnabled || hasTiers;

  const tierValidationError = useMemo((): string | null => {
    if (!hasTiers) return null;
    for (const tier of parsedTiers) {
      if (!tier.minQuantityValid || tier.minQuantity == null || tier.minQuantity <= 0) {
        return "Количество «от» должно быть положительным целым числом";
      }
      if (tier.price == null || tier.price < 0) {
        return "Цена уровня количества должна быть неотрицательным числом";
      }
    }
    const seen = new Set<number>();
    for (const tier of parsedTiers) {
      if (tier.minQuantity == null) continue;
      if (seen.has(tier.minQuantity)) {
        return `Значение «от ${tier.minQuantity}» указано более одного раза`;
      }
      seen.add(tier.minQuantity);
    }
    return null;
  }, [hasTiers, parsedTiers]);

  function addTierRow() {
    setTierRows((prev) => [...prev, newTierRow()]);
  }

  function removeTierRow(key: string) {
    setTierRows((prev) => prev.filter((row) => row.key !== key));
  }

  function updateTierRow(key: string, field: "minQuantity" | "price", value: string) {
    setTierRows((prev) => prev.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  }

  const sortedPreviewTiers = useMemo(
    () =>
      [...parsedTiers]
        .filter((t) => t.minQuantity != null && t.price != null)
        .sort((a, b) => (a.minQuantity ?? 0) - (b.minQuantity ?? 0)),
    [parsedTiers],
  );

  async function handleApply() {
    if (busy || !hasChange) return;
    setError(null);

    if (retailEnabled && (parsedBasePrice == null || parsedBasePrice < 0)) {
      setError("Розничная цена должна быть неотрицательным числом");
      return;
    }

    if (tierValidationError) {
      setError(tierValidationError);
      return;
    }

    if (hasTiers && tierMode === "replace") {
      const confirmed = window.confirm(
        "Существующие цены от количества у выбранных товаров будут заменены. Продолжить?",
      );
      if (!confirmed) return;
    }

    setBusy(true);
    try {
      const result = await bulkUpdateProductPricing(productIds, {
        updateBase: retailEnabled,
        basePrice: retailEnabled ? parsedBasePrice : null,
        tiers: hasTiers
          ? parsedTiers.map((t) => ({ minQuantity: t.minQuantity as number, price: t.price as number }))
          : [],
        tierMode,
      });
      onApplied(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось применить массовое изменение цен");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-prices-title"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 id="bulk-prices-title" className="text-lg font-semibold text-neutral-800">
              Массовое изменение цен
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500">Выбрано: {productIds.length} товаров</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
            className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 ${focusRing}`}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Retail price section */}
          <section className="rounded-md border border-neutral-200 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-neutral-800">
              <input
                type="checkbox"
                className="accent-[#0F766E]"
                checked={retailEnabled}
                onChange={(e) => setRetailEnabled(e.target.checked)}
                disabled={busy}
              />
              Изменить розничную цену
            </label>
            {retailEnabled && (
              <label className="mt-3 block text-sm text-neutral-700">
                Новая цена
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className={`${inputClass} mt-0`}
                    value={basePrice}
                    onChange={(e) => setBasePrice(e.target.value)}
                    inputMode="decimal"
                    placeholder="Например 10000"
                    disabled={busy}
                  />
                  <span className="text-neutral-500">₸</span>
                </div>
              </label>
            )}
            {!retailEnabled && (
              <p className="mt-1 text-xs text-neutral-500">
                Розничная цена выбранных товаров не изменится.
              </p>
            )}
          </section>

          {/* Quantity tiers section */}
          <section className="rounded-md border border-neutral-200 p-3">
            <p className="text-sm font-medium text-neutral-800">Цены от количества</p>

            <div className="mt-3 space-y-2">
              {tierRows.map((row) => (
                <div key={row.key} className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-neutral-500">от</span>
                  <input
                    className={`${inputClass} mt-0 w-24`}
                    value={row.minQuantity}
                    onChange={(e) => updateTierRow(row.key, "minQuantity", e.target.value)}
                    inputMode="numeric"
                    placeholder="10"
                    disabled={busy}
                  />
                  <span className="text-sm text-neutral-500">шт →</span>
                  <input
                    className={`${inputClass} mt-0 w-32`}
                    value={row.price}
                    onChange={(e) => updateTierRow(row.key, "price", e.target.value)}
                    inputMode="decimal"
                    placeholder="9500"
                    disabled={busy}
                  />
                  <span className="text-sm text-neutral-500">₸</span>
                  <button
                    type="button"
                    onClick={() => removeTierRow(row.key)}
                    disabled={busy}
                    className={`ml-auto text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 ${focusRing}`}
                  >
                    Удалить
                  </button>
                </div>
              ))}
              {tierRows.length === 0 && (
                <p className="text-xs text-neutral-500">Уровни количества не добавлены.</p>
              )}
            </div>

            <button
              type="button"
              onClick={addTierRow}
              disabled={busy}
              className={`mt-3 text-sm font-medium text-[#0F766E] hover:underline disabled:opacity-50 ${focusRing}`}
            >
              + Добавить уровень
            </button>

            {hasTiers && (
              <div className="mt-4 border-t border-neutral-100 pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Режим применения
                </p>
                <div className="mt-2 space-y-2">
                  <label className="flex items-start gap-2 text-sm text-neutral-700">
                    <input
                      type="radio"
                      name="tierMode"
                      className="mt-0.5 accent-[#0F766E]"
                      checked={tierMode === "merge"}
                      onChange={() => setTierMode("merge")}
                      disabled={busy}
                    />
                    <span>
                      <span className="font-medium">Добавить / обновить указанные уровни</span>
                      <br />
                      <span className="text-xs text-neutral-500">
                        Существующие уровни, которых нет в списке выше, сохраняются.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-neutral-700">
                    <input
                      type="radio"
                      name="tierMode"
                      className="mt-0.5 accent-[#0F766E]"
                      checked={tierMode === "replace"}
                      onChange={() => setTierMode("replace")}
                      disabled={busy}
                    />
                    <span>
                      <span className="font-medium text-red-700">Заменить все уровни</span>
                      <br />
                      <span className="text-xs text-neutral-500">
                        Существующие уровни выбранных товаров будут удалены и заменены списком выше.
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* Preview */}
          {hasChange && !tierValidationError && (
            <section className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 text-sm">
              <p className="font-medium text-neutral-800">
                Будет изменено {productIds.length} товаров
              </p>
              {retailEnabled && parsedBasePrice != null && (
                <p className="mt-1.5 text-neutral-700">
                  Розничная цена: <span className="font-medium">→ {formatPrice(parsedBasePrice)}</span>
                </p>
              )}
              {sortedPreviewTiers.length > 0 && (
                <div className="mt-1.5 text-neutral-700">
                  <p>Уровни количества:</p>
                  <ul className="mt-1 space-y-0.5">
                    {sortedPreviewTiers.map((t) => (
                      <li key={t.key}>
                        {t.minQuantity}+ → {formatPrice(t.price as number)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs">
                    Режим:{" "}
                    {tierMode === "replace" ? (
                      <span className="font-medium text-red-700">Заменить существующие уровни</span>
                    ) : (
                      <span className="font-medium">
                        Добавить / обновить (существующие другие уровни будут сохранены)
                      </span>
                    )}
                  </p>
                </div>
              )}
              <p className="mt-2 text-xs text-neutral-500">
                Индивидуальные цены клиентов и цены в существующих заказах не изменятся.
              </p>
            </section>
          )}

          {!hasChange && (
            <p className="text-xs text-neutral-500">
              Включите розничную цену или добавьте хотя бы один уровень количества.
            </p>
          )}

          {(error || tierValidationError) && (
            <p className="text-sm text-red-600" role="alert">
              {error ?? tierValidationError}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 ${focusRing}`}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={busy || !hasChange || !!tierValidationError}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
          >
            {busy ? "Применение..." : `Применить к ${productIds.length} товарам`}
          </button>
        </div>
      </div>
    </div>
  );
}
