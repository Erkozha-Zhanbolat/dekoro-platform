import { supabase } from "@/lib/supabase/client";
import { parseFactoryCatalogRefs } from "@/lib/staff/factoryCatalogParse";
import type {
  ProductLandedCostHistoryItem,
  ProductSupplyComparisonRow,
  ProductSupplyCurrency,
  ProductSupplyDiscrepancyType,
  ProductSupplyDocument,
  ProductSupplyExpense,
  ProductSupplyFxRate,
  ProductSupplyHeader,
  ProductSupplyItem,
  ProductSupplyLinkedDocument,
  ProductSupplyListItem,
  ProductSupplyLogisticsStatus,
  ProductSupplyPayload,
  ProductSupplyProductSearch,
  ProductSupplyQtySource,
  ProductSupplyReceiving,
  ProductSupplyReceivingItem,
  ProductSupplyReceivingStatus,
  ProductSupplyStatus,
  ProductSupplyStatusHistoryItem,
  ProductSupplyTotals,
  ProductStatus,
} from "@/types/database";

export type {
  ProductLandedCostHistoryItem,
  ProductSupplyComparisonRow,
  ProductSupplyCurrency,
  ProductSupplyDiscrepancyType,
  ProductSupplyDocument,
  ProductSupplyExpense,
  ProductSupplyFxRate,
  ProductSupplyHeader,
  ProductSupplyItem,
  ProductSupplyListItem,
  ProductSupplyLogisticsStatus,
  ProductSupplyPayload,
  ProductSupplyProductSearch,
  ProductSupplyReceiving,
  ProductSupplyReceivingItem,
  ProductSupplyReceivingStatus,
  ProductSupplyStatus,
  ProductSupplyStatusHistoryItem,
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
    logistics_status: asString(row.logistics_status, "draft") as ProductSupplyLogisticsStatus,
    gross_weight_kg: asNullableNumber(row.gross_weight_kg),
    total_expenses_kzt: asNullableNumber(row.total_expenses_kzt),
    expense_per_kg: asNullableNumber(row.expense_per_kg),
    total_landed_cost_kzt: asNullableNumber(row.total_landed_cost_kzt),
    items_count: asNumber(row.items_count, 0),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at, asString(row.created_at)),
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
    logistics_status: asString(row.logistics_status, "draft") as ProductSupplyLogisticsStatus,
    receiving_status: asString(
      row.receiving_status,
      "not_started",
    ) as ProductSupplyReceivingStatus,
    active_receiving_id: asNullableString(row.active_receiving_id),
    source_kind: row.source_kind === "import" ? "import" : "manual",
    created_by: asString(row.created_by),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    closed_at: asNullableString(row.closed_at),
    closed_by: asNullableString(row.closed_by),
    is_preliminary: Boolean(row.is_preliminary),
    inventory_receipt_id: asNullableString(row.inventory_receipt_id),
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
    received_quantity: asNullableNumber(row.received_quantity),
    damaged_quantity: asNullableNumber(row.damaged_quantity),
    accepted_quantity: asNullableNumber(row.accepted_quantity),
    qty_source: asString(row.qty_source, "manual") as ProductSupplyQtySource,
    ordered_quantity: asNullableNumber(row.ordered_quantity),
    ordered_unit: asNullableString(row.ordered_unit),
    ordered_purchase_currency: asNullableString(row.ordered_purchase_currency) as ProductSupplyCurrency | null,
    ordered_price_per_unit: asNullableNumber(row.ordered_price_per_unit),
    ordered_amount: asNullableNumber(row.ordered_amount),
    ordered_spec: asNullableString(row.ordered_spec),
    ordered_name: asNullableString(row.ordered_name),
    ordered_source_document_id: asNullableString(row.ordered_source_document_id),
    shipped_quantity: asNullableNumber(row.shipped_quantity),
    shipped_unit: asNullableString(row.shipped_unit),
    shipped_purchase_currency: asNullableString(row.shipped_purchase_currency) as ProductSupplyCurrency | null,
    shipped_price_per_unit: asNullableNumber(row.shipped_price_per_unit),
    shipped_amount: asNullableNumber(row.shipped_amount),
    shipped_spec: asNullableString(row.shipped_spec),
    shipped_name: asNullableString(row.shipped_name),
    shipped_source_document_id: asNullableString(row.shipped_source_document_id),
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
    use_custom_exchange_rate: Boolean(row.use_custom_exchange_rate),
    amount_kzt: asNullableNumber(row.amount_kzt),
    expense_date: asNullableString(row.expense_date),
    notes: asNullableString(row.notes),
    sort_order: asNumber(row.sort_order, 0),
    linked_documents: ((row.linked_documents as Record<string, unknown>[] | null) ?? []).map(
      (doc) => ({
        id: asString(doc.id),
        title: asString(doc.title),
        document_type: asString(doc.document_type) as ProductSupplyLinkedDocument["document_type"],
        original_filename: asString(doc.original_filename),
      }),
    ),
  };
}

