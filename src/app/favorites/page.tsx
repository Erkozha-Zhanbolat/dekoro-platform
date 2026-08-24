"use client";

import Link from "next/link";
import { useEffect } from "react";
import ProductCard from "@/components/ProductCard";
import { useAuth } from "@/context/AuthContext";
import { useCatalog } from "@/context/CatalogContext";
import { useFavorites } from "@/context/FavoritesContext";
import { useSupabaseCatalog } from "@/lib/featureFlags";
import { getFavoriteProductId } from "@/lib/favorites";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function FavoritesPage() {
  const { user } = useAuth();
  const catalog = useCatalog();
  const { ensureCatalogLoaded } = catalog;
  const { favoriteProductIds, favoritesLoading, favoritesError } = useFavorites();

  useEffect(() => {
    ensureCatalogLoaded();
  }, [ensureCatalogLoaded]);

  // Signing in is only required in Supabase mode (favorites are tied to a
  // user there). With local favorites storage, guests can keep favorites too.
  const requiresSignIn = useSupabaseCatalog && !user;

  if (requiresSignIn) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">Избранные товары</h1>
        <p className="mt-4 text-neutral-600">
          Войдите, чтобы сохранять товары и быстро возвращаться к ним.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/login"
            className={`rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Войти
          </Link>
          <Link
            href="/register"
            className={`rounded-md border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
          >
            Зарегистрироваться
          </Link>
        </div>
      </div>
    );
  }

  const products = catalog.products;
  const isLoading = catalog.loading || favoritesLoading;
  const errorMessage = catalog.error
    ? "Не удалось загрузить каталог"
    : favoritesError;

  const favoriteProducts = products.filter((product) =>
    favoriteProductIds.includes(getFavoriteProductId(product)),
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">Избранные товары</h1>
      <p className="mt-2 text-neutral-600">
        Товары, которые вы сохранили для быстрого доступа.
      </p>

      {isLoading ? (
        <p className="mt-10 text-center text-neutral-500">Загрузка избранного...</p>
      ) : errorMessage ? (
        <p className="mt-10 text-center text-red-600">
          Не удалось загрузить избранное: {errorMessage}
        </p>
      ) : favoriteProducts.length === 0 ? (
        <div className="mt-10 text-center">
          <p className="text-neutral-500">В избранном пока нет товаров.</p>
          <Link
            href="/catalog"
            className={`mt-4 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Перейти в каталог
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-4 text-sm text-neutral-500">
            Товаров в избранном: {favoriteProducts.length}
          </p>
          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {favoriteProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
