import { supabase } from "@/lib/supabase/client";
import type {
  CustomerType,
  OrganizationPaymentProfile,
  OrganizationPaymentProfileUpdate,
} from "@/types/database";

export type { OrganizationPaymentProfile, OrganizationPaymentProfileUpdate };

function mapProfile(row: OrganizationPaymentProfile): OrganizationPaymentProfile {
  return {
    id: row.id,
    customer_type: row.customer_type,
    beneficiary_name: row.beneficiary_name,
    bin_iin: row.bin_iin,
    bank_name: row.bank_name,
    bank_bik: row.bank_bik,
    bank_iik: row.bank_iik,
    bank_kbe: row.bank_kbe,
    payment_purpose_code: row.payment_purpose_code ?? null,
    is_active: row.is_active,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listOrganizationPaymentProfiles(): Promise<
  OrganizationPaymentProfile[]
> {
  const { data, error } = await supabase.rpc(
    "staff_list_organization_payment_profiles",
  );

  if (error) {
    throw new Error(error.message || "Не удалось загрузить платёжные реквизиты");
  }

  return ((data as OrganizationPaymentProfile[] | null) ?? []).map(mapProfile);
}

export async function upsertOrganizationPaymentProfile(
  input: OrganizationPaymentProfileUpdate,
): Promise<OrganizationPaymentProfile> {
  const { data, error } = await supabase.rpc(
    "staff_upsert_organization_payment_profile",
    {
      p_customer_type: input.customer_type,
      p_beneficiary_name: input.beneficiary_name,
      p_bin_iin: input.bin_iin,
      p_bank_name: input.bank_name,
      p_bank_bik: input.bank_bik,
      p_bank_iik: input.bank_iik,
      p_bank_kbe: input.bank_kbe,
      p_payment_purpose_code: input.payment_purpose_code || null,
      p_is_active: input.is_active,
    },
  );

  if (error) {
    throw new Error(error.message || "Не удалось сохранить платёжные реквизиты");
  }

  return mapProfile(data as OrganizationPaymentProfile);
}

export function emptyPaymentProfileForm(
  customerType: CustomerType,
  defaults?: Partial<OrganizationPaymentProfile>,
): OrganizationPaymentProfileUpdate {
  return {
    customer_type: customerType,
    beneficiary_name: defaults?.beneficiary_name ?? "",
    bin_iin: defaults?.bin_iin ?? "",
    bank_name: defaults?.bank_name ?? "",
    bank_bik: defaults?.bank_bik ?? "",
    bank_iik: defaults?.bank_iik ?? "",
    bank_kbe: defaults?.bank_kbe ?? "",
    payment_purpose_code: defaults?.payment_purpose_code ?? "",
    is_active: defaults?.is_active ?? true,
  };
}
