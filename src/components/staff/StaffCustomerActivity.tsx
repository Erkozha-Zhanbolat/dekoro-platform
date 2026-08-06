"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCustomerActivity } from "@/lib/analytics/api";
import type { CustomerActivity } from "@/lib/analytics/types";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const EVENT_LABELS: Record<string, string> = {
  page_view: "Просмотр страницы",
  catalog_open: "Каталог",
  category_open: "Категория",
  product_view: "Товар",
  search: "Поиск",
  favorite_add: "В избранное",
  favorite_remove: "Из избранного",
  cart_add: "В корзину",
  cart_remove: "Удаление из корзины",
  checkout_start: "Оформление",
  login: "Вход",
  register: "Регистрация",
  order_created: "Заказ",
  order_cancelled: "Отмена заказа",
  invoice_open: "Счёт",
  delivery_note_open: "Накладная",
  document_download: "Скачивание",
};

const SOURCE_LABELS: Record<string, string> = {
  direct: "Прямой заход",
  instagram: "Instagram",
  google: "Google",
  whatsapp: "WhatsApp",
  referral: "Реферал",
  other: "Другое",
};

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m <= 0) return `${s} с`;
  return `${m} мин ${s} с`;
}

function ListBlock({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-neutral-800">{title}</h3>
      {empty ? (
        <p className="mt-2 text-sm text-neutral-500">Нет данных</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-100 text-sm">{children}</ul>
      )}
    </div>
  );
}

export function StaffCustomerActivity({ customerId }: { customerId: string }) {
  const [data, setData] = useState<CustomerActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!customerId) return;
    let ignore = false;

    getCustomerActivity(customerId)
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
            : "Не удалось загрузить активность",
        );
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [customerId]);

  if (loading) {
    return <p className="text-sm text-neutral-500">Загрузка активности...</p>;
  }

  if (error) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {error}
      </div>
    );
  }

  if (!data) return null;

  const sourceLabel = data.traffic_source
    ? (SOURCE_LABELS[data.traffic_source] ?? data.traffic_source)
    : "—";

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Последний визит
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {formatDateTime(data.last_visit)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Источник
          </p>
          <p className="mt-1 text-sm text-neutral-800">{sourceLabel}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Визитов
          </p>
          <p className="mt-1 text-sm text-neutral-800">{data.visits_count}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Ср. длительность
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {formatDuration(data.avg_session_duration_seconds)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Регистрация
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {formatDateTime(data.registered_at)}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Последняя активность
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {formatDateTime(data.last_activity)}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ListBlock title="Страницы" empty={data.pages.length === 0}>
          {data.pages.map((row) => (
            <li key={row.page} className="flex justify-between gap-3 py-2">
              <span className="truncate text-neutral-700">{row.page}</span>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {row.count}
              </span>
            </li>
          ))}
        </ListBlock>

        <ListBlock
          title="Просмотренные товары"
          empty={data.products_viewed.length === 0}
        >
          {data.products_viewed.map((row) => (
            <li key={row.product_id} className="flex justify-between gap-3 py-2">
              <Link
                href={`/staff/products/${row.product_id}`}
                className={`truncate text-[#0F766E] hover:text-[#0c5f58] ${focusRing}`}
              >
                {row.product_name ?? row.product_sku ?? row.product_id}
              </Link>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {row.views}
              </span>
            </li>
          ))}
        </ListBlock>

        <ListBlock title="Поиск" empty={data.searches.length === 0}>
          {data.searches.map((row) => (
            <li key={row.query} className="flex justify-between gap-3 py-2">
              <span className="truncate text-neutral-700">«{row.query}»</span>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {row.count}
              </span>
            </li>
          ))}
        </ListBlock>

        <ListBlock title="Добавлял в корзину" empty={data.cart_adds.length === 0}>
          {data.cart_adds.map((row) => (
            <li key={`add-${row.product_id}`} className="flex justify-between gap-3 py-2">
              <span className="truncate text-neutral-700">
                {row.product_name ?? row.product_id}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {row.count}
              </span>
            </li>
          ))}
        </ListBlock>

        <ListBlock
          title="Удалял из корзины"
          empty={data.cart_removes.length === 0}
        >
          {data.cart_removes.map((row) => (
            <li
              key={`rm-${row.product_id}`}
              className="flex justify-between gap-3 py-2"
            >
              <span className="truncate text-neutral-700">
                {row.product_name ?? row.product_id}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {row.count}
              </span>
            </li>
          ))}
        </ListBlock>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-neutral-800">
          Последние события
        </h3>
        {data.recent_events.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Нет событий</p>
        ) : (
          <ul className="mt-2 divide-y divide-neutral-100 text-sm">
            {data.recent_events.map((ev) => (
              <li
                key={ev.id}
                className="flex flex-wrap items-baseline justify-between gap-2 py-2"
              >
                <span className="text-neutral-800">
                  {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                  {ev.page ? (
                    <span className="ml-2 text-neutral-500">{ev.page}</span>
                  ) : null}
                </span>
                <span className="text-xs text-neutral-400">
                  {formatDateTime(ev.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
