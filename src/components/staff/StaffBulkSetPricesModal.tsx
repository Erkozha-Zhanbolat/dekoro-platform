"use client";

import { useEffect, useMemo, useState } from "react";
import {
  bulkUpdateProductPrices,
  listStaffPriceGroups,
  type PriceGroup,
} from "@/lib/staff/pricing";
import type { BulkProductPricesPayload } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

type GroupDraft = {
  priceGroupId: string;
  name: string;
  /** keep | set | reset — empty price field with keep means leave unchanged */
  mode: "keep" | "set" | "reset";
  price: string;
};

function parsePrice(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".").replace(/\s/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export default function StaffBulkSetPricesModal({
  productIds,
  onClose,
  onApplied,
}: {
  productIds: string[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [basePrice, setBasePrice] = useState("");
  const [groupDrafts, setGroupDrafts] = useState<GroupDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listStaffPriceGroups(false)
      .then((rows: PriceGroup[]) => {
        if (ignore) return;
        const sorted = [...rows]
          .filter((g) => g.is_active)
          .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
        setGroupDrafts(
          sorted.map((g) => ({
            priceGroupId: g.id,
            name: g.name,
            mode: "keep" as const,
            price: "",
          })),
        );
        setGroupsError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setGroupsError(err instanceof Error ? err.message : "Не удалось загрузить группы");
      })
      .finally(() => {
        if (!ignore) setGroupsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const hasAnyChange = useMemo(() => {
    if (basePrice.trim() !== "") return true;
    return groupDrafts.some((g) => g.mode === "reset" || (g.mode === "set" && g.price.trim() !== ""));
  }, [basePrice, groupDrafts]);

  function patchGroup(priceGroupId: string, patch: Partial<GroupDraft>) {
    setGroupDrafts((prev) =>
      prev.map((g) => (g.priceGroupId === priceGroupId ? { ...g, ...patch } : g)),
    );
  }

  async function handleApply() {
    if (busy || !hasAnyChange) return;
    setError(null);

    const baseTrimmed = basePrice.trim();
    let base: BulkProductPricesPayload["base"] = { action: "keep" };
    if (baseTrimmed !== "") {
      const n = parsePrice(baseTrimmed);
      if (n == null || n < 0) {
        setError("Базовая цена должна быть неотрицательным числом");
        return;
      }
      base = { action: "set", price: n };
    }

    const groups: BulkProductPricesPayload["groups"] = [];
    for (const draft of groupDrafts) {
      if (draft.mode === "reset") {
        groups.push({ price_group_id: draft.priceGroupId, action: "reset" });
        continue;
      }
      const trimmed = draft.price.trim();
      if (trimmed === "") {
        groups.push({ price_group_id: draft.priceGroupId, action: "keep" });
        continue;
      }
      const n = parsePrice(trimmed);
      if (n == null || n < 0) {
        setError(`Некорректная цена для «${draft.name}»`);
        return;
      }
      groups.push({ price_group_id: draft.priceGroupId, action: "set", price: n });
    }

    setBusy(true);
    try {
      await bulkUpdateProductPrices(productIds, { base, groups });
      onApplied();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось применить цены");
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
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 id="bulk-prices-title" className="text-lg font-semibold text-neutral-800">
              Задать цены
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              Выбрано товаров: {productIds.length}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 ${focusRing}`}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-xs text-neutral-500">
            Пустое поле = не менять текущую цену. Сброс override категории — только явной
            кнопкой «Сбросить».
          </p>

          {groupsLoading ? (
            <p className="text-sm text-neutral-500">Загрузка категорий...</p>
          ) : groupsError ? (
            <p className="text-sm text-red-600" role="alert">
              {groupsError}
            </p>
          ) : (
            <>
              <label className="block text-sm text-neutral-700">
                <span className="font-medium">Базовая цена</span>
                <input
                  className={inputClass}
                  value={basePrice}
                  onChange={(e) => setBasePrice(e.target.value)}
                  inputMode="decimal"
                  placeholder="Не менять"
                  disabled={busy}
                />
              </label>

              {groupDrafts.map((draft) => (
                <div
                  key={draft.priceGroupId}
                  className="rounded-md border border-neutral-100 bg-neutral-50 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-neutral-800">{draft.name}</span>
                    {draft.mode === "reset" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => patchGroup(draft.priceGroupId, { mode: "keep", price: "" })}
                        className={`text-xs font-medium text-[#0F766E] ${focusRing}`}
                      >
                        Отменить сброс
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          patchGroup(draft.priceGroupId, { mode: "reset", price: "" })
                        }
                        className={`text-xs font-medium text-neutral-500 hover:text-red-600 ${focusRing}`}
                      >
                        Сбросить цену категории
                      </button>
                    )}
                  </div>
                  {draft.mode === "reset" ? (
                    <p className="mt-2 text-sm text-amber-700">
                      Override будет удалён → fallback на базовую цену
                    </p>
                  ) : (
                    <input
                      className={inputClass}
                      value={draft.price}
                      onChange={(e) =>
                        patchGroup(draft.priceGroupId, {
                          mode: "set",
                          price: e.target.value,
                        })
                      }
                      inputMode="decimal"
                      placeholder="Не менять"
                      disabled={busy}
                    />
                  )}
                </div>
              ))}

              {groupDrafts.length === 0 && (
                <p className="text-sm text-neutral-500">
                  Нет активных ценовых категорий. Создайте их в Настройки → Цены.
                </p>
              )}
            </>
          )}

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
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
            disabled={busy || groupsLoading || !hasAnyChange}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
          >
            {busy ? "Применение..." : "Применить к выбранным"}
          </button>
        </div>
      </div>
    </div>
  );
}
