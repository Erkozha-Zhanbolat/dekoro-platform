import type { Product } from "@/types/product";
import { useSupabaseCatalog } from "@/lib/featureFlags";

// localStorage key for favorites while the catalog is static (see
// FavoritesContext.tsx). Kept separate from any future Supabase-backed
// favorites so a later migration to the Supabase catalog can read this key
// once to migrate a browser's local favorites, without any risk of mixing
// the two id spaces (SKU vs. products.id UUID) together.
export const STATIC_FAVORITES_STORAGE_KEY = "dekoro_static_favorites";

/**
 * Stable identifier used to track a product in favorites, regardless of
 * which catalog source is active:
 * - Supabase catalog: product.id is the real products.id UUID from the DB
 *   (see CatalogContext), so favorites.product_id can reference it directly.
 * - Static catalog: product.id is just a local slug (src/data/products.ts),
 *   not a database key, so the SKU is used instead — it's stable, unique
 *   per product, and never an array index or display name.
 */
export function getFavoriteProductId(product: Product): string {
  return useSupabaseCatalog ? product.id : product.sku;
}

export function readLocalFavorites(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STATIC_FAVORITES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeLocalFavorites(ids: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STATIC_FAVORITES_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage errors (private browsing, quota exceeded, etc.) —
    // favorites simply won't persist across reloads in that case.
  }
}
