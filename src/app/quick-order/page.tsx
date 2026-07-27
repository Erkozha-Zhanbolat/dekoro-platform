"use client";

import { useMemo, useState } from "react";
import { products as staticProducts } from "@/data/products";
import { PRODUCT_CATEGORIES } from "@/types/product";
import { useCatalog } from "@/context/CatalogContext";
import { useSupabaseCatalog } from "@/lib/featureFlags";
import { QuickOrderRow, QUICK_ORDER_GRID_TEMPLATE } from "@/components/QuickOrderRow";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function categoryButtonClass(isActive: boolean) {
  return `rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${focusRing} ${
    isActive
      ? "border-[#0F766E] bg-[#0F766E] text-white"
      : "border-neutral-200 text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
  }`;
}

export default function QuickOrderPage() {
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
      <h1 className="text-3xl font-bold text-neutral-800">Быстрый заказ</h1>
      <p className="mt-2 text-neutral-600">
        Быстро найдите товары по названию или артикулу и сформируйте заказ.
      </p>

      <div className="mt-6">
        <label htmlFor="quick-order-search" className="sr-only">
          Поиск по названию и артикулу
        </label>
        <input
          id="quick-order-search"
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
          Все
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
            <div className="mt-6 overflow-hidden rounded-lg border border-neutral-200">
              <div
                className={`hidden border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-400 md:grid md:items-center md:gap-4 ${QUICK_ORDER_GRID_TEMPLATE}`}
              >
                <span>Артикул</span>
                <span>Товар</span>
                <span>Категория</span>
                <span>Ед.</span>
                <span>Остаток</span>
                <span className="text-right">Цена</span>
              </div>
              <div className="divide-y divide-neutral-100">
                {filteredProducts.map((product) => (
                  <QuickOrderRow key={product.id} product={product} />
                ))}
              </div>
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
