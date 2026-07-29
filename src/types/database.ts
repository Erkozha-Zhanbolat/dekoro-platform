export type UserRole = "client" | "manager" | "accountant" | "warehouse" | "admin";

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  client: "Клиент",
  manager: "Менеджер",
  accountant: "Бухгалтер",
  warehouse: "Склад",
  admin: "Администратор",
};

/**
 * Roles that may enter the internal Staff Platform (/staff/**).
 * Matches supabase/migrations/010_staff_role_access.sql's
 * has_staff_role() allow-list — keep both in sync if this ever changes.
 */
export const STAFF_ROLES: readonly UserRole[] = ["manager", "accountant", "warehouse", "admin"];

/** True for any role other than "client" (or a missing role). */
export function isStaffRole(role: UserRole | null | undefined): boolean {
  return !!role && STAFF_ROLES.includes(role);
}

/**
 * Single source of truth for "can this role open /staff?". Currently
 * identical to isStaffRole(), kept as a separate name so access rules for
 * the Staff Platform can diverge from the general staff/client distinction
 * later without touching every call site.
 */
export function canAccessStaff(role: UserRole | null | undefined): boolean {
  return isStaffRole(role);
}

export interface Company {
  id: string;
  name: string;
  bin: string;
  phone: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export type CustomerType = "individual" | "company";

export interface Profile {
  id: string;
  company_id: string | null;
  full_name: string;
  phone: string | null;
  role: UserRole;
  customer_type: CustomerType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type ProductStatus = "draft" | "active" | "archived";

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  category_id: string | null;
  name: string;
  slug: string;
  sku: string;
  original_sku: string | null;
  description: string | null;
  dimensions: string | null;
  unit: string;
  base_price: number | null;
  status: ProductStatus;
  is_promotion: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductImage {
  id: string;
  product_id: string;
  image_url: string;
  alt_text: string | null;
  sort_order: number;
  is_primary: boolean;
  created_at: string;
}

export interface Warehouse {
  id: string;
  name: string;
  code: string;
  address: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Inventory {
  id: string;
  product_id: string;
  warehouse_id: string;
  quantity: number;
  reserved_quantity: number;
  updated_at: string;
}

export interface ProductAvailability {
  product_id: string;
  warehouse_id: string;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
}

export interface PriceGroup {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductPrice {
  id: string;
  product_id: string;
  price_group_id: string;
  price: number;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyProductPrice {
  id: string;
  company_id: string;
  product_id: string;
  price: number;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface Favorite {
  id: string;
  user_id: string;
  product_id: string;
  created_at: string;
}

/**
 * Order workflow statuses (supabase/migrations/012_staff_order_workflow.sql).
 * Legacy `processing` is remapped to `awaiting_payment` by migration 012.
 */
export type OrderStatus =
  | "new"
  | "awaiting_payment"
  | "paid"
  | "picking"
  | "ready_for_shipment"
  | "shipped"
  | "completed"
  | "cancelled";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Новый",
  awaiting_payment: "Ожидает оплаты",
  paid: "Оплачен",
  picking: "Сборка",
  ready_for_shipment: "Готов к отгрузке",
  shipped: "Отгружен",
  completed: "Завершён",
  cancelled: "Отменён",
};

/** Statuses in forward workflow order (excluding cancelled). */
export const ORDER_WORKFLOW_STATUSES: readonly OrderStatus[] = [
  "new",
  "awaiting_payment",
  "paid",
  "picking",
  "ready_for_shipment",
  "shipped",
  "completed",
];

/** Staff may edit line items only while the order is still pre-payment. */
export const ORDER_ITEM_EDITABLE_STATUSES: readonly OrderStatus[] = [
  "new",
  "awaiting_payment",
];

export function canEditOrderItems(status: OrderStatus): boolean {
  return ORDER_ITEM_EDITABLE_STATUSES.includes(status);
}

export interface Order {
  id: string;
  order_number: string;
  user_id: string;
  profile_id: string;
  company_id: string | null;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  comment: string | null;
  // Added by supabase/migrations/007_checkout_order_details.sql.
  delivery_type: DeliveryType;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  delivery_address: string | null;
  delivery_comment: string | null;
  // Added by supabase/migrations/012_staff_order_workflow.sql.
  assigned_manager_id: string | null;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row from public.order_status_history (012) — read via staff RPC only. */
export interface OrderStatusHistoryEntry {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_by: string;
  note: string | null;
  created_at: string;
}

/** Row from public.order_internal_notes (012) — read via staff RPC only. */
export interface OrderInternalNote {
  id: string;
  order_id: string;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  product_sku: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  created_at: string;
}

/** Fields a client may supply when inserting into public.orders (RLS-scoped). */
export type OrderInsert = {
  user_id: string;
  profile_id: string;
  company_id?: string | null;
  status?: OrderStatus;
  subtotal: number;
  discount?: number;
  total: number;
  comment?: string | null;
};

/** Fields a client may supply when inserting into public.order_items (RLS-scoped). */
export type OrderItemInsert = {
  order_id: string;
  product_id: string;
  product_name: string;
  product_sku?: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
};

/** Payload element for public.create_order(p_items jsonb, ...). */
export type CreateOrderItemInput = {
  product_id: string;
  quantity: number;
};

/**
 * public.orders.delivery_type / create_order()'s p_delivery_type
 * (supabase/migrations/007_checkout_order_details.sql). "delivery" is
 * accepted by the schema/RPC for a future courier-delivery flow but is not
 * yet reachable from the checkout UI, which only offers "pickup" and
 * "customer_transport".
 */
export type DeliveryType = "pickup" | "customer_transport" | "delivery";

/** Full argument shape for public.create_order() (see 007 migration). */
export type CreateOrderInput = {
  items: CreateOrderItemInput[];
  deliveryType: DeliveryType;
  contactName: string;
  contactPhone: string;
  comment?: string | null;
  contactEmail?: string | null;
  deliveryAddress?: string | null;
  deliveryComment?: string | null;
};

/** Row returned by public.create_order(...). */
export type CreateOrderResult = {
  id: string;
  order_number: string;
  total: number;
  created_at: string;
};

// Row shape returned by the get_catalog() RPC (supabase/migrations/002_catalog_inventory_pricing.sql).
export interface CatalogEntry {
  product_id: string;
  name: string;
  sku: string;
  original_sku: string | null;
  category: string | null;
  dimensions: string | null;
  unit: string;
  available_stock: number;
  sale_price: number | null;
  image: string | null;
  is_promotion: boolean;
}

// ============================================================
// Staff Platform — manual orders (supabase/migrations/011_staff_manual_orders.sql)
// ============================================================

/** Row returned by public.staff_search_clients(p_query, p_limit). */
export type StaffClientSearchResult = {
  profile_id: string;
  company_id: string | null;
  full_name: string;
  company_name: string | null;
  phone: string | null;
  email: string | null;
};

/** Row returned by public.staff_search_products(p_query, p_limit). */
export type StaffProductSearchResult = {
  product_id: string;
  name: string;
  sku: string;
  category: string | null;
  unit: string;
  price: number | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  physical_quantity: number;
  reserved_quantity: number;
  available_quantity: number;
};

/** Row returned by public.staff_create_order(p_client_profile_id). */
export type StaffCreateOrderResult = {
  id: string;
  order_number: string;
  status: OrderStatus;
  created_at: string;
};

/**
 * Row returned by public.staff_add_order_item() /
 * public.staff_update_order_item_quantity() / public.staff_remove_order_item()
 * — all three return the full, freshly recalculated public.orders row
 * (a single composite row, not a set).
 */
export type StaffOrderMutationResult = {
  id: string;
  order_number: string;
  user_id: string;
  profile_id: string;
  company_id: string | null;
  status: OrderStatus;
  subtotal: number;
  discount: number;
  total: number;
  comment: string | null;
  delivery_type: DeliveryType;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  delivery_address: string | null;
  delivery_comment: string | null;
  assigned_manager_id: string | null;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  created_at: string;
  updated_at: string;
};
