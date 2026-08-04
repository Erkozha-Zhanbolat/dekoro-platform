import type { InvoiceTemplate, OrderDocumentMetadata } from "@/types/database";

export type ResolvedInvoiceRenderMode = InvoiceTemplate | "legacy";

/**
 * Resolve invoice PDF render mode from immutable metadata only.
 *
 * Order:
 * 1. explicit invoice_template (018+)
 * 2. immutable buyer.customer_type
 * 3. legacy renderer (pre-template docs without customer_type)
 *
 * Never uses live customers/settings.
 */
export function resolveInvoiceRenderMode(
  metadata: OrderDocumentMetadata,
): ResolvedInvoiceRenderMode {
  const explicit = metadata.invoice_template;
  if (explicit === "individual" || explicit === "company") {
    return explicit;
  }

  const buyerType = metadata.buyer?.customer_type;
  if (buyerType === "individual" || buyerType === "company") {
    return buyerType;
  }

  return "legacy";
}

/** @deprecated use resolveInvoiceRenderMode */
export function resolveInvoiceTemplate(
  metadata: OrderDocumentMetadata,
): InvoiceTemplate | "legacy" {
  return resolveInvoiceRenderMode(metadata);
}
