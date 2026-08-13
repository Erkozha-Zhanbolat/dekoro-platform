"use client";

import { useMemo, useState } from "react";
import {
  buildMappingPreview,
  formatQty,
  suggestColumnMapping,
  type ColumnMapping,
  type MappingPreview,
} from "@/lib/staff/inventoryReconciliationParse";
import { parseExcelFile } from "@/lib/staff/inventoryReconciliation";
import type { ParsedWorkbook } from "@/lib/staff/inventoryReconciliationParse";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const selectClass = `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

export default function InventoryReconciliationUpload({
  busy,
  onParsed,
}: {
  busy: boolean;
  onParsed: (workbook: ParsedWorkbook, mapping: ColumnMapping, preview: MappingPreview) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({
    skuColumn: "",
    nameColumn: "",
    quantityColumn: "",
  });

  const preview = useMemo(() => {
    if (!workbook) return null;
    if (!mapping.skuColumn || !mapping.quantityColumn) return null;
    return buildMappingPreview(workbook.headers, workbook.rows, mapping, workbook.headerRowIndex);
  }, [workbook, mapping]);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const parsed = await parseExcelFile(file);
      const suggested = suggestColumnMapping(parsed.headers);
      setWorkbook(parsed);
      setMapping(suggested);
    } catch (err: unknown) {
      setWorkbook(null);
      setError(err instanceof Error ? err.message : "Не удалось прочитать файл");
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          1. Загрузить файл
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Excel из 1С не меняет остатки сам по себе. Сначала сверка, затем явное подтверждение.
        </p>
      </div>

      <label className="block">
        <span className="sr-only">Загрузить Excel из 1С</span>
        <input
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            void handleFile(file);
            event.target.value = "";
          }}
          className={`block w-full text-sm text-neutral-600 file:mr-4 file:rounded-md file:border-0 file:bg-[#0F766E] file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-white hover:file:bg-[#0c5f58] ${focusRing}`}
        />
      </label>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      {workbook && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-neutral-400">Файл</p>
              <p className="mt-1 truncate text-sm font-medium text-neutral-800">{workbook.fileName}</p>
            </div>
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-neutral-400">Строк</p>
              <p className="mt-1 text-sm font-medium text-neutral-800">
                {workbook.totalDataRows.toLocaleString("ru-RU")}
              </p>
            </div>
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-neutral-400">Лист</p>
              <p className="mt-1 truncate text-sm font-medium text-neutral-800">{workbook.sheetName}</p>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              2. Сопоставить колонки
            </h3>
            <p className="mt-1 text-sm text-neutral-500">
              Проверьте, какие колонки содержат артикул и остаток. Название можно не указывать.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Артикул / SKU *
              </span>
              <select
                className={selectClass}
                value={mapping.skuColumn}
                disabled={busy}
                onChange={(e) => setMapping((m) => ({ ...m, skuColumn: e.target.value }))}
              >
                <option value="">Не выбрано</option>
                {workbook.headers.map((header, index) => (
                  <option key={`sku-${index}`} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Название
              </span>
              <select
                className={selectClass}
                value={mapping.nameColumn}
                disabled={busy}
                onChange={(e) => setMapping((m) => ({ ...m, nameColumn: e.target.value }))}
              >
                <option value="">Не использовать</option>
                {workbook.headers.map((header, index) => (
                  <option key={`name-${index}`} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Остаток *
              </span>
              <select
                className={selectClass}
                value={mapping.quantityColumn}
                disabled={busy}
                onChange={(e) => setMapping((m) => ({ ...m, quantityColumn: e.target.value }))}
              >
                <option value="">Не выбрано</option>
                {workbook.headers.map((header, index) => (
                  <option key={`qty-${index}`} value={header}>
                    {header}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {preview && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md bg-neutral-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-neutral-400">Распознано</p>
                <p className="mt-1 text-lg font-semibold text-neutral-800">
                  {preview.recognized.toLocaleString("ru-RU")}
                </p>
              </div>
              <div className="rounded-md bg-neutral-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-neutral-400">Ошибок</p>
                <p className="mt-1 text-lg font-semibold text-neutral-800">
                  {preview.errorCount.toLocaleString("ru-RU")}
                </p>
              </div>
              <div className="rounded-md bg-neutral-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-neutral-400">Дубликатов строк</p>
                <p className="mt-1 text-lg font-semibold text-neutral-800">
                  {preview.duplicateCount.toLocaleString("ru-RU")}
                </p>
              </div>
            </div>
          )}

          {preview && preview.issues.length > 0 && (
            <div className="max-h-40 overflow-auto rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {preview.issues.slice(0, 12).map((issue) => (
                <p key={`${issue.rowNumber}-${issue.message}`}>
                  Строка {issue.rowNumber}
                  {issue.sku ? ` (${issue.sku})` : ""}: {issue.message}
                </p>
              ))}
              {preview.issues.length > 12 && (
                <p>…и ещё {preview.issues.length - 12}</p>
              )}
            </div>
          )}

          {preview && preview.payload.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-neutral-100">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Строка</th>
                    <th className="px-3 py-2">Артикул</th>
                    <th className="px-3 py-2">Название</th>
                    <th className="px-3 py-2">Остаток</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.payload.slice(0, 5).map((row) => (
                    <tr key={row.row_number} className="border-t border-neutral-100">
                      <td className="px-3 py-2 text-neutral-500">{row.row_number}</td>
                      <td className="px-3 py-2 font-medium text-neutral-800">{row.sku || "—"}</td>
                      <td className="px-3 py-2 text-neutral-600">{row.name || "—"}</td>
                      <td className="px-3 py-2 text-neutral-800">{formatQty(row.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button
            type="button"
            disabled={busy || !preview || preview.payload.length === 0 || !mapping.skuColumn || !mapping.quantityColumn}
            onClick={() => {
              if (!workbook || !preview) return;
              onParsed(workbook, mapping, preview);
            }}
            className={`self-start rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {busy ? "Сверка..." : "3. Проверить и сравнить"}
          </button>
        </>
      )}
    </section>
  );
}
