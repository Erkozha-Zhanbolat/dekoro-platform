"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DELIVERY_TYPE_LABELS } from "@/lib/orders";
import {
  addStaffOrderNote,
  assignStaffOrderManager,
  cancelStaffOrder,
  canStaffCancelOrder,
  changeStaffOrderStatus,
  getAllowedStatusTransitions,
  getStaffOrderById,
  getStatusTransitionLabel,
  isDeadlineOverdue,
  listAssignableManagers,
  removeStaffOrderItem,
  updateStaffOrderDeadlines,
  updateStaffOrderItemQuantity,
} from "@/lib/staff/orders";
import type {
  StaffManagerOption,
  StaffOrderDetail,
  StaffOrderDetailItem,
} from "@/lib/staff/orders";
import {
  findOrderDocument,
  generateStaffDeliveryNote,
  generateStaffInvoice,
  listStaffOrderDocuments,
} from "@/lib/staff/documents";
import type { StaffOrderDocumentListItem } from "@/lib/staff/documents";
import { getOrganizationSettings } from "@/lib/staff/organization";
import { formatPrice } from "@/lib/formatPrice";
import {
  canAccessWarehouseOps,
  canEditOrderItems,
  ORDER_DOCUMENT_STATUS_LABELS,
  ORDER_STATUS_LABELS,
  type DocumentTaxMode,
  type OrderDocumentType,
  type OrderStatus,
} from "@/types/database";
import { useProfile } from "@/context/ProfileContext";
import StaffAddOrderItemModal from "@/components/staff/StaffAddOrderItemModal";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const BackToOrdersLink = () => (
  <Link
    href="/staff/orders"
    className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
  >
    ← Назад к заказам
  </Link>
);

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

