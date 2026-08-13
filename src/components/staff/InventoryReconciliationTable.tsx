"use client";

import { useMemo, useState } from "react";
import {
  INVENTORY_RECONCILIATION_MATCH_LABELS,
  type InventoryReconciliationItem,
  type InventoryReconciliationPayload,
} from "@/types/database";
import { formatQty, formatSignedQty } from "@/lib/staff/inventoryReconciliationParse";
import { isApplyableItem } from "@/lib/staff/inventoryReconciliation";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

type FilterKey = "all" | "diff" | "equal" | "missing_dekoro" | "missing_1c" | "errors";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "diff", label: "Расхождения" },
  { key: "equal", label: "Совпадает" },
  { key: "missing_dekoro", label: "Не найдено" },
  { key: "missing_1c", label: "Нет в файле" },
  { key: "errors", label: "Ошибки" },
];

function matchesFilter(item: InventoryReconciliationItem, filter: FilterKey): boolean {
  switch (filter) {
    case "diff":
      return item.match_status === "matched_difference";
    case "equal":
      return item.match_status === "matched_equal";
    case "missing_dekoro":
      return item.match_status === "missing_in_dekoro";
    case "missing_1c":
      return item.match_status === "missing_in_source";
    case "errors":
      return item.match_status === "invalid" || item.match_status === "duplicate_source";
    default:
      return true;
  }
}

function statusClass(item: InventoryReconciliationItem): string {
  if (item.conflict_code === "reservation_conflict" || item.conflict_code === "stale") {
    return "text-red-700";
  }
  if (item.match_status === "matched_difference") return "text-amber-700";
  if (item.match_status === "matched_equal") return "text-emerald-700";
  if (item.match_status === "invalid" || item.match_status === "duplicate_source") {
    return "text-red-700";
  }
  return "text-neutral-600";
}

function itemStatusLabel(item: InventoryReconciliationItem): string {
  if (item.conflict_code === "stale") return "Остаток изменился";
  if (item.conflict_code === "reservation_conflict") return "Конфликт резерва";
  if (item.apply_status === "applied") return "Применено";
  return INVENTORY_RECONCILIATION_MATCH_LABELS[item.match_status];
}

