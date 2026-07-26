"use client";

import Link from "next/link";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/formatPrice";
import { getAvailableStock } from "@/lib/inventory";
import { ProductImagePlaceholder } from "@/components/ProductImagePlaceholder";
import type { Product } from "@/types/product";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function ProductCard({ product }: { product: Product }) {
  const { addItem } = useCart();
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;
  const productHref = `/product/${product.id}`;

  return (
    <div className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-sm">
      <Link href={productHref} className={`block rounded-md ${focusRing}`}>
        <ProductImagePlaceholder
          isPromotion={product.isPromotion}
          className="aspect-square"
        />
      </Link>

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
            Цена доступна после авторизации
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

      <button
        type="button"
        onClick={() => addItem(product)}
        disabled={isOutOfStock}
        className={`mt-4 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400 ${focusRing}`}
      >
        В корзину
      </button>
    </div>
  );
}
