"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getWarehouseShipmentHistoryOrder } from "@/lib/staff/warehouse";
import type { WarehouseShipmentHistoryOrder } from "@/types/database";
import {
  ORDER_STATUS_LABELS,
  canAccessWarehouseHistory,
} from "@/types/database";
import { useProfile } from "@/context/ProfileContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function formatQty(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);
}

function formatTs(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TIMELINE_STEPS: {
  key: keyof WarehouseShipmentHistoryOrder["timeline"];
  label: string;
}[] = [
  { key: "paid_at", label: "Оплачен" },
  { key: "picking_started_at", label: "Сборка начата" },
  { key: "picking_completed_at", label: "Сборка завершена" },
  { key: "shipped_at", label: "Отгружен" },
];

export default function StaffWarehouseHistoryOrderPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const router = useRouter();
  const { profile } = useProfile();
  const allowed = canAccessWarehouseHistory(profile?.role);

  const [details, setDetails] = useState<WarehouseShipmentHistoryOrder | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (profile && !allowed) {
      router.replace("/staff/warehouse");
    }
  }, [profile, allowed, router]);

  useEffect(() => {
    if (!allowed || loadedId === orderId) {
      return;
    }

    let ignore = false;

    getWarehouseShipmentHistoryOrder(orderId)
      .then((result) => {
        if (ignore) {
          return;
        }
        setDetails(result);
        setLoadError(null);
        setLoadedId(orderId);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setDetails(null);
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить отгруженный заказ",
        );
        setLoadedId(orderId);
      });

    return () => {
      ignore = true;
    };
  }, [allowed, orderId, loadedId]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  const loading = loadedId !== orderId;

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          href="/staff/warehouse/history"
          className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
        >
          ← К истории отгрузок
        </Link>
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (loadError || !details) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          href="/staff/warehouse/history"
          className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
        >
          ← К истории отгрузок
        </Link>
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError ?? "Заказ не найден в истории отгрузок"}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href="/staff/warehouse/history"
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
      >
        ← К истории отгрузок
      </Link>

      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-bold text-neutral-800">
            Заказ {details.order.order_number}
          </h1>
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
            {ORDER_STATUS_LABELS[details.order.status]}
          </span>
        </div>
        <p className="mt-2 text-base text-neutral-700">{details.customer_display_name}</p>
        {(details.picked_by_name || details.shipped_by_name) && (
          <p className="mt-1 text-sm text-neutral-500">
            {details.picked_by_name ? `Собрал: ${details.picked_by_name}` : null}
            {details.picked_by_name && details.shipped_by_name ? " · " : null}
            {details.shipped_by_name ? `Отгрузил: ${details.shipped_by_name}` : null}
          </p>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-neutral-800">Товары</h2>
        {details.items.length === 0 ? (
          <p className="text-sm text-neutral-500">В заказе нет позиций</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {details.items.map((item, index) => (
              <li
                key={`${item.product_id}-${index}`}
                className="rounded-xl border border-neutral-200 bg-white px-4 py-4"
              >
                <p className="text-base font-semibold text-neutral-800">{item.product_name}</p>
                <p className="mt-1 text-sm text-neutral-500">
                  {item.product_sku ? `SKU ${item.product_sku} · ` : ""}
                  {formatQty(item.quantity)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-neutral-800">Складские этапы</h2>
        <ol className="mt-4 flex flex-col gap-3">
          {TIMELINE_STEPS.map((step) => {
            const stamp = formatTs(details.timeline[step.key]);
            return (
              <li key={step.key} className="flex items-start justify-between gap-3">
                <span className="text-sm font-medium text-neutral-800">{step.label}</span>
                <span className="text-sm text-neutral-500">{stamp ?? "—"}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}