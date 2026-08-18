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
  PRODUCT_SUPPLY_STATUS_LABELS,
  canAccessProductSupplies,
  type ProductSupplyStatus,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function StatusBadge({ status }: { status: ProductSupplyStatus }) {
  if (status === "closed") {
    return (
      <span className="inline-flex rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600">
        {PRODUCT_SUPPLY_STATUS_LABELS.closed}
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
      {PRODUCT_SUPPLY_STATUS_LABELS.draft}
    </span>
  );
}

export default function StaffSuppliesPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const allowed = canAccessProductSupplies(profile?.role);

  const [statusFilter, setStatusFilter] = useState<ProductSupplyStatus | "">("");
  const [rows, setRows] = useState<ProductSupplyListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!profileLoading && profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, allowed, router]);

  useEffect(() => {
    if (!allowed) return;
    if (loadedKey === statusFilter) return;

    let ignore = false;
    listProductSupplies({ status: statusFilter, limit: 100 })
      .then((data) => {
        if (ignore) return;
        setRows(data);
        setLoadError(null);
        setLoadedKey(statusFilter);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить поставки");
        setLoadedKey(statusFilter);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, statusFilter, loadedKey]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const loading = loadedKey !== statusFilter;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Поставки</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Фактическая себестоимость товара. Складской остаток не меняется.
          </p>
        </div>
        <Link
          href="/staff/supplies/new"
          className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
        >
          Новая поставка
        </Link>
      </div>

      <label className="flex max-w-xs flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Статус</span>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as ProductSupplyStatus | "");
          }}
          className={inputClass}
        >
          <option value="">Все</option>
          <option value="draft">{PRODUCT_SUPPLY_STATUS_LABELS.draft}</option>
          <option value="closed">{PRODUCT_SUPPLY_STATUS_LABELS.closed}</option>
        </select>
      </label>

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
                <th className="px-4 py-3 font-medium">Название</th>
                <th className="px-4 py-3 font-medium">Поставщик</th>
                <th className="px-4 py-3 font-medium">Дата</th>
                <th className="px-4 py-3 font-medium">Статус</th>
                <th className="px-4 py-3 font-medium">Брутто</th>
                <th className="px-4 py-3 font-medium">Расходы</th>
                <th className="px-4 py-3 font-medium">Себестоимость</th>
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
                  </td>
                  <td className="px-4 py-3 text-neutral-800">
                    {row.title}
                    <span className="ml-2 text-xs text-neutral-400">{row.items_count} поз.</span>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{row.supplier_name ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">
                    {new Date(`${row.supply_date}T00:00:00`).toLocaleDateString("ru-RU")}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-3 text-neutral-700">{formatSupplyKg(row.gross_weight_kg)}</td>
                  <td className="px-4 py-3 text-neutral-700">
                    {formatSupplyMoney(row.total_expenses_kzt)}
                  </td>
                  <td className="px-4 py-3 font-medium text-neutral-800">
                    {formatSupplyMoney(row.total_landed_cost_kzt)}
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
