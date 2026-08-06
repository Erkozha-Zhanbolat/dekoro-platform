"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Product } from "@/types/product";
import { trackEvent } from "@/lib/analytics/track";

function isProductUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
}

function trackCartAdd(product: Product, quantity: number): void {
  trackEvent({
    event_type: "cart_add",
    product_id: isProductUuid(product.id) ? product.id : null,
    metadata: {
      quantity,
      sku: product.sku,
      ...(isProductUuid(product.id) ? {} : { static_product_id: product.id }),
    },
  });
}

function trackCartRemove(productId: string): void {
  trackEvent({
    event_type: "cart_remove",
    product_id: isProductUuid(productId) ? productId : null,
    metadata: isProductUuid(productId) ? {} : { static_product_id: productId },
  });
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface CartBulkEntry {
  product: Product;
  quantity: number;
}

interface CartContextValue {
  items: CartItem[];
  totalQuantity: number;
  totalAmount: number;
  hasUnpricedItems: boolean;
  addToCart: (product: Product, quantity: number) => void;
  addManyToCart: (entries: CartBulkEntry[]) => void;
  increaseQuantity: (productId: string) => void;
  decreaseQuantity: (productId: string) => void;
  setItemQuantity: (productId: string, quantity: number) => void;
  removeItem: (productId: string) => void;
  clearCart: () => void;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);

  const addToCart = useCallback((product: Product, quantity: number) => {
    if (quantity <= 0) {
      return;
    }
    setItems((current) => {
      const existing = current.find((item) => item.product.id === product.id);
      if (existing) {
        return current.map((item) =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + quantity }
            : item,
        );
      }
      return [...current, { product, quantity }];
    });
    trackCartAdd(product, quantity);
  }, []);

  // Merges a batch of entries into the cart with a single setItems() call,
  // instead of calling addToCart() in a loop (which would issue one state
  // update per entry). Entries for the same product (either duplicated in
  // the input or already present in the cart) have their quantities summed;
  // entries with quantity <= 0 are ignored, same as addToCart().
  const addManyToCart = useCallback((entries: CartBulkEntry[]) => {
    const additionalQuantityByProductId = new Map<string, number>();
    const productById = new Map<string, Product>();

    for (const entry of entries) {
      if (entry.quantity <= 0) {
        continue;
      }
      additionalQuantityByProductId.set(
        entry.product.id,
        (additionalQuantityByProductId.get(entry.product.id) ?? 0) + entry.quantity,
      );
      productById.set(entry.product.id, entry.product);
    }

    if (additionalQuantityByProductId.size === 0) {
      return;
    }

    setItems((current) => {
      const remaining = new Map(additionalQuantityByProductId);
      const next = current.map((item) => {
        const additionalQuantity = remaining.get(item.product.id);
        if (additionalQuantity === undefined) {
          return item;
        }
        remaining.delete(item.product.id);
        return { ...item, quantity: item.quantity + additionalQuantity };
      });

      for (const [productId, quantity] of remaining) {
        const product = productById.get(productId);
        if (product) {
          next.push({ product, quantity });
        }
      }

      return next;
    });

    for (const [productId, quantity] of additionalQuantityByProductId) {
      const product = productById.get(productId);
      if (product) {
        trackCartAdd(product, quantity);
      }
    }
  }, []);

  const increaseQuantity = useCallback((productId: string) => {
    setItems((current) =>
      current.map((item) =>
        item.product.id === productId
          ? { ...item, quantity: item.quantity + 1 }
          : item,
      ),
    );
  }, []);

  const decreaseQuantity = useCallback((productId: string) => {
    setItems((current) =>
      current.map((item) =>
        item.product.id === productId
          ? { ...item, quantity: Math.max(1, item.quantity - 1) }
          : item,
      ),
    );
  }, []);

  const setItemQuantity = useCallback((productId: string, quantity: number) => {
    setItems((current) =>
      current.map((item) =>
        item.product.id === productId
          ? { ...item, quantity: Math.max(1, Math.trunc(quantity)) }
          : item,
      ),
    );
  }, []);

  const removeItem = useCallback((productId: string) => {
    setItems((current) => current.filter((item) => item.product.id !== productId));
    trackCartRemove(productId);
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
  }, []);

  const totalQuantity = useMemo(
    () => items.reduce((sum, item) => sum + item.quantity, 0),
    [items],
  );

  const totalAmount = useMemo(
    () =>
      items.reduce((sum, item) => {
        if (item.product.salePrice === null) {
          return sum;
        }
        return sum + item.product.salePrice * item.quantity;
      }, 0),
    [items],
  );

  const hasUnpricedItems = useMemo(
    () => items.some((item) => item.product.salePrice === null),
    [items],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      totalQuantity,
      totalAmount,
      hasUnpricedItems,
      addToCart,
      addManyToCart,
      increaseQuantity,
      decreaseQuantity,
      setItemQuantity,
      removeItem,
      clearCart,
    }),
    [
      items,
      totalQuantity,
      totalAmount,
      hasUnpricedItems,
      addToCart,
      addManyToCart,
      increaseQuantity,
      decreaseQuantity,
      setItemQuantity,
      removeItem,
      clearCart,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart должен использоваться внутри CartProvider");
  }
  return context;
}
