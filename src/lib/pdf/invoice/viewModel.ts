import type {
  OrderDocumentMetadataItem,
  OrderDocumentPdfSource,
} from "@/types/database";
import { amountInWordsKzt } from "../amountInWordsKzt";
import {
  documentNumberFromMetadata,
  formatPdfDateLong,
  formatPdfMoneyPlain,
  formatPdfVatRate,
  str,
} from "../format";
import type { ResolvedSupplierImages } from "../types";
import { INVOICE_NOTICE_LINES } from "./constants";

export type InvoicePdfVariant = "company" | "individual" | "legacy";

export type InvoicePaymentView = {
  beneficiaryName: string;
  binIin: string;
  iban: string;
  kbe: string;
  bankName: string;
  bic: string;
  knp: string;
};

export type InvoiceViewModel = {
  variant: InvoicePdfVariant;
  documentNumber: string;
  invoiceDateLabel: string;
  noticeLines: readonly string[];
  payment: InvoicePaymentView;
  supplierLine: string;
  buyerLine: string;
  basisLine: string;
  items: OrderDocumentMetadataItem[];
  taxMode: string;
  vatRateLabel: string;
  vatAmount: unknown;
  finalTotal: unknown;
  itemCount: number;
  amountWords: string;
  totalLine: string;
  directorName: string;
  issuedDateLabel: string;
  images: ResolvedSupplierImages;
};

function present(value: unknown): string {
  return str(value, "");
}

function joinParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "—")
    .join(", ");
}

function formatSupplierLine(supplier: Record<string, unknown>): string {
  const bin = present(supplier.bin);
  const name = present(supplier.legal_name);
  const address = present(supplier.address);
  const parts: string[] = [];
  if (bin) parts.push(`БИН / ИИН ${bin}`);
  if (name) parts.push(name);
  if (address) parts.push(address);
  return parts.join(", ") || "—";
}

function formatCompanyBuyerLine(buyer: Record<string, unknown>): string {
  const bin = present(buyer.iin_bin ?? buyer.bin);
  const name = present(buyer.legal_name ?? buyer.display_name);
  const address = present(buyer.address);
  const parts: string[] = [];
  if (bin) parts.push(`БИН / ИИН ${bin}`);
  if (name) parts.push(name);
  if (address) parts.push(address);
  return parts.join(", ") || "—";
}

function formatIndividualBuyerLine(buyer: Record<string, unknown>): string {
  return present(buyer.display_name ?? buyer.legal_name) || "—";
}

function formatBuyerLine(
  buyer: Record<string, unknown>,
  variant: InvoicePdfVariant,
): string {
  if (variant === "individual") {
    return formatIndividualBuyerLine(buyer);
  }
  if (variant === "company") {
    return formatCompanyBuyerLine(buyer);
  }
  const type = present(buyer.customer_type);
  if (type === "individual") {
    return formatIndividualBuyerLine(buyer);
  }
  if (type === "company") {
    return formatCompanyBuyerLine(buyer);
  }
  return joinParts([
    present(buyer.iin_bin ?? buyer.bin)
      ? `БИН / ИИН ${present(buyer.iin_bin ?? buyer.bin)}`
      : "",
    present(buyer.legal_name ?? buyer.display_name),
    present(buyer.address),
  ]) || "—";
}

function formatBasisLine(
  basis: Record<string, unknown>,
  order: Record<string, unknown>,
): string {
  const orderNumber = present(basis.order_number) || present(order.order_number);
  const orderDate = basis.order_date ?? order.created_at;
  const orderPart = orderNumber
    ? `Заказ № ${orderNumber} от ${formatPdfDateLong(orderDate)}`
    : present(basis.label) || "—";

  const contractNumber = present(basis.contract_number);
  if (!contractNumber) {
    return orderPart;
  }

  const contractDate = basis.contract_date
    ? ` от ${formatPdfDateLong(basis.contract_date)}`
    : "";
  return `Договор № ${contractNumber}${contractDate} / ${orderPart}`;
}

function resolvePayment(
  payment: Record<string, unknown> | null | undefined,
  supplier: Record<string, unknown>,
): InvoicePaymentView {
  const source = payment ?? {};
  const hasProfile =
    present(source.beneficiary_name) ||
    present(source.bank_iik) ||
    present(source.bank_name);

  const from = hasProfile ? source : supplier;
  return {
    beneficiaryName: str(
      hasProfile ? source.beneficiary_name : supplier.legal_name,
    ),
    binIin: str(hasProfile ? source.bin_iin : supplier.bin),
    iban: str(hasProfile ? source.bank_iik : supplier.bank_iik),
    kbe: str(hasProfile ? source.bank_kbe : supplier.bank_kbe),
    bankName: str(hasProfile ? from.bank_name : supplier.bank_name),
    bic: str(hasProfile ? source.bank_bik : supplier.bank_bik),
    knp: present(hasProfile ? source.payment_purpose_code : ""),
  };
}

function resolveAmountWords(totals: Record<string, unknown>): string {
  const stored = present(totals.amount_in_words);
  if (stored) {
    return stored;
  }
  const finalTotal = totals.final_total ?? totals.total;
  try {
    return amountInWordsKzt(finalTotal);
  } catch {
    return formatPdfMoneyPlain(finalTotal);
  }
}

export function buildInvoiceViewModel(
  document: OrderDocumentPdfSource,
  images: ResolvedSupplierImages,
  variant: InvoicePdfVariant,
): InvoiceViewModel {
  const meta = document.metadata;
  const supplier = meta.supplier ?? {};
  const buyer = meta.buyer ?? {};
  const totals = meta.totals ?? {};
  const basis = meta.basis ?? {};
  const order = meta.order ?? {};
  const items = meta.items ?? [];
  const documentNumber = documentNumberFromMetadata(meta);

  if (!documentNumber) {
    throw new Error("В metadata отсутствует document_number — PDF не сформирован");
  }

  if (variant === "company" && !meta.payment_profile) {
    throw new Error(
      "В metadata отсутствует payment_profile — company invoice PDF не сформирован",
    );
  }

  const taxMode = present(totals.tax_mode);
  const finalTotal = totals.final_total ?? totals.total;
  const itemCount = Number(totals.item_count ?? totals.items_count ?? items.length);
  const vatRateLabel = formatPdfVatRate(totals.vat_rate);
  const amountWords = resolveAmountWords(totals);

  return {
    variant,
    documentNumber,
    invoiceDateLabel: formatPdfDateLong(meta.generated_at),
    // Boilerplate notice is template copy (Stage 36), not a financial snapshot field.
    noticeLines: INVOICE_NOTICE_LINES,
    payment: resolvePayment(meta.payment_profile, supplier),
    supplierLine: formatSupplierLine(supplier),
    buyerLine: formatBuyerLine(buyer, variant),
    basisLine: formatBasisLine(basis, order),
    items,
    taxMode,
    vatRateLabel,
    vatAmount: totals.vat_amount,
    finalTotal,
    itemCount: Number.isFinite(itemCount) ? itemCount : items.length,
    amountWords,
    totalLine: formatPdfMoneyPlain(finalTotal),
    directorName: present(supplier.director_name),
    issuedDateLabel: formatPdfDateLong(meta.generated_at),
    images,
  };
}
