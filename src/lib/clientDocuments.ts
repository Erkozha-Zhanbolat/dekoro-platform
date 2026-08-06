import { supabase } from "@/lib/supabase/client";
import type {
  ClientOrderDocumentDetails,
  ClientOrderDocumentListItem,
  OrderDocumentMetadata,
  OrderDocumentStatus,
  OrderDocumentType,
} from "@/types/database";

export type { ClientOrderDocumentDetails, ClientOrderDocumentListItem };

const ORGANIZATION_ASSETS_BUCKET = "organization-assets";

const SNAPSHOT_PATH_RE =
  /^organization\/doc-snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(logo|stamp|signature)\.(png|jpe?g|webp)$/i;

type ClientDocumentListRow = {
  id: string;
  order_id: string;
  document_type: string;
  number: string;
  status: string;
  generated_at: string;
  created_at: string;
};

type ClientDocumentDetailRow = ClientDocumentListRow & {
  metadata: OrderDocumentMetadata;
};

function mapListItem(row: ClientDocumentListRow): ClientOrderDocumentListItem {
  return {
    id: row.id,
    order_id: row.order_id,
    document_type: row.document_type as OrderDocumentType,
    number: row.number,
    status: row.status as OrderDocumentStatus,
    generated_at: row.generated_at,
    created_at: row.created_at,
  };
}

/**
 * Lists generated documents for an order owned by the current user
 * (public.client_list_order_documents — 021). No staff metadata.
 */
export async function listClientOrderDocuments(
  orderId: string,
): Promise<ClientOrderDocumentListItem[]> {
  const { data, error } = await supabase.rpc("client_list_order_documents", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить документы");
  }

  return ((data as ClientDocumentListRow[] | null) ?? []).map(mapListItem);
}

/**
 * Fetches a generated document bound to the caller's order
 * (public.client_get_order_document — 021). Cross-order IDs return empty.
 */
export async function getClientOrderDocument(
  orderId: string,
  documentId: string,
): Promise<ClientOrderDocumentDetails | null> {
  const { data, error } = await supabase.rpc("client_get_order_document", {
    p_order_id: orderId,
    p_document_id: documentId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить документ");
  }

  const [row] = (data as ClientDocumentDetailRow[] | null) ?? [];
  if (!row) {
    return null;
  }

  return {
    ...mapListItem(row),
    metadata: row.metadata as OrderDocumentMetadata,
  };
}

/**
 * Signed URL for an image sealed in this document's metadata.
 * Storage SELECT is gated by client_can_read_document_asset (021).
 */
export async function getClientDocumentAssetSignedUrl(
  orderId: string,
  documentId: string,
  path: string,
  expiresInSeconds = 60 * 15,
): Promise<string> {
  const trimmed = path.trim();
  if (!SNAPSHOT_PATH_RE.test(trimmed)) {
    throw new Error("Некорректный Storage path изображения документа");
  }

  const document = await getClientOrderDocument(orderId, documentId);
  if (!document) {
    throw new Error("Документ не найден или недоступен");
  }

  const supplier = document.metadata.supplier ?? {};
  const allowed = new Set(
    [supplier.logo_path, supplier.stamp_path, supplier.signature_path]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim()),
  );

  if (!allowed.has(trimmed)) {
    throw new Error("Path не принадлежит metadata этого документа");
  }

  const { data, error } = await supabase.storage
    .from(ORGANIZATION_ASSETS_BUCKET)
    .createSignedUrl(trimmed, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Не удалось получить URL изображения документа");
  }

  return data.signedUrl;
}

/**
 * Build PDF from immutable metadata and trigger download.
 * Does not call staff print-audit RPCs.
 */
export async function downloadClientOrderDocument(
  orderId: string,
  documentId: string,
): Promise<void> {
  const document = await getClientOrderDocument(orderId, documentId);
  if (!document) {
    throw new Error("Документ не найден или не принадлежит этому заказу");
  }

  if (document.order_id !== orderId) {
    throw new Error("Документ не принадлежит этому заказу");
  }

  const { pdfFilename, renderOrderDocumentPdf } = await import(
    "@/lib/pdf/renderOrderDocumentPdf"
  );

  const blob = await renderOrderDocumentPdf(document, {
    resolveAssetUrl: getClientDocumentAssetSignedUrl,
  });

  const objectUrl = URL.createObjectURL(blob);
  try {
    const filename = pdfFilename(document);
    const anchor = window.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 30_000);
  }
}

export function findClientOrderDocument(
  documents: ClientOrderDocumentListItem[],
  type: OrderDocumentType,
): ClientOrderDocumentListItem | undefined {
  return documents.find((doc) => doc.document_type === type);
}
