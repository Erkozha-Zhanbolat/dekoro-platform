import { pdf } from "@react-pdf/renderer";
import type { StaffOrderDocumentDetails } from "@/types/database";
import { ensurePdfFontsRegistered } from "./fonts";
import { documentNumberFromMetadata, str } from "./format";
import { OrderDocumentPdf } from "./OrderDocumentPdf";
import type { ResolvedSupplierImages } from "./types";

export type { ResolvedSupplierImages };

async function resolvePath(
  path: unknown,
  orderId: string,
  documentId: string,
): Promise<string | null> {
  const value = str(path, "");
  if (!value || value === "—") {
    return null;
  }
  try {
    const { getDocumentAssetSignedUrl } = await import("@/lib/staff/organizationAssets");
    return await getDocumentAssetSignedUrl(orderId, documentId, value, 60 * 15);
  } catch {
    // Missing snapshot file must not crash PDF — fall back to text-only layout.
    return null;
  }
}

export async function resolveSupplierImagesFromMetadata(
  metadata: StaffOrderDocumentDetails["metadata"],
  orderId: string,
  documentId: string,
): Promise<ResolvedSupplierImages> {
  const supplier = metadata.supplier ?? {};
  const [logoUrl, stampUrl, signatureUrl] = await Promise.all([
    resolvePath(supplier.logo_path, orderId, documentId),
    resolvePath(supplier.stamp_path, orderId, documentId),
    resolvePath(supplier.signature_path, orderId, documentId),
  ]);
  return { logoUrl, stampUrl, signatureUrl };
}

/**
 * Build a PDF Blob strictly from the document metadata snapshot.
 * Images are loaded via signed URLs for paths stored in metadata (not live settings).
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
  const images = await resolveSupplierImagesFromMetadata(
    document.metadata,
    document.order_id,
    document.id,
  );

  try {
    return await pdf(
      <OrderDocumentPdf document={document} images={images} />,
    ).toBlob();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Не удалось сформировать PDF: ${detail}`);
  }
}

/** @deprecated Use renderOrderDocumentPdf */
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
