import type { OrderDocumentPdfSource } from "@/types/database";
import { InvoiceCompactDocument } from "./invoice/InvoiceCompactDocument";
import type { ResolvedSupplierImages } from "./types";

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

/** Individual (ФЛ) invoice — compact KZ layout from metadata snapshot. */
export function InvoiceIndividualPdfDocument({ document, images }: Props) {
  return (
    <InvoiceCompactDocument
      document={document}
      images={images}
      variant="individual"
    />
  );
}
