import { supabase } from "@/lib/supabase/client";
import type {
  DocumentTaxMode,
  OrderPaymentClaimStatus,
  OrderPaymentMethod,
  OrderPaymentRecordStatus,
  OrderPaymentStatus,
  OrderStatus,
  StaffConfirmPaymentMethod,
  StaffCustomerReceivables,
  StaffOrderPaymentClaim,
  StaffOrderPaymentItem,
  StaffOrderPaymentListSummary,
  StaffOrderPaymentSummary,
} from "@/types/database";

/**
 * Staff payments API (supabase/migrations/022_order_payments.sql).
 *
 * All access via SECURITY DEFINER RPCs — no direct table grants on
 * public.order_payments / public.order_payment_obligations.
 *
 * amount_due: frozen obligation after first payment; otherwise provisional
 * (generated invoice final_total, else orders.total).
 */

type SummaryRow = {
  order_id: string;
  order_number: string;
  order_status: string;
  amount_due: number | string;
  amount_paid: number | string;
  amount_remaining: number | string;
  payment_status: string;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_tax_mode: string | null;
  invoice_final_total: number | string | null;
  has_payment_shortfall: boolean;
  payment_due_at: string | null;
  obligation_frozen: boolean;
  obligation_source_type: string | null;
  obligation_source_number: string | null;
};

type ListSummaryRow = {
  order_id: string;
  order_number: string;
  order_status: string;
  amount_due: number | string;
  amount_paid: number | string;
  amount_remaining: number | string;
  payment_status: string;
  invoice_id: string | null;
  invoice_number: string | null;
  has_payment_shortfall: boolean;
  payment_due_at: string | null;
  obligation_frozen: boolean;
  obligation_source_type: string | null;
};

type PaymentRow = {
  id: string;
  order_id: string;
  amount: number | string;
  payment_date: string;
  payment_method: string;
  reference_number: string | null;
  comment: string | null;
  status: string;
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_at: string;
  reversed_by: string | null;
  reversed_by_name: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
};

type ReceivablesRow = {
  customer_id: string;
  open_obligation_total: number | string;
  amount_paid_total: number | string;
  amount_outstanding_total: number | string;
  orders_with_balance_count: number;
  overdue_outstanding_total: number | string;
  overdue_orders_count: number;
};

