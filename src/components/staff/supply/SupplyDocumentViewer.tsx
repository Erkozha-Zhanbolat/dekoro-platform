"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PRODUCT_SUPPLY_DOCUMENT_TYPE_LABELS,
  SUPPLY_DOCUMENT_ROW_MATCH_LABELS,
  type ProductSupplyProductSearch,
  type SupplyDocumentProductCandidate,
} from "@/types/database";
import FactoryCatalogMarkers from "@/components/staff/FactoryCatalogMarkers";
import {
  commitSupplyImport,
  createDraftForSupplyDocumentRow,
  downloadSupplyDocumentOriginal,
  getSupplyDocumentDetail,
  patchSupplyDocumentRow,
  type SupplyDocumentDetail,
  type SupplyDocumentParsedRow,
} from "@/lib/staff/supplyDocuments";
import {
  formatSupplyMoney,
  formatSupplyRate,
  getProductSupply,
  getSupplyFxRate,
  searchProductsForSupply,
} from "@/lib/staff/supplies";
import type { ProductSupplyFxRate, ProductSupplyHeader } from "@/types/database";

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

function productContext(row: {
  sku?: string | null;
  name?: string | null;
  category_name?: string | null;
  subcategory_name?: string | null;
  dimensions?: string | null;
  original_sku?: string | null;
}): string {
  const parts = [
    row.sku,
    row.name,
    [row.category_name, row.subcategory_name].filter(Boolean).join(" / ") || null,
    row.dimensions,
    row.original_sku ? `orig. ${row.original_sku}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export default function SupplyDocumentViewer({
  supplyId,
  documentId,
}: {
  supplyId: string;
  documentId: string;
}) {
  const [detail, setDetail] = useState<SupplyDocumentDetail | null>(null);
  const [fxRates, setFxRates] = useState<ProductSupplyFxRate[]>([]);
  const [supplyHeader, setSupplyHeader] = useState<Pick<
    ProductSupplyHeader,
    "default_currency" | "default_exchange_rate_to_kzt"
  > | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pickRowId, setPickRowId] = useState<string | null>(null);
  const [draftRowId, setDraftRowId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await getSupplyDocumentDetail(documentId);
    if (next.supply_id !== supplyId) {
      throw new Error("Документ не принадлежит этой поставке");
    }
    setDetail(next);
  }, [documentId, supplyId]);

  useEffect(() => {
    let ignore = false;
    Promise.all([getSupplyDocumentDetail(documentId), getProductSupply(supplyId)])
      .then(([next, supplyPayload]) => {
        if (ignore) return;
        if (next.supply_id !== supplyId) {
          setLoadError("Документ не принадлежит этой поставке");
          return;
        }
        setDetail(next);
        setFxRates(supplyPayload.fx_rates);
        setSupplyHeader({
          default_currency: supplyPayload.supply.default_currency,
          default_exchange_rate_to_kzt: supplyPayload.supply.default_exchange_rate_to_kzt,
        });
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setLoadError(err instanceof Error ? err.message : "Не удалось загрузить документ");
      });
    return () => {
      ignore = true;
    };
  }, [documentId, supplyId]);

  const closed = detail?.supply_status === "closed";
  const committed = detail?.document.parser_status === "committed";
  const editable = Boolean(detail) && !closed;

  const pending = useMemo(() => {
    if (!detail) return 0;
    return detail.rows.filter(
      (row) =>
        row.match_status !== "skipped" &&
        (row.match_status === "unmatched" ||
          row.match_status === "needs_selection" ||
          !row.matched_product_id),
    ).length;
  }, [detail]);

  async function applyPatch(input: Parameters<typeof patchSupplyDocumentRow>[0]) {
    setBusy(true);
    setError(null);
    try {
      const next = await patchSupplyDocumentRow(input);
      setDetail(next);
      setPickRowId(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить строку");
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!detail || busy) return;
    if (pending > 0) {
      setError("Сопоставьте все строки или пропустите их.");
      return;
    }
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await commitSupplyImport({
        documentId,
        replace: committed,
      });
      await load();
      setInfo(committed ? "Импорт обновлён." : "Импорт подтверждён.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось подтвердить импорт");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink supplyId={supplyId} />
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  if (!detail) {
    return <p className="text-sm text-neutral-500">Загрузка документа...</p>;
  }

  const doc = detail.document;
  const ignored = Array.isArray(detail.parser_metadata.ignored)
    ? (detail.parser_metadata.ignored as { rowNumber?: number; reason?: string; preview?: string }[])
    : [];
  const profileLabel = asText(detail.parser_metadata.profileLabel);
  const linkedRows = detail.rows.filter((row) => row.linked_supply_item_id);

  return (
    <div className="flex flex-col gap-6">
      <BackLink supplyId={supplyId} />

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Оригинал</p>
            <h1 className="mt-1 text-lg font-semibold text-neutral-900">{doc.title}</h1>
            <p className="mt-1 text-sm text-neutral-600">
              {detail.supply_number} · {PRODUCT_SUPPLY_DOCUMENT_TYPE_LABELS[doc.document_type]} · {doc.original_filename}
            </p>
          </div>
          <button
            type="button"
            className={`rounded-md border border-neutral-200 px-3 py-2 text-sm text-[#0F766E] ${focusRing}`}
            onClick={() =>
              void downloadSupplyDocumentOriginal(doc.id).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Не удалось скачать файл");
              })
            }
          >
            Скачать оригинал
          </button>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <Info label="Дата загрузки" value={formatWhen(doc.uploaded_at)} />
          <Info
            label="Дата документа"
            value={
              doc.document_date
                ? new Date(`${doc.document_date}T00:00:00`).toLocaleDateString("ru-RU")
                : "—"
            }
          />
          <Info label="Кто загрузил" value={doc.uploaded_by_name ?? "—"} />
          <Info label="Заметка" value={doc.notes ?? "—"} />
        </dl>
        {profileLabel ? (
          <p className="mt-3 text-xs text-neutral-500">Профиль разбора: {profileLabel}</p>
        ) : null}
      </section>

      {committed ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">Импорт подтверждён</p>
          {doc.imported_at ? (
            <p className="mt-1 text-xs">Подтверждён {formatWhen(doc.imported_at)}</p>
          ) : null}
          {linkedRows.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {linkedRows.map((row) => (
                <li key={row.id}>
                  {row.linked_item_sku ?? row.matched_sku ?? "—"}{" "}
                  {row.linked_item_name ?? row.matched_name ?? ""}
                  {row.quantity != null ? ` — ${row.quantity} ${row.unit ?? ""}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Распознанные данные
            </h2>
            <p className="mt-1 text-xs text-neutral-500">
              Сопоставлено {detail.match_summary.matched}, требуется выбор{" "}
              {detail.match_summary.needs_selection}, не найдено {detail.match_summary.unmatched},
              пропущено {detail.match_summary.skipped}.
            </p>
          </div>
          {editable ? (
            <button
              type="button"
              disabled={busy || pending > 0}
              onClick={() => void handleCommit()}
              className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${focusRing}`}
            >
              {busy ? "Сохранение..." : committed ? "Обновить импорт" : "Подтвердить импорт"}
            </button>
          ) : (
            <p className="text-sm text-amber-800">Себестоимость закрыта — документ только для чтения.</p>
          )}
        </div>

        {info ? <p className="mt-3 text-sm text-neutral-600">{info}</p> : null}
        {error ? (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        {ignored.length > 0 ? (
          <details className="mt-3 text-sm text-neutral-600">
            <summary className="cursor-pointer">Пропущенные строки разбора ({ignored.length})</summary>
            <ul className="mt-2 list-disc pl-5">
              {ignored.map((row, index) => (
                <li key={`${row.rowNumber ?? index}-${row.reason ?? ""}`}>
                  стр. {row.rowNumber}: {row.reason}
                  {row.preview ? ` — ${row.preview}` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {detail.rows.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">Нет распознанных товарных строк.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[1280px] w-full text-left text-xs">
              <thead className="border-b border-neutral-200 text-[11px] uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-2 py-2">Стр.</th>
                  <th className="px-2 py-2">OWN CODE</th>
                  <th className="px-2 py-2">Код поставщика</th>
                  <th className="px-2 py-2">Товар из документа</th>
                  <th className="px-2 py-2">Спецификация</th>
                  <th className="px-2 py-2 text-right">Кол-во</th>
                  <th className="px-2 py-2">Ед.</th>
                  <th className="px-2 py-2 text-right">Цена</th>
                  <th className="px-2 py-2 text-right">Сумма</th>
                  <th className="px-2 py-2">Товар DEKORO</th>
                  <th className="px-2 py-2">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {detail.rows.map((row) => (
                  <DocumentRow
                    key={row.id}
                    row={row}
                    supplyCnyRate={getSupplyFxRate(
                      fxRates,
                      "CNY",
                      supplyHeader
                        ? {
                            currency: supplyHeader.default_currency,
                            rate: supplyHeader.default_exchange_rate_to_kzt,
                          }
                        : null,
                    )}
                    editable={editable}
                    busy={busy}
                    picking={pickRowId === row.id}
                    drafting={draftRowId === row.id}
                    onPickOpen={() => {
                      setDraftRowId(null);
                      setPickRowId(row.id);
                    }}
                    onDraftOpen={() => {
                      setPickRowId(null);
                      setDraftRowId(row.id);
                    }}
                    onCloseMenus={() => {
                      setPickRowId(null);
                      setDraftRowId(null);
                    }}
                    onSkip={() => void applyPatch({ rowId: row.id, skip: true })}
                    onUnskip={() => void applyPatch({ rowId: row.id, skip: false, clearMatch: true })}
                    onSaveValues={(patch) => void applyPatch({ rowId: row.id, ...patch })}
                    onSelectProduct={(productId) =>
                      void applyPatch({ rowId: row.id, matchedProductId: productId })
                    }
                    onCreated={(next) => {
                      setDetail(next);
                      setDraftRowId(null);
                    }}
                    onError={setError}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function BackLink({ supplyId }: { supplyId: string }) {
  return (
    <Link
      href={`/staff/supplies/${supplyId}`}
      className={`text-sm text-[#0F766E] hover:underline ${focusRing}`}
    >
      ← К поставке
    </Link>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="mt-0.5 text-neutral-800">{value}</dd>
    </div>
  );
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function DocumentRow({
  row,
  supplyCnyRate,
  editable,
  busy,
  picking,
  drafting,
  onPickOpen,
  onDraftOpen,
  onCloseMenus,
  onSkip,
  onUnskip,
  onSaveValues,
  onSelectProduct,
  onCreated,
  onError,
}: {
  row: SupplyDocumentParsedRow;
  supplyCnyRate: number | null;
  editable: boolean;
  busy: boolean;
  picking: boolean;
  drafting: boolean;
  onPickOpen: () => void;
  onDraftOpen: () => void;
  onCloseMenus: () => void;
  onSkip: () => void;
  onUnskip: () => void;
  onSaveValues: (patch: { quantity?: number; price?: number; unit?: string; specification?: string }) => void;
  onSelectProduct: (productId: string) => void;
  onCreated: (detail: SupplyDocumentDetail) => void;
  onError: (message: string | null) => void;
}) {
  const skipped = row.match_status === "skipped";
  const matched =
    (row.match_status === "auto_match" || row.match_status === "manual_match") && row.matched_product_id;

  return (
    <tr className={`align-top ${skipped ? "bg-neutral-50 text-neutral-400" : "bg-white"}`}>
      <td className="px-2 py-2 tabular-nums">{row.source_row_number}</td>
      <td className="px-2 py-2 font-medium text-neutral-800">{row.own_code ?? "—"}</td>
      <td className="px-2 py-2">{row.supplier_code ?? "—"}</td>
      <td className="px-2 py-2">
        {row.product_name ?? "—"}
        {row.source_name && row.source_name !== row.product_name ? (
          <p className="text-[11px] text-neutral-400">в файле: {row.source_name}</p>
        ) : null}
      </td>
      <td className="px-2 py-2">
        {editable && !skipped ? (
          <BlurInput
            value={row.specification ?? ""}
            disabled={busy}
            onCommit={(value) => onSaveValues({ specification: value })}
          />
        ) : (
          row.specification ?? "—"
        )}
        {row.source_spec && row.source_spec !== row.specification ? (
          <p className="text-[11px] text-neutral-400">в файле: {row.source_spec}</p>
        ) : null}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {editable && !skipped ? (
          <BlurInput
            value={row.quantity == null ? "" : String(row.quantity)}
            disabled={busy}
            className="text-right"
            onCommit={(value) => {
              const n = Number(value.replace(",", "."));
              if (!Number.isFinite(n) || n <= 0) return;
              onSaveValues({ quantity: n });
            }}
          />
        ) : (
          (row.quantity ?? "—")
        )}
        {row.source_quantity != null && row.source_quantity !== row.quantity ? (
          <p className="text-[11px] text-neutral-400">в файле: {row.source_quantity}</p>
        ) : null}
      </td>
      <td className="px-2 py-2">
        {editable && !skipped ? (
          <BlurInput
            value={row.unit ?? ""}
            disabled={busy}
            onCommit={(value) => onSaveValues({ unit: value })}
          />
        ) : (
          row.unit ?? "—"
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {editable && !skipped ? (
          <BlurInput
            value={row.price == null ? "" : String(row.price)}
            disabled={busy}
            className="text-right"
            onCommit={(value) => {
              const n = Number(value.replace(",", "."));
              if (!Number.isFinite(n) || n < 0) return;
              onSaveValues({ price: n });
            }}
          />
        ) : (
          (row.price == null ? "—" : `${row.price} ¥`)
        )}
        {row.price != null ? (
          <p className="text-[11px] text-neutral-400">
            {supplyCnyRate == null
              ? "Курс CNY не задан"
              : `≈ ${formatSupplyMoney(row.price * supplyCnyRate)} по курсу ${formatSupplyRate(supplyCnyRate)}`}
          </p>
        ) : null}
        {row.source_price != null && row.source_price !== row.price ? (
          <p className="text-[11px] text-neutral-400">в файле: {row.source_price}</p>
        ) : null}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{row.amount ?? "—"}</td>
      <td className="px-2 py-2">
        {matched ? (
          <div>
            <p className="font-medium text-neutral-800">
              {row.matched_sku} {row.matched_name}
            </p>
            <p className="text-[11px] text-neutral-500">
              {productContext({
                category_name: row.matched_category_name,
                subcategory_name: row.matched_subcategory_name,
                dimensions: row.matched_dimensions,
                original_sku: row.matched_original_sku,
              })}
            </p>
          </div>
        ) : skipped ? (
          <p>Пропущена</p>
        ) : (
          <Candidates
            candidates={row.match_candidates}
            onSelect={onSelectProduct}
            disabled={!editable || busy}
          />
        )}
        {picking ? (
          <ProductPickPanel
            onPick={(product) => onSelectProduct(product.id)}
            onClose={onCloseMenus}
          />
        ) : null}
        {drafting ? (
          <CreateDraftPanel
            row={row}
            onCreated={onCreated}
            onClose={onCloseMenus}
            onError={onError}
          />
        ) : null}
      </td>
      <td className="px-2 py-2">
        <p className={statusClass(row.match_status)}>
          {row.match_status === "manual_match" && row.matched_sku
            ? `Сопоставлено вручную → ${row.matched_sku} ${row.matched_name ?? ""}`.trim()
            : row.match_status === "auto_match" && row.matched_sku
              ? `Сопоставлено автоматически → ${row.matched_sku} ${row.matched_name ?? ""}`.trim()
              : SUPPLY_DOCUMENT_ROW_MATCH_LABELS[row.match_status]}
        </p>
        {editable ? (
          <div className="mt-2 flex flex-col items-start gap-1">
            {!skipped ? (
              <button
                type="button"
                className={`text-[11px] text-[#0F766E] hover:underline ${focusRing}`}
                onClick={onPickOpen}
              >
                {matched ? "Изменить выбор" : "Выбрать товар"}
              </button>
            ) : null}
            {!skipped && !matched ? (
              <button
                type="button"
                className={`text-[11px] text-[#0F766E] hover:underline ${focusRing}`}
                onClick={onDraftOpen}
              >
                Создать новый товар
              </button>
            ) : null}
            {skipped ? (
              <button
                type="button"
                className={`text-[11px] text-[#0F766E] hover:underline ${focusRing}`}
                onClick={onUnskip}
              >
                Вернуть строку
              </button>
            ) : (
              <button
                type="button"
                className={`text-[11px] text-neutral-500 hover:underline ${focusRing}`}
                onClick={onSkip}
              >
                Пропустить
              </button>
            )}
          </div>
        ) : null}
        {row.source_issues.length > 0 ? (
          <p className="mt-1 text-[11px] text-amber-700">{row.source_issues.join("; ")}</p>
        ) : null}
      </td>
    </tr>
  );
}

function statusClass(status: SupplyDocumentParsedRow["match_status"]): string {
  if (status === "manual_match" || status === "auto_match") return "text-emerald-700";
  if (status === "needs_selection") return "text-amber-800";
  if (status === "unmatched") return "text-red-700";
  return "text-neutral-500";
}

function Candidates({
  candidates,
  onSelect,
  disabled,
}: {
  candidates: SupplyDocumentProductCandidate[];
  onSelect: (productId: string) => void;
  disabled: boolean;
}) {
  if (candidates.length === 0) return <p className="text-neutral-500">Нет автоматических вариантов</p>;
  return (
    <ul className="flex flex-col gap-1">
      {candidates.map((candidate) => (
        <li key={candidate.product_id}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(candidate.product_id)}
            className={`w-full rounded px-1 py-1 text-left hover:bg-neutral-50 disabled:opacity-50 ${focusRing}`}
          >
            <span className="font-medium">
              {candidate.sku} — {candidate.name}
            </span>
            <span className="block text-[11px] text-neutral-500">
              {productContext({
                category_name: candidate.category_name,
                subcategory_name: candidate.subcategory_name,
                dimensions: candidate.dimensions,
                original_sku: candidate.original_sku,
              })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProductPickPanel({
  onPick,
  onClose,
}: {
  onPick: (product: ProductSupplyProductSearch) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ProductSupplyProductSearch[]>([]);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    try {
      setRows(await searchProductsForSupply(q, 20));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-2">
      <div className="flex gap-1">
        <input
          className={inputClass}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
          placeholder="SKU, original_sku или название"
        />
        <button type="button" onClick={() => void search()} className={`px-2 text-xs text-[#0F766E] ${focusRing}`}>
          {busy ? "..." : "Найти"}
        </button>
        <button type="button" onClick={onClose} className={`px-2 text-xs text-neutral-500 ${focusRing}`}>
          Закрыть
        </button>
      </div>
      <ul className="mt-1 max-h-40 overflow-y-auto">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onPick(row)}
              className={`w-full px-1 py-1 text-left hover:bg-white ${focusRing}`}
            >
              <span className="font-medium">
                {row.sku} — {row.name}{" "}
                <FactoryCatalogMarkers catalogs={row.factory_catalogs} />
              </span>
              <span className="block text-[11px] text-neutral-500">
                {productContext({
                  category_name: row.category_name,
                  subcategory_name: row.subcategory_name,
                  dimensions: row.dimensions,
                  original_sku: row.original_sku,
                })}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateDraftPanel({
  row,
  onCreated,
  onClose,
  onError,
}: {
  row: SupplyDocumentParsedRow;
  onCreated: (detail: SupplyDocumentDetail) => void;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const [sku, setSku] = useState(row.own_code ?? "");
  const [name, setName] = useState(row.product_name ?? "");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!sku.trim() || !name.trim()) {
      onError("Для нового товара нужны артикул и название");
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const next = await createDraftForSupplyDocumentRow({
        rowId: row.id,
        sku: sku.trim(),
        name: name.trim(),
        unit: row.unit,
        originalSku: row.supplier_code,
      });
      onCreated(next);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : "Не удалось создать товар");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 grid gap-1 rounded-md border border-neutral-200 bg-neutral-50 p-2">
      <input className={inputClass} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" />
      <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" />
      <p className="text-[11px] text-amber-800">
        Если артикул уже есть в каталоге, создайте другой SKU — глобальный UNIQUE на products.sku не снимается.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void create()}
          className={`text-[11px] text-[#0F766E] ${focusRing}`}
        >
          {busy ? "Создание..." : "Создать и сопоставить"}
        </button>
        <button type="button" onClick={onClose} className={`text-[11px] text-neutral-500 ${focusRing}`}>
          Отмена
        </button>
      </div>
    </div>
  );
}

function BlurInput({
  value,
  onCommit,
  disabled,
  className = "",
}: {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  return (
    <input
      className={`${inputClass} ${className}`}
      value={text}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft ?? value;
        setDraft(null);
        if (next !== value) onCommit(next);
      }}
    />
  );
}
