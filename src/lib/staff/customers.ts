import { supabase } from "@/lib/supabase/client";
import type {
  Customer,
  CustomerSource,
  CustomerType,
  OrderStatus,
  StaffCustomerDetails,
  StaffCustomerSearchResult,
} from "@/types/database";

/**
 * Staff-facing customers API (supabase/migrations/013_customers_foundation.sql).
 *
 * All reads/writes go through SECURITY DEFINER RPCs — no direct table
 * access to public.customers from the client beyond the own-row SELECT
 * policy (unused here).
 */

export type { Customer, CustomerSource, CustomerType, StaffCustomerDetails, StaffCustomerSearchResult };

export type StaffCustomerOrderListItem = {
  id: string;
  order_number: string;
  status: OrderStatus;
  total: number;
  created_at: string;
  contact_name: string;
  contact_phone: string;
};

export type StaffCreateCustomerInput = {
  customer_type: CustomerType;
  display_name: string;
  legal_name?: string | null;
  phone?: string | null;
  email?: string | null;
  iin_bin?: string | null;
  contact_person?: string | null;
  address?: string | null;
  city?: string | null;
  source?: CustomerSource | null;
  notes?: string | null;
};

export type StaffUpdateCustomerInput = {
  display_name: string;
  /** Pass '' to clear; omit/undefined keeps existing (RPC NULL = keep). */
  legal_name?: string | null;
  phone?: string | null;
  email?: string | null;
  iin_bin?: string | null;
  contact_person?: string | null;
  address?: string | null;
  city?: string | null;
  source?: CustomerSource | "" | null;
  notes?: string | null;
};

const DEFAULT_CUSTOMER_SEARCH_LIMIT = 30;

function mapCustomerRow(row: Customer): Customer {
  return {
    id: row.id,
    customer_type: row.customer_type,
    profile_id: row.profile_id,
    company_id: row.company_id,
    display_name: row.display_name,
    legal_name: row.legal_name,
    phone: row.phone,
    email: row.email,
    iin_bin: row.iin_bin,
    contact_person: row.contact_person,
    address: row.address,
    city: row.city,
    source: row.source,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    price_group_id: row.price_group_id ?? null,
  };
}

export async function searchStaffCustomers(
  query: string,
  limit: number = DEFAULT_CUSTOMER_SEARCH_LIMIT,
): Promise<StaffCustomerSearchResult[]> {
  const trimmed = query.trim();

  const { data, error } = await supabase.rpc("staff_search_customers", {
    p_query: trimmed.length > 0 ? trimmed : null,
    p_limit: limit,
  });

  if (error) {
    throw new Error(error.message || "Не удалось выполнить поиск клиентов");
  }

  return ((data as StaffCustomerSearchResult[] | null) ?? []).map((row) => ({
    id: row.id,
    customer_type: row.customer_type,
    display_name: row.display_name,
    legal_name: row.legal_name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    source: row.source,
    profile_id: row.profile_id,
    company_id: row.company_id,
    orders_count: Number(row.orders_count),
    last_order_at: row.last_order_at,
  }));
}

export async function getStaffCustomer(customerId: string): Promise<StaffCustomerDetails | null> {
  const { data, error } = await supabase.rpc("staff_get_customer", {
    p_customer_id: customerId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить клиента");
  }

  const [row] = (data as StaffCustomerDetails[] | null) ?? [];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    customer_type: row.customer_type,
    profile_id: row.profile_id,
    company_id: row.company_id,
    display_name: row.display_name,
    legal_name: row.legal_name,
    phone: row.phone,
    email: row.email,
    iin_bin: row.iin_bin,
    contact_person: row.contact_person,
    address: row.address,
    city: row.city,
    source: row.source,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_registered: row.is_registered,
    orders_count: Number(row.orders_count),
    last_order_at: row.last_order_at,
    price_group_id: row.price_group_id ?? null,
    price_group_name: row.price_group_name ?? null,
    price_group_is_default: Boolean(row.price_group_is_default),
  };
}

export async function createStaffCustomer(input: StaffCreateCustomerInput): Promise<Customer> {
  const { data, error } = await supabase.rpc("staff_create_customer", {
    p_customer_type: input.customer_type,
    p_display_name: input.display_name,
    p_legal_name: input.legal_name ?? null,
    p_phone: input.phone ?? null,
    p_email: input.email ?? null,
    p_iin_bin: input.iin_bin ?? null,
    p_contact_person: input.contact_person ?? null,
    p_address: input.address ?? null,
    p_city: input.city ?? null,
    p_source: input.source ?? "staff",
    p_notes: input.notes ?? null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось создать клиента");
  }

  return mapCustomerRow(data as Customer);
}

export async function updateStaffCustomer(
  customerId: string,
  input: StaffUpdateCustomerInput,
): Promise<Customer> {
  // RPC semantics (013): NULL = keep field; '' = clear to null; value = set.
  // Full-form UI always sends every field as string (possibly '').
  const { data, error } = await supabase.rpc("staff_update_customer", {
    p_customer_id: customerId,
    p_display_name: input.display_name,
    p_legal_name: input.legal_name ?? "",
    p_phone: input.phone ?? "",
    p_email: input.email ?? "",
    p_iin_bin: input.iin_bin ?? "",
    p_contact_person: input.contact_person ?? "",
    p_address: input.address ?? "",
    p_city: input.city ?? "",
    p_source: input.source ?? "",
    p_notes: input.notes ?? "",
  });

  if (error) {
    throw new Error(error.message || "Не удалось обновить клиента");
  }

  return mapCustomerRow(data as Customer);
}

export async function listStaffCustomerOrders(
  customerId: string,
): Promise<StaffCustomerOrderListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_customer_orders", {
    p_customer_id: customerId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить заказы клиента");
  }

  return ((data as StaffCustomerOrderListItem[] | null) ?? []).map((row) => ({
    id: row.id,
    order_number: row.order_number,
    status: row.status,
    total: Number(row.total),
    created_at: row.created_at,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
  }));
}
