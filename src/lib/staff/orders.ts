import { supabase } from "@/lib/supabase/client";
import type {
  DeliveryType,
  OrderActivityEventType,
  OrderStatus,
  StaffCreateOrderResult,
  StaffOrderMutationResult,
} from "@/types/database";
import { ORDER_STATUS_LABELS, ORDER_WORKFLOW_STATUSES } from "@/types/database";

/**
 * Staff-facing order data access (migrations 010–012).
 *
 * Orders / order_items reads use RLS staff SELECT from 010.
 * order_status_history and order_internal_notes have NO table grants —
 * they are read only via staff_list_* SECURITY DEFINER RPCs.
 */

export type StaffOrderListItem = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total: number;
  delivery_type: DeliveryType;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  assigned_manager_id: string | null;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  itemCount: number;
  totalQuantity: number;
};

type StaffOrderListRow = {
  id: string;
  order_number: string;
  created_at: string;
  status: OrderStatus;
  total: number;
  delivery_type: DeliveryType;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  assigned_manager_id: string | null;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  order_items: { quantity: number }[] | null;
};

function mapListRow(row: StaffOrderListRow): StaffOrderListItem {
  const items = row.order_items ?? [];
  return {
    id: row.id,
    order_number: row.order_number,
    created_at: row.created_at,
    status: row.status,
    total: Number(row.total),
    delivery_type: row.delivery_type,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    contact_email: row.contact_email,
    assigned_manager_id: row.assigned_manager_id,
    payment_due_at: row.payment_due_at,
    reservation_expires_at: row.reservation_expires_at,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

function escapeIlikeValue(value: string): string {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

export type StaffOrdersQuery = {
  search?: string;
  status?: OrderStatus | "all";
  limit?: number;
};

const DEFAULT_STAFF_ORDERS_LIMIT = 100;

export async function getStaffOrders(
  query: StaffOrdersQuery = {},
): Promise<StaffOrderListItem[]> {
  let request = supabase
    .from("orders")
    .select(
      "id, order_number, created_at, status, total, delivery_type, contact_name, contact_phone, contact_email, assigned_manager_id, payment_due_at, reservation_expires_at, order_items(quantity)",
    )
    .order("created_at", { ascending: false })
    .limit(query.limit ?? DEFAULT_STAFF_ORDERS_LIMIT);

  if (query.status && query.status !== "all") {
    request = request.eq("status", query.status);
  }

  const search = query.search?.trim();
  if (search) {
    const escaped = escapeIlikeValue(search);
    request = request.or(
      [
        `order_number.ilike.%${escaped}%`,
        `contact_name.ilike.%${escaped}%`,
        `contact_phone.ilike.%${escaped}%`,
        `contact_email.ilike.%${escaped}%`,
      ].join(","),
    );
  }

  const { data, error } = await request;

  if (error) {
    throw new Error(error.message || "Не удалось загрузить заказы");
  }

  return ((data as StaffOrderListRow[] | null) ?? []).map(mapListRow);
}

export type StaffOrderDetailItem = {
  id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total: number;
};

export type StaffOrderStatusHistoryItem = {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_by: string;
  changed_by_name: string | null;
  note: string | null;
  created_at: string;
};

export type StaffOrderInternalNoteItem = {
  id: string;
  order_id: string;
  body: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  updated_at: string | null;
};

export type StaffOrderActivityItem = {
  id: string;
  order_id: string;
  event_type: OrderActivityEventType;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
};

export type StaffOrderDetail = {
  id: string;
  order_number: string;
  created_at: string;
  updated_at: string;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  comment: string | null;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  delivery_type: DeliveryType;
  delivery_address: string | null;
  delivery_comment: string | null;
  assigned_manager_id: string | null;
  assigned_manager_name: string | null;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  items: StaffOrderDetailItem[];
  statusHistory: StaffOrderStatusHistoryItem[];
  activityLog: StaffOrderActivityItem[];
  internalNotes: StaffOrderInternalNoteItem[];
};

type StaffOrderDetailRow = {
  id: string;
  order_number: string;
  created_at: string;
  updated_at: string;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  comment: string | null;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  delivery_type: DeliveryType;
  delivery_address: string | null;
  delivery_comment: string | null;
  assigned_manager_id: string | null;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  order_items: StaffOrderDetailItem[] | null;
};

export async function getStaffOrderById(id: string): Promise<StaffOrderDetail | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_number, created_at, updated_at, status, subtotal, discount, total, comment, contact_name, contact_phone, contact_email, delivery_type, delivery_address, delivery_comment, assigned_manager_id, payment_due_at, reservation_expires_at, order_items(id, product_id, product_name, quantity, unit_price, total:line_total)",
    )
    .eq("id", id)
    .single();

  if (error) {
    if (error.code === "PGRST116" || error.code === "22P02") {
      return null;
    }
    throw new Error(error.message || "Не удалось загрузить заказ");
  }

  const row = data as StaffOrderDetailRow;
  const items = row.order_items ?? [];

  const [history, notes, activity, assigneeName] = await Promise.all([
    listStaffOrderStatusHistory(id),
    listStaffOrderInternalNotes(id),
    listStaffOrderActivity(id),
    (async () => {
      const { data, error: nameError } = await supabase.rpc("staff_get_order_assignee_name", {
        p_order_id: id,
      });
      if (nameError) {
        return null;
      }
      return (data as string | null) ?? null;
    })(),
  ]);

  return {
    id: row.id,
    order_number: row.order_number,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    subtotal: Number(row.subtotal),
    discount: Number(row.discount),
    total: Number(row.total),
    comment: row.comment,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    contact_email: row.contact_email,
    delivery_type: row.delivery_type,
    delivery_address: row.delivery_address,
    delivery_comment: row.delivery_comment,
    assigned_manager_id: row.assigned_manager_id,
    assigned_manager_name: assigneeName,
    payment_due_at: row.payment_due_at,
    reservation_expires_at: row.reservation_expires_at,
    items: items.map((item) => ({
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
      total: Number(item.total),
    })),
    statusHistory: history,
    activityLog: activity,
    internalNotes: notes,
  };
}

export type StaffOrderStats = Record<OrderStatus, number> & { total: number };

export async function getStaffOrderStats(): Promise<StaffOrderStats> {
  const { data, error } = await supabase.from("orders").select("status");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить статистику заказов");
  }

  const rows = (data as { status: OrderStatus }[] | null) ?? [];
  const stats: StaffOrderStats = {
    total: rows.length,
    new: 0,
    awaiting_payment: 0,
    paid: 0,
    picking: 0,
    ready_for_shipment: 0,
    shipped: 0,
    completed: 0,
    cancelled: 0,
  };

  for (const row of rows) {
    stats[row.status] += 1;
  }

  return stats;
}

