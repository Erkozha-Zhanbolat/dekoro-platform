import type { StaffOrderDocumentDetails } from "@/types/database";
import { DeliveryNotePdfDocument } from "./DeliveryNotePdfDocument";
import { InvoicePdfDocument } from "./InvoicePdfDocument";
import type { ResolvedSupplierImages } from "./types";

type Props = {
  document: StaffOrderDocumentDetails;
  images: ResolvedSupplierImages;
};

/**
 * Universal PDF renderer: chooses layout by document_type only.
 * Always renders from order_documents.metadata (never live orders/settings).
 */
export function OrderDocumentPdf({ document, images }: Props) {
  if (document.document_type === "invoice") {
    return <InvoicePdfDocument document={document} images={images} />;
  }

  if (document.document_type === "delivery_note") {
    return <DeliveryNotePdfDocument document={document} images={images} />;
  }

  const exhaustive: never = document.document_type;
  throw new Error(`Неизвестный тип документа: ${String(exhaustive)}`);
}
