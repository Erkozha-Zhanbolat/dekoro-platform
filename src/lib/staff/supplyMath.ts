import type { ProductSupplyCurrency } from "@/types/database";

/** Pure helpers for Stage 40 FX / receiving math (deterministic, no DB). */
export function supplyAmountKzt(
  amount: number | null,
  currency: ProductSupplyCurrency,
  rate: number | null,
): number | null {
  if (amount == null) return null;
  if (currency === "KZT") return amount;
  if (rate == null || rate <= 0) return null;
  return amount * rate;
}

export function supplyAcceptedQuantity(
  received: number | null,
  damaged: number,
): number | null {
  if (received == null) return null;
  return received - damaged;
}

export function supplyReceivingDifference(
  received: number | null,
  expected: number,
): number | null {
  if (received == null) return null;
  return received - expected;
}
