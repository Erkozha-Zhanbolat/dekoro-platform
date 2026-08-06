import type { OrderDocumentPdfSource } from "@/types/database";
import { DeliveryNotePdfDocument } from "./DeliveryNotePdfDocument";
import { InvoiceCompanyPdfDocument } from "./InvoiceCompanyPdfDocument";
import { InvoiceIndividualPdfDocument } from "./InvoiceIndividualPdfDocument";
import { InvoicePdfDocument } from "./InvoicePdfDocument";
import { resolveInvoiceRenderMode } from "./resolveInvoiceTemplate";
import type { ResolvedSupplierImages } from "./types";

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

/**
 * Universal PDF renderer.
 * Always renders from order_documents.metadata (never live orders/settings).
 */
export function OrderDocumentPdf({ document, images }: Props) {
  if (document.document_type === "delivery_note") {
    return <DeliveryNotePdfDocument document={document} images={images} />;
  }

  if (document.document_type === "invoice") {
    const mode = resolveInvoiceRenderMode(document.metadata);
    if (mode === "company") {
      return <InvoiceCompanyPdfDocument document={document} images={images} />;
    }
    if (mode === "individual") {
      return <InvoiceIndividualPdfDocument document={document} images={images} />;
    }
    // Legacy pre-018 invoices without invoice_template / buyer.customer_type.
    return <InvoicePdfDocument document={document} images={images} />;
  }

  const exhaustive: never = document.document_type;
  throw new Error(`Неизвестный тип документа: ${String(exhaustive)}`);
}
