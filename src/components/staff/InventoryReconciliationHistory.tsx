"use client";

import {
  INVENTORY_RECONCILIATION_STATUS_LABELS,
  type InventoryReconciliationListItem,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function formatWhen(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function InventoryReconciliationHistory({
  rows,
  loading,
  error,
  activeId,
  onOpen,
}: {
  rows: InventoryReconciliationListItem[];
  loading: boolean;
  error: string | null;
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-neutral-800">История сверок</h2>
      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка истории...</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-200 bg-white px-5 py-8 text-center text-sm text-neutral-500">
          Сверок пока нет
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const active = row.id === activeId;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onOpen(row.id)}
                  className={`w-full rounded-lg border bg-white p-4 text-left transition-colors ${focusRing} ${
                    active
                      ? "border-[#0F766E] ring-1 ring-[#0F766E]/30"
                      : "border-neutral-200 hover:border-[#0F766E]"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-neutral-800">{row.reconciliation_number}</p>
                      <p className="mt-1 text-sm text-neutral-500">
                        {formatWhen(row.created_at)} · {row.source_file_name}
                      </p>
                    </div>
                    <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                      {INVENTORY_RECONCILIATION_STATUS_LABELS[row.status]}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-neutral-500">
                    <span>{row.total_rows.toLocaleString("ru-RU")} строк</span>
                    <span>{row.different_rows.toLocaleString("ru-RU")} расхождений</span>
                    <span>{row.applied_rows.toLocaleString("ru-RU")} применено</span>
                    <span>{row.created_by_name || "Сотрудник"}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
