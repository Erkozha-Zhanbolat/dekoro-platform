import type { OrderDocumentPdfSource } from "@/types/database";
import { InvoiceCompactDocument } from "./invoice/InvoiceCompactDocument";
import type { ResolvedSupplierImages } from "./types";

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

/** Company (ЮЛ) invoice — compact KZ B2B layout from metadata snapshot. */
export function InvoiceCompanyPdfDocument({ document, images }: Props) {
  return (
    <InvoiceCompactDocument
      document={document}
      images={images}
      variant="company"
    />
  );
}
