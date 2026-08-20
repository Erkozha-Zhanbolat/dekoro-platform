"use client";

import { useState } from "react";
import {
  PRODUCT_SUPPLY_LOGISTICS_LABELS,
  PRODUCT_SUPPLY_LOGISTICS_STATUS_ORDER,
  type ProductSupplyLogisticsStatus,
  type ProductSupplyStatusHistoryItem,
} from "@/types/database";
import { setProductSupplyLogisticsStatus, type ProductSupplyPayload } from "@/lib/staff/supplies";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SupplyLogisticsPanel({
  supplyId,
  current,
  history,
  onUpdated,
}: {
  supplyId: string;
  current: ProductSupplyLogisticsStatus;
  history: ProductSupplyStatusHistoryItem[];
  onUpdated: (payload: ProductSupplyPayload) => void;
}) {
  const [toStatus, setToStatus] = useState<ProductSupplyLogisticsStatus>(current);
  const [note, setNote] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await setProductSupplyLogisticsStatus({
        supplyId,
        toStatus,
        note: note.trim() || null,
        location: location.trim() || null,
      });
      onUpdated(next);
      setNote("");
      setLocation("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сменить статус");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Логистический статус
          </span>
          <select
            value={toStatus}
            onChange={(e) => setToStatus(e.target.value as ProductSupplyLogisticsStatus)}
            className={inputClass}
          >
            {PRODUCT_SUPPLY_LOGISTICS_STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {PRODUCT_SUPPLY_LOGISTICS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Место / комментарий</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заметка</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
        </label>
      </div>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy || toStatus === current}
        onClick={() => void handleSave()}
        className={`self-start rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-50 ${focusRing}`}
      >
        {busy ? "Сохранение..." : "Записать статус"}
      </button>

      <ol className="relative border-l border-neutral-200 pl-5">
        {history.map((event) => {
          const isCurrent = event.to_status === current && event.id === history[history.length - 1]?.id;
          return (
            <li key={event.id} className="mb-5 last:mb-0">
              <span
                className={`absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full ${
                  isCurrent ? "bg-[#0F766E]" : "bg-neutral-300"
                }`}
              />
              <p className={`text-sm ${isCurrent ? "font-semibold text-neutral-900" : "font-medium text-neutral-700"}`}>
                {PRODUCT_SUPPLY_LOGISTICS_LABELS[event.to_status]}
              </p>
              <p className="text-xs text-neutral-500">
                {formatWhen(event.changed_at)}
                {event.changed_by_name ? ` · ${event.changed_by_name}` : ""}
                {event.location ? ` · ${event.location}` : ""}
              </p>
              {event.note ? <p className="mt-1 text-sm text-neutral-600">{event.note}</p> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
