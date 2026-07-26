export const PRODUCT_CATEGORIES = [
  "Бамбуковые панели",
  "Луверы",
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
  image: string | null;
  isPromotion: boolean;
}