export type StaffManagerOption = {
  id: string;
  full_name: string;
  role: "manager" | "admin";
};

export async function listAssignableManagers(): Promise<StaffManagerOption[]> {
  const { data, error } = await supabase.rpc("staff_list_assignable_managers");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить список менеджеров");
  }

  return ((data as StaffManagerOption[] | null) ?? []).map((row) => ({
    id: row.id,
    full_name: row.full_name,
    role: row.role as "manager" | "admin",
  }));
}

export async function listStaffOrderStatusHistory(
  orderId: string,
): Promise<StaffOrderStatusHistoryItem[]> {
  const { data, error } = await supabase.rpc("staff_list_order_status_history", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить историю статусов");
  }

  return ((data as StaffOrderStatusHistoryItem[] | null) ?? []).map((entry) => ({
    id: entry.id,
    order_id: entry.order_id,
    from_status: entry.from_status,
    to_status: entry.to_status,
    changed_by: entry.changed_by,
    changed_by_name: entry.changed_by_name,
    note: entry.note,
    created_at: entry.created_at,
  }));
}

export async function listStaffOrderInternalNotes(
  orderId: string,
): Promise<StaffOrderInternalNoteItem[]> {
  const { data, error } = await supabase.rpc("staff_list_order_internal_notes", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить заметки");
  }

  return ((data as StaffOrderInternalNoteItem[] | null) ?? []).map((note) => ({
    id: note.id,
    order_id: note.order_id,
    body: note.body,
    created_by: note.created_by,
    created_by_name: note.created_by_name,
    created_at: note.created_at,
    updated_at: note.updated_at,
  }));
}

export async function listStaffOrderActivity(
  orderId: string,
): Promise<StaffOrderActivityItem[]> {
  const { data, error } = await supabase.rpc("staff_list_order_activity", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить активность заказа");
  }

  return ((data as StaffOrderActivityItem[] | null) ?? []).map((entry) => ({
    id: entry.id,
    order_id: entry.order_id,
    event_type: entry.event_type,
    description: entry.description,
    metadata: entry.metadata,
    created_by: entry.created_by,
    created_by_name: entry.created_by_name,
    created_at: entry.created_at,
  }));
}

export async function createStaffOrder(
  clientProfileId: string,
): Promise<StaffCreateOrderResult> {
  const { data, error } = await supabase.rpc("staff_create_order", {
    p_client_profile_id: clientProfileId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось создать заказ");
  }

  const [result] = (data as StaffCreateOrderResult[] | null) ?? [];
  if (!result) {
    throw new Error("Не удалось создать заказ");
  }
  return result;
}

export async function createStaffOrderForCustomer(
  customerId: string,
): Promise<StaffCreateOrderResult> {
  const { data, error } = await supabase.rpc("staff_create_order_for_customer", {
    p_customer_id: customerId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось создать заказ");
  }

  const [result] = (data as StaffCreateOrderResult[] | null) ?? [];
  if (!result) {
    throw new Error("Не удалось создать заказ");
  }
  return result;
}

export async function addStaffOrderItem(
  orderId: string,
  productId: string,
  quantity: number,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_add_order_item", {
    p_order_id: orderId,
    p_product_id: productId,
    p_quantity: quantity,
  });
  if (error) {
    throw new Error(error.message || "Не удалось добавить товар");
  }
  return data as StaffOrderMutationResult;
}

