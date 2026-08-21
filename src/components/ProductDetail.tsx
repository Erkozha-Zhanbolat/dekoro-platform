"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/formatPrice";
import { computeDiscountPercent, computeSavingsPerUnit } from "@/lib/pricing";
import { getCartPricing } from "@/lib/cartPricing";
import type { CartPricingRow } from "@/lib/cartPricing";
import { getAvailableStock } from "@/lib/inventory";
import { ProductMedia } from "@/components/ProductMedia";
import { QuantitySelector } from "@/components/QuantitySelector";
import FavoriteButton from "@/components/FavoriteButton";
import { getFavoriteProductId } from "@/lib/favorites";
import type { Product } from "@/types/product";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function ProductDetail({ product }: { product: Product }) {
  const { items, addToCart } = useCart();
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;

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

  const totalForQuantity =
    product.salePrice === null ? null : product.salePrice * selectedQuantity;

  const discountPercent = computeDiscountPercent(product.listPrice, product.salePrice);
  const savingsPerUnit = computeSavingsPerUnit(product.listPrice, product.salePrice);

  // Quantity-aware "next threshold" nudge (ТЗ §16) — re-resolved server-side
  // via get_cart_pricing() as the selected quantity changes; never trusted
  // for the actual charge (create_order() re-resolves at checkout).
  const [pricing, setPricing] = useState<CartPricingRow | null>(null);
  useEffect(() => {
    if (product.salePrice === null) {
      return;
    }
    let ignore = false;
    const timeout = setTimeout(() => {
      getCartPricing([{ productId: product.id, quantity: selectedQuantity }])
        .then((rows) => {
          if (!ignore) setPricing(rows[0] ?? null);
        })
        .catch(() => {
          if (!ignore) setPricing(null);
        });
    }, 250);
    return () => {
      ignore = true;
      clearTimeout(timeout);
    };
  }, [product.id, product.salePrice, selectedQuantity]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <Link
        href="/catalog"
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
      >
        ← Назад в каталог
      </Link>

      <div className="mt-6 grid grid-cols-1 gap-10 md:grid-cols-2">
        <ProductMedia
          src={product.image}
          alt={product.name}
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
          {isFullyInCart && (
            <p className="mt-1 text-sm text-amber-600">
              Весь доступный остаток уже в корзине
            </p>
          )}
          {!isFullyInCart && isAtCapacity && (
            <p className="mt-1 text-sm text-amber-600">
              Доступно только: {remainingCapacity} {product.unit}
            </p>
          )}

          <div className="mt-6 border-t border-neutral-200 pt-6">
            {product.salePrice === null ? (
              <p className="text-base font-medium text-neutral-600">
                Цена доступна после авторизации
              </p>
            ) : (
              <>
                {discountPercent != null && product.listPrice != null && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-neutral-400 line-through">
                      {formatPrice(product.listPrice)}
                    </span>
                    <span className="rounded-full bg-[#0F766E]/10 px-2 py-0.5 text-xs font-medium text-[#0F766E]">
                      −{discountPercent}%
                    </span>
                  </div>
                )}
                <p className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-neutral-800">
                    {formatPrice(product.salePrice)}
                  </span>
                  <span className="text-sm text-neutral-500">
                    / {product.unit}
                  </span>
                </p>
                {discountPercent != null && (
                  <p className="mt-1 text-sm font-medium text-[#0F766E]">Ваша цена</p>
                )}
                {savingsPerUnit != null && (
                  <p className="mt-1 text-sm text-emerald-700">
                    Вы экономите {formatPrice(savingsPerUnit)} с каждой {product.unit === "шт." ? "штуки" : "единицы"}
                  </p>
                )}
                {pricing?.nextTierPrice != null && pricing.nextTierMinQuantity != null && (
                  <p className="mt-1 text-sm text-neutral-500">
                    От {pricing.nextTierMinQuantity} {product.unit} цена снизится до{" "}
                    {formatPrice(pricing.nextTierPrice)}
                  </p>
                )}
                {pricing?.priceSource === "quantity_tier"
                  && pricing.quantityTierMinQuantity != null
                  && pricing.quantityTierMinQuantity > 1 && (
                  <p className="mt-1 text-sm text-neutral-500">
                    От {pricing.quantityTierMinQuantity} {product.unit} — {formatPrice(product.salePrice)}/{product.unit}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="mt-6 flex items-center gap-4">
            <span className="text-sm font-medium text-neutral-700">
              Количество
            </span>
            <QuantitySelector
              value={selectedQuantity}
              onChange={handleQuantityChange}
              min={1}
              max={maxSelectable}
              unit={product.unit}
              disabled={isSelectionDisabled}
            />
          </div>

          {totalForQuantity !== null && (
            <p className="mt-4 text-sm text-neutral-600">
              Сумма:{" "}
              <span className="font-semibold text-neutral-800">
                {formatPrice(totalForQuantity)}
              </span>
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleAddToCart}
              disabled={isSelectionDisabled}
              className={`rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 ${focusRing}`}
            >
              {isOutOfStock ? "Нет в наличии" : "Добавить в корзину"}
            </button>
            <FavoriteButton productId={getFavoriteProductId(product)} variant="labeled" />
          </div>
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
