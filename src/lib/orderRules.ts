import type { Order } from "@/context/OrderContext";

/**
 * Склад не начинает сборку заказа до подтверждения 100% оплаты.
 */
export function canSendToWarehouse(order: Order): boolean {
  return order.paymentStatus === "paid";
}
