import { supabase } from "@/lib/supabase/client";
import type {
  ProductLandedCostHistoryItem,
  ProductSupplyCurrency,
  ProductSupplyExpense,
  ProductSupplyHeader,
  ProductSupplyItem,
  ProductSupplyListItem,
  ProductSupplyPayload,
  ProductSupplyProductSearch,
  ProductSupplyStatus,
  ProductSupplyTotals,
  ProductStatus,
} from "@/types/database";

export type {
  ProductLandedCostHistoryItem,
  ProductSupplyCurrency,
  ProductSupplyExpense,
  ProductSupplyHeader,
  ProductSupplyItem,
  ProductSupplyListItem,
  ProductSupplyPayload,
  ProductSupplyProductSearch,
  ProductSupplyStatus,
  ProductSupplyTotals,
};

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = asNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

function asNullableString(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function mapListItem(row: Record<string, unknown>): ProductSupplyListItem {
  return {
    id: asString(row.id),
    sequence_number: asNumber(row.sequence_number, 0),
    supply_number: asString(row.supply_number),
    title: asString(row.title),
    supplier_name: asNullableString(row.supplier_name),
    supply_date: asString(row.supply_date),
    status: asString(row.status, "draft") as ProductSupplyStatus,
    gross_weight_kg: asNullableNumber(row.gross_weight_kg),
    total_expenses_kzt: asNullableNumber(row.total_expenses_kzt),
    expense_per_kg: asNullableNumber(row.expense_per_kg),
    total_landed_cost_kzt: asNullableNumber(row.total_landed_cost_kzt),
    items_count: asNumber(row.items_count, 0),
    created_at: asString(row.created_at),
    closed_at: asNullableString(row.closed_at),
  };
}

function mapHeader(row: Record<string, unknown>): ProductSupplyHeader {
  return {
    id: asString(row.id),
    sequence_number: asNumber(row.sequence_number, 0),
    supply_number: asString(row.supply_number),
    title: asString(row.title),
    supplier_name: asNullableString(row.supplier_name),
    supply_date: asString(row.supply_date),
    default_currency: asString(row.default_currency, "CNY") as ProductSupplyCurrency,
    default_exchange_rate_to_kzt: asNullableNumber(row.default_exchange_rate_to_kzt),
    gross_weight_kg: asNullableNumber(row.gross_weight_kg),
    notes: asNullableString(row.notes),
    status: asString(row.status, "draft") as ProductSupplyStatus,
    source_kind: row.source_kind === "import" ? "import" : "manual",
    created_by: asString(row.created_by),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    closed_at: asNullableString(row.closed_at),
    closed_by: asNullableString(row.closed_by),
    is_preliminary: Boolean(row.is_preliminary),
  };
}

function mapItem(row: Record<string, unknown>): ProductSupplyItem {
  return {
    id: asString(row.id),
    supply_id: asString(row.supply_id),
    product_id: asString(row.product_id),
    sku: asString(row.sku),
    name: asString(row.name),
    original_sku: asNullableString(row.original_sku),
    product_status: asString(row.product_status, "draft") as ProductStatus,
    sort_order: asNumber(row.sort_order, 0),
    quantity: asNumber(row.quantity, 0),
    unit: asString(row.unit, "шт."),
    purchase_currency: asString(row.purchase_currency, "KZT") as ProductSupplyCurrency,
    purchase_price_per_unit: asNullableNumber(row.purchase_price_per_unit),
    exchange_rate_to_kzt: asNullableNumber(row.exchange_rate_to_kzt),
    purchase_price_per_unit_kzt: asNullableNumber(row.purchase_price_per_unit_kzt),
    unit_net_weight_kg: asNullableNumber(row.unit_net_weight_kg),
    total_net_weight_kg: asNullableNumber(row.total_net_weight_kg),
    item_weight_share: asNullableNumber(row.item_weight_share),
    allocated_gross_weight_kg: asNullableNumber(row.allocated_gross_weight_kg),
    gross_weight_per_unit_kg: asNullableNumber(row.gross_weight_per_unit_kg),
    allocated_expenses_kzt: asNullableNumber(row.allocated_expenses_kzt),
    expense_per_unit_kzt: asNullableNumber(row.expense_per_unit_kzt),
    purchase_total_kzt: asNullableNumber(row.purchase_total_kzt),
    landed_cost_per_unit_kzt: asNullableNumber(row.landed_cost_per_unit_kzt),
    landed_cost_total_kzt: asNullableNumber(row.landed_cost_total_kzt),
  };
}

function mapExpense(row: Record<string, unknown>): ProductSupplyExpense {
  return {
    id: asString(row.id),
    supply_id: asString(row.supply_id),
    category_key: asString(row.category_key, "custom"),
    name: asString(row.name),
    amount: asNumber(row.amount, 0),
    currency: asString(row.currency, "KZT") as ProductSupplyCurrency,
    exchange_rate_to_kzt: asNullableNumber(row.exchange_rate_to_kzt),
    amount_kzt: asNullableNumber(row.amount_kzt),
    expense_date: asNullableString(row.expense_date),
    notes: asNullableString(row.notes),
    sort_order: asNumber(row.sort_order, 0),
  };
}

function mapTotals(row: Record<string, unknown>): ProductSupplyTotals {
  return {
    total_net_weight_kg: asNullableNumber(row.total_net_weight_kg),
    gross_weight_kg: asNullableNumber(row.gross_weight_kg),
    packaging_weight_kg: asNullableNumber(row.packaging_weight_kg),
    packaging_weight_pct: asNullableNumber(row.packaging_weight_pct),
    total_purchase_kzt: asNullableNumber(row.total_purchase_kzt),
    total_expenses_kzt: asNullableNumber(row.total_expenses_kzt),
    expense_per_kg: asNullableNumber(row.expense_per_kg),
    total_landed_cost_kzt: asNullableNumber(row.total_landed_cost_kzt),
    gross_lt_net: Boolean(row.gross_lt_net),
  };
}

function mapPayload(data: unknown): ProductSupplyPayload {
  const row = (data ?? {}) as Record<string, unknown>;
  const supply = (row.supply ?? {}) as Record<string, unknown>;
  const items = (row.items as Record<string, unknown>[] | null) ?? [];
  const expenses = (row.expenses as Record<string, unknown>[] | null) ?? [];
  const totals = (row.totals ?? {}) as Record<string, unknown>;
  return {
    supply: mapHeader(supply),
    items: items.map(mapItem),
    expenses: expenses.map(mapExpense),
    totals: mapTotals(totals),
  };
}

function throwRpc(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function listProductSupplies(params: {
  status?: ProductSupplyStatus | "";
  limit?: number;
} = {}): Promise<ProductSupplyListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_product_supplies", {
    p_status: params.status || null,
    p_limit: params.limit ?? 50,
  });
  if (error) throwRpc(error, "Не удалось загрузить поставки");
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapListItem);
}