function mapFxRate(row: Record<string, unknown>): ProductSupplyFxRate {
  return {
    currency: asString(row.currency, "CNY") as ProductSupplyCurrency,
    rate_to_kzt: asNumber(row.rate_to_kzt, 0),
    effective_date: asNullableString(row.effective_date),
    source_note: asNullableString(row.source_note),
    updated_at: asString(row.updated_at),
    updated_by: asNullableString(row.updated_by),
  };
}

function mapReceivingItem(row: Record<string, unknown>): ProductSupplyReceivingItem {
  return {
    id: asString(row.id),
    receiving_id: asString(row.receiving_id),
    supply_item_id: asNullableString(row.supply_item_id),
    product_id: asString(row.product_id),
    sort_order: asNumber(row.sort_order, 0),
    sku: asNullableString(row.sku),
    name: asNullableString(row.name),
    spec: asNullableString(row.spec),
    ordered_quantity: asNullableNumber(row.ordered_quantity),
    shipped_quantity: asNullableNumber(row.shipped_quantity),
    expected_quantity: asNumber(row.expected_quantity, 0),
    received_quantity: asNullableNumber(row.received_quantity),
    damaged_quantity: asNumber(row.damaged_quantity, 0),
    accepted_quantity: asNullableNumber(row.accepted_quantity),
    difference_quantity: asNullableNumber(row.difference_quantity),
    discrepancy_type: asNullableString(row.discrepancy_type) as ProductSupplyDiscrepancyType | null,
    comment: asNullableString(row.comment),
    is_unexpected: Boolean(row.is_unexpected),
    line_status: row.line_status === "filled" ? "filled" : "pending",
    stock_receipt_id: asNullableString(row.stock_receipt_id),
  };
}