export default function StaffOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const { profile } = useProfile();

  const [order, setOrder] = useState<StaffOrderDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [isAddItemModalOpen, setIsAddItemModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [managers, setManagers] = useState<StaffManagerOption[]>([]);

  const [managerDraft, setManagerDraft] = useState("");
  const [managerSaving, setManagerSaving] = useState(false);
  const [managerError, setManagerError] = useState<string | null>(null);

  const [paymentDueDraft, setPaymentDueDraft] = useState("");
  const [reservationExpiresDraft, setReservationExpiresDraft] = useState("");
  const [deadlinesSaving, setDeadlinesSaving] = useState(false);
  const [deadlinesError, setDeadlinesError] = useState<string | null>(null);

  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const [documents, setDocuments] = useState<StaffOrderDocumentListItem[]>([]);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [deliveryNoteBusy, setDeliveryNoteBusy] = useState(false);
  const [taxModalDocType, setTaxModalDocType] = useState<OrderDocumentType | null>(null);
  const [taxModeDraft, setTaxModeDraft] = useState<DocumentTaxMode>("without_vat");
  const [contractNumberDraft, setContractNumberDraft] = useState("");
  const [contractDateDraft, setContractDateDraft] = useState("");
  const [orgVatRate, setOrgVatRate] = useState<number | null>(null);
  const [taxModalError, setTaxModalError] = useState<string | null>(null);

  async function refetchDocuments() {
    try {
      const docs = await listStaffOrderDocuments(orderId);
      setDocuments(docs);
      setDocumentsError(null);
    } catch (error) {
      setDocumentsError(
        error instanceof Error ? error.message : "Не удалось загрузить документы",
      );
    }
  }

  async function refetchOrder() {
    try {
      const result = await getStaffOrderById(orderId);
      setOrder(result);
      setNotFound(result === null);
      if (result) {
        setManagerDraft(result.assigned_manager_id ?? "");
        setPaymentDueDraft(toDatetimeLocalValue(result.payment_due_at));
        setReservationExpiresDraft(toDatetimeLocalValue(result.reservation_expires_at));
        await refetchDocuments();
      }
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить заказ");
    }
  }

  useEffect(() => {
    if (loadedId === orderId) {
      return;
    }

    let ignore = false;

    Promise.all([
      getStaffOrderById(orderId),
      listAssignableManagers().catch(() => [] as StaffManagerOption[]),
      listStaffOrderDocuments(orderId).catch(() => [] as StaffOrderDocumentListItem[]),
    ])
      .then(([result, managerOptions, docs]) => {
        if (ignore) {
          return;
        }
        setOrder(result);
        setNotFound(result === null);
        setManagers(managerOptions);
        setDocuments(docs);
        if (result) {
          setManagerDraft(result.assigned_manager_id ?? "");
          setPaymentDueDraft(toDatetimeLocalValue(result.payment_due_at));
          setReservationExpiresDraft(toDatetimeLocalValue(result.reservation_expires_at));
        }
        setLoadError(null);
        setLoadedId(orderId);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setOrder(null);
        setNotFound(false);
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить заказ");
        setLoadedId(orderId);
      });

    return () => {
      ignore = true;
    };
  }, [orderId, loadedId]);

  const loading = loadedId !== orderId;
  const canManageWorkflow = profile?.role === "manager" || profile?.role === "admin";
  const isAdmin = profile?.role === "admin";
  const canManageItems =
    canManageWorkflow && order != null && canEditOrderItems(order.status);
  const canCancel = order != null && canStaffCancelOrder(order.status, profile?.role);
  const transitions = order ? getAllowedStatusTransitions(order.status) : [];
  const fieldsEditable =
    canManageWorkflow && order != null && order.status !== "completed" && order.status !== "cancelled";
  const invoiceDoc = findOrderDocument(documents, "invoice");
  const deliveryNoteDoc = findOrderDocument(documents, "delivery_note");
  const canGenerateInvoice =
    canManageWorkflow && order != null && order.status !== "cancelled" && order.items.length > 0;
  const deliveryNoteAllowedStatuses: OrderStatus[] = [
    "paid",
    "picking",
    "ready_for_shipment",
    "shipped",
    "completed",
  ];
  const canGenerateDeliveryNote =
    canGenerateInvoice && order != null && deliveryNoteAllowedStatuses.includes(order.status);
  const showWarehouseLink =
    canAccessWarehouseOps(profile?.role) &&
    order != null &&
    (order.status === "paid" ||
      order.status === "picking" ||
      order.status === "ready_for_shipment");

  const paymentOverdue =
    order != null &&
    order.status === "awaiting_payment" &&
    isDeadlineOverdue(order.payment_due_at);
  const reservationOverdue =
    order != null &&
    !["shipped", "completed", "cancelled"].includes(order.status) &&
    isDeadlineOverdue(order.reservation_expires_at);

  async function handleStatusChange(nextStatus: OrderStatus) {
    if (!order || actionBusy) {
      return;
    }

    const label = getStatusTransitionLabel(order.status, nextStatus);
    const confirmed = window.confirm(
      `Изменить статус заказа ${order.order_number}?\n\n${ORDER_STATUS_LABELS[order.status]} → ${ORDER_STATUS_LABELS[nextStatus]}\n(${label})`,
    );
    if (!confirmed) {
      return;
    }

    setActionBusy(true);
    setActionError(null);

    try {
      await changeStaffOrderStatus(order.id, nextStatus);
      await refetchOrder();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Не удалось изменить статус");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCancel() {
    if (!order || actionBusy || !canCancel) {
      return;
    }

    const reason = window.prompt(
      `Отменить заказ ${order.order_number}?\nУкажите причину отмены (обязательно):`,
    );
    if (reason === null) {
      return;
    }
    if (!reason.trim()) {
      setActionError("Причина отмены обязательна");
      return;
    }

    setActionBusy(true);
    setActionError(null);

    try {
      await cancelStaffOrder(order.id, reason.trim());
      await refetchOrder();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Не удалось отменить заказ");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleAssignManager() {
    if (!order || !fieldsEditable || managerSaving) {
      return;
    }

    const nextManager = managerDraft.trim();
    if (!isAdmin && nextManager === "") {
      setManagerError("Менеджер не может снять назначение");
      return;
    }
    if (!isAdmin && nextManager !== profile?.id) {
      setManagerError("Менеджер может назначить только себя");
      return;
    }

    setManagerSaving(true);
    setManagerError(null);

    try {
      await assignStaffOrderManager(order.id, nextManager || null);
      await refetchOrder();
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Не удалось назначить");
    } finally {
      setManagerSaving(false);
    }
  }

  async function handleSaveDeadlines() {
    if (!order || !fieldsEditable || deadlinesSaving) {
      return;
    }

    setDeadlinesSaving(true);
    setDeadlinesError(null);

    try {
      await updateStaffOrderDeadlines(
        order.id,
        fromDatetimeLocalValue(paymentDueDraft),
        fromDatetimeLocalValue(reservationExpiresDraft),
      );
      await refetchOrder();
    } catch (error) {
      setDeadlinesError(error instanceof Error ? error.message : "Не удалось сохранить сроки");
    } finally {
      setDeadlinesSaving(false);
    }
  }

  async function handleAddNote() {
    if (!order || !canManageWorkflow || noteSaving) {
      return;
    }

    const body = noteDraft.trim();
    if (!body) {
      setNoteError("Пустая заметка запрещена");
      return;
    }

    setNoteSaving(true);
    setNoteError(null);

    try {
      await addStaffOrderNote(order.id, body);
      setNoteDraft("");
      await refetchOrder();
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : "Не удалось добавить заметку");
    } finally {
      setNoteSaving(false);
    }
  }

  function openTaxModal(docType: OrderDocumentType) {
    if (!order || !canManageWorkflow) {
      return;
    }
    setDocumentsError(null);
    setTaxModalError(null);
    setTaxModeDraft("without_vat");
    setContractNumberDraft("");
    setContractDateDraft("");
    setTaxModalDocType(docType);

    void getOrganizationSettings()
      .then((settings) => {
        setOrgVatRate(settings.vat_rate);
        setTaxModeDraft(settings.default_tax_mode);
      })
      .catch((error: unknown) => {
        setTaxModalError(
          error instanceof Error
            ? error.message
            : "Не удалось загрузить ставку НДС из настроек",
        );
      });
  }

  async function confirmGenerateDocument() {
    if (!order || !taxModalDocType) {
      return;
    }

    const docType = taxModalDocType;
    const taxMode = taxModeDraft;
    const contractNumber = contractNumberDraft.trim() || null;
    const contractDate = contractDateDraft.trim() || null;
    setTaxModalDocType(null);

    if (docType === "invoice") {
      if (invoiceBusy) {
        return;
      }
      setInvoiceBusy(true);
      setDocumentsError(null);
      try {
        await generateStaffInvoice(order.id, taxMode, {
          contractNumber,
          contractDate,
        });
        await refetchDocuments();
      } catch (error) {
        setDocumentsError(
          error instanceof Error ? error.message : "Не удалось сформировать счёт",
        );
      } finally {
        setInvoiceBusy(false);
      }
      return;
    }

    if (deliveryNoteBusy) {
      return;
    }
    setDeliveryNoteBusy(true);
    setDocumentsError(null);
    try {
      await generateStaffDeliveryNote(order.id, taxMode);
      await refetchDocuments();
    } catch (error) {
      setDocumentsError(
        error instanceof Error ? error.message : "Не удалось сформировать накладную",
      );
    } finally {
      setDeliveryNoteBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Не удалось загрузить заказ</h1>
        <p className="mt-4 text-red-600" role="alert">
          {loadError}
        </p>
        <div className="mt-6">
          <BackToOrdersLink />
        </div>
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Заказ не найден</h1>
        <p className="mt-4 text-neutral-600">
          Проверьте ссылку или вернитесь к списку заказов.
        </p>
        <Link
          href="/staff/orders"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          К списку заказов
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <BackToOrdersLink />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-neutral-800">Заказ {order.order_number}</h1>
        <span className="rounded-full bg-neutral-100 px-3 py-1 text-sm font-medium text-neutral-600">
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        от {new Date(order.created_at).toLocaleString("ru-RU")}
      </p>

      {showWarehouseLink && (
        <Link
          href={`/staff/warehouse/${order.id}`}
          className={`mt-4 inline-flex rounded-md border border-[#0F766E]/30 bg-[#0F766E]/5 px-4 py-2 text-sm font-medium text-[#0F766E] transition-colors hover:bg-[#0F766E]/10 ${focusRing}`}
        >
          Открыть карточку сборки →
        </Link>
      )}

      {(paymentOverdue || reservationOverdue) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {paymentOverdue && (
            <span className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700">
              Просрочена оплата
            </span>
          )}
          {reservationOverdue && (
            <span className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-800">
              Просрочен резерв
            </span>
          )}
        </div>
      )}

      {canManageWorkflow && (transitions.length > 0 || canCancel) && (
        <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Действия по заказу</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {transitions.map((nextStatus) => (
              <button
                key={nextStatus}
                type="button"
                disabled={actionBusy}
                onClick={() => handleStatusChange(nextStatus)}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-300 ${focusRing}`}
              >
                {getStatusTransitionLabel(order.status, nextStatus)}
              </button>
            ))}
            {canCancel && (
              <button
                type="button"
                disabled={actionBusy}
                onClick={handleCancel}
                className={`rounded-md border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:text-neutral-400 ${focusRing}`}
              >
                Отменить заказ
              </button>
            )}
          </div>
          {actionBusy && <p className="mt-3 text-sm text-neutral-500">Выполняется...</p>}
          {actionError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {actionError}
            </p>
          )}
        </section>
      )}

      <div className="mt-8 flex flex-col gap-8">
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Контактные данные</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row label="Контактное лицо" value={order.contact_name} />
            <Row label="Телефон" value={order.contact_phone} />
            <Row label="Email" value={order.contact_email} />
          </dl>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Получение заказа</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row label="Способ получения" value={DELIVERY_TYPE_LABELS[order.delivery_type]} />
            <Row label="Адрес доставки" value={order.delivery_address} />
            <Row label="Комментарий по получению" value={order.delivery_comment} />
          </dl>
        </section>

        {order.comment && (
          <section className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-neutral-800">Комментарий к заказу</h2>
            <p className="mt-3 text-sm text-neutral-600">{order.comment}</p>
          </section>
        )}

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Ответственный менеджер</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Сейчас: {order.assigned_manager_name ?? "Не назначен"}
          </p>
          {fieldsEditable && (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">Назначить</span>
                <select
                  value={managerDraft}
                  onChange={(event) => setManagerDraft(event.target.value)}
                  disabled={managerSaving}
                  className={`rounded-md border border-neutral-200 px-3 py-2 text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
                >
                  {isAdmin && <option value="">Не назначен</option>}
                  {!isAdmin && !managerDraft && <option value="">Выберите себя</option>}
                  {managers.map((manager) => (
                    <option key={manager.id} value={manager.id}>
                      {manager.full_name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={handleAssignManager}
                disabled={managerSaving}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
              >
                {managerSaving ? "..." : "Сохранить"}
              </button>
            </div>
          )}
          {managerError && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {managerError}
            </p>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Сроки</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            <Row
              label="Срок оплаты"
              value={
                order.payment_due_at
                  ? `${new Date(order.payment_due_at).toLocaleString("ru-RU")}${paymentOverdue ? " · просрочен" : ""}`
                  : null
              }
            />
            <Row
              label="Срок резерва"
              value={
                order.reservation_expires_at
                  ? `${new Date(order.reservation_expires_at).toLocaleString("ru-RU")}${reservationOverdue ? " · просрочен" : ""}`
                  : null
              }
            />
          </dl>
          {fieldsEditable && (
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">Срок оплаты</span>
                <input
                  type="datetime-local"
                  value={paymentDueDraft}
                  onChange={(event) => setPaymentDueDraft(event.target.value)}
                  disabled={deadlinesSaving}
                  className={`rounded-md border border-neutral-200 px-3 py-2 text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-neutral-700">Срок резерва</span>
                <input
                  type="datetime-local"
                  value={reservationExpiresDraft}
                  onChange={(event) => setReservationExpiresDraft(event.target.value)}
                  disabled={deadlinesSaving}
                  className={`rounded-md border border-neutral-200 px-3 py-2 text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
                />
              </label>
              <div className="sm:col-span-2">
                <button
                  type="button"
                  onClick={handleSaveDeadlines}
                  disabled={deadlinesSaving}
                  className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
                >
                  {deadlinesSaving ? "Сохранение..." : "Сохранить сроки"}
                </button>
                {deadlinesError && (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    {deadlinesError}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Внутренние заметки</h2>
          {canManageWorkflow && (
            <div className="mt-4 flex flex-col gap-3">
              <textarea
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                rows={3}
                placeholder="Новая заметка..."
                disabled={noteSaving}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
              />
              <div>
                <button
                  type="button"
                  onClick={handleAddNote}
                  disabled={noteSaving}
                  className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
                >
                  {noteSaving ? "Добавление..." : "Добавить заметку"}
                </button>
                {noteError && (
                  <p className="mt-2 text-sm text-red-600" role="alert">
                    {noteError}
                  </p>
                )}
              </div>
            </div>
          )}
          {order.internalNotes.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">Заметок пока нет</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {order.internalNotes.map((note) => (
                <li
                  key={note.id}
                  className="border-b border-neutral-100 pb-3 text-sm last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-neutral-800">
                      {note.created_by_name ?? "Сотрудник"}
                    </p>
                    <time className="text-xs text-neutral-400">
                      {new Date(note.created_at).toLocaleString("ru-RU")}
                    </time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-neutral-600">{note.body}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Документы</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Счёт и накладная — snapshot metadata. PDF формируется из документа, не из live
            заказа.
          </p>

          {documentsError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {documentsError}
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-md border border-neutral-100 bg-neutral-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Счёт</p>
              {invoiceDoc ? (
                <div className="mt-2 space-y-2 text-sm text-neutral-700">
                  <p className="font-medium text-neutral-800">{invoiceDoc.number}</p>
                  <p>
                    {ORDER_DOCUMENT_STATUS_LABELS[invoiceDoc.status]} ·{" "}
                    {new Date(invoiceDoc.generated_at).toLocaleString("ru-RU")}
                  </p>
                  {invoiceDoc.generated_by_name && (
                    <p className="text-neutral-500">{invoiceDoc.generated_by_name}</p>
                  )}
                  {invoiceDoc.printed_at && (
                    <p className="text-xs text-neutral-400">
                      Печать: {new Date(invoiceDoc.printed_at).toLocaleString("ru-RU")}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href={`/staff/orders/${order.id}/documents/${invoiceDoc.id}`}
                      className={`inline-flex rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
                    >
                      Просмотр
                    </Link>
                    <Link
                      href={`/staff/orders/${order.id}/documents/${invoiceDoc.id}/print`}
                      className={`inline-flex rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
                    >
                      Печать
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-neutral-500">Счёт ещё не создан</p>
                  {canGenerateInvoice && (
                    <button
                      type="button"
                      onClick={() => openTaxModal("invoice")}
                      disabled={invoiceBusy}
                      className={`mt-3 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
                    >
                      {invoiceBusy ? "Создание..." : "Создать счёт"}
                    </button>
                  )}
                  {canManageWorkflow && order.items.length === 0 && (
                    <p className="mt-2 text-xs text-neutral-400">
                      Добавьте товары в заказ, чтобы сформировать счёт
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-md border border-neutral-100 bg-neutral-50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Накладная
              </p>
              {deliveryNoteDoc ? (
                <div className="mt-2 space-y-2 text-sm text-neutral-700">
                  <p className="font-medium text-neutral-800">{deliveryNoteDoc.number}</p>
                  <p>
                    {ORDER_DOCUMENT_STATUS_LABELS[deliveryNoteDoc.status]} ·{" "}
                    {new Date(deliveryNoteDoc.generated_at).toLocaleString("ru-RU")}
                  </p>
                  {deliveryNoteDoc.generated_by_name && (
                    <p className="text-neutral-500">{deliveryNoteDoc.generated_by_name}</p>
                  )}
                  {deliveryNoteDoc.printed_at && (
                    <p className="text-xs text-neutral-400">
                      Печать: {new Date(deliveryNoteDoc.printed_at).toLocaleString("ru-RU")}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href={`/staff/orders/${order.id}/documents/${deliveryNoteDoc.id}`}
                      className={`inline-flex rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
                    >
                      Просмотр
                    </Link>
                    <Link
                      href={`/staff/orders/${order.id}/documents/${deliveryNoteDoc.id}/print`}
                      className={`inline-flex rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
                    >
                      Печать
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-neutral-500">Накладная ещё не создана</p>
                  {canGenerateDeliveryNote && (
                    <button
                      type="button"
                      onClick={() => openTaxModal("delivery_note")}
                      disabled={deliveryNoteBusy}
                      className={`mt-3 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
                    >
                      {deliveryNoteBusy ? "Создание..." : "Создать накладную"}
                    </button>
                  )}
                  {canManageWorkflow && order.items.length === 0 && (
                    <p className="mt-2 text-xs text-neutral-400">
                      Добавьте товары в заказ, чтобы сформировать накладную
                    </p>
                  )}
                  {canManageWorkflow &&
                    order.items.length > 0 &&
                    !canGenerateDeliveryNote &&
                    order.status !== "cancelled" && (
                      <p className="mt-2 text-xs text-neutral-400">
                        Накладная доступна после оплаты (paid и далее)
                      </p>
                    )}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-neutral-800">Состав заказа</h2>
            {canManageItems && (
              <button
                type="button"
                onClick={() => setIsAddItemModalOpen(true)}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
              >
                + Добавить товар
              </button>
            )}
          </div>
          {!canManageItems && canManageWorkflow && (
            <p className="mt-2 text-sm text-neutral-500">
              Состав можно менять только в статусах «Новый» и «Ожидает оплаты».
            </p>
          )}

          {order.items.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">В заказе пока нет товаров</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                    <th className="px-4 py-3">Товар</th>
                    <th className="px-4 py-3 text-right">Кол-во</th>
                    <th className="px-4 py-3 text-right">Цена</th>
                    <th className="px-4 py-3 text-right">Сумма</th>
                    {canManageItems && <th className="px-4 py-3" />}
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((item) =>
                    canManageItems ? (
                      <EditableOrderItemRow
                        key={item.id}
                        item={item}
                        orderNumber={order.order_number}
                        onChanged={refetchOrder}
                      />
                    ) : (
                      <tr key={item.id} className="border-b border-neutral-100 last:border-b-0">
                        <td className="px-4 py-3 text-neutral-800">{item.product_name}</td>
                        <td className="px-4 py-3 text-right text-neutral-600">{item.quantity}</td>
                        <td className="px-4 py-3 text-right text-neutral-600">
                          {formatPrice(item.unit_price)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-neutral-800">
                          {formatPrice(item.total)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-4 ml-auto flex max-w-xs flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-neutral-500">Подытог</span>
              <span className="text-neutral-800">{formatPrice(order.subtotal)}</span>
            </div>
            {order.discount > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-neutral-500">Скидка</span>
                <span className="text-neutral-800">−{formatPrice(order.discount)}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-neutral-200 pt-2">
              <span className="font-semibold text-neutral-800">Итого</span>
              <span className="text-lg font-bold text-neutral-800">
                {formatPrice(order.total)}
              </span>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">История статусов</h2>
          {order.statusHistory.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">История пока пуста</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {order.statusHistory.map((entry) => (
                <li
                  key={entry.id}
                  className="border-b border-neutral-100 pb-3 text-sm last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-neutral-800">
                      {entry.from_status
                        ? `${ORDER_STATUS_LABELS[entry.from_status]} → ${ORDER_STATUS_LABELS[entry.to_status]}`
                        : ORDER_STATUS_LABELS[entry.to_status]}
                    </p>
                    <time className="text-xs text-neutral-400">
                      {new Date(entry.created_at).toLocaleString("ru-RU")}
                    </time>
                  </div>
                  <p className="mt-1 text-neutral-500">
                    {entry.changed_by_name ?? "Сотрудник"}
                  </p>
                  {entry.note && <p className="mt-1 text-neutral-600">{entry.note}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Активность заказа</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Назначение менеджера и изменения сроков — без ложных переходов статуса.
          </p>
          {order.activityLog.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">Активности пока нет</p>
          ) : (
            <ol className="mt-4 space-y-3">
              {order.activityLog.map((entry) => (
                <li
                  key={entry.id}
                  className="border-b border-neutral-100 pb-3 text-sm last:border-b-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-neutral-800">
                      {entry.event_type === "manager_assigned"
                        ? "Менеджер назначен"
                        : entry.event_type === "manager_unassigned"
                          ? "Менеджер снят"
                          : "Сроки обновлены"}
                    </p>
                    <time className="text-xs text-neutral-400">
                      {new Date(entry.created_at).toLocaleString("ru-RU")}
                    </time>
                  </div>
                  <p className="mt-1 text-neutral-500">
                    {entry.created_by_name ?? "Сотрудник"}
                  </p>
                  {entry.description && (
                    <p className="mt-1 text-neutral-600">{entry.description}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {isAddItemModalOpen && (
        <StaffAddOrderItemModal
          orderId={order.id}
          onClose={() => setIsAddItemModalOpen(false)}
          onAdded={() => {
            setIsAddItemModalOpen(false);
            void refetchOrder();
          }}
        />
      )}

      {taxModalDocType && order && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tax-mode-dialog-title"
          onClick={() => setTaxModalDocType(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="tax-mode-dialog-title" className="text-lg font-semibold text-neutral-800">
              {taxModalDocType === "invoice" ? "Создать счёт" : "Создать накладную"}
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              {taxModalDocType === "invoice"
                ? "Шаблон счёта выбирается автоматически по типу покупателя. Цены заказа без НДС — при «С НДС» налог начисляется сверху."
                : "Цены заказа без НДС — при «С НДС» налог начисляется сверху."}
            </p>

            {(() => {
              const orderSubtotal = Number(order.total);
              const vatRate = orgVatRate;
              // Match SQL: round(subtotal * rate / 100, 2)
              const vatAmountRounded =
                taxModeDraft === "with_vat" && vatRate != null
                  ? Math.round(((orderSubtotal * vatRate) / 100) * 100) / 100
                  : 0;
              const payTotal =
                taxModeDraft === "with_vat"
                  ? orderSubtotal + vatAmountRounded
                  : orderSubtotal;
              const withVatDisabled = vatRate == null;

              return (
                <div className="mt-4 space-y-3">
                  <div className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm">
                    <p className="text-neutral-500">Сумма заказа</p>
                    <p className="text-lg font-semibold text-neutral-800">
                      {formatPrice(orderSubtotal)}
                    </p>
                  </div>

                  <fieldset className="space-y-2">
                    <legend className="sr-only">Налоговый режим</legend>
                    <label
                      className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-3 text-sm ${
                        taxModeDraft === "without_vat"
                          ? "border-[#0F766E] bg-[#0F766E]/5"
                          : "border-neutral-200 hover:border-[#0F766E]"
                      }`}
                    >
                      <span className="flex items-center gap-3 font-medium text-neutral-800">
                        <input
                          type="radio"
                          name="document-tax-mode"
                          value="without_vat"
                          checked={taxModeDraft === "without_vat"}
                          onChange={() => setTaxModeDraft("without_vat")}
                          className="accent-[#0F766E]"
                        />
                        Без НДС
                      </span>
                      {taxModeDraft === "without_vat" && (
                        <span className="pl-7 text-neutral-600">
                          К оплате:{" "}
                          <span className="font-semibold text-neutral-800">
                            {formatPrice(orderSubtotal)}
                          </span>
                        </span>
                      )}
                    </label>

                    <label
                      className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-3 text-sm ${
                        withVatDisabled
                          ? "cursor-not-allowed border-neutral-100 bg-neutral-50 opacity-60"
                          : taxModeDraft === "with_vat"
                            ? "border-[#0F766E] bg-[#0F766E]/5"
                            : "border-neutral-200 hover:border-[#0F766E]"
                      }`}
                    >
                      <span className="flex items-center gap-3 font-medium text-neutral-800">
                        <input
                          type="radio"
                          name="document-tax-mode"
                          value="with_vat"
                          checked={taxModeDraft === "with_vat"}
                          onChange={() => setTaxModeDraft("with_vat")}
                          disabled={withVatDisabled}
                          className="accent-[#0F766E]"
                        />
                        С НДС{vatRate != null ? ` (${vatRate}%)` : ""}
                      </span>
                      {withVatDisabled ? (
                        <span className="pl-7 text-xs text-red-600">
                          Укажите ставку НДС в настройках организации
                        </span>
                      ) : taxModeDraft === "with_vat" ? (
                        <span className="space-y-0.5 pl-7 text-neutral-600">
                          <span className="block">
                            НДС:{" "}
                            <span className="font-medium text-neutral-800">
                              {formatPrice(vatAmountRounded)}
                            </span>
                          </span>
                          <span className="block">
                            К оплате:{" "}
                            <span className="font-semibold text-neutral-800">
                              {formatPrice(payTotal)}
                            </span>
                          </span>
                        </span>
                      ) : null}
                    </label>
                  </fieldset>
                </div>
              );
            })()}

            {taxModalError && (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {taxModalError}
              </p>
            )}

            {taxModalDocType === "invoice" && (
              <div className="mt-4 space-y-3 border-t border-neutral-100 pt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Договор (необязательно)
                </p>
                <label className="block text-sm text-neutral-600">
                  Номер договора
                  <input
                    className={`mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`}
                    value={contractNumberDraft}
                    onChange={(e) => setContractNumberDraft(e.target.value)}
                    placeholder="Без договора — оставьте пустым"
                  />
                </label>
                <label className="block text-sm text-neutral-600">
                  Дата договора
                  <input
                    type="date"
                    className={`mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`}
                    value={contractDateDraft}
                    onChange={(e) => setContractDateDraft(e.target.value)}
                  />
                </label>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTaxModalDocType(null)}
                className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void confirmGenerateDocument()}
                disabled={taxModeDraft === "with_vat" && orgVatRate == null}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
              >
                Создать
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditableOrderItemRow({
  item,
  orderNumber,
  onChanged,
}: {
  item: StaffOrderDetailItem;
  orderNumber: string;
  onChanged: () => Promise<void>;
}) {
  const [quantityInput, setQuantityInput] = useState(String(item.quantity));
  const [syncedQuantity, setSyncedQuantity] = useState(item.quantity);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  if (item.quantity !== syncedQuantity) {
    setSyncedQuantity(item.quantity);
    setQuantityInput(String(item.quantity));
  }

  const parsedQuantity = Number(quantityInput);
  const isValidQuantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0;
  const isDirty = isValidQuantity && parsedQuantity !== item.quantity;
  const busy = saving || removing;

  async function handleSaveQuantity() {
    if (!isDirty || busy) {
      return;
    }
    setSaving(true);
    setRowError(null);
    try {
      await updateStaffOrderItemQuantity(item.id, parsedQuantity);
      await onChanged();
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "Не удалось изменить количество");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (busy) {
      return;
    }
    const confirmed = window.confirm(
      `Удалить «${item.product_name}» из заказа ${orderNumber}? Резерв товара будет освобождён.`,
    );
    if (!confirmed) {
      return;
    }
    setRemoving(true);
    setRowError(null);
    try {
      await removeStaffOrderItem(item.id);
      await onChanged();
    } catch (error) {
      setRowError(error instanceof Error ? error.message : "Не удалось удалить позицию");
      setRemoving(false);
    }
  }

  return (
    <tr className="border-b border-neutral-100 last:border-b-0">
      <td className="px-4 py-3 text-neutral-800">
        {item.product_name}
        {rowError && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {rowError}
          </p>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <input
            type="number"
            min={1}
            value={quantityInput}
            disabled={busy}
            onChange={(event) => setQuantityInput(event.target.value)}
            className={`w-20 rounded-md border border-neutral-200 px-2 py-1.5 text-right text-sm text-neutral-800 outline-none focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 ${focusRing}`}
          />
          {isDirty && (
            <button
              type="button"
              onClick={handleSaveQuantity}
              disabled={busy}
              className={`rounded-md bg-[#0F766E] px-2.5 py-1.5 text-xs font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
            >
              {saving ? "..." : "Сохранить"}
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-right text-neutral-600">{formatPrice(item.unit_price)}</td>
      <td className="px-4 py-3 text-right font-medium text-neutral-800">
        {formatPrice(item.total)}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          onClick={handleRemove}
          disabled={busy}
          className={`text-sm font-medium text-red-600 hover:text-red-700 disabled:text-neutral-400 rounded-sm ${focusRing}`}
        >
          {removing ? "Удаление..." : "Удалить"}
        </button>
      </td>
    </tr>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) {
    return null;
  }
  return (
    <div className="flex justify-between gap-2 border-b border-neutral-100 py-2 text-sm">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right text-neutral-800">{value}</dd>
    </div>
  );
}
