"use client";

import { useMemo, useState } from "react";
import { products as staticProducts } from "@/data/products";
import { PRODUCT_CATEGORIES } from "@/types/product";
import { useCatalog } from "@/context/CatalogContext";
import { useCart } from "@/context/CartContext";
import { useSupabaseCatalog } from "@/lib/featureFlags";
import { getAvailableStock } from "@/lib/inventory";
import { QuickOrderRow, QUICK_ORDER_GRID_TEMPLATE } from "@/components/QuickOrderRow";

// Selected quantity per product for this Quick Order session, keyed by
// product.id. A quantity of 0 (or an absent key) means "not selected". Kept
// independent of the current search/category filter so a selection survives
// the product being temporarily hidden by the filter.
type QuickOrderSelection = Record<string, number>;

interface QuickOrderProductState {
  availableStock: number;
  quantityInCart: number;
  remainingCapacity: number;
}

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
  const { items: cartItems } = useCart();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selection, setSelection] = useState<QuickOrderSelection>({});

  const products = useSupabaseCatalog ? catalog.products : staticProducts;
  const categoryNames = useSupabaseCatalog
    ? catalog.categories.map((item) => item.name)
    : [...PRODUCT_CATEGORIES];

  const quantityInCartByProductId = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of cartItems) {
      map.set(item.product.id, item.quantity);
    }
    return map;
  }, [cartItems]);

  // Available stock and remaining capacity (stock minus what's already in
  // the cart) for every product, independent of the current filter — this is
  // what lets a selection survive a product being temporarily hidden.
  const productStateById = useMemo(() => {
    const map = new Map<string, QuickOrderProductState>();
    for (const product of products) {
      const availableStock = getAvailableStock(product);
      const quantityInCart = quantityInCartByProductId.get(product.id) ?? 0;
      const remainingCapacity = Math.max(0, availableStock - quantityInCart);
      map.set(product.id, { availableStock, quantityInCart, remainingCapacity });
    }
    return map;
  }, [products, quantityInCartByProductId]);

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

  // Selected quantity is derived by clamping the stored raw value against
  // the product's current remaining capacity, rather than mutating the
  // stored value — if capacity temporarily drops (e.g. the same product was
  // just added elsewhere) and later recovers, the original selection re-
  // appears without the user having to re-enter it.
  function getSelectedQuantity(productId: string): number {
    const remainingCapacity = productStateById.get(productId)?.remainingCapacity ?? 0;
    const rawQuantity = selection[productId] ?? 0;
    return Math.min(rawQuantity, remainingCapacity);
  }

  function handleQuantityChange(productId: string, quantity: number) {
    const remainingCapacity = productStateById.get(productId)?.remainingCapacity ?? 0;
    const clamped = Math.max(0, Math.min(Math.trunc(quantity), remainingCapacity));
    setSelection((current) => ({ ...current, [productId]: clamped }));
  }

  const selectedCount = useMemo(() => {
    let count = 0;
    for (const product of products) {
      const remainingCapacity = productStateById.get(product.id)?.remainingCapacity ?? 0;
      const rawQuantity = selection[product.id] ?? 0;
      if (Math.min(rawQuantity, remainingCapacity) > 0) {
        count += 1;
      }
    }
    return count;
  }, [products, productStateById, selection]);

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
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-500">
            <span>Найдено товаров: {filteredProducts.length}</span>
            <span>Выбрано позиций: {selectedCount}</span>
          </div>

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
                <span>Количество</span>
              </div>
              <div className="divide-y divide-neutral-100">
                {filteredProducts.map((product) => {
                  const productState = productStateById.get(product.id);
                  const remainingCapacity = productState?.remainingCapacity ?? 0;
                  const quantityInCart = productState?.quantityInCart ?? 0;

                  return (
                    <QuickOrderRow
                      key={product.id}
                      product={product}
                      value={getSelectedQuantity(product.id)}
                      maxQuantity={remainingCapacity}
                      quantityInCart={quantityInCart}
                      onQuantityChange={(quantity) =>
                        handleQuantityChange(product.id, quantity)
                      }
                    />
                  );
                })}
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
