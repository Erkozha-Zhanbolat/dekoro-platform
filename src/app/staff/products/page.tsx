"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import StaffBulkSetPricesModal from "@/components/staff/StaffBulkSetPricesModal";
import { StaffProductPhotoThumb } from "@/components/staff/StaffProductPhotoThumb";
import { formatPrice } from "@/lib/formatPrice";
import {
  archiveStaffCategory,
  createStaffCategory,
  listStaffCategories,
  listStaffProducts,
  updateStaffCategory,
  type StaffCategoryListItem,
  type StaffProductListItem,
} from "@/lib/staff/products";
import {
  STAFF_PRODUCT_STATUS_LABELS,
  canManageProducts,
  canReadProducts,
  type StaffProductStatus,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

const SEARCH_DEBOUNCE_MS = 300;
const LIST_LIMIT = 100;

function formatQty(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

export default function StaffProductsPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canRead = canReadProducts(profile?.role);
  const canManage = canManageProducts(profile?.role);
  const canBulkPrice = profile?.role === "admin";

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StaffProductStatus | "">("");
  const [products, setProducts] = useState<StaffProductListItem[]>([]);
  const [categories, setCategories] = useState<StaffCategoryListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [showCategories, setShowCategories] = useState(false);

  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkOk, setBulkOk] = useState<string | null>(null);

  useEffect(() => {
    if (!profileLoading && profile && !canRead) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, canRead, router]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const listKey = `${debouncedSearch}|${categoryFilter}|${statusFilter}`;

  useEffect(() => {
    if (!canRead) return;
    if (loadedKey === listKey) return;

    let ignore = false;

    Promise.all([
      listStaffProducts({
        query: debouncedSearch,
        categoryId: categoryFilter || null,
        status: statusFilter || null,
        limit: LIST_LIMIT,
      }),
      listStaffCategories(true),
    ])
      .then(([productRows, categoryRows]) => {
        if (ignore) return;
        setProducts(productRows);
        setCategories(categoryRows);
        setLoadError(null);
        setLoadedKey(listKey);
        setSelectedIds(new Set());
        setBulkOk(null);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить товары");
        setLoadedKey(listKey);
      });

    return () => {
      ignore = true;
    };
  }, [canRead, debouncedSearch, categoryFilter, statusFilter, listKey, loadedKey]);

  const allVisibleSelected =
    products.length > 0 && products.every((p) => selectedIds.has(p.id));

  function toggleProduct(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setBulkOk(null);
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      if (products.length > 0 && products.every((p) => prev.has(p.id))) {
        return new Set();
      }
      return new Set(products.map((p) => p.id));
    });
    setBulkOk(null);
  }

  function reloadProducts() {
    setLoadedKey(undefined);
  }

  const topCategories = useMemo(
    () => categories.filter((c) => c.parent_id === null),
    [categories],
  );

  const activeTopCategories = useMemo(
    () => topCategories.filter((c) => c.is_active),
    [topCategories],
  );

  const loading = loadedKey !== listKey;

  async function refreshCategories() {
    const rows = await listStaffCategories(true);
    setCategories(rows);
  }

  async function handleCreateCategory(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || categoryBusy) return;
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      await createStaffCategory({
        name: newCategoryName,
        parentId: newCategoryParentId || null,
      });
      setNewCategoryName("");
      setNewCategoryParentId("");
      await refreshCategories();
      setLoadedKey(undefined);
    } catch (error: unknown) {
      setCategoryError(error instanceof Error ? error.message : "Ошибка создания категории");
    } finally {
      setCategoryBusy(false);
    }
  }

  async function handleSaveCategoryName(category: StaffCategoryListItem) {
    if (!canManage || categoryBusy) return;
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      await updateStaffCategory({
        id: category.id,
        name: editingCategoryName,
        sortOrder: category.sort_order,
        parentId: category.parent_id,
      });
      setEditingCategoryId(null);
      await refreshCategories();
      setLoadedKey(undefined);
    } catch (error: unknown) {
      setCategoryError(error instanceof Error ? error.message : "Ошибка сохранения категории");
    } finally {
      setCategoryBusy(false);
    }
  }

  async function handleArchiveCategory(category: StaffCategoryListItem) {
    if (!canManage || categoryBusy) return;
    if (!window.confirm(`Архивировать категорию «${category.name}»?`)) return;
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      await archiveStaffCategory(category.id);
      await refreshCategories();
      setLoadedKey(undefined);
    } catch (error: unknown) {
      setCategoryError(error instanceof Error ? error.message : "Ошибка архивации");
    } finally {
      setCategoryBusy(false);
    }
  }

  if (profileLoading || (!canRead && profile)) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  if (!canRead) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Товары</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Каталог DEKORO — карточки, цены и остатки
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && (
            <>
              <button
                type="button"
                onClick={() => setShowCategories((v) => !v)}
                className={`rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
              >
                {showCategories ? "Скрыть категории" : "Категории"}
              </button>
              <Link
                href="/staff/products/new"
                className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
              >
                + Новый товар
              </Link>
            </>
          )}
        </div>
      </div>

      {showCategories && canManage && (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Категории
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Создать, изменить или архивировать. Удаление недоступно.
          </p>

          <form onSubmit={handleCreateCategory} className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex min-w-[200px] flex-1 flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Название
              </span>
              <input
                required
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                className={inputClass}
                placeholder="Новая категория"
              />
            </label>
            <label className="flex min-w-[200px] flex-1 flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Родитель (для подкатегории)
              </span>
              <select
                value={newCategoryParentId}
                onChange={(e) => setNewCategoryParentId(e.target.value)}
                className={inputClass}
              >
                <option value="">— верхний уровень —</option>
                {activeTopCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={categoryBusy}
              className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
            >
              Добавить
            </button>
          </form>

          {categoryError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {categoryError}
            </p>
          )}

          <ul className="mt-4 divide-y divide-neutral-100">
            {topCategories.map((cat) => {
              const children = categories.filter((c) => c.parent_id === cat.id);
              return (
                <li key={cat.id} className="py-3">
                  <CategoryRow
                    category={cat}
                    editing={editingCategoryId === cat.id}
                    editingName={editingCategoryName}
                    busy={categoryBusy}
                    onEdit={() => {
                      setEditingCategoryId(cat.id);
                      setEditingCategoryName(cat.name);
                    }}
                    onEditingNameChange={setEditingCategoryName}
                    onCancelEdit={() => setEditingCategoryId(null)}
                    onSave={() => handleSaveCategoryName(cat)}
                    onArchive={() => handleArchiveCategory(cat)}
                  />
                  {children.length > 0 && (
                    <ul className="mt-2 ml-6 space-y-2 border-l border-neutral-100 pl-4">
                      {children.map((sub) => (
                        <li key={sub.id}>
                          <CategoryRow
                            category={sub}
                            editing={editingCategoryId === sub.id}
                            editingName={editingCategoryName}
                            busy={categoryBusy}
                            onEdit={() => {
                              setEditingCategoryId(sub.id);
                              setEditingCategoryName(sub.name);
                            }}
                            onEditingNameChange={setEditingCategoryName}
                            onCancelEdit={() => setEditingCategoryId(null)}
                            onSave={() => handleSaveCategoryName(sub)}
                            onArchive={() => handleArchiveCategory(sub)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap gap-3">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Поиск по артикулу или названию"
          className={`${inputClass} w-full sm:max-w-md`}
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className={inputClass}
        >
          <option value="">Все категории</option>
          {activeTopCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StaffProductStatus | "")}
          className={inputClass}
        >
          <option value="">Все статусы</option>
          <option value="active">{STAFF_PRODUCT_STATUS_LABELS.active}</option>
          <option value="archived">{STAFF_PRODUCT_STATUS_LABELS.archived}</option>
        </select>
      </div>

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      )}

      {bulkOk && (
        <p className="rounded-md border border-[#0F766E]/20 bg-[#0F766E]/5 px-4 py-3 text-sm text-[#0F766E]" role="status">
          {bulkOk}
        </p>
      )}

      {canBulkPrice && selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#0F766E]/30 bg-[#0F766E]/5 px-4 py-3">
          <p className="text-sm text-neutral-700">
            Выбрано: <span className="font-semibold">{selectedIds.size}</span>
            {products.length > 0 ? (
              <span className="text-neutral-500"> (на экране: {products.length})</span>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 ${focusRing}`}
            >
              Снять выбор
            </button>
            <button
              type="button"
              onClick={() => setBulkModalOpen(true)}
              className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
            >
              Задать цены
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        {loading ? (
          <p className="px-5 py-6 text-sm text-neutral-500">Загрузка...</p>
        ) : products.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500">
            {debouncedSearch || categoryFilter || statusFilter
              ? "Товары не найдены"
              : "Товаров пока нет"}
          </p>
        ) : (
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                {canBulkPrice && (
                  <th className="px-4 py-3">
                    <label className="inline-flex items-center gap-2 font-medium normal-case tracking-normal text-neutral-600">
                      <input
                        type="checkbox"
                        className="accent-[#0F766E]"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        aria-label={`Выбрать все на странице (до ${LIST_LIMIT})`}
                        title={`Выбрать все на странице (до ${LIST_LIMIT})`}
                      />
                      <span className="hidden sm:inline">Стр.</span>
                    </label>
                  </th>
                )}
                <th className="px-4 py-3">Фото</th>
                <th className="px-4 py-3">Артикул</th>
                <th className="px-4 py-3">Название</th>
                <th className="px-4 py-3">Категория</th>
                <th className="px-4 py-3 text-right">Базовая</th>
                <th className="px-4 py-3 text-right">Остаток</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} className="border-b border-neutral-100 last:border-0">
                  {canBulkPrice && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        className="accent-[#0F766E]"
                        checked={selectedIds.has(product.id)}
                        onChange={() => toggleProduct(product.id)}
                        aria-label={`Выбрать ${product.sku}`}
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <StaffProductPhotoThumb
                      path={product.main_photo_path}
                      alt={product.name}
                      cacheBust={product.updated_at}
                      className="h-12 w-12 rounded-md"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-neutral-800">{product.sku}</td>
                  <td className="px-4 py-3 text-neutral-800">{product.name}</td>
                  <td className="px-4 py-3 text-neutral-600">
                    {product.category_name ?? "—"}
                    {product.subcategory_name ? (
                      <span className="text-neutral-400"> / {product.subcategory_name}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-700">
                    {product.base_price != null ? formatPrice(product.base_price) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-neutral-700">
                    {formatQty(product.available_quantity)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={product.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/products/${product.id}`}
                      className={`text-sm font-medium text-[#0F766E] hover:text-[#0c5f58] ${focusRing}`}
                    >
                      {canManage ? "Редактировать" : "Открыть"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canBulkPrice && !loading && products.length > 0 && (
        <p className="text-xs text-neutral-500">
          На странице: {products.length} из найденных (лимит {LIST_LIMIT}). Это не весь каталог.{" "}
          <button
            type="button"
            onClick={toggleSelectAllVisible}
            className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}
          >
            {allVisibleSelected
              ? "Снять выбор со страницы"
              : `Выбрать все на странице (до ${LIST_LIMIT})`}
          </button>
        </p>
      )}

      {bulkModalOpen && (
        <StaffBulkSetPricesModal
          productIds={[...selectedIds]}
          onClose={() => setBulkModalOpen(false)}
          onApplied={() => {
            setBulkModalOpen(false);
            setBulkOk(`Цены обновлены для ${selectedIds.size} товар(ов)`);
            setSelectedIds(new Set());
            reloadProducts();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
        Активен
      </span>
    );
  }
  if (status === "archived") {
    return (
      <span className="inline-flex rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
        Архив
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
      {status}
    </span>
  );
}

function CategoryRow({
  category,
  editing,
  editingName,
  busy,
  onEdit,
  onEditingNameChange,
  onCancelEdit,
  onSave,
  onArchive,
}: {
  category: StaffCategoryListItem;
  editing: boolean;
  editingName: string;
  busy: boolean;
  onEdit: () => void;
  onEditingNameChange: (value: string) => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {editing ? (
        <>
          <input
            value={editingName}
            onChange={(e) => onEditingNameChange(e.target.value)}
            className={`${inputClass} min-w-[180px] flex-1`}
          />
          <button
            type="button"
            disabled={busy}
            onClick={onSave}
            className={`text-sm font-medium text-[#0F766E] ${focusRing}`}
          >
            Сохранить
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancelEdit}
            className={`text-sm text-neutral-500 ${focusRing}`}
          >
            Отмена
          </button>
        </>
      ) : (
        <>
          <span className={`font-medium ${category.is_active ? "text-neutral-800" : "text-neutral-400"}`}>
            {category.name}
          </span>
          {!category.is_active && (
            <span className="text-xs text-neutral-400">архив</span>
          )}
          <span className="text-xs text-neutral-400">· {category.products_count} тов.</span>
          {category.is_active && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onEdit}
                className={`text-sm font-medium text-[#0F766E] ${focusRing}`}
              >
                Изменить
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onArchive}
                className={`text-sm text-neutral-500 hover:text-red-600 ${focusRing}`}
              >
                Архивировать
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