export async function updateStaffOrderItemQuantity(
  orderItemId: string,
  quantity: number,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_update_order_item_quantity", {
    p_order_item_id: orderItemId,
    p_quantity: quantity,
  });
  if (error) {
    throw new Error(error.message || "Не удалось изменить количество");
  }
  return data as StaffOrderMutationResult;
}

export async function removeStaffOrderItem(
  orderItemId: string,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_remove_order_item", {
    p_order_item_id: orderItemId,
  });
  if (error) {
    throw new Error(error.message || "Не удалось удалить позицию");
  }
  return data as StaffOrderMutationResult;
}

export async function changeStaffOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  note?: string | null,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_change_order_status", {
    p_order_id: orderId,
    p_new_status: newStatus,
    p_note: note ?? null,
  });
  if (error) {
    throw new Error(error.message || "Не удалось изменить статус заказа");
  }
  return data as StaffOrderMutationResult;
}

export async function cancelStaffOrder(
  orderId: string,
  note: string,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_cancel_order", {
    p_order_id: orderId,
    p_note: note,
  });
  if (error) {
    throw new Error(error.message || "Не удалось отменить заказ");
  }
  return data as StaffOrderMutationResult;
}

export async function addStaffOrderNote(
  orderId: string,
  body: string,
): Promise<StaffOrderInternalNoteItem> {
  const { data, error } = await supabase.rpc("staff_add_order_note", {
    p_order_id: orderId,
    p_body: body,
  });
  if (error) {
    throw new Error(error.message || "Не удалось добавить заметку");
  }
  const row = data as {
    id: string;
    order_id: string;
    body: string;
    created_by: string;
    created_at: string;
    updated_at: string | null;
  };
  return {
    id: row.id,
    order_id: row.order_id,
    body: row.body,
    created_by: row.created_by,
    created_by_name: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function assignStaffOrderManager(
  orderId: string,
  managerId: string | null,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_assign_order_manager", {
    p_order_id: orderId,
    p_manager_id: managerId,
  });
  if (error) {
    throw new Error(error.message || "Не удалось назначить менеджера");
  }
  return data as StaffOrderMutationResult;
}

export async function updateStaffOrderDeadlines(
  orderId: string,
  paymentDueAt: string | null,
  reservationExpiresAt: string | null,
): Promise<StaffOrderMutationResult> {
  const { data, error } = await supabase.rpc("staff_update_order_deadlines", {
    p_order_id: orderId,
    p_payment_due_at: paymentDueAt,
    p_reservation_expires_at: reservationExpiresAt,
  });
  if (error) {
    throw new Error(error.message || "Не удалось обновить сроки");
  }
  return data as StaffOrderMutationResult;
}

export function getAllowedStatusTransitions(from: OrderStatus): OrderStatus[] {
  const map: Record<OrderStatus, OrderStatus[]> = {
    new: ["awaiting_payment"],
    awaiting_payment: ["paid", "new"],
    paid: ["picking"],
    picking: ["ready_for_shipment", "paid"],
    ready_for_shipment: ["shipped", "picking"],
    shipped: ["completed"],
    completed: [],
    cancelled: [],
  };
  return map[from];
}

export function getStatusTransitionLabel(from: OrderStatus, to: OrderStatus): string {
  const labels: Record<string, string> = {
    "new->awaiting_payment": "На оплату",
    "awaiting_payment->paid": "Оплата получена",
    "awaiting_payment->new": "Вернуть в новые",
    "paid->picking": "В сборку",
    "picking->ready_for_shipment": "Готов к отгрузке",
    "picking->paid": "Вернуть в оплаченные",
    "ready_for_shipment->shipped": "Отгрузить",
    "ready_for_shipment->picking": "Вернуть в сборку",
    "shipped->completed": "Завершить",
  };
  return labels[`${from}->${to}`] ?? `→ ${ORDER_STATUS_LABELS[to]}`;
}

export function canStaffCancelOrder(
  status: OrderStatus,
  role: string | null | undefined,
): boolean {
  if (role !== "manager" && role !== "admin") {
    return false;
  }
  if (status === "new" || status === "awaiting_payment") {
    return true;
  }
  if (status === "paid" || status === "picking" || status === "ready_for_shipment") {
    return role === "admin";
  }
  return false;
}

export function isDeadlineOverdue(iso: string | null, now = new Date()): boolean {
  if (!iso) {
    return false;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getTime() < now.getTime();
}

export const STAFF_STATUS_FILTER_OPTIONS: { value: OrderStatus | "all"; label: string }[] = [
  { value: "all", label: "Все статусы" },
  ...ORDER_WORKFLOW_STATUSES.map((status) => ({
    value: status,
    label: ORDER_STATUS_LABELS[status],
  })),
  { value: "cancelled", label: ORDER_STATUS_LABELS.cancelled },
];