function num(value: number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function mapSummary(row: SummaryRow): StaffOrderPaymentSummary {
  return {
    order_id: row.order_id,
    order_number: row.order_number,
    order_status: row.order_status as OrderStatus,
    amount_due: num(row.amount_due),
    amount_paid: num(row.amount_paid),
    amount_remaining: num(row.amount_remaining),
    payment_status: row.payment_status as OrderPaymentStatus,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    invoice_tax_mode: (row.invoice_tax_mode as DocumentTaxMode | null) ?? null,
    invoice_final_total:
      row.invoice_final_total == null ? null : num(row.invoice_final_total),
    has_payment_shortfall: Boolean(row.has_payment_shortfall),
    payment_due_at: row.payment_due_at,
    obligation_frozen: Boolean(row.obligation_frozen),
    obligation_source_type:
      row.obligation_source_type === "order" || row.obligation_source_type === "invoice"
        ? row.obligation_source_type
        : null,
    obligation_source_number: row.obligation_source_number,
  };
}

function mapListSummary(row: ListSummaryRow): StaffOrderPaymentListSummary {
  return {
    order_id: row.order_id,
    order_number: row.order_number,
    order_status: row.order_status as OrderStatus,
    amount_due: num(row.amount_due),
    amount_paid: num(row.amount_paid),
    amount_remaining: num(row.amount_remaining),
    payment_status: row.payment_status as OrderPaymentStatus,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    has_payment_shortfall: Boolean(row.has_payment_shortfall),
    payment_due_at: row.payment_due_at,
    obligation_frozen: Boolean(row.obligation_frozen),
    obligation_source_type:
      row.obligation_source_type === "order" || row.obligation_source_type === "invoice"
        ? row.obligation_source_type
        : null,
  };
}

function mapPayment(row: PaymentRow): StaffOrderPaymentItem {
  return {
    id: row.id,
    order_id: row.order_id,
    amount: num(row.amount),
    payment_date: row.payment_date,
    payment_method: row.payment_method as OrderPaymentMethod,
    reference_number: row.reference_number,
    comment: row.comment,
    status: row.status as OrderPaymentRecordStatus,
    recorded_by: row.recorded_by,
    recorded_by_name: row.recorded_by_name,
    recorded_at: row.recorded_at,
    reversed_by: row.reversed_by,
    reversed_by_name: row.reversed_by_name,
    reversed_at: row.reversed_at,
    reversal_reason: row.reversal_reason,
  };
}

export async function getStaffOrderPaymentSummary(
  orderId: string,
): Promise<StaffOrderPaymentSummary> {
  const { data, error } = await supabase.rpc("staff_get_order_payment_summary", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сводку оплаты");
  }

  const [row] = (data as SummaryRow[] | null) ?? [];
  if (!row) {
    throw new Error("Сводка оплаты не найдена");
  }
  return mapSummary(row);
}

export async function listStaffOrdersPaymentSummaries(
  orderIds: string[],
): Promise<StaffOrderPaymentListSummary[]> {
  if (orderIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase.rpc("staff_list_orders_payment_summaries", {
    p_order_ids: orderIds,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сводки оплат");
  }

  return ((data as ListSummaryRow[] | null) ?? []).map(mapListSummary);
}

export async function listStaffOrderPayments(
  orderId: string,
): Promise<StaffOrderPaymentItem[]> {
  const { data, error } = await supabase.rpc("staff_list_order_payments", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить платежи");
  }

  return ((data as PaymentRow[] | null) ?? []).map(mapPayment);
}

export type RecordStaffOrderPaymentInput = {
  orderId: string;
  amount: number;
  paymentDate: string;
  paymentMethod: OrderPaymentMethod;
  referenceNumber?: string | null;
  comment?: string | null;
};

export async function recordStaffOrderPayment(
  input: RecordStaffOrderPaymentInput,
): Promise<StaffOrderPaymentItem> {
  const { data, error } = await supabase.rpc("staff_record_order_payment", {
    p_order_id: input.orderId,
    p_amount: input.amount,
    p_payment_date: input.paymentDate,
    p_payment_method: input.paymentMethod,
    p_reference_number: input.referenceNumber ?? null,
    p_comment: input.comment ?? null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось зарегистрировать оплату");
  }

  return mapPayment(data as PaymentRow);
}

export type ConfirmStaffOrderPaymentInput = {
  orderId: string;
  amount: number;
  paymentDate: string;
  paymentMethod: StaffConfirmPaymentMethod;
  referenceNumber?: string | null;
  comment?: string | null;
};

export type ConfirmStaffOrderPaymentResult = {
  payment_id: string;
  amount: number;
  amount_remaining: number;
  payment_status: OrderPaymentStatus;
  order_status: OrderStatus;
  transitioned_to_paid: boolean;
};

export async function confirmStaffOrderPayment(
  input: ConfirmStaffOrderPaymentInput,
): Promise<ConfirmStaffOrderPaymentResult> {
  const { data, error } = await supabase.rpc("staff_confirm_order_payment", {
    p_order_id: input.orderId,
    p_amount: input.amount,
    p_payment_date: input.paymentDate,
    p_payment_method: input.paymentMethod,
    p_reference_number: input.referenceNumber ?? null,
    p_comment: input.comment ?? null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось подтвердить оплату");
  }

  const [row] = (data as Array<{
    payment_id: string;
    amount: number | string;
    amount_remaining: number | string;
    payment_status: string;
    order_status: string;
    transitioned_to_paid: boolean;
  }> | null) ?? [];

  if (!row) {
    throw new Error("Не удалось подтвердить оплату");
  }

  return {
    payment_id: row.payment_id,
    amount: num(row.amount),
    amount_remaining: num(row.amount_remaining),
    payment_status: row.payment_status as OrderPaymentStatus,
    order_status: row.order_status as OrderStatus,
    transitioned_to_paid: Boolean(row.transitioned_to_paid),
  };
}

export async function reverseStaffOrderPayment(
  paymentId: string,
  reason: string,
): Promise<StaffOrderPaymentItem> {
  const { data, error } = await supabase.rpc("staff_reverse_order_payment", {
    p_payment_id: paymentId,
    p_reason: reason,
  });

  if (error) {
    throw new Error(error.message || "Не удалось сторнировать оплату");
  }

  return mapPayment(data as PaymentRow);
}

export async function getStaffCustomerReceivables(
  customerId: string,
): Promise<StaffCustomerReceivables> {
  const { data, error } = await supabase.rpc("staff_get_customer_receivables", {
    p_customer_id: customerId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить дебиторку");
  }

  const [row] = (data as ReceivablesRow[] | null) ?? [];
  if (!row) {
    throw new Error("Сводка дебиторки не найдена");
  }

  return {
    customer_id: row.customer_id,
    open_obligation_total: num(row.open_obligation_total),
    amount_paid_total: num(row.amount_paid_total),
    amount_outstanding_total: num(row.amount_outstanding_total),
    orders_with_balance_count: Number(row.orders_with_balance_count),
    overdue_outstanding_total: num(row.overdue_outstanding_total),
    overdue_orders_count: Number(row.overdue_orders_count),
  };
}

type ClaimRow = {
  claim_id: string | null;
  status: string | null;
  created_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  confirmed_payment_id: string | null;
  kaspi_qr_path: string | null;
};

const KASPI_QR_PATH_RE = /^organization\/kaspi_qr\.(png|jpe?g|webp)$/i;

export async function getStaffOrderPaymentClaim(
  orderId: string,
): Promise<StaffOrderPaymentClaim> {
  const { data, error } = await supabase.rpc("staff_get_order_payment_claim", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сообщение об оплате");
  }

  const [row] = (data as ClaimRow[] | null) ?? [];
  if (!row) {
    return {
      claim_id: null,
      status: null,
      created_at: null,
      resolved_at: null,
      resolved_by: null,
      resolved_by_name: null,
      confirmed_payment_id: null,
      kaspi_qr_path: null,
    };
  }

  const claimStatus = row.status;
  const claimOk = claimStatus === "reported" || claimStatus === "confirmed";
  const qr =
    typeof row.kaspi_qr_path === "string" && KASPI_QR_PATH_RE.test(row.kaspi_qr_path.trim())
      ? row.kaspi_qr_path.trim()
      : null;

  return {
    claim_id: row.claim_id,
    status: claimOk ? (claimStatus as OrderPaymentClaimStatus) : null,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    resolved_by_name: row.resolved_by_name,
    confirmed_payment_id: row.confirmed_payment_id,
    kaspi_qr_path: qr,
  };
}
