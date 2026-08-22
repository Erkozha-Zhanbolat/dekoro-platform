"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { StaffProductPhotoThumb } from "@/components/staff/StaffProductPhotoThumb";
import FactoryCatalogMarkers from "@/components/staff/FactoryCatalogMarkers";
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
  listFactoryCatalogs,
  setProductFactoryCatalogs,
} from "@/lib/staff/factoryCatalogs";
import {
  adjustStaffProductInventory,
  getStaffProductInventory,
  listStaffProductInventoryAdjustments,
  listStaffProductStockReceipts,
  recordStaffStockReceipt,
  type StaffInventoryAdjustment,
  type StaffProductInventory,
  type StaffStockReceipt,
} from "@/lib/staff/productInventory";
import {
  INVENTORY_ADJUSTMENT_REASON_PRESETS,
  STAFF_PRODUCT_STATUS_LABELS,
  canManageProducts,
  canReadProducts,
  canRecordStockReceipt,
  canViewInventoryMovementHistory,
  canAccessProductSupplies,
  canManageFactoryCatalogs,
  type FactoryCatalog,
  type StaffProductStatus,
} from "@/types/database";
import { StaffProductAnalytics } from "@/components/staff/StaffProductAnalytics";
import StaffProductLandedCostHistory from "@/components/staff/StaffProductLandedCostHistory";

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
  const canReceipt = canRecordStockReceipt(profile?.role);
  const canViewMovements = canViewInventoryMovementHistory(profile?.role);
  const canSeeLandedCost = canAccessProductSupplies(profile?.role);
  const canAssignCatalogs = canManageFactoryCatalogs(profile?.role);

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

  const [inventory, setInventory] = useState<StaffProductInventory | null>(null);
  const [adjustments, setAdjustments] = useState<StaffInventoryAdjustment[]>([]);
  const [receipts, setReceipts] = useState<StaffStockReceipt[]>([]);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [newQuantity, setNewQuantity] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustInfo, setAdjustInfo] = useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptQty, setReceiptQty] = useState("");
  const [receiptDoc, setReceiptDoc] = useState("");
  const [receiptReason, setReceiptReason] = useState("");
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptInfo, setReceiptInfo] = useState<string | null>(null);
  const [factoryCatalogs, setFactoryCatalogs] = useState<FactoryCatalog[]>([]);
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<Set<string>>(new Set());
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogOk, setCatalogOk] = useState(false);

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
    setStatus(
      row.status === "archived" ? "archived" : row.status === "draft" ? "draft" : "active",
    );
    setBasePrice(toInputNumber(row.base_price));
    setMinOrderQty(toInputNumber(row.min_order_qty) || "1");
    setUnit(row.unit || "шт.");
    setLengthMm(toInputNumber(row.length_mm));
    setWidthMm(toInputNumber(row.width_mm));
    setThicknessMm(toInputNumber(row.thickness_mm));
    setWeightKg(toInputNumber(row.weight_kg));
    setSelectedCatalogIds(new Set((row.factory_catalogs ?? []).map((c) => c.id)));
  }

  useEffect(() => {
    if (!productId || !canRead) return;
    if (loadedKey === productId) return;

    let ignore = false;

    Promise.all([
      getStaffProduct(productId),
      listStaffCategories(true),
      getStaffProductInventory(productId),
      listFactoryCatalogs(false).catch(() => [] as FactoryCatalog[]),
      canViewMovements
        ? listStaffProductInventoryAdjustments(productId, 20)
        : Promise.resolve([] as StaffInventoryAdjustment[]),
      canViewMovements
        ? listStaffProductStockReceipts(productId, 20)
        : Promise.resolve([] as StaffStockReceipt[]),
    ])
      .then(([row, cats, inv, catalogRows, history, receiptHistory]) => {
        if (ignore) return;
        applyProduct(row);
        setCategories(cats);
        setInventory(inv);
        setFactoryCatalogs(catalogRows);
        setAdjustments(history);
        setReceipts(receiptHistory);
        setInventoryError(null);
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
  }, [productId, canRead, canViewMovements, loadedKey]);

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
      category_id: categoryId || null,
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

  async function refreshInventory() {
    if (!productId) return;
    const [inv, history, receiptHistory] = await Promise.all([
      getStaffProductInventory(productId),
      canViewMovements
        ? listStaffProductInventoryAdjustments(productId, 20)
        : Promise.resolve([] as StaffInventoryAdjustment[]),
      canViewMovements
        ? listStaffProductStockReceipts(productId, 20)
        : Promise.resolve([] as StaffStockReceipt[]),
    ]);
    setInventory(inv);
    setAdjustments(history);
    setReceipts(receiptHistory);
    setInventoryError(null);
  }

  async function handleAdjustInventory(event: React.FormEvent) {
    event.preventDefault();
    if (!product || !canManage || adjustBusy) return;

    const qty = Number(newQuantity.trim().replace(",", "."));
    if (!Number.isFinite(qty) || qty < 0) {
      setAdjustError("Фактический остаток должен быть числом ≥ 0");
      return;
    }
    if (!adjustReason.trim()) {
      setAdjustError("Укажите причину корректировки");
      return;
    }
    if (inventory && qty < inventory.reserved_quantity) {
      setAdjustError(
        `Фактический остаток не может быть меньше количества в резерве (${inventory.reserved_quantity})`,
      );
      return;
    }

    const confirmed = window.confirm(
      `Изменить фактический остаток на ${qty}?\nПричина: ${adjustReason.trim()}`,
    );
    if (!confirmed) return;

    setAdjustBusy(true);
    setAdjustError(null);
    setAdjustInfo(null);
    try {
      const result = await adjustStaffProductInventory({
        productId: product.id,
        newQuantity: qty,
        reason: adjustReason.trim(),
      });
      setInventory(result);
      if (!result.adjusted) {
        setAdjustInfo("Количество не изменилось — запись корректировки не создана.");
      } else {
        setAdjustInfo("Остаток обновлён.");
        setAdjustOpen(false);
        setNewQuantity("");
        setAdjustReason("");
      }
      const history = await listStaffProductInventoryAdjustments(product.id, 20);
      setAdjustments(history);
      const refreshed = await getStaffProduct(product.id);
      applyProduct(refreshed);
    } catch (error: unknown) {
      setAdjustError(error instanceof Error ? error.message : "Не удалось изменить остаток");
    } finally {
      setAdjustBusy(false);
    }
  }

  async function handleStockReceipt(event: React.FormEvent) {
    event.preventDefault();
    if (!product || !canReceipt || receiptBusy) return;

    const qty = Number(receiptQty.trim().replace(",", "."));
    if (!Number.isFinite(qty) || qty <= 0) {
      setReceiptError("Количество поступления должно быть больше 0");
      return;
    }

    const confirmed = window.confirm(
      `Оприходовать +${qty}?\n${receiptDoc.trim() ? `Документ: ${receiptDoc.trim()}\n` : ""}${
        receiptReason.trim() ? `Причина: ${receiptReason.trim()}` : ""
      }`.trim(),
    );
    if (!confirmed) return;

    setReceiptBusy(true);
    setReceiptError(null);
    setReceiptInfo(null);
    try {
      const result = await recordStaffStockReceipt({
        productId: product.id,
        quantity: qty,
        documentNumber: receiptDoc,
        reason: receiptReason,
      });
      setInventory({
        inventory_id: result.inventory_id,
        product_id: result.product_id,
        warehouse_id: result.warehouse_id,
        warehouse_code: result.warehouse_code,
        quantity: result.quantity,
        reserved_quantity: result.reserved_quantity,
        available_quantity: result.available_quantity,
      });
      setReceiptInfo(`Оприходовано +${result.received_quantity}.`);
      setReceiptOpen(false);
      setReceiptQty("");
      setReceiptDoc("");
      setReceiptReason("");
      const [history, receiptHistory] = await Promise.all([
        listStaffProductInventoryAdjustments(product.id, 20),
        listStaffProductStockReceipts(product.id, 20),
      ]);
      setAdjustments(history);
      setReceipts(receiptHistory);
      const refreshed = await getStaffProduct(product.id);
      applyProduct(refreshed);
    } catch (error: unknown) {
      setReceiptError(error instanceof Error ? error.message : "Не удалось оприходовать");
    } finally {
      setReceiptBusy(false);
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

      <h1 className="mt-4 text-2xl font-bold text-neutral-800">
        {product.name}{" "}
        <FactoryCatalogMarkers catalogs={product.factory_catalogs} className="ml-1" />
      </h1>
      <p className="mt-1 text-sm text-neutral-500">
        {product.sku}
        {inventory
          ? ` · доступно ${inventory.available_quantity} (ALMATY-01)`
          : ` · доступно ${product.available_quantity}`}
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
              cacheBust={product.updated_at}
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
                {status === "active" ? "Категория *" : "Категория"}
              </span>
              <select
                required={status === "active"}
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
            {status === "draft" ? (
              <p className="text-xs text-amber-700">
                Черновик не показывается в клиентском каталоге, пока статус не станет «Активен».
              </p>
            ) : null}
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

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Заводские каталоги
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            {canAssignCatalogs
              ? "Товар может быть сразу в нескольких книгах завода. Клиенты это не видят."
              : "Только просмотр. Назначает администратор."}
          </p>
          {factoryCatalogs.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-400">Каталоги ещё не созданы</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {factoryCatalogs.map((catalog) => (
                <li key={catalog.id}>
                  <label className="flex items-center gap-2 text-sm text-neutral-800">
                    <input
                      type="checkbox"
                      className="accent-[#0F766E]"
                      checked={selectedCatalogIds.has(catalog.id)}
                      disabled={!canAssignCatalogs || catalogBusy}
                      onChange={() => {
                        setSelectedCatalogIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(catalog.id)) next.delete(catalog.id);
                          else next.add(catalog.id);
                          return next;
                        });
                        setCatalogOk(false);
                      }}
                    />
                    <FactoryCatalogMarkers catalogs={[catalog]} />
                    <span>{catalog.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {catalogError ? (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {catalogError}
            </p>
          ) : null}
          {catalogOk ? (
            <p className="mt-2 text-sm text-[#0F766E]">Каталоги сохранены</p>
          ) : null}
          {canAssignCatalogs ? (
            <button
              type="button"
              disabled={catalogBusy}
              onClick={() => {
                setCatalogBusy(true);
                setCatalogError(null);
                setProductFactoryCatalogs(productId, [...selectedCatalogIds])
                  .then((next) => {
                    setProduct((prev) => (prev ? { ...prev, factory_catalogs: next } : prev));
                    setCatalogOk(true);
                  })
                  .catch((err: unknown) => {
                    setCatalogError(err instanceof Error ? err.message : "Не удалось сохранить каталоги");
                  })
                  .finally(() => setCatalogBusy(false));
              }}
              className={`mt-3 rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 ${focusRing}`}
            >
              {catalogBusy ? "Сохранение..." : "Сохранить каталоги"}
            </button>
          ) : null}
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

      <div className="mt-6">
        <StaffProductAnalytics productId={productId} />
      </div>

      {canSeeLandedCost ? <StaffProductLandedCostHistory productId={productId} /> : null}

      <section className="mt-6 flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Остаток — ALMATY-01
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Фактический остаток не может быть меньше количества в резерве.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <button
                type="button"
                onClick={() => {
                  setAdjustOpen((open) => !open);
                  setReceiptOpen(false);
                  setNewQuantity(inventory ? String(inventory.quantity) : "0");
                  setAdjustReason("");
                  setAdjustError(null);
                  setAdjustInfo(null);
                }}
                className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
              >
                {adjustOpen ? "Скрыть форму" : "Изменить остаток"}
              </button>
            )}
            {canReceipt && (
              <button
                type="button"
                onClick={() => {
                  setReceiptOpen((open) => !open);
                  setAdjustOpen(false);
                  setReceiptQty("");
                  setReceiptDoc("");
                  setReceiptReason("");
                  setReceiptError(null);
                  setReceiptInfo(null);
                }}
                className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
              >
                {receiptOpen ? "Скрыть поступление" : "Оприходовать"}
              </button>
            )}
          </div>
        </div>

        {inventoryError && (
          <p className="text-sm text-red-600" role="alert">
            {inventoryError}
          </p>
        )}

        {inventory ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">
                Фактический остаток
              </dt>
              <dd className="mt-1 text-lg font-semibold text-neutral-800">
                {inventory.quantity}
              </dd>
            </div>
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">
                В резерве
              </dt>
              <dd className="mt-1 text-lg font-semibold text-neutral-800">
                {inventory.reserved_quantity}
              </dd>
            </div>
            <div className="rounded-md bg-neutral-50 px-3 py-2">
              <dt className="text-xs uppercase tracking-wide text-neutral-400">
                Доступно
              </dt>
              <dd className="mt-1 text-lg font-semibold text-neutral-800">
                {inventory.available_quantity}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-neutral-500">Остаток не загружен</p>
        )}

        {canManage && adjustOpen && (
          <form
            onSubmit={handleAdjustInventory}
            className="flex flex-col gap-3 rounded-md border border-neutral-100 bg-neutral-50 p-4"
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Новое фактическое количество *
              </span>
              <input
                required
                inputMode="decimal"
                value={newQuantity}
                onChange={(e) => setNewQuantity(e.target.value)}
                className={inputClass}
                placeholder="115 или 115.5"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Причина *
              </span>
              <input
                required
                list="inventory-adjustment-reasons"
                maxLength={500}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                className={inputClass}
                placeholder="Например: Начальный остаток"
              />
              <datalist id="inventory-adjustment-reasons">
                {INVENTORY_ADJUSTMENT_REASON_PRESETS.map((reason) => (
                  <option key={reason} value={reason} />
                ))}
              </datalist>
            </label>
            <p className="text-xs text-neutral-500">
              Резерв ({inventory?.reserved_quantity ?? 0}) менять вручную нельзя.
              Отгрузки заказов продолжают списывать остаток через workflow.
            </p>
            {adjustError && (
              <p className="text-sm text-red-600" role="alert">
                {adjustError}
              </p>
            )}
            {adjustInfo && (
              <p className="text-sm text-emerald-700">{adjustInfo}</p>
            )}
            <button
              type="submit"
              disabled={adjustBusy}
              className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
            >
              {adjustBusy ? "Сохранение..." : "Подтвердить изменение"}
            </button>
          </form>
        )}

        {canReceipt && receiptOpen && (
          <form
            onSubmit={handleStockReceipt}
            className="flex flex-col gap-3 rounded-md border border-neutral-100 bg-neutral-50 p-4"
          >
            <p className="text-sm text-neutral-600">
              Поступление увеличивает фактический остаток. Это не корректировка
              (correction) — для исправлений используйте «Изменить остаток».
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Количество поступило *
              </span>
              <input
                required
                inputMode="decimal"
                value={receiptQty}
                onChange={(e) => setReceiptQty(e.target.value)}
                className={inputClass}
                placeholder="120"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Номер документа
              </span>
              <input
                maxLength={100}
                value={receiptDoc}
                onChange={(e) => setReceiptDoc(e.target.value)}
                className={inputClass}
                placeholder="Необязательно"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Причина / комментарий
              </span>
              <input
                maxLength={500}
                value={receiptReason}
                onChange={(e) => setReceiptReason(e.target.value)}
                className={inputClass}
                placeholder="Необязательно"
              />
            </label>
            {receiptError && (
              <p className="text-sm text-red-600" role="alert">
                {receiptError}
              </p>
            )}
            {receiptInfo && (
              <p className="text-sm text-emerald-700">{receiptInfo}</p>
            )}
            <button
              type="submit"
              disabled={receiptBusy}
              className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
            >
              {receiptBusy ? "Сохранение..." : "Оприходовать"}
            </button>
          </form>
        )}

        {canViewMovements && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            История поступлений
          </h3>
          {receipts.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">Пока нет поступлений</p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-100">
              {receipts.map((row) => (
                <li key={row.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-emerald-700">
                      +{row.quantity}
                      <span className="ml-2 font-normal text-neutral-500">
                        ({row.previous_quantity} → {row.new_quantity})
                      </span>
                    </span>
                    <span className="text-xs text-neutral-400">
                      {new Date(row.created_at).toLocaleString("ru-RU")}
                    </span>
                  </div>
                  {row.document_number ? (
                    <p className="text-neutral-600">Документ: {row.document_number}</p>
                  ) : null}
                  {row.reason ? <p className="text-neutral-600">{row.reason}</p> : null}
                  <p className="text-xs text-neutral-400">
                    {row.created_by_name ?? "Сотрудник"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        )}

        {canViewMovements && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            История корректировок
          </h3>
          {adjustments.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">Пока нет корректировок</p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-100">
              {adjustments.map((row) => (
                <li key={row.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-neutral-800">
                      {row.previous_quantity} → {row.new_quantity}
                      <span
                        className={
                          row.difference > 0
                            ? "ml-2 text-emerald-600"
                            : row.difference < 0
                              ? "ml-2 text-red-600"
                              : "ml-2 text-neutral-500"
                        }
                      >
                        ({row.difference > 0 ? "+" : ""}
                        {row.difference})
                      </span>
                    </span>
                    <span className="text-xs text-neutral-400">
                      {new Date(row.created_at).toLocaleString("ru-RU")}
                    </span>
                  </div>
                  <p className="text-neutral-600">{row.reason}</p>
                  <p className="text-xs text-neutral-400">
                    {row.created_by_name ?? "Сотрудник"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        )}
        {inventoryError === null && canRead && (
          <button
            type="button"
            onClick={() => {
              refreshInventory().catch((error: unknown) => {
                setInventoryError(
                  error instanceof Error ? error.message : "Ошибка обновления остатка",
                );
              });
            }}
            className={`self-start text-xs font-medium text-[#0F766E] ${focusRing}`}
          >
            Обновить остаток
          </button>
        )}
      </section>

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
