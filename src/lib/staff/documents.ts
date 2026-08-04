import { supabase } from "@/lib/supabase/client";
import type {
  DocumentTaxMode,
  OrderDocument,
  OrderDocumentMetadata,
  OrderDocumentStatus,
  OrderDocumentType,
  StaffOrderDocumentDetails,
  StaffOrderDocumentListItem,
} from "@/types/database";

/**
 * Staff-facing order documents (014 + 015).
 *
 * Reads/writes only through SECURITY DEFINER RPCs.
 * PDF is built client-side from metadata only (Stage 5).
 */

export type {
  DocumentTaxMode,
  OrderDocument,
  OrderDocumentMetadata,
  OrderDocumentStatus,
  OrderDocumentType,
  StaffOrderDocumentDetails,
  StaffOrderDocumentListItem,
};

function mapListItem(row: StaffOrderDocumentListItem): StaffOrderDocumentListItem {
  return {
    id: row.id,
    order_id: row.order_id,
    document_type: row.document_type,
    number: row.number,
    status: row.status,
    file_path: row.file_path,
    generated_by: row.generated_by,
    generated_by_name: row.generated_by_name,
    generated_at: row.generated_at,
    printed_at: row.printed_at ?? null,
    printed_by: row.printed_by ?? null,
    printed_by_name: row.printed_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapDocumentRow(row: OrderDocument): OrderDocument {
  return {
    id: row.id,
    order_id: row.order_id,
    document_type: row.document_type,
    number: row.number,
    status: row.status,
    file_path: row.file_path,
    generated_by: row.generated_by,
    generated_at: row.generated_at,
    printed_at: row.printed_at ?? null,
    printed_by: row.printed_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: row.metadata as OrderDocumentMetadata,
  };
}

export async function listStaffOrderDocuments(
  orderId: string,
): Promise<StaffOrderDocumentListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_order_documents", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить документы заказа");
  }

  return ((data as StaffOrderDocumentListItem[] | null) ?? []).map(mapListItem);
}

/**
 * Fetch document bound to order. Server rejects mismatches
 * (staff_get_document requires both p_order_id and p_document_id).
 */
export async function getStaffDocument(
  orderId: string,
  documentId: string,
): Promise<StaffOrderDocumentDetails | null> {
  const { data, error } = await supabase.rpc("staff_get_document", {
    p_order_id: orderId,
    p_document_id: documentId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить документ");
  }

  const [row] = (data as StaffOrderDocumentDetails[] | null) ?? [];
  if (!row) {
    return null;
  }

  return {
    ...mapListItem(row),
    metadata: row.metadata as OrderDocumentMetadata,
  };
}

export async function generateStaffInvoice(
  orderId: string,
  taxMode: DocumentTaxMode,
): Promise<OrderDocument> {
  const { prepareDocumentAssetSnapshot, failDocumentAssetSnapshot } = await import(
    "@/lib/staff/organizationAssets"
  );

  const intentId = await prepareDocumentAssetSnapshot(orderId, "invoice");

  const { data, error } = await supabase.rpc("staff_generate_invoice", {
    p_order_id: orderId,
    p_tax_mode: taxMode,
    p_snapshot_intent_id: intentId,
  });

  if (error) {
    await failDocumentAssetSnapshot(intentId);
    throw new Error(error.message || "Не удалось сформировать счёт");
  }

  return mapDocumentRow(data as OrderDocument);
}

export async function generateStaffDeliveryNote(
  orderId: string,
  taxMode: DocumentTaxMode,
): Promise<OrderDocument> {
  const { prepareDocumentAssetSnapshot, failDocumentAssetSnapshot } = await import(
    "@/lib/staff/organizationAssets"
  );

  const intentId = await prepareDocumentAssetSnapshot(orderId, "delivery_note");

  const { data, error } = await supabase.rpc("staff_generate_delivery_note", {
    p_order_id: orderId,
    p_tax_mode: taxMode,
    p_snapshot_intent_id: intentId,
  });

  if (error) {
    await failDocumentAssetSnapshot(intentId);
    throw new Error(error.message || "Не удалось сформировать накладную");
  }

  return mapDocumentRow(data as OrderDocument);
}

/**
 * Records first successful PDF print. Idempotent — reprint does not overwrite.
 */
export async function markStaffDocumentPrinted(
  orderId: string,
  documentId: string,
): Promise<OrderDocument> {
  const { data, error } = await supabase.rpc("staff_mark_document_printed", {
    p_order_id: orderId,
    p_document_id: documentId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось зафиксировать печать документа");
  }

  return mapDocumentRow(data as OrderDocument);
}

export function findOrderDocument(
  documents: StaffOrderDocumentListItem[],
  type: OrderDocumentType,
): StaffOrderDocumentListItem | undefined {
  return documents.find((doc) => doc.document_type === type);
}

/**
 * Generate PDF from metadata, open/download, then mark printed_at (first time only).
 * printed_at is updated only after a successful PDF Blob is created.
 * View pages must not call this — only explicit Print actions.
 */
export async function printStaffOrderDocument(
  orderId: string,
  documentId: string,
): Promise<{ document: StaffOrderDocumentDetails; markedPrinted: boolean }> {
  const document = await getStaffDocument(orderId, documentId);
  if (!document) {
    throw new Error("Документ не найден или не принадлежит этому заказу");
  }

  // Defense in depth (RPC already binds order_id).
  if (document.order_id !== orderId) {
    throw new Error("Документ не принадлежит этому заказу");
  }

  if (document.status === "cancelled") {
    throw new Error("Нельзя печатать отменённый документ");
  }

  const { pdfFilename, renderOrderDocumentPdf } = await import(
    "@/lib/pdf/renderOrderDocumentPdf"
  );

  // 1) Build PDF first. If this throws — printed_at stays unchanged.
  const blob = await renderOrderDocumentPdf(document);

  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(blob);
    const filename = pdfFilename(document);

    const opened = window.open(objectUrl, "_blank", "noopener,noreferrer");
    if (!opened) {
      // Popup blocked — fall back to download.
      const anchor = window.document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      anchor.rel = "noopener";
      window.document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    // 2) Mark print only after successful PDF generation.
    const wasPrinted = document.printed_at != null;
    const marked = await markStaffDocumentPrinted(orderId, documentId);

    return {
      document: {
        ...document,
        printed_at: marked.printed_at,
        printed_by: marked.printed_by,
      },
      markedPrinted: !wasPrinted && marked.printed_at != null,
    };
  } finally {
    // Release blob URL after the new tab / download has had time to read it.
    if (objectUrl) {
      const toRevoke = objectUrl;
      window.setTimeout(() => {
        URL.revokeObjectURL(toRevoke);
      }, 30_000);
    }
  }
}
