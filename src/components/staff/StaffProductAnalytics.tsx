"use client";

import { useEffect, useState } from "react";
import { getProductAnalytics } from "@/lib/analytics/api";
import type { ProductAnalytics } from "@/lib/analytics/types";

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-neutral-800">
        {value}
      </p>
    </div>
  );
}

export function StaffProductAnalytics({ productId }: { productId: string }) {
  const [data, setData] = useState<ProductAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!productId) return;
    let ignore = false;

    getProductAnalytics(productId)
      .then((row) => {
        if (ignore) return;
        setData(row);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) return;
        setData(null);
        setError(
          err instanceof Error
            ? err.message
            : "Не удалось загрузить аналитику товара",
        );
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [productId]);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
      <div>
        <h2 className="text-lg font-semibold text-neutral-800">Аналитика</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Просмотры, корзина, избранное и заказы по этому товару
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка...</p>
      ) : error ? (
        <p className="text-sm text-amber-800">{error}</p>
      ) : data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Сегодня" value={data.views_today} />
          <Metric label="7 дней" value={data.views_7d} />
          <Metric label="30 дней" value={data.views_30d} />
          <Metric label="Всего просмотров" value={data.views_total} />
          <Metric label="В корзину" value={data.cart_adds} />
          <Metric label="В избранное" value={data.favorite_adds} />
          <Metric label="Заказали" value={data.orders_count} />
          <Metric label="Конверсия в корзину" value={`${data.conversion_cart}%`} />
          <Metric label="Конверсия в заказ" value={`${data.conversion_order}%`} />
        </div>
      ) : null}
    </section>
  );
}