export default function InventoryReconciliationTable({
  payload,
  readOnly,
  busy,
  onApply,
}: {
  payload: InventoryReconciliationPayload;
  readOnly: boolean;
  busy: boolean;
  onApply: (itemIds: string[]) => void;
}) {
  const { reconciliation, items } = payload;
  const [filter, setFilter] = useState<FilterKey>("diff");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const filtered = useMemo(
    () => items.filter((item) => matchesFilter(item, filter)),
    [items, filter],
  );
  const visible = filtered.slice(0, 500);

  const applyable = useMemo(
    () => items.filter(isApplyableItem),
    [items],
  );

  const selectedItems = applyable.filter((item) => selected.has(item.id));
  const willIncrease = selectedItems.filter((item) => (item.difference ?? 0) > 0).length;
  const willDecrease = selectedItems.filter((item) => (item.difference ?? 0) < 0).length;

  function toggle(id: string, enabled: boolean) {
    if (!enabled || readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectDifferences() {
    setSelected(new Set(applyable.map((item) => item.id)));
    setFilter("diff");
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Товаров в файле", reconciliation.total_rows],
          ["Совпало", reconciliation.matched_rows],
          ["Расхождений", reconciliation.different_rows],
          ["Не найдено в DEKORO", reconciliation.missing_in_dekoro_rows],
          ["Нет в загруженном файле", reconciliation.missing_in_source_rows],
          ["Ошибок/дубликатов", reconciliation.duplicate_rows + reconciliation.invalid_rows],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-neutral-200 bg-white px-3 py-3">
            <p className="text-xs text-neutral-400">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-neutral-800">
              {Number(value).toLocaleString("ru-RU")}
            </p>
          </div>
        ))}
      </div>

      {!readOnly && applyable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={selectDifferences}
            className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 ${focusRing}`}
          >
            Выбрать расхождения
          </button>
          <button
            type="button"
            disabled={busy || selectedItems.length === 0}
            onClick={() => setConfirmOpen(true)}
            className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            Применить выбранные
          </button>
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-1">
        {FILTERS.map((item) => {
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`min-w-[7rem] flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${focusRing} ${
                active
                  ? "bg-white text-[#0F766E] shadow-sm"
                  : "text-neutral-600 hover:text-neutral-800"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-400">
            <tr>
              {!readOnly && <th className="px-3 py-3 w-10" />}
              <th className="px-3 py-3">Товар</th>
              <th className="px-3 py-3">Артикул</th>
              <th className="px-3 py-3">DEKORO</th>
              <th className="px-3 py-3">1С</th>
              <th className="px-3 py-3">Разница</th>
              <th className="px-3 py-3">Резерв</th>
              <th className="px-3 py-3">Доступно</th>
              <th className="px-3 py-3">Статус</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={readOnly ? 8 : 9}
                  className="px-4 py-10 text-center text-neutral-500"
                >
                  Нет строк в этом фильтре
                </td>
              </tr>
            ) : (
              visible.map((item) => {
                const canSelect = !readOnly && isApplyableItem(item);
                const reservationBlocked =
                  item.conflict_code === "reservation_conflict" ||
                  (item.match_status === "matched_difference" &&
                    item.source_quantity != null &&
                    item.reserved_quantity != null &&
                    item.source_quantity < item.reserved_quantity);
                return (
                  <tr
                    key={item.id}
                    className={`border-t border-neutral-100 ${
                      reservationBlocked ? "bg-red-50" : ""
                    }`}
                  >
                    {!readOnly && (
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(item.id)}
                          disabled={!canSelect || busy}
                          onChange={() => toggle(item.id, canSelect)}
                          aria-label={`Выбрать ${item.source_sku ?? item.product_sku ?? item.id}`}
                          className="h-4 w-4 accent-[#0F766E]"
                        />
                      </td>
                    )}
                    <td className="px-3 py-3 text-neutral-800">
                      {item.product_name || item.source_name || "—"}
                    </td>
                    <td className="px-3 py-3 font-medium text-neutral-800">
                      {item.product_sku || item.source_sku || "—"}
                    </td>
                    <td className="px-3 py-3 tabular-nums">{formatQty(item.platform_quantity)}</td>
                    <td className="px-3 py-3 tabular-nums">{formatQty(item.source_quantity)}</td>
                    <td className="px-3 py-3 tabular-nums">{formatSignedQty(item.difference)}</td>
                    <td className="px-3 py-3 tabular-nums">{formatQty(item.reserved_quantity)}</td>
                    <td className="px-3 py-3 tabular-nums">{formatQty(item.available_quantity)}</td>
                    <td className={`px-3 py-3 ${statusClass(item)}`}>
                      <p>{itemStatusLabel(item)}</p>
                      {reservationBlocked && (
                        <p className="mt-1 text-xs text-red-700">
                          Остаток 1С ниже зарезервированного количества.
                        </p>
                      )}
                      {item.conflict_code === "stale" && (
                        <p className="mt-1 text-xs text-red-700">
                          {item.conflict_message}
                        </p>
                      )}
                      {item.match_status === "missing_in_dekoro" && (
                        <p className="mt-1 text-xs text-neutral-500">Не найден в DEKORO</p>
                      )}
                      {item.match_status === "missing_in_source" && (
                        <p className="mt-1 text-xs text-neutral-500">
                          Количество не обнуляется
                        </p>
                      )}
                      {item.error_message && item.match_status !== "matched_difference" && (
                        <p className="mt-1 text-xs text-neutral-500">{item.error_message}</p>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > 500 && (
        <p className="text-xs text-neutral-500">
          Показаны первые 500 из {filtered.length.toLocaleString("ru-RU")} строк фильтра.
          Скачайте Excel, чтобы увидеть полный список.
        </p>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
          role="dialog"
          aria-modal="true"
          aria-labelledby="apply-reconciliation-title"
          onClick={() => !busy && setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="apply-reconciliation-title" className="text-lg font-semibold text-neutral-800">
              Подтверждение сверки
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              Будут изменены остатки {selectedItems.length} товаров.
            </p>
            <p className="mt-3 text-sm text-neutral-700">
              Увеличатся: {willIncrease}
              <br />
              Уменьшатся: {willDecrease}
            </p>
            <p className="mt-3 text-xs text-neutral-500">
              Резервы заказов не сбрасываются. Это не поступление товара.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
                className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const ids = selectedItems.map((item) => item.id);
                  setConfirmOpen(false);
                  onApply(ids);
                }}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
              >
                Применить
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
