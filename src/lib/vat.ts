/**
 * Document VAT helpers for DEKORO commercial documents.
 *
 * Catalog / order line prices and orders.total are treated as the customer-facing
 * amount already including VAT when tax_mode = with_vat. VAT is extracted, not added:
 *
 *   vat_amount = round(amount_with_vat * vat_rate / (100 + vat_rate), 2)
 *   amount_without_vat = amount_with_vat - vat_amount
 *   final_total = amount_with_vat
 *
 * Must stay in sync with public.staff_build_document_metadata (migration 040+).
 */

export type DocumentVatBreakdown = {
  amountWithVat: number;
  amountWithoutVat: number;
  vatAmount: number;
  finalTotal: number;
  vatRate: number;
  pricesIncludeVat: boolean;
};

/** Round half-up to 2 decimal places (matches Postgres round(numeric, 2) for money). */
export function roundMoney2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Некорректная денежная сумма");
  }
  return Math.round(value * 100) / 100;
}

/**
 * Extract VAT from an inclusive amount.
 * For rate 16: amount * 16 / 116.
 * For without_vat / rate 0: VAT = 0, totals unchanged.
 */
export function extractVatFromInclusive(
  amountWithVat: number,
  vatRate: number,
): DocumentVatBreakdown {
  if (!Number.isFinite(amountWithVat) || amountWithVat < 0) {
    throw new Error("Некорректная сумма с НДС");
  }
  if (!Number.isFinite(vatRate) || vatRate < 0 || vatRate > 100) {
    throw new Error("Некорректная ставка НДС");
  }

  const total = roundMoney2(amountWithVat);

  if (vatRate === 0) {
    return {
      amountWithVat: total,
      amountWithoutVat: total,
      vatAmount: 0,
      finalTotal: total,
      vatRate: 0,
      pricesIncludeVat: true,
    };
  }

  const vatAmount = roundMoney2((total * vatRate) / (100 + vatRate));
  const amountWithoutVat = roundMoney2(total - vatAmount);

  return {
    amountWithVat: total,
    amountWithoutVat,
    vatAmount,
    finalTotal: total,
    vatRate,
    pricesIncludeVat: true,
  };
}
