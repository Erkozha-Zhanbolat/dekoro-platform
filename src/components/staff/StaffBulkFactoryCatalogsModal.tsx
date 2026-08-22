"use client";

import { useMemo, useState } from "react";
import { bulkAssignFactoryCatalogs } from "@/lib/staff/factoryCatalogs";
import type { FactoryCatalog } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function StaffBulkFactoryCatalogsModal({
  productIds,
  catalogs,
  onClose,
  onApplied,
}: {
  productIds: string[];
  catalogs: FactoryCatalog[];
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const active = useMemo(() => catalogs.filter((c) => c.is_active), [catalogs]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleApply() {
    if (busy) return;
    if (mode === "add" && selected.size === 0) {
      setError("Выберите хотя бы один каталог");
      return;
    }
    if (mode === "replace") {
      const names = active.filter((c) => selected.has(c.id)).map((c) => c.name);
      const confirmed = window.confirm(
        `Заменить заводские каталоги у ${productIds.length} товаров?\n\n` +
          (names.length === 0
            ? "Все текущие назначения будут сняты."
            : `Новый набор: ${names.join(", ")}.`),
      );
      if (!confirmed) return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await bulkAssignFactoryCatalogs({
        productIds,
        catalogIds: [...selected],
        mode,
      });
      onApplied(
        mode === "add"
          ? `Каталоги добавлены: ${result.products} тов., новых связей ${result.rows_inserted}`
          : `Каталоги заменены у ${result.products} товаров`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось назначить каталоги");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-800">
              Назначить заводские каталоги
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Выбрано товаров: {productIds.length}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 ${focusRing}`}
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-2 text-sm text-neutral-700">
            <input
              type="radio"
              className="mt-0.5 accent-[#0F766E]"
              checked={mode === "add"}
              onChange={() => setMode("add")}
            />
            <span>
              <span className="font-medium">Добавить</span> — выбранные каталоги
              добавляются, текущие назначения сохраняются.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-neutral-700">
            <input
              type="radio"
              className="mt-0.5 accent-[#0F766E]"
              checked={mode === "replace"}
              onChange={() => setMode("replace")}
            />
            <span>
              <span className="font-medium">Заменить</span> — полностью заменить
              принадлежность выбранных товаров. Требует подтверждение.
            </span>
          </label>
        </div>

        <ul className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {active.length === 0 ? (
            <li className="text-sm text-neutral-500">Нет активных каталогов</li>
          ) : (
            active.map((catalog) => (
              <li key={catalog.id}>
                <label className="flex items-center gap-2 text-sm text-neutral-800">
                  <input
                    type="checkbox"
                    className="accent-[#0F766E]"
                    checked={selected.has(catalog.id)}
                    onChange={() => toggle(catalog.id)}
                  />
                  <span>{catalog.name}</span>
                </label>
              </li>
            ))
          )}
        </ul>

        {error ? (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 ${focusRing}`}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleApply()}
            disabled={busy}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {busy ? "Сохранение..." : "Применить"}
          </button>
        </div>
      </div>
    </div>
  );
}
