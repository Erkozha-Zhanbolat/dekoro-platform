"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import {
  getClientKaspiQrSignedUrl,
  getClientOrderPaymentFlow,
  reportClientOrderPayment,
} from "@/lib/clientPayments";
import { downloadClientOrderDocument } from "@/lib/clientDocuments";
import type { ClientOrderPaymentFlow } from "@/types/database";
import { ORDER_PAYMENT_STATUS_LABELS, type OrderStatus } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

type Props = {
  orderId: string;
  orderStatus: OrderStatus;
};

function formatClaimTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Client payment block (033): invoice (primary) + permanent Kaspi QR + claim.
 * "Я оплатил" is not payment confirmation.
 */
export function ClientOrderPaymentSummaryBlock({ orderId, orderStatus }: Props) {
  const [flow, setFlow] = useState<ClientOrderPaymentFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [qrLoadedFor, setQrLoadedFor] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    getClientOrderPaymentFlow(orderId)
      .then((result) => {
        if (ignore) {
          return;
        }
        setFlow(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) {
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить сводку оплаты",
        );
        setFlow(null);
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [orderId]);

  const qrPath = flow?.kaspi_qr_path ?? null;
  const ledgerPaid = flow?.payment_status === "paid" || flow?.payment_status === "overpaid";
  const orderPaid =
    orderStatus === "paid" ||
    orderStatus === "picking" ||
    orderStatus === "ready_for_shipment" ||
    orderStatus === "shipped" ||
    orderStatus === "completed";
  const showConfirmed = ledgerPaid || orderPaid;
  const awaiting = orderStatus === "awaiting_payment" && !showConfirmed;
  const claimed = awaiting && flow?.claim_status === "reported";
  const showKaspi = awaiting && !showConfirmed;

  useEffect(() => {
    if (!showKaspi || !qrPath) {
      return;
    }

    let ignore = false;
    getClientKaspiQrSignedUrl(qrPath)
      .then((url) => {
        if (ignore) {
          return;
        }
        setQrUrl(url);
        setQrFailed(false);
        setQrLoadedFor(qrPath);
      })
      .catch(() => {
        if (ignore) {
          return;
        }
        setQrUrl(null);
        setQrFailed(true);
        setQrLoadedFor(qrPath);
      });

    return () => {
      ignore = true;
    };
  }, [showKaspi, qrPath]);

  async function handleDownloadInvoice() {
    if (!flow?.invoice_id || downloadBusy) {
      return;
    }
    setDownloadBusy(true);
    setDownloadError(null);
    try {
      await downloadClientOrderDocument(orderId, flow.invoice_id);
    } catch (err: unknown) {
      setDownloadError(
        err instanceof Error ? err.message : "Не удалось скачать счёт",
      );
    } finally {
      setDownloadBusy(false);
    }
  }

  async function handleReportPaid() {
    if (!awaiting || claimed || claimBusy || showConfirmed) {
      return;
    }
    setClaimBusy(true);
    setClaimError(null);
    try {
      const result = await reportClientOrderPayment(orderId);
      setFlow((prev) =>
        prev
          ? {
              ...prev,
              claim_id: result.id,
              claim_status: result.status,
              claim_created_at: result.created_at,
            }
          : prev,
      );
    } catch (err: unknown) {
      setClaimError(
        err instanceof Error ? err.message : "Не удалось отправить сообщение об оплате",
      );
    } finally {
      setClaimBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата заказа</h2>
        <p className="mt-3 text-sm text-neutral-500">Загрузка...</p>
      </section>
    );
  }

  if (error || !flow) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата заказа</h2>
        <p className="mt-3 text-sm text-neutral-500">
          Сводка оплаты временно недоступна.
        </p>
      </section>
    );
  }

  if (showConfirmed) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата заказа</h2>
        <p className="mt-3 text-sm font-medium text-[#0F766E]">✓ Оплата подтверждена</p>
        <p className="mt-1 text-sm text-neutral-500">
          Счёт остаётся доступным в документах заказа.
        </p>
        {flow.invoice_number && (
          <p className="mt-2 text-sm text-neutral-500">Счёт № {flow.invoice_number}</p>
        )}
        {flow.invoice_id && (
          <>
            <button
              type="button"
              onClick={() => void handleDownloadInvoice()}
              disabled={downloadBusy}
              className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 sm:w-auto ${focusRing}`}
            >
              {downloadBusy ? "Скачивание…" : "Скачать счёт на оплату"}
            </button>
            {downloadError && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {downloadError}
              </p>
            )}
          </>
        )}
      </section>
    );
  }

  if (orderStatus === "new") {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата заказа</h2>
        <p className="mt-3 text-sm text-neutral-700">
          Счёт готовится. Менеджер свяжется с вами.
        </p>
        {flow.invoice_id ? (
          <>
            {flow.invoice_number && (
              <p className="mt-2 text-sm text-neutral-500">Счёт № {flow.invoice_number}</p>
            )}
            <button
              type="button"
              onClick={() => void handleDownloadInvoice()}
              disabled={downloadBusy}
              className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 sm:w-auto ${focusRing}`}
            >
              {downloadBusy ? "Скачивание…" : "Скачать счёт на оплату"}
            </button>
            {downloadError && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {downloadError}
              </p>
            )}
          </>
        ) : null}
      </section>
    );
  }

  if (!awaiting) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата заказа</h2>
        {flow.invoice_number && (
          <p className="mt-1 text-sm text-neutral-500">Счёт № {flow.invoice_number}</p>
        )}
        <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              К оплате
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
              {formatPrice(flow.amount_due)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Статус
            </dt>
            <dd className="mt-1 text-lg font-semibold text-neutral-900">
              {ORDER_PAYMENT_STATUS_LABELS[flow.payment_status]}
            </dd>
          </div>
        </dl>
      </section>
    );
  }

  const kaspiReady = Boolean(showKaspi && qrPath && qrLoadedFor === qrPath);
  const kaspiUnavailable = Boolean(showKaspi && (!qrPath || (kaspiReady && qrFailed)));
  const displayQrUrl = kaspiReady && !qrFailed ? qrUrl : null;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-neutral-800">Оплата заказа</h2>

      <div className="mt-5 grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            К оплате
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(flow.amount_remaining > 0 ? flow.amount_remaining : flow.amount_due)}
          </p>
          {flow.invoice_number && (
            <p className="mt-2 text-sm text-neutral-500">Счёт № {flow.invoice_number}</p>
          )}

          {flow.invoice_id ? (
            <button
              type="button"
              onClick={() => void handleDownloadInvoice()}
              disabled={downloadBusy}
              className={`mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 sm:w-auto ${focusRing}`}
            >
              {downloadBusy ? "Скачивание…" : "Скачать счёт на оплату"}
            </button>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              Счёт на оплату ещё формируется. После появления его можно скачать здесь
              и в документах заказа.
            </p>
          )}
          {downloadError && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {downloadError}
            </p>
          )}
        </div>

        <div>
          <p className="text-sm font-semibold text-neutral-800">
            Быстрая оплата через Kaspi
          </p>
          {displayQrUrl ? (
            <>
              <div className="mt-3 flex justify-center md:justify-start">
                <div className="w-40 max-w-[40%] overflow-hidden rounded-md border border-neutral-200 bg-white p-2 sm:w-44 sm:max-w-[11rem]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={displayQrUrl}
                    alt="Kaspi QR для оплаты"
                    className="h-auto w-full object-contain"
                    onError={() => {
                      setQrUrl(null);
                      setQrFailed(true);
                      if (qrPath) setQrLoadedFor(qrPath);
                    }}
                  />
                </div>
              </div>
              <p className="mt-3 text-sm text-neutral-500">
                Отсканируйте QR в приложении Kaspi.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">
              {kaspiUnavailable
                ? "Быстрая оплата через Kaspi временно недоступна."
                : "Загрузка QR…"}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 border-t border-neutral-100 pt-5">
        {claimed ? (
          <div>
            <p className="text-sm font-medium text-[#0F766E]">
              Оплата отправлена на проверку
            </p>
            {flow.claim_created_at && (
              <p className="mt-1 text-sm text-neutral-500">
                {formatClaimTime(flow.claim_created_at)}
              </p>
            )}
            <p className="mt-2 text-sm text-neutral-500">
              После подтверждения менеджером заказ будет передан на сборку.
            </p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-neutral-600">
              После оплаты сообщите менеджеру:
            </p>
            <button
              type="button"
              onClick={() => void handleReportPaid()}
              disabled={claimBusy}
              className={`mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 sm:w-auto ${focusRing}`}
            >
              {claimBusy ? "Отправка…" : "Я оплатил"}
            </button>
            {claimError && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                {claimError}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
