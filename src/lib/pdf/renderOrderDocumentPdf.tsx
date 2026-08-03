import { pdf } from "@react-pdf/renderer";
import type { StaffOrderDocumentDetails } from "@/types/database";
import { ensurePdfFontsRegistered } from "./fonts";
import { documentNumberFromMetadata } from "./format";
import { OrderDocumentPdf } from "./OrderDocumentPdf";

/**
 * Build a PDF Blob strictly from the document metadata snapshot.
 * Must run in the browser (fonts from /public/fonts).
 *
 * Flow:
 *   renderOrderDocumentPdf()
 *     → OrderDocumentPdf (by document_type)
 *       → InvoicePdfDocument | DeliveryNotePdfDocument
 *         → formatters / fonts
 */
export async function renderOrderDocumentPdf(
  document: StaffOrderDocumentDetails,
): Promise<Blob> {
  if (!document.metadata || typeof document.metadata !== "object") {
    throw new Error("У документа отсутствует metadata snapshot — PDF не сформирован");
  }

  if (!documentNumberFromMetadata(document.metadata)) {
    throw new Error("В metadata отсутствует document_number — PDF не сформирован");
  }

  if (!Array.isArray(document.metadata.items)) {
    throw new Error("В metadata отсутствует список позиций — PDF не сформирован");
  }

  await ensurePdfFontsRegistered();

  try {
    return await pdf(<OrderDocumentPdf document={document} />).toBlob();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Не удалось сформировать PDF: ${detail}`);
  }
}

/** @deprecated Use renderOrderDocumentPdf — kept as alias for call sites. */
export async function renderOrderDocumentPdfBlob(
  document: StaffOrderDocumentDetails,
): Promise<Blob> {
  return renderOrderDocumentPdf(document);
}

export function pdfFilename(document: StaffOrderDocumentDetails): string {
  const number = documentNumberFromMetadata(document.metadata);
  if (!number) {
    throw new Error("В metadata отсутствует document_number — имя файла не сформировано");
  }
  return `${number}.pdf`;
}