export async function getProductSupply(supplyId: string): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_get_product_supply", {
    p_supply_id: supplyId,
  });
  if (error) throwRpc(error, "Не удалось загрузить поставку");
  if (!data) throw new Error("Поставка не найдена");
  return mapPayload(data);
}

export async function createProductSupply(input: {
  title: string;
  supplierName?: string | null;
  supplyDate?: string | null;
  defaultCurrency?: ProductSupplyCurrency;
  defaultExchangeRateToKzt?: number | null;
  grossWeightKg?: number | null;
  notes?: string | null;
}): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_create_product_supply", {
    p_title: input.title,
    p_supplier_name: input.supplierName?.trim() || null,
    p_supply_date: input.supplyDate || null,
    p_default_currency: input.defaultCurrency ?? "CNY",
    p_default_exchange_rate_to_kzt: input.defaultExchangeRateToKzt ?? null,
    p_gross_weight_kg: input.grossWeightKg ?? null,
    p_notes: input.notes?.trim() || null,
  });
  if (error) throwRpc(error, "Не удалось создать поставку");
  return mapPayload(data);
}

export async function updateProductSupply(
  supplyId: string,
  input: {
    title?: string;
    supplierName?: string | null;
    supplyDate?: string | null;
    defaultCurrency?: ProductSupplyCurrency;
    defaultExchangeRateToKzt?: number | null;
    grossWeightKg?: number | null;
    notes?: string | null;
    clearSupplier?: boolean;
    clearNotes?: boolean;
    clearGrossWeight?: boolean;
  },
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_update_product_supply", {
    p_supply_id: supplyId,
    p_title: input.title ?? null,
    p_supplier_name: input.supplierName ?? null,
    p_supply_date: input.supplyDate ?? null,
    p_default_currency: input.defaultCurrency ?? null,
    p_default_exchange_rate_to_kzt: input.defaultExchangeRateToKzt ?? null,
    p_gross_weight_kg: input.grossWeightKg ?? null,
    p_notes: input.notes ?? null,
    p_clear_supplier: input.clearSupplier ?? false,
    p_clear_notes: input.clearNotes ?? false,
    p_clear_gross_weight: input.clearGrossWeight ?? false,
  });
  if (error) throwRpc(error, "Не удалось сохранить поставку");
  return mapPayload(data);
}

