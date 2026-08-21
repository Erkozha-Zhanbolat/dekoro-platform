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
 * Inactive profiles are blocked separately via profiles.is_active
 * (get_my_role returns NULL when inactive as of migration 024).
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
 * Callers must also check profiles.is_active (see staff layout).
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
  /**
   * For company customers this is the legal address (юридический адрес).
   * Stage 23 invoice validation reads this column — there is no separate legal_address field.
   */
  address: string | null;
  city: string | null;
  source: CustomerSource | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Stage 28 — customer's assigned price group (default group when unset). */
  price_group_id?: string | null;
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
  iin_bin: string | null;
  contact_person: string | null;
  is_registered: boolean;
  price_group_id: string | null;
  price_group_name: string | null;
};

/** Client-safe row from public.client_get_my_customer_details(). */
export type ClientCustomerDetails = {
  id: string;
  customer_type: CustomerType;
  display_name: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  iin_bin: string | null;
  contact_person: string | null;
  address: string | null;
  city: string | null;
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
  price_group_id: string | null;
  price_group_name: string | null;
  price_group_is_default: boolean;
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

/** Staff product management UI statuses. Draft = unpublished, hidden from get_catalog(). */
export type StaffProductStatus = "draft" | "active" | "archived";

export const STAFF_PRODUCT_STATUS_LABELS: Record<StaffProductStatus, string> = {
  draft: "Черновик",
  active: "Активен",
  archived: "Архив",
};

export interface Category {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  description: string | null;
  image_url: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Row from public.staff_list_categories(). */
export type StaffCategoryListItem = {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  products_count: number;
  created_at: string;
  updated_at: string;
};

export interface Product {
  id: string;
  category_id: string | null;
  subcategory_id: string | null;
  name: string;
  slug: string;
  sku: string;
  original_sku: string | null;
  description: string | null;
  dimensions: string | null;
  unit: string;
  base_price: number | null;
  min_order_qty: number;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  weight_kg: number | null;
  main_photo_path: string | null;
  status: ProductStatus;
  is_promotion: boolean;
  created_at: string;
  updated_at: string;
}

/** Row from public.staff_list_products(). */
export type StaffProductListItem = {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  unit: string;
  base_price: number | null;
  min_order_qty: number;
  status: ProductStatus;
  main_photo_path: string | null;
  available_quantity: number;
  created_at: string;
  updated_at: string;
};

/** Payload from public.staff_get_product() / create / update. */
export type StaffProductDetails = {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  status: ProductStatus;
  unit: string;
  base_price: number | null;
  min_order_qty: number;
  length_mm: number | null;
  width_mm: number | null;
  thickness_mm: number | null;
  weight_kg: number | null;
  dimensions: string | null;
  main_photo_path: string | null;
  available_quantity: number;
  physical_quantity: number;
  reserved_quantity: number;
  created_at: string;
  updated_at: string;
};

export type StaffProductCopyResult = StaffProductDetails & {
  source_product_id: string;
  source_main_photo_path: string | null;
};

export function canManageProducts(role: UserRole | null | undefined): boolean {
  return role === "admin";
}

export function canReadProducts(role: UserRole | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "warehouse";
}

/** Explicit stock receipt (оприходование) — admin only (032). */
export function canRecordStockReceipt(role: UserRole | null | undefined): boolean {
  return role === "admin";
}

/**
 * Receipt / adjustment history on the product card.
 * Manager keeps read because the existing product UI shows those lists.
 * Warehouse is denied — their history is shipment history, not inventory writes.
 */
export function canViewInventoryMovementHistory(
  role: UserRole | null | undefined,
): boolean {
  return role === "admin" || role === "manager";
}

/** 1C Excel inventory reconciliation — admin only (032). */
export function canAccessInventoryReconciliation(
  role: UserRole | null | undefined,
): boolean {
  return role === "admin";
}

/** Shipment history — warehouse + admin. Manager is not auto-granted. */
export function canAccessWarehouseHistory(
  role: UserRole | null | undefined,
): boolean {
  return role === "warehouse" || role === "admin";
}

export type InventoryReconciliationStatus =
  | "draft"
  | "reviewed"
  | "partially_applied"
  | "applied"
  | "cancelled";

export type InventoryReconciliationMatchStatus =
  | "matched_equal"
  | "matched_difference"
  | "missing_in_dekoro"
  | "missing_in_source"
  | "duplicate_source"
  | "invalid";

export type InventoryReconciliationApplyStatus =
  | "pending"
  | "applied"
  | "conflict"
  | "skipped";

export type InventoryReconciliationConflictCode = "reservation_conflict" | "stale";

export type InventoryReconciliation = {
  id: string;
  reconciliation_number: string;
  source_type: "1c_excel";
  source_file_name: string;
  warehouse_id: string;
  status: InventoryReconciliationStatus;
  total_rows: number;
  matched_rows: number;
  equal_rows: number;
  different_rows: number;
  missing_in_dekoro_rows: number;
  missing_in_source_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
  applied_rows: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  applied_by: string | null;
  applied_by_name: string | null;
  applied_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  metadata: Record<string, unknown>;
};

export type InventoryReconciliationItem = {
  id: string;
  reconciliation_id: string;
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  source_sku: string | null;
  source_name: string | null;
  source_quantity: number | null;
  platform_quantity: number | null;
  reserved_quantity: number | null;
  available_quantity: number | null;
  difference: number | null;
  match_status: InventoryReconciliationMatchStatus;
  apply_status: InventoryReconciliationApplyStatus;
  conflict_code: InventoryReconciliationConflictCode | null;
  conflict_message: string | null;
  applied_quantity: number | null;
  applied_adjustment_id: string | null;
  source_row_number: number | null;
  duplicate_count: number | null;
  error_message: string | null;
  created_at: string;
};

export type InventoryReconciliationListItem = {
  id: string;
  reconciliation_number: string;
  source_file_name: string;
  status: InventoryReconciliationStatus;
  total_rows: number;
  matched_rows: number;
  equal_rows: number;
  different_rows: number;
  missing_in_dekoro_rows: number;
  missing_in_source_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
  applied_rows: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  applied_by: string | null;
  applied_by_name: string | null;
  applied_at: string | null;
};

export type InventoryReconciliationApplyResult = {
  applied_count: number;
  stale_count: number;
  reservation_conflict_count: number;
  already_applied_count: number;
  skipped_count: number;
  increased_count: number;
  decreased_count: number;
};

export type InventoryReconciliationPayload = {
  reconciliation: InventoryReconciliation;
  items: InventoryReconciliationItem[];
  apply_result?: InventoryReconciliationApplyResult;
};

export const INVENTORY_RECONCILIATION_STATUS_LABELS: Record<
  InventoryReconciliationStatus,
  string
> = {
  draft: "Черновик",
  reviewed: "Готова к применению",
  partially_applied: "Частично применена",
  applied: "Применена",
  cancelled: "Отменена",
};

export const INVENTORY_RECONCILIATION_MATCH_LABELS: Record<
  InventoryReconciliationMatchStatus,
  string
> = {
  matched_equal: "Совпадает",
  matched_difference: "Расхождение",
  missing_in_dekoro: "Не найден в DEKORO",
  missing_in_source: "Нет в загруженном файле",
  duplicate_source: "Дубликат в файле",
  invalid: "Ошибка",
};

/**
 * Row from public.staff_get_product_inventory / staff_adjust_product_inventory.
 * Quantities are numeric(14,3) in DB — keep as JS number (no integer truncation).
 */
export type StaffProductInventory = {
  inventory_id: string | null;
  product_id: string;
  warehouse_id: string;
  warehouse_code: string;
  quantity: number;
  reserved_quantity: number;
  available_quantity: number;
};

export type StaffProductInventoryAdjustResult = StaffProductInventory & {
  adjusted: boolean;
};

/** Row from public.staff_list_product_inventory_adjustments (numeric quantities). */
export type StaffInventoryAdjustment = {
  id: string;
  inventory_id: string;
  product_id: string;
  warehouse_id: string;
  previous_quantity: number;
  new_quantity: number;
  difference: number;
  reason: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
};

/** Row from public.staff_record_stock_receipt / staff_list_product_stock_receipts. */
export type StaffStockReceipt = {
  id: string;
  product_id: string;
  warehouse_id: string;
  quantity: number;
  previous_quantity: number;
  new_quantity: number;
  document_number: string | null;
  reason: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
};

export type StaffStockReceiptResult = StaffProductInventory & {
  receipt_id: string;
  received_quantity: number;
  previous_quantity: number;
  new_quantity: number;
};

export const INVENTORY_ADJUSTMENT_REASON_PRESETS = [
  "Начальный остаток",
  "Приход товара",
  "Инвентаризация",
  "Исправление ошибки",
  "Списание брака",
] as const;

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

/**
 * Legacy price-group row (supabase/migrations/002_catalog_inventory_pricing.sql,
 * extended by 028_customer_pricing.sql). Stage 42
 * (042_remove_legacy_price_groups.sql) removes price groups from runtime
 * price resolution and from the staff UI; the table itself is kept in the
 * database (unused) — see that migration's section 8 for why. Kept here
 * only because public.price_groups / public.product_prices rows still
 * physically exist and some historical order_items reference
 * price_source = 'price_group'.
 */
export interface PriceGroup {
  id: string;
  name: string;
  code: string;
  description: string | null;
  sort_order: number;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Extended by supabase/migrations/041_order_pricing_engine.sql with
 * "quantity_tier" (automatic, from product_quantity_prices) and
 * "manager_override" (manual, staff_set_order_item_price). "price_group"
 * and "legacy_company" are retired from NEW price resolution as of Stage 42
 * (042_remove_legacy_price_groups.sql) but kept in this union because
 * historical order_items rows still carry those values and must keep
 * rendering correctly (PRICE_SOURCE_LABELS below).
 */
export type PriceSource =
  | "individual"
  | "legacy_company"
  | "price_group"
  | "base"
  | "quantity_tier"
  | "manager_override";

/**
 * Payload for admin_bulk_update_product_prices — retail (base) price only
 * as of Stage 42. The RPC still accepts an optional `groups` array for
 * backward compatibility with its own signature; the client always omits
 * it now (see bulkUpdateProductPrices in lib/staff/pricing.ts).
 */
export type BulkProductPricesPayload = {
  base: { action: "keep" } | { action: "set"; price: number };
};

export type BulkProductPricesResult = {
  updated_products: number;
  base_updates: number;
  group_sets: number;
  group_resets: number;
};

/**
 * Payload for admin_bulk_update_product_pricing (043_bulk_product_pricing.sql).
 * Retail price and quantity tiers only — never customer_product_prices or
 * order_items. `tiers` omitted/empty means "no tier change" regardless of mode.
 */
export type BulkProductPricingTierMode = "merge" | "replace";

export type BulkProductPricingTierInput = {
  minQuantity: number;
  price: number;
};

export type BulkProductPricingPayload = {
  updateBase: boolean;
  basePrice?: number | null;
  tiers: BulkProductPricingTierInput[];
  tierMode: BulkProductPricingTierMode;
};

export type BulkProductPricingResult = {
  updated_products: number;
  base_price_changed: boolean;
  base_price: number | null;
  tiers_changed: boolean;
  tier_mode: BulkProductPricingTierMode | null;
  tiers_count: number;
  tier_rows_written: number;
};

/** Row from admin_list_product_pricing_overview (042) — retail price + quantity tiers. */
export type ProductPricingOverviewRow = {
  product_id: string;
  sku: string;
  name: string;
  category_name: string | null;
  base_price: number | null;
  quantity_tiers: Array<{ min_quantity: number; price: number }>;
};

/** Row from staff_list_customer_product_prices (individual overrides only). */
export type CustomerProductPriceRow = {
  product_id: string;
  sku: string;
  name: string;
  base_price: number | null;
  group_price: number | null;
  individual_price: number | null;
  effective_price: number | null;
  price_source: PriceSource;
};

/**
 * Row from public.product_quantity_prices (041) — quantity-based pricing
 * tiers. Rule: the applicable tier is the one with the largest
 * min_quantity <= requested quantity (no overlapping ranges).
 */
export type ProductQuantityPriceRow = {
  id: string;
  product_id: string;
  min_quantity: number;
  price: number;
  created_at: string;
  updated_at: string;
};

/**
 * Row from public.pricing_guard_settings (041) — singleton cost/discount
 * guard, deliberately minimal (ТЗ §22): not a full approval workflow, just
 * a configurable floor below which a manager needs admin help.
 */
export type PricingGuardSettings = {
  max_manager_discount_percent: number | null;
  min_margin_over_cost_percent: number | null;
  updated_by: string | null;
  updated_at: string;
};

/** Manager-override reason (order_items.manual_price_reason, 041). */
export type ManualPriceReason =
  | "regular_customer"
  | "object_top_up"
  | "approved_by_management"
  | "compensation"
  | "other";

export const MANUAL_PRICE_REASON_LABELS: Record<ManualPriceReason, string> = {
  regular_customer: "Постоянный клиент",
  object_top_up: "Добор на объект",
  approved_by_management: "Согласовано руководителем",
  compensation: "Компенсация",
  other: "Другое",
};

export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  base: "Розничная",
  price_group: "Ценовая группа",
  individual: "Индивидуальная цена",
  legacy_company: "Индивидуальная цена (компания)",
  quantity_tier: "Цена от количества",
  manager_override: "Ручная цена менеджера",
};

/**
 * Output of public.resolve_order_item_price() / staff_preview_item_price()
 * — the *automatic* price for one line, before any manager override.
 */
export type ItemPricePreview = {
  list_price: number | null;
  resolved_price: number | null;
  resolved_source: PriceSource | null;
  tier_min_quantity: number | null;
};

/**
 * Row from public.staff_get_customer_product_price_history() (041) — a
 * hint for managers, never an automatic rule. Excludes cancelled orders.
 */
export type CustomerProductPriceHistoryEntry = {
  order_id: string;
  order_number: string;
  unit_price: number;
  quantity: number;
  status: OrderStatus;
  ordered_at: string;
};

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

/** Client «Активные» — everything except terminal completed/cancelled. */
export const CLIENT_ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  "new",
  "awaiting_payment",
  "paid",
  "picking",
  "ready_for_shipment",
  "shipped",
];

/** Client «История» — terminal statuses only. */
export const CLIENT_HISTORY_ORDER_STATUSES: readonly OrderStatus[] = [
  "completed",
  "cancelled",
];

/**
 * Client-facing status labels (storefront).
 * Differs from ORDER_STATUS_LABELS for picking (warehouse wording).
 */
export const CLIENT_ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Создан",
  awaiting_payment: "Ожидает оплаты",
  paid: "Оплачен",
  picking: "Собирается на складе",
  ready_for_shipment: "Готов к отгрузке",
  shipped: "Отгружен",
  completed: "Завершён",
  cancelled: "Отменён",
};

