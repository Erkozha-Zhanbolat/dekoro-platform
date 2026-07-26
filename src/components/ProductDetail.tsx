"use client";

import Link from "next/link";
import { useState } from "react";
import type { ChangeEvent } from "react";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/formatPrice";
import { getAvailableStock } from "@/lib/inventory";
import { ProductImagePlaceholder } from "@/components/ProductImagePlaceholder";
import type { Product } from "@/types/product";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function ProductDetail({ product }: { product: Product }) {
  const { addItem } = useCart();
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;
  const maxQuantity = Math.max(availableStock, 1);
  const [quantity, setQuantity] = useState(1);

  function clampQuantity(value: number): number {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.min(Math.max(1, Math.trunc(value)), maxQuantity);
  }

  function handleDecrease() {
    setQuantity((current) => clampQuantity(current - 1));
  }

  function handleIncrease() {
    setQuantity((current) => clampQuantity(current + 1));
  }

  function handleQuantityChange(event: ChangeEvent<HTMLInputElement>) {
    setQuantity(clampQuantity(Number(event.target.value)));
  }

  function handleAddToCart() {
    if (isOutOfStock) {
      return;
    }
    addItem(product, quantity);
  }

  const totalForQuantity =
    product.salePrice === null ? null : product.salePrice * quantity;

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Link
        href="/catalog"
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
      >
        ← Назад в каталог
      </Link>

      <div className="mt-6 grid grid-cols-1 gap-10 md:grid-cols-2">
        <ProductImagePlaceholder
          isPromotion={product.isPromotion}
          className="aspect-square w-full"
        />

        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-neutral-400">
            {product.category}
          </span>
          <h1 className="mt-1 text-2xl font-bold text-neutral-800">
            {product.name}
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            Артикул: {product.sku}
          </p>
          {product.dimensions && (
            <p className="mt-1 text-sm text-neutral-500">
              Размер: {product.dimensions}
            </p>
          )}
          <p
            className={`mt-1 text-sm ${isOutOfStock ? "text-red-600" : "text-neutral-500"}`}
          >
            {isOutOfStock
              ? "Нет в наличии"
              : `В наличии: ${availableStock} ${product.unit}`}
          </p>

          <div className="mt-6 border-t border-neutral-200 pt-6">
            {product.salePrice === null ? (
              <p className="text-base font-medium text-neutral-600">
                Цена доступна после авторизации
              </p>
            ) : (
              <p className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-neutral-800">
                  {formatPrice(product.salePrice)}
                </span>
                <span className="text-sm text-neutral-500">
                  / {product.unit}
                </span>
              </p>
            )}
          </div>

          <div className="mt-6 flex items-center gap-4">
            <span className="text-sm font-medium text-neutral-700">
              Количество
            </span>
            <div className="flex items-center rounded-md border border-neutral-200">
              <button
                type="button"
                onClick={handleDecrease}
                disabled={isOutOfStock || quantity <= 1}
                aria-label="Уменьшить количество"
                className={`flex h-9 w-9 items-center justify-center text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent ${focusRing}`}
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={maxQuantity}
                step={1}
                value={quantity}
                onChange={handleQuantityChange}
                disabled={isOutOfStock}
                aria-label="Количество"
                className={`h-9 w-14 border-x border-neutral-200 text-center text-sm font-medium text-neutral-800 outline-none disabled:bg-neutral-50 disabled:text-neutral-300 ${focusRing}`}
              />
              <button
                type="button"
                onClick={handleIncrease}
                disabled={isOutOfStock || quantity >= maxQuantity}
                aria-label="Увеличить количество"
                className={`flex h-9 w-9 items-center justify-center text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent ${focusRing}`}
              >
                +
              </button>
            </div>
          </div>

          {totalForQuantity !== null && (
            <p className="mt-4 text-sm text-neutral-600">
              Сумма:{" "}
              <span className="font-semibold text-neutral-800">
                {formatPrice(totalForQuantity)}
              </span>
            </p>
          )}

          <button
            type="button"
            onClick={handleAddToCart}
            disabled={isOutOfStock}
            className={`mt-6 rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 ${focusRing}`}
          >
            {isOutOfStock ? "Нет в наличии" : "Добавить в корзину"}
          </button>
        </div>
      </div>

      <div className="mt-12 flex flex-col gap-8 border-t border-neutral-200 pt-8">
        <section>
          <h2 className="text-lg font-semibold text-neutral-800">Описание</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Описание товара будет добавлено позже.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-neutral-800">
            Характеристики
          </h2>
          <dl className="mt-2 grid grid-cols-1 gap-x-8 gap-y-0 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-2 border-b border-neutral-100 py-2">
              <dt className="text-neutral-500">Артикул</dt>
              <dd className="text-neutral-800">{product.sku}</dd>
            </div>
            <div className="flex justify-between gap-2 border-b border-neutral-100 py-2">
              <dt className="text-neutral-500">Категория</dt>
              <dd className="text-neutral-800">{product.category}</dd>
            </div>
            <div className="flex justify-between gap-2 border-b border-neutral-100 py-2">
              <dt className="text-neutral-500">Размер</dt>
              <dd className="text-neutral-800">{product.dimensions ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2 border-b border-neutral-100 py-2">
              <dt className="text-neutral-500">Единица измерения</dt>
              <dd className="text-neutral-800">{product.unit}</dd>
            </div>
          </dl>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-neutral-800">Документы</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Документы будут доступны после загрузки.
          </p>
        </section>
      </div>
    </div>
  );
}