function mapReceiving(row: Record<string, unknown> | null): ProductSupplyReceiving | null {
  if (!row || typeof row !== "object") return null;
  const summary = (row.summary ?? {}) as Record<string, unknown>;
  return {
    id: asString(row.id),
    supply_id: asString(row.supply_id),
    status: row.status === "confirmed" ? "confirmed" : "draft",
    warehouse_id: asNullableString(row.warehouse_id),
    started_by: asString(row.started_by),
    started_at: asString(row.started_at),
    confirmed_by: asNullableString(row.confirmed_by),
    confirmed_at: asNullableString(row.confirmed_at),
    stock_receipt_batch_id: asNullableString(row.stock_receipt_batch_id),
    notes: asNullableString(row.notes),
    created_at: asString(row.created_at),
    updated_at: asString(row.updated_at),
    items: ((row.items as Record<string, unknown>[] | null) ?? []).map(mapReceivingItem),
    summary: {
      expected_sum: asNumber(summary.expected_sum, 0),
      received_sum: asNumber(summary.received_sum, 0),
      accepted_sum: asNumber(summary.accepted_sum, 0),
      damaged_sum: asNumber(summary.damaged_sum, 0),
      shortage_sum: asNumber(summary.shortage_sum, 0),
      overage_sum: asNumber(summary.overage_sum, 0),
    },
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

function mapDocument(row: Record<string, unknown>): ProductSupplyDocument {
  return {
    id: asString(row.id),
    supply_id: asString(row.supply_id),
    document_type: asString(row.document_type, "other") as ProductSupplyDocument["document_type"],
    title: asString(row.title),
    original_filename: asString(row.original_filename),
    storage_path: asString(row.storage_path),
    mime_type: asNullableString(row.mime_type),
    file_size: asNullableNumber(row.file_size),
    content_sha256: asNullableString(row.content_sha256),
    uploaded_by: asString(row.uploaded_by),
    uploaded_by_name: asNullableString(row.uploaded_by_name),
    uploaded_at: asString(row.uploaded_at),
    document_date: asNullableString(row.document_date),
    notes: asNullableString(row.notes),
    source_kind: row.source_kind === "import" ? "import" : "upload",
    linked_expense_id: asNullableString(row.linked_expense_id),
    linked_expense_name: asNullableString(row.linked_expense_name),
    parser_status: asNullableString(row.parser_status) as ProductSupplyDocument["parser_status"],
    imported_at: asNullableString(row.imported_at),
    imported_by: asNullableString(row.imported_by),
    already_imported: Boolean(row.already_imported),
    parsed_row_count: asNumber(row.parsed_row_count, 0),
  };
}

function mapHistory(row: Record<string, unknown>): ProductSupplyStatusHistoryItem {
  return {
    id: asString(row.id),
    supply_id: asString(row.supply_id),
    from_status: asNullableString(row.from_status) as ProductSupplyLogisticsStatus | null,
    to_status: asString(row.to_status, "draft") as ProductSupplyLogisticsStatus,
    changed_by: asString(row.changed_by),
    changed_by_name: asNullableString(row.changed_by_name),
    changed_at: asString(row.changed_at),
    note: asNullableString(row.note),
    location: asNullableString(row.location),
  };
}

function mapComparison(row: Record<string, unknown>): ProductSupplyComparisonRow {
  const flags = Array.isArray(row.flags)
    ? (row.flags as unknown[]).map((flag) => String(flag))
    : [];
  return {
    item_id: asString(row.item_id),
    product_id: asString(row.product_id),
    sku: asString(row.sku),
    name: asString(row.name),
    unit: asString(row.unit, "шт."),
    ordered_quantity: asNullableNumber(row.ordered_quantity),
    shipped_quantity: asNullableNumber(row.shipped_quantity),
    quantity_diff: asNullableNumber(row.quantity_diff),
    ordered_price_per_unit: asNullableNumber(row.ordered_price_per_unit),
    shipped_price_per_unit: asNullableNumber(row.shipped_price_per_unit),
    price_diff: asNullableNumber(row.price_diff),
    ordered_source_document_id: asNullableString(row.ordered_source_document_id),
    shipped_source_document_id: asNullableString(row.shipped_source_document_id),
    qty_source: asString(row.qty_source, "manual") as ProductSupplyQtySource,
    status: asString(row.status, "manual") as ProductSupplyComparisonRow["status"],
    flags,
  };
}

export function mapProductSupplyPayload(data: unknown): ProductSupplyPayload {
  const row = (data ?? {}) as Record<string, unknown>;
  const supply = (row.supply ?? {}) as Record<string, unknown>;
  const items = (row.items as Record<string, unknown>[] | null) ?? [];
  const expenses = (row.expenses as Record<string, unknown>[] | null) ?? [];
  const documents = (row.documents as Record<string, unknown>[] | null) ?? [];
  const history = (row.logistics_history as Record<string, unknown>[] | null) ?? [];
  const comparison = (row.comparison as Record<string, unknown>[] | null) ?? [];
  const fxRates = (row.fx_rates as Record<string, unknown>[] | null) ?? [];
  const totals = (row.totals ?? {}) as Record<string, unknown>;
  const fxApply = row.fx_apply as Record<string, unknown> | null | undefined;
  return {
    supply: mapHeader(supply),
    items: items.map(mapItem),
    expenses: expenses.map(mapExpense),
    fx_rates: fxRates.map(mapFxRate),
    receiving: mapReceiving(
      row.receiving && typeof row.receiving === "object"
        ? (row.receiving as Record<string, unknown>)
        : null,
    ),
    documents: documents.map(mapDocument),
    logistics_history: history.map(mapHistory),
    comparison: comparison.map(mapComparison),
    totals: mapTotals(totals),
    fx_apply: fxApply
      ? {
          items: asNumber(fxApply.items, 0),
          expenses: asNumber(fxApply.expenses, 0),
        }
      : null,
  };
}

function mapPayload(data: unknown): ProductSupplyPayload {
  return mapProductSupplyPayload(data);
}

function throwRpc(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

export async function listProductSupplies(params: {
  status?: ProductSupplyStatus | "";
  logisticsStatus?: ProductSupplyLogisticsStatus | "";
  dateFrom?: string | null;
  dateTo?: string | null;
  query?: string | null;
  limit?: number;
} = {}): Promise<ProductSupplyListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_product_supplies", {
    p_status: params.status || null,
    p_limit: params.limit ?? 50,
    p_logistics_status: params.logisticsStatus || null,
    p_date_from: params.dateFrom || null,
    p_date_to: params.dateTo || null,
    p_query: params.query?.trim() || null,
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
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapProductSearch);
}

function mapProductSearch(row: Record<string, unknown>): ProductSupplyProductSearch {
  return {
    id: asString(row.id),
    sku: asString(row.sku),
    name: asString(row.name),
    original_sku: asNullableString(row.original_sku),
    unit: asString(row.unit, "шт."),
    status: asString(row.status, "draft") as ProductStatus,
    weight_kg: asNullableNumber(row.weight_kg),
    dimensions: asNullableString(row.dimensions),
    category_id: asNullableString(row.category_id),
    category_name: asNullableString(row.category_name),
    subcategory_id: asNullableString(row.subcategory_id),
    subcategory_name: asNullableString(row.subcategory_name),
    factory_catalogs: parseFactoryCatalogRefs(row.factory_catalogs),
  };
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
  return mapProductSearch((data ?? {}) as Record<string, unknown>);
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
  useCustomExchangeRate?: boolean;
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
    p_use_custom_exchange_rate: input.useCustomExchangeRate ?? false,
  });
  if (error) throwRpc(error, "Не удалось добавить расход");
  return mapPayload(data);
}

