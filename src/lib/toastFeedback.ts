/**
 * User-facing toast copy helpers for cart / favorites actions.
 * Kept outside CartContext / FavoritesContext so UI feedback stays in the UI layer.
 */

export function cartAddedToastCopy(options: {
  productName: string;
  quantity: number;
  unit: string;
  wasAlreadyInCart: boolean;
}): { title: string; description: string } {
  const { productName, quantity, unit, wasAlreadyInCart } = options;
  if (wasAlreadyInCart) {
    return {
      title: "Добавлено ещё в корзину",
      description: `${productName} · +${quantity} ${unit}`,
    };
  }
  return {
    title: "Товар добавлен в корзину",
    description: `${productName} · ${quantity} ${unit}`,
  };
}

/** Avoid leaking raw Supabase / DB errors into toast secondary text. */
export function safeUserFacingErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const message = error.message.trim();
  if (!message || message.length > 100) {
    return undefined;
  }
  if (
    /supabase|postgres|postgrest|pgrst|jwt|rls|permission denied|networkerror|failed to fetch|auth\.|sql/i.test(
      message,
    )
  ) {
    return undefined;
  }
  return message;
}
