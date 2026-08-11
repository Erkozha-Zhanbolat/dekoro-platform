"use client";

import { FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import { formatPrice } from "@/lib/formatPrice";
import { listStaffCategories } from "@/lib/staff/products";
import {
  archivePriceGroup,
  batchUpsertProductGroupPrices,
  createPriceGroup,
  listAdminPriceGroups,
  listPricingMatrix,
  reorderPriceGroups,
  restorePriceGroup,
  setDefaultPriceGroup,
  updatePriceGroup,
} from "@/lib/staff/pricing";
import type { PriceGroup, PricingMatrixRow } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass =
  `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

const btnPrimary =
  `rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 disabled:opacity-50 ${focusRing}`;

const btnSecondary =
  `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 ${focusRing}`;

const MATRIX_PAGE_SIZE = 50;

type CellKey = `${string}:${string}`;

function cellKey(productId: string, groupId: string): CellKey {
  return `${productId}:${groupId}`;
}

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

export default function StaffPricingSettingsPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const isAdmin = profile?.role === "admin";

  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [priceGroups, setPriceGroups] = useState<PriceGroup[]>([]);
  const [groupBusy, setGroupBusy] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<PriceGroup | null>(null);

  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [matrixQuery, setMatrixQuery] = useState("");
  const [matrixCategoryId, setMatrixCategoryId] = useState("");
  const [matrixRows, setMatrixRows] = useState<PricingMatrixRow[]>([]);
  const [matrixOffset, setMatrixOffset] = useState(0);
  const [matrixHasMore, setMatrixHasMore] = useState(false);
  const [matrixLoading, setMatrixLoading] = useState(true);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [matrixLoadingMore, setMatrixLoadingMore] = useState(false);

  const [originalPrices, setOriginalPrices] = useState<Map<CellKey, number>>(new Map());
  const [edits, setEdits] = useState<Map<CellKey, string>>(new Map());
  /** Explicit reset markers — empty/Backspace alone must NOT delete overrides. */
  const [resetKeys, setResetKeys] = useState<Set<CellKey>>(new Set());
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const activeGroups = useMemo(
    () =>
      [...priceGroups]
        .filter((g) => g.is_active)
        .sort((a, b) => a.sort_order - b.sort_order),
    [priceGroups],
  );

  const sortedGroups = useMemo(
    () => [...priceGroups].sort((a, b) => a.sort_order - b.sort_order),
    [priceGroups],
  );

  const dirtyCount = useMemo(() => {
    let count = resetKeys.size;
    for (const [key, value] of edits) {
      if (resetKeys.has(key)) continue;
      const original = originalPrices.get(key);
      const trimmed = value.trim();
      if (trimmed === "") continue; // empty = keep, never auto-reset
      const num = Number(trimmed);
      if (Number.isFinite(num) && num !== original) count += 1;
    }
    return count;
  }, [edits, originalPrices, resetKeys]);

  useEffect(() => {
    if (profile && profile.role !== "admin") {
      router.replace("/staff");
    }
  }, [profile, router]);

  const reloadGroups = useCallback(async () => {
    setGroupsLoading(true);
    setGroupsError(null);
    try {
      const rows = await listAdminPriceGroups(true);
      setPriceGroups(rows);
    } catch (err: unknown) {
      setGroupsError(err instanceof Error ? err.message : "Не удалось загрузить группы");
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    queueMicrotask(() => {
      void reloadGroups();
    });
    listStaffCategories(false)
      .then((rows) => setCategories(rows.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCategories([]));
  }, [isAdmin, reloadGroups]);

  const loadMatrix = useCallback(
    async (append: boolean) => {
      const offset = append ? matrixOffset : 0;
      if (append) {
        setMatrixLoadingMore(true);
      } else {
        setMatrixLoading(true);
        setMatrixError(null);
      }

      try {
        const rows = await listPricingMatrix({
          query: matrixQuery,
          categoryId: matrixCategoryId || null,
          limit: MATRIX_PAGE_SIZE,
          offset,
        });

        setOriginalPrices((prev) => {
          const next = append ? new Map(prev) : new Map<CellKey, number>();
          for (const row of rows) {
            for (const [groupId, price] of Object.entries(row.group_prices)) {
              next.set(cellKey(row.product_id, groupId), price);
            }
          }
          return next;
        });

        if (append) {
          setMatrixRows((prev) => [...prev, ...rows]);
        } else {
          setMatrixRows(rows);
          setEdits(new Map());
          setResetKeys(new Set());
          setSaveOk(false);
        }
        setMatrixHasMore(rows.length === MATRIX_PAGE_SIZE);
        setMatrixOffset(offset + rows.length);
      } catch (err: unknown) {
        setMatrixError(err instanceof Error ? err.message : "Не удалось загрузить матрицу");
      } finally {
        setMatrixLoading(false);
        setMatrixLoadingMore(false);
      }
    },
    [matrixCategoryId, matrixOffset, matrixQuery],
  );

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(() => {
      setMatrixOffset(0);
      void loadMatrix(false);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, matrixQuery, matrixCategoryId]);

  async function runGroupAction(key: string, fn: () => Promise<void>) {
    if (groupBusy) return;
    setGroupBusy(key);
    setGroupsError(null);
    try {
      await fn();
      await reloadGroups();
    } catch (err: unknown) {
      setGroupsError(err instanceof Error ? err.message : "Операция не выполнена");
    } finally {
      setGroupBusy(null);
    }
  }

  async function moveGroup(id: string, direction: "up" | "down") {
    const sorted = [...priceGroups].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((g) => g.id === id);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const reordered = [...sorted];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    const items = reordered.map((g, i) => ({ id: g.id, sort_order: i }));

    await runGroupAction(`move-${id}`, async () => {
      await reorderPriceGroups(items);
    });
  }

  function getCellDisplay(row: PricingMatrixRow, groupId: string): string {
    const key = cellKey(row.product_id, groupId);
    if (resetKeys.has(key)) return "";
    if (edits.has(key)) return edits.get(key) ?? "";
    const explicit = row.group_prices[groupId];
    return explicit != null ? String(explicit) : "";
  }

  function setCellValue(productId: string, groupId: string, value: string) {
    const key = cellKey(productId, groupId);
    setResetKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setEdits((prev) => {
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
    setSaveOk(false);
  }

  function markCellReset(productId: string, groupId: string) {
    const key = cellKey(productId, groupId);
    setResetKeys((prev) => new Set(prev).add(key));
    setEdits((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    setSaveOk(false);
  }

  function cancelCellReset(productId: string, groupId: string) {
    const key = cellKey(productId, groupId);
    setResetKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setSaveOk(false);
  }

  function isCellDirty(productId: string, groupId: string): boolean {
    const key = cellKey(productId, groupId);
    if (resetKeys.has(key)) return true;
    if (!edits.has(key)) return false;
    const value = edits.get(key) ?? "";
    const original = originalPrices.get(key);
    const trimmed = value.trim();
    if (trimmed === "") return false; // empty = keep
    const num = Number(trimmed);
    return Number.isFinite(num) && num !== original;
  }

  async function handleSaveMatrix() {
    if (saveBusy || dirtyCount === 0) return;
    setSaveBusy(true);
    setSaveError(null);
    setSaveOk(false);

    const payload: Array<{ product_id: string; price_group_id: string; price: number | null }> =
      [];

    for (const key of resetKeys) {
      const [productId, groupId] = key.split(":");
      payload.push({
        product_id: productId,
        price_group_id: groupId,
        price: null,
      });
    }

    for (const [key, value] of edits) {
      if (resetKeys.has(key)) continue;
      const [productId, groupId] = key.split(":");
      const original = originalPrices.get(key);
      const trimmed = value.trim();

      // Empty field = keep current override (never accidental delete via Backspace).
      if (trimmed === "") continue;

      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) {
        setSaveError("Проверьте введённые цены — допустимы только неотрицательные числа");
        setSaveBusy(false);
        return;
      }
      if (num !== original) {
        payload.push({
          product_id: productId,
          price_group_id: groupId,
          price: num,
        });
      }
    }

    if (payload.length === 0) {
      setSaveBusy(false);
      return;
    }

    try {
      await batchUpsertProductGroupPrices(payload);
      setSaveOk(true);
      setMatrixOffset(0);
      await loadMatrix(false);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Не удалось сохранить цены");
    } finally {
      setSaveBusy(false);
    }
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
        Обычно три активные категории (например Розница / Опт / Дилер) + спеццены на карточке
        клиента. Массовое задание цен — на странице товаров.
      </p>

      <SettingsNav active="pricing" />

      {/* Price groups */}
      <section className="mt-8 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-800">Ценовые категории</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Переименование, порядок и группа по умолчанию. Нельзя архивировать default, пока не
              назначена другая.
            </p>
          </div>
          <button
            type="button"
            className={btnPrimary}
            disabled={!!groupBusy}
            onClick={() => setCreateOpen(true)}
          >
            Добавить группу
          </button>
        </div>

        {groupsError && (
          <p className="text-sm text-red-600" role="alert">
            {groupsError}
          </p>
        )}

        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Название</th>
                  <th className="px-4 py-3 font-medium">Код</th>
                  <th className="px-4 py-3 font-medium">Порядок</th>
                  <th className="px-4 py-3 font-medium">Статус</th>
                  <th className="px-4 py-3 font-medium">Действия</th>
                </tr>
              </thead>
              <tbody>
                {groupsLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                      Загрузка...
                    </td>
                  </tr>
                ) : sortedGroups.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                      Группы не найдены
                    </td>
                  </tr>
                ) : (
                  sortedGroups.map((group, index) => (
                    <tr key={group.id} className="border-t border-neutral-100">
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`font-medium ${
                              group.is_active ? "text-neutral-800" : "text-neutral-400"
                            }`}
                          >
                            {group.name}
                          </span>
                          {group.is_default && (
                            <span className="rounded bg-[#0F766E]/10 px-2 py-0.5 text-xs font-medium text-[#0F766E]">
                              По умолчанию
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-neutral-600">
                        {group.code || "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-neutral-600">
                        {group.sort_order}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                            group.is_active
                              ? "bg-[#0F766E]/10 text-[#0F766E]"
                              : "bg-neutral-200 text-neutral-600"
                          }`}
                        >
                          {group.is_active ? "Активна" : "Архив"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={!!groupBusy}
                            onClick={() => setEditGroup(group)}
                          >
                            Изменить
                          </button>
                          {!group.is_default && group.is_active && (
                            <button
                              type="button"
                              className={btnSecondary}
                              disabled={!!groupBusy}
                              onClick={() =>
                                void runGroupAction(`default-${group.id}`, async () => {
                                  await setDefaultPriceGroup(group.id);
                                })
                              }
                            >
                              По умолчанию
                            </button>
                          )}
                          {group.is_active ? (
                            <button
                              type="button"
                              className={`${btnSecondary} text-red-600 hover:border-red-300`}
                              disabled={!!groupBusy || group.is_default}
                              title={
                                group.is_default
                                  ? "Нельзя архивировать группу по умолчанию"
                                  : undefined
                              }
                              onClick={() =>
                                void runGroupAction(`archive-${group.id}`, async () => {
                                  await archivePriceGroup(group.id);
                                })
                              }
                            >
                              Архив
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={btnSecondary}
                              disabled={!!groupBusy}
                              onClick={() =>
                                void runGroupAction(`restore-${group.id}`, async () => {
                                  await restorePriceGroup(group.id);
                                })
                              }
                            >
                              Восстановить
                            </button>
                          )}
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={!!groupBusy || index === 0}
                            onClick={() => void moveGroup(group.id, "up")}
                            aria-label="Выше"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className={btnSecondary}
                            disabled={!!groupBusy || index === sortedGroups.length - 1}
                            onClick={() => void moveGroup(group.id, "down")}
                            aria-label="Ниже"
                          >
                            ↓
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
      </section>

      {/* Pricing matrix */}
      <section className="mt-12 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-neutral-800">Матрица цен</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Активные категории как колонки. Пустое поле = не менять. Сброс override — только
            кнопкой «Сбросить» (Backspace сам по себе ничего не удаляет). Массовый выбор товаров —
            /staff/products → «Задать цены».
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm text-neutral-600 sm:col-span-2">
            Поиск
            <input
              className={inputClass}
              value={matrixQuery}
              onChange={(e) => setMatrixQuery(e.target.value)}
              placeholder="SKU или название"
            />
          </label>
          <label className="block text-sm text-neutral-600">
            Категория
            <select
              className={inputClass}
              value={matrixCategoryId}
              onChange={(e) => setMatrixCategoryId(e.target.value)}
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

        {matrixError && (
          <p className="text-sm text-red-600" role="alert">
            {matrixError}
          </p>
        )}

        {dirtyCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-900">
              Несохранённых изменений: {dirtyCount}
            </p>
            <button
              type="button"
              className={btnPrimary}
              disabled={saveBusy}
              onClick={() => void handleSaveMatrix()}
            >
              {saveBusy ? "Сохранение..." : "Сохранить изменения"}
            </button>
          </div>
        )}

        {saveError && (
          <p className="text-sm text-red-600" role="alert">
            {saveError}
          </p>
        )}
        {saveOk && (
          <p className="text-sm text-[#0F766E]" role="status">
            Цены сохранены
          </p>
        )}

        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="min-w-[220px] px-3 py-3 font-medium">Товар</th>
                  <th className="min-w-[100px] px-3 py-3 font-medium">Базовая</th>
                  {activeGroups.map((group) => (
                    <th key={group.id} className="min-w-[120px] px-3 py-3 font-medium">
                      <div>{group.name}</div>
                      {group.code && (
                        <div className="mt-0.5 font-mono text-[10px] normal-case text-neutral-400">
                          {group.code}
                        </div>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixLoading ? (
                  <tr>
                    <td
                      colSpan={2 + activeGroups.length}
                      className="px-4 py-10 text-center text-neutral-500"
                    >
                      Загрузка...
                    </td>
                  </tr>
                ) : matrixRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={2 + activeGroups.length}
                      className="px-4 py-10 text-center text-neutral-500"
                    >
                      Товары не найдены
                    </td>
                  </tr>
                ) : (
                  matrixRows.map((row) => (
                    <tr key={row.product_id} className="border-t border-neutral-100">
                      <td className="px-3 py-2">
                        <div className="font-medium text-neutral-800">{row.name}</div>
                        <div className="mt-0.5 font-mono text-xs text-neutral-400">
                          {row.sku}
                          {row.category_name ? ` · ${row.category_name}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums text-neutral-700">
                        {row.base_price != null ? formatPrice(row.base_price) : "—"}
                      </td>
                      {activeGroups.map((group) => {
                        const key = cellKey(row.product_id, group.id);
                        const hasOriginal = originalPrices.has(key);
                        const markedReset = resetKeys.has(key);
                        const placeholder =
                          row.base_price != null
                            ? `= ${formatPrice(row.base_price)}`
                            : "базовая";
                        const dirty = isCellDirty(row.product_id, group.id);
                        return (
                          <td key={group.id} className="px-3 py-2 align-top">
                            {markedReset ? (
                              <div className="space-y-1">
                                <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                                  Сброс → базовая
                                </p>
                                <button
                                  type="button"
                                  className={`text-xs font-medium text-[#0F766E] ${focusRing}`}
                                  onClick={() => cancelCellReset(row.product_id, group.id)}
                                >
                                  Отменить сброс
                                </button>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  className={`w-full min-w-[100px] rounded-md border px-2 py-1.5 text-sm tabular-nums text-neutral-800 ${focusRing} ${
                                    dirty
                                      ? "border-amber-400 bg-amber-50"
                                      : "border-neutral-200 bg-white"
                                  }`}
                                  value={getCellDisplay(row, group.id)}
                                  placeholder={placeholder}
                                  onChange={(e) =>
                                    setCellValue(row.product_id, group.id, e.target.value)
                                  }
                                />
                                {hasOriginal && (
                                  <button
                                    type="button"
                                    className={`text-xs font-medium text-neutral-500 hover:text-red-600 ${focusRing}`}
                                    onClick={() => markCellReset(row.product_id, group.id)}
                                  >
                                    Сбросить
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {matrixHasMore && (
            <button
              type="button"
              className={btnSecondary}
              disabled={matrixLoadingMore || matrixLoading}
              onClick={() => void loadMatrix(true)}
            >
              {matrixLoadingMore ? "Загрузка..." : "Ещё"}
            </button>
          )}
          {dirtyCount > 0 && (
            <button
              type="button"
              className={btnPrimary}
              disabled={saveBusy}
              onClick={() => void handleSaveMatrix()}
            >
              {saveBusy ? "Сохранение..." : "Сохранить изменения"}
            </button>
          )}
        </div>
      </section>

      {createOpen && (
        <PriceGroupFormModal
          title="Новая ценовая группа"
          initial={{ name: "", code: "" }}
          busy={!!groupBusy}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (values) => {
            const maxOrder = Math.max(0, ...priceGroups.map((g) => g.sort_order));
            await runGroupAction("create", async () => {
              await createPriceGroup({
                name: values.name,
                code: values.code,
                sort_order: maxOrder + 1,
              });
              setCreateOpen(false);
            });
          }}
        />
      )}

      {editGroup && (
        <PriceGroupFormModal
          title="Редактирование группы"
          initial={{ name: editGroup.name, code: editGroup.code }}
          busy={!!groupBusy}
          onClose={() => setEditGroup(null)}
          onSubmit={async (values) => {
            await runGroupAction(`edit-${editGroup.id}`, async () => {
              await updatePriceGroup({
                id: editGroup.id,
                name: values.name,
                code: values.code,
              });
              setEditGroup(null);
            });
          }}
        />
      )}
    </div>
  );
}

function PriceGroupFormModal({
  title,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: { name: string; code: string };
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: { name: string; code: string }) => Promise<void>;
}) {
  const titleId = useId();
  const [name, setName] = useState(initial.name);
  const [code, setCode] = useState(initial.code);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const trimmedName = name.trim();
    const trimmedCode = code.trim();
    if (!trimmedName) {
      setError("Укажите название");
      return;
    }
    if (!trimmedCode) {
      setError("Укажите код");
      return;
    }
    setError(null);
    try {
      await onSubmit({ name: trimmedName, code: trimmedCode });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <h2 id={titleId} className="text-lg font-semibold text-neutral-800">
          {title}
        </h2>

        <label className="mt-4 block text-sm text-neutral-600">
          Название *
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <label className="mt-3 block text-sm text-neutral-600">
          Код *
          <input
            className={inputClass}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            disabled={busy}
            placeholder="например retail"
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
