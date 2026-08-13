import { supabase } from "@/lib/supabase/client";
import type {
  CustomerType,
  DeliveryType,
  OrderDocumentStatus,
  OrderStatus,
  PickingTaskStatus,
  WarehouseActivityEventType,
  WarehouseOrderActivityItem,
  WarehouseOrderListItem,
  WarehouseOrderPickingDetails,
  WarehouseQueueStatus,
  WarehouseShipmentHistoryItem,
  WarehouseShipmentHistoryOrder,
} from "@/types/database";
import { WAREHOUSE_QUEUE_STATUSES } from "@/types/database";

/**
 * Warehouse queue + picking (migration 017).
 * All reads/writes go through SECURITY DEFINER RPCs — no direct table access.
 */

export type WarehouseListQuery = {
  status?: WarehouseQueueStatus | "all";
  search?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 50;

function mapListRow(row: Record<string, unknown>): WarehouseOrderListItem {
  const status = row.status as WarehouseQueueStatus;
  return {
    order_id: String(row.order_id),
    order_number: String(row.order_number),
    customer_display_name: String(row.customer_display_name ?? ""),
    delivery_type: row.delivery_type as DeliveryType,
    status,
    total_item_count: Number(row.total_item_count ?? 0),
    completed_item_count: Number(row.completed_item_count ?? 0),
    picking_task_status: (row.picking_task_status as PickingTaskStatus | null) ?? null,
    assigned_to: (row.assigned_to as string | null) ?? null,
    assigned_to_name: (row.assigned_to_name as string | null) ?? null,
    created_at: String(row.created_at),
    payment_due_at: (row.payment_due_at as string | null) ?? null,
    reservation_expires_at: (row.reservation_expires_at as string | null) ?? null,
    total: Number(row.total ?? 0),
  };
}

export async function listWarehouseOrders(
  query: WarehouseListQuery = {},
): Promise<WarehouseOrderListItem[]> {
  const status =
    query.status && query.status !== "all" && WAREHOUSE_QUEUE_STATUSES.includes(query.status)
      ? query.status
      : null;

  const { data, error } = await supabase.rpc("warehouse_list_orders", {
    p_status: status,
    p_limit: query.limit ?? DEFAULT_LIMIT,
    p_search: query.search?.trim() || null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить складскую очередь");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map(mapListRow);
}

function mapPickingDetails(raw: Record<string, unknown>): WarehouseOrderPickingDetails {
  const order = raw.order as Record<string, unknown>;
  const customer = raw.customer as Record<string, unknown> | null;
  const manager = raw.manager as Record<string, unknown> | null;
  const task = raw.picking_task as Record<string, unknown> | null;
  const progress = (raw.progress as Record<string, unknown> | null) ?? {};
  const deliveryNote = raw.delivery_note as Record<string, unknown> | null;

  const pickingItems = ((raw.picking_items as Record<string, unknown>[] | null) ?? []).map(
    (item) => ({
      id: String(item.id),
      picking_task_id: String(item.picking_task_id),
      order_item_id: String(item.order_item_id),
      product_id: String(item.product_id),
      product_name: String(item.product_name ?? ""),
      product_sku: (item.product_sku as string | null) ?? null,
      required_quantity: Number(item.required_quantity ?? 0),
      picked_quantity: Number(item.picked_quantity ?? 0),
      is_completed: Boolean(item.is_completed),
      completed_by: (item.completed_by as string | null) ?? null,
      completed_at: (item.completed_at as string | null) ?? null,
    }),
  );

  const orderItems = ((raw.order_items as Record<string, unknown>[] | null) ?? []).map((item) => ({
    id: String(item.id),
    product_id: String(item.product_id),
    product_name: String(item.product_name ?? ""),
    product_sku: (item.product_sku as string | null) ?? null,
    quantity: Number(item.quantity ?? 0),
  }));

  return {
    order: {
      id: String(order.id),
      order_number: String(order.order_number),
      status: order.status as OrderStatus,
      total: Number(order.total ?? 0),
      delivery_type: order.delivery_type as DeliveryType,
      contact_name: String(order.contact_name ?? ""),
      contact_phone: String(order.contact_phone ?? ""),
      contact_email: (order.contact_email as string | null) ?? null,
      delivery_address: (order.delivery_address as string | null) ?? null,
      delivery_comment: (order.delivery_comment as string | null) ?? null,
      comment: (order.comment as string | null) ?? null,
      payment_due_at: (order.payment_due_at as string | null) ?? null,
      reservation_expires_at: (order.reservation_expires_at as string | null) ?? null,
      created_at: String(order.created_at),
      updated_at: String(order.updated_at),
      assigned_manager_id: (order.assigned_manager_id as string | null) ?? null,
      customer_id: String(order.customer_id),
    },
    customer: customer
      ? {
          id: String(customer.id),
          display_name: String(customer.display_name ?? ""),
          phone: (customer.phone as string | null) ?? null,
          email: (customer.email as string | null) ?? null,
          customer_type: customer.customer_type as CustomerType,
        }
      : null,
    manager: manager
      ? {
          id: String(manager.id),
          full_name: String(manager.full_name ?? ""),
        }
      : null,
    picking_task: task
      ? {
          id: String(task.id),
          order_id: String(task.order_id),
          warehouse_id: String(task.warehouse_id),
          status: task.status as PickingTaskStatus,
          assigned_to: (task.assigned_to as string | null) ?? null,
          assigned_to_name: (task.assigned_to_name as string | null) ?? null,
          started_at: (task.started_at as string | null) ?? null,
          completed_at: (task.completed_at as string | null) ?? null,
          created_at: String(task.created_at),
          updated_at: String(task.updated_at),
        }
      : null,
    picking_items: pickingItems,
    order_items: orderItems,
    delivery_note: deliveryNote
      ? {
          id: String(deliveryNote.id),
          number: String(deliveryNote.number),
          status: deliveryNote.status as OrderDocumentStatus,
          generated_at: String(deliveryNote.generated_at),
          printed_at: (deliveryNote.printed_at as string | null) ?? null,
        }
      : null,
    progress: {
      total: Number(progress.total ?? 0),
      completed: Number(progress.completed ?? 0),
    },
  };
}

export async function getWarehouseOrderPicking(
  orderId: string,
): Promise<WarehouseOrderPickingDetails> {
  const { data, error } = await supabase.rpc("warehouse_get_order_picking", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить карточку сборки");
  }

  if (!data || typeof data !== "object") {
    throw new Error("Пустой ответ карточки сборки");
  }

  return mapPickingDetails(data as Record<string, unknown>);
}

export async function startOrderPicking(orderId: string): Promise<void> {
  const { error } = await supabase.rpc("staff_start_order_picking", {
    p_order_id: orderId,
  });
  if (error) {
    throw new Error(error.message || "Не удалось начать сборку");
  }
}

export async function setPickingItemCompleted(
  pickingItemId: string,
  completed: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("staff_set_picking_item_completed", {
    p_picking_item_id: pickingItemId,
    p_completed: completed,
  });
  if (error) {
    throw new Error(error.message || "Не удалось обновить позицию сборки");
  }
}

export async function completeOrderPicking(orderId: string): Promise<void> {
  const { error } = await supabase.rpc("staff_complete_order_picking", {
    p_order_id: orderId,
  });
  if (error) {
    throw new Error(error.message || "Не удалось завершить сборку");
  }
}

export async function shipOrder(orderId: string): Promise<void> {
  const { error } = await supabase.rpc("staff_ship_order", {
    p_order_id: orderId,
  });
  if (error) {
    throw new Error(error.message || "Не удалось отгрузить заказ");
  }
}

export async function listWarehouseOrderActivity(
  orderId: string,
): Promise<WarehouseOrderActivityItem[]> {
  const { data, error } = await supabase.rpc("warehouse_list_order_activity", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить историю склада");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    id: String(row.id),
    order_id: String(row.order_id),
    picking_task_id: (row.picking_task_id as string | null) ?? null,
    event_type: row.event_type as WarehouseActivityEventType,
    description: (row.description as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    created_by: String(row.created_by),
    created_by_name: (row.created_by_name as string | null) ?? null,
    created_at: String(row.created_at),
  }));
}

export type WarehouseShipmentHistoryQuery = {
  from?: string | null;
  to?: string | null;
  search?: string;
  limit?: number;
  offset?: number;
};

function mapHistoryRow(row: Record<string, unknown>): WarehouseShipmentHistoryItem {
  return {
    order_id: String(row.order_id),
    order_number: String(row.order_number),
    customer_display_name: String(row.customer_display_name ?? ""),
    shipped_at: String(row.shipped_at),
    line_count: Number(row.line_count ?? 0),
    total_quantity: Number(row.total_quantity ?? 0),
    picked_by_name: (row.picked_by_name as string | null) ?? null,
    shipped_by_name: (row.shipped_by_name as string | null) ?? null,
    status: row.status as OrderStatus,
    total_count: Number(row.total_count ?? 0),
  };
}

export async function listWarehouseShipmentHistory(
  query: WarehouseShipmentHistoryQuery = {},
): Promise<WarehouseShipmentHistoryItem[]> {
  const { data, error } = await supabase.rpc("staff_list_warehouse_shipment_history", {
    p_from: query.from ?? null,
    p_to: query.to ?? null,
    p_search: query.search?.trim() || null,
    p_limit: query.limit ?? DEFAULT_LIMIT,
    p_offset: query.offset ?? 0,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить историю отгрузок");
  }

  return ((data as Record<string, unknown>[] | null) ?? []).map(mapHistoryRow);
}

export async function getWarehouseShipmentHistoryOrder(
  orderId: string,
): Promise<WarehouseShipmentHistoryOrder> {
  const { data, error } = await supabase.rpc("staff_get_warehouse_shipment_history_order", {
    p_order_id: orderId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить отгруженный заказ");
  }

  if (!data || typeof data !== "object") {
    throw new Error("Пустой ответ истории отгрузки");
  }

  const raw = data as Record<string, unknown>;
  const order = raw.order as Record<string, unknown>;
  const timeline = (raw.timeline as Record<string, unknown> | null) ?? {};
  const items = ((raw.items as Record<string, unknown>[] | null) ?? []).map((item) => ({
    product_id: String(item.product_id ?? ""),
    product_sku: (item.product_sku as string | null) ?? null,
    product_name: String(item.product_name ?? ""),
    quantity: Number(item.quantity ?? 0),
  }));

  return {
    order: {
      id: String(order.id),
      order_number: String(order.order_number),
      status: order.status as OrderStatus,
      created_at: String(order.created_at),
    },
    customer_display_name: String(raw.customer_display_name ?? ""),
    shipped_at: String(raw.shipped_at),
    picked_by_name: (raw.picked_by_name as string | null) ?? null,
    shipped_by_name: (raw.shipped_by_name as string | null) ?? null,
    items,
    timeline: {
      paid_at: (timeline.paid_at as string | null) ?? null,
      picking_started_at: (timeline.picking_started_at as string | null) ?? null,
      picking_completed_at: (timeline.picking_completed_at as string | null) ?? null,
      shipped_at: (timeline.shipped_at as string | null) ?? null,
    },
  };
}
