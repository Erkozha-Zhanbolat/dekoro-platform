import { mapInventoryBalanceReport, type InventoryBalanceReport } from "@/lib/staff/inventoryBalance";
import { supabase } from "@/lib/supabase/client";

export async function getInventoryBalanceReport(): Promise<InventoryBalanceReport> {
  const { data, error } = await supabase.rpc("staff_get_inventory_balance_report");
  if (error) {
    throw new Error(error.message || "Не удалось загрузить отчёт по остаткам");
  }
  return mapInventoryBalanceReport(data);
}
