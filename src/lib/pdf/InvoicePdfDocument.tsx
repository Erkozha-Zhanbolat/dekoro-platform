import type { OrderDocumentPdfSource } from "@/types/database";
import { InvoiceCompactDocument } from "./invoice/InvoiceCompactDocument";
import type { ResolvedSupplierImages } from "./types";

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

/**
 * Legacy invoice (pre-018, no invoice_template / buyer.customer_type).
 * Same compact KZ layout; bank/buyer fields fall back from supplier snapshot.
 */
export function InvoicePdfDocument({ document, images }: Props) {
  return (
    <InvoiceCompactDocument
      document={document}
      images={images}
      variant="legacy"
    />
  );
}
