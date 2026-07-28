import { supabase } from "@/lib/supabase/client";
import { PRODUCT_CATEGORIES } from "@/types/product";
import type { Product, ProductCategory } from "@/types/product";

/**
 * Row shape returned by public.get_catalog().
 * Mirrors supabase/migrations/002_catalog_inventory_pricing.sql.
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
  image: string | null;
  is_promotion: boolean;
};

const KNOWN_CATEGORIES: readonly string[] = PRODUCT_CATEGORIES;

/**
 * Fetches the storefront catalog via Supabase RPC.
 * No UI — data access only.
 */
export async function getCatalog(): Promise<CatalogProduct[]> {
  const { data, error } = await supabase.rpc("get_catalog");

  if (error) {
    throw new Error(error.message || "Не удалось загрузить каталог");
  }

  return (data as CatalogProduct[] | null) ?? [];
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
    image: entry.image,
    isPromotion: Boolean(entry.is_promotion),
  };
}

/** Unique category names from loaded products (no extra network request). */
export function deriveCategoryNames(products: Product[]): string[] {
  const names = new Set<string>();
  for (const product of products) {
    if (product.category) {
      names.add(product.category);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, "ru"));
}
