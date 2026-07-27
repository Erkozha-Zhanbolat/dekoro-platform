// Centralized feature flags. Read once here instead of re-checking
// process.env.NEXT_PUBLIC_* in every file that needs to branch on them.

export const useSupabaseCatalog = process.env.NEXT_PUBLIC_USE_SUPABASE_CATALOG === "true";

// Favorites work independently of the catalog source:
// - useSupabaseCatalog=true  -> favorites are stored in public.favorites
//   (per signed-in user, via Supabase).
// - useSupabaseCatalog=false -> favorites are stored in localStorage on the
//   current browser (see src/lib/favorites.ts), so the feature is usable
//   with the current static 20-product catalog without any DB dependency.
export const useSupabaseFavorites = process.env.NEXT_PUBLIC_USE_SUPABASE_FAVORITES === "true";
