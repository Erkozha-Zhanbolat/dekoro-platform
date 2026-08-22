/**
 * Deterministic procurement recommendation (Stage 44).
 * Pure functions — the live UI applies this to staff_get_procurement_snapshot().
 *
 * Windows match the director dashboard calendar convention (Asia/Almaty):
 * 7d = today + previous 6 days, 30d = today + previous 29, 90d = today + previous 89.
 *
 * A window is included in the weighted average only when historyDays >= window
 * (do not pretend a 12-day product has a 90-day baseline). Thin history
 * (< 7 days) still produces a number, but status is insufficient_history.
 */

export const DEFAULT_LEAD_TIME_DAYS = 60;
export const DEFAULT_SAFETY_STOCK_DAYS = 14;
export const DEFAULT_VELOCITY_WEIGHT_7 = 0.5;
export const DEFAULT_VELOCITY_WEIGHT_30 = 0.3;
export const DEFAULT_VELOCITY_WEIGHT_90 = 0.2;

export type ProcurementRecommendationStatus =
  | "insufficient_history"
  | "in_transit"
  | "critical"
  | "recommend"
  | "order_soon"
  | "watch"
  | "sufficient"
  | "slow";

export const PROCUREMENT_STATUS_LABELS: Record<ProcurementRecommendationStatus, string> = {
  insufficient_history: "Недостаточно истории",
  in_transit: "Уже едет",
  critical: "Критический остаток",
  recommend: "Рекомендуется заказать",
  order_soon: "Скоро заказывать",
  watch: "Наблюдать",
  sufficient: "Достаточный запас",
  slow: "Медленные продажи",
};

export type ProcurementWeights = {
  weight7: number;
  weight30: number;
  weight90: number;
};

export type ProcurementMathInput = {
  sales7: number;
  sales30: number;
  sales90: number;
  historyDays: number;
  availableQty: number;
  incomingQty: number;
  leadTimeDays: number;
  safetyStockDays: number;
  weights: ProcurementWeights;
};

export type ProcurementMathResult = {
  daily7: number;
  daily30: number;
  daily90: number;
  usedWeight7: number;
  usedWeight30: number;
  usedWeight90: number;
  avgDailySales: number;
  coverageDays: number;
  targetStock: number;
  effectiveStock: number;
  recommendedQty: number;
  daysOfStock: number | null;
  status: ProcurementRecommendationStatus;
  reason: string;
};

