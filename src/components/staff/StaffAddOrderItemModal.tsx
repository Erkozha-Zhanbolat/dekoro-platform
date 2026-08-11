"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import { searchStaffProducts } from "@/lib/staff/inventory";
import type { StaffProductSearchResult } from "@/lib/staff/inventory";
import { addStaffOrderItem } from "@/lib/staff/orders";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const SEARCH_DEBOUNCE_MS = 300;

/** UI-only availability indication — not a business rule (see ТЗ). */
function AvailabilityBadge({ available }: { available: number }) {
  if (available <= 0) {
    return (
      <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-600">
        Нет в наличии
      </span>
    );
  }
  if (available <= 20) {
    return (
      <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
        Мало
      </span>
    );
  }
  return <span className="text-xs text-neutral-500">{available} доступно</span>;
}

export default function StaffAddOrderItemModal({
  orderId,
  customerId = null,
  onClose,
  onAdded,
}: {
  orderId: string;
  customerId?: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [products, setProducts] = useState<StaffProductSearchResult[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // undefined = not searched yet for this term.
  const [searchedTerm, setSearchedTerm] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (searchedTerm === debouncedSearch) {
      return;
    }

    let ignore = false;

    searchStaffProducts(debouncedSearch, 50, customerId)
      .then((result) => {
        if (ignore) {
          return;
        }
        setProducts(result);
        setLoadError(null);
        setSearchedTerm(debouncedSearch);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить товары");
        setSearchedTerm(debouncedSearch);
      });

    return () => {
      ignore = true;
    };
  }, [debouncedSearch, searchedTerm, customerId]);

  const loading = searchedTerm !== debouncedSearch;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Добавить товар</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 ${focusRing}`}
          >
            ✕
          </button>
        </div>

        <div className="border-b border-neutral-200 px-5 py-4">
          <input
            type="search"
            autoFocus
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Поиск по названию или артикулу"
            className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadError ? (
            <p className="px-5 py-6 text-sm text-red-600" role="alert">
              {loadError}
            </p>
          ) : loading ? (
            <p className="px-5 py-6 text-center text-sm text-neutral-500">Загрузка...</p>
          ) : products.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-neutral-500">Товары не найдены</p>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-4 py-3">Товар</th>
                  <th className="px-4 py-3 text-right">Цена</th>
                  <th className="px-4 py-3 text-right">Физ. остаток</th>
                  <th className="px-4 py-3 text-right">Резерв</th>
                  <th className="px-4 py-3 text-right">Доступно</th>
                  <th className="px-4 py-3">Кол-во</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <ProductRow
                    key={product.product_id}
                    product={product}
                    orderId={orderId}
                    onAdded={onAdded}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function ProductRow({
  product,
  orderId,
  onAdded,
}: {
  product: StaffProductSearchResult;
  orderId: string;
  onAdded: () => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outOfStock = product.available_quantity <= 0;

  async function handleAdd() {
    if (adding || outOfStock || quantity <= 0) {
      return;
    }

    setAdding(true);
    setError(null);

    try {
      await addStaffOrderItem(orderId, product.product_id, quantity);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось добавить товар");
      setAdding(false);
      return;
    }

    setAdding(false);
    onAdded();
  }

  return (
    <tr className="border-b border-neutral-100 last:border-b-0">
      <td className="px-4 py-3">
        <p className="text-sm font-medium text-neutral-800">{product.name}</p>
        <p className="text-xs text-neutral-500">
          {product.sku}
          {product.category ? ` · ${product.category}` : ""}
        </p>
        {error && (
          <p className="mt-1 text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-right text-sm text-neutral-600">
        {product.price !== null ? formatPrice(product.price) : "—"}
      </td>
      <td className="px-4 py-3 text-right text-sm text-neutral-600">
        {product.physical_quantity}
      </td>
      <td className="px-4 py-3 text-right text-sm text-neutral-600">
        {product.reserved_quantity}
      </td>
      <td className="px-4 py-3 text-right">
        <AvailabilityBadge available={product.available_quantity} />
      </td>
      <td className="px-4 py-3">
        <input
          type="number"
          min={1}
          max={outOfStock ? undefined : product.available_quantity}
          value={quantity}
          disabled={outOfStock || adding}
          onChange={(event) => {
            const next = Number(event.target.value);
            setQuantity(Number.isFinite(next) && next > 0 ? Math.floor(next) : 1);
          }}
          className={`w-20 rounded-md border border-neutral-200 px-2 py-1.5 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] disabled:bg-neutral-100 disabled:text-neutral-400 ${focusRing}`}
        />
      </td>
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={handleAdd}
          disabled={outOfStock || adding}
          className={`rounded-md bg-[#0F766E] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-300 ${focusRing}`}
        >
          {adding ? "Добавление..." : "Добавить"}
        </button>
      </td>
    </tr>
  );
}
