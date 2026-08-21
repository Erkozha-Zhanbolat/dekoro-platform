import { formatPrice } from "@/lib/formatPrice";
import { computeDiscountPercent } from "@/lib/pricing";
import type { CartItem } from "@/context/CartContext";

export function OrderSummaryPanel({
  items,
  knownTotal,
  hasUnpricedItems,
  title = "Ваш заказ",
  fulfillmentLabel,
  totalSavings = 0,
}: {
  items: CartItem[];
  knownTotal: number;
  hasUnpricedItems: boolean;
  title?: string;
  fulfillmentLabel?: string;
  /** ТЗ §18 — "Вы экономите X благодаря вашим условиям DEKORO". */
  totalSavings?: number;
}) {
  return (
    <div className="h-fit rounded-lg border border-neutral-200 p-5">
      <h2 className="text-base font-semibold text-neutral-800">{title}</h2>
      {fulfillmentLabel && (
        <p className="mt-1 text-xs text-neutral-500">
          Способ получения:{" "}
          <span className="font-medium text-neutral-700">
            {fulfillmentLabel}
          </span>
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-4">
        {items.map((item) => (
          <li
            key={item.product.id}
            className="flex items-start justify-between gap-4 text-sm"
          >
            <div>
              <p className="font-medium text-neutral-800">
                {item.product.name}
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                Артикул: {item.product.sku}
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {item.quantity} {item.product.unit}
              </p>
            </div>
            <div className="shrink-0 text-right">
              {item.product.salePrice === null ? (
                <span className="text-xs text-neutral-500">
                  Цена уточняется
                </span>
              ) : (
                <>
                  {computeDiscountPercent(item.product.listPrice, item.product.salePrice) != null
                    && item.product.listPrice != null && (
                    <p className="text-xs text-neutral-400 line-through">
                      {formatPrice(item.product.listPrice * item.quantity)}
                    </p>
                  )}
                  <p className="font-medium text-neutral-800">
                    {formatPrice(item.product.salePrice * item.quantity)}
                  </p>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-center justify-between border-t border-neutral-200 pt-4">
        <span className="text-sm text-neutral-500">Итого</span>
        <span className="text-lg font-bold text-neutral-800">
          {formatPrice(knownTotal)}
        </span>
      </div>

      {totalSavings > 0 && (
        <p className="mt-3 rounded-md bg-[#0F766E]/10 px-3 py-2 text-sm text-[#0F766E]">
          Вы экономите {formatPrice(totalSavings)} благодаря вашим условиям DEKORO
        </p>
      )}

      {hasUnpricedItems && (
        <p className="mt-2 text-xs text-neutral-400">
          Сумма рассчитана без учёта товаров с уточняемой ценой
        </p>
      )}
    </div>
  );
}