function nonNeg(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function coverageDays(leadTimeDays: number, safetyStockDays: number): number {
  return Math.max(0, leadTimeDays) + Math.max(0, safetyStockDays);
}

export function historyAwareDailyRate(
  sales: number,
  windowDays: number,
  historyDays: number,
): number {
  const denom = Math.min(windowDays, Math.max(historyDays, 1));
  return nonNeg(sales) / denom;
}

/**
 * Incomplete long windows are dropped so a 12-day product does not get a
 * fake 90-day baseline (sales90 would equal sales30 and double-count).
 */
export function effectiveVelocityWeights(
  historyDays: number,
  weights: ProcurementWeights,
): ProcurementWeights {
  const w7 = Math.max(0, weights.weight7);
  const w30 = historyDays >= 30 ? Math.max(0, weights.weight30) : 0;
  const w90 = historyDays >= 90 ? Math.max(0, weights.weight90) : 0;
  if (w7 + w30 + w90 > 0) {
    return { weight7: w7, weight30: w30, weight90: w90 };
  }
  return { weight7: 1, weight30: 0, weight90: 0 };
}

export function averageDailySales(
  sales7: number,
  sales30: number,
  sales90: number,
  historyDays: number,
  weights: ProcurementWeights,
): {
  daily7: number;
  daily30: number;
  daily90: number;
  used: ProcurementWeights;
  avgDailySales: number;
} {
  const used = effectiveVelocityWeights(historyDays, weights);
  const daily7 = historyAwareDailyRate(sales7, 7, historyDays);
  const daily30 = historyAwareDailyRate(sales30, 30, historyDays);
  const daily90 = historyAwareDailyRate(sales90, 90, historyDays);
  const sumW = used.weight7 + used.weight30 + used.weight90;
  const avgDailySales =
    sumW <= 0
      ? 0
      : (used.weight7 * daily7 + used.weight30 * daily30 + used.weight90 * daily90) / sumW;
  return { daily7, daily30, daily90, used, avgDailySales };
}

export function computeProcurementMath(input: ProcurementMathInput): ProcurementMathResult {
  const historyDays = Math.max(0, Math.floor(input.historyDays));
  const availableQty = nonNeg(input.availableQty);
  const incomingQty = nonNeg(input.incomingQty);
  const leadTimeDays = Math.max(0, input.leadTimeDays);
  const safetyStockDays = Math.max(0, input.safetyStockDays);

  const { daily7, daily30, daily90, used, avgDailySales } = averageDailySales(
    input.sales7,
    input.sales30,
    input.sales90,
    historyDays,
    input.weights,
  );

  const cover = coverageDays(leadTimeDays, safetyStockDays);
  const targetStock = Math.ceil(avgDailySales * cover);
  const effectiveStock = availableQty + incomingQty;
  const recommendedQty = Math.max(0, targetStock - effectiveStock);
  const daysOfStock =
    avgDailySales <= 0 ? (effectiveStock > 0 ? null : 0) : effectiveStock / avgDailySales;

  const thinHistory = historyDays < 7;
  const days = daysOfStock;
  const coverWithSafety = cover;
  const leadOnly = leadTimeDays;

  let status: ProcurementRecommendationStatus;
  let reason: string;

  if (thinHistory && !(availableQty <= 0 && incomingQty <= 0 && avgDailySales > 0)) {
    status = "insufficient_history";
    reason =
      historyDays <= 0
        ? "Нет продаж и товар слишком новый — нет устойчивой скорости."
        : `История ${historyDays} дн. — меньше недели. Цифра ориентировочная.`;
  } else if (incomingQty > 0 && recommendedQty <= 0 && (days == null || days < leadOnly || availableQty <= 0)) {
    status = "in_transit";
    reason = `В пути ${incomingQty} шт. закрывают потребность на срок поставки.`;
  } else if (recommendedQty > 0 && (days != null && days < safetyStockDays || (availableQty <= 0 && incomingQty <= 0))) {
    status = "critical";
    reason = "Доступного остатка не хватает на страховой запас.";
  } else if (recommendedQty > 0) {
    status = "recommend";
    reason = `Целевой запас ${targetStock} шт. на ${cover} дн. покрытия; эффективный остаток ${effectiveStock}.`;
  } else if (days != null && days < leadOnly) {
    status = "order_soon";
    reason = "Запаса меньше планового срока поставки, но после входящих дефицита нет.";
  } else if (days != null && days < coverWithSafety) {
    status = "watch";
    reason = "Запас покрывает срок поставки, но без полного страхового запаса.";
  } else if (avgDailySales <= 0 && effectiveStock > 0) {
    status = "slow";
    reason = "Продаж в окне нет, закупка не нужна.";
  } else {
    status = "sufficient";
    reason = "Доступно + в пути покрывает целевой запас.";
  }

  return {
    daily7,
    daily30,
    daily90,
    usedWeight7: used.weight7,
    usedWeight30: used.weight30,
    usedWeight90: used.weight90,
    avgDailySales,
    coverageDays: cover,
    targetStock,
    effectiveStock,
    recommendedQty,
    daysOfStock,
    status,
    reason,
  };
}

export function preferredCatalogId(
  productCatalogIds: string[],
  uniqueRecommendedQtyByCatalog: Map<string, number>,
  uniqueSkuCountByCatalog: Map<string, number>,
  sortOrderByCatalog: Map<string, number>,
): string | null {
  if (productCatalogIds.length === 0) return null;
  if (productCatalogIds.length === 1) return productCatalogIds[0] ?? null;

  const ranked = [...productCatalogIds].sort((a, b) => {
    const qtyA = uniqueRecommendedQtyByCatalog.get(a) ?? 0;
    const qtyB = uniqueRecommendedQtyByCatalog.get(b) ?? 0;
    if (qtyA !== qtyB) return qtyB - qtyA;
    const skuA = uniqueSkuCountByCatalog.get(a) ?? 0;
    const skuB = uniqueSkuCountByCatalog.get(b) ?? 0;
    if (skuA !== skuB) return skuB - skuA;
    const soA = sortOrderByCatalog.get(a) ?? 0;
    const soB = sortOrderByCatalog.get(b) ?? 0;
    if (soA !== soB) return soA - soB;
    return a.localeCompare(b);
  });
  return ranked[0] ?? null;
}
