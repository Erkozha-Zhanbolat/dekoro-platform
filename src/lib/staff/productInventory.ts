import { supabase } from "@/lib/supabase/client";
import type {
  StaffInventoryAdjustment,
  StaffProductInventory,
  StaffProductInventoryAdjustResult,
} from "@/types/database";

export type {
  StaffInventoryAdjustment,
  StaffProductInventory,
  StaffProductInventoryAdjustResult,
};

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function mapInventory(row: StaffProductInventory): StaffProductInventory {
  return {
    inventory_id: row.inventory_id,
    product_id: row.product_id,
    warehouse_id: row.warehouse_id,
    warehouse_code: row.warehouse_code,
    quantity: asNumber(row.quantity, 0),
    reserved_quantity: asNumber(row.reserved_quantity, 0),
    available_quantity: asNumber(row.available_quantity, 0),
  };
}

function mapAdjustment(row: StaffInventoryAdjustment): StaffInventoryAdjustment {
  return {
    id: row.id,
    inventory_id: row.inventory_id,
    product_id: row.product_id,
    warehouse_id: row.warehouse_id,
    previous_quantity: asNumber(row.previous_quantity, 0),
    new_quantity: asNumber(row.new_quantity, 0),
    difference: asNumber(row.difference, 0),
    reason: row.reason,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
  };
}

export async function getStaffProductInventory(
  productId: string,
): Promise<StaffProductInventory> {
  const { data, error } = await supabase.rpc("staff_get_product_inventory", {
    p_product_id: productId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить остаток");
  }

  const rows = (data as StaffProductInventory[] | null) ?? [];
  if (rows.length === 0) {
    throw new Error("Склад ALMATY-01 не найден");
  }

  return mapInventory(rows[0]);
}

export async function adjustStaffProductInventory(input: {
  productId: string;
  newQuantity: number;
  reason: string;
}): Promise<StaffProductInventoryAdjustResult> {
  const { data, error } = await supabase.rpc("staff_adjust_product_inventory", {
    p_product_id: input.productId,
    p_new_quantity: input.newQuantity,
    p_reason: input.reason,
  });

  if (error) {
    throw new Error(error.message || "Не удалось изменить остаток");
  }

  const rows = (data as StaffProductInventoryAdjustResult[] | null) ?? [];
  if (rows.length === 0) {
    throw new Error("Пустой ответ при корректировке остатка");
  }

  const row = rows[0];
  return {
    ...mapInventory(row),
    adjusted: Boolean(row.adjusted),
  };
}

export async function listStaffProductInventoryAdjustments(
  productId: string,
  limit = 50,
): Promise<StaffInventoryAdjustment[]> {
  const { data, error } = await supabase.rpc(
    "staff_list_product_inventory_adjustments",
    {
      p_product_id: productId,
      p_limit: limit,
    },
  );

  if (error) {
    throw new Error(error.message || "Не удалось загрузить историю остатков");
  }

  return ((data as StaffInventoryAdjustment[] | null) ?? []).map(mapAdjustment);
}
