import { supabase } from "@/lib/supabase/client";
import type {
  StaffCategoryListItem,
  StaffProductCopyResult,
  StaffProductDetails,
  StaffProductListItem,
  StaffProductStatus,
} from "@/types/database";

export type {
  StaffCategoryListItem,
  StaffProductCopyResult,
  StaffProductDetails,
  StaffProductListItem,
};

export type StaffProductWriteInput = {
  sku: string;
  name: string;
  category_id: string | null;
  subcategory_id?: string | null;
  status: StaffProductStatus;
  base_price?: number | null;
  min_order_qty: number;
  unit: string;
  length_mm?: number | null;
  width_mm?: number | null;
  thickness_mm?: number | null;
  weight_kg?: number | null;
};

export type StaffListProductsParams = {
  query?: string;
  categoryId?: string | null;
  status?: StaffProductStatus | "" | null;
  limit?: number;
};

const DEFAULT_LIST_LIMIT = 100;

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = asNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function mapListItem(row: StaffProductListItem): StaffProductListItem {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category_id: row.category_id,
    category_name: row.category_name,
    subcategory_id: row.subcategory_id,
    subcategory_name: row.subcategory_name,
    unit: row.unit,
    base_price: asNullableNumber(row.base_price),
    min_order_qty: asNumber(row.min_order_qty, 1),
    status: row.status,
    main_photo_path: row.main_photo_path,
    available_quantity: asNumber(row.available_quantity, 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapDetails(row: StaffProductDetails): StaffProductDetails {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    slug: row.slug,
    category_id: row.category_id,
    category_name: row.category_name,
    subcategory_id: row.subcategory_id,
    subcategory_name: row.subcategory_name,
    status: row.status,
    unit: row.unit,
    base_price: asNullableNumber(row.base_price),
    min_order_qty: asNumber(row.min_order_qty, 1),
    length_mm: asNullableNumber(row.length_mm),
    width_mm: asNullableNumber(row.width_mm),
    thickness_mm: asNullableNumber(row.thickness_mm),
    weight_kg: asNullableNumber(row.weight_kg),
    dimensions: row.dimensions,
    main_photo_path: row.main_photo_path,
    available_quantity: asNumber(row.available_quantity, 0),
    physical_quantity: asNumber(row.physical_quantity, 0),
    reserved_quantity: asNumber(row.reserved_quantity, 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapCategory(row: StaffCategoryListItem): StaffCategoryListItem {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parent_id: row.parent_id,
    sort_order: asNumber(row.sort_order, 0),
    is_active: !!row.is_active,
    products_count: asNumber(row.products_count, 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listStaffProducts(
  params: StaffListProductsParams = {},
): Promise<StaffProductListItem[]> {
  const query = params.query?.trim() ?? "";
  const { data, error } = await supabase.rpc("staff_list_products", {
    p_query: query.length > 0 ? query : null,
    p_category_id: params.categoryId || null,
    p_status: params.status || null,
    p_limit: params.limit ?? DEFAULT_LIST_LIMIT,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить товары");
  }

  return ((data as StaffProductListItem[] | null) ?? []).map(mapListItem);
}

export async function getStaffProduct(productId: string): Promise<StaffProductDetails> {
  const { data, error } = await supabase.rpc("staff_get_product", {
    p_product_id: productId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить товар");
  }

  return mapDetails(data as StaffProductDetails);
}

export async function createStaffProduct(
  input: StaffProductWriteInput,
): Promise<StaffProductDetails> {
  const { data, error } = await supabase.rpc("staff_create_product", {
    p_sku: input.sku,
    p_name: input.name,
    p_category_id: input.category_id || null,
    p_subcategory_id: input.subcategory_id || null,
    p_status: input.status,
    p_base_price: input.base_price ?? null,
    p_min_order_qty: input.min_order_qty,
    p_unit: input.unit,
    p_length_mm: input.length_mm ?? null,
    p_width_mm: input.width_mm ?? null,
    p_thickness_mm: input.thickness_mm ?? null,
    p_weight_kg: input.weight_kg ?? null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось создать товар");
  }

  return mapDetails(data as StaffProductDetails);
}

export async function updateStaffProduct(
  productId: string,
  input: StaffProductWriteInput,
): Promise<StaffProductDetails> {
  const { data, error } = await supabase.rpc("staff_update_product", {
    p_product_id: productId,
    p_sku: input.sku,
    p_name: input.name,
    p_category_id: input.category_id || null,
    p_subcategory_id: input.subcategory_id || null,
    p_status: input.status,
    p_base_price: input.base_price ?? null,
    p_min_order_qty: input.min_order_qty,
    p_unit: input.unit,
    p_length_mm: input.length_mm ?? null,
    p_width_mm: input.width_mm ?? null,
    p_thickness_mm: input.thickness_mm ?? null,
    p_weight_kg: input.weight_kg ?? null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось сохранить товар");
  }

  return mapDetails(data as StaffProductDetails);
}

export async function copyStaffProduct(input: {
  sourceId: string;
  sku: string;
  name: string;
}): Promise<StaffProductCopyResult> {
  const { data, error } = await supabase.rpc("staff_copy_product", {
    p_source_id: input.sourceId,
    p_sku: input.sku,
    p_name: input.name,
  });

  if (error) {
    throw new Error(error.message || "Не удалось скопировать товар");
  }

  const row = data as StaffProductCopyResult;
  return {
    ...mapDetails(row),
    source_product_id: row.source_product_id,
    source_main_photo_path: row.source_main_photo_path ?? null,
  };
}

export async function setStaffProductMainPhoto(
  productId: string,
  path: string | null,
): Promise<StaffProductDetails> {
  const { data, error } = await supabase.rpc("staff_set_product_main_photo", {
    p_product_id: productId,
    p_path: path,
  });

  if (error) {
    throw new Error(error.message || "Не удалось обновить фото товара");
  }

  return mapDetails(data as StaffProductDetails);
}

export async function listStaffCategories(
  includeArchived = false,
): Promise<StaffCategoryListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_categories", {
    p_include_archived: includeArchived,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить категории");
  }

  return ((data as StaffCategoryListItem[] | null) ?? []).map(mapCategory);
}

export async function createStaffCategory(input: {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
}): Promise<StaffCategoryListItem> {
  const { data, error } = await supabase.rpc("staff_create_category", {
    p_name: input.name,
    p_parent_id: input.parentId || null,
    p_sort_order: input.sortOrder ?? 0,
  });

  if (error) {
    throw new Error(error.message || "Не удалось создать категорию");
  }

  const row = data as StaffCategoryListItem & { products_count?: number };
  return mapCategory({
    ...row,
    products_count: row.products_count ?? 0,
  });
}

export async function updateStaffCategory(input: {
  id: string;
  name: string;
  sortOrder?: number | null;
  parentId?: string | null;
  clearParent?: boolean;
}): Promise<StaffCategoryListItem> {
  const { data, error } = await supabase.rpc("staff_update_category", {
    p_id: input.id,
    p_name: input.name,
    p_sort_order: input.sortOrder ?? null,
    p_parent_id: input.parentId ?? null,
    p_clear_parent: input.clearParent ?? false,
  });

  if (error) {
    throw new Error(error.message || "Не удалось сохранить категорию");
  }

  const row = data as StaffCategoryListItem & { products_count?: number };
  return mapCategory({
    ...row,
    products_count: row.products_count ?? 0,
  });
}

export async function archiveStaffCategory(id: string): Promise<StaffCategoryListItem> {
  const { data, error } = await supabase.rpc("staff_archive_category", {
    p_id: id,
  });

  if (error) {
    throw new Error(error.message || "Не удалось архивировать категорию");
  }

  const row = data as StaffCategoryListItem & { products_count?: number };
  return mapCategory({
    ...row,
    products_count: row.products_count ?? 0,
  });
}
