import { supabase } from "@/lib/supabase/client";
import type {
  ClientOrderPaymentFlow,
  ClientOrderPaymentSummary,
  OrderPaymentClaimStatus,
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

type ClientFlowRow = ClientSummaryRow & {
  invoice_id: string | null;
  kaspi_qr_path: string | null;
  claim_id: string | null;
  claim_status: string | null;
  claim_created_at: string | null;
};

const ORGANIZATION_ASSETS_BUCKET = "organization-assets";
const KASPI_QR_PATH_RE = /^organization\/kaspi_qr\.(png|jpe?g|webp)$/i;

function num(value: number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

function mapSummary(row: ClientSummaryRow): ClientOrderPaymentSummary {
  return {
    amount_due: num(row.amount_due),
    amount_paid: num(row.amount_paid),
    amount_remaining: num(row.amount_remaining),
    payment_status: row.payment_status as OrderPaymentStatus,
    invoice_number: row.invoice_number,
  };
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

  return mapSummary(row);
}

/**
 * Client payment block (033): totals + invoice id + Kaspi path + claim.
 * Ownership via orders.user_id. Amounts are server-derived.
 */
export async function getClientOrderPaymentFlow(
  orderId: string,
): Promise<ClientOrderPaymentFlow> {
  const { data, error } = await supabase.rpc("client_get_order_payment_flow", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сводку оплаты");
  }

  const [row] = (data as ClientFlowRow[] | null) ?? [];
  if (!row) {
    throw new Error("Сводка оплаты не найдена");
  }

  const qr =
    typeof row.kaspi_qr_path === "string" && KASPI_QR_PATH_RE.test(row.kaspi_qr_path.trim())
      ? row.kaspi_qr_path.trim()
      : null;

  const claimStatus = row.claim_status;
  const claimOk = claimStatus === "reported" || claimStatus === "confirmed";

  return {
    ...mapSummary(row),
    invoice_id: row.invoice_id,
    kaspi_qr_path: qr,
    claim_id: row.claim_id,
    claim_status: claimOk ? (claimStatus as OrderPaymentClaimStatus) : null,
    claim_created_at: row.claim_created_at,
  };
}

/**
 * Client "Я оплатил" — creates or returns the unresolved claim.
 * Does NOT mark the order paid. Amount is never taken from the browser.
 */
export async function reportClientOrderPayment(orderId: string): Promise<{
  id: string;
  order_id: string;
  status: OrderPaymentClaimStatus;
  created_at: string;
  already_reported: boolean;
}> {
  const { data, error } = await supabase.rpc("client_report_order_payment", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось отправить сообщение об оплате");
  }

  const [row] = (data as Array<{
    id: string;
    order_id: string;
    status: string;
    created_at: string;
    already_reported: boolean;
  }> | null) ?? [];

  if (!row) {
    throw new Error("Не удалось отправить сообщение об оплате");
  }

  return {
    id: row.id,
    order_id: row.order_id,
    status: row.status as OrderPaymentClaimStatus,
    created_at: row.created_at,
    already_reported: Boolean(row.already_reported),
  };
}

/** Signed URL for the live company Kaspi QR. Storage RLS is client_can_read_kaspi_qr_asset. */
export async function getClientKaspiQrSignedUrl(
  path: string,
  expiresInSeconds = 60 * 10,
): Promise<string> {
  const trimmed = path.trim();
  if (!KASPI_QR_PATH_RE.test(trimmed)) {
    throw new Error("Некорректный путь Kaspi QR");
  }

  const { data, error } = await supabase.storage
    .from(ORGANIZATION_ASSETS_BUCKET)
    .createSignedUrl(trimmed, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Не удалось загрузить Kaspi QR");
  }

  return data.signedUrl;
}
