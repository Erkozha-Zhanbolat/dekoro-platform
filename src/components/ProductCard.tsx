"use client";

import type { SVGProps } from "react";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/formatPrice";
import type { Product } from "@/types/product";

function ImagePlaceholderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.1 0L4 19" />
    </svg>
  );
}

export default function ProductCard({ product }: { product: Product }) {
  const { addItem } = useCart();
  const isOutOfStock = product.stock === 0;

  return (
    <div className="flex flex-col rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-sm">
      <div className="relative flex aspect-square items-center justify-center rounded-md bg-neutral-100 text-neutral-300">
        <ImagePlaceholderIcon className="h-10 w-10" />
        {product.isPromotion && (
          <span className="absolute left-2 top-2 rounded-full bg-[#0F766E] px-2 py-0.5 text-[11px] font-semibold text-white">
            Акция
          </span>
        )}
      </div>

      <span className="mt-3 text-xs uppercase tracking-wide text-neutral-400">
        {product.category}
      </span>
      <h3 className="mt-1 text-sm font-semibold text-neutral-800">
        {product.name}
      </h3>
      <p className="mt-1 text-xs text-neutral-500">Артикул: {product.sku}</p>

      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-lg font-bold text-neutral-800">
          {formatPrice(product.price)}
        </span>
        <span className="text-xs text-neutral-500">/ {product.unit}</span>
      </div>

      <p
        className={`mt-1 text-xs ${isOutOfStock ? "text-red-600" : "text-neutral-500"}`}
      >
        {isOutOfStock
          ? "Нет в наличии"
          : `В наличии: ${product.stock} ${product.unit}`}
      </p>

      <button
        type="button"
        onClick={() => addItem(product)}
        disabled={isOutOfStock}
        className="mt-4 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
      >
        В корзину
      </button>
    </div>
  );
}