export async function deleteProductSupply(supplyId: string): Promise<void> {
  const { error } = await supabase.rpc("staff_delete_product_supply", {
    p_supply_id: supplyId,
  });
  if (error) throwRpc(error, "Не удалось удалить поставку");
}

export async function searchProductsForSupply(
  query: string,
  limit = 30,
): Promise<ProductSupplyProductSearch[]> {
  const { data, error } = await supabase.rpc("staff_search_products_for_supply", {
    p_query: query.trim() || null,
    p_limit: limit,
  });
  if (error) throwRpc(error, "Не удалось найти товары");
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    id: asString(row.id),
    sku: asString(row.sku),
    name: asString(row.name),
    original_sku: asNullableString(row.original_sku),
    unit: asString(row.unit, "шт."),
    status: asString(row.status, "draft") as ProductStatus,
    weight_kg: asNullableNumber(row.weight_kg),
  }));
}

export async function createDraftProductForSupply(input: {
  sku: string;
  name: string;
  unit?: string;
  originalSku?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
  weightKg?: number | null;
}): Promise<ProductSupplyProductSearch> {
  const { data, error } = await supabase.rpc("staff_create_draft_product_for_supply", {
    p_sku: input.sku,
    p_name: input.name,
    p_unit: input.unit ?? "шт.",
    p_original_sku: input.originalSku?.trim() || null,
    p_category_id: input.categoryId || null,
    p_subcategory_id: input.subcategoryId || null,
    p_weight_kg: input.weightKg ?? null,
  });
  if (error) throwRpc(error, "Не удалось создать товар");
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    id: asString(row.id),
    sku: asString(row.sku),
    name: asString(row.name),
    original_sku: asNullableString(row.original_sku),
    unit: asString(row.unit, "шт."),
    status: asString(row.status, "draft") as ProductStatus,
    weight_kg: asNullableNumber(row.weight_kg),
  };
}

export async function addProductSupplyItem(input: {
  supplyId: string;
  productId: string;
  quantity: number;
  unitNetWeightKg?: number | null;
  purchasePricePerUnit?: number | null;
  purchaseCurrency?: ProductSupplyCurrency | null;
  exchangeRateToKzt?: number | null;
}): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_add_product_supply_item", {
    p_supply_id: input.supplyId,
    p_product_id: input.productId,
    p_quantity: input.quantity,
    p_unit_net_weight_kg: input.unitNetWeightKg ?? null,
    p_purchase_price_per_unit: input.purchasePricePerUnit ?? null,
    p_purchase_currency: input.purchaseCurrency ?? null,
    p_exchange_rate_to_kzt: input.exchangeRateToKzt ?? null,
  });
  if (error) throwRpc(error, "Не удалось добавить товар");
  return mapPayload(data);
}

