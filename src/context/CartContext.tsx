"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Product } from "@/types/product";

export interface CartItem {
  product: Product;
  quantity: number;
}

interface CartContextValue {
  items: CartItem[];
  totalQuantity: number;
  totalAmount: number;
  hasUnpricedItems: boolean;
  addToCart: (product: Product, quantity: number) => void;
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
