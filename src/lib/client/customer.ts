import { supabase } from "@/lib/supabase/client";
import {
  normalizeCustomerEmail,
  normalizeCustomerPhone,
} from "@/lib/staff/customerDetails";
import type { ClientCustomerDetails } from "@/types/database";

export type { ClientCustomerDetails };

export type ClientUpdateMyCustomerInput = {
  display_name?: string;
  legal_name?: string;
  iin_bin?: string;
  city: string;
  address?: string;
  contact_person?: string;
  phone: string;
  email: string;
};

function mapRow(row: ClientCustomerDetails): ClientCustomerDetails {
  return {
    id: row.id,
    customer_type: row.customer_type,
    display_name: row.display_name,
    legal_name: row.legal_name,
    phone: row.phone,
    email: row.email,
    iin_bin: row.iin_bin,
    contact_person: row.contact_person,
    address: row.address,
    city: row.city,
  };
}

export async function getMyCustomerDetails(): Promise<ClientCustomerDetails | null> {
  const { data, error } = await supabase.rpc("client_get_my_customer_details");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить данные клиента");
  }

  const [row] = (data as ClientCustomerDetails[] | null) ?? [];
  return row ? mapRow(row) : null;
}

export async function updateMyCustomerDetails(
  input: ClientUpdateMyCustomerInput,
): Promise<ClientCustomerDetails> {
  const { data, error } = await supabase.rpc("client_update_my_customer_details", {
    p_display_name: input.display_name?.trim() || null,
    p_legal_name: input.legal_name?.trim() || null,
    p_iin_bin: input.iin_bin?.trim() || null,
    p_city: input.city.trim(),
    p_address: input.address?.trim() || null,
    p_contact_person: input.contact_person?.trim() || null,
    p_phone: normalizeCustomerPhone(input.phone),
    p_email: normalizeCustomerEmail(input.email),
  });

  if (error) {
    throw new Error(error.message || "Не удалось сохранить данные");
  }

  const [row] = (data as ClientCustomerDetails[] | null) ?? [];
  if (!row) {
    throw new Error("Не удалось сохранить данные");
  }

  return mapRow(row);
}
