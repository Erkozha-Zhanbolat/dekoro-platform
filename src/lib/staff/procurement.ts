import {
  mapProcurementSettings,
  mapProcurementSnapshot,
  type ProcurementSettings,
  type ProcurementSnapshot,
} from "@/lib/staff/procurementAnalytics";
import { supabase } from "@/lib/supabase/client";

export * from "@/lib/staff/procurementAnalytics";

export async function getProcurementSettings(): Promise<ProcurementSettings> {
  const { data, error } = await supabase.rpc("staff_get_procurement_settings");
  if (error) {
    throw new Error(error.message || "Не удалось загрузить настройки закупки");
  }
  return mapProcurementSettings((data ?? {}) as Record<string, unknown>);
}

export async function updateProcurementSettings(input: {
  leadTimeDays: number;
  safetyStockDays: number;
  weight7: number;
  weight30: number;
  weight90: number;
}): Promise<ProcurementSettings> {
  const { data, error } = await supabase.rpc("staff_update_procurement_settings", {
    p_lead_time_days: input.leadTimeDays,
    p_safety_stock_days: input.safetyStockDays,
    p_velocity_weight_7: input.weight7,
    p_velocity_weight_30: input.weight30,
    p_velocity_weight_90: input.weight90,
  });
  if (error) {
    throw new Error(error.message || "Не удалось сохранить настройки закупки");
  }
  return mapProcurementSettings((data ?? {}) as Record<string, unknown>);
}

export async function getProcurementSnapshot(): Promise<ProcurementSnapshot> {
  const { data, error } = await supabase.rpc("staff_get_procurement_snapshot");
  if (error) {
    throw new Error(error.message || "Не удалось загрузить закупочную аналитику");
  }
  return mapProcurementSnapshot(data);
}
