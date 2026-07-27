"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { PRODUCT_CATEGORIES } from "@/types/product";
import type { Product as StaticProduct, ProductCategory } from "@/types/product";
import type { CatalogEntry, Category } from "@/types/database";

// Feature flag: while false, nothing in this context ever talks to
// Supabase — the static catalog (src/data/products.ts) keeps driving
// /catalog, /product/[id] and the cart, unchanged.
export const IS_SUPABASE_CATALOG_ENABLED =
  process.env.NEXT_PUBLIC_USE_SUPABASE_CATALOG === "true";

interface CatalogContextValue {
  categories: Category[];
  products: StaticProduct[];
  loading: boolean;
  error: string | null;
  refreshCatalog: () => Promise<void>;
}

interface CatalogData {
  categories: Category[];
  products: StaticProduct[];
}

const KNOWN_CATEGORIES: readonly string[] = PRODUCT_CATEGORIES;

function mapCatalogEntryToProduct(entry: CatalogEntry): StaticProduct {
  return {
    id: entry.product_id,
    name: entry.name,
    sku: entry.sku,
    originalSku: entry.original_sku ?? entry.sku,
    // Demo/seed category names are expected to match PRODUCT_CATEGORIES;
    // fall back to the first known category for any future mismatch
    // instead of breaking the whole catalog render.
    category: KNOWN_CATEGORIES.includes(entry.category ?? "")
      ? (entry.category as ProductCategory)
      : PRODUCT_CATEGORIES[0],
    dimensions: entry.dimensions,
    unit: entry.unit,
    stock: entry.available_stock,
    reserved: 0,
    salePrice: entry.sale_price,
    image: entry.image,
    isPromotion: entry.is_promotion,
  };
}

async function fetchCatalogData(): Promise<CatalogData> {
  const [categoriesResult, catalogResult] = await Promise.all([
    supabase.from("categories").select("*").order("sort_order", { ascending: true }),
    supabase.rpc("get_catalog"),
  ]);

  const errorMessage = categoriesResult.error?.message ?? catalogResult.error?.message ?? null;
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const categories = (categoriesResult.data as Category[] | null) ?? [];
  const entries = (catalogResult.data as CatalogEntry[] | null) ?? [];

  return { categories, products: entries.map(mapCatalogEntryToProduct) };
}

const CatalogContext = createContext<CatalogContextValue | undefined>(undefined);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const currentUserId = user?.id ?? null;

  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<StaticProduct[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadedForUserId, setLoadedForUserId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!IS_SUPABASE_CATALOG_ENABLED || authLoading || loadedForUserId === currentUserId) {
      return;
    }

    let ignore = false;

    fetchCatalogData()
      .then((data) => {
        if (ignore) {
          return;
        }
        setCategories(data.categories);
        setProducts(data.products);
        setError(null);
        setLoadedForUserId(currentUserId);
      })
      .catch((caughtError: unknown) => {
        if (ignore) {
          return;
        }
        setError(
          caughtError instanceof Error ? caughtError.message : "Не удалось загрузить каталог",
        );
        setLoadedForUserId(currentUserId);
      });

    return () => {
      ignore = true;
    };
  }, [authLoading, currentUserId, loadedForUserId]);

  const refreshCatalog = useCallback(async () => {
    if (!IS_SUPABASE_CATALOG_ENABLED) {
      return;
    }
    try {
      const data = await fetchCatalogData();
      setCategories(data.categories);
      setProducts(data.products);
      setError(null);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Не удалось загрузить каталог",
      );
    }
  }, []);

  const loading =
    IS_SUPABASE_CATALOG_ENABLED && (authLoading || loadedForUserId !== currentUserId);

  const value = useMemo<CatalogContextValue>(
    () => ({ categories, products, loading, error, refreshCatalog }),
    [categories, products, loading, error, refreshCatalog],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogContextValue {
  const context = useContext(CatalogContext);
  if (!context) {
    throw new Error("useCatalog должен использоваться внутри CatalogProvider");
  }
  return context;
}
