"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { StaffProductPhotoThumb } from "@/components/staff/StaffProductPhotoThumb";
import {
  clearProductMainPhoto,
  copyProductMainPhoto,
  uploadProductMainPhoto,
  PRODUCT_MAIN_PHOTO_MAX_BYTES,
} from "@/lib/staff/productImages";
import {
  copyStaffProduct,
  getStaffProduct,
  listStaffCategories,
  updateStaffProduct,
  type StaffCategoryListItem,
  type StaffProductDetails,
  type StaffProductWriteInput,
} from "@/lib/staff/products";
import {
  STAFF_PRODUCT_STATUS_LABELS,
  canManageProducts,
  canReadProducts,
  type StaffProductStatus,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function toInputNumber(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

export default function StaffProductDetailPage() {
  const params = useParams();
  const productId = typeof params.id === "string" ? params.id : "";
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canRead = canReadProducts(profile?.role);
  const canManage = canManageProducts(profile?.role);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [product, setProduct] = useState<StaffProductDetails | null>(null);
  const [categories, setCategories] = useState<StaffCategoryListItem[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [status, setStatus] = useState<StaffProductStatus>("active");
  const [basePrice, setBasePrice] = useState("");
  const [minOrderQty, setMinOrderQty] = useState("1");
  const [unit, setUnit] = useState("шт.");
  const [lengthMm, setLengthMm] = useState("");
  const [widthMm, setWidthMm] = useState("");
  const [thicknessMm, setThicknessMm] = useState("");
  const [weightKg, setWeightKg] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [copyOpen, setCopyOpen] = useState(false);
  const [copySku, setCopySku] = useState("");
  const [copyName, setCopyName] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileLoading && profile && !canRead) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, canRead, router]);

  function applyProduct(row: StaffProductDetails) {
    setProduct(row);
    setSku(row.sku);
    setName(row.name);
    setCategoryId(row.category_id ?? "");
    setSubcategoryId(row.subcategory_id ?? "");
    setStatus(row.status === "archived" ? "archived" : "active");
    setBasePrice(toInputNumber(row.base_price));
    setMinOrderQty(toInputNumber(row.min_order_qty) || "1");
    setUnit(row.unit || "шт.");
    setLengthMm(toInputNumber(row.length_mm));
    setWidthMm(toInputNumber(row.width_mm));
    setThicknessMm(toInputNumber(row.thickness_mm));
    setWeightKg(toInputNumber(row.weight_kg));
  }

  useEffect(() => {
    if (!productId || !canRead) return;
    if (loadedKey === productId) return;

    let ignore = false;

    Promise.all([getStaffProduct(productId), listStaffCategories(true)])
      .then(([row, cats]) => {
        if (ignore) return;
        applyProduct(row);
        setCategories(cats);
        setLoadError(null);
        setLoadedKey(productId);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить товар");
        setProduct(null);
        setLoadedKey(productId);
      });

    return () => {
      ignore = true;
    };
  }, [productId, canRead, loadedKey]);

  const loading = loadedKey !== productId;

  const topCategories = useMemo(
    () => categories.filter((c) => c.parent_id === null && (c.is_active || c.id === categoryId)),
    [categories, categoryId],
  );

  const subcategories = useMemo(
    () =>
      categories.filter(
        (c) =>
          c.parent_id === categoryId && (c.is_active || c.id === subcategoryId),
      ),
    [categories, categoryId, subcategoryId],
  );

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!canManage || saving || !product) return;

    const price = parseOptionalNumber(basePrice);
    const minQty = parseOptionalNumber(minOrderQty);
    if (minQty == null || minQty <= 0) {
      setSaveError("Минимальный заказ должен быть больше 0");
      return;
    }
    if (!categoryId) {
      setSaveError("Выберите категорию");
      return;
    }

    const input: StaffProductWriteInput = {
      sku,
      name,
      category_id: categoryId,
      subcategory_id: subcategoryId || null,
      status,
      base_price: price,
      min_order_qty: minQty,
      unit: unit || "шт.",
      length_mm: parseOptionalNumber(lengthMm),
      width_mm: parseOptionalNumber(widthMm),
      thickness_mm: parseOptionalNumber(thicknessMm),
      weight_kg: parseOptionalNumber(weightKg),
    };

    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      const updated = await updateStaffProduct(product.id, input);
      applyProduct(updated);
      setSaveOk(true);
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoSelected(file: File | null) {
    if (!file || !product || !canManage || photoBusy) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const updated = await uploadProductMainPhoto(
        product.id,
        file,
        product.main_photo_path,
      );
      applyProduct(updated);
    } catch (error: unknown) {
      setPhotoError(error instanceof Error ? error.message : "Ошибка загрузки фото");
    } finally {
      setPhotoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleClearPhoto() {
    if (!product || !canManage || photoBusy) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const updated = await clearProductMainPhoto(product.id, product.main_photo_path);
      applyProduct(updated);
    } catch (error: unknown) {
      setPhotoError(error instanceof Error ? error.message : "Ошибка удаления фото");
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleCopy(event: React.FormEvent) {
    event.preventDefault();
    if (!product || !canManage || copyBusy) return;
    setCopyBusy(true);
    setCopyError(null);
    try {
      const copied = await copyStaffProduct({
        sourceId: product.id,
        sku: copySku,
        name: copyName,
      });
      if (copied.source_main_photo_path) {
        await copyProductMainPhoto({
          newProductId: copied.id,
          sourcePath: copied.source_main_photo_path,
        });
      }
      router.push(`/staff/products/${copied.id}`);
    } catch (error: unknown) {
      setCopyError(error instanceof Error ? error.message : "Не удалось скопировать");
      setCopyBusy(false);
    }
  }

  if (profileLoading || loading) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  if (!canRead) {
    return null;
  }

  if (loadError || !product) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <Link href="/staff/products" className={`text-sm text-neutral-500 ${focusRing}`}>
          ← К списку
        </Link>
        <p className="mt-4 text-red-600" role="alert">
          {loadError ?? "Товар не найден"}
        </p>
      </div>
    );
  }

  const readOnly = !canManage;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/staff/products"
          className={`text-sm font-medium text-neutral-500 hover:text-[#0F766E] ${focusRing}`}
        >
          ← Назад
        </Link>
        {canManage && (
          <button
            type="button"
            onClick={() => {
              setCopyOpen(true);
              setCopySku(`${product.sku}-COPY`);
              setCopyName(`${product.name} (копия)`);
              setCopyError(null);
            }}
            className={`rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
          >
            Копировать товар
          </button>
        )}
      </div>

      <h1 className="mt-4 text-2xl font-bold text-neutral-800">{product.name}</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {product.sku}
        {" · "}
        остаток {product.available_quantity}
        {readOnly ? " · только просмотр" : ""}
      </p>

      <form onSubmit={handleSave} className="mt-6 flex flex-col gap-6">
        <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Основная информация
          </h2>

          <div className="flex flex-wrap items-start gap-4">
            <StaffProductPhotoThumb
              path={product.main_photo_path}
              alt={product.name}
              className="h-28 w-28 rounded-md"
            />
            {canManage && (
              <div className="flex flex-col gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => handlePhotoSelected(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  disabled={photoBusy}
                  onClick={() => fileInputRef.current?.click()}
                  className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
                >
                  {product.main_photo_path ? "Заменить фото" : "Загрузить фото"}
                </button>
                {product.main_photo_path && (
                  <button
                    type="button"
                    disabled={photoBusy}
                    onClick={handleClearPhoto}
                    className={`text-sm text-neutral-500 hover:text-red-600 ${focusRing}`}
                  >
                    Убрать фото
                  </button>
                )}
                <p className="text-xs text-neutral-400">
                  PNG / JPEG / WEBP, до {(PRODUCT_MAIN_PHOTO_MAX_BYTES / (1024 * 1024)).toFixed(0)} МБ.
                  Только одно главное фото.
                </p>
                {photoError && (
                  <p className="text-sm text-red-600" role="alert">
                    {photoError}
                  </p>
                )}
              </div>
            )}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Артикул *
            </span>
            <input
              required
              disabled={readOnly}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Название *
            </span>
            <input
              required
              disabled={readOnly}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Категория *
              </span>
              <select
                required
                disabled={readOnly}
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setSubcategoryId("");
                }}
                className={inputClass}
              >
                <option value="">Выберите</option>
                {topCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {!c.is_active ? " (архив)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Подкатегория
              </span>
              <select
                disabled={readOnly || !categoryId}
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                className={inputClass}
              >
                <option value="">—</option>
                {subcategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {!c.is_active ? " (архив)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Статус</span>
            <select
              disabled={readOnly}
              value={status}
              onChange={(e) => setStatus(e.target.value as StaffProductStatus)}
              className={inputClass}
            >
              {(Object.keys(STAFF_PRODUCT_STATUS_LABELS) as StaffProductStatus[]).map((key) => (
                <option key={key} value={key}>
                  {STAFF_PRODUCT_STATUS_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Продажи</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Цена</span>
              <input
                disabled={readOnly}
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                className={inputClass}
                inputMode="decimal"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Мин. заказ *
              </span>
              <input
                required
                disabled={readOnly}
                value={minOrderQty}
                onChange={(e) => setMinOrderQty(e.target.value)}
                className={inputClass}
                inputMode="decimal"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Ед. изм. *
              </span>
              <input
                required
                disabled={readOnly}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Характеристики
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Длина, мм
              </span>
              <input
                disabled={readOnly}
                value={lengthMm}
                onChange={(e) => setLengthMm(e.target.value)}
                className={inputClass}
                inputMode="decimal"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Ширина, мм
              </span>
              <input
                disabled={readOnly}
                value={widthMm}
                onChange={(e) => setWidthMm(e.target.value)}
                className={inputClass}
                inputMode="decimal"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Толщина, мм
              </span>
              <input
                disabled={readOnly}
                value={thicknessMm}
                onChange={(e) => setThicknessMm(e.target.value)}
                className={inputClass}
                inputMode="decimal"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Вес, кг
              </span>
              <input
                disabled={readOnly}
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                className={inputClass}
                inputMode="decimal"
              />
            </label>
          </div>
        </section>

        {saveError && (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
            {saveError}
          </p>
        )}
        {saveOk && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            Сохранено
          </p>
        )}

        {canManage && (
          <button
            type="submit"
            disabled={saving}
            className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
        )}
      </form>

      {copyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold text-neutral-800">Копировать товар</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Копируются фото, категория, цена, единица, мин. заказ и характеристики.
              Укажите новый артикул и название. Статус копии — всегда «Активен».
            </p>
            <form onSubmit={handleCopy} className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Артикул *
                </span>
                <input
                  required
                  value={copySku}
                  onChange={(e) => setCopySku(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Название *
                </span>
                <input
                  required
                  value={copyName}
                  onChange={(e) => setCopyName(e.target.value)}
                  className={inputClass}
                />
              </label>
              {copyError && (
                <p className="text-sm text-red-600" role="alert">
                  {copyError}
                </p>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={copyBusy}
                  onClick={() => setCopyOpen(false)}
                  className={`rounded-md px-4 py-2 text-sm text-neutral-600 ${focusRing}`}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={copyBusy}
                  className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${focusRing}`}
                >
                  {copyBusy ? "Копирование..." : "Создать копию"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
