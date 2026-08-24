import { supabase } from "@/lib/supabase/client";
import { PRODUCT_CATEGORIES } from "@/types/product";
import type { Product, ProductCategory } from "@/types/product";

/** Fixed bucket from migrations 019/020 — never accept arbitrary bucket names. */
const PRODUCT_IMAGES_BUCKET = "product-images";

/**
 * Row shape returned by public.get_catalog()
 * (002 + 020_product_inventory_and_catalog_images.sql).
 *
 * `image` is either:
 * - Storage path `products/{uuid}/main.{ext}` from products.main_photo_path, or
 * - legacy absolute URL from product_images.image_url.
 * `updated_at` is used for cache-busting when the Storage path is overwritten.
 */
export type CatalogProduct = {
  product_id: string;
  name: string;
  sku: string;
  original_sku: string | null;
  category: string | null;
  dimensions: string | null;
  unit: string;
  available_stock: number;
  sale_price: number | null;
  /** products.base_price, added by 041_order_pricing_engine.sql — public retail price. */
  list_price: number | null;
  image: string | null;
  is_promotion: boolean;
  updated_at: string;
};

const KNOWN_CATEGORIES: readonly string[] = PRODUCT_CATEGORIES;

/** Relative path only — never a full URL or foreign bucket prefix. */
const PRODUCT_PHOTO_PATH_RE =
  /^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/main\.(png|jpe?g|webp)$/i;

function cacheBustToken(cacheBust?: string | number | null): string | null {
  if (cacheBust === null || cacheBust === undefined) return null;
  const raw = String(cacheBust).trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return String(ms);
  return encodeURIComponent(raw);
}

/**
 * Resolve catalog image to a browser-usable URL without a Storage round-trip.
 *
 * - http(s)://… → return as-is (legacy product_images.image_url)
 * - products/{uuid}/main.ext → public URL for bucket product-images only
 * - null / empty / invalid → null (UI shows placeholder)
 * - never wraps an already-absolute URL again
 * - never accepts arbitrary bucket names
 */
export function resolveCatalogImageUrl(
  image: string | null | undefined,
  cacheBust?: string | number | null,
): string | null {
  if (image == null) return null;
  const trimmed = image.trim();
  if (!trimmed) return null;

  // Legacy absolute URL — do not pass through getPublicUrl (would double-wrap).
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  // Reject mistaken prefixes (bucket name, storage API paths, etc.).
  if (
    trimmed.startsWith("product-images/")
    || trimmed.startsWith("/storage/")
    || trimmed.includes("://")
  ) {
    return null;
  }

  if (!PRODUCT_PHOTO_PATH_RE.test(trimmed)) {
    return null;
  }

  const { data } = supabase.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .getPublicUrl(trimmed);

  const publicUrl = data?.publicUrl;
  if (!publicUrl || !/^https?:\/\//i.test(publicUrl)) {
    return null;
  }

  const token = cacheBustToken(cacheBust);
  if (!token) {
    return publicUrl;
  }

  const sep = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${sep}v=${token}`;
}

/**
 * Storefront grouping key: known PRODUCT_CATEGORIES first (seed/UI order),
 * then any other category name, then uncategorized last. Stable — does not
 * re-order items inside the same category (preserves RPC subcategory / name
 * order when get_catalog is sorted that way).
 */
function compareStorefrontCategory(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const rank = (category: string | null | undefined): number => {
    if (!category) return KNOWN_CATEGORIES.length + 1;
    const known = KNOWN_CATEGORIES.indexOf(category);
    return known === -1 ? KNOWN_CATEGORIES.length : known;
  };

  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  return (a ?? "").localeCompare(b ?? "", "ru");
}

/** Groups catalog rows by category without shuffling items inside a group. */
export function sortCatalogByCategory<T extends { category: string | null }>(
  entries: T[],
): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const byCategory = compareStorefrontCategory(left.entry.category, right.entry.category);
      return byCategory !== 0 ? byCategory : left.index - right.index;
    })
    .map(({ entry }) => entry);
}

/**
 * Fetches the storefront catalog via Supabase RPC.
 * No UI — data access only.
 */
export async function getCatalog(): Promise<CatalogProduct[]> {
  const { data, error } = await supabase.rpc("get_catalog");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить каталог");
  }

  return sortCatalogByCategory((data as CatalogProduct[] | null) ?? []);
}

/** Default page size for storefront infinite scroll (24–40 range). */
export const CATALOG_PAGE_SIZE = 32;

export type CatalogPageRow = CatalogProduct & {
  total_count: number;
};

export type CatalogPageResult = {
  products: CatalogProduct[];
  totalCount: number;
  /** Next OFFSET for LIMIT/OFFSET pagination (currentOffset + page length). */
  nextOffset: number;
  hasMore: boolean;
};

/**
 * One page of the storefront catalog (migration 046).
 * Sort matches Stage 45; search/category are applied server-side before LIMIT/OFFSET.
 */
export async function getCatalogPage(options: {
  limit?: number;
  search?: string | null;
  category?: string | null;
  offset?: number;
}): Promise<CatalogPageResult> {
  const limit = Math.min(
    Math.max(options.limit ?? CATALOG_PAGE_SIZE, 1),
    100,
  );
  const offset = Math.max(options.offset ?? 0, 0);

  const { data, error } = await supabase.rpc("get_catalog_page", {
    p_limit: limit,
    p_search: options.search?.trim() || null,
    p_category: options.category?.trim() || null,
    p_offset: offset,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить каталог");
  }

  const rows = (data as CatalogPageRow[] | null) ?? [];
  const products: CatalogProduct[] = rows.map((row) => {
    const { total_count: _ignored, ...product } = row;
    void _ignored;
    return product;
  });
  const totalCount = rows.length > 0 ? Number(rows[0].total_count) || 0 : 0;
  const nextOffset = offset + products.length;

  return {
    products,
    totalCount,
    nextOffset,
    // More rows exist when this page was full and we have not reached total_count.
    hasMore:
      products.length > 0
      && nextOffset < totalCount,
  };
}

/** Active top-level category names for storefront filter chips (046). */
export async function getCatalogCategories(): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_catalog_categories");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить категории");
  }

  const rows = (data as { category: string }[] | null) ?? [];
  return rows
    .map((row) => row.category)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Maps an RPC catalog row into the Product shape used by existing UI
 * (cards, cart, quantity/stock helpers).
 */
export function mapCatalogProductToProduct(entry: CatalogProduct): Product {
  const categoryName = entry.category ?? "";

  return {
    id: entry.product_id,
    name: entry.name,
    sku: entry.sku,
    originalSku: entry.original_sku ?? entry.sku,
    category: KNOWN_CATEGORIES.includes(categoryName)
      ? (categoryName as ProductCategory)
      : categoryName.length > 0
        ? (categoryName as ProductCategory)
        : PRODUCT_CATEGORIES[0],
    dimensions: entry.dimensions,
    unit: entry.unit,
    stock: Number(entry.available_stock) || 0,
    reserved: 0,
    salePrice: entry.sale_price === null || entry.sale_price === undefined
      ? null
      : Number(entry.sale_price),
    listPrice: entry.list_price === null || entry.list_price === undefined
      ? null
      : Number(entry.list_price),
    image: resolveCatalogImageUrl(entry.image, entry.updated_at),
    isPromotion: Boolean(entry.is_promotion),
  };
}

/** Unique category names in catalog display order (no extra network request). */
export function deriveCategoryNames(products: Product[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const product of products) {
    if (product.category && !seen.has(product.category)) {
      seen.add(product.category);
      names.push(product.category);
    }
  }
  return names;
}
