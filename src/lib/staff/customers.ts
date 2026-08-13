import { supabase } from "@/lib/supabase/client";
import {
  normalizeCustomerEmail,
  normalizeCustomerPhone,
} from "@/lib/staff/customerDetails";
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
  /**
   * Omit/undefined/null keeps the existing DB value (RPC NULL = keep).
   * Pass '' to clear. Company legal address is `address` (Stage 23 invoice).
   */
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
    p_display_name: input.display_name.trim(),
    p_legal_name: input.legal_name?.trim() || null,
    p_phone: input.phone ? normalizeCustomerPhone(input.phone) : null,
    p_email: input.email ? normalizeCustomerEmail(input.email) : null,
    p_iin_bin: input.iin_bin?.trim() || null,
    p_contact_person: input.contact_person?.trim() || null,
    p_address: input.address?.trim() || null,
    p_city: input.city?.trim() || null,
    p_source: input.source ?? "staff",
    p_notes: input.notes?.trim() || null,
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
  // RPC semantics (013/034): NULL/omit = keep; '' = clear; value = set.
  // Individual edits omit company-only keys so they are not wiped.
  const payload: Record<string, string | null> = {
    p_customer_id: customerId,
    p_display_name: input.display_name.trim(),
  };

  if (input.legal_name !== undefined) {
    payload.p_legal_name = input.legal_name?.trim() ?? "";
  }
  if (input.phone !== undefined) {
    payload.p_phone = input.phone ? normalizeCustomerPhone(input.phone) : "";
  }
  if (input.email !== undefined) {
    payload.p_email = input.email ? normalizeCustomerEmail(input.email) : "";
  }
  if (input.iin_bin !== undefined) {
    payload.p_iin_bin = input.iin_bin?.trim() ?? "";
  }
  if (input.contact_person !== undefined) {
    payload.p_contact_person = input.contact_person?.trim() ?? "";
  }
  if (input.address !== undefined) {
    payload.p_address = input.address?.trim() ?? "";
  }
  if (input.city !== undefined) {
    payload.p_city = input.city?.trim() ?? "";
  }
  if (input.source !== undefined) {
    payload.p_source = input.source ?? "";
  }
  if (input.notes !== undefined) {
    payload.p_notes = input.notes?.trim() ?? "";
  }

  const { data, error } = await supabase.rpc("staff_update_customer", payload as {
    p_customer_id: string;
    p_display_name: string;
    p_legal_name?: string;
    p_phone?: string;
    p_email?: string;
    p_iin_bin?: string;
    p_contact_person?: string;
    p_address?: string;
    p_city?: string;
    p_source?: string;
    p_notes?: string;
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
