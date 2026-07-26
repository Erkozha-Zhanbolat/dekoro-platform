import type { Product } from "@/types/product";

export function getAvailableStock(product: Product): number {
  return product.stock - product.reserved;
}
