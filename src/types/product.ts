/**
 * Known storefront category labels (types / fallbacks only).
 * Display and pagination order come from categories.sort_order in Postgres
 * (migration 047) — do not use this array as a second sort authority.
 */
export const PRODUCT_CATEGORIES = [
  "Бамбуковые панели",
  "Луверы",
  "Плинтусы",
  "Алюминиевые профили",
  "Клей",
  "Монтажная пена",
  "Комплектующие",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface Product {
  id: string;
  name: string;
  sku: string;
  originalSku: string;
  category: ProductCategory;
  dimensions: string | null;
  unit: string;
  stock: number;
  reserved: number;
  salePrice: number | null;
  /**
   * Retail/base price (products.base_price via get_catalog(), 041) — shown
   * struck-through for comparison. Public for guests and authenticated
   * customers alike; `salePrice` above is the actual price to charge and
   * stays null for guests (personalized pricing requires authentication).
   */
  listPrice: number | null;
  image: string | null;
  isPromotion: boolean;
}
