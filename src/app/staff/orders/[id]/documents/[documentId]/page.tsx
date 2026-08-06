"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getStaffDocument,
  printStaffOrderDocument,
} from "@/lib/staff/documents";
import type { StaffOrderDocumentDetails } from "@/lib/staff/documents";
import { formatPrice } from "@/lib/formatPrice";
import { amountInWordsKzt } from "@/lib/pdf/amountInWordsKzt";
import {
  ORDER_DOCUMENT_STATUS_LABELS,
  ORDER_DOCUMENT_TYPE_LABELS,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

/**
 * Document view page — HTML preview of immutable metadata + PDF print.
 * Security: staff_get_document(order_id, document_id) rejects cross-order IDs.
 */
export default function StaffDocumentViewPage() {
  const params = useParams<{ id: string; documentId: string }>();
  const orderId = params.id;
  const documentId = params.documentId;

  const [document, setDocument] = useState<StaffOrderDocumentDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [printBusy, setPrintBusy] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    getStaffDocument(orderId, documentId)
      .then((result) => {
        if (ignore) {
          return;
        }
        if (!result) {
          setDocument(null);
          setLoadError("Документ не найден или не принадлежит этому заказу");
          return;
        }
        if (result.order_id !== orderId) {
          setDocument(null);
          setLoadError("Документ не принадлежит этому заказу");
          return;
        }
        setDocument(result);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить документ");
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [documentId, orderId]);

  async function handlePrint() {
    if (printBusy) {
      return;
    }
    setPrintBusy(true);
    setPrintError(null);
    try {
      const result = await printStaffOrderDocument(orderId, documentId);
      setDocument((prev) =>
        prev
          ? {
              ...prev,
              printed_at: result.document.printed_at,
              printed_by: result.document.printed_by,
            }
          : prev,
      );
    } catch (error: unknown) {
      setPrintError(error instanceof Error ? error.message : "Не удалось сформировать PDF");
    } finally {
      setPrintBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <p className="text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (loadError || !document) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Документ недоступен</h1>
        <p className="mt-4 text-red-600" role="alert">
          {loadError ?? "Нет данных"}
        </p>
        <Link
          href={`/staff/orders/${orderId}`}
          className={`mt-6 inline-block text-sm font-medium text-[#0F766E] ${focusRing}`}
        >
          ← К заказу
        </Link>
      </div>
    );
  }

  const buyer = document.metadata.buyer ?? {};
  const supplier = document.metadata.supplier ?? {};
  const totals = document.metadata.totals ?? {};
  const basis = document.metadata.basis ?? {};
  const items = document.metadata.items ?? [];
  const documentNumber = String(document.metadata.document_number ?? "").trim();
  const taxMode = String(totals.tax_mode ?? "");
  const taxLabel = String(totals.tax_label ?? "");
  const vatRate = totals.vat_rate != null ? Number(totals.vat_rate) : null;
  const vatAmount = totals.vat_amount != null ? Number(totals.vat_amount) : null;
  const amountWithoutVat =
    totals.amount_without_vat != null
      ? Number(totals.amount_without_vat)
      : totals.subtotal != null
        ? Number(totals.subtotal)
        : null;
  const finalTotal =
    totals.final_total != null
      ? Number(totals.final_total)
      : totals.total != null
        ? Number(totals.total)
        : null;
  let amountWords = String(totals.amount_in_words ?? "").trim();
  if (!amountWords && finalTotal != null) {
    try {
      amountWords = amountInWordsKzt(finalTotal);
    } catch {
      amountWords = "";
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={`/staff/orders/${orderId}`}
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
      >
        ← К заказу
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">
            {ORDER_DOCUMENT_TYPE_LABELS[document.document_type]}{" "}
            {documentNumber || "—"}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {ORDER_DOCUMENT_STATUS_LABELS[document.status]} ·{" "}
            {new Date(document.generated_at).toLocaleString("ru-RU")}
          </p>
          <p className="mt-1 text-sm text-neutral-600">
            Основание: {String(basis.label ?? `Заказ ${String(basis.order_number ?? "")}`)}
            {basis.contract_label
              ? ` · ${String(basis.contract_label)}`
              : ""}
          </p>
          {document.metadata.invoice_template && (
            <p className="mt-1 text-sm text-neutral-500">
              Шаблон счёта:{" "}
              {document.metadata.invoice_template === "company"
                ? "юридическое лицо"
                : "физическое лицо"}
            </p>
          )}
          {document.printed_at && (
            <p className="mt-1 text-sm text-neutral-500">
              Первая печать: {new Date(document.printed_at).toLocaleString("ru-RU")}
              {document.printed_by_name ? ` · ${document.printed_by_name}` : ""}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={printBusy}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
          >
            {printBusy ? "Формирование PDF..." : "Печать"}
          </button>
        </div>
      </div>

      {printError && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {printError}
        </p>
      )}

      <p className="mt-4 text-sm text-neutral-500">
        Данные из неизменяемого snapshot metadata. Live orders/customers не используются.
      </p>

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Поставщик</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-neutral-400">Юр. название</dt>
            <dd className="text-neutral-800">{String(supplier.legal_name ?? "—")}</dd>
          </div>
          <div>
            <dt className="text-neutral-400">БИН</dt>
            <dd className="text-neutral-800">{String(supplier.bin ?? "—")}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-neutral-400">Адрес</dt>
            <dd className="text-neutral-800">{String(supplier.address ?? "—")}</dd>
          </div>
          <div>
            <dt className="text-neutral-400">Телефон</dt>
            <dd className="text-neutral-800">{String(supplier.phone ?? "—")}</dd>
          </div>
          <div>
            <dt className="text-neutral-400">Директор</dt>
            <dd className="text-neutral-800">{String(supplier.director_name ?? "—")}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Покупатель</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          {String(buyer.customer_type ?? "") === "individual" ? (
            <>
              <div>
                <dt className="text-neutral-400">ФИО</dt>
                <dd className="text-neutral-800">
                  {String(buyer.display_name ?? buyer.legal_name ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">Телефон</dt>
                <dd className="text-neutral-800">{String(buyer.phone ?? "—")}</dd>
              </div>
              <div>
                <dt className="text-neutral-400">Email</dt>
                <dd className="text-neutral-800">{String(buyer.email ?? "—")}</dd>
              </div>
            </>
          ) : String(buyer.customer_type ?? "") === "company" ? (
            <>
              <div>
                <dt className="text-neutral-400">Компания</dt>
                <dd className="text-neutral-800">
                  {String(buyer.legal_name ?? buyer.display_name ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">БИН</dt>
                <dd className="text-neutral-800">
                  {String(buyer.bin ?? buyer.iin_bin ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">Контактное лицо</dt>
                <dd className="text-neutral-800">
                  {String(buyer.contact_person ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">Телефон</dt>
                <dd className="text-neutral-800">{String(buyer.phone ?? "—")}</dd>
              </div>
              <div>
                <dt className="text-neutral-400">Email</dt>
                <dd className="text-neutral-800">{String(buyer.email ?? "—")}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-neutral-400">Юридический адрес</dt>
                <dd className="text-neutral-800">{String(buyer.address ?? "—")}</dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt className="text-neutral-400">Название</dt>
                <dd className="text-neutral-800">
                  {String(buyer.legal_name ?? buyer.display_name ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">ИИН/БИН</dt>
                <dd className="text-neutral-800">
                  {String(buyer.bin ?? buyer.iin ?? buyer.iin_bin ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">Контакт</dt>
                <dd className="text-neutral-800">
                  {String(buyer.contact_person ?? "—")}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-400">Телефон</dt>
                <dd className="text-neutral-800">{String(buyer.phone ?? "—")}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-neutral-400">Адрес</dt>
                <dd className="text-neutral-800">{String(buyer.address ?? "—")}</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      {document.document_type === "invoice" && document.metadata.payment_profile && (
        <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">
            Реквизиты для оплаты
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {document.metadata.payment_profile.id != null && (
              <div className="sm:col-span-2">
                <dt className="text-neutral-400">ID профиля (snapshot)</dt>
                <dd className="font-mono text-xs text-neutral-600">
                  {String(document.metadata.payment_profile.id)}
                </dd>
              </div>
            )}
            <div className="sm:col-span-2">
              <dt className="text-neutral-400">Получатель</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.beneficiary_name ?? "—")}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-400">ИИН/БИН</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.bin_iin ?? "—")}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-400">КНП</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.payment_purpose_code ?? "—")}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-neutral-400">Банк</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.bank_name ?? "—")}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-400">БИК</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.bank_bik ?? "—")}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-400">КБе</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.bank_kbe ?? "—")}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-neutral-400">ИИК</dt>
              <dd className="text-neutral-800">
                {String(document.metadata.payment_profile.bank_iik ?? "—")}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="mt-4 overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <th className="px-4 py-3">№</th>
              <th className="px-4 py-3">Товар</th>
              <th className="px-4 py-3">Ед.</th>
              <th className="px-4 py-3 text-right">Кол-во</th>
              <th className="px-4 py-3 text-right">Цена</th>
              <th className="px-4 py-3 text-right">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.order_item_id} className="border-b border-neutral-100 last:border-0">
                <td className="px-4 py-3 text-neutral-500">{item.line_no}</td>
                <td className="px-4 py-3 text-neutral-800">
                  <p className="font-medium">{item.product_name}</p>
                  {item.product_sku && (
                    <p className="text-xs text-neutral-400">{item.product_sku}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-neutral-600">{item.unit}</td>
                <td className="px-4 py-3 text-right text-neutral-800">{item.quantity}</td>
                <td className="px-4 py-3 text-right text-neutral-800">
                  {formatPrice(Number(item.unit_price))}
                </td>
                <td className="px-4 py-3 text-right font-medium text-neutral-800">
                  {formatPrice(Number(item.line_total))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-neutral-200 px-4 py-3 text-right text-sm">
          <p className="mb-2 text-left text-xs text-neutral-400">
            Цены заказа — без НДС. При режиме «С НДС» налог начисляется сверху.
          </p>
          {taxMode === "without_vat" ? (
            <p className="mt-1 text-lg font-semibold text-neutral-800">
              Итого: {formatPrice(finalTotal ?? 0)} {String(totals.currency ?? "KZT")}
            </p>
          ) : (
            <>
              <p className="text-neutral-500">
                Стоимость товаров:{" "}
                {formatPrice(amountWithoutVat ?? Number(totals.subtotal ?? 0))}
              </p>
              <p className="text-neutral-500">
                НДС{vatRate != null ? ` (${vatRate}%)` : ""}:{" "}
                {vatAmount != null ? formatPrice(vatAmount) : "—"}
              </p>
              <p className="mt-1 text-lg font-semibold text-neutral-800">
                Итого к оплате: {formatPrice(finalTotal ?? 0)}{" "}
                {String(totals.currency ?? "KZT")}
              </p>
            </>
          )}
          {taxLabel && (
            <p className="mt-1 text-xs text-neutral-400">{taxLabel}</p>
          )}
          {amountWords && (
            <p className="mt-2 text-left text-sm text-neutral-600">
              Всего к оплате: {amountWords}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
