"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import {
  formatSupplyKg,
  formatSupplyMoney,
  listProductSupplies,
  type ProductSupplyListItem,
} from "@/lib/staff/supplies";
import {
  PRODUCT_SUPPLY_FINANCIAL_LABELS,
  PRODUCT_SUPPLY_LOGISTICS_LABELS,
  PRODUCT_SUPPLY_LOGISTICS_STATUS_ORDER,
  PRODUCT_SUPPLY_STATUS_LABELS,
  canAccessProductSupplies,
  type ProductSupplyLogisticsStatus,
  type ProductSupplyStatus,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function FinancialBadge({ status }: { status: ProductSupplyStatus }) {
  if (status === "closed") {
    return (
      <span className="inline-flex rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
        {PRODUCT_SUPPLY_FINANCIAL_LABELS.closed}
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
      {PRODUCT_SUPPLY_FINANCIAL_LABELS.draft}
    </span>
  );
}

export default function StaffSuppliesPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const allowed = canAccessProductSupplies(profile?.role);

  const [statusFilter, setStatusFilter] = useState<ProductSupplyStatus | "">("");
  const [logisticsFilter, setLogisticsFilter] = useState<ProductSupplyLogisticsStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [rows, setRows] = useState<ProductSupplyListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const filterKey = `${statusFilter}|${logisticsFilter}|${dateFrom}|${dateTo}|${debouncedQuery}`;

  useEffect(() => {
    if (!profileLoading && profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, allowed, router]);

  useEffect(() => {
    if (!allowed) return;
    if (loadedKey === filterKey) return;

    let ignore = false;
    listProductSupplies({
      status: statusFilter,
      logisticsStatus: logisticsFilter,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      query: debouncedQuery || null,
      limit: 100,
    })
      .then((data) => {
        if (ignore) return;
        setRows(data);
        setLoadError(null);
        setLoadedKey(filterKey);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить поставки");
        setLoadedKey(filterKey);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, filterKey, loadedKey, statusFilter, logisticsFilter, dateFrom, dateTo, debouncedQuery]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const loading = loadedKey !== filterKey;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Поставки</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Операционный модуль закупок. Складской остаток не меняется.
          </p>
        </div>
        <Link
          href="/staff/supplies/new"
          className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
        >
          Новая поставка
        </Link>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex min-w-[160px] flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Себестоимость</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as ProductSupplyStatus | "")}
            className={inputClass}
          >
            <option value="">Все</option>
            <option value="draft">{PRODUCT_SUPPLY_STATUS_LABELS.draft}</option>
            <option value="closed">{PRODUCT_SUPPLY_STATUS_LABELS.closed}</option>
          </select>
        </label>
        <label className="flex min-w-[220px] flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Логистика</span>
          <select
            value={logisticsFilter}
            onChange={(e) =>
              setLogisticsFilter(e.target.value as ProductSupplyLogisticsStatus | "")
            }
            className={inputClass}
          >
            <option value="">Все</option>
            {PRODUCT_SUPPLY_LOGISTICS_STATUS_ORDER.map((status) => (
              <option key={status} value={status}>
                {PRODUCT_SUPPLY_LOGISTICS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Дата с</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Дата по</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={inputClass} />
        </label>
        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Поиск</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${inputClass} w-full`}
            placeholder="Номер или поставщик"
          />
        </label>
      </div>

      {loadError ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Поставок пока нет</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Номер</th>
                <th className="px-4 py-3 font-medium">Поставщик</th>
                <th className="px-4 py-3 font-medium">Дата</th>
                <th className="px-4 py-3 font-medium">Логистика</th>
                <th className="px-4 py-3 font-medium">Себестоимость</th>
                <th className="px-4 py-3 font-medium">Позиции</th>
                <th className="px-4 py-3 font-medium">Брутто</th>
                <th className="px-4 py-3 font-medium">Расходы</th>
                <th className="px-4 py-3 font-medium">Себест. итого</th>
                <th className="px-4 py-3 font-medium">Обновлено</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/staff/supplies/${row.id}`}
                      className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}
                    >
                      {row.supply_number}
                    </Link>
                    <p className="text-xs text-neutral-400">{row.title}</p>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{row.supplier_name ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">
                    {new Date(`${row.supply_date}T00:00:00`).toLocaleDateString("ru-RU")}
                  </td>
                  <td className="px-4 py-3 text-neutral-700">
                    {PRODUCT_SUPPLY_LOGISTICS_LABELS[row.logistics_status] ?? row.logistics_status}
                  </td>
                  <td className="px-4 py-3">
                    <FinancialBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-neutral-700">{row.items_count}</td>
                  <td className="px-4 py-3 text-neutral-700">{formatSupplyKg(row.gross_weight_kg)}</td>
                  <td className="px-4 py-3 text-neutral-700">
                    {formatSupplyMoney(row.total_expenses_kzt)}
                  </td>
                  <td className="px-4 py-3 font-medium text-neutral-800">
                    {formatSupplyMoney(row.total_landed_cost_kzt)}
                  </td>
                  <td className="px-4 py-3 text-neutral-500">
                    {new Date(row.updated_at).toLocaleDateString("ru-RU")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