export function isClientActiveOrderStatus(status: OrderStatus): boolean {
  return (CLIENT_ACTIVE_ORDER_STATUSES as readonly string[]).includes(status);
}

export function isClientHistoryOrderStatus(status: OrderStatus): boolean {
  return (CLIENT_HISTORY_ORDER_STATUSES as readonly string[]).includes(status);
}

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

/**
 * Client-safe status transition from public.client_list_order_status_history
 * (021) — no note / changed_by.
 */
export type ClientOrderStatusHistoryEntry = {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  created_at: string;
};

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
  // Price snapshot / manager-override fields added by
  // supabase/migrations/041_order_pricing_engine.sql. Nullable for every
  // pre-041 row (backward compatible — unit_price/line_total above remain
  // that order's authoritative historical price regardless).
  list_price: number | null;
  auto_price: number | null;
  price_source: PriceSource | null;
  quantity_tier_min_quantity: number | null;
  is_manual_price: boolean;
  manual_price_reason: ManualPriceReason | null;
  manual_price_comment: string | null;
  price_overridden_by: string | null;
  price_overridden_at: string | null;
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

// Row shape returned by the get_catalog() RPC
// (002_catalog_inventory_pricing.sql, extended in 020 with updated_at).
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

/** Singleton public.organization_settings (014 + 016 assets + 033 Kaspi QR). */
export type OrganizationAssetKind = "logo" | "stamp" | "signature" | "kaspi_qr";

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
  /** Permanent company Kaspi QR (033). Not a payment integration. */
  kaspi_qr_path: string | null;
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

