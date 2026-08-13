import { supabase } from "@/lib/supabase/client";
import type {
  DocumentTaxMode,
  OrganizationAssetKind,
  OrganizationSettings,
  OrganizationSettingsUpdate,
} from "@/types/database";

export type { OrganizationSettings, OrganizationSettingsUpdate, OrganizationAssetKind };

function mapSettings(row: OrganizationSettings): OrganizationSettings {
  return {
    id: row.id,
    singleton_key: "default",
    legal_name: row.legal_name,
    bin: row.bin,
    address: row.address,
    city: row.city,
    phone: row.phone,
    email: row.email,
    website: row.website ?? null,
    whatsapp: row.whatsapp ?? null,
    bank_name: row.bank_name,
    bank_bik: row.bank_bik,
    bank_iik: row.bank_iik,
    bank_kbe: row.bank_kbe,
    director_name: row.director_name,
    warehouse_name: row.warehouse_name,
    warehouse_code: row.warehouse_code,
    warehouse_address: row.warehouse_address ?? null,
    default_tax_mode: row.default_tax_mode,
    vat_rate: row.vat_rate,
    logo_path: row.logo_path ?? null,
    stamp_path: row.stamp_path ?? null,
    signature_path: row.signature_path ?? null,
    kaspi_qr_path: row.kaspi_qr_path ?? null,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getOrganizationSettings(): Promise<OrganizationSettings> {
  const { data, error } = await supabase.rpc("staff_get_organization_settings");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить реквизиты организации");
  }

  if (!data) {
    throw new Error("organization_settings не найдена");
  }

  return mapSettings(data as OrganizationSettings);
}

export async function updateOrganizationSettings(
  input: OrganizationSettingsUpdate,
): Promise<OrganizationSettings> {
  const { data, error } = await supabase.rpc("staff_upsert_organization_settings", {
    p_legal_name: input.legal_name,
    p_bin: input.bin,
    p_address: input.address,
    p_phone: input.phone,
    p_bank_name: input.bank_name,
    p_bank_bik: input.bank_bik,
    p_bank_iik: input.bank_iik,
    p_bank_kbe: input.bank_kbe,
    p_director_name: input.director_name,
    p_city: input.city ?? null,
    p_email: input.email ?? null,
    p_warehouse_name: input.warehouse_name ?? null,
    p_warehouse_code: input.warehouse_code ?? null,
    p_default_tax_mode: input.default_tax_mode,
    p_vat_rate: input.vat_rate,
    p_website: input.website ?? null,
    p_whatsapp: input.whatsapp ?? null,
    p_warehouse_address: input.warehouse_address ?? null,
    p_logo_path: input.logo_path ?? null,
    p_stamp_path: input.stamp_path ?? null,
    p_signature_path: input.signature_path ?? null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось сохранить реквизиты организации");
  }

  return mapSettings(data as OrganizationSettings);
}

export async function setOrganizationAssetPath(
  kind: OrganizationAssetKind,
  path: string | null,
): Promise<OrganizationSettings> {
  const { data, error } = await supabase.rpc("staff_set_organization_asset_path", {
    p_kind: kind,
    p_path: path,
  });

  if (error) {
    throw new Error(error.message || "Не удалось обновить путь изображения");
  }

  return mapSettings(data as OrganizationSettings);
}

export function emptyOrganizationForm(
  defaults?: Partial<OrganizationSettings>,
): OrganizationSettingsUpdate {
  return {
    legal_name: defaults?.legal_name ?? "",
    bin: defaults?.bin ?? "",
    address: defaults?.address ?? "",
    city: defaults?.city ?? "",
    phone: defaults?.phone ?? "",
    email: defaults?.email ?? "",
    website: defaults?.website ?? "",
    whatsapp: defaults?.whatsapp ?? "",
    bank_name: defaults?.bank_name ?? "",
    bank_bik: defaults?.bank_bik ?? "",
    bank_iik: defaults?.bank_iik ?? "",
    bank_kbe: defaults?.bank_kbe ?? "",
    director_name: defaults?.director_name ?? "",
    warehouse_name: defaults?.warehouse_name ?? "",
    warehouse_code: defaults?.warehouse_code ?? "",
    warehouse_address: defaults?.warehouse_address ?? "",
    default_tax_mode: (defaults?.default_tax_mode ?? "without_vat") as DocumentTaxMode,
    vat_rate: defaults?.vat_rate ?? null,
    logo_path: defaults?.logo_path ?? null,
    stamp_path: defaults?.stamp_path ?? null,
    signature_path: defaults?.signature_path ?? null,
  };
}
