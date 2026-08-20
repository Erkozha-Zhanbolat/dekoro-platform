"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  PRODUCT_SUPPLY_DOCUMENT_TYPE_LABELS,
  PRODUCT_SUPPLY_DOCUMENT_TYPE_ORDER,
  type ProductSupplyDocumentType,
  type ProductSupplyExpense,
  type ProductSupplyPayload,
} from "@/types/database";
import {
  deleteSupplyDocument,
  downloadSupplyDocumentOriginal,
  isSupplyImportDocumentType,
  openSupplyDocumentInBrowser,
  supplyDocumentInternalPath,
  supplyDocumentOpenMode,
  updateSupplyDocument,
  uploadSupplyDocument,
} from "@/lib/staff/supplyDocuments";
import { isExcelFileName } from "@/lib/staff/supplyImports";
import { formatSupplyMoney } from "@/lib/staff/supplies";

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

export default function SupplyDocumentsPanel({
  payload,
  onUpdated,
}: {
  payload: ProductSupplyPayload;
  onUpdated: (next: ProductSupplyPayload) => void;
}) {
  const { supply, expenses } = payload;
  const router = useRouter();
  const closed = supply.status === "closed";

  const [docType, setDocType] = useState<ProductSupplyDocumentType>("factory_order");
  const [title, setTitle] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [notes, setNotes] = useState("");
  const [linkedExpenseId, setLinkedExpenseId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleUpload() {
    if (!file || busy) return;
    if (docType === "other" && !title.trim()) {
      setError("Для типа «Другое» укажите название");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await uploadSupplyDocument({
        supplyId: supply.id,
        file,
        documentType: docType,
        title: title.trim() || undefined,
        documentDate: documentDate || null,
        notes: notes.trim() || null,
        linkedExpenseId: linkedExpenseId || null,
      });
      if (result.payload) onUpdated(result.payload);
      const importExcel =
        isSupplyImportDocumentType(docType) && isExcelFileName(file.name);
      if (result.parserError) {
        setError(result.parserError);
      }
      if (result.duplicateFile) {
        setInfo("Такой файл уже загружался в эту поставку.");
      }
      if (importExcel && result.documentId && !result.parserError) {
        router.push(supplyDocumentInternalPath(supply.id, result.documentId));
        return;
      }
      setInfo(result.parserError ? "Файл сохранён в архив, но разбор не удался." : "Файл сохранён в архив.");
      setFile(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить документ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Тип документа</span>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as ProductSupplyDocumentType)}
            className={inputClass}
          >
            {PRODUCT_SUPPLY_DOCUMENT_TYPE_ORDER.map((type) => (
              <option key={type} value={type}>
                {PRODUCT_SUPPLY_DOCUMENT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Название</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputClass}
            placeholder={docType === "other" ? "Обязательно для «Другое»" : "По имени файла, если пусто"}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Дата документа</span>
          <input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Связанный расход</span>
          <select value={linkedExpenseId} onChange={(e) => setLinkedExpenseId(e.target.value)} className={inputClass}>
            <option value="">Нет</option>
            {expenses.map((exp) => (
              <option key={exp.id} value={exp.id}>
                {exp.name}
                {exp.amount_kzt != null ? ` — ${formatSupplyMoney(exp.amount_kzt)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Файл</span>
          <input
            type="file"
            accept=".xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заметка</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </label>
      </div>
      <p className="text-xs text-neutral-500">
        Оригинал сохраняется без изменений. Excel заказа/накладной открывается как документ DEKORO.
        Скачать оригинал выдаёт исходный файл из архива. Закрытая себестоимость не меняется от нового файла.
      </p>
      <button
        type="button"
        disabled={!file || busy}
        onClick={() => void handleUpload()}
        className={`self-start rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-50 ${focusRing}`}
      >
        {busy ? "Загрузка..." : "Загрузить документ"}
      </button>

      {info ? <p className="text-sm text-neutral-600">{info}</p> : null}
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <DocumentsTable payload={payload} onUpdated={onUpdated} expenses={expenses} closed={closed} />
    </div>
  );
}

function DocumentsTable({
  payload,
  onUpdated,
  expenses,
  closed,
}: {
  payload: ProductSupplyPayload;
  onUpdated: (next: ProductSupplyPayload) => void;
  expenses: ProductSupplyExpense[];
  closed: boolean;
}) {
  const { documents, supply } = payload;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (documents.length === 0) {
    return <p className="text-sm text-neutral-500">Архив документов пуст</p>;
  }

  return (
    <div className="overflow-x-auto">
      {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
      <table className="min-w-[960px] w-full text-left text-sm">
        <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-2 py-2 font-medium">Тип</th>
            <th className="px-2 py-2 font-medium">Название</th>
            <th className="px-2 py-2 font-medium">Дата документа</th>
            <th className="px-2 py-2 font-medium">Файл</th>
            <th className="px-2 py-2 font-medium">Загружен</th>
            <th className="px-2 py-2 font-medium">Кто загрузил</th>
            <th className="px-2 py-2 font-medium">Связанный расход</th>
            <th className="px-2 py-2 font-medium">Действия</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {documents.map((doc) => {
            const openMode = supplyDocumentOpenMode(doc);
            return (
              <tr key={doc.id}>
                <td className="px-2 py-2">{PRODUCT_SUPPLY_DOCUMENT_TYPE_LABELS[doc.document_type]}</td>
                <td className="px-2 py-2">
                  {doc.title}
                  {doc.parser_status === "committed" ? (
                    <p className="text-[11px] text-emerald-700">Импорт подтверждён</p>
                  ) : doc.parsed_row_count > 0 ? (
                    <p className="text-[11px] text-neutral-500">{doc.parsed_row_count} строк</p>
                  ) : null}
                </td>
                <td className="px-2 py-2">
                  {doc.document_date
                    ? new Date(`${doc.document_date}T00:00:00`).toLocaleDateString("ru-RU")
                    : "—"}
                </td>
                <td className="px-2 py-2 text-neutral-600">{doc.original_filename}</td>
                <td className="px-2 py-2 text-neutral-600">{formatWhen(doc.uploaded_at)}</td>
                <td className="px-2 py-2">{doc.uploaded_by_name ?? "—"}</td>
                <td className="px-2 py-2">
                  <select
                    value={doc.linked_expense_id ?? ""}
                    disabled={busyId === doc.id}
                    onChange={(e) => {
                      const value = e.target.value;
                      setBusyId(doc.id);
                      setError(null);
                      void updateSupplyDocument(doc.id, {
                        linkedExpenseId: value || null,
                        clearExpense: value === "",
                      })
                        .then(onUpdated)
                        .catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : "Не удалось связать расход");
                        })
                        .finally(() => setBusyId(null));
                    }}
                    className={inputClass}
                  >
                    <option value="">—</option>
                    {expenses.map((exp) => (
                      <option key={exp.id} value={exp.id}>
                        {exp.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-2">
                    {openMode === "internal" ? (
                      <Link
                        href={supplyDocumentInternalPath(supply.id, doc.id)}
                        className={`text-xs text-[#0F766E] hover:underline ${focusRing}`}
                      >
                        Открыть
                      </Link>
                    ) : null}
                    {openMode === "browser" ? (
                      <button
                        type="button"
                        className={`text-xs text-[#0F766E] hover:underline ${focusRing}`}
                        onClick={() =>
                          void openSupplyDocumentInBrowser(doc.id).catch((err: unknown) => {
                            setError(err instanceof Error ? err.message : "Не удалось открыть файл");
                          })
                        }
                      >
                        Открыть
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`text-xs text-[#0F766E] hover:underline ${focusRing}`}
                      onClick={() =>
                        void downloadSupplyDocumentOriginal(doc.id).catch((err: unknown) => {
                          setError(err instanceof Error ? err.message : "Не удалось скачать файл");
                        })
                      }
                    >
                      Скачать оригинал
                    </button>
                    {doc.parser_status !== "committed" && !closed ? (
                      <button
                        type="button"
                        className={`text-xs text-red-600 hover:underline ${focusRing}`}
                        onClick={() => {
                          if (!window.confirm("Удалить документ из архива?")) return;
                          setBusyId(doc.id);
                          void deleteSupplyDocument(doc.id)
                            .then((next) => {
                              if (next) onUpdated(next);
                            })
                            .catch((err: unknown) => {
                              setError(err instanceof Error ? err.message : "Не удалось удалить");
                            })
                            .finally(() => setBusyId(null));
                        }}
                      >
                        Удалить
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
