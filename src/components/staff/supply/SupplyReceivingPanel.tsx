"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addUnexpectedProductSupplyReceivingItem,
  confirmProductSupplyReceiving,
  createDraftProductForSupply,
  fillProductSupplyReceivingExpected,
  formatSupplyRate,
  saveProductSupplyReceiving,
  searchProductsForSupply,
  startProductSupplyReceiving,
  supplyAcceptedQuantity,
  supplyReceivingDifference,
  type ProductSupplyPayload,
  type ProductSupplyProductSearch,
  type ProductSupplyReceiving,
  type ProductSupplyReceivingItem,
} from "@/lib/staff/supplies";
import {
  PRODUCT_SUPPLY_DISCREPANCY_LABELS,
  PRODUCT_SUPPLY_DISCREPANCY_TYPES,
  PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS,
  type ProductSupplyDiscrepancyType,
  type ProductSupplyHeader,
  type ProductSupplyLogisticsStatus,
  type ProductSupplyReceivingStatus,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";
const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

type LineDraft = {
  received: string;
  damaged: string;
  discrepancy_type: ProductSupplyDiscrepancyType | "";
  comment: string;
};

function toInput(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

function itemToDraft(item: ProductSupplyReceivingItem): LineDraft {
  return {
    received: toInput(item.received_quantity),
    damaged: toInput(item.damaged_quantity || 0),
    discrepancy_type: item.discrepancy_type ?? "",
    comment: item.comment ?? "",
  };
}

function diffLabel(diff: number | null): string {
  if (diff == null) return "—";
  if (diff === 0) return "0";
  if (diff < 0) return `Недостача: ${formatSupplyRate(-diff)}`;
  return `Излишек: ${formatSupplyRate(diff)}`;
}

export default function SupplyReceivingPanel({
  supply,
  receiving,
  onUpdated,
}: {
  supply: ProductSupplyHeader;
  receiving: ProductSupplyReceiving | null;
  onUpdated: (payload: ProductSupplyPayload) => void;
}) {
  return (
    <SupplyReceivingPanelInner
      key={receiving ? `${receiving.id}:${receiving.updated_at}` : "empty"}
      supply={supply}
      receiving={receiving}
      onUpdated={onUpdated}
    />
  );
}

function SupplyReceivingPanelInner({
  supply,
  receiving,
  onUpdated,
}: {
  supply: ProductSupplyHeader;
  receiving: ProductSupplyReceiving | null;
  onUpdated: (payload: ProductSupplyPayload) => void;
}) {
  const readOnly =
    supply.receiving_status === "completed" || receiving?.status === "confirmed";
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>(() => {
    if (!receiving) return {};
    const next: Record<string, LineDraft> = {};
    for (const item of receiving.items) {
      next[item.id] = itemToDraft(item);
    }
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [unexpectedOpen, setUnexpectedOpen] = useState(false);

  const softHint = useMemo(() => {
    return shouldPreferArrived(supply.logistics_status) ? null : (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Обычно приёмку начинают после статуса «Прибыл в Алматы». Ручной старт раньше всё равно
        разрешён.
      </p>
    );
  }, [supply.logistics_status]);

  async function run(action: () => Promise<ProductSupplyPayload>, okMessage?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const next = await action();
      onUpdated(next);
      if (okMessage) setInfo(okMessage);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ошибка приёмки");
    } finally {
      setBusy(false);
    }
  }

  function patchDraft(id: string, patch: Partial<LineDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? itemToDraft(receiving!.items.find((r) => r.id === id)!)), ...patch },
    }));
  }

  async function handleSave() {
    if (!receiving || readOnly) return;
    const items = receiving.items.map((item) => {
      const draft = drafts[item.id] ?? itemToDraft(item);
      const received =
        draft.received.trim() === "" ? null : Number(draft.received.replace(",", "."));
      const damaged =
        draft.damaged.trim() === "" ? 0 : Number(draft.damaged.replace(",", ".") || "0");
      return {
        id: item.id,
        receivedQuantity: received != null && Number.isFinite(received) ? received : null,
        damagedQuantity: Number.isFinite(damaged) ? damaged : 0,
        discrepancyType: (draft.discrepancy_type || null) as ProductSupplyDiscrepancyType | null,
        comment: draft.comment.trim() || null,
      };
    });
    await run(() => saveProductSupplyReceiving(supply.id, items), "Приёмка сохранена");
  }

  const summary = receiving?.summary;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Приёмка
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Статус: {PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS[supply.receiving_status]}
            {receiving?.stock_receipt_batch_id
              ? ` · batch ${receiving.stock_receipt_batch_id.slice(0, 8)}…`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {supply.receiving_status === "not_started" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => startProductSupplyReceiving(supply.id),
                  "Приёмка начата",
                )
              }
              className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
            >
              Начать приёмку
            </button>
          ) : null}
          {receiving && !readOnly ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => fillProductSupplyReceivingExpected(supply.id),
                    "Заполнено по накладной",
                  )
                }
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 ${focusRing}`}
              >
                Принять по накладной
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setUnexpectedOpen(true)}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 ${focusRing}`}
              >
                + Неожиданный товар
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSave()}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 disabled:opacity-60 ${focusRing}`}
              >
                Сохранить
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => confirmProductSupplyReceiving(supply.id),
                    "Приёмка подтверждена, склад обновлён",
                  )
                }
                className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
              >
                Подтвердить приёмку
              </button>
            </>
          ) : null}
        </div>
      </div>

      {softHint}

      {summary ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Stat label="Статус" value={statusLabel(supply.receiving_status)} />
          <Stat label="Ожидалось" value={formatSupplyRate(summary.expected_sum)} />
          <Stat label="Фактически получено" value={formatSupplyRate(summary.received_sum)} />
          <Stat label="Принято на склад" value={formatSupplyRate(summary.accepted_sum)} />
          <Stat label="Повреждено" value={formatSupplyRate(summary.damaged_sum)} />
          <Stat
            label="Недостача / излишек"
            value={`${formatSupplyRate(summary.shortage_sum)} / ${formatSupplyRate(summary.overage_sum)}`}
          />
        </div>
      ) : (
        <p className="text-sm text-neutral-500">
          Приёмка ещё не начата. После старта строки формируются из товаров поставки (ordered /
          shipped).
        </p>
      )}

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="rounded-md border border-teal-100 bg-teal-50 px-3 py-2 text-sm text-teal-800">
          {info}
        </p>
      ) : null}

      {receiving && receiving.items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="min-w-[1200px] w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Товар</th>
                <th className="px-3 py-2 font-medium">Заказ</th>
                <th className="px-3 py-2 font-medium">Отгрузка</th>
                <th className="px-3 py-2 font-medium">Ожид.</th>
                <th className="px-3 py-2 font-medium">Получено</th>
                <th className="px-3 py-2 font-medium">Повреждено</th>
                <th className="px-3 py-2 font-medium">Принято</th>
                <th className="px-3 py-2 font-medium">Разница</th>
                <th className="px-3 py-2 font-medium">Причина</th>
                <th className="px-3 py-2 font-medium">Комментарий</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {receiving.items.map((item) => {
                const draft = drafts[item.id] ?? itemToDraft(item);
                const received =
                  draft.received.trim() === ""
                    ? null
                    : Number(draft.received.replace(",", "."));
                const damaged =
                  draft.damaged.trim() === ""
                    ? 0
                    : Number(draft.damaged.replace(",", ".") || "0");
                const accepted = supplyAcceptedQuantity(
                  Number.isFinite(received as number) ? received : null,
                  Number.isFinite(damaged) ? damaged : 0,
                );
                const diff = supplyReceivingDifference(
                  Number.isFinite(received as number) ? received : null,
                  item.expected_quantity,
                );
                return (
                  <tr key={item.id} className={item.is_unexpected ? "bg-amber-50/40" : undefined}>
                    <td className="px-3 py-2 font-medium text-neutral-800">
                      {item.sku ?? "—"}
                      {item.is_unexpected ? (
                        <span className="mt-0.5 block text-[11px] font-normal text-amber-700">
                          неожиданный
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-neutral-700">
                      <div>{item.name ?? "—"}</div>
                      {item.spec ? (
                        <div className="text-xs text-neutral-400">{item.spec}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{formatSupplyRate(item.ordered_quantity)}</td>
                    <td className="px-3 py-2">{formatSupplyRate(item.shipped_quantity)}</td>
                    <td className="px-3 py-2">{formatSupplyRate(item.expected_quantity)}</td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        formatSupplyRate(item.received_quantity)
                      ) : (
                        <input
                          value={draft.received}
                          onChange={(e) => patchDraft(item.id, { received: e.target.value })}
                          className={`${inputClass} w-24`}
                          inputMode="decimal"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        formatSupplyRate(item.damaged_quantity)
                      ) : (
                        <input
                          value={draft.damaged}
                          onChange={(e) => patchDraft(item.id, { damaged: e.target.value })}
                          className={`${inputClass} w-20`}
                          inputMode="decimal"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {formatSupplyRate(readOnly ? item.accepted_quantity : accepted)}
                    </td>
                    <td className="px-3 py-2 text-neutral-700">
                      {diffLabel(readOnly ? item.difference_quantity : diff)}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        item.discrepancy_type
                          ? PRODUCT_SUPPLY_DISCREPANCY_LABELS[item.discrepancy_type]
                          : "—"
                      ) : (
                        <select
                          value={draft.discrepancy_type}
                          onChange={(e) =>
                            patchDraft(item.id, {
                              discrepancy_type: e.target.value as ProductSupplyDiscrepancyType | "",
                            })
                          }
                          className={`${inputClass} min-w-[140px]`}
                          disabled={diff === 0 && damaged === 0 && !item.is_unexpected}
                        >
                          <option value="">—</option>
                          {PRODUCT_SUPPLY_DISCREPANCY_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {PRODUCT_SUPPLY_DISCREPANCY_LABELS[type]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {readOnly ? (
                        item.comment ?? "—"
                      ) : (
                        <input
                          value={draft.comment}
                          onChange={(e) => patchDraft(item.id, { comment: e.target.value })}
                          className={`${inputClass} min-w-[160px]`}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {unexpectedOpen ? (
        <UnexpectedProductModal
          supplyId={supply.id}
          onClose={() => setUnexpectedOpen(false)}
          onAdded={(payload) => {
            onUpdated(payload);
            setUnexpectedOpen(false);
            setInfo("Неожиданный товар добавлен");
          }}
        />
      ) : null}
    </section>
  );
}

function shouldPreferArrived(status: ProductSupplyLogisticsStatus): boolean {
  return status === "arrived_almaty" || status === "completed";
}

function statusLabel(status: ProductSupplyReceivingStatus): string {
  return PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS[status];
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-1 text-sm font-semibold text-neutral-800">{value}</p>
    </div>
  );
}

function UnexpectedProductModal({
  supplyId,
  onClose,
  onAdded,
}: {
  supplyId: string;
  onClose: () => void;
  onAdded: (payload: ProductSupplyPayload) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSupplyProductSearch[]>([]);
  const [selected, setSelected] = useState<ProductSupplyProductSearch | null>(null);
  const [received, setReceived] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftSku, setDraftSku] = useState("");
  const [draftName, setDraftName] = useState("");
  const [mode, setMode] = useState<"search" | "draft">("search");

  useEffect(() => {
    if (mode !== "search") return;
    const handle = window.setTimeout(() => {
      void searchProductsForSupply(query)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query, mode]);

  async function submit() {
    if (busy) return;
    const qty = Number(received.replace(",", "."));
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Укажите полученное количество > 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let productId = selected?.id;
      if (mode === "draft") {
        if (!draftSku.trim() || !draftName.trim()) {
          setError("Укажите артикул и название draft-товара");
          setBusy(false);
          return;
        }
        const created = await createDraftProductForSupply({
          sku: draftSku.trim(),
          name: draftName.trim(),
        });
        productId = created.id;
      }
      if (!productId) {
        setError("Выберите товар");
        setBusy(false);
        return;
      }
      const payload = await addUnexpectedProductSupplyReceivingItem({
        supplyId,
        productId,
        receivedQuantity: qty,
        comment: comment.trim() || null,
      });
      onAdded(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось добавить");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
        <h3 className="text-base font-semibold text-neutral-900">Неожиданный товар</h3>
        <p className="mt-1 text-xs text-neutral-500">
          ordered = 0, shipped = 0, discrepancy = unexpected. Товар появится в приёмке и в поставке.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("search")}
            className={`rounded-md px-3 py-1.5 text-sm ${mode === "search" ? "bg-[#0F766E] text-white" : "border border-neutral-200"} ${focusRing}`}
          >
            Существующий
          </button>
          <button
            type="button"
            onClick={() => setMode("draft")}
            className={`rounded-md px-3 py-1.5 text-sm ${mode === "draft" ? "bg-[#0F766E] text-white" : "border border-neutral-200"} ${focusRing}`}
          >
            Новый draft
          </button>
        </div>

        {mode === "search" ? (
          <div className="mt-3 flex flex-col gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск SKU / названия"
              className={inputClass}
            />
            <div className="max-h-40 overflow-y-auto rounded-md border border-neutral-200">
              {results.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelected(row)}
                  className={`block w-full px-3 py-2 text-left text-sm ${
                    selected?.id === row.id ? "bg-teal-50 text-[#0F766E]" : "hover:bg-neutral-50"
                  }`}
                >
                  <span className="font-medium">{row.sku}</span> · {row.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-3 grid gap-2">
            <input
              value={draftSku}
              onChange={(e) => setDraftSku(e.target.value)}
              placeholder="Артикул"
              className={inputClass}
            />
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Название"
              className={inputClass}
            />
          </div>
        )}

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-400">Получено *</span>
            <input
              value={received}
              onChange={(e) => setReceived(e.target.value)}
              className={inputClass}
              inputMode="decimal"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-400">Комментарий</span>
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        {error ? (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm ${focusRing}`}
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${focusRing}`}
          >
            {busy ? "Добавление..." : "Добавить"}
          </button>
        </div>
      </div>
    </div>
  );
}