/**
 * Client document list row from public.client_list_order_documents (021).
 * No staff identity / print audit / file_path.
 */
export type ClientOrderDocumentListItem = {
  id: string;
  order_id: string;
  document_type: OrderDocumentType;
  number: string;
  status: OrderDocumentStatus;
  generated_at: string;
  created_at: string;
};

/**
 * Client document details from public.client_get_order_document (021).
 * Metadata is the immutable PDF snapshot; no staff fields.
 */
export type ClientOrderDocumentDetails = ClientOrderDocumentListItem & {
  metadata: OrderDocumentMetadata;
};

/** Minimal document shape accepted by PDF renderer (staff or client). */
export type OrderDocumentPdfSource = {
  id: string;
  order_id: string;
  document_type: OrderDocumentType;
  number: string;
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

/** Row from public.staff_list_warehouse_shipment_history(...). */
export type WarehouseShipmentHistoryItem = {
  order_id: string;
  order_number: string;
  customer_display_name: string;
  shipped_at: string;
  line_count: number;
  total_quantity: number;
  picked_by_name: string | null;
  shipped_by_name: string | null;
  status: OrderStatus;
  total_count: number;
};

export type WarehouseShipmentHistoryItemLine = {
  product_id: string;
  product_sku: string | null;
  product_name: string;
  quantity: number;
};

export type WarehouseShipmentHistoryTimeline = {
  paid_at: string | null;
  picking_started_at: string | null;
  picking_completed_at: string | null;
  shipped_at: string | null;
};

/** Payload from public.staff_get_warehouse_shipment_history_order(...). */
export type WarehouseShipmentHistoryOrder = {
  order: {
    id: string;
    order_number: string;
    status: OrderStatus;
    created_at: string;
  };
  customer_display_name: string;
  shipped_at: string;
  picked_by_name: string | null;
  shipped_by_name: string | null;
  items: WarehouseShipmentHistoryItemLine[];
  timeline: WarehouseShipmentHistoryTimeline;
};

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

// ---------------------------------------------------------------------------
// Payments & receivables (022_order_payments.sql)
// ---------------------------------------------------------------------------

/** Manual payment method whitelist — no online acquiring. */
export type OrderPaymentMethod =
  | "bank_transfer"
  | "cash"
  | "card_terminal"
  | "other";

/** Stage 33 confirm modal. Kaspi is stored via 022 `other` + comment. */
export type StaffConfirmPaymentMethod = OrderPaymentMethod | "kaspi";

export const ORDER_PAYMENT_METHOD_LABELS: Record<StaffConfirmPaymentMethod, string> = {
  bank_transfer: "Банковский перевод",
  cash: "Наличные",
  card_terminal: "Карта (терминал)",
  other: "Другое",
  kaspi: "Kaspi",
};

export const ORDER_PAYMENT_METHODS: readonly OrderPaymentMethod[] = [
  "bank_transfer",
  "cash",
  "card_terminal",
  "other",
];

export const STAFF_CONFIRM_PAYMENT_METHODS: readonly StaffConfirmPaymentMethod[] = [
  "bank_transfer",
  "kaspi",
  "other",
];

export type OrderPaymentRecordStatus = "confirmed" | "reversed";

export const ORDER_PAYMENT_RECORD_STATUS_LABELS: Record<
  OrderPaymentRecordStatus,
  string
> = {
  confirmed: "Подтверждён",
  reversed: "Сторнирован",
};

/**
 * Derived payment coverage for an order.
 * Formula (tolerance 0.01):
 *   amount_due = frozen obligation OR provisional (invoice final_total | orders.total)
 *   amount_paid = SUM(confirmed)
 *   amount_remaining = amount_due - amount_paid
 *   unpaid | partially_paid | paid | overpaid
 */
export type OrderPaymentStatus =
  | "unpaid"
  | "partially_paid"
  | "paid"
  | "overpaid";

export const ORDER_PAYMENT_STATUS_LABELS: Record<OrderPaymentStatus, string> = {
  unpaid: "Не оплачено",
  partially_paid: "Частично оплачено",
  paid: "Оплачено",
  overpaid: "Переплата",
};

/** Staff list filter including shortfall-after-reversal (UI-only flag). */
export type StaffPaymentListFilter =
  | "all"
  | OrderPaymentStatus
  | "shortfall_after_reversal";

export const STAFF_PAYMENT_FILTER_OPTIONS: ReadonlyArray<{
  value: StaffPaymentListFilter;
  label: string;
}> = [
  { value: "all", label: "Все оплаты" },
  { value: "unpaid", label: "Не оплачено" },
  { value: "partially_paid", label: "Частично" },
  { value: "paid", label: "Оплачено" },
  { value: "overpaid", label: "Переплата" },
  { value: "shortfall_after_reversal", label: "Задолженность после сторно" },
];

export type OrderActivityEventType =
  | "manager_assigned"
  | "manager_unassigned"
  | "deadlines_updated"
  | "payment_recorded"
  | "payment_reversed"
  | "payment_completed"
  | "payment_shortfall_after_reversal"
  | "payment_claimed"
  | "invoice_generation_failed"
  | "item_price_overridden"
  | "item_price_reset";

export const ORDER_ACTIVITY_EVENT_LABELS: Record<OrderActivityEventType, string> = {
  manager_assigned: "Менеджер назначен",
  manager_unassigned: "Менеджер снят",
  deadlines_updated: "Сроки обновлены",
  payment_recorded: "Оплата зарегистрирована",
  payment_reversed: "Оплата сторнирована",
  payment_completed: "Заказ оплачен полностью",
  payment_shortfall_after_reversal: "Недофинансирование после сторно",
  payment_claimed: "Клиент сообщил об оплате",
  invoice_generation_failed: "Не удалось сформировать счёт",
  item_price_overridden: "Цена позиции изменена менеджером",
  item_price_reset: "Ручная цена позиции сброшена",
};

/** Staff in-app notification types (029 + 030_workflow_notifications.sql). */
export type StaffNotificationType =
  | "new_order"
  | "payment_received"
  | "payment_overdue"
  | "order_paid"
  | "picking_started"
  | "order_ready"
  | "order_shipped"
  | "low_stock"
  | "customer_registered"
  | "stock_received"
  | "payment_claimed"
  | "invoice_generation_failed";

export const STAFF_NOTIFICATION_TYPE_LABELS: Record<StaffNotificationType, string> = {
  new_order: "Новый заказ",
  payment_received: "Оплата получена",
  payment_overdue: "Просрочка оплаты",
  order_paid: "Заказ оплачен",
  picking_started: "Сборка начата",
  order_ready: "Заказ готов",
  order_shipped: "Заказ отгружен",
  low_stock: "Низкий остаток",
  customer_registered: "Новый клиент",
  stock_received: "Поступление товара",
  payment_claimed: "Клиент сообщил об оплате",
  invoice_generation_failed: "Не удалось сформировать счёт",
};

/** Row from public.staff_list_notifications. */
export type StaffNotification = {
  id: string;
  notification_type: StaffNotificationType;
  title: string;
  message: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action_url: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

/** Client in-app notification types (030_workflow_notifications.sql). */
export type ClientNotificationType =
  | "payment_confirmed"
  | "order_picking"
  | "order_ready"
  | "order_shipped"
  | "order_completed";

export const CLIENT_NOTIFICATION_TYPE_LABELS: Record<ClientNotificationType, string> = {
  payment_confirmed: "Оплата подтверждена",
  order_picking: "Сборка",
  order_ready: "Готов к отгрузке",
  order_shipped: "Отгружен",
  order_completed: "Завершён",
};

/** Row from public.client_list_notifications. */
export type ClientNotification = {
  id: string;
  notification_type: ClientNotificationType;
  title: string;
  message: string | null;
  entity_type: string | null;
  entity_id: string | null;
  action_url: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

/** Row from public.staff_get_order_payment_summary / batch list. */
export type StaffOrderPaymentSummary = {
  order_id: string;
  order_number: string;
  order_status: OrderStatus;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  payment_status: OrderPaymentStatus;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_tax_mode: DocumentTaxMode | null;
  invoice_final_total: number | null;
  has_payment_shortfall: boolean;
  payment_due_at: string | null;
  obligation_frozen: boolean;
  obligation_source_type: "order" | "invoice" | null;
  obligation_source_number: string | null;
};

/** Compact row from public.staff_list_orders_payment_summaries. */
export type StaffOrderPaymentListSummary = {
  order_id: string;
  order_number: string;
  order_status: OrderStatus;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  payment_status: OrderPaymentStatus;
  invoice_id: string | null;
  invoice_number: string | null;
  has_payment_shortfall: boolean;
  payment_due_at: string | null;
  obligation_frozen: boolean;
  obligation_source_type: "order" | "invoice" | null;
};

/** Row from public.staff_list_order_payments. */
export type StaffOrderPaymentItem = {
  id: string;
  order_id: string;
  amount: number;
  payment_date: string;
  payment_method: OrderPaymentMethod;
  reference_number: string | null;
  comment: string | null;
  status: OrderPaymentRecordStatus;
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_at: string;
  reversed_by: string | null;
  reversed_by_name: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
};

export type OrderPaymentClaimStatus = "reported" | "confirmed";

export const ORDER_PAYMENT_CLAIM_STATUS_LABELS: Record<
  OrderPaymentClaimStatus,
  string
> = {
  reported: "Клиент сообщил об оплате",
  confirmed: "Оплата подтверждена",
};

/** Client-safe summary from public.client_get_order_payment_summary. */
export type ClientOrderPaymentSummary = {
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  payment_status: OrderPaymentStatus;
  invoice_number: string | null;
};

/** Client payment block from public.client_get_order_payment_flow (033). */
export type ClientOrderPaymentFlow = ClientOrderPaymentSummary & {
  invoice_id: string | null;
  kaspi_qr_path: string | null;
  claim_id: string | null;
  claim_status: OrderPaymentClaimStatus | null;
  claim_created_at: string | null;
};

/** Staff claim + Kaspi path from public.staff_get_order_payment_claim (033). */
export type StaffOrderPaymentClaim = {
  claim_id: string | null;
  status: OrderPaymentClaimStatus | null;
  created_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  confirmed_payment_id: string | null;
  kaspi_qr_path: string | null;
};

/** Aggregate from public.staff_get_customer_receivables. */
export type StaffCustomerReceivables = {
  customer_id: string;
  open_obligation_total: number;
  amount_paid_total: number;
  amount_outstanding_total: number;
  orders_with_balance_count: number;
  overdue_outstanding_total: number;
  overdue_orders_count: number;
};

/** Roles that may view/record order payments (not warehouse). */
export function canAccessOrderPayments(role: UserRole | null | undefined): boolean {
  return role === "manager" || role === "accountant" || role === "admin";
}

/** Roles that may reverse a payment. */
export function canReverseOrderPayments(role: UserRole | null | undefined): boolean {
  return role === "accountant" || role === "admin";
}

/** Stage 38 — financial product supplies (landed cost). Admin only. */
export type ProductSupplyStatus = "draft" | "closed";
export type ProductSupplyCurrency = "KZT" | "CNY" | "USD";

export const PRODUCT_SUPPLY_STATUS_LABELS: Record<ProductSupplyStatus, string> = {
  draft: "Черновик",
  closed: "Закрыта",
};

export const PRODUCT_SUPPLY_FINANCIAL_LABELS: Record<ProductSupplyStatus, string> = {
  draft: "Предварительная",
  closed: "Закрыта",
};

/** Stage 40 — factual Almaty receiving (independent of logistics / financial). */
export type ProductSupplyReceivingStatus = "not_started" | "in_progress" | "completed";

export const PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS: Record<
  ProductSupplyReceivingStatus,
  string
> = {
  not_started: "Не начата",
  in_progress: "В процессе",
  completed: "Завершена",
};

export type ProductSupplyDiscrepancyType =
  | "shortage"
  | "overage"
  | "damaged"
  | "wrong_product"
  | "pallet_mismatch"
  | "unexpected"
  | "other";

export const PRODUCT_SUPPLY_DISCREPANCY_LABELS: Record<
  ProductSupplyDiscrepancyType,
  string
> = {
  shortage: "Недостача",
  overage: "Излишек",
  damaged: "Повреждение",
  wrong_product: "Пересорт / другой товар",
  pallet_mismatch: "Неверное кол-во в паллете",
  unexpected: "Неожиданный товар",
  other: "Другое",
};

export const PRODUCT_SUPPLY_DISCREPANCY_TYPES: readonly ProductSupplyDiscrepancyType[] = [
  "shortage",
  "overage",
  "damaged",
  "wrong_product",
  "pallet_mismatch",
  "unexpected",
  "other",
];

export type ProductSupplyLogisticsStatus =
  | "draft"
  | "ordered"
  | "in_production"
  | "ready_at_factory"
  | "to_khorgos"
  | "khorgos_queue"
  | "khorgos_customs"
  | "to_almaty"
  | "arrived_almaty"
  | "completed";

export const PRODUCT_SUPPLY_LOGISTICS_STATUS_ORDER: readonly ProductSupplyLogisticsStatus[] = [
  "draft",
  "ordered",
  "in_production",
  "ready_at_factory",
  "to_khorgos",
  "khorgos_queue",
  "khorgos_customs",
  "to_almaty",
  "arrived_almaty",
  "completed",
];

export const PRODUCT_SUPPLY_LOGISTICS_LABELS: Record<ProductSupplyLogisticsStatus, string> = {
  draft: "Черновик",
  ordered: "Заказ отправлен заводу",
  in_production: "В производстве",
  ready_at_factory: "Готов на заводе",
  to_khorgos: "В пути до Хоргоса",
  khorgos_queue: "В очереди в Хоргосе",
  khorgos_customs: "На оформлении в Хоргосе",
  to_almaty: "В пути в Алматы",
  arrived_almaty: "Прибыл в Алматы",
  completed: "Завершено",
};

export type ProductSupplyDocumentType =
  | "factory_order"
  | "factory_shipment"
  | "commercial_invoice"
  | "packing_list"
  | "china_export_declaration"
  | "transit_declaration"
  | "kazakhstan_customs_declaration"
  | "cmr"
  | "transport_document"
  | "certificate"
  | "broker_document"
  | "expense_invoice"
  | "payment_document"
  | "other";

export const PRODUCT_SUPPLY_DOCUMENT_TYPE_ORDER: readonly ProductSupplyDocumentType[] = [
  "factory_order",
  "factory_shipment",
  "commercial_invoice",
  "packing_list",
  "china_export_declaration",
  "transit_declaration",
  "kazakhstan_customs_declaration",
  "cmr",
  "transport_document",
  "certificate",
  "broker_document",
  "expense_invoice",
  "payment_document",
  "other",
];

export const PRODUCT_SUPPLY_DOCUMENT_TYPE_LABELS: Record<ProductSupplyDocumentType, string> = {
  factory_order: "Заказ заводу",
  factory_shipment: "Накладная завода",
  commercial_invoice: "Commercial Invoice",
  packing_list: "Packing List",
  china_export_declaration: "Экспортная декларация Китая",
  transit_declaration: "Транзитная декларация",
  kazakhstan_customs_declaration: "ДТ Казахстан",
  cmr: "CMR",
  transport_document: "Транспортный документ",
  certificate: "Сертификат",
  broker_document: "Документ брокера",
  expense_invoice: "Счёт по расходу",
  payment_document: "Платёжный документ",
  other: "Другое",
};

export const PRODUCT_SUPPLY_IMPORT_DOCUMENT_TYPES: readonly ProductSupplyDocumentType[] = [
  "factory_order",
  "factory_shipment",
];

export type ProductSupplyParserStatus =
  | "uploaded"
  | "preview"
  | "committed"
  | "error"
  | "skipped";

export type ProductSupplyQtySource = "manual" | "ordered" | "shipped";

export type ProductSupplyComparisonStatus =
  | "match"
  | "under_shipped"
  | "over_shipped"
  | "new_in_shipment"
  | "missing_in_shipment"
  | "manual";

export const PRODUCT_SUPPLY_COMPARISON_LABELS: Record<ProductSupplyComparisonStatus, string> = {
  match: "Совпадает",
  under_shipped: "Недопоставка",
  over_shipped: "Перепоставка",
  new_in_shipment: "Новый товар в отгрузке",
  missing_in_shipment: "Нет в отгрузке",
  manual: "Вручную",
};

export const PRODUCT_SUPPLY_CURRENCY_LABELS: Record<ProductSupplyCurrency, string> = {
  KZT: "KZT",
  CNY: "CNY",
  USD: "USD",
};

export const PRODUCT_SUPPLY_CURRENCIES: readonly ProductSupplyCurrency[] = [
  "KZT",
  "CNY",
  "USD",
];

export type ProductSupplyExpensePreset = {
  key: string;
  name: string;
};

/** Suggested expense names; admin can still add any custom article. */
export const PRODUCT_SUPPLY_EXPENSE_PRESETS: readonly ProductSupplyExpensePreset[] = [
  { key: "customs", name: "Таможня" },
  { key: "duty", name: "Пошлина" },
  { key: "vat", name: "НДС" },
  { key: "svh", name: "СВХ" },
  { key: "urumqi_khorgos", name: "Урумчи → Хоргос" },
  { key: "export_customs", name: "Затаможка" },
  { key: "reload", name: "Перегрузка" },
  { key: "khorgos_almaty", name: "Хоргос → Алматы" },
  { key: "transit_declaration", name: "Транзитная декларация" },
  { key: "broker", name: "Брокер" },
  { key: "other", name: "Другие расходы" },
];

export type ProductSupplyListItem = {
  id: string;
  sequence_number: number;
  supply_number: string;
  title: string;
  supplier_name: string | null;
  supply_date: string;
  status: ProductSupplyStatus;
  logistics_status: ProductSupplyLogisticsStatus;
  gross_weight_kg: number | null;
  total_expenses_kzt: number | null;
  expense_per_kg: number | null;
  total_landed_cost_kzt: number | null;
  items_count: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type ProductSupplyHeader = {
  id: string;
  sequence_number: number;
  supply_number: string;
  title: string;
  supplier_name: string | null;
  supply_date: string;
  default_currency: ProductSupplyCurrency;
  default_exchange_rate_to_kzt: number | null;
  gross_weight_kg: number | null;
  notes: string | null;
  status: ProductSupplyStatus;
  logistics_status: ProductSupplyLogisticsStatus;
  receiving_status: ProductSupplyReceivingStatus;
  active_receiving_id: string | null;
  source_kind: "manual" | "import";
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  is_preliminary: boolean;
  inventory_receipt_id: string | null;
};

export type ProductSupplyFxRate = {
  currency: ProductSupplyCurrency;
  rate_to_kzt: number;
  effective_date: string | null;
  source_note: string | null;
  updated_at: string;
  updated_by: string | null;
};

export type ProductSupplyReceivingItem = {
  id: string;
  receiving_id: string;
  supply_item_id: string | null;
  product_id: string;
  sort_order: number;
  sku: string | null;
  name: string | null;
  spec: string | null;
  ordered_quantity: number | null;
  shipped_quantity: number | null;
  expected_quantity: number;
  received_quantity: number | null;
  damaged_quantity: number;
  accepted_quantity: number | null;
  difference_quantity: number | null;
  discrepancy_type: ProductSupplyDiscrepancyType | null;
  comment: string | null;
  is_unexpected: boolean;
  line_status: "pending" | "filled";
  stock_receipt_id: string | null;
};

export type ProductSupplyReceivingSummary = {
  expected_sum: number;
  received_sum: number;
  accepted_sum: number;
  damaged_sum: number;
  shortage_sum: number;
  overage_sum: number;
};

export type ProductSupplyReceiving = {
  id: string;
  supply_id: string;
  status: "draft" | "confirmed";
  warehouse_id: string | null;
  started_by: string;
  started_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  stock_receipt_batch_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  items: ProductSupplyReceivingItem[];
  summary: ProductSupplyReceivingSummary;
};

export type ProductSupplyItem = {
  id: string;
  supply_id: string;
  product_id: string;
  sku: string;
  name: string;
  original_sku: string | null;
  product_status: ProductStatus;
  sort_order: number;
  quantity: number;
  unit: string;
  purchase_currency: ProductSupplyCurrency;
  purchase_price_per_unit: number | null;
  exchange_rate_to_kzt: number | null;
  purchase_price_per_unit_kzt: number | null;
  unit_net_weight_kg: number | null;
  total_net_weight_kg: number | null;
  item_weight_share: number | null;
  allocated_gross_weight_kg: number | null;
  gross_weight_per_unit_kg: number | null;
  allocated_expenses_kzt: number | null;
  expense_per_unit_kzt: number | null;
  purchase_total_kzt: number | null;
  landed_cost_per_unit_kzt: number | null;
  landed_cost_total_kzt: number | null;
  received_quantity: number | null;
  damaged_quantity: number | null;
  accepted_quantity: number | null;
  qty_source: ProductSupplyQtySource;
  ordered_quantity: number | null;
  ordered_unit: string | null;
  ordered_purchase_currency: ProductSupplyCurrency | null;
  ordered_price_per_unit: number | null;
  ordered_amount: number | null;
  ordered_spec: string | null;
  ordered_name: string | null;
  ordered_source_document_id: string | null;
  shipped_quantity: number | null;
  shipped_unit: string | null;
  shipped_purchase_currency: ProductSupplyCurrency | null;
  shipped_price_per_unit: number | null;
  shipped_amount: number | null;
  shipped_spec: string | null;
  shipped_name: string | null;
  shipped_source_document_id: string | null;
};

export type ProductSupplyExpense = {
  id: string;
  supply_id: string;
  category_key: string;
  name: string;
  amount: number;
  currency: ProductSupplyCurrency;
  exchange_rate_to_kzt: number | null;
  use_custom_exchange_rate: boolean;
  amount_kzt: number | null;
  expense_date: string | null;
  notes: string | null;
  sort_order: number;
  linked_documents: ProductSupplyLinkedDocument[];
};

export type ProductSupplyLinkedDocument = {
  id: string;
  title: string;
  document_type: ProductSupplyDocumentType;
  original_filename: string;
};

export type SupplyDocumentRowMatchStatus =
  | "auto_match"
  | "needs_selection"
  | "unmatched"
  | "manual_match"
  | "skipped";

export const SUPPLY_DOCUMENT_ROW_MATCH_LABELS: Record<SupplyDocumentRowMatchStatus, string> = {
  auto_match: "Сопоставлено автоматически",
  needs_selection: "Требуется выбор товара",
  unmatched: "Товар не найден",
  manual_match: "Сопоставлено вручную",
  skipped: "Пропущена",
};

export type SupplyDocumentProductCandidate = {
  product_id: string;
  sku: string;
  name: string;
  original_sku: string | null;
  unit: string;
  status: string;
  dimensions: string | null;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
};

export type ProductSupplyDocument = {
  id: string;
  supply_id: string;
  document_type: ProductSupplyDocumentType;
  title: string;
  original_filename: string;
  storage_path: string;
  mime_type: string | null;
  file_size: number | null;
  content_sha256: string | null;
  uploaded_by: string;
  uploaded_by_name: string | null;
  uploaded_at: string;
  document_date: string | null;
  notes: string | null;
  source_kind: "upload" | "import";
  linked_expense_id: string | null;
  linked_expense_name: string | null;
  parser_status: ProductSupplyParserStatus | null;
  imported_at: string | null;
  imported_by: string | null;
  already_imported: boolean;
  parsed_row_count: number;
};

export type ProductSupplyStatusHistoryItem = {
  id: string;
  supply_id: string;
  from_status: ProductSupplyLogisticsStatus | null;
  to_status: ProductSupplyLogisticsStatus;
  changed_by: string;
  changed_by_name: string | null;
  changed_at: string;
  note: string | null;
  location: string | null;
};

export type ProductSupplyComparisonRow = {
  item_id: string;
  product_id: string;
  sku: string;
  name: string;
  unit: string;
  ordered_quantity: number | null;
  shipped_quantity: number | null;
  quantity_diff: number | null;
  ordered_price_per_unit: number | null;
  shipped_price_per_unit: number | null;
  price_diff: number | null;
  ordered_source_document_id: string | null;
  shipped_source_document_id: string | null;
  qty_source: ProductSupplyQtySource;
  status: ProductSupplyComparisonStatus;
  flags: string[];
};

export type ProductSupplyTotals = {
  total_net_weight_kg: number | null;
  gross_weight_kg: number | null;
  packaging_weight_kg: number | null;
  packaging_weight_pct: number | null;
  total_purchase_kzt: number | null;
  total_expenses_kzt: number | null;
  expense_per_kg: number | null;
  total_landed_cost_kzt: number | null;
  gross_lt_net: boolean;
};

export type ProductSupplyPayload = {
  supply: ProductSupplyHeader;
  items: ProductSupplyItem[];
  expenses: ProductSupplyExpense[];
  fx_rates: ProductSupplyFxRate[];
  receiving: ProductSupplyReceiving | null;
  documents: ProductSupplyDocument[];
  logistics_history: ProductSupplyStatusHistoryItem[];
  comparison: ProductSupplyComparisonRow[];
  totals: ProductSupplyTotals;
  fx_apply?: { items: number; expenses: number } | null;
};

export type ProductSupplyProductSearch = {
  id: string;
  sku: string;
  name: string;
  original_sku: string | null;
  unit: string;
  status: ProductStatus;
  weight_kg: number | null;
  dimensions: string | null;
  category_id: string | null;
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
};

export type ProductLandedCostHistoryItem = {
  supply_id: string;
  supply_number: string;
  sequence_number: number;
  title: string;
  supply_date: string;
  status: ProductSupplyStatus;
  quantity: number;
  unit: string;
  landed_cost_per_unit_kzt: number | null;
  is_preliminary: boolean;
  closed_at: string | null;
};

export function canAccessProductSupplies(role: UserRole | null | undefined): boolean {
  return role === "admin";
}
