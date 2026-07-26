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
  category: ProductCategory;
  price: number;
  unit: string;
  stock: number;
  image: string | null;
  isPromotion: boolean;
}
