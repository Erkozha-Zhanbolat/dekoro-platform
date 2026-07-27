"use client";

import { useMemo, useState } from "react";
import ProductCard from "@/components/ProductCard";
import { products as staticProducts } from "@/data/products";
import { PRODUCT_CATEGORIES } from "@/types/product";
import { useCatalog } from "@/context/CatalogContext";
import { useSupabaseCatalog } from "@/lib/featureFlags";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function categoryButtonClass(isActive: boolean) {
  return `rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${focusRing} ${
    isActive
      ? "border-[#0F766E] bg-[#0F766E] text-white"
      : "border-neutral-200 text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
  }`;
}

export default function CatalogPage() {
  const catalog = useCatalog();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const products = useSupabaseCatalog ? catalog.products : staticProducts;
  const categoryNames = useSupabaseCatalog
    ? catalog.categories.map((item) => item.name)
    : [...PRODUCT_CATEGORIES];

  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return products.filter((product) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        product.name.toLowerCase().includes(normalizedQuery) ||
        product.sku.toLowerCase().includes(normalizedQuery);
      const matchesCategory = category === null || product.category === category;

      return matchesQuery && matchesCategory;
    });
  }, [products, query, category]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">Каталог</h1>
      <p className="mt-2 text-neutral-600">
        Каталог — здесь представлен ассортимент продукции DEKORO.
      </p>

      <div className="mt-6">
        <label htmlFor="catalog-search" className="sr-only">
          Поиск по названию и артикулу
        </label>
        <input
          id="catalog-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по названию и артикулу"
          className={`w-full max-w-xl rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:bg-white focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setCategory(null)}
          className={categoryButtonClass(category === null)}
        >
          Все категории
        </button>
        {categoryNames.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setCategory(item)}
            className={categoryButtonClass(category === item)}
          >
            {item}
          </button>
        ))}
      </div>

      {useSupabaseCatalog && catalog.loading ? (
        <p className="mt-10 text-center text-neutral-500">Загрузка каталога...</p>
      ) : useSupabaseCatalog && catalog.error ? (
        <p className="mt-10 text-center text-red-600">
          Не удалось загрузить каталог: {catalog.error}
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-neutral-500">
            Найдено товаров: {filteredProducts.length}
          </p>

          {filteredProducts.length > 0 ? (
            <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredProducts.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          ) : (
            <p className="mt-10 text-center text-neutral-500">
              По вашему запросу ничего не найдено.
            </p>
          )}
        </>
      )}
    </div>
  );
}
