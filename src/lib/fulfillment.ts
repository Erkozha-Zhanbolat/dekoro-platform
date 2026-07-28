/**
 * Fulfillment options currently reachable from the checkout UI. Distinct
 * from public.orders.delivery_type / DeliveryType (src/types/database.ts),
 * which additionally allows "delivery" for a future courier-delivery flow
 * that checkout does not expose yet.
 */
export type FulfillmentType = "pickup" | "customer_transport";

export const FULFILLMENT_LABELS: Record<FulfillmentType, string> = {
  pickup: "Самовывоз со склада DEKORO",
  customer_transport: "Забор транспортом клиента",
};
