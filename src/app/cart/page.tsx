"use client";

import Link from "next/link";
import { useCart } from "@/context/CartContext";
import { formatPrice } from "@/lib/formatPrice";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function CartPage() {
  const { items, totalAmount, increaseQuantity, decreaseQuantity, removeItem } =
    useCart();
  const hasPendingPriceItems = items.some(
    (item) => item.product.salePrice === null,
  );

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">Корзина</h1>
        <p className="mt-4 text-neutral-600">Корзина пуста</p>
        <Link
          href="/catalog"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          Перейти в каталог
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">Корзина</h1>

      <div className="mt-6 flex flex-col gap-4">
        {items.map((item) => (
          <div
            key={item.product.id}
            className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <h2 className="text-sm font-semibold text-neutral-800">
                {item.product.name}
              </h2>
              <p className="mt-1 text-xs text-neutral-500">
                Артикул: {item.product.sku}
              </p>
              <p className="mt-1 text-sm text-neutral-600">
                {item.product.salePrice === null ? (
                  <span className="text-neutral-500">Цена уточняется</span>
                ) : (
                  <>
                    {formatPrice(item.product.salePrice)} / {item.product.unit}
                  </>
                )}
              </p>
            </div>

            <div className="flex items-center gap-4 sm:gap-6">
              <div className="flex items-center rounded-md border border-neutral-200">
                <button
                  type="button"
                  onClick={() => decreaseQuantity(item.product.id)}
                  aria-label="Уменьшить количество"
                  className={`flex h-8 w-8 items-center justify-center text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
                >
                  −
                </button>
                <span className="w-8 text-center text-sm font-medium text-neutral-800">
                  {item.quantity}
                </span>
                <button
                  type="button"
                  onClick={() => increaseQuantity(item.product.id)}
                  aria-label="Увеличить количество"
                  className={`flex h-8 w-8 items-center justify-center text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
                >
                  +
                </button>
              </div>

              <span className="w-28 shrink-0 text-right text-sm font-semibold text-neutral-800">
                {item.product.salePrice === null
                  ? "Цена уточняется"
                  : formatPrice(item.product.salePrice * item.quantity)}
              </span>

              <button
                type="button"
                onClick={() => removeItem(item.product.id)}
                aria-label="Удалить товар"
                className={`rounded-sm text-sm font-medium text-neutral-400 transition-colors hover:text-red-600 ${focusRing}`}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-col items-end gap-1 border-t border-neutral-200 pt-6">
        <span className="text-sm text-neutral-500">Итого к оплате</span>
        <span className="text-2xl font-bold text-neutral-800">
          {formatPrice(totalAmount)}
        </span>
        {hasPendingPriceItems && (
          <span className="text-xs text-neutral-400">
            Сумма рассчитана без учёта товаров с уточняемой ценой
          </span>
        )}
      </div>
    </div>
  );
}
