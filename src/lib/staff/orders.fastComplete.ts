import type { OrderStatus } from "@/types/database";

/** Statuses from which manager/admin may start staff_fast_complete_order. */
export const FAST_COMPLETE_ELIGIBLE_STATUSES: readonly OrderStatus[] = [
  "paid",
  "picking",
  "ready_for_shipment",
  "shipped",
];

/**
 * UI gate for «Быстро завершить». Backend still enforces role + payment + guards.
 * Does not grant warehouse/accountant a new manager action.
 */
export function canStaffFastCompleteOrder(input: {
  status: OrderStatus;
  role: string | null | undefined;
  hasItems: boolean;
}): boolean {
  if (input.role !== "manager" && input.role !== "admin") {
    return false;
  }
  if (!input.hasItems) {
    return false;
  }
  return (FAST_COMPLETE_ELIGIBLE_STATUSES as readonly string[]).includes(input.status);
}

/**
 * Remaining status steps the orchestration will perform from current status.
 * Mirrors staff_fast_complete_order (resume from current, no rewind).
 */
export function getFastCompleteRemainingSteps(status: OrderStatus): OrderStatus[] {
  switch (status) {
    case "paid":
      return ["picking", "ready_for_shipment", "shipped", "completed"];
    case "picking":
      return ["ready_for_shipment", "shipped", "completed"];
    case "ready_for_shipment":
      return ["shipped", "completed"];
    case "shipped":
      return ["completed"];
    default:
      return [];
  }
}
