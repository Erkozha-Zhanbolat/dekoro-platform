"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ProductCard from "@/components/ProductCard";
import { useAuth } from "@/context/AuthContext";
import { trackEvent } from "@/lib/analytics/track";
import {
  CATALOG_PAGE_SIZE,
  getCatalogCategories,
  getCatalogPage,
  mapCatalogProductToProduct,
} from "@/lib/catalog";
import type { Product } from "@/types/product";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const SEARCH_DEBOUNCE_MS = 300;

function categoryButtonClass(isActive: boolean) {
  return `rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${focusRing} ${
    isActive
      ? "border-[#0F766E] bg-[#0F766E] text-white"
      : "border-neutral-200 text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
  }`;
}

function mergeUniqueProducts(current: Product[], incoming: Product[]): Product[] {
  if (incoming.length === 0) {
    return current;
  }
  const seen = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const product of incoming) {
    if (!seen.has(product.id)) {
      seen.add(product.id);
      next.push(product);
    }
  }
  return next;
}

export default function CatalogPage() {
  const { user, loading: authLoading } = useAuth();
  const currentUserId = user?.id ?? null;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [categoryNames, setCategoryNames] = useState<string[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const productsRef = useRef<Product[]>([]);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const requestIdRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyticsSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSearch = useRef<string>("");
  const lastCategory = useRef<string | null>(null);

  useEffect(() => {
    productsRef.current = products;
  }, [products]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  useEffect(() => {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }
    searchTimer.current = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
      }
    };
  }, [query]);

  useEffect(() => {
    const normalized = query.trim();
    if (analyticsSearchTimer.current) {
      clearTimeout(analyticsSearchTimer.current);
    }
    if (normalized.length < 2) {
      return;
    }
    analyticsSearchTimer.current = setTimeout(() => {
      if (lastSearch.current === normalized) return;
      lastSearch.current = normalized;
      trackEvent({
        event_type: "search",
        metadata: { query: normalized.slice(0, 200) },
      });
    }, 600);
    return () => {
      if (analyticsSearchTimer.current) {
        clearTimeout(analyticsSearchTimer.current);
      }
    };
  }, [query]);

  useEffect(() => {
    if (category === null) {
      lastCategory.current = null;
      return;
    }
    if (lastCategory.current === category) return;
    lastCategory.current = category;
    trackEvent({
      event_type: "category_open",
      metadata: { category_name: category },
    });
  }, [category]);

  useEffect(() => {
    let ignore = false;
    getCatalogCategories()
      .then((names) => {
        if (!ignore) {
          setCategoryNames(names);
        }
      })
      .catch(() => {
        if (!ignore) {
          setCategoryNames([]);
        }
      });
    return () => {
      ignore = true;
    };
  }, []);

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (authLoading) {
        return;
      }

      if (mode === "append") {
        if (loadingMoreRef.current || !hasMoreRef.current) {
          return;
        }
        loadingMoreRef.current = true;
        setLoadingMore(true);
      }

      const requestId = ++requestIdRef.current;
      if (mode === "replace") {
        offsetRef.current = 0;
        loadingMoreRef.current = false;
      }

      try {
        // Yield so replace-mode loading flags are not set synchronously inside effects.
        if (mode === "replace") {
          await Promise.resolve();
          if (requestId !== requestIdRef.current) {
            return;
          }
          setInitialLoading(true);
          setLoadingMore(false);
          setError(null);
        }

        const page = await getCatalogPage({
          limit: CATALOG_PAGE_SIZE,
          search: debouncedQuery || null,
          category,
          offset: mode === "append" ? offsetRef.current : 0,
        });

        if (requestId !== requestIdRef.current) {
          return;
        }

        const mapped = page.products.map(mapCatalogProductToProduct);
        setTotalCount(page.totalCount);

        let nextProducts: Product[];
        if (mode === "replace") {
          nextProducts = mapped;
        } else {
          nextProducts = mergeUniqueProducts(productsRef.current, mapped);
        }

        productsRef.current = nextProducts;
        setProducts(nextProducts);
        offsetRef.current = page.nextOffset;

        const nextHasMore = page.hasMore;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
      } catch (caughtError: unknown) {
        if (requestId !== requestIdRef.current) {
          return;
        }
        if (mode === "replace") {
          productsRef.current = [];
          setProducts([]);
          setTotalCount(0);
          offsetRef.current = 0;
          hasMoreRef.current = false;
          setHasMore(false);
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Не удалось загрузить каталог",
          );
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setInitialLoading(false);
          setLoadingMore(false);
          loadingMoreRef.current = false;
        }
      }
    },
    [authLoading, category, debouncedQuery],
  );

  // Server fetch when filters or auth identity change (sale_price personalization).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keyed catalog page fetch
    void loadPage("replace");
  }, [loadPage, currentUserId]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || initialLoading || error || !hasMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadPage("append");
        }
      },
      { root: null, rootMargin: "240px 0px", threshold: 0 },
    );

    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [error, hasMore, initialLoading, loadPage, products.length]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">Каталог</h1>
      <p className="mt-2 text-neutral-600">
        Каталог — здесь представлен ассортимент продукции DEKORO.
      </p>

      <div className="mt-6">
        <label htmlFor="catalog-search" className="sr-only">
          Поиск по названию и артикулу
        </label>
        <input
          id="catalog-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по названию и артикулу"
          className={`w-full max-w-xl rounded-md border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:bg-white focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setCategory(null)}
          className={categoryButtonClass(category === null)}
        >
          Все категории
        </button>
        {categoryNames.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setCategory(item)}
            className={categoryButtonClass(category === item)}
          >
            {item}
          </button>
        ))}
      </div>

      {initialLoading ? (
        <p className="mt-10 text-center text-neutral-500">Загрузка каталога...</p>
      ) : error ? (
        <p className="mt-10 text-center text-red-600">
          Не удалось загрузить каталог
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm text-neutral-500">
            Найдено товаров: {totalCount}
          </p>

          {products.length > 0 ? (
            <>
              <div className="mt-6 grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {products.map((product, index) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    imageLoading={index < 8 ? "eager" : "lazy"}
                  />
                ))}
              </div>

              <div ref={sentinelRef} className="h-8 w-full" aria-hidden />

              {loadingMore ? (
                <div className="mt-4 flex justify-center" role="status">
                  <div className="h-8 w-full max-w-md animate-pulse rounded-md bg-neutral-100" />
                </div>
              ) : null}

              {!hasMore && products.length > 0 ? (
                <p className="mt-4 text-center text-xs text-neutral-400">
                  Показаны все товары
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-10 text-center text-neutral-500">
              По вашему запросу ничего не найдено.
            </p>
          )}
        </>
      )}
    </div>
  );
}
