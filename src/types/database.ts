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

/**
 * Universal customer entity (supabase/migrations/013_customers_foundation.sql).
 * Covers registered profiles, companies, and staff-created walk-in clients.
 */
export type CustomerSource =
  | "website"
  | "staff"
  | "phone"
  | "whatsapp"
  | "instagram"
  | "referral"
  | "other";

export const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  individual: "Физлицо",
  company: "Компания",
};

export const CUSTOMER_SOURCE_LABELS: Record<CustomerSource, string> = {
  website: "Сайт",
  staff: "Менеджер",
  phone: "Телефон",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  referral: "Рекомендация",
  other: "Другое",
};

export const CUSTOMER_SOURCES: readonly CustomerSource[] = [
  "website",
  "staff",
  "phone",
  "whatsapp",
  "instagram",
  "referral",
  "other",
];

export interface Customer {
  id: string;
  customer_type: CustomerType;
  profile_id: string | null;
  company_id: string | null;
  display_name: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  iin_bin: string | null;
  contact_person: string | null;
  address: string | null;
  city: string | null;
  source: CustomerSource | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Row returned by public.staff_search_customers(p_query, p_limit). */
export type StaffCustomerSearchResult = {
  id: string;
  customer_type: CustomerType;
  display_name: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  source: CustomerSource | null;
  profile_id: string | null;
  company_id: string | null;
  orders_count: number;
  last_order_at: string | null;
};

/** Row returned by public.staff_get_customer(p_customer_id). */
export type StaffCustomerDetails = {
  id: string;
  customer_type: CustomerType;
  profile_id: string | null;
  company_id: string | null;
  display_name: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  iin_bin: string | null;
  contact_person: string | null;
  address: string | null;
  city: string | null;
  source: CustomerSource | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_registered: boolean;
  orders_count: number;
  last_order_at: string | null;
};

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
  /** Nullable for unregistered staff-created customers (013). */
  user_id: string | null;
  /** Nullable for unregistered staff-created customers (013). */
  profile_id: string | null;
  company_id: string | null;
  /** Universal customer — required after 013 backfill. */
  customer_id: string;
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

/** Row returned by public.staff_create_order / staff_create_order_for_customer. */
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
  user_id: string | null;
  profile_id: string | null;
  company_id: string | null;
  customer_id: string;
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

// ============================================================
// Staff Platform — order documents (supabase/migrations/014_documents.sql)
// ============================================================

export type OrderDocumentType = "invoice" | "delivery_note";

export type OrderDocumentStatus = "generated" | "cancelled";

/** Tax mode chosen when generating invoice / delivery note (014). */
export type DocumentTaxMode = "without_vat" | "with_vat";

export const DOCUMENT_TAX_MODE_LABELS: Record<DocumentTaxMode, string> = {
  without_vat: "Без НДС",
  with_vat: "С НДС",
};

export const ORDER_DOCUMENT_TYPE_LABELS: Record<OrderDocumentType, string> = {
  invoice: "Счёт",
  delivery_note: "Накладная",
};

export const ORDER_DOCUMENT_STATUS_LABELS: Record<OrderDocumentStatus, string> = {
  generated: "Сформирован",
  cancelled: "Отменён",
};

/** Singleton public.organization_settings (014 + 016 assets). */
export type OrganizationAssetKind = "logo" | "stamp" | "signature";

export type OrganizationSettings = {
  id: string;
  singleton_key: "default";
  legal_name: string | null;
  bin: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  whatsapp: string | null;
  bank_name: string | null;
  bank_bik: string | null;
  bank_iik: string | null;
  bank_kbe: string | null;
  director_name: string | null;
  warehouse_name: string | null;
  warehouse_code: string | null;
  warehouse_address: string | null;
  default_tax_mode: DocumentTaxMode;
  /** Percent, e.g. 12.00 for KZ. Null until admin configures. */
  vat_rate: number | null;
  /** Private Storage path, e.g. organization/logo.png */
  logo_path: string | null;
  stamp_path: string | null;
  signature_path: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

/** Payload for staff_upsert_organization_settings (016). */
export type OrganizationSettingsUpdate = {
  legal_name: string;
  bin: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  website: string;
  whatsapp: string;
  bank_name: string;
  bank_bik: string;
  bank_iik: string;
  bank_kbe: string;
  director_name: string;
  warehouse_name: string;
  warehouse_code: string;
  warehouse_address: string;
  default_tax_mode: DocumentTaxMode;
  vat_rate: number | null;
  logo_path: string | null;
  stamp_path: string | null;
  signature_path: string | null;
};

/** Row from public.order_documents (014 + 015 print audit). */
export type OrderDocument = {
  id: string;
  order_id: string;
  document_type: OrderDocumentType;
  number: string;
  status: OrderDocumentStatus;
  file_path: string | null;
  generated_by: string;
  generated_at: string;
  printed_at: string | null;
  printed_by: string | null;
  created_at: string;
  updated_at: string;
  metadata: OrderDocumentMetadata;
};

/** Invoice PDF layout chosen at generate time from customers.customer_type (018). */
export type InvoiceTemplate = "individual" | "company";

/** DEKORO beneficiary bank profile for invoices (018). */
export type OrganizationPaymentProfile = {
  id: string;
  customer_type: CustomerType;
  beneficiary_name: string;
  bin_iin: string;
  bank_name: string;
  bank_bik: string;
  bank_iik: string;
  bank_kbe: string;
  payment_purpose_code: string | null;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationPaymentProfileUpdate = {
  customer_type: CustomerType;
  beneficiary_name: string;
  bin_iin: string;
  bank_name: string;
  bank_bik: string;
  bank_iik: string;
  bank_kbe: string;
  payment_purpose_code: string;
  is_active: boolean;
};

/** Snapshot stored in order_documents.metadata for PDF (incl. KZ form 3-2). */
export type OrderDocumentMetadata = {
  schema_version: number;
  document_type: OrderDocumentType;
  document_number: string;
  form_hint: string;
  /** Present on invoices from migration 018+. Legacy docs may omit. */
  invoice_template?: InvoiceTemplate | null;
  generated_at: string;
  warning_text?: string | null;
  order: Record<string, unknown>;
  supplier: Record<string, unknown>;
  /** Invoice-only from 018; null/absent on delivery notes and legacy invoices. */
  payment_profile?: Record<string, unknown> | null;
  buyer: Record<string, unknown>;
  items: OrderDocumentMetadataItem[];
  totals: Record<string, unknown>;
  basis: Record<string, unknown>;
  form_3_2: Record<string, unknown>;
};

export type OrderDocumentMetadataItem = {
  line_no: number;
  order_item_id: string;
  product_id: string;
  product_name: string;
  product_sku: string | null;
  unit: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

/** Row returned by public.staff_list_order_documents(p_order_id). */
export type StaffOrderDocumentListItem = {
  id: string;
  order_id: string;
  document_type: OrderDocumentType;
  number: string;
  status: OrderDocumentStatus;
  file_path: string | null;
  generated_by: string;
  generated_by_name: string | null;
  generated_at: string;
  printed_at: string | null;
  printed_by: string | null;
  printed_by_name: string | null;
  created_at: string;
  updated_at: string;
};

/** Row returned by public.staff_get_document(p_order_id, p_document_id). */
export type StaffOrderDocumentDetails = StaffOrderDocumentListItem & {
  metadata: OrderDocumentMetadata;
};

// ============================================================
// Staff Platform — warehouse operations (017)
// ============================================================

export type PickingTaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export const PICKING_TASK_STATUS_LABELS: Record<PickingTaskStatus, string> = {
  pending: "Ожидает",
  in_progress: "В сборке",
  completed: "Собрано",
  cancelled: "Отменена",
};

/** Queue statuses shown on /staff/warehouse. */
export const WAREHOUSE_QUEUE_STATUSES: readonly OrderStatus[] = [
  "paid",
  "picking",
  "ready_for_shipment",
];

export type WarehouseQueueStatus = (typeof WAREHOUSE_QUEUE_STATUSES)[number];

/** Row from public.warehouse_list_orders(...). */
export type WarehouseOrderListItem = {
  order_id: string;
  order_number: string;
  customer_display_name: string;
  delivery_type: DeliveryType;
  status: WarehouseQueueStatus;
  total_item_count: number;
  completed_item_count: number;
  picking_task_status: PickingTaskStatus | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_at: string;
  payment_due_at: string | null;
  reservation_expires_at: string | null;
  total: number;
};

export type WarehousePickingItem = {
  id: string;
  picking_task_id: string;
  order_item_id: string;
  product_id: string;
  product_name: string;
  product_sku: string | null;
  required_quantity: number;
  picked_quantity: number;
  is_completed: boolean;
  completed_by: string | null;
  completed_at: string | null;
};

export type WarehouseOrderPickingDetails = {
  order: {
    id: string;
    order_number: string;
    status: OrderStatus;
    total: number;
    delivery_type: DeliveryType;
    contact_name: string;
    contact_phone: string;
    contact_email: string | null;
    delivery_address: string | null;
    delivery_comment: string | null;
    comment: string | null;
    payment_due_at: string | null;
    reservation_expires_at: string | null;
    created_at: string;
    updated_at: string;
    assigned_manager_id: string | null;
    customer_id: string;
  };
  customer: {
    id: string;
    display_name: string;
    phone: string | null;
    email: string | null;
    customer_type: CustomerType;
  } | null;
  manager: {
    id: string;
    full_name: string;
  } | null;
  picking_task: {
    id: string;
    order_id: string;
    warehouse_id: string;
    status: PickingTaskStatus;
    assigned_to: string | null;
    assigned_to_name: string | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
  } | null;
  picking_items: WarehousePickingItem[];
  order_items: {
    id: string;
    product_id: string;
    product_name: string;
    product_sku: string | null;
    quantity: number;
  }[];
  delivery_note: {
    id: string;
    number: string;
    status: OrderDocumentStatus;
    generated_at: string;
    printed_at: string | null;
  } | null;
  progress: {
    total: number;
    completed: number;
  };
};

export function canAccessWarehouseOps(role: UserRole | null | undefined): boolean {
  return role === "warehouse" || role === "manager" || role === "admin";
}

export type WarehouseActivityEventType =
  | "picking_started"
  | "picking_item_completed"
  | "picking_item_reopened"
  | "picking_completed"
  | "order_shipped";

export const WAREHOUSE_ACTIVITY_EVENT_LABELS: Record<WarehouseActivityEventType, string> = {
  picking_started: "Начал сборку",
  picking_item_completed: "Собрал позицию",
  picking_item_reopened: "Вернул позицию в несобранные",
  picking_completed: "Завершил сборку",
  order_shipped: "Отгрузил заказ",
};

/** Row from public.warehouse_list_order_activity(p_order_id). */
export type WarehouseOrderActivityItem = {
  id: string;
  order_id: string;
  picking_task_id: string | null;
  event_type: WarehouseActivityEventType;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
};
