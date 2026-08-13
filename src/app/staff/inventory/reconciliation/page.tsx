"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import InventoryReconciliationHistory from "@/components/staff/InventoryReconciliationHistory";
import InventoryReconciliationTable from "@/components/staff/InventoryReconciliationTable";
import InventoryReconciliationUpload from "@/components/staff/InventoryReconciliationUpload";
import {
  applyInventoryReconciliation,
  cancelInventoryReconciliation,
  createInventoryReconciliation,
  downloadReconciliationExcel,
  getInventoryReconciliation,
  listInventoryReconciliations,
} from "@/lib/staff/inventoryReconciliation";
import type { ColumnMapping, MappingPreview, ParsedWorkbook } from "@/lib/staff/inventoryReconciliationParse";
import {
  INVENTORY_RECONCILIATION_STATUS_LABELS,
  canAccessInventoryReconciliation,
  type InventoryReconciliationListItem,
  type InventoryReconciliationPayload,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function StaffInventoryReconciliationPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const allowed = canAccessInventoryReconciliation(profile?.role);

  const [history, setHistory] = useState<InventoryReconciliationListItem[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [payload, setPayload] = useState<InventoryReconciliationPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshHistory() {
    const rows = await listInventoryReconciliations(50);
    setHistory(rows);
    setHistoryError(null);
  }

  useEffect(() => {
    if (!profileLoading && profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, allowed, router]);

  useEffect(() => {
    if (!allowed) {
      return;
    }

    let ignore = false;

    listInventoryReconciliations(50)
      .then((rows) => {
        if (ignore) return;
        setHistory(rows);
        setHistoryError(null);
        setHistoryLoading(false);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setHistoryError(err instanceof Error ? err.message : "Не удалось загрузить историю");
        setHistoryLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [allowed]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const rec = payload?.reconciliation;
  const canApply = rec?.status === "reviewed" || rec?.status === "partially_applied";

  async function handleParsed(
    workbook: ParsedWorkbook,
    mapping: ColumnMapping,
    preview: MappingPreview,
  ) {
    setBusy(true);
    setError(null);
    setMessage("Сверяем остатки DEKORO с файлом 1С...");
    try {
      const result = await createInventoryReconciliation({
        fileName: workbook.fileName,
        mapping,
        sheetName: workbook.sheetName,
        rows: preview.payload,
      });
      setPayload(result);
      setMessage("Сверка готова. Остатки ещё не изменены.");
      await refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось выполнить сверку");
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(itemIds: string[]) {
    if (!payload) return;
    setBusy(true);
    setError(null);
    setMessage("Применяем выбранные остатки...");
    try {
      const result = await applyInventoryReconciliation(payload.reconciliation.id, itemIds);
      setPayload(result);
      const applied = result.apply_result?.applied_count ?? 0;
      const stale = result.apply_result?.stale_count ?? 0;
      const reserved = result.apply_result?.reservation_conflict_count ?? 0;
      const parts = [`Применено: ${applied}`];
      if (stale > 0) {
        parts.push(
          `${stale} не применены: остаток изменился после загрузки файла. Выполните повторную сверку.`,
        );
      }
      if (reserved > 0) {
        parts.push(`${reserved} заблокированы из‑за резерва.`);
      }
      setMessage(parts.join(" "));
      await refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось применить сверку");
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen(id: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await getInventoryReconciliation(id);
      setPayload(result);
      setMessage(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось открыть сверку");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      const result = await cancelInventoryReconciliation(payload.reconciliation.id);
      setPayload(result);
      setMessage("Сверка отменена. Применённые ранее остатки не откатываются.");
      await refreshHistory();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось отменить сверку");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-neutral-500">
            <Link href="/staff/warehouse" className={`hover:text-[#0F766E] ${focusRing}`}>
              Склад
            </Link>
            <span className="px-1.5">/</span>
            Сверка с 1С
          </p>
          <h1 className="mt-1 text-2xl font-bold text-neutral-800">Сверка с 1С</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Сравнивается физический остаток DEKORO с выгрузкой 1С. Резервы заказов не сбрасываются.
          </p>
        </div>
        {payload && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => downloadReconciliationExcel(payload)}
              className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
            >
              Скачать результат Excel
            </button>
            {canApply && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleCancel()}
                className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:border-red-300 hover:text-red-700 ${focusRing}`}
              >
                Отменить сверку
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {message}
        </p>
      )}
      {busy && (
        <p className="text-sm text-neutral-500">Обработка...</p>
      )}

      <InventoryReconciliationUpload busy={busy} onParsed={(wb, mapping, preview) => void handleParsed(wb, mapping, preview)} />

      {payload && rec && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-neutral-800">
                {rec.reconciliation_number}
              </h2>
              <p className="mt-1 text-sm text-neutral-500">
                {rec.source_file_name} · {INVENTORY_RECONCILIATION_STATUS_LABELS[rec.status]}
              </p>
            </div>
          </div>
          <InventoryReconciliationTable
            payload={payload}
            readOnly={!canApply}
            busy={busy}
            onApply={(ids) => void handleApply(ids)}
          />
        </section>
      )}

      <InventoryReconciliationHistory
        rows={history}
        loading={historyLoading}
        error={historyError}
        activeId={rec?.id ?? null}
        onOpen={(id) => void handleOpen(id)}
      />
    </div>
  );
}
