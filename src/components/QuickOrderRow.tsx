import { formatPrice } from "@/lib/formatPrice";
import { getAvailableStock } from "@/lib/inventory";
import { ProductImagePlaceholder } from "@/components/ProductImagePlaceholder";
import { QuantitySelector } from "@/components/QuantitySelector";
import type { Product } from "@/types/product";

// Shared grid template so the header row (rendered by the page) and every
// QuickOrderRow line up on exactly the same columns:
// Артикул | Товар | Категория | Ед. | Остаток | Цена | Количество.
export const QUICK_ORDER_GRID_TEMPLATE =
  "md:grid-cols-[100px_minmax(0,1.4fr)_130px_60px_90px_110px_190px]";

export interface QuickOrderRowProps {
  product: Product;
  // Currently selected quantity for this row, already clamped to
  // [0, maxQuantity] by the page.
  value: number;
  // Remaining capacity for this product: available stock minus whatever
  // quantity of it is already sitting in the cart. Computed on the page
  // (not here) since it depends on cart state.
  maxQuantity: number;
  quantityInCart: number;
  onQuantityChange: (quantity: number) => void;
}

// Presentational row for the Quick Order table: quantity selection is fully
// controlled by the page (value/maxQuantity/onQuantityChange props) — this
// component does not read CartContext or own any state of its own. Below md
// it collapses from a grid row into a stacked, labeled mini-card so the
// table never forces horizontal scrolling.
export function QuickOrderRow({
  product,
  value,
  maxQuantity,
  quantityInCart,
  onQuantityChange,
}: QuickOrderRowProps) {
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;
  const isSelectionDisabled = maxQuantity <= 0;
  const isFullyInCart = !isOutOfStock && isSelectionDisabled;

  return (
    <div
      className={`flex flex-col gap-1.5 px-3 py-3 text-sm md:grid md:items-center md:gap-4 ${QUICK_ORDER_GRID_TEMPLATE}`}
    >
      <span className="font-medium text-neutral-700 md:font-normal md:text-neutral-600">
        <span className="mr-1 text-neutral-400 md:hidden">Артикул:</span>
        {product.sku}
      </span>

      <div className="flex min-w-0 items-center gap-3">
        <ProductImagePlaceholder
          isPromotion={product.isPromotion}
          className="hidden h-10 w-10 shrink-0 sm:flex"
        />
        <span className="min-w-0 font-medium text-neutral-800 md:truncate">
          {product.name}
        </span>
      </div>

      <span className="text-neutral-500 md:text-neutral-600">
        <span className="mr-1 text-neutral-400 md:hidden">Категория:</span>
        {product.category}
      </span>

      <span className="text-neutral-500 md:text-neutral-600">
        <span className="mr-1 text-neutral-400 md:hidden">Ед.:</span>
        {product.unit}
      </span>

      <span className={isOutOfStock ? "text-red-600" : "text-neutral-500 md:text-neutral-600"}>
        <span className="mr-1 text-neutral-400 md:hidden">Остаток:</span>
        {isOutOfStock ? "Нет в наличии" : availableStock}
      </span>

      <span className="font-semibold text-neutral-800 md:text-right">
        <span className="mr-1 text-xs font-normal text-neutral-400 md:hidden">
          Цена:
        </span>
        {product.salePrice === null ? (
          <span className="text-sm font-normal text-neutral-500">
            Цена уточняется
          </span>
        ) : (
          formatPrice(product.salePrice)
        )}
      </span>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-neutral-400 md:hidden">Количество</span>
        <QuantitySelector
          value={value}
          onChange={onQuantityChange}
          min={0}
          max={maxQuantity}
          unit={product.unit}
          disabled={isSelectionDisabled}
          size="sm"
        />
        {isOutOfStock ? (
          <span className="text-xs text-red-600">Нет в наличии</span>
        ) : isFullyInCart ? (
          <span className="text-xs text-amber-600">
            Весь доступный остаток уже в корзине
          </span>
        ) : (
          <span className="text-xs text-neutral-500">
            Доступно для добавления: {maxQuantity} {product.unit}
          </span>
        )}
        {quantityInCart > 0 && (
          <span className="text-xs text-neutral-400">
            Уже в корзине: {quantityInCart} {product.unit}
          </span>
        )}
      </div>
    </div>
  );
}
