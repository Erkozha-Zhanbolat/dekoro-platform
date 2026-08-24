"use client";

import Link from "next/link";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import FactoryCatalogMarkers from "@/components/staff/FactoryCatalogMarkers";
import { downloadInventoryBalanceExcel } from "@/lib/staff/inventoryBalanceExcel";
import { getInventoryBalanceReport } from "@/lib/staff/inventoryBalanceApi";
import {
  filterInventoryBalanceProducts,
  inventoryBalanceBadges,
  sortInventoryBalanceProducts,
  summarizeFilteredProducts,
  type InventoryBalanceProduct,
  type InventoryBalanceReport,
  type InventoryBalanceSortKey,
  type InventoryBalanceStockState,
} from "@/lib/staff/inventoryBalance";
import {
  canAccessInventoryBalance,
  canExportInventoryBalance,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";
const inputClass = `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 50;

const STOCK_FILTERS: { value: InventoryBalanceStockState; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "in_stock", label: "В наличии" },
  { value: "out_of_stock", label: "Нет в наличии" },
  { value: "has_reserve", label: "Есть резерв" },
  { value: "incoming", label: "В пути" },
];

const SORT_KEYS = new Set<InventoryBalanceSortKey>([
  "sku",
  "name",
  "physical_qty",
  "reserved_qty",
  "available_qty",
  "incoming_qty",
  "expected_available_qty",
]);

function formatQty(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

function parseStock(value: string | null): InventoryBalanceStockState {
  if (
    value === "in_stock" ||
    value === "out_of_stock" ||
    value === "has_reserve" ||
    value === "incoming"
  ) {
    return value;
  }
  return "all";
}

function parseSort(value: string | null): InventoryBalanceSortKey | null {
  if (value && SORT_KEYS.has(value as InventoryBalanceSortKey)) {
    return value as InventoryBalanceSortKey;
  }
  return null;
}

function parseDir(value: string | null): "asc" | "desc" {
  return value === "desc" ? "desc" : "asc";
}

function parsePage(value: string | null): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.trunc(n);
}

function badgeClass(label: string): string {
  switch (label) {
    case "Нет в наличии":
      return "bg-red-50 text-red-700";
    case "Есть резерв":
      return "bg-amber-50 text-amber-800";
    case "В пути":
      return "bg-sky-50 text-sky-800";
    default:
      return "bg-emerald-50 text-emerald-800";
  }
}

export default function StaffInventoryBalancePage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-lg border border-neutral-200 bg-white py-12 text-center text-sm text-neutral-500">
          Загрузка остатков...
        </div>
      }
    >
      <StaffInventoryBalanceFromUrl />
    </Suspense>
  );
}

function StaffInventoryBalanceFromUrl() {
  const searchParams = useSearchParams();
  return <StaffInventoryBalanceContent searchParams={searchParams} />;
}

function StaffInventoryBalanceContent({
  searchParams,
}: {
  searchParams: ReturnType<typeof useSearchParams>;
}) {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canRead = canAccessInventoryBalance(profile?.role);
  const canExport = canExportInventoryBalance(profile?.role);

  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") ?? "");
  const [categoryId, setCategoryId] = useState(() => searchParams.get("category") ?? "");
  const [subcategoryId, setSubcategoryId] = useState(
    () => searchParams.get("subcategory") ?? "",
  );
  const [stockState, setStockState] = useState<InventoryBalanceStockState>(() =>
    parseStock(searchParams.get("stock")),
  );
  const [catalogId, setCatalogId] = useState(() => searchParams.get("catalog") ?? "all");
  const [sortKey, setSortKey] = useState<InventoryBalanceSortKey | null>(() =>
    parseSort(searchParams.get("sort")),
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() =>
    parseDir(searchParams.get("dir")),
  );
  const [page, setPage] = useState(() => parsePage(searchParams.get("page")));

  const [report, setReport] = useState<InventoryBalanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [openIncomingId, setOpenIncomingId] = useState<string | null>(null);

  useEffect(() => {
    if (!profileLoading && profile && !canRead) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, canRead, router]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (categoryId) params.set("category", categoryId);
    if (subcategoryId) params.set("subcategory", subcategoryId);
    if (stockState !== "all") params.set("stock", stockState);
    if (catalogId && catalogId !== "all") params.set("catalog", catalogId);
    if (sortKey) {
      params.set("sort", sortKey);
      if (sortDir === "desc") params.set("dir", "desc");
    }
    if (page > 1) params.set("page", String(page));

    const qs = params.toString();
    const next = qs ? `/staff/inventory?${qs}` : "/staff/inventory";
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== next) {
      router.replace(next);
    }
  }, [
    router,
    debouncedSearch,
    categoryId,
    subcategoryId,
    stockState,
    catalogId,
    sortKey,
    sortDir,
    page,
  ]);

  const reload = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      const next = await getInventoryBalanceReport();
      setReport(next);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить остатки");
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    const t = setTimeout(() => {
      void reload();
    }, 0);
    return () => clearTimeout(t);
  }, [canRead, reload]);

  const rootCategories = useMemo(() => {
    if (!report) return [];
    return report.categories
      .filter((c) => !c.parent_id)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  }, [report]);

  const subcategories = useMemo(() => {
    if (!report || !categoryId) return [];
    return report.categories
      .filter((c) => c.parent_id === categoryId)
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  }, [report, categoryId]);

  const filtered = useMemo(() => {
    if (!report) return [];
    const list = filterInventoryBalanceProducts(report.products, {
      search: debouncedSearch,
      categoryId: categoryId || undefined,
      subcategoryId: subcategoryId || undefined,
      stockState,
      catalogId,
    });
    return sortInventoryBalanceProducts(list, sortKey, sortDir);
  }, [
    report,
    debouncedSearch,
    categoryId,
    subcategoryId,
    stockState,
    catalogId,
    sortKey,
    sortDir,
  ]);

  const filteredSummary = useMemo(
    () => summarizeFilteredProducts(filtered),
    [filtered],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const pageSlice = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage]);

  function toggleSort(key: InventoryBalanceSortKey) {
    if (sortKey === key) {
      const nextDir = sortDir === "asc" ? "desc" : "asc";
      setSortDir(nextDir);
      setPage(1);
      return;
    }
    setSortKey(key);
    setSortDir(key === "sku" || key === "name" ? "asc" : "asc");
    setPage(1);
  }

  function sortMark(key: InventoryBalanceSortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  function handleExport() {
    if (!report || !canExport) return;
    try {
      const fileName = downloadInventoryBalanceExcel({
        report,
        products: filtered,
      });
      setExportNote(`Скачан файл ${fileName}`);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось выгрузить Excel");
    }
  }

  if (profileLoading || (!canRead && profile)) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Остатки</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Складская ведомость: физический остаток, резерв, доступно сейчас и в пути.
            {report ? ` Склад: ${report.warehouse.code}.` : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void reload()}
            className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
          >
            Обновить
          </button>
          {canExport ? (
            <button
              type="button"
              onClick={handleExport}
              disabled={!report || loading}
              className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0d6a63] disabled:opacity-50 ${focusRing}`}
            >
              Выгрузить Excel
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {exportNote ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {exportNote}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label="Всего SKU" value={formatQty(filteredSummary.total_sku)} />
        <Kpi label="В наличии" value={formatQty(filteredSummary.in_stock_sku)} />
        <Kpi label="Нет в наличии" value={formatQty(filteredSummary.out_of_stock_sku)} />
        <Kpi label="Зарезервировано" value={formatQty(filteredSummary.reserved_units)} hint="ед." />
        <Kpi label="В пути" value={formatQty(filteredSummary.incoming_units)} hint="ед." />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 bg-white p-4">
        <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-neutral-500">
          Поиск
          <input
            className={inputClass}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="SKU, original SKU, название"
          />
        </label>
        <label className="flex min-w-[160px] flex-col gap-1 text-xs text-neutral-500">
          Категория
          <select
            className={inputClass}
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setSubcategoryId("");
              setPage(1);
            }}
          >
            <option value="">Все</option>
            {rootCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[160px] flex-col gap-1 text-xs text-neutral-500">
          Подкатегория
          <select
            className={inputClass}
            value={subcategoryId}
            disabled={!categoryId || subcategories.length === 0}
            onChange={(e) => {
              setSubcategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Все</option>
            {subcategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[160px] flex-col gap-1 text-xs text-neutral-500">
          Состояние
          <select
            className={inputClass}
            value={stockState}
            onChange={(e) => {
              setStockState(e.target.value as InventoryBalanceStockState);
              setPage(1);
            }}
          >
            {STOCK_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-[180px] flex-col gap-1 text-xs text-neutral-500">
          Заводской каталог
          <select
            className={inputClass}
            value={catalogId}
            onChange={(e) => {
              setCatalogId(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">Все</option>
            <option value="none">Без каталога</option>
            {(report?.catalogs ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        {loading && !report ? (
          <TableSkeleton />
        ) : !report || report.products.length === 0 ? (
          <p className="py-12 text-center text-sm text-neutral-500">Товары не найдены</p>
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-neutral-500">
            По выбранным условиям товаров нет
          </p>
        ) : (
          <>
            <table className="min-w-[1100px] w-full border-collapse text-left text-sm">
              <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <ThButton onClick={() => toggleSort("sku")}>SKU{sortMark("sku")}</ThButton>
                  <ThButton onClick={() => toggleSort("name")}>Товар{sortMark("name")}</ThButton>
                  <th className="px-3 py-2 font-medium">Категория</th>
                  <th className="px-3 py-2 font-medium">Подкатегория</th>
                  <ThButton onClick={() => toggleSort("physical_qty")}>
                    Физический остаток{sortMark("physical_qty")}
                  </ThButton>
                  <ThButton onClick={() => toggleSort("reserved_qty")}>
                    Резерв{sortMark("reserved_qty")}
                  </ThButton>
                  <ThButton onClick={() => toggleSort("available_qty")}>
                    Доступно{sortMark("available_qty")}
                  </ThButton>
                  <ThButton onClick={() => toggleSort("incoming_qty")}>
                    В пути{sortMark("incoming_qty")}
                  </ThButton>
                  <ThButton onClick={() => toggleSort("expected_available_qty")}>
                    Ожидаемо доступно{sortMark("expected_available_qty")}
                  </ThButton>
                  <th className="px-3 py-2 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {pageSlice.map((product) => (
                  <ProductRow
                    key={product.product_id}
                    product={product}
                    open={openIncomingId === product.product_id}
                    onToggleIncoming={() =>
                      setOpenIncomingId((id) =>
                        id === product.product_id ? null : product.product_id,
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-100 px-4 py-3 text-sm text-neutral-600">
              <span>
                Показано {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, filtered.length)} из {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className={`rounded-md border border-neutral-200 px-2 py-1 disabled:opacity-40 ${focusRing}`}
                >
                  Назад
                </button>
                <span>
                  {safePage} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  className={`rounded-md border border-neutral-200 px-2 py-1 disabled:opacity-40 ${focusRing}`}
                >
                  Вперёд
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-neutral-800">{value}</p>
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

function ThButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <th className="px-3 py-2 font-medium">
      <button
        type="button"
        onClick={onClick}
        className={`text-left hover:text-neutral-800 ${focusRing}`}
      >
        {children}
      </button>
    </th>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded bg-neutral-100" />
      ))}
    </div>
  );
}

function ProductRow({
  product,
  open,
  onToggleIncoming,
}: {
  product: InventoryBalanceProduct;
  open: boolean;
  onToggleIncoming: () => void;
}) {
  const badges = inventoryBalanceBadges(product);
  const productHref = `/staff/products/${product.product_id}`;

  return (
    <>
      <tr className="border-t border-neutral-100 hover:bg-neutral-50/80">
        <td className="px-3 py-2 font-medium tabular-nums">
          <Link href={productHref} className="text-[#0F766E] hover:underline">
            {product.sku}
          </Link>
          <FactoryCatalogMarkers catalogs={product.catalogs} className="ml-1" />
        </td>
        <td className="px-3 py-2">
          <Link href={productHref} className="text-neutral-800 hover:underline">
            {product.name}
          </Link>
        </td>
        <td className="px-3 py-2 text-neutral-600">{product.category_name ?? "—"}</td>
        <td className="px-3 py-2 text-neutral-600">{product.subcategory_name ?? "—"}</td>
        <td className="px-3 py-2 tabular-nums">{formatQty(product.physical_qty)}</td>
        <td className="px-3 py-2 tabular-nums">{formatQty(product.reserved_qty)}</td>
        <td className="px-3 py-2 tabular-nums font-medium">{formatQty(product.available_qty)}</td>
        <td className="px-3 py-2 tabular-nums">
          {product.incoming_qty > 0 ? (
            <button
              type="button"
              onClick={onToggleIncoming}
              className={`font-medium text-sky-700 underline-offset-2 hover:underline ${focusRing}`}
              title="Расшифровка поставок в пути"
            >
              {formatQty(product.incoming_qty)}
            </button>
          ) : (
            formatQty(0)
          )}
        </td>
        <td className="px-3 py-2 tabular-nums font-medium text-neutral-900">
          {formatQty(product.expected_available_qty)}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {badges.map((b) => (
              <span
                key={b}
                className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${badgeClass(b)}`}
              >
                {b}
              </span>
            ))}
          </div>
        </td>
      </tr>
      {open && product.incoming_breakdown.length > 0 ? (
        <tr className="border-t border-sky-100 bg-sky-50/40">
          <td colSpan={10} className="px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-sky-800">
              В пути — расшифровка
            </p>
            <ul className="mt-2 space-y-1 text-sm text-neutral-700">
              {product.incoming_breakdown.map((line) => (
                <li key={`${line.supply_id}-${line.supply_number}`} className="flex flex-wrap gap-x-3">
                  <span className="font-medium">{line.supply_number}</span>
                  <span className="tabular-nums">{formatQty(line.quantity)} шт.</span>
                  <span className="text-neutral-500">{line.label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm font-medium text-neutral-800">
              Итого: {formatQty(product.incoming_qty)} шт.
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}
