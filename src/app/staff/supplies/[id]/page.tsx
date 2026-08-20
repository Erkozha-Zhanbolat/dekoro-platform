"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { listStaffCategories, type StaffCategoryListItem } from "@/lib/staff/products";
import {
  addProductSupplyExpense,
  addProductSupplyItem,
  closeProductSupply,
  createDraftProductForSupply,
  deleteProductSupply,
  deleteProductSupplyExpense,
  deleteProductSupplyItem,
  formatSupplyKg,
  formatSupplyMoney,
  formatSupplyPct,
  formatSupplyRate,
  getProductSupply,
  getSupplyFxRate,
  parseSupplyNumber,
  searchProductsForSupply,
  updateProductSupply,
  updateProductSupplyItem,
  type ProductSupplyItem,
  type ProductSupplyPayload,
  type ProductSupplyProductSearch,
} from "@/lib/staff/supplies";
import {
  PRODUCT_SUPPLY_CURRENCIES,
  PRODUCT_SUPPLY_EXPENSE_PRESETS,
  PRODUCT_SUPPLY_STATUS_LABELS,
  STAFF_PRODUCT_STATUS_LABELS,
  canAccessProductSupplies,
  type ProductSupplyCurrency,
  type StaffProductStatus,
} from "@/types/database";
import SupplySectionNav, { type SupplyTabId } from "@/components/staff/supply/SupplySectionNav";
import SupplyDualStatus from "@/components/staff/supply/SupplyDualStatus";
import SupplyComparisonPanel from "@/components/staff/supply/SupplyComparisonPanel";
import SupplyDocumentsPanel from "@/components/staff/supply/SupplyDocumentsPanel";
import SupplyLogisticsPanel from "@/components/staff/supply/SupplyLogisticsPanel";
import SupplyFxRatesPanel from "@/components/staff/supply/SupplyFxRatesPanel";
import SupplyReceivingPanel from "@/components/staff/supply/SupplyReceivingPanel";
const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

const SEARCH_DEBOUNCE_MS = 300;

