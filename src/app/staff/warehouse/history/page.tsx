"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import WarehouseSectionNav from "@/components/staff/WarehouseSectionNav";
import { listWarehouseShipmentHistory } from "@/lib/staff/warehouse";
import type { WarehouseShipmentHistoryItem } from "@/types/database";
import {
  ORDER_STATUS_LABELS,
  canAccessWarehouseHistory,
} from "@/types/database";
import { useProfile } from "@/context/ProfileContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const SEARCH_DEBOUNCE_MS = 300;
const LIST_LIMIT = 50;

type DatePreset = "today" | "7d" | "30d" | "custom";

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: "today", label: "Сегодня" },
  { key: "7d", label: "7 дней" },
  { key: "30d", label: "30 дней" },
  { key: "custom", label: "Произвольный период" },
];

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDateInput(value: string, endOfDay: boolean): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return endOfDay ? endOfLocalDay(date) : startOfLocalDay(date);
}

function rangeForPreset(preset: Exclude<DatePreset, "custom">): { from: Date; to: Date } {
  const now = new Date();
  if (preset === "today") {
    return { from: startOfLocalDay(now), to: endOfLocalDay(now) };
  }
  const from = new Date(now);
  from.setDate(from.getDate() - (preset === "7d" ? 7 : 30));
  return { from, to: now };
}

function formatQty(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

export default function StaffWarehouseHistoryPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const allowed = canAccessWarehouseHistory(profile?.role);

  const [preset, setPreset] = useState<DatePreset>("30d");
  const [customFrom, setCustomFrom] = useState(() =>
    toDateInputValue(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  );
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [orders, setOrders] = useState<WarehouseShipmentHistoryItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);

  const dateRange = useMemo(() => {
    if (preset !== "custom") {
      return rangeForPreset(preset);
    }
    const from = parseDateInput(customFrom, false);
    const to = parseDateInput(customTo, true);
    if (!from || !to) {
      return null;
    }
    return { from, to };
  }, [preset, customFrom, customTo]);

  const rangeError =
    preset === "custom" && dateRange && dateRange.from > dateRange.to
      ? "Дата начала позже даты окончания"
      : preset === "custom" && !dateRange
        ? "Укажите корректный период"
        : null;

  useEffect(() => {
    if (profile && !allowed) {
      router.replace("/staff/warehouse");
    }
  }, [profile, allowed, router]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  const filterKey = dateRange
    ? `${preset}:${dateRange.from.toISOString()}:${dateRange.to.toISOString()}:${debouncedSearch}`
    : `invalid:${preset}:${customFrom}:${customTo}:${debouncedSearch}`;

  const offset = page * LIST_LIMIT;
  const currentKey = `${filterKey}:${page}`;
  const rowsForFilter = loadedKey?.startsWith(`${filterKey}:`) ? orders : [];

  useEffect(() => {
    if (!allowed || rangeError || !dateRange || loadedKey === currentKey) {
      return;
    }

    let ignore = false;

    listWarehouseShipmentHistory({
      from: dateRange.from.toISOString(),
      to: dateRange.to.toISOString(),
      search: debouncedSearch,
      limit: LIST_LIMIT,
      offset,
    })
      .then((result) => {
        if (ignore) {
          return;
        }
        setOrders((prev) => (page === 0 ? result : [...prev, ...result]));
        setLoadError(null);
        setLoadedKey(currentKey);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить историю отгрузок",
        );
        setLoadedKey(currentKey);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, rangeError, dateRange, debouncedSearch, currentKey, loadedKey, offset, page]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const loading = !loadedKey?.startsWith(`${filterKey}:`) && !rangeError;
  const loadingMore = page > 0 && loadedKey !== currentKey;
  const totalCount = rowsForFilter[0]?.total_count ?? 0;
  const hasMore = rowsForFilter.length < totalCount;

  function applyPreset(next: DatePreset) {
    setPreset(next);
    setPage(0);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-800">Склад</h1>
        <p className="mt-1 text-sm text-neutral-500">
          История реально отгруженных заказов
        </p>
      </div>

      <WarehouseSectionNav role={profile?.role} />

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-1">
        {PRESETS.map((item) => {
          const active = preset === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => applyPreset(item.key)}
              className={`min-w-[7rem] flex-1 rounded-md px-3 py-2.5 text-sm font-medium transition-colors ${focusRing} ${
                active
                  ? "bg-white text-[#0F766E] shadow-sm"
                  : "text-neutral-600 hover:text-neutral-800"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {preset === "custom" && (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm text-neutral-600">
            С
            <input
              type="date"
              value={customFrom}
              onChange={(event) => {
                setCustomFrom(event.target.value);
                setPage(0);
              }}
              className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-neutral-600">
            По
            <input
              type="date"
              value={customTo}
              onChange={(event) => {
                setCustomTo(event.target.value);
                setPage(0);
              }}
              className={`rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`}
            />
          </label>
        </div>
      )}

      <input
        type="search"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        placeholder="Поиск по номеру, клиенту, SKU или названию"
        className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-3 text-base text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:max-w-md sm:text-sm ${focusRing}`}
      />

      {rangeError && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {rangeError}
        </p>
      )}

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : rowsForFilter.length === 0 && !rangeError ? (
        <p className="rounded-lg border border-dashed border-neutral-200 bg-white px-5 py-10 text-center text-sm text-neutral-500">
          За выбранный период отгрузок нет
        </p>
      ) : rowsForFilter.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-4 py-3">№ заказа</th>
                  <th className="px-4 py-3">Клиент</th>
                  <th className="px-4 py-3">Дата отгрузки</th>
                  <th className="px-4 py-3">Позиции</th>
                  <th className="px-4 py-3">Кол-во</th>
                  <th className="px-4 py-3">Собрал / отгрузил</th>
                  <th className="px-4 py-3">Статус</th>
                </tr>
              </thead>
              <tbody>
                {rowsForFilter.map((order) => (
                  <tr key={order.order_id} className="border-b border-neutral-100 last:border-b-0">
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/warehouse/history/${order.order_id}`}
                        className={`font-semibold text-neutral-800 hover:text-[#0F766E] ${focusRing}`}
                      >
                        {order.order_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-neutral-700">{order.customer_display_name}</td>
                    <td className="px-4 py-3 text-neutral-600">
                      {new Date(order.shipped_at).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3 text-neutral-700">{order.line_count}</td>
                    <td className="px-4 py-3 text-neutral-700">{formatQty(order.total_quantity)}</td>
                    <td className="px-4 py-3 text-neutral-600">
                      {[order.picked_by_name, order.shipped_by_name]
                        .filter(Boolean)
                        .join(" / ") || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
                        {ORDER_STATUS_LABELS[order.status] ?? order.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => setPage((value) => value + 1)}
              className={`self-start rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-60 ${focusRing}`}
            >
              {loadingMore ? "Загрузка..." : "Показать ещё"}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
