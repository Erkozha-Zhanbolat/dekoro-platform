"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/formatPrice";
import { getAvailableStock } from "@/lib/inventory";
import { ProductMedia } from "@/components/ProductMedia";
import { QuantitySelector } from "@/components/QuantitySelector";
import FavoriteButton from "@/components/FavoriteButton";
import { getFavoriteProductId } from "@/lib/favorites";
import type { Product } from "@/types/product";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function ProductCard({ product }: { product: Product }) {
  const { items, addToCart } = useCart();
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;
  const productHref = `/product/${product.id}`;

  const quantityInCart = useMemo(
    () => items.find((item) => item.product.id === product.id)?.quantity ?? 0,
    [items, product.id],
  );
  const remainingCapacity = Math.max(availableStock - quantityInCart, 0);
  const isFullyInCart = !isOutOfStock && remainingCapacity <= 0;
  const isSelectionDisabled = isOutOfStock || isFullyInCart;
  const maxSelectable = Math.max(remainingCapacity, 1);

  const [quantity, setQuantity] = useState(1);
  const selectedQuantity = Math.min(quantity, maxSelectable);
  const isAtCapacity = !isSelectionDisabled && selectedQuantity >= remainingCapacity;

  function handleQuantityChange(value: number) {
    setQuantity(Math.min(Math.max(value, 1), maxSelectable));
  }

  function handleAddToCart() {
    if (isSelectionDisabled) {
      return;
    }
    const quantityToAdd = Math.min(selectedQuantity, remainingCapacity);
    if (quantityToAdd <= 0) {
      return;
    }
    addToCart(product, quantityToAdd);
    setQuantity(1);
  }

  return (
    <div className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-sm">
      <div className="relative">
        <Link href={productHref} className={`block rounded-md ${focusRing}`}>
          <ProductMedia
            src={product.image}
            alt={product.name}
            isPromotion={product.isPromotion}
            className="aspect-square"
          />
        </Link>
        <div className="absolute right-2 top-2 z-10">
          <FavoriteButton productId={getFavoriteProductId(product)} />
        </div>
      </div>

      <span className="mt-3 text-xs uppercase tracking-wide text-neutral-400">
        {product.category}
      </span>
      <h3 className="mt-1 text-sm font-semibold text-neutral-800">
        <Link
          href={productHref}
          className={`rounded-sm transition-colors hover:text-[#0F766E] ${focusRing}`}
        >
          {product.name}
        </Link>
      </h3>
      <p className="mt-1 text-xs text-neutral-500">Артикул: {product.sku}</p>
      {product.dimensions && (
        <p className="mt-0.5 text-xs text-neutral-500">
          Размер: {product.dimensions}
        </p>
      )}

      <div className="mt-3 flex items-baseline gap-1">
        {product.salePrice === null ? (
          <span className="text-sm font-medium text-neutral-500">
            Цена по запросу
          </span>
        ) : (
          <>
            <span className="text-lg font-bold text-neutral-800">
              {formatPrice(product.salePrice)}
            </span>
            <span className="text-xs text-neutral-500">/ {product.unit}</span>
          </>
        )}
      </div>

      <p
        className={`mt-1 text-xs ${isOutOfStock ? "text-red-600" : "text-neutral-500"}`}
      >
        {isOutOfStock
          ? "Нет в наличии"
          : `В наличии: ${availableStock} ${product.unit}`}
      </p>

      {isFullyInCart && (
        <p className="mt-0.5 text-xs text-amber-600">
          Весь доступный остаток уже в корзине
        </p>
      )}
      {!isFullyInCart && isAtCapacity && (
        <p className="mt-0.5 text-xs text-amber-600">
          Доступно только: {remainingCapacity} {product.unit}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <QuantitySelector
          value={selectedQuantity}
          onChange={handleQuantityChange}
          min={1}
          max={maxSelectable}
          unit={product.unit}
          disabled={isSelectionDisabled}
          size="sm"
        />

        <button
          type="button"
          onClick={handleAddToCart}
          disabled={isSelectionDisabled}
          className={`flex-1 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 ${focusRing}`}
        >
          В корзину
        </button>
      </div>
    </div>
  );
}
