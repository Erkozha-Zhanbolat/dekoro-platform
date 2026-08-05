"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import {
  createStaffProduct,
  listStaffCategories,
  type StaffCategoryListItem,
  type StaffProductWriteInput,
} from "@/lib/staff/products";
import {
  STAFF_PRODUCT_STATUS_LABELS,
  canManageProducts,
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

export default function StaffNewProductPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canManage = canManageProducts(profile?.role);

  const [categories, setCategories] = useState<StaffCategoryListItem[]>([]);
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileLoading && profile && !canManage) {
      router.replace("/staff/products");
    }
  }, [profile, profileLoading, canManage, router]);

  useEffect(() => {
    if (!canManage) return;
    let ignore = false;
    listStaffCategories(false)
      .then((rows) => {
        if (!ignore) {
          setCategories(rows);
          setLoadError(null);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setLoadError(err instanceof Error ? err.message : "Не удалось загрузить категории");
        }
      });
    return () => {
      ignore = true;
    };
  }, [canManage]);

  const topCategories = useMemo(
    () => categories.filter((c) => c.parent_id === null && c.is_active),
    [categories],
  );

  const subcategories = useMemo(
    () =>
      categories.filter((c) => c.parent_id === categoryId && c.is_active),
    [categories, categoryId],
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !canManage) return;

    const price = parseOptionalNumber(basePrice);
    const minQty = parseOptionalNumber(minOrderQty);
    if (minQty == null || minQty <= 0) {
      setError("Минимальный заказ должен быть больше 0");
      return;
    }
    if (!categoryId) {
      setError("Выберите категорию");
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
    setError(null);
    try {
      const product = await createStaffProduct(input);
      router.push(`/staff/products/${product.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать товар");
      setSaving(false);
    }
  }

  if (profileLoading) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Недостаточно прав</h1>
        <p className="mt-4 text-neutral-600">Создавать товары может только администратор.</p>
        <Link
          href="/staff/products"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white ${focusRing}`}
        >
          К списку товаров
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/staff/products"
        className={`text-sm font-medium text-neutral-500 hover:text-[#0F766E] ${focusRing}`}
      >
        ← Назад
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-neutral-800">Новый товар</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Фото можно добавить после создания карточки
      </p>

      {loadError && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {loadError}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-6">
        <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Основная информация
          </h2>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Артикул *
            </span>
            <input required value={sku} onChange={(e) => setSku(e.target.value)} className={inputClass} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Название *
            </span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Категория *
              </span>
              <select
                required
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
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Подкатегория
              </span>
              <select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                className={inputClass}
                disabled={!categoryId || subcategories.length === 0}
              >
                <option value="">—</option>
                {subcategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Статус</span>
            <select
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
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                className={inputClass}
                inputMode="decimal"
                placeholder="0"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Мин. заказ *
              </span>
              <input
                required
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
              <input required value={unit} onChange={(e) => setUnit(e.target.value)} className={inputClass} />
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
              <input value={lengthMm} onChange={(e) => setLengthMm(e.target.value)} className={inputClass} inputMode="decimal" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Ширина, мм
              </span>
              <input value={widthMm} onChange={(e) => setWidthMm(e.target.value)} className={inputClass} inputMode="decimal" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Толщина, мм
              </span>
              <input value={thicknessMm} onChange={(e) => setThicknessMm(e.target.value)} className={inputClass} inputMode="decimal" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Вес, кг
              </span>
              <input value={weightKg} onChange={(e) => setWeightKg(e.target.value)} className={inputClass} inputMode="decimal" />
            </label>
          </div>
        </section>

        {error && (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
        >
          {saving ? "Создание..." : "Создать товар"}
        </button>
      </form>
    </div>
  );
}
