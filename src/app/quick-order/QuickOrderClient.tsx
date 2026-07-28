"use client";

import { useMemo, useState } from "react";
import type { Product } from "@/types/product";
import { useCatalog } from "@/context/CatalogContext";
import { useCart } from "@/context/CartContext";
import { getAvailableStock } from "@/lib/inventory";
import { formatPrice } from "@/lib/formatPrice";
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

interface QuickOrderEntry {
  product: Product;
  quantity: number;
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

export default function QuickOrderClient() {
  const catalog = useCatalog();
  const { items: cartItems, addManyToCart } = useCart();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selection, setSelection] = useState<QuickOrderSelection>({});
  const [addedMessage, setAddedMessage] = useState<string | null>(null);

  const products = catalog.products;
  const categoryNames = catalog.categoryNames;

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

  function handleQuantityChange(productId: string, quantity: number) {
    const remainingCapacity = productStateById.get(productId)?.remainingCapacity ?? 0;
    const clamped = Math.max(0, Math.min(Math.trunc(quantity), remainingCapacity));
    setSelection((current) => ({ ...current, [productId]: clamped }));
    // A quantity change makes any previous "added to cart" message stale.
    setAddedMessage(null);
  }

  // Single source of truth for every selection-derived value (summary bar
  // and the bulk add-to-cart call): built over the full product list (not
  // just filteredProducts) so it reflects the whole session, and always
  // re-clamps the raw selection against the *current* remainingCapacity —
  // never trusts a previously rendered value on its own. Anything computed
  // from `selection` elsewhere on this page should be derived from this
  // array instead of re-implementing the same clamp.
  const selectedEntries = useMemo<QuickOrderEntry[]>(() => {
    const entries: QuickOrderEntry[] = [];
    for (const product of products) {
      const remainingCapacity = productStateById.get(product.id)?.remainingCapacity ?? 0;
      const quantity = Math.max(0, Math.min(selection[product.id] ?? 0, remainingCapacity));
      if (quantity > 0) {
        entries.push({ product, quantity });
      }
    }
    return entries;
  }, [products, productStateById, selection]);

  const selectedQuantityByProductId = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of selectedEntries) {
      map.set(entry.product.id, entry.quantity);
    }
    return map;
  }, [selectedEntries]);

  const selectedCount = selectedEntries.length;

  const totalQuantity = useMemo(
    () => selectedEntries.reduce((sum, entry) => sum + entry.quantity, 0),
    [selectedEntries],
  );

  const totalAmount = useMemo(
    () =>
      selectedEntries.reduce((sum, entry) => {
        if (entry.product.salePrice === null) {
          return sum;
        }
        return sum + entry.product.salePrice * entry.quantity;
      }, 0),
    [selectedEntries],
  );

  const unpricedCount = useMemo(
    () => selectedEntries.filter((entry) => entry.product.salePrice === null).length,
    [selectedEntries],
  );

  function handleAddSelectedToCart() {
    if (selectedEntries.length === 0) {
      return;
    }

    // selectedEntries was just recomputed from the current products/cart/
    // selection state above, so this is already validated against the
    // up-to-date remainingCapacity — a single addManyToCart call, no loop.
    addManyToCart(selectedEntries);

    const addedProductIds = new Set(selectedEntries.map((entry) => entry.product.id));
    setSelection((current) => {
      const next = { ...current };
      for (const productId of addedProductIds) {
        delete next[productId];
      }
      return next;
    });

    setAddedMessage(`Добавлено в корзину: ${selectedEntries.length} позиций`);
  }

  return (
    <div
      className={`mx-auto max-w-6xl px-6 pt-12 ${selectedCount > 0 ? "pb-36" : "pb-12"}`}
    >
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

      {catalog.loading ? (
        <p className="mt-10 text-center text-neutral-500">Загрузка каталога...</p>
      ) : catalog.error ? (
        <p className="mt-10 text-center text-red-600">
          Не удалось загрузить каталог
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-neutral-500">
            <span>Найдено товаров: {filteredProducts.length}</span>
            <span>Выбрано позиций: {selectedCount}</span>
          </div>

          {addedMessage && (
            <p className="mt-3 rounded-md bg-[#0F766E]/10 px-3 py-2 text-sm font-medium text-[#0F766E]">
              {addedMessage}
            </p>
          )}

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
                      value={selectedQuantityByProductId.get(product.id) ?? 0}
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

      {selectedCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 px-4 pb-4 sm:px-6">
          <div className="mx-auto flex max-w-6xl flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-lg sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-neutral-600">
              <span>
                Выбрано позиций:{" "}
                <span className="font-semibold text-neutral-800">{selectedCount}</span>
              </span>
              <span>
                Общее количество:{" "}
                <span className="font-semibold text-neutral-800">{totalQuantity}</span>
              </span>
              <span>
                Сумма:{" "}
                <span className="font-semibold text-neutral-800">
                  {formatPrice(totalAmount)}
                </span>
              </span>
              {unpricedCount > 0 && (
                <span className="text-neutral-500">
                  Без цены: {unpricedCount} позиций
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={handleAddSelectedToCart}
              disabled={selectedEntries.length === 0}
              aria-label={`Добавить выбранные товары в корзину: ${selectedCount} позиций`}
              className={`w-full shrink-0 rounded-md bg-[#0F766E] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 sm:w-auto ${focusRing}`}
            >
              Добавить выбранные ({selectedCount})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