export async function updateProductSupplyItem(
  itemId: string,
  input: {
    quantity?: number | null;
    unitNetWeightKg?: number | null;
    purchasePricePerUnit?: number | null;
    purchaseCurrency?: ProductSupplyCurrency | null;
    exchangeRateToKzt?: number | null;
    clearWeight?: boolean;
    clearPrice?: boolean;
  },
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_update_product_supply_item", {
    p_item_id: itemId,
    p_quantity: input.quantity ?? null,
    p_unit_net_weight_kg: input.unitNetWeightKg ?? null,
    p_purchase_price_per_unit: input.purchasePricePerUnit ?? null,
    p_purchase_currency: input.purchaseCurrency ?? null,
    p_exchange_rate_to_kzt: input.exchangeRateToKzt ?? null,
    p_clear_weight: input.clearWeight ?? false,
    p_clear_price: input.clearPrice ?? false,
  });
  if (error) throwRpc(error, "Не удалось сохранить позицию");
  return mapPayload(data);
}

export async function deleteProductSupplyItem(itemId: string): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_delete_product_supply_item", {
    p_item_id: itemId,
  });
  if (error) throwRpc(error, "Не удалось удалить позицию");
  return mapPayload(data);
}

export async function addProductSupplyExpense(input: {
  supplyId: string;
  name: string;
  amount: number;
  currency?: ProductSupplyCurrency;
  exchangeRateToKzt?: number | null;
  categoryKey?: string;
  expenseDate?: string | null;
  notes?: string | null;
}): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_add_product_supply_expense", {
    p_supply_id: input.supplyId,
    p_name: input.name,
    p_amount: input.amount,
    p_currency: input.currency ?? "KZT",
    p_exchange_rate_to_kzt: input.exchangeRateToKzt ?? null,
    p_category_key: input.categoryKey ?? "custom",
    p_expense_date: input.expenseDate || null,
    p_notes: input.notes?.trim() || null,
  });
  if (error) throwRpc(error, "Не удалось добавить расход");
  return mapPayload(data);
}

export async function deleteProductSupplyExpense(
  expenseId: string,
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_delete_product_supply_expense", {
    p_expense_id: expenseId,
  });
  if (error) throwRpc(error, "Не удалось удалить расход");
  return mapPayload(data);
}

export async function closeProductSupply(supplyId: string): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_close_product_supply", {
    p_supply_id: supplyId,
  });
  if (error) throwRpc(error, "Не удалось закрыть поставку");
  return mapPayload(data);
}

export async function listProductLandedCosts(
  productId: string,
): Promise<ProductLandedCostHistoryItem[]> {
  const { data, error } = await supabase.rpc("staff_list_product_landed_costs", {
    p_product_id: productId,
  });
  if (error) throwRpc(error, "Не удалось загрузить историю себестоимости");
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    supply_id: asString(row.supply_id),
    supply_number: asString(row.supply_number),
    sequence_number: asNumber(row.sequence_number, 0),
    title: asString(row.title),
    supply_date: asString(row.supply_date),
    status: asString(row.status, "draft") as ProductSupplyStatus,
    quantity: asNumber(row.quantity, 0),
    unit: asString(row.unit, "шт."),
    landed_cost_per_unit_kzt: asNullableNumber(row.landed_cost_per_unit_kzt),
    is_preliminary: Boolean(row.is_preliminary),
    closed_at: asNullableString(row.closed_at),
  }));
}

const kztFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const kgFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

const kgPreciseFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const rateFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatSupplyMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${kztFormatter.format(value)} ₸`;
}

export function formatSupplyKg(value: number | null | undefined, precise = false): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(precise ? kgPreciseFormatter : kgFormatter).format(value)} кг`;
}

export function formatSupplyRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return rateFormatter.format(value);
}

export function formatSupplyPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} %`;
}

export function parseSupplyNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
