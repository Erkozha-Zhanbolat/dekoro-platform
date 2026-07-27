import { formatPrice } from "@/lib/formatPrice";
import { getAvailableStock } from "@/lib/inventory";
import { ProductImagePlaceholder } from "@/components/ProductImagePlaceholder";
import type { Product } from "@/types/product";

// Shared grid template so the header row (rendered by the page) and every
// QuickOrderRow line up on exactly the same columns:
// Артикул | Товар | Категория | Ед. | Остаток | Цена.
export const QUICK_ORDER_GRID_TEMPLATE =
  "md:grid-cols-[120px_minmax(0,2fr)_150px_70px_110px_130px]";

// Read-only row for the Quick Order table: no quantity input, no add-to-cart
// button, no favorites. Below md it collapses from a grid row into a
// stacked, labeled mini-card so the table never forces horizontal scrolling.
export function QuickOrderRow({ product }: { product: Product }) {
  const availableStock = getAvailableStock(product);
  const isOutOfStock = availableStock <= 0;

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
    </div>
  );
}
