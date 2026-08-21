"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import { formatPrice } from "@/lib/formatPrice";
import { listStaffCategories } from "@/lib/staff/products";
import {
  bulkUpdateProductPrices,
  getPricingGuardSettings,
  listProductPricingIds,
  listProductPricingOverview,
  updatePricingGuardSettings,
} from "@/lib/staff/pricing";
import type { PricingGuardSettings, ProductPricingOverviewRow } from "@/types/database";
import ProductQuantityTiersModal from "@/components/staff/ProductQuantityTiersModal";
import StaffBulkSetPricesModal from "@/components/staff/StaffBulkSetPricesModal";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass =
  `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

const btnPrimary =
  `rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 disabled:opacity-50 ${focusRing}`;

const btnSecondary =
  `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 ${focusRing}`;

const PRODUCT_PAGE_SIZE = 50;

function SettingsNav({ active }: { active: "org" | "users" | "pricing" | "data" }) {
  const tabClass = (isActive: boolean) =>
    isActive
      ? "rounded-md bg-[#0F766E]/10 px-3 py-1.5 text-sm font-medium text-[#0F766E]"
      : `rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`;

  return (
    <div className="mt-4 flex flex-wrap gap-2 border-b border-neutral-200 pb-3">
      {active === "org" ? (
        <span className={tabClass(true)}>Организация</span>
      ) : (
        <Link href="/staff/settings" className={tabClass(false)}>
          Организация
        </Link>
      )}
      {active === "users" ? (
        <span className={tabClass(true)}>Сотрудники</span>
      ) : (
        <Link href="/staff/settings/users" className={tabClass(false)}>
          Сотрудники
        </Link>
      )}
      {active === "pricing" ? (
        <span className={tabClass(true)}>Цены</span>
      ) : (
        <Link href="/staff/settings/pricing" className={tabClass(false)}>
          Цены
        </Link>
      )}
      {active === "data" ? (
        <span className={tabClass(true)}>Управление данными</span>
      ) : (
        <Link href="/staff/settings/data" className={tabClass(false)}>
          Управление данными
        </Link>
      )}
    </div>
  );
}

function formatTiersSummary(tiers: ProductPricingOverviewRow["quantity_tiers"]): string {
  if (tiers.length === 0) return "—";
  return tiers
    .map((tier) => `от ${tier.min_quantity} — ${formatPrice(tier.price)}`)
    .join(" · ");
}

export default function StaffPricingSettingsPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const isAdmin = profile?.role === "admin";

  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [productQuery, setProductQuery] = useState("");
  const [productCategoryId, setProductCategoryId] = useState("");
  const [products, setProducts] = useState<ProductPricingOverviewRow[]>([]);
  const [productOffset, setProductOffset] = useState(0);
  const [productHasMore, setProductHasMore] = useState(false);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsLoadingMore, setProductsLoadingMore] = useState(false);

  const [tiersModalProduct, setTiersModalProduct] = useState<ProductPricingOverviewRow | null>(null);
  const [editPriceProduct, setEditPriceProduct] = useState<ProductPricingOverviewRow | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [matchedIds, setMatchedIds] = useState<string[]>([]);
  const [matchedIdsLoading, setMatchedIdsLoading] = useState(false);
  const [bulkPricingModalOpen, setBulkPricingModalOpen] = useState(false);
  const [bulkPricingOk, setBulkPricingOk] = useState<string | null>(null);

  const [guardSettings, setGuardSettings] = useState<PricingGuardSettings | null>(null);
  const [guardLoading, setGuardLoading] = useState(true);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [guardDiscountInput, setGuardDiscountInput] = useState("");
  const [guardMarginInput, setGuardMarginInput] = useState("");
  const [guardSaving, setGuardSaving] = useState(false);
  const [guardSaveOk, setGuardSaveOk] = useState(false);

  useEffect(() => {
    if (profile && profile.role !== "admin") {
      router.replace("/staff");
    }
  }, [profile, router]);

  useEffect(() => {
    if (!isAdmin) return;
    listStaffCategories(false)
      .then((rows) => setCategories(rows.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCategories([]));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    queueMicrotask(() => {
      setGuardLoading(true);
      getPricingGuardSettings()
        .then((settings) => {
          setGuardSettings(settings);
          setGuardDiscountInput(
            settings.max_manager_discount_percent != null
              ? String(settings.max_manager_discount_percent)
              : "",
          );
          setGuardMarginInput(
            settings.min_margin_over_cost_percent != null
              ? String(settings.min_margin_over_cost_percent)
              : "",
          );
          setGuardError(null);
        })
        .catch((err: unknown) => {
          setGuardError(err instanceof Error ? err.message : "Не удалось загрузить настройки");
        })
        .finally(() => setGuardLoading(false));
    });
  }, [isAdmin]);

  async function handleSaveGuardSettings() {
    if (guardSaving) return;
    const discountTrimmed = guardDiscountInput.trim();
    const marginTrimmed = guardMarginInput.trim();
    const discount = discountTrimmed === "" ? null : Number(discountTrimmed);
    const margin = marginTrimmed === "" ? null : Number(marginTrimmed);

    if (discount != null && (!Number.isFinite(discount) || discount < 0 || discount > 100)) {
      setGuardError("Максимальная скидка менеджера должна быть от 0 до 100%");
      return;
    }
    if (margin != null && (!Number.isFinite(margin) || margin < 0)) {
      setGuardError("Минимальная наценка не может быть отрицательной");
      return;
    }

    setGuardSaving(true);
    setGuardError(null);
    setGuardSaveOk(false);
    try {
      const updated = await updatePricingGuardSettings({
        maxManagerDiscountPercent: discount,
        minMarginOverCostPercent: margin,
      });
      setGuardSettings(updated);
      setGuardSaveOk(true);
    } catch (err: unknown) {
      setGuardError(err instanceof Error ? err.message : "Не удалось сохранить настройки");
    } finally {
      setGuardSaving(false);
    }
  }

  const loadProducts = useCallback(
    async (append: boolean) => {
      const offset = append ? productOffset : 0;
      if (append) {
        setProductsLoadingMore(true);
      } else {
        setProductsLoading(true);
        setProductsError(null);
      }

      try {
        const rows = await listProductPricingOverview({
          query: productQuery,
          categoryId: productCategoryId || null,
          limit: PRODUCT_PAGE_SIZE,
          offset,
        });

        if (append) {
          setProducts((prev) => [...prev, ...rows]);
        } else {
          setProducts(rows);
        }
        setProductHasMore(rows.length === PRODUCT_PAGE_SIZE);
        setProductOffset(offset + rows.length);
      } catch (err: unknown) {
        setProductsError(err instanceof Error ? err.message : "Не удалось загрузить товары");
      } finally {
        setProductsLoading(false);
        setProductsLoadingMore(false);
      }
    },
    [productCategoryId, productOffset, productQuery],
  );

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(() => {
      setProductOffset(0);
      void loadProducts(false);
      setSelectedIds(new Set());
      setBulkPricingOk(null);

      setMatchedIdsLoading(true);
      listProductPricingIds({ query: productQuery, categoryId: productCategoryId || null })
        .then((ids) => setMatchedIds(ids))
        .catch(() => setMatchedIds([]))
        .finally(() => setMatchedIdsLoading(false));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, productQuery, productCategoryId]);

  function refreshCurrentPage() {
    setProductOffset(0);
    void loadProducts(false);
  }

  const allLoadedSelected = products.length > 0 && products.every((p) => selectedIds.has(p.product_id));
  const allMatchedSelected =
    matchedIds.length > 0 && matchedIds.every((id) => selectedIds.has(id));

  function toggleProductSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setBulkPricingOk(null);
  }

  function toggleSelectAllLoaded() {
    setSelectedIds((prev) => {
      if (products.length > 0 && products.every((p) => prev.has(p.product_id))) {
        return new Set();
      }
      return new Set(products.map((p) => p.product_id));
    });
    setBulkPricingOk(null);
  }

  function selectAllMatched() {
    setSelectedIds(new Set(matchedIds));
    setBulkPricingOk(null);
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  if (profile && !isAdmin) {
    return (
      <div className="py-16 text-center text-sm text-neutral-500">Перенаправление...</div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <h1 className="text-2xl font-bold text-neutral-800">Настройки</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Цена определяется так: розничная цена → скидка от количества / индивидуальная цена
        клиента (что выгоднее) → ручная цена менеджера в заказе.
      </p>

      <SettingsNav active="pricing" />

      {/* Retail prices + quantity tiers */}
      <section className="mt-8 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">Цены</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Розничная цена товара и скидки от количества. Индивидуальные цены конкретных
            клиентов настраиваются на карточке клиента. Отметьте товары ниже, чтобы изменить
            цены сразу у нескольких.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm text-neutral-600 sm:col-span-2">
            Поиск
            <input
              className={inputClass}
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              placeholder="SKU или название"
            />
          </label>
          <label className="block text-sm text-neutral-600">
            Категория
            <select
              className={inputClass}
              value={productCategoryId}
              onChange={(e) => setProductCategoryId(e.target.value)}
            >
              <option value="">Все категории</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {productsError && (
          <p className="text-sm text-red-600" role="alert">
            {productsError}
          </p>
        )}

        {!productsLoading && (
          <p className="text-xs text-neutral-500">
            {matchedIdsLoading
              ? "Подсчёт найденных товаров..."
              : `Найдено товаров: ${matchedIds.length}`}
          </p>
        )}

        {bulkPricingOk && (
          <p
            className="rounded-md border border-[#0F766E]/20 bg-[#0F766E]/5 px-4 py-3 text-sm text-[#0F766E]"
            role="status"
          >
            {bulkPricingOk}
          </p>
        )}

        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#0F766E]/30 bg-[#0F766E]/5 px-4 py-3">
            <p className="text-sm text-neutral-700">
              Выбрано: <span className="font-semibold">{selectedIds.size}</span> товаров
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={clearSelection}
                className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
              >
                Снять выбор
              </button>
              <button
                type="button"
                onClick={() => setBulkPricingModalOpen(true)}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
              >
                Изменить цены
              </button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-3 font-medium">
                    <input
                      type="checkbox"
                      className="accent-[#0F766E]"
                      checked={allLoadedSelected}
                      onChange={toggleSelectAllLoaded}
                      disabled={products.length === 0}
                      aria-label="Выбрать все на странице"
                      title="Выбрать все на странице"
                    />
                  </th>
                  <th className="min-w-[220px] px-3 py-3 font-medium">Товар</th>
                  <th className="min-w-[110px] px-3 py-3 font-medium">Розничная цена</th>
                  <th className="min-w-[260px] px-3 py-3 font-medium">Скидки от количества</th>
                  <th className="px-3 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {productsLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                      Загрузка...
                    </td>
                  </tr>
                ) : products.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                      Товары не найдены
                    </td>
                  </tr>
                ) : (
                  products.map((row) => (
                    <tr key={row.product_id} className="border-t border-neutral-100">
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          className="accent-[#0F766E]"
                          checked={selectedIds.has(row.product_id)}
                          onChange={() => toggleProductSelection(row.product_id)}
                          aria-label={`Выбрать ${row.sku}`}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <div className="font-medium text-neutral-800">{row.name}</div>
                        <div className="mt-0.5 font-mono text-xs text-neutral-400">
                          {row.sku}
                          {row.category_name ? ` · ${row.category_name}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-3 tabular-nums text-neutral-700">
                        {row.base_price != null ? formatPrice(row.base_price) : "—"}
                      </td>
                      <td className="px-3 py-3 text-neutral-600">
                        {formatTiersSummary(row.quantity_tiers)}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="flex flex-wrap justify-end gap-3">
                          <button
                            type="button"
                            className={`text-xs font-medium text-[#0F766E] hover:underline ${focusRing}`}
                            onClick={() => setEditPriceProduct(row)}
                          >
                            Изменить розничную цену
                          </button>
                          <button
                            type="button"
                            className={`text-xs font-medium text-[#0F766E] hover:underline ${focusRing}`}
                            onClick={() => setTiersModalProduct(row)}
                          >
                            Настроить количество
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {!productsLoading && products.length > 0 && matchedIds.length > products.length && (
          <p className="text-xs text-neutral-500">
            На экране {products.length} из {matchedIds.length} найденных.{" "}
            <button
              type="button"
              onClick={selectAllMatched}
              disabled={matchedIdsLoading}
              className={`font-medium text-[#0F766E] hover:underline disabled:opacity-50 ${focusRing}`}
            >
              {allMatchedSelected
                ? `Выбраны все ${matchedIds.length} найденных`
                : `Выбрать все ${matchedIds.length} найденных товаров`}
            </button>
          </p>
        )}

        {productHasMore && (
          <button
            type="button"
            className={btnSecondary}
            disabled={productsLoadingMore || productsLoading}
            onClick={() => void loadProducts(true)}
          >
            {productsLoadingMore ? "Загрузка..." : "Ещё"}
          </button>
        )}
      </section>

      {/* Pricing guard — manager discount / margin boundary (ТЗ §21–22) */}
      <section className="mt-12 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">Контроль цен менеджера</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Минимальная граница: ниже неё менеджер не может установить цену вручную — только
            администратор. Пустое поле = проверка отключена. Точная себестоимость менеджеру не
            показывается.
          </p>
        </div>

        {guardLoading ? (
          <p className="text-sm text-neutral-500">Загрузка...</p>
        ) : (
          <div className="max-w-xl rounded-lg border border-neutral-200 bg-white p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm text-neutral-600">
                Макс. скидка менеджера, %
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  className={inputClass}
                  value={guardDiscountInput}
                  onChange={(e) => setGuardDiscountInput(e.target.value)}
                  placeholder="не ограничено"
                  disabled={guardSaving}
                />
              </label>
              <label className="block text-sm text-neutral-600">
                Мин. наценка над себестоимостью, %
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  className={inputClass}
                  value={guardMarginInput}
                  onChange={(e) => setGuardMarginInput(e.target.value)}
                  placeholder="не ограничено"
                  disabled={guardSaving}
                />
              </label>
            </div>

            {guardSettings?.updated_at && (
              <p className="mt-3 text-xs text-neutral-400">
                Обновлено {new Date(guardSettings.updated_at).toLocaleString("ru-RU")}
              </p>
            )}

            {guardError && (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {guardError}
              </p>
            )}
            {guardSaveOk && (
              <p className="mt-3 text-sm text-[#0F766E]" role="status">
                Настройки сохранены
              </p>
            )}

            <div className="mt-4">
              <button
                type="button"
                className={btnPrimary}
                disabled={guardSaving}
                onClick={() => void handleSaveGuardSettings()}
              >
                {guardSaving ? "Сохранение..." : "Сохранить"}
              </button>
            </div>
          </div>
        )}
      </section>

      {editPriceProduct && (
        <RetailPriceModal
          product={editPriceProduct}
          onClose={() => setEditPriceProduct(null)}
          onSaved={() => {
            setEditPriceProduct(null);
            refreshCurrentPage();
          }}
        />
      )}

      {tiersModalProduct && (
        <ProductQuantityTiersModal
          productId={tiersModalProduct.product_id}
          productName={tiersModalProduct.name}
          basePrice={tiersModalProduct.base_price}
          onClose={() => {
            setTiersModalProduct(null);
            refreshCurrentPage();
          }}
        />
      )}

      {bulkPricingModalOpen && (
        <StaffBulkSetPricesModal
          productIds={[...selectedIds]}
          onClose={() => setBulkPricingModalOpen(false)}
          onApplied={(summary) => {
            setBulkPricingModalOpen(false);
            const parts: string[] = [];
            if (summary.base_price_changed) {
              parts.push(`Розничная цена: ${summary.updated_products}`);
            }
            if (summary.tiers_changed) {
              parts.push(`Уровни количества: ${summary.updated_products} товаров`);
            }
            setBulkPricingOk(
              `Цены обновлены для ${summary.updated_products} товаров` +
                (parts.length > 0 ? ` (${parts.join(" · ")})` : ""),
            );
            setSelectedIds(new Set());
            refreshCurrentPage();
          }}
        />
      )}
    </div>
  );
}

function RetailPriceModal({
  product,
  onClose,
  onSaved,
}: {
  product: ProductPricingOverviewRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [price, setPrice] = useState(product.base_price != null ? String(product.base_price) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    const trimmed = price.trim().replace(",", ".");
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }, [price]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (parsed == null || parsed < 0) {
      setError("Укажите неотрицательное число");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bulkUpdateProductPrices([product.product_id], {
        base: { action: "set", price: parsed },
      });
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить цену");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <form
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <h2 className="text-lg font-semibold text-neutral-800">Розничная цена</h2>
        <p className="mt-0.5 text-sm text-neutral-500">{product.name}</p>

        <label className="mt-4 block text-sm text-neutral-600">
          Цена *
          <input
            className={inputClass}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            required
            disabled={busy}
          />
        </label>

        {error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 ${focusRing}`}
          >
            Отмена
          </button>
          <button type="submit" disabled={busy} className={btnPrimary}>
            {busy ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}
