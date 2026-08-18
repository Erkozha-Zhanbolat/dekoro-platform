"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  formatSupplyMoney,
  listProductLandedCosts,
  type ProductLandedCostHistoryItem,
} from "@/lib/staff/supplies";

export default function StaffProductLandedCostHistory({ productId }: { productId: string }) {
  const [rows, setRows] = useState<ProductLandedCostHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    listProductLandedCosts(productId)
      .then((data) => {
        if (ignore) return;
        setRows(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить историю себестоимости");
        setRows([]);
      });
    return () => {
      ignore = true;
    };
  }, [productId]);

  return (
    <section className="mt-6 flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        История себестоимости
      </h2>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {rows == null ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Пока нет поставок с себестоимостью по этому товару</p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {rows.map((row) => (
            <li key={`${row.supply_id}-${row.supply_number}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
              <Link
                href={`/staff/supplies/${row.supply_id}`}
                className="font-medium text-[#0F766E] hover:underline"
              >
                Поставка №{row.sequence_number}
                <span className="ml-2 font-normal text-neutral-500">{row.supply_number}</span>
              </Link>
              <span className="text-neutral-800">
                {formatSupplyMoney(row.landed_cost_per_unit_kzt)} / {row.unit}
                {row.is_preliminary ? (
                  <span className="ml-2 text-xs text-amber-700">предварительно</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
