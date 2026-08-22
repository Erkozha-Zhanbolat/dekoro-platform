"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import StaffSettingsNav from "@/components/staff/StaffSettingsNav";
import {
  FACTORY_CATALOG_COLOR_META,
  FACTORY_CATALOG_COLOR_TOKENS,
  factoryCatalogSwatchColor,
} from "@/lib/staff/factoryCatalogColors";
import {
  archiveFactoryCatalog,
  createFactoryCatalog,
  listFactoryCatalogs,
  updateFactoryCatalog,
} from "@/lib/staff/factoryCatalogs";
import { canManageFactoryCatalogs } from "@/types/database";
import type { FactoryCatalog } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

export default function StaffFactoryCatalogsSettingsPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canManage = canManageFactoryCatalogs(profile?.role);

  const [rows, setRows] = useState<FactoryCatalog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [color, setColor] = useState("white");
  const [description, setDescription] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("slate");
  const [editDescription, setEditDescription] = useState("");

  useEffect(() => {
    if (!profileLoading && profile && !canManage) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, canManage, router]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listFactoryCatalogs(true);
      setRows(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить каталоги");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManage) return;
    const t = setTimeout(() => {
      void reload();
    }, 0);
    return () => clearTimeout(t);
  }, [canManage, reload]);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await createFactoryCatalog({
        name,
        color,
        description,
        sortOrder: rows.length,
      });
      setName("");
      setDescription("");
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать каталог");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(catalog: FactoryCatalog) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateFactoryCatalog({
        id: catalog.id,
        name: editName,
        color: editColor,
        description: editDescription,
        sortOrder: catalog.sort_order,
        isActive: catalog.is_active,
      });
      setEditingId(null);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(catalog: FactoryCatalog) {
    if (busy) return;
    if (!window.confirm(`Архивировать «${catalog.name}»? Товары сохранят связь.`)) return;
    setBusy(true);
    setError(null);
    try {
      await archiveFactoryCatalog(catalog.id);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось архивировать");
    } finally {
      setBusy(false);
    }
  }

  if (profileLoading || (!canManage && profile)) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-neutral-800">Настройки</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Заводские каталоги (книги). Клиенты их не видят.
      </p>
      <StaffSettingsNav active="catalogs" />

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Добавить каталог</h2>
        <form onSubmit={(e) => void handleCreate(e)} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-neutral-600 sm:col-span-2">
            Название
            <input
              required
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Белая книга"
            />
          </label>
          <label className="text-sm text-neutral-600">
            Цвет
            <select className={inputClass} value={color} onChange={(e) => setColor(e.target.value)}>
              {FACTORY_CATALOG_COLOR_TOKENS.map((token) => (
                <option key={token} value={token}>
                  {FACTORY_CATALOG_COLOR_META[token].label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <span
              className="mb-2 inline-block h-8 w-8 rounded-full border border-neutral-200"
              style={{ backgroundColor: factoryCatalogSwatchColor(color) }}
            />
          </div>
          <label className="text-sm text-neutral-600 sm:col-span-2">
            Описание (необязательно)
            <input
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
            >
              + Добавить каталог
            </button>
          </div>
        </form>
      </section>

      {error ? (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Каталоги</h2>
        {loading ? (
          <p className="mt-3 text-sm text-neutral-500">Загрузка...</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">Пока нет каталогов</p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-100">
            {rows.map((catalog) => (
              <li key={catalog.id} className="py-3">
                {editingId === catalog.id ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      className={inputClass}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                    <select
                      className={inputClass}
                      value={editColor}
                      onChange={(e) => setEditColor(e.target.value)}
                    >
                      {FACTORY_CATALOG_COLOR_TOKENS.map((token) => (
                        <option key={token} value={token}>
                          {FACTORY_CATALOG_COLOR_META[token].label}
                        </option>
                      ))}
                    </select>
                    <input
                      className={`${inputClass} sm:col-span-2`}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Описание"
                    />
                    <div className="flex gap-2 sm:col-span-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSave(catalog)}
                        className={`rounded-md bg-[#0F766E] px-3 py-1.5 text-sm font-medium text-white ${focusRing}`}
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className={`rounded-md border border-neutral-200 px-3 py-1.5 text-sm ${focusRing}`}
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span
                        className="h-4 w-4 rounded-full border border-neutral-200"
                        style={{ backgroundColor: factoryCatalogSwatchColor(catalog.color) }}
                      />
                      <div>
                        <p className="font-medium text-neutral-800">
                          {catalog.name}
                          {!catalog.is_active ? (
                            <span className="ml-2 text-xs font-normal text-neutral-400">архив</span>
                          ) : null}
                        </p>
                        <p className="text-xs text-neutral-500">
                          Товаров: {catalog.products_count}
                          {catalog.description ? ` · ${catalog.description}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(catalog.id);
                          setEditName(catalog.name);
                          setEditColor(catalog.color);
                          setEditDescription(catalog.description ?? "");
                        }}
                        className={`rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium ${focusRing}`}
                      >
                        Изменить
                      </button>
                      {catalog.is_active ? (
                        <button
                          type="button"
                          onClick={() => void handleArchive(catalog)}
                          className={`rounded-md border border-neutral-200 px-3 py-1.5 text-xs font-medium text-red-600 ${focusRing}`}
                        >
                          Архивировать
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
