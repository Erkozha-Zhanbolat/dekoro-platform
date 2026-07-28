export type UserRole = "client" | "manager" | "accountant" | "warehouse" | "admin";

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  client: "Клиент",
  manager: "Менеджер",
  accountant: "Бухгалтер",
  warehouse: "Склад",
  admin: "Администратор",
};

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

export type OrderStatus = "new" | "processing" | "completed" | "cancelled";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Новый",
  processing: "В обработке",
  completed: "Завершён",
  cancelled: "Отменён",
};

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
  created_at: string;
  updated_at: string;
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
