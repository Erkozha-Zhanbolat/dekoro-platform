"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import FactoryCatalogMarkers from "@/components/staff/FactoryCatalogMarkers";
import { downloadProcurementExcel } from "@/lib/staff/procurementExcel";
import {
  buildProcurementAnalytics,
  getProcurementSnapshot,
  updateProcurementSettings,
  type ProcurementAnalytics,
} from "@/lib/staff/procurement";
import { PROCUREMENT_STATUS_LABELS, type ProcurementRecommendationStatus } from "@/lib/staff/procurementMath";
import {
  canAccessProcurement,
  canManageFactoryCatalogs,
  type FactoryCatalog,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";
const inputClass = `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

function formatQty(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

function statusClass(status: ProcurementRecommendationStatus): string {
  switch (status) {
    case "critical":
      return "bg-red-50 text-red-700";
    case "recommend":
      return "bg-amber-50 text-amber-800";
    case "order_soon":
      return "bg-orange-50 text-orange-800";
    case "in_transit":
      return "bg-sky-50 text-sky-800";
    case "watch":
      return "bg-neutral-100 text-neutral-700";
    case "insufficient_history":
      return "bg-neutral-50 text-neutral-500";
    default:
      return "bg-emerald-50 text-emerald-800";
  }
}

export default function StaffProcurementPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canRead = canAccessProcurement(profile?.role);
  const canAdmin = canManageFactoryCatalogs(profile?.role);

  const [analytics, setAnalytics] = useState<ProcurementAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [leadTime, setLeadTime] = useState("60");
  const [safety, setSafety] = useState("14");
  const [w7, setW7] = useState("0.5");
  const [w30, setW30] = useState("0.3");
  const [w90, setW90] = useState("0.2");
  const [settingsBusy, setSettingsBusy] = useState(false);

  const [catalogFilter, setCatalogFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [exportCatalogId, setExportCatalogId] = useState("");
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [allocation, setAllocation] = useState<Record<string, string>>({});
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [addSku, setAddSku] = useState("");
  const [exportNote, setExportNote] = useState<string | null>(null);

  useEffect(() => {
    if (!profileLoading && profile && !canRead) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, canRead, router]);

  const reload = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      const snapshot = await getProcurementSnapshot();
      const next = buildProcurementAnalytics(snapshot);
      setAnalytics(next);
      setLeadTime(String(snapshot.settings.lead_time_days));
      setSafety(String(snapshot.settings.safety_stock_days));
      setW7(String(snapshot.settings.velocity_weight_7));
      setW30(String(snapshot.settings.velocity_weight_30));
      setW90(String(snapshot.settings.velocity_weight_90));
      setError(null);
      const alloc: Record<string, string> = {};
      for (const product of next.products) {
        if (product.preferred_catalog_id) {
          alloc[product.product_id] = product.preferred_catalog_id;
        }
      }
      setAllocation(alloc);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить закупки");
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
  }, [canRead, reload, reloadToken]);

  const filtered = useMemo(() => {
    if (!analytics) return [];
    const q = search.trim().toLowerCase();
    return analytics.products.filter((p) => {
      if (statusFilter && p.status !== statusFilter) return false;
      if (catalogFilter === "none" && p.catalogs.length > 0) return false;
      if (catalogFilter !== "all" && catalogFilter !== "none") {
        if (!p.catalogs.some((c) => c.id === catalogFilter)) return false;
      }
      if (q && !p.sku.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [analytics, catalogFilter, statusFilter, search]);

  const exportCatalog: FactoryCatalog | null =
    analytics?.snapshot.catalogs.find((c) => c.id === exportCatalogId) ?? null;

  const exportProducts = useMemo(() => {
    if (!analytics || !exportCatalogId) return [];
    return analytics.products.filter((p) => {
      if (addedIds.has(p.product_id) && p.catalogs.some((c) => c.id === exportCatalogId)) {
        return true;
      }
      if (p.catalogs.length === 1 && p.catalogs[0]?.id === exportCatalogId) {
        return p.recommendedQty > 0 || addedIds.has(p.product_id);
      }
      if (p.catalogs.some((c) => c.id === exportCatalogId) && p.catalogs.length > 1) {
        const assigned = allocation[p.product_id] ?? p.preferred_catalog_id;
        return assigned === exportCatalogId && (p.recommendedQty > 0 || addedIds.has(p.product_id));
      }
      return false;
    });
  }, [analytics, exportCatalogId, allocation, addedIds]);

  async function handleSaveSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!canAdmin || settingsBusy) return;
    setSettingsBusy(true);
    setError(null);
    try {
      await updateProcurementSettings({
        leadTimeDays: Number(leadTime),
        safetyStockDays: Number(safety),
        weight7: Number(w7),
        weight30: Number(w30),
        weight90: Number(w90),
      });
      setReloadToken((n) => n + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить настройки");
    } finally {
      setSettingsBusy(false);
    }
  }

  function handleExport() {
    if (!analytics || !exportCatalog) return;
    const lines = exportProducts.map((product) => {
      const raw = qtyOverrides[product.product_id];
      const parsed = raw == null || raw.trim() === "" ? product.recommendedQty : Number(raw);
      const orderQty = Number.isFinite(parsed) ? Math.max(0, parsed) : product.recommendedQty;
      return {
        product,
        orderQty,
        included: !excluded.has(product.product_id) && orderQty > 0,
        allocationCatalogName: exportCatalog.name,
        note: product.is_universal
          ? `Можно заказать у: ${product.catalogs.map((c) => c.name).join(" / ")}`
          : "",
      };
    });
    const fileName = downloadProcurementExcel({ analytics, catalog: exportCatalog, lines });
    setExportNote(`Скачан файл ${fileName}`);
  }

  if (profileLoading || (!canRead && profile)) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Закупки</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Рекомендация заказа заводу. Это не поставки — реальные поставки в разделе
            «Поставки».
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setReloadToken((n) => n + 1);
          }}
          className={`rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm font-medium ${focusRing}`}
        >
          Обновить
        </button>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {canAdmin ? (
        <form
          onSubmit={(e) => void handleSaveSettings(e)}
          className="rounded-lg border border-neutral-200 bg-white p-5"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Параметры рекомендации
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-5">
            <label className="text-xs text-neutral-500">
              Срок поставки, дн.
              <input className={`mt-1 w-full ${inputClass}`} value={leadTime} onChange={(e) => setLeadTime(e.target.value)} />
            </label>
            <label className="text-xs text-neutral-500">
              Страховой запас, дн.
              <input className={`mt-1 w-full ${inputClass}`} value={safety} onChange={(e) => setSafety(e.target.value)} />
            </label>
            <label className="text-xs text-neutral-500">
              Вес 7д
              <input className={`mt-1 w-full ${inputClass}`} value={w7} onChange={(e) => setW7(e.target.value)} />
            </label>
            <label className="text-xs text-neutral-500">
              Вес 30д
              <input className={`mt-1 w-full ${inputClass}`} value={w30} onChange={(e) => setW30(e.target.value)} />
            </label>
            <label className="text-xs text-neutral-500">
              Вес 90д
              <input className={`mt-1 w-full ${inputClass}`} value={w90} onChange={(e) => setW90(e.target.value)} />
            </label>
          </div>
          <button
            type="submit"
            disabled={settingsBusy}
            className={`mt-3 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {settingsBusy ? "Сохранение..." : "Сохранить параметры"}
          </button>
        </form>
      ) : null}

      {loading || !analytics ? (
        <p className="text-sm text-neutral-500">Загрузка аналитики...</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {analytics.groups.map((group) => {
              const recSku =
                group.unique_recommended_sku +
                group.universal_products.filter((p) => p.recommendedQty > 0).length;
              const recQty = group.unique_recommended_qty + group.preferred_universal_qty;
              const weight = [...group.unique_products, ...group.universal_products]
                .filter((p) => p.preferred_catalog_id === group.catalog.id || p.catalogs.length === 1)
                .reduce((sum, p) => sum + (p.estimated_weight_kg ?? 0), 0);
              return (
                <button
                  key={group.catalog.id}
                  type="button"
                  onClick={() => {
                    setCatalogFilter(group.catalog.id);
                    setExportCatalogId(group.catalog.id);
                  }}
                  className={`rounded-lg border bg-white p-4 text-left ${
                    exportCatalogId === group.catalog.id
                      ? "border-[#0F766E]"
                      : "border-neutral-200"
                  } ${focusRing}`}
                >
                  <p className="font-semibold text-neutral-800">{group.catalog.name}</p>
                  <p className="mt-2 text-sm text-neutral-600">
                    {recSku} SKU рекомендуется · {formatQty(recQty)} шт.
                  </p>
                  <p className="mt-1 text-xs text-neutral-400">
                    {group.unique_products.filter((p) => p.recommendedQty > 0).length} только этот
                    каталог · {group.universal_products.filter((p) => p.recommendedQty > 0).length}{" "}
                    универсальных
                  </p>
                  {weight > 0 ? (
                    <p className="mt-1 text-xs text-neutral-500">
                      Ориентировочный вес: {formatQty(Math.round(weight))} кг
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>

          {analytics.weight_missing_sku > 0 ? (
            <p className="text-sm text-amber-800">
              Для {analytics.weight_missing_sku} SKU с рекомендацией вес не задан.
            </p>
          ) : null}

          <p className="text-xs text-neutral-400">{analytics.formula_text}</p>

          <div className="flex flex-wrap gap-3">
            <input
              className={`${inputClass} w-full sm:max-w-xs`}
              placeholder="Поиск SKU / названия"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={inputClass}
              value={catalogFilter}
              onChange={(e) => setCatalogFilter(e.target.value)}
            >
              <option value="all">Все каталоги</option>
              {analytics.snapshot.catalogs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="none">Без каталога</option>
            </select>
            <select
              className={inputClass}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Все статусы</option>
              {Object.entries(PROCUREMENT_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Название</th>
                  <th className="px-3 py-2">Каталоги</th>
                  <th className="px-3 py-2 text-right">Остаток</th>
                  <th className="px-3 py-2 text-right">Резерв</th>
                  <th className="px-3 py-2 text-right">Доступно</th>
                  <th className="px-3 py-2 text-right">В пути</th>
                  <th className="px-3 py-2 text-right">7д</th>
                  <th className="px-3 py-2 text-right">30д</th>
                  <th className="px-3 py-2 text-right">90д</th>
                  <th className="px-3 py-2 text-right">Запас дн.</th>
                  <th className="px-3 py-2">Статус</th>
                  <th className="px-3 py-2 text-right">Рек.</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.product_id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2 font-medium text-neutral-800">
                      <span className="mr-1">{p.sku}</span>
                      <FactoryCatalogMarkers catalogs={p.catalogs} />
                    </td>
                    <td className="px-3 py-2 text-neutral-700">{p.name}</td>
                    <td className="px-3 py-2 text-xs text-neutral-500">
                      {p.catalogs.length === 0
                        ? "—"
                        : p.is_universal
                          ? `Можно заказать у: ${p.catalogs.map((c) => c.name).join(" / ")}`
                          : p.catalogs[0]?.name}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(p.physical_qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(p.reserved_qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(p.available_qty)}</td>
                    <td
                      className="px-3 py-2 text-right tabular-nums"
                      title={p.incoming_breakdown.map((b) => b.label).join("\n")}
                    >
                      {formatQty(p.incoming_qty)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(p.sales_7)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(p.sales_30)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(p.sales_90)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {p.daysOfStock == null ? "∞" : formatQty(Math.round(p.daysOfStock))}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusClass(p.status)}`}>
                        {PROCUREMENT_STATUS_LABELS[p.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">
                      {formatQty(p.recommendedQty)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="rounded-lg border border-neutral-200 bg-white p-5">
            <h2 className="text-lg font-semibold text-neutral-800">Черновик заказа (Excel)</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Правки количества не меняют аналитику — только этот отчёт.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <select
                className={inputClass}
                value={exportCatalogId}
                onChange={(e) => setExportCatalogId(e.target.value)}
              >
                <option value="">Выберите каталог</option>
                {analytics.snapshot.catalogs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!exportCatalog}
                onClick={handleExport}
                className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
              >
                Выгрузить Excel
              </button>
            </div>

            {exportCatalog && exportProducts.length > 0 ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                      <th className="py-2">В заказ</th>
                      <th>SKU</th>
                      <th>Каталог</th>
                      <th className="text-right">Рек.</th>
                      <th className="text-right">Заказать</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exportProducts.map((p) => (
                      <tr key={p.product_id} className="border-t border-neutral-100">
                        <td className="py-2">
                          <input
                            type="checkbox"
                            className="accent-[#0F766E]"
                            checked={!excluded.has(p.product_id)}
                            onChange={() => {
                              setExcluded((prev) => {
                                const next = new Set(prev);
                                if (next.has(p.product_id)) next.delete(p.product_id);
                                else next.add(p.product_id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td>
                          {p.sku}{" "}
                          <span className="text-neutral-400">{p.name}</span>
                        </td>
                        <td>
                          {p.is_universal ? (
                            <select
                              className={inputClass}
                              value={allocation[p.product_id] ?? p.preferred_catalog_id ?? ""}
                              onChange={(e) =>
                                setAllocation((prev) => ({
                                  ...prev,
                                  [p.product_id]: e.target.value,
                                }))
                              }
                            >
                              {p.catalogs.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            p.catalogs[0]?.name ?? "—"
                          )}
                        </td>
                        <td className="text-right tabular-nums">{formatQty(p.recommendedQty)}</td>
                        <td className="text-right">
                          <input
                            className={`${inputClass} w-24 text-right`}
                            value={qtyOverrides[p.product_id] ?? String(p.recommendedQty)}
                            onChange={(e) =>
                              setQtyOverrides((prev) => ({
                                ...prev,
                                [p.product_id]: e.target.value,
                              }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : exportCatalog ? (
              <p className="mt-3 text-sm text-neutral-500">
                Нет позиций к заказу для этого каталога. Можно добавить SKU ниже.
              </p>
            ) : null}

            {exportCatalog ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <input
                  className={`${inputClass} w-40`}
                  placeholder="Добавить SKU"
                  value={addSku}
                  onChange={(e) => setAddSku(e.target.value)}
                />
                <button
                  type="button"
                  className={`rounded-md border border-neutral-200 px-3 py-2 text-sm ${focusRing}`}
                  onClick={() => {
                    const found = analytics.products.find(
                      (p) => p.sku.toLowerCase() === addSku.trim().toLowerCase(),
                    );
                    if (!found) {
                      setExportNote("SKU не найден");
                      return;
                    }
                    setAddedIds((prev) => new Set(prev).add(found.product_id));
                    if (found.is_universal) {
                      setAllocation((prev) => ({
                        ...prev,
                        [found.product_id]: exportCatalogId,
                      }));
                    }
                    setAddSku("");
                    setExportNote(`Добавлен ${found.sku}`);
                  }}
                >
                  Добавить позицию
                </button>
              </div>
            ) : null}

            {exportNote ? (
              <p className="mt-3 text-sm text-[#0F766E]" role="status">
                {exportNote}
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
