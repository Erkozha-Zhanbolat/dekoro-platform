"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  deriveCategoryNames,
  getCatalog,
  mapCatalogProductToProduct,
} from "@/lib/catalog";
import type { Product } from "@/types/product";

interface CatalogContextValue {
  /** Category names derived from loaded products (no separate query). */
  categoryNames: string[];
  products: Product[];
  loading: boolean;
  error: string | null;
  refreshCatalog: () => Promise<void>;
}

const CatalogContext = createContext<CatalogContextValue | undefined>(undefined);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const currentUserId = user?.id ?? null;

  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  // undefined = not loaded yet for this auth identity
  const [loadedForUserId, setLoadedForUserId] = useState<string | null | undefined>(
    undefined,
  );

  useEffect(() => {
    // Re-fetch when auth identity settles/changes so sale_price personalizes.
    if (authLoading || loadedForUserId === currentUserId) {
      return;
    }

    let ignore = false;

    getCatalog()
      .then((entries) => {
        if (ignore) {
          return;
        }
        setProducts(entries.map(mapCatalogProductToProduct));
        setError(null);
        setLoadedForUserId(currentUserId);
      })
      .catch((caughtError: unknown) => {
        if (ignore) {
          return;
        }
        setProducts([]);
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Не удалось загрузить каталог",
        );
        setLoadedForUserId(currentUserId);
      });

    return () => {
      ignore = true;
    };
  }, [authLoading, currentUserId, loadedForUserId]);

  const refreshCatalog = useCallback(async () => {
    try {
      const entries = await getCatalog();
      setProducts(entries.map(mapCatalogProductToProduct));
      setError(null);
      setLoadedForUserId(currentUserId);
    } catch (caughtError) {
      setProducts([]);
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Не удалось загрузить каталог",
      );
    }
  }, [currentUserId]);

  const loading = authLoading || loadedForUserId !== currentUserId;
  const categoryNames = useMemo(() => deriveCategoryNames(products), [products]);

  const value = useMemo<CatalogContextValue>(
    () => ({ categoryNames, products, loading, error, refreshCatalog }),
    [categoryNames, products, loading, error, refreshCatalog],
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