function toInput(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

export default function StaffSupplyDetailPage() {
  const params = useParams();
  const supplyId = typeof params.id === "string" ? params.id : "";
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const allowed = canAccessProductSupplies(profile?.role);

  const [payload, setPayload] = useState<ProductSupplyPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);

  const [title, setTitle] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplyDate, setSupplyDate] = useState("");
  const [currency, setCurrency] = useState<ProductSupplyCurrency>("CNY");
  const [gross, setGross] = useState("");
  const [notes, setNotes] = useState("");
  const [headerBusy, setHeaderBusy] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  const [itemDrafts, setItemDrafts] = useState<Record<string, ItemDraft>>({});
  const [itemBusyId, setItemBusyId] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);

  const [actionError, setActionError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<SupplyTabId>("overview");

  useEffect(() => {
    if (!profileLoading && profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, allowed, router]);

  function applyPayload(next: ProductSupplyPayload) {
    setPayload(next);
    const s = next.supply;
    setTitle(s.title);
    setSupplierName(s.supplier_name ?? "");
    setSupplyDate(s.supply_date);
    setCurrency(s.default_currency);
    setGross(toInput(s.gross_weight_kg));
    setNotes(s.notes ?? "");
    const drafts: Record<string, ItemDraft> = {};
    for (const item of next.items) {
      drafts[item.id] = itemToDraft(item);
    }
    setItemDrafts(drafts);
  }

  useEffect(() => {
    if (!allowed || !supplyId) return;
    if (loadedId === supplyId) return;

    let ignore = false;
    getProductSupply(supplyId)
      .then((data) => {
        if (ignore) return;
        applyPayload(data);
        setLoadError(null);
        setLoadedId(supplyId);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить поставку");
        setLoadedId(supplyId);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, supplyId, loadedId]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (loadedId !== supplyId) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  if (loadError || !payload) {
    return (
      <div className="flex flex-col gap-3">
        <Link href="/staff/supplies" className={`text-sm text-[#0F766E] hover:underline ${focusRing}`}>
          ← К поставкам
        </Link>
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError ?? "Поставка не найдена"}
        </p>
      </div>
    );
  }

  const { supply, items, expenses, totals } = payload;
  const readOnly = supply.status === "closed";
  const isPreliminary = supply.status === "draft";

  async function persistHeader() {
    if (readOnly || headerBusy) return;
    setHeaderBusy(true);
    setHeaderError(null);
    try {
      const next = await updateProductSupply(supply.id, {
        title,
        supplierName: supplierName.trim() || null,
        supplyDate,
        defaultCurrency: currency,
        defaultExchangeRateToKzt:
          currency === "KZT"
            ? 1
            : getSupplyFxRate(payload?.fx_rates ?? [], currency, {
                currency: supply.default_currency,
                rate: supply.default_exchange_rate_to_kzt,
              }),
        grossWeightKg: parseSupplyNumber(gross),
        notes: notes.trim() || null,
        clearSupplier: supplierName.trim() === "",
        clearNotes: notes.trim() === "",
        clearGrossWeight: parseSupplyNumber(gross) == null,
      });
      applyPayload(next);
    } catch (error: unknown) {
      setHeaderError(error instanceof Error ? error.message : "Не удалось сохранить шапку");
    } finally {
      setHeaderBusy(false);
    }
  }

  async function persistItem(itemId: string, override?: Partial<ItemDraft>) {
    if (readOnly) return;
    const draft = {
      ...(itemDrafts[itemId] ?? itemToDraft(items.find((row) => row.id === itemId)!)),
      ...override,
    };
    if (!draft) return;
    const qty = parseSupplyNumber(draft.quantity);
    if (qty == null || qty <= 0) {
      setItemError("Количество должно быть больше 0");
      return;
    }
    setItemBusyId(itemId);
    setItemError(null);
    try {
      const weight = parseSupplyNumber(draft.unit_net_weight_kg);
      const price = parseSupplyNumber(draft.purchase_price_per_unit);
      const next = await updateProductSupplyItem(itemId, {
        quantity: qty,
        unitNetWeightKg: weight,
        purchasePricePerUnit: price,
        purchaseCurrency: draft.purchase_currency,
        clearWeight: weight == null,
        clearPrice: price == null,
      });
      applyPayload(next);
    } catch (error: unknown) {
      setItemError(error instanceof Error ? error.message : "Не удалось сохранить позицию");
    } finally {
      setItemBusyId(null);
    }
  }

  function patchDraft(itemId: string, patch: Partial<ItemDraft>) {
    setItemDrafts((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] ?? itemToDraft(items.find((row) => row.id === itemId)!)),
        ...patch,
      },
    }));
  }

  async function handleDeleteItem(itemId: string) {
    if (readOnly) return;
    setItemBusyId(itemId);
    setItemError(null);
    try {
      applyPayload(await deleteProductSupplyItem(itemId));
    } catch (error: unknown) {
      setItemError(error instanceof Error ? error.message : "Не удалось удалить позицию");
    } finally {
      setItemBusyId(null);
    }
  }

  async function handleDeleteExpense(expenseId: string) {
    if (readOnly) return;
    setActionError(null);
    try {
      applyPayload(await deleteProductSupplyExpense(expenseId));
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "Не удалось удалить расход");
    }
  }

  async function handleClose() {
    if (readOnly || closing) return;
    setClosing(true);
    setActionError(null);
    try {
      applyPayload(await closeProductSupply(supply.id));
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "Не удалось закрыть поставку");
    } finally {
      setClosing(false);
    }
  }

  async function handleDeleteSupply() {
    if (readOnly || deleting) return;
    if (!window.confirm("Удалить черновик поставки?")) return;
    setDeleting(true);
    setActionError(null);
    try {
      await deleteProductSupply(supply.id);
      router.replace("/staff/supplies");
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : "Не удалось удалить поставку");
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/staff/supplies" className={`text-sm text-[#0F766E] hover:underline ${focusRing}`}>
            ← К поставкам
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-neutral-900">
            {supply.supply_number}
            <span className="ml-3 text-lg font-normal text-neutral-500">{supply.title}</span>
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {isPreliminary
              ? "Предварительная себестоимость — расчёт обновляется при каждом изменении."
              : "Закрытая поставка. Финансовый snapshot зафиксирован. Документы и логистика доступны."}
          </p>
          <div className="mt-3">
            <SupplyDualStatus
              logisticsStatus={supply.logistics_status}
              financialStatus={supply.status}
              receivingStatus={supply.receiving_status}
            />
          </div>
        </div>
        <span
          className={
            readOnly
              ? "rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600"
              : "rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700"
          }
        >
          {PRODUCT_SUPPLY_STATUS_LABELS[supply.status]}
        </span>
      </div>

      <SupplySectionNav
        active={tab}
        onChange={setTab}
        counts={{
          items: items.length,
          comparison: payload.comparison.length,
          receiving: payload.receiving?.items.length,
          expenses: expenses.length,
          documents: payload.documents.length,
          history: payload.logistics_history.length,
        }}
      />

      {tab === "overview" ? (
      <>
      <section className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
        <HeaderStat label="Поставщик" value={supply.supplier_name ?? "—"} />
        <HeaderStat
          label="Дата"
          value={new Date(`${supply.supply_date}T00:00:00`).toLocaleDateString("ru-RU")}
        />
        <HeaderStat label="Брутто" value={formatSupplyKg(totals.gross_weight_kg)} />
        <HeaderStat label="Расходы" value={formatSupplyMoney(totals.total_expenses_kzt)} />
        <HeaderStat label="Расход / кг" value={formatSupplyMoney(totals.expense_per_kg)} />
        <HeaderStat
          label={isPreliminary ? "Предв. себестоимость" : "Себестоимость"}
          value={formatSupplyMoney(totals.total_landed_cost_kzt)}
        />
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Шапка поставки</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Название</span>
            <input disabled={readOnly} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Поставщик</span>
            <input
              disabled={readOnly}
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Дата</span>
            <input
              type="date"
              disabled={readOnly}
              value={supplyDate}
              onChange={(e) => setSupplyDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Валюта закупки</span>
            <select
              disabled={readOnly}
              value={currency}
              onChange={(e) => setCurrency(e.target.value as ProductSupplyCurrency)}
              className={inputClass}
            >
              {PRODUCT_SUPPLY_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Фактический брутто-вес, кг
            </span>
            <input
              disabled={readOnly}
              value={gross}
              onChange={(e) => setGross(e.target.value)}
              className={inputClass}
              inputMode="decimal"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заметки</span>
          <textarea
            disabled={readOnly}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={`${inputClass} min-h-[72px]`}
          />
        </label>
        {headerError ? (
          <p className="text-sm text-red-600" role="alert">
            {headerError}
          </p>
        ) : null}
        {!readOnly ? (
          <button
            type="button"
            onClick={() => {
              void persistHeader();
            }}
            disabled={headerBusy}
            className={`self-start rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {headerBusy ? "Сохранение..." : "Сохранить шапку"}
          </button>
        ) : null}
      </section>

      <SupplyFxRatesPanel
        supply={supply}
        fxRates={payload.fx_rates}
        readOnly={readOnly}
        onUpdated={applyPayload}
      />

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Вес поставки</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <HeaderStat label="Чистый вес товаров" value={formatSupplyKg(totals.total_net_weight_kg)} />
          <HeaderStat label="Фактический брутто" value={formatSupplyKg(totals.gross_weight_kg)} />
          <HeaderStat label="Тара / паллеты" value={formatSupplyKg(totals.packaging_weight_kg)} />
          <HeaderStat label="Доля тары" value={formatSupplyPct(totals.packaging_weight_pct)} />
        </div>
        {totals.gross_lt_net ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
            Брутто-вес меньше чистого расчётного веса товаров. Закрыть поставку нельзя, пока веса не исправлены.
          </p>
        ) : null}
      </section>
      </>
      ) : null}

      {tab === "items" ? (
      <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Товары</h2>
          {!readOnly ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className={`rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
              >
                Добавить товар
              </button>
              <button
                type="button"
                onClick={() => setNewProductOpen(true)}
                className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
              >
                + Новый товар
              </button>
            </div>
          ) : null}
        </div>

        {itemError ? (
          <p className="text-sm text-red-600" role="alert">
            {itemError}
          </p>
        ) : null}

        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">Пока нет позиций</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-2 py-2 font-medium">Артикул</th>
                  <th className="px-2 py-2 font-medium">Наименование</th>
                  <th className="px-2 py-2 font-medium">Кол-во</th>
                  <th className="px-2 py-2 font-medium">Вес 1 шт</th>
                  <th className="px-2 py-2 font-medium">Чистый вес</th>
                  <th className="px-2 py-2 font-medium">Расч. gross</th>
                  <th className="px-2 py-2 font-medium">Цена пост.</th>
                  <th className="px-2 py-2 font-medium">Цена KZT</th>
                  <th className="px-2 py-2 font-medium">Расход / шт</th>
                  <th className="px-2 py-2 font-medium">Себест. / шт</th>
                  {!readOnly ? <th className="px-2 py-2 font-medium" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {items.map((item) => {
                  const draft = itemDrafts[item.id] ?? itemToDraft(item);
                  return (
                    <tr key={item.id} className="align-top">
                      <td className="px-2 py-2">
                        <Link
                          href={`/staff/products/${item.product_id}`}
                          className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}
                        >
                          {item.sku}
                        </Link>
                        {item.product_status === "draft" ? (
                          <p className="text-[11px] text-amber-700">не опубликован</p>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 text-neutral-800">
                        {item.name}
                        <p className="text-xs text-neutral-400">{item.unit}</p>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          disabled={readOnly}
                          value={draft.quantity}
                          onChange={(e) => patchDraft(item.id, { quantity: e.target.value })}
                          onBlur={() => void persistItem(item.id)}
                          className={`${inputClass} w-24`}
                          inputMode="decimal"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          disabled={readOnly}
                          value={draft.unit_net_weight_kg}
                          onChange={(e) => patchDraft(item.id, { unit_net_weight_kg: e.target.value })}
                          onBlur={() => void persistItem(item.id)}
                          className={`${inputClass} w-24`}
                          inputMode="decimal"
                        />
                      </td>
                      <td className="px-2 py-2 text-neutral-700">{formatSupplyKg(item.total_net_weight_kg)}</td>
                      <td className="px-2 py-2 text-neutral-700">
                        {formatSupplyKg(item.gross_weight_per_unit_kg, true)}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex min-w-[160px] flex-col gap-1">
                          <input
                            disabled={readOnly}
                            value={draft.purchase_price_per_unit}
                            onChange={(e) =>
                              patchDraft(item.id, { purchase_price_per_unit: e.target.value })
                            }
                            onBlur={() => void persistItem(item.id)}
                            className={inputClass}
                            inputMode="decimal"
                          />
                          <select
                            disabled={readOnly}
                            value={draft.purchase_currency}
                            onChange={(e) => {
                              const nextCurrency = e.target.value as ProductSupplyCurrency;
                              patchDraft(item.id, { purchase_currency: nextCurrency });
                              void persistItem(item.id, { purchase_currency: nextCurrency });
                            }}
                            className={inputClass}
                          >
                            {PRODUCT_SUPPLY_CURRENCIES.map((code) => (
                              <option key={code} value={code}>
                                {code}
                              </option>
                            ))}
                          </select>
                          {draft.purchase_currency !== "KZT" ? (
                            <p className="text-[11px] text-neutral-500">
                              {(() => {
                                const supplyRate = getSupplyFxRate(
                                  payload.fx_rates,
                                  draft.purchase_currency,
                                  {
                                    currency: supply.default_currency,
                                    rate: supply.default_exchange_rate_to_kzt,
                                  },
                                );
                                return supplyRate == null
                                  ? `Курс ${draft.purchase_currency} не задан`
                                  : `курс поставки ${formatSupplyRate(supplyRate)}`;
                              })()}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-neutral-700">
                        {formatSupplyMoney(item.purchase_price_per_unit_kzt)}
                      </td>
                      <td className="px-2 py-2 text-neutral-700">
                        {formatSupplyMoney(item.expense_per_unit_kzt)}
                      </td>
                      <td className="px-2 py-2 font-medium text-neutral-800">
                        {formatSupplyMoney(item.landed_cost_per_unit_kzt)}
                        {itemBusyId === item.id ? (
                          <p className="text-[11px] font-normal text-neutral-400">сохранение...</p>
                        ) : null}
                      </td>
                      {!readOnly ? (
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            onClick={() => void handleDeleteItem(item.id)}
                            className={`text-xs text-red-600 hover:underline ${focusRing}`}
                          >
                            Удалить
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {tab === "comparison" ? (
        <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Заказ / Отгрузка</h2>
          <p className="text-xs text-neutral-500">
            Заказанные значения не затираются. После подтверждения накладной фактические количества и цены
            становятся основой расчёта себестоимости Stage 38.
          </p>
          <SupplyComparisonPanel rows={payload.comparison} />
        </section>
      ) : null}

      {tab === "receiving" ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <SupplyReceivingPanel
            supply={supply}
            receiving={payload.receiving}
            onUpdated={applyPayload}
          />
        </section>
      ) : null}

      {tab === "expenses" ? (
      <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Расходы поставки</h2>
          {!readOnly ? (
            <button
              type="button"
              onClick={() => setExpenseOpen(true)}
              className={`rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
            >
              + Добавить расход
            </button>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500">
          Только расходы этой поставки (таможня, логистика, брокер). Операционные расходы бизнеса сюда не входят.
        </p>
        {expenses.length === 0 ? (
          <p className="text-sm text-neutral-500">Расходов пока нет</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Статья</th>
                  <th className="px-3 py-2 font-medium">Сумма</th>
                  <th className="px-3 py-2 font-medium">Валюта</th>
                  <th className="px-3 py-2 font-medium">Курс</th>
                  <th className="px-3 py-2 font-medium">Сумма KZT</th>
                  <th className="px-3 py-2 font-medium">Документы</th>
                  {!readOnly ? <th className="px-3 py-2 font-medium" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {expenses.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 text-neutral-800">
                      {row.name}
                      {row.expense_date ? (
                        <p className="text-xs text-neutral-400">
                          {new Date(`${row.expense_date}T00:00:00`).toLocaleDateString("ru-RU")}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{formatSupplyRate(row.amount)}</td>
                    <td className="px-3 py-2">{row.currency}</td>
                    <td className="px-3 py-2">
                      {formatSupplyRate(row.exchange_rate_to_kzt)}
                      {row.use_custom_exchange_rate ? (
                        <span className="mt-0.5 block text-[11px] text-amber-700">свой курс</span>
                      ) : row.currency !== "KZT" ? (
                        <span className="mt-0.5 block text-[11px] text-neutral-400">курс поставки</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-medium">{formatSupplyMoney(row.amount_kzt)}</td>
                    <td className="px-3 py-2 text-xs text-neutral-600">
                      {row.linked_documents.length === 0
                        ? "—"
                        : row.linked_documents.map((doc) => doc.original_filename).join(", ")}
                    </td>
                    {!readOnly ? (
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => void handleDeleteExpense(row.id)}
                          className={`text-xs text-red-600 hover:underline ${focusRing}`}
                        >
                          Удалить
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {tab === "documents" ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Документы</h2>
          <SupplyDocumentsPanel payload={payload} onUpdated={applyPayload} />
        </section>
      ) : null}

      {tab === "history" ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">История логистики</h2>
          <SupplyLogisticsPanel
            supplyId={supply.id}
            current={supply.logistics_status}
            history={payload.logistics_history}
            onUpdated={applyPayload}
          />
        </section>
      ) : null}

      {tab === "overview" ? (
      <>
      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Итоги</h2>
        <dl className="grid gap-2 sm:grid-cols-2">
          <TotalsRow label="Закупочная стоимость" value={formatSupplyMoney(totals.total_purchase_kzt)} />
          <TotalsRow label="Дополнительные расходы" value={formatSupplyMoney(totals.total_expenses_kzt)} />
          <TotalsRow label="Общий gross" value={formatSupplyKg(totals.gross_weight_kg)} />
          <TotalsRow label="Расход / кг" value={formatSupplyMoney(totals.expense_per_kg)} />
          <TotalsRow
            label={isPreliminary ? "Предварительная себестоимость поставки" : "Итоговая себестоимость поставки"}
            value={formatSupplyMoney(totals.total_landed_cost_kzt)}
            emphasize
          />
        </dl>
      </section>

      {actionError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {actionError}
        </p>
      ) : null}

      {!readOnly ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={closing}
            className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {closing ? "Закрытие..." : "Закрыть поставку"}
          </button>
          <button
            type="button"
            onClick={() => void handleDeleteSupply()}
            disabled={deleting}
            className={`rounded-md border border-red-200 px-5 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 ${focusRing}`}
          >
            {deleting ? "Удаление..." : "Удалить черновик"}
          </button>
        </div>
      ) : null}
      </>
      ) : null}

      {addOpen ? (
        <AddProductModal
          supplyId={supply.id}
          defaultCurrency={supply.default_currency}
          defaultRate={supply.default_exchange_rate_to_kzt}
          onClose={() => setAddOpen(false)}
          onAdded={(next) => {
            applyPayload(next);
            setAddOpen(false);
          }}
        />
      ) : null}

      {newProductOpen ? (
        <NewProductModal
          supplyId={supply.id}
          defaultCurrency={supply.default_currency}
          defaultRate={supply.default_exchange_rate_to_kzt}
          onClose={() => setNewProductOpen(false)}
          onAdded={(next) => {
            applyPayload(next);
            setNewProductOpen(false);
          }}
        />
      ) : null}

      {expenseOpen ? (
        <AddExpenseModal
          supplyId={supply.id}
          supplyRateFor={(code) =>
            getSupplyFxRate(payload.fx_rates, code, {
              currency: supply.default_currency,
              rate: supply.default_exchange_rate_to_kzt,
            })
          }
          onClose={() => setExpenseOpen(false)}
          onAdded={(next) => {
            applyPayload(next);
            setExpenseOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

type ItemDraft = {
  quantity: string;
  unit_net_weight_kg: string;
  purchase_price_per_unit: string;
  purchase_currency: ProductSupplyCurrency;
  exchange_rate_to_kzt: string;
};

function itemToDraft(item: ProductSupplyItem): ItemDraft {
  return {
    quantity: toInput(item.quantity),
    unit_net_weight_kg: toInput(item.unit_net_weight_kg),
    purchase_price_per_unit: toInput(item.purchase_price_per_unit),
    purchase_currency: item.purchase_currency,
    exchange_rate_to_kzt: toInput(item.exchange_rate_to_kzt),
  };
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-1 text-sm font-medium text-neutral-800">{value}</p>
    </div>
  );
}

function TotalsRow({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-neutral-100 py-2">
      <dt className="text-sm text-neutral-500">{label}</dt>
      <dd className={emphasize ? "text-base font-semibold text-neutral-900" : "text-sm font-medium text-neutral-800"}>
        {value}
      </dd>
    </div>
  );
}

function AddProductModal({
  supplyId,
  defaultCurrency,
  defaultRate,
  onClose,
  onAdded,
}: {
  supplyId: string;
  defaultCurrency: ProductSupplyCurrency;
  defaultRate: number | null;
  onClose: () => void;
  onAdded: (payload: ProductSupplyPayload) => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<ProductSupplyProductSearch[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProductSupplyProductSearch | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [weight, setWeight] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<ProductSupplyCurrency>(defaultCurrency);
  const [rate, setRate] = useState(toInput(defaultRate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    let ignore = false;
    searchProductsForSupply(debounced, 30)
      .then((rows) => {
        if (ignore) return;
        setResults(rows);
        setSearchError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setSearchError(err instanceof Error ? err.message : "Ошибка поиска");
      });
    return () => {
      ignore = true;
    };
  }, [debounced]);

  async function handleAdd() {
    if (!selected || busy) return;
    const qty = parseSupplyNumber(quantity);
    if (qty == null || qty <= 0) {
      setError("Количество должно быть больше 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = await addProductSupplyItem({
        supplyId,
        productId: selected.id,
        quantity: qty,
        unitNetWeightKg: parseSupplyNumber(weight),
        purchasePricePerUnit: parseSupplyNumber(price),
        purchaseCurrency: currency,
        exchangeRateToKzt: currency === "KZT" ? 1 : parseSupplyNumber(rate),
      });
      onAdded(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось добавить товар");
      setBusy(false);
    }
  }

  return (
    <Modal title="Добавить товар из каталога" onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
          Поиск по артикулу, названию, коду поставщика
        </span>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className={inputClass}
          placeholder="Артикул или название"
        />
      </label>
      {searchError ? <p className="text-sm text-red-600">{searchError}</p> : null}
      <ul className="max-h-48 overflow-y-auto rounded-md border border-neutral-200">
        {results.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => {
                setSelected(row);
                setWeight(toInput(row.weight_kg));
              }}
              className={`flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-neutral-50 ${
                selected?.id === row.id ? "bg-teal-50" : ""
              }`}
            >
              <span className="font-medium text-neutral-800">
                {row.sku} — {row.name}
              </span>
              <span className="text-xs text-neutral-500">
                {STAFF_PRODUCT_STATUS_LABELS[row.status as StaffProductStatus] ?? row.status}
                {row.original_sku ? ` · ${row.original_sku}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Количество *" value={quantity} onChange={setQuantity} />
          <NumberField label="Вес 1 шт, кг" value={weight} onChange={setWeight} />
          <NumberField label="Цена поставщика" value={price} onChange={setPrice} />
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Валюта</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as ProductSupplyCurrency)}
              className={inputClass}
            >
              {PRODUCT_SUPPLY_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          {currency !== "KZT" ? (
            <NumberField label="Курс к KZT" value={rate} onChange={setRate} />
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`rounded-md px-3 py-2 text-sm text-neutral-600 ${focusRing}`}>
          Отмена
        </button>
        <button
          type="button"
          disabled={!selected || busy}
          onClick={() => void handleAdd()}
          className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${focusRing}`}
        >
          {busy ? "Добавление..." : "Добавить"}
        </button>
      </div>
    </Modal>
  );
}

function NewProductModal({
  supplyId,
  defaultCurrency,
  defaultRate,
  onClose,
  onAdded,
}: {
  supplyId: string;
  defaultCurrency: ProductSupplyCurrency;
  defaultRate: number | null;
  onClose: () => void;
  onAdded: (payload: ProductSupplyPayload) => void;
}) {
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [originalSku, setOriginalSku] = useState("");
  const [unit, setUnit] = useState("шт.");
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [categories, setCategories] = useState<StaffCategoryListItem[]>([]);
  const [quantity, setQuantity] = useState("1");
  const [weight, setWeight] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<ProductSupplyCurrency>(defaultCurrency);
  const [rate, setRate] = useState(toInput(defaultRate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listStaffCategories(false)
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  const topCategories = useMemo(
    () => categories.filter((c) => c.parent_id === null && c.is_active),
    [categories],
  );
  const subcategories = useMemo(
    () => categories.filter((c) => c.parent_id === categoryId && c.is_active),
    [categories, categoryId],
  );

  async function handleCreate() {
    if (busy) return;
    const qty = parseSupplyNumber(quantity);
    if (qty == null || qty <= 0) {
      setError("Количество должно быть больше 0");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const product = await createDraftProductForSupply({
        sku,
        name,
        unit,
        originalSku: originalSku.trim() || null,
        categoryId: categoryId || null,
        subcategoryId: subcategoryId || null,
        weightKg: parseSupplyNumber(weight),
      });
      const payload = await addProductSupplyItem({
        supplyId,
        productId: product.id,
        quantity: qty,
        unitNetWeightKg: parseSupplyNumber(weight),
        purchasePricePerUnit: parseSupplyNumber(price),
        purchaseCurrency: currency,
        exchangeRateToKzt: currency === "KZT" ? 1 : parseSupplyNumber(rate),
      });
      onAdded(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать товар");
      setBusy(false);
    }
  }

  return (
    <Modal title="Новый товар в каталог" onClose={onClose}>
      <p className="text-sm text-neutral-500">
        Товар создаётся как черновик и не публикуется в клиентском каталоге. Позже можно добавить фото, цены и
        опубликовать.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Артикул *</span>
          <input required value={sku} onChange={(e) => setSku(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Название *</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Код поставщика</span>
          <input value={originalSku} onChange={(e) => setOriginalSku(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Ед. изм.</span>
          <input value={unit} onChange={(e) => setUnit(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Категория</span>
          <select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setSubcategoryId("");
            }}
            className={inputClass}
          >
            <option value="">Позже</option>
            {topCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Подкатегория</span>
          <select
            value={subcategoryId}
            onChange={(e) => setSubcategoryId(e.target.value)}
            className={inputClass}
            disabled={!categoryId}
          >
            <option value="">—</option>
            {subcategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <NumberField label="Количество в поставке *" value={quantity} onChange={setQuantity} />
        <NumberField label="Вес 1 шт, кг" value={weight} onChange={setWeight} />
        <NumberField label="Цена поставщика" value={price} onChange={setPrice} />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Валюта</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as ProductSupplyCurrency)}
            className={inputClass}
          >
            {PRODUCT_SUPPLY_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        {currency !== "KZT" ? (
          <NumberField label="Курс к KZT" value={rate} onChange={setRate} />
        ) : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`rounded-md px-3 py-2 text-sm text-neutral-600 ${focusRing}`}>
          Отмена
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleCreate()}
          className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${focusRing}`}
        >
          {busy ? "Создание..." : "Создать и добавить"}
        </button>
      </div>
    </Modal>
  );
}

function AddExpenseModal({
  supplyId,
  supplyRateFor,
  onClose,
  onAdded,
}: {
  supplyId: string;
  supplyRateFor: (currency: ProductSupplyCurrency) => number | null;
  onClose: () => void;
  onAdded: (payload: ProductSupplyPayload) => void;
}) {
  const [presetKey, setPresetKey] = useState(PRODUCT_SUPPLY_EXPENSE_PRESETS[0]?.key ?? "custom");
  const [name, setName] = useState(PRODUCT_SUPPLY_EXPENSE_PRESETS[0]?.name ?? "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<ProductSupplyCurrency>("KZT");
  const [useCustomRate, setUseCustomRate] = useState(false);
  const [rate, setRate] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inheritedRate = supplyRateFor(currency);

  async function handleAdd() {
    if (busy) return;
    const value = parseSupplyNumber(amount);
    if (value == null || value < 0) {
      setError("Укажите сумму расхода");
      return;
    }
    if (!name.trim()) {
      setError("Укажите название статьи");
      return;
    }
    if (currency !== "KZT" && useCustomRate) {
      const custom = parseSupplyNumber(rate);
      if (custom == null || custom <= 0) {
        setError("Укажите свой курс к тенге");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const payload = await addProductSupplyExpense({
        supplyId,
        name: name.trim(),
        amount: value,
        currency,
        useCustomExchangeRate: currency !== "KZT" && useCustomRate,
        exchangeRateToKzt:
          currency === "KZT"
            ? 1
            : useCustomRate
              ? parseSupplyNumber(rate)
              : null,
        categoryKey: presetKey,
        expenseDate: date || null,
        notes: notes.trim() || null,
      });
      onAdded(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось добавить расход");
      setBusy(false);
    }
  }

  return (
    <Modal title="Добавить расход" onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Статья</span>
        <select
          value={presetKey}
          onChange={(e) => {
            const key = e.target.value;
            setPresetKey(key);
            const preset = PRODUCT_SUPPLY_EXPENSE_PRESETS.find((p) => p.key === key);
            if (preset) setName(preset.name);
          }}
          className={inputClass}
        >
          {PRODUCT_SUPPLY_EXPENSE_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.name}
            </option>
          ))}
          <option value="custom">Своя статья</option>
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Название</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField label="Сумма *" value={amount} onChange={setAmount} />
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Валюта</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value as ProductSupplyCurrency)}
            className={inputClass}
          >
            {PRODUCT_SUPPLY_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        {currency !== "KZT" ? (
          <div className="flex flex-col gap-2 sm:col-span-2">
            <p className="text-xs text-neutral-500">
              По умолчанию: курс поставки{" "}
              {inheritedRate == null ? (
                <span className="text-amber-700">не задан</span>
              ) : (
                <span className="font-medium text-neutral-700">{formatSupplyRate(inheritedRate)}</span>
              )}
            </p>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={useCustomRate}
                onChange={(e) => {
                  setUseCustomRate(e.target.checked);
                  if (e.target.checked && !rate) {
                    setRate(toInput(inheritedRate));
                  }
                }}
              />
              Использовать свой курс
            </label>
            {useCustomRate ? (
              <NumberField label="Свой курс к KZT *" value={rate} onChange={setRate} />
            ) : null}
          </div>
        ) : null}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Дата</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заметка</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`rounded-md px-3 py-2 text-sm text-neutral-600 ${focusRing}`}>
          Отмена
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleAdd()}
          className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${focusRing}`}
        >
          {busy ? "Добавление..." : "Добавить"}
        </button>
      </div>
    </Modal>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} inputMode="decimal" />
    </label>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-lg">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-neutral-800">{title}</h2>
          <button type="button" onClick={onClose} className={`text-sm text-neutral-500 ${focusRing}`}>
            Закрыть
          </button>
        </div>
        <div className="flex flex-col gap-3">{children}</div>
      </div>
    </div>
  );
}
