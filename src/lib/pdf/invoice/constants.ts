/** Compact KZ invoice layout — A4 portrait, mm converted at 72/25.4 pt. */

export const MM = 72 / 25.4;

export const INVOICE_PAGE = {
  width: 595.28,
  height: 841.89,
  marginTop: 9 * MM,
  marginBottom: 11 * MM,
  marginX: 11 * MM,
} as const;

export const INVOICE_NOTICE_LINES = [
  "Оплата настоящего счета означает согласие с условиями заказа.",
  "Товар резервируется и передается в сборку после подтверждения поступления оплаты.",
  "Срок и способ отгрузки согласовываются с менеджером DEKORO.",
] as const;

export const INVOICE_COL = {
  no: "5%",
  sku: "13%",
  name: "44%",
  qty: "8%",
  unit: "6%",
  price: "12%",
  sum: "12%",
} as const;

export const INVOICE_TYPE = {
  noticeFont: 6.75,
  noticeLineHeight: 1.12,
  bodyFont: 8,
  bodyLineHeight: 1.12,
  titleFont: 13,
  tableFont: 7.5,
  tableHeaderFont: 7,
  tableLineHeight: 1.1,
  tablePadY: 1.2,
  tablePadX: 2,
  tableBorder: 0.5,
  partyLabelWidth: 70,
  bankLabelFont: 6.5,
  bankValueFont: 8,
  bankPadY: 2.5,
  bankPadX: 3.5,
  stampSize: 48,
  signatureWidth: 92,
  signatureHeight: 36,
} as const;

export function invoiceContentWidth(): number {
  return INVOICE_PAGE.width - INVOICE_PAGE.marginX * 2;
}

export function invoiceContentHeight(): number {
  return INVOICE_PAGE.height - INVOICE_PAGE.marginTop - INVOICE_PAGE.marginBottom;
}
