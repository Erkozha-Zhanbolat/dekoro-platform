"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/context/AuthContext";
import { useSupabaseCatalog } from "@/lib/featureFlags";
import { readLocalFavorites, writeLocalFavorites } from "@/lib/favorites";

interface FavoritesContextValue {
  favoriteProductIds: string[];
  favoritesLoading: boolean;
  favoritesError: string | null;
  isFavorite: (productId: string) => boolean;
  toggleFavorite: (productId: string) => Promise<void>;
  addFavorite: (productId: string) => Promise<void>;
  removeFavorite: (productId: string) => Promise<void>;
  refreshFavorites: () => Promise<void>;
}

async function fetchFavoriteProductIds(): Promise<string[]> {
  const { data, error } = await supabase.from("favorites").select("product_id");
  if (error) {
    throw new Error(error.message);
  }
  return ((data as { product_id: string }[] | null) ?? []).map((row) => row.product_id);
}

const FavoritesContext = createContext<FavoritesContextValue | undefined>(undefined);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const currentUserId = user?.id ?? null;

  // Two independent storage backends, chosen once per app build:
  // - static catalog (useSupabaseCatalog=false): localStorage, works for
  //   guests and signed-in users alike, on this browser only.
  // - Supabase catalog (useSupabaseCatalog=true): the favorites table,
  //   scoped to the signed-in user via RLS.
  const isLocalMode = !useSupabaseCatalog;

  const [favoriteProductIds, setFavoriteProductIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedLocal, setHasLoadedLocal] = useState(false);
  const [loadedForUserId, setLoadedForUserId] = useState<string | null | undefined>(undefined);
  const [renderedUserId, setRenderedUserId] = useState<string | null | undefined>(undefined);
  const pendingIdsRef = useRef<Set<string>>(new Set());

  // Supabase mode only: clear favorites synchronously during render as soon
  // as the signed-in user changes (e.g. sign-out), mirroring ProfileContext's
  // pattern. Local mode never depends on the signed-in user.
  if (!isLocalMode && !authLoading && renderedUserId !== currentUserId) {
    setRenderedUserId(currentUserId);
    setFavoriteProductIds([]);
    setError(null);
    setLoadedForUserId(undefined);
  }

  // Local mode: read localStorage once after mount. Deferred to an effect
  // (rather than a lazy useState initializer) so the very first client
  // render matches the server-rendered markup (no localStorage during SSR),
  // avoiding a hydration mismatch.
  useEffect(() => {
    if (!isLocalMode || hasLoadedLocal) {
      return;
    }

    let ignore = false;

    // Deferred to a microtask (rather than calling setState directly in the
    // effect body) so this reads the same as every other "sync with an
    // external system" effect in this codebase.
    Promise.resolve().then(() => {
      if (ignore) {
        return;
      }
      setFavoriteProductIds(readLocalFavorites());
      setHasLoadedLocal(true);
    });

    return () => {
      ignore = true;
    };
  }, [isLocalMode, hasLoadedLocal]);

  // Supabase mode: load the signed-in user's favorites from the DB.
  useEffect(() => {
    if (isLocalMode || authLoading || !currentUserId || loadedForUserId === currentUserId) {
      return;
    }

    let ignore = false;

    fetchFavoriteProductIds()
      .then((ids) => {
        if (ignore) {
          return;
        }
        setFavoriteProductIds(ids);
        setError(null);
        setLoadedForUserId(currentUserId);
      })
      .catch((caughtError: unknown) => {
        if (ignore) {
          return;
        }
        setError(
          caughtError instanceof Error ? caughtError.message : "Не удалось загрузить избранное",
        );
        setLoadedForUserId(currentUserId);
      });

    return () => {
      ignore = true;
    };
  }, [isLocalMode, authLoading, currentUserId, loadedForUserId]);

  const isFavorite = useCallback(
    (productId: string) => favoriteProductIds.includes(productId),
    [favoriteProductIds],
  );

  const addFavorite = useCallback(
    async (productId: string) => {
      if (isLocalMode) {
        if (favoriteProductIds.includes(productId)) {
          return;
        }
        setFavoriteProductIds((current) => {
          if (current.includes(productId)) {
            return current;
          }
          const next = [...current, productId];
          writeLocalFavorites(next);
          return next;
        });
        return;
      }

      if (!currentUserId) {
        return;
      }
      if (pendingIdsRef.current.has(productId) || favoriteProductIds.includes(productId)) {
        return;
      }
      pendingIdsRef.current.add(productId);
      setFavoriteProductIds((current) =>
        current.includes(productId) ? current : [...current, productId],
      );

      try {
        const { error: upsertError } = await supabase
          .from("favorites")
          .upsert(
            { user_id: currentUserId, product_id: productId },
            { onConflict: "user_id,product_id", ignoreDuplicates: true },
          );

        if (upsertError) {
          setFavoriteProductIds((current) => current.filter((id) => id !== productId));
          setError(upsertError.message);
          throw new Error(upsertError.message);
        }
        setError(null);
      } finally {
        pendingIdsRef.current.delete(productId);
      }
    },
    [isLocalMode, currentUserId, favoriteProductIds],
  );

  const removeFavorite = useCallback(
    async (productId: string) => {
      if (isLocalMode) {
        if (!favoriteProductIds.includes(productId)) {
          return;
        }
        setFavoriteProductIds((current) => {
          const next = current.filter((id) => id !== productId);
          writeLocalFavorites(next);
          return next;
        });
        return;
      }

      if (!currentUserId) {
        return;
      }
      if (pendingIdsRef.current.has(productId) || !favoriteProductIds.includes(productId)) {
        return;
      }
      pendingIdsRef.current.add(productId);
      setFavoriteProductIds((current) => current.filter((id) => id !== productId));

      try {
        const { error: deleteError } = await supabase
          .from("favorites")
          .delete()
          .eq("user_id", currentUserId)
          .eq("product_id", productId);

        if (deleteError) {
          setFavoriteProductIds((current) =>
            current.includes(productId) ? current : [...current, productId],
          );
          setError(deleteError.message);
          throw new Error(deleteError.message);
        }
        setError(null);
      } finally {
        pendingIdsRef.current.delete(productId);
      }
    },
    [isLocalMode, currentUserId, favoriteProductIds],
  );

  const toggleFavorite = useCallback(
    async (productId: string) => {
      if (favoriteProductIds.includes(productId)) {
        await removeFavorite(productId);
      } else {
        await addFavorite(productId);
      }
    },
    [favoriteProductIds, addFavorite, removeFavorite],
  );

  const refreshFavorites = useCallback(async () => {
    if (isLocalMode) {
      setFavoriteProductIds(readLocalFavorites());
      setError(null);
      return;
    }
    if (!currentUserId) {
      return;
    }
    try {
      const ids = await fetchFavoriteProductIds();
      setFavoriteProductIds(ids);
      setError(null);
      setLoadedForUserId(currentUserId);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error ? caughtError.message : "Не удалось загрузить избранное",
      );
    }
  }, [isLocalMode, currentUserId]);

  const favoritesLoading = isLocalMode
    ? !hasLoadedLocal
    : !!currentUserId && (authLoading || loadedForUserId !== currentUserId);

  const value = useMemo<FavoritesContextValue>(
    () => ({
      favoriteProductIds,
      favoritesLoading,
      favoritesError: error,
      isFavorite,
      toggleFavorite,
      addFavorite,
      removeFavorite,
      refreshFavorites,
    }),
    [
      favoriteProductIds,
      favoritesLoading,
      error,
      isFavorite,
      toggleFavorite,
      addFavorite,
      removeFavorite,
      refreshFavorites,
    ],
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesContextValue {
  const context = useContext(FavoritesContext);
  if (!context) {
    throw new Error("useFavorites должен использоваться внутри FavoritesProvider");
  }
  return context;
}
