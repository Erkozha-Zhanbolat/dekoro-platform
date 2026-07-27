"use client";

import Link from "next/link";
import { useCatalog } from "@/context/CatalogContext";
import ProductDetail from "@/components/ProductDetail";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

// Used only when NEXT_PUBLIC_USE_SUPABASE_CATALOG=true (see
// src/app/product/[id]/page.tsx). Resolves the product from CatalogContext
// on the client instead of the static data file, then renders the exact
// same ProductDetail component so the page looks identical either way.
export default function SupabaseProductPage({ productId }: { productId: string }) {
  const { products, loading, error } = useCatalog();

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-16 text-center text-neutral-500">
        Загрузка товара...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-16 text-center text-red-600">
        Не удалось загрузить товар: {error}
      </div>
    );
  }

  const product = products.find((item) => item.id === productId);

  if (!product) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Товар не найден</h1>
        <p className="mt-4 text-neutral-600">
          Возможно, товар был снят с продажи или ссылка устарела.
        </p>
        <Link
          href="/catalog"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          Перейти в каталог
        </Link>
      </div>
    );
  }

  return <ProductDetail product={product} />;
}
