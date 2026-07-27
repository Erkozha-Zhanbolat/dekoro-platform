"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { CartItem } from "@/context/CartContext";

export type FulfillmentType = "pickup" | "customer_transport";

export const FULFILLMENT_LABELS: Record<FulfillmentType, string> = {
  pickup: "Самовывоз со склада DEKORO",
  customer_transport: "Забор транспортом клиента",
};

export type OrderStatus = "На проверке";

export type PaymentStatus = "not_invoiced" | "awaiting_payment" | "paid";

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  not_invoiced: "Счёт ещё не выставлен",
  awaiting_payment: "Ожидает оплаты",
  paid: "Оплачено",
};

export interface Order {
  id: string;
  orderNumber: string;
  createdAt: string;
  status: OrderStatus;
  companyName: string;
  bin: string;
  contactPerson: string;
  phone: string;
  email: string;
  fulfillmentType: FulfillmentType;
  pickupComment: string;
  comment: string;
  paymentStatus: PaymentStatus;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  items: CartItem[];
  knownTotal: number;
  hasUnpricedItems: boolean;
}

export type CreateOrderInput = Omit<
  Order,
  | "id"
  | "orderNumber"
  | "createdAt"
  | "status"
  | "paymentStatus"
  | "invoiceNumber"
  | "invoiceDate"
>;

interface OrderContextValue {
  orders: Order[];
  createOrder: (input: CreateOrderInput) => Order;
  getOrderById: (id: string) => Order | undefined;
}

const OrderContext = createContext<OrderContextValue | undefined>(undefined);

function createOrderNumber(createdAt: Date, sequence: number): string {
  const year = createdAt.getFullYear();
  const paddedSequence = String(sequence).padStart(4, "0");
  return `DK-${year}-${paddedSequence}`;
}

export function OrderProvider({ children }: { children: ReactNode }) {
  const [orders, setOrders] = useState<Order[]>([]);

  const createOrder = useCallback(
    (input: CreateOrderInput): Order => {
      const createdAt = new Date();
      const order: Order = {
        ...input,
        id: `order-${createdAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        orderNumber: createOrderNumber(createdAt, orders.length + 1),
        createdAt: createdAt.toISOString(),
        status: "На проверке",
        paymentStatus: "not_invoiced",
        invoiceNumber: null,
        invoiceDate: null,
      };

      setOrders((current) => [...current, order]);

      return order;
    },
    [orders],
  );

  const getOrderById = useCallback(
    (id: string) => orders.find((order) => order.id === id),
    [orders],
  );

  const value = useMemo<OrderContextValue>(
    () => ({ orders, createOrder, getOrderById }),
    [orders, createOrder, getOrderById],
  );

  return <OrderContext.Provider value={value}>{children}</OrderContext.Provider>;
}

export function useOrders(): OrderContextValue {
  const context = useContext(OrderContext);
  if (!context) {
    throw new Error("useOrders должен использоваться внутри OrderProvider");
  }
  return context;
}
