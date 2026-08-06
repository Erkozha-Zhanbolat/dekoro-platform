import { supabase } from "@/lib/supabase/client";
import type {
  ClientOrderPaymentSummary,
  OrderPaymentStatus,
} from "@/types/database";

/**
 * Client payment summary (022) — ownership via orders.user_id.
 * No payment history, comments, references, or reversal details.
 */

type ClientSummaryRow = {
  amount_due: number | string;
  amount_paid: number | string;
  amount_remaining: number | string;
  payment_status: string;
  invoice_number: string | null;
};

function num(value: number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

/**
 * Safe payment totals for the caller's own order
 * (public.client_get_order_payment_summary).
 */
export async function getClientOrderPaymentSummary(
  orderId: string,
): Promise<ClientOrderPaymentSummary> {
  const { data, error } = await supabase.rpc("client_get_order_payment_summary", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сводку оплаты");
  }

  const [row] = (data as ClientSummaryRow[] | null) ?? [];
  if (!row) {
    throw new Error("Сводка оплаты не найдена");
  }

  return {
    amount_due: num(row.amount_due),
    amount_paid: num(row.amount_paid),
    amount_remaining: num(row.amount_remaining),
    payment_status: row.payment_status as OrderPaymentStatus,
    invoice_number: row.invoice_number,
  };
}
