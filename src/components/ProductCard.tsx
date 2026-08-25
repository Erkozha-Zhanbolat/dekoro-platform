"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useCart } from "@/context/CartContext";
import { useToast } from "@/context/ToastContext";
import { formatPrice } from "@/lib/formatPrice";
import { computeDiscountPercent } from "@/lib/pricing";
import { getAvailableStock } from "@/lib/inventory";
import { cartAddedToastCopy } from "@/lib/toastFeedback";
import { buildProductHref } from "@/lib/catalogReturnPath";
import { ProductMedia } from "@/components/ProductMedia";
import { QuantitySelector } from "@/components/QuantitySelector";
import FavoriteButton from "@/components/FavoriteButton";
import { getFavoriteProductId } from "@/lib/favorites";
import type { Product } from "@/types/product";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

type ProductCardProps = {
  product: Product;
  /** Override image loading; first viewport cards may use eager. */
  imageLoading?: "lazy" | "eager";
  /**
   * When set (storefront catalog), product links carry `?from=` so
   * «Назад в каталог» can restore search/category. Source of truth: actual
   * catalog URL, not debounced React state.
   */
  catalogReturnHref?: string;
};

export default function ProductCard({
  product,
  imageLoading = "lazy",
  catalogReturnHref,
}: ProductCardProps) {
  const { items, addToCart } = useCart();
  const toast = useToast();
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;
  const productHref = useMemo(
    () => buildProductHref(product.id, catalogReturnHref),
    [product.id, catalogReturnHref],
  );

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
  const discountPercent = computeDiscountPercent(product.listPrice, product.salePrice);
  const hasDiscount = discountPercent != null && product.listPrice != null;

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
    const wasAlreadyInCart = quantityInCart > 0;
    addToCart(product, quantityToAdd);
    const copy = cartAddedToastCopy({
      productName: product.name,
      quantity: quantityToAdd,
      unit: product.unit,
      wasAlreadyInCart,
    });
    toast.success(copy.title, copy.description);
    setQuantity(1);
  }

  return (
    <div className="flex h-full flex-col rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-sm">
      <div className="relative shrink-0">
        <Link href={productHref} className={`block rounded-md ${focusRing}`}>
          <ProductMedia
            src={product.image}
            alt={product.name}
            isPromotion={product.isPromotion}
            className="aspect-square"
            loading={imageLoading}
          />
        </Link>
        <div className="absolute right-2 top-2 z-10">
          <FavoriteButton
            productId={getFavoriteProductId(product)}
            productName={product.name}
          />
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <span className="block truncate text-xs uppercase tracking-wide text-neutral-400">
          {product.category}
        </span>

        <h3
          className="mt-1 min-h-[2.5rem] text-sm font-semibold leading-5 text-neutral-800"
          title={product.name}
        >
          <Link
            href={productHref}
            className={`line-clamp-2 rounded-sm transition-colors hover:text-[#0F766E] ${focusRing}`}
          >
            {product.name}
          </Link>
        </h3>

        <p className="mt-1 truncate text-xs text-neutral-500" title={product.sku}>
          Артикул: {product.sku}
        </p>
        <p
          className="mt-0.5 min-h-[1rem] truncate text-xs text-neutral-500"
          title={product.dimensions ?? undefined}
        >
          {product.dimensions ? `Размер: ${product.dimensions}` : "\u00A0"}
        </p>

        {/* Fixed-height price area so discount / personal price never shifts actions */}
        <div className="mt-3 flex min-h-[4.25rem] flex-col justify-start">
          {product.salePrice === null ? (
            <span className="text-sm font-medium text-neutral-500">
              Цена по запросу
            </span>
          ) : (
            <>
              <div className="flex h-5 items-center gap-1.5">
                {hasDiscount ? (
                  <>
                    <span className="text-xs text-neutral-400 line-through">
                      {formatPrice(product.listPrice!)}
                    </span>
                    <span className="rounded-full bg-[#0F766E]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#0F766E]">
                      −{discountPercent}%
                    </span>
                  </>
                ) : null}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold leading-7 text-neutral-800">
                  {formatPrice(product.salePrice)}
                </span>
                <span className="text-xs text-neutral-500">/ {product.unit}</span>
              </div>
              <div className="h-4">
                {hasDiscount ? (
                  <span className="text-xs font-medium text-[#0F766E]">Ваша цена</span>
                ) : null}
              </div>
            </>
          )}
        </div>

        <p
          className={`mt-1 min-h-[1rem] text-xs ${
            isOutOfStock ? "text-red-600" : "text-neutral-500"
          }`}
        >
          {isOutOfStock
            ? "Нет в наличии"
            : `В наличии: ${availableStock} ${product.unit}`}
        </p>

        <div className="mt-0.5 min-h-[1rem] text-xs text-amber-600">
          {isFullyInCart
            ? "Весь доступный остаток уже в корзине"
            : isAtCapacity
              ? `Доступно только: ${remainingCapacity} ${product.unit}`
              : null}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
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
    </div>
  );
}
