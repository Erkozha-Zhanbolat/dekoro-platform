import type { StaffOrderDocumentDetails } from "@/types/database";
import { DeliveryNotePdfDocument } from "./DeliveryNotePdfDocument";
import { InvoicePdfDocument } from "./InvoicePdfDocument";

type Props = {
  document: StaffOrderDocumentDetails;
};

/**
 * Universal PDF renderer: chooses layout by document_type only.
 * Always renders from order_documents.metadata (never live orders).
 */
export function OrderDocumentPdf({ document }: Props) {
  if (document.document_type === "invoice") {
    return <InvoicePdfDocument document={document} />;
  }

  if (document.document_type === "delivery_note") {
    return <DeliveryNotePdfDocument document={document} />;
  }

  const exhaustive: never = document.document_type;
  throw new Error(`Неизвестный тип документа: ${String(exhaustive)}`);
}
