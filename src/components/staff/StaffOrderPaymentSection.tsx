"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import {
  confirmStaffOrderPayment,
  getStaffOrderPaymentClaim,
  getStaffOrderPaymentSummary,
  listStaffOrderPayments,
  recordStaffOrderPayment,
  reverseStaffOrderPayment,
} from "@/lib/staff/payments";
import { getOrganizationAssetSignedUrl } from "@/lib/staff/organizationAssets";
import { changeStaffOrderStatus } from "@/lib/staff/orders";
import type {
  StaffConfirmPaymentMethod,
  StaffOrderPaymentClaim,
  StaffOrderPaymentItem,
  StaffOrderPaymentSummary,
  UserRole,
} from "@/types/database";
import {
  ORDER_PAYMENT_METHOD_LABELS,
  ORDER_PAYMENT_METHODS,
  ORDER_PAYMENT_RECORD_STATUS_LABELS,
  ORDER_PAYMENT_STATUS_LABELS,
  STAFF_CONFIRM_PAYMENT_METHODS,
  canReverseOrderPayments,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function todayIsoDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Props = {
  orderId: string;
  orderStatus: string;
  role: UserRole | null | undefined;
  canManageWorkflow: boolean;
  onOrderStatusChanged: () => void | Promise<void>;
};

export default function StaffOrderPaymentSection({
  orderId,
  orderStatus,
  role,
  canManageWorkflow,
  onOrderStatusChanged,
}: Props) {
  const canReverse = canReverseOrderPayments(role);

  const [summary, setSummary] = useState<StaffOrderPaymentSummary | null>(null);
  const [payments, setPayments] = useState<StaffOrderPaymentItem[]>([]);
  const [claim, setClaim] = useState<StaffOrderPaymentClaim | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrLoadedFor, setQrLoadedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [amountDraft, setAmountDraft] = useState("");
  const [dateDraft, setDateDraft] = useState(todayIsoDate());
  const [methodDraft, setMethodDraft] = useState<StaffConfirmPaymentMethod>("bank_transfer");
  const [referenceDraft, setReferenceDraft] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [reverseId, setReverseId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);

  const [confirmPaidBusy, setConfirmPaidBusy] = useState(false);
  const [confirmPaidError, setConfirmPaidError] = useState<string | null>(null);

  const currentKey = `${orderId}:${reloadToken}`;
  const loading = loadedKey !== currentKey;

  useEffect(() => {
    if (loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    Promise.all([
      getStaffOrderPaymentSummary(orderId),
      listStaffOrderPayments(orderId),
      getStaffOrderPaymentClaim(orderId),
    ])
      .then(([s, list, claimRow]) => {
        if (ignore) {
          return;
        }
        setSummary(s);
        setPayments(list);
        setClaim(claimRow);
        setLoadError(null);
        setLoadedKey(currentKey);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить оплаты",
        );
        setLoadedKey(currentKey);
      });

    return () => {
      ignore = true;
    };
  }, [orderId, currentKey, loadedKey]);

  const kaspiPath = claim?.kaspi_qr_path ?? null;

  useEffect(() => {
    if (!kaspiPath) {
      return;
    }
    let ignore = false;
    getOrganizationAssetSignedUrl(kaspiPath)
      .then((url) => {
        if (ignore) return;
        setQrUrl(url);
        setQrLoadedFor(kaspiPath);
      })
      .catch(() => {
        if (ignore) return;
        setQrUrl(null);
        setQrLoadedFor(kaspiPath);
      });
    return () => {
      ignore = true;
    };
  }, [kaspiPath]);

  function requestReload() {
    setReloadToken((token) => token + 1);
  }

  const parsedAmount = Number(amountDraft.replace(",", "."));
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const remainingAfter =
    summary && amountValid ? summary.amount_remaining - parsedAmount : null;

  function openModal() {
    setAmountDraft(
      summary && summary.amount_remaining > 0
        ? String(summary.amount_remaining)
        : "",
    );
    setDateDraft(todayIsoDate());
    setMethodDraft("bank_transfer");
    setReferenceDraft("");
    setCommentDraft("");
    setSaveError(null);
    setModalOpen(true);
  }

  async function handleRecordPayment(event: React.FormEvent) {
    event.preventDefault();
    if (!summary || saveBusy || !amountValid) {
      return;
    }

    setSaveBusy(true);
    setSaveError(null);
    try {
      if (canManageWorkflow) {
        await confirmStaffOrderPayment({
          orderId,
          amount: parsedAmount,
          paymentDate: dateDraft,
          paymentMethod: methodDraft,
          referenceNumber: referenceDraft,
          comment: commentDraft,
        });
        setModalOpen(false);
        await onOrderStatusChanged();
        requestReload();
      } else {
        if (methodDraft === "kaspi") {
          throw new Error("Kaspi доступен только при подтверждении менеджером");
        }
        await recordStaffOrderPayment({
          orderId,
          amount: parsedAmount,
          paymentDate: dateDraft,
          paymentMethod: methodDraft,
          referenceNumber: referenceDraft,
          comment: commentDraft,
        });
        setModalOpen(false);
        requestReload();
      }
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Не удалось сохранить оплату",
      );
    } finally {
      setSaveBusy(false);
    }
  }

  async function handleReverse(event: React.FormEvent) {
    event.preventDefault();
    if (!reverseId || reverseBusy || !reverseReason.trim()) {
      return;
    }

    setReverseBusy(true);
    setReverseError(null);
    try {
      await reverseStaffOrderPayment(reverseId, reverseReason.trim());
      setReverseId(null);
      setReverseReason("");
      requestReload();
    } catch (error) {
      setReverseError(
        error instanceof Error ? error.message : "Не удалось сторнировать",
      );
    } finally {
      setReverseBusy(false);
    }
  }

  async function handleConfirmPaid() {
    if (!canManageWorkflow || confirmPaidBusy || !summary) {
      return;
    }
    if (summary.payment_status !== "paid" || orderStatus !== "awaiting_payment") {
      return;
    }

    setConfirmPaidBusy(true);
    setConfirmPaidError(null);
    try {
      await changeStaffOrderStatus(orderId, "paid");
      await onOrderStatusChanged();
      requestReload();
    } catch (error) {
      setConfirmPaidError(
        error instanceof Error ? error.message : "Не удалось перевести статус",
      );
    } finally {
      setConfirmPaidBusy(false);
    }
  }

  if (loading && !summary) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
        <p className="mt-3 text-sm text-neutral-500">Загрузка...</p>
      </section>
    );
  }

  if ((loadError || !summary) && !loading) {
    return (
      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
        <p className="mt-3 text-sm text-red-600" role="alert">
          {loadError ?? "Нет данных"}
        </p>
        <button
          type="button"
          onClick={() => {
            setLoadError(null);
            requestReload();
          }}
          className={`mt-3 rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          Повторить
        </button>
      </section>
    );
  }

  if (!summary) {
    return null;
  }

  const canMarkPaid =
    canManageWorkflow &&
    orderStatus === "awaiting_payment" &&
    summary.payment_status === "paid" &&
    summary.amount_due > 0;

  const claimReported = claim?.status === "reported" && claim.created_at != null;

  const confirmedPayment = claim?.confirmed_payment_id
    ? payments.find((item) => item.id === claim.confirmed_payment_id)
    : undefined;

  const sourceLabel = summary.obligation_frozen
    ? summary.obligation_source_type === "invoice" && summary.obligation_source_number
      ? `Зафиксировано по счёту ${summary.obligation_source_number}`
      : "Зафиксировано по сумме заказа"
    : summary.invoice_number
      ? `По счёту ${summary.invoice_number}`
      : "По сумме заказа — счёт ещё не создан";

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
          <p className="mt-1 text-sm text-neutral-500">{sourceLabel}</p>
        </div>
        {orderStatus === "awaiting_payment" &&
          summary.amount_remaining > 0 &&
          canManageWorkflow && (
          <button
            type="button"
            onClick={openModal}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
          >
            Подтвердить оплату
          </button>
        )}
        {orderStatus !== "cancelled" && summary.amount_remaining > 0 && !canManageWorkflow && (
          <button
            type="button"
            onClick={openModal}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
          >
            Добавить оплату
          </button>
        )}
      </div>

      {orderStatus === "new" && !summary.invoice_number && canManageWorkflow && (
        <div
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="status"
        >
          Не удалось автоматически сформировать счёт. Сформируйте счёт вручную и
          переведите заказ в «Ожидает оплаты».
        </div>
      )}

      {summary.has_payment_shortfall && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          Оплата сторнирована, заказ недофинансирован. Статус заказа не откатан
          автоматически — требуется решение администратора.
        </div>
      )}

      <dl className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            К оплате
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(summary.amount_due)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Оплачено
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(summary.amount_paid)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Осталось
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(Math.max(summary.amount_remaining, 0))}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Статус
          </dt>
          <dd className="mt-1 text-lg font-semibold text-neutral-900">
            {claimReported
              ? "Клиент сообщил об оплате"
              : ORDER_PAYMENT_STATUS_LABELS[summary.payment_status]}
          </dd>
          {claimReported && claim?.created_at && (
            <p className="mt-1 text-sm text-neutral-500">
              {new Date(claim.created_at).toLocaleString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
        </div>
      </dl>

      {claimReported && canManageWorkflow && (
        <p className="mt-4 text-sm text-neutral-600">
          Проверьте поступление вне платформы (банк / Kaspi), затем подтвердите
          фактическую сумму кнопкой «Подтвердить оплату».
        </p>
      )}
      {claimReported && !canManageWorkflow && (
        <p className="mt-4 text-sm text-neutral-600">
          Клиент сообщил об оплате. Регистрация суммы — через «Добавить оплату».
          Перевод заказа в «Оплачен» выполняет менеджер или администратор.
        </p>
      )}

      {claim?.status === "confirmed" && (
        <p className="mt-4 text-sm text-neutral-600">
          Сообщение клиента подтверждено
          {claim.resolved_by_name ? ` · ${claim.resolved_by_name}` : ""}
          {claim.resolved_at
            ? ` · ${new Date(claim.resolved_at).toLocaleString("ru-RU")}`
            : ""}
          {confirmedPayment
            ? ` · ${formatPrice(confirmedPayment.amount)}`
            : ""}
          {claim.confirmed_payment_id
            ? ` · платёж ${claim.confirmed_payment_id.slice(0, 8)}`
            : ""}
        </p>
      )}

      {canMarkPaid && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void handleConfirmPaid()}
            disabled={confirmPaidBusy}
            className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
          >
            {confirmPaidBusy ? "Перевод..." : "Перевести в Оплачен"}
          </button>
          {confirmPaidError && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {confirmPaidError}
            </p>
          )}
        </div>
      )}

      {kaspiPath && (
        <div className="mt-5 rounded-md border border-neutral-100 bg-neutral-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Kaspi QR компании
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Постоянный QR. Не подтверждает оплату и не заменяет счёт.
          </p>
          {qrLoadedFor === kaspiPath && qrUrl ? (
            <div className="mt-2 w-24 overflow-hidden rounded border border-neutral-200 bg-white p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrUrl} alt="" className="h-auto w-full object-contain" />
            </div>
          ) : (
            <p className="mt-2 text-xs text-neutral-500">
              {qrLoadedFor === kaspiPath
                ? "Изображение QR сейчас недоступно. Счёт на оплату не затронут."
                : "Загрузка QR…"}
            </p>
          )}
        </div>
      )}

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-neutral-800">История платежей</h3>
        {payments.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Платежей пока нет</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-100">
            {payments.map((payment) => (
              <li key={payment.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium text-neutral-800">
                    {formatPrice(payment.amount)} ·{" "}
                    {ORDER_PAYMENT_METHOD_LABELS[payment.payment_method]}
                  </p>
                  <span
                    className={
                      payment.status === "reversed"
                        ? "text-xs font-medium text-red-600"
                        : "text-xs font-medium text-neutral-500"
                    }
                  >
                    {ORDER_PAYMENT_RECORD_STATUS_LABELS[payment.status]}
                  </span>
                </div>
                <p className="mt-1 text-neutral-500">
                  {new Date(payment.payment_date).toLocaleDateString("ru-RU")}
                  {payment.reference_number
                    ? ` · ${payment.reference_number}`
                    : ""}
                  {" · "}
                  {payment.recorded_by_name ?? "Сотрудник"}
                </p>
                {payment.comment && (
                  <p className="mt-1 text-neutral-600">{payment.comment}</p>
                )}
                {payment.status === "reversed" && payment.reversal_reason && (
                  <p className="mt-1 text-red-700">
                    Сторно: {payment.reversal_reason}
                    {payment.reversed_by_name
                      ? ` (${payment.reversed_by_name})`
                      : ""}
                  </p>
                )}
                {canReverse && payment.status === "confirmed" && (
                  <button
                    type="button"
                    onClick={() => {
                      setReverseId(payment.id);
                      setReverseReason("");
                      setReverseError(null);
                    }}
                    className={`mt-2 text-sm font-medium text-red-600 hover:text-red-800 ${focusRing}`}
                  >
                    Сторнировать
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-dialog-title"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2
              id="payment-dialog-title"
              className="text-lg font-semibold text-neutral-800"
            >
              {canManageWorkflow ? "Подтвердить оплату" : "Добавить оплату"}
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Остаток сейчас: {formatPrice(summary.amount_remaining)}
            </p>
            <form onSubmit={handleRecordPayment} className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">
                  {canManageWorkflow ? "Фактически поступило" : "Сумма"}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountDraft}
                  onChange={(e) => setAmountDraft(e.target.value)}
                  required
                  disabled={saveBusy}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">Дата</span>
                <input
                  type="date"
                  value={dateDraft}
                  onChange={(e) => setDateDraft(e.target.value)}
                  required
                  disabled={saveBusy}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">Способ</span>
                <select
                  value={methodDraft}
                  onChange={(e) =>
                    setMethodDraft(e.target.value as StaffConfirmPaymentMethod)
                  }
                  disabled={saveBusy}
                  className={inputClass}
                >
                  {(canManageWorkflow
                    ? STAFF_CONFIRM_PAYMENT_METHODS
                    : ORDER_PAYMENT_METHODS
                  ).map((method) => (
                    <option key={method} value={method}>
                      {ORDER_PAYMENT_METHOD_LABELS[method]}
                    </option>
                  ))}
                </select>
              </label>
              {!canManageWorkflow && (
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-neutral-700">
                    Номер платёжного документа
                  </span>
                  <input
                    type="text"
                    value={referenceDraft}
                    onChange={(e) => setReferenceDraft(e.target.value)}
                    maxLength={100}
                    disabled={saveBusy}
                    className={inputClass}
                  />
                </label>
              )}
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">
                  Комментарий{canManageWorkflow ? " (необязательно)" : ""}
                </span>
                <textarea
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  rows={2}
                  maxLength={canManageWorkflow ? 993 : 1000}
                  disabled={saveBusy}
                  className={inputClass}
                />
              </label>
              {remainingAfter != null && (
                <p className="text-sm text-neutral-600">
                  Остаток после оплаты:{" "}
                  <span className="font-medium">
                    {formatPrice(Math.max(remainingAfter, 0))}
                  </span>
                  {remainingAfter < 0 && (
                    <span className="text-red-600"> — переплата запрещена</span>
                  )}
                </p>
              )}
              {saveError && (
                <p className="text-sm text-red-600" role="alert">
                  {saveError}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={
                    saveBusy ||
                    !amountValid ||
                    (remainingAfter != null && remainingAfter < 0)
                  }
                  className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
                >
                  {saveBusy
                    ? "Сохранение..."
                    : canManageWorkflow
                      ? "Подтвердить"
                      : "Зарегистрировать"}
                </button>
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  disabled={saveBusy}
                  className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:border-neutral-400 ${focusRing}`}
                >
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {reverseId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reverse-dialog-title"
          onClick={() => setReverseId(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2
              id="reverse-dialog-title"
              className="text-lg font-semibold text-neutral-800"
            >
              Сторнировать оплату
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Запись сохранится. Статус заказа не откатится автоматически.
            </p>
            <form onSubmit={handleReverse} className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">Причина</span>
                <textarea
                  value={reverseReason}
                  onChange={(e) => setReverseReason(e.target.value)}
                  rows={3}
                  required
                  maxLength={1000}
                  disabled={reverseBusy}
                  className={inputClass}
                />
              </label>
              {reverseError && (
                <p className="text-sm text-red-600" role="alert">
                  {reverseError}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={reverseBusy || !reverseReason.trim()}
                  className={`rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:bg-neutral-300 ${focusRing}`}
                >
                  {reverseBusy ? "Сторнирование..." : "Подтвердить сторно"}
                </button>
                <button
                  type="button"
                  onClick={() => setReverseId(null)}
                  disabled={reverseBusy}
                  className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 ${focusRing}`}
                >
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