export async function setProductSupplyFxRates(
  supplyId: string,
  rates: Array<{
    currency: "CNY" | "USD";
    rateToKzt: number;
    effectiveDate?: string | null;
    sourceNote?: string | null;
  }>,
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_set_product_supply_fx_rates", {
    p_supply_id: supplyId,
    p_rates: rates.map((rate) => ({
      currency: rate.currency,
      rate_to_kzt: rate.rateToKzt,
      effective_date: rate.effectiveDate || null,
      source_note: rate.sourceNote?.trim() || null,
    })),
  });
  if (error) throwRpc(error, "Не удалось сохранить курсы валют");
  return mapPayload(data);
}

export async function startProductSupplyReceiving(
  supplyId: string,
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_start_product_supply_receiving", {
    p_supply_id: supplyId,
  });
  if (error) throwRpc(error, "Не удалось начать приёмку");
  return mapPayload(data);
}

export async function fillProductSupplyReceivingExpected(
  supplyId: string,
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_fill_product_supply_receiving_expected", {
    p_supply_id: supplyId,
  });
  if (error) throwRpc(error, "Не удалось заполнить приёмку по накладной");
  return mapPayload(data);
}

export async function saveProductSupplyReceiving(
  supplyId: string,
  items: Array<{
    id: string;
    receivedQuantity: number | null;
    damagedQuantity?: number;
    discrepancyType?: ProductSupplyDiscrepancyType | null;
    comment?: string | null;
  }>,
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_save_product_supply_receiving", {
    p_supply_id: supplyId,
    p_items: items.map((item) => ({
      id: item.id,
      received_quantity: item.receivedQuantity,
      damaged_quantity: item.damagedQuantity ?? 0,
      discrepancy_type: item.discrepancyType ?? null,
      comment: item.comment?.trim() || null,
    })),
  });
  if (error) throwRpc(error, "Не удалось сохранить приёмку");
  return mapPayload(data);
}

export async function addUnexpectedProductSupplyReceivingItem(input: {
  supplyId: string;
  productId: string;
  receivedQuantity: number;
  damagedQuantity?: number;
  comment?: string | null;
}): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc(
    "staff_add_unexpected_product_supply_receiving_item",
    {
      p_supply_id: input.supplyId,
      p_product_id: input.productId,
      p_received_quantity: input.receivedQuantity,
      p_damaged_quantity: input.damagedQuantity ?? 0,
      p_comment: input.comment?.trim() || null,
    },
  );
  if (error) throwRpc(error, "Не удалось добавить неожиданный товар");
  return mapPayload(data);
}

export async function confirmProductSupplyReceiving(
  supplyId: string,
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_confirm_product_supply_receiving", {
    p_supply_id: supplyId,
  });
  if (error) throwRpc(error, "Не удалось подтвердить приёмку");
  return mapPayload(data);
}

export function getSupplyFxRate(
  fxRates: ProductSupplyFxRate[],
  currency: ProductSupplyCurrency,
  fallbackDefault: { currency: ProductSupplyCurrency; rate: number | null } | null = null,
): number | null {
  if (currency === "KZT") return 1;
  const found = fxRates.find((row) => row.currency === currency);
  if (found) return found.rate_to_kzt;
  if (fallbackDefault && fallbackDefault.currency === currency) {
    return fallbackDefault.rate;
  }
  return null;
}

export {
  supplyAcceptedQuantity,
  supplyAmountKzt,
  supplyReceivingDifference,
} from "./supplyMath";

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

export async function setProductSupplyLogisticsStatus(input: {
  supplyId: string;
  toStatus: ProductSupplyLogisticsStatus;
  note?: string | null;
  location?: string | null;
}): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_set_product_supply_logistics_status", {
    p_supply_id: input.supplyId,
    p_to_status: input.toStatus,
    p_note: input.note?.trim() || null,
    p_location: input.location?.trim() || null,
  });
  if (error) throwRpc(error, "Не удалось обновить логистический статус");
  return mapPayload(data);
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
