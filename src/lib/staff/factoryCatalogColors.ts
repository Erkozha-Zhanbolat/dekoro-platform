/**
 * Factory catalog colors are stored as allowlisted tokens, never raw CSS.
 * Changing a catalog's color does not change product membership (UUID identity).
 */

export const FACTORY_CATALOG_COLOR_TOKENS = [
  "white",
  "orange",
  "amber",
  "rose",
  "red",
  "teal",
  "emerald",
  "blue",
  "indigo",
  "slate",
  "stone",
] as const;

export type FactoryCatalogColorToken = (typeof FACTORY_CATALOG_COLOR_TOKENS)[number];

export const FACTORY_CATALOG_COLOR_META: Record<
  FactoryCatalogColorToken,
  { label: string; swatch: string; star: string }
> = {
  white: { label: "Белый", swatch: "#F5F0E6", star: "#A8A29A" },
  orange: { label: "Оранжевый", swatch: "#EA580C", star: "#EA580C" },
  amber: { label: "Янтарный", swatch: "#D97706", star: "#D97706" },
  rose: { label: "Розовый", swatch: "#E11D48", star: "#E11D48" },
  red: { label: "Красный", swatch: "#DC2626", star: "#DC2626" },
  teal: { label: "Бирюзовый", swatch: "#0F766E", star: "#0F766E" },
  emerald: { label: "Изумрудный", swatch: "#059669", star: "#059669" },
  blue: { label: "Синий", swatch: "#2563EB", star: "#2563EB" },
  indigo: { label: "Индиго", swatch: "#4F46E5", star: "#4F46E5" },
  slate: { label: "Серый", swatch: "#475569", star: "#475569" },
  stone: { label: "Каменный", swatch: "#78716C", star: "#78716C" },
};

export function isFactoryCatalogColorToken(
  value: string | null | undefined,
): value is FactoryCatalogColorToken {
  return (
    typeof value === "string" &&
    (FACTORY_CATALOG_COLOR_TOKENS as readonly string[]).includes(value)
  );
}

export function factoryCatalogStarColor(token: string | null | undefined): string {
  if (isFactoryCatalogColorToken(token)) {
    return FACTORY_CATALOG_COLOR_META[token].star;
  }
  return FACTORY_CATALOG_COLOR_META.slate.star;
}

export function factoryCatalogSwatchColor(token: string | null | undefined): string {
  if (isFactoryCatalogColorToken(token)) {
    return FACTORY_CATALOG_COLOR_META[token].swatch;
  }
  return FACTORY_CATALOG_COLOR_META.slate.swatch;
}
