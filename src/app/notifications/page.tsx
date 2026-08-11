"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import type { ClientNotification } from "@/types/database";
import {
  formatClientNotificationRelativeTime,
  listClientNotifications,
  markAllClientNotificationsRead,
  markClientNotificationRead,
} from "@/lib/client/notifications";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const PAGE_SIZE = 30;

type FilterMode = "all" | "unread";

export default function ClientNotificationsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const currentUserId = user?.id ?? null;
  const [filter, setFilter] = useState<FilterMode>("all");
  const [items, setItems] = useState<ClientNotification[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reloadToken, setReloadToken] = useState(0);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);

  // Shared browser / account switch: drop previous client's list before paint.
  if (!authLoading && loadedUserId !== currentUserId) {
    setLoadedUserId(currentUserId);
    setItems([]);
    setOffset(0);
    setHasMore(false);
    setLoading(Boolean(currentUserId));
    setError(null);
    setFilter("all");
    setReloadToken((token) => token + 1);
  }

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/login");
    }
  }, [authLoading, user, router]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    setError(null);
    try {
      const rows = await listClientNotifications({
        limit: PAGE_SIZE,
        unreadOnly: filter === "unread",
        offset,
      });
      setItems((prev) => [...prev, ...rows]);
      setOffset((prev) => prev + rows.length);
      setHasMore(rows.length === PAGE_SIZE);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить уведомления");
    } finally {
      setLoadingMore(false);
    }
  }, [filter, offset]);

  useEffect(() => {
    if (!user) return;

    let ignore = false;
    const timer = window.setTimeout(() => {
      listClientNotifications({
        limit: PAGE_SIZE,
        unreadOnly: filter === "unread",
        offset: 0,
      })
        .then((rows) => {
          if (ignore) return;
          setItems(rows);
          setOffset(rows.length);
          setHasMore(rows.length === PAGE_SIZE);
          setNowMs(Date.now());
          setLoading(false);
          setError(null);
        })
        .catch((err: unknown) => {
          if (ignore) return;
          setError(err instanceof Error ? err.message : "Не удалось загрузить уведомления");
          setItems([]);
          setOffset(0);
          setHasMore(false);
          setLoading(false);
        });
    }, 0);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [filter, reloadToken, user]);

  function handleFilterChange(next: FilterMode) {
    if (next === filter) return;
    setLoading(true);
    setFilter(next);
  }

  async function handleMarkAll() {
    setMarkingAll(true);
    setError(null);
    try {
      await markAllClientNotificationsRead();
      setLoading(true);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отметить все");
    } finally {
      setMarkingAll(false);
    }
  }

  async function handleItemClick(item: ClientNotification) {
    try {
      if (!item.read_at) {
        await markClientNotificationRead(item.id);
        setItems((prev) =>
          prev.map((row) =>
            row.id === item.id
              ? { ...row, read_at: row.read_at ?? new Date().toISOString() }
              : row,
          ),
        );
      }
    } catch {
      // Navigate anyway.
    }
    router.push(item.action_url || "/orders");
  }

  if (authLoading || !user) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="text-sm text-neutral-500">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-800">Уведомления</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Статусы ваших заказов DEKORO
          </p>
        </div>
        <button
          type="button"
          disabled={markingAll}
          onClick={() => void handleMarkAll()}
          className={`rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 ${focusRing}`}
        >
          Отметить все прочитанными
        </button>
      </div>

      <div className="flex gap-2">
        {(
          [
            ["all", "Все"],
            ["unread", "Непрочитанные"],
          ] as const
        ).map(([value, label]) => {
          const active = filter === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleFilterChange(value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${focusRing} ${
                active
                  ? "bg-[#0F766E] text-white"
                  : "bg-white text-neutral-600 ring-1 ring-neutral-200 hover:text-[#0F766E]"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div
          className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-neutral-500">Загрузка…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white px-5 py-10 text-center">
          <p className="text-sm text-neutral-500">
            {filter === "unread" ? "Нет непрочитанных уведомлений" : "Нет уведомлений"}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200 bg-white">
          {items.map((item) => {
            const unread = !item.read_at;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => void handleItemClick(item)}
                  className={`flex w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-neutral-50 ${
                    unread ? "bg-[#0F766E]/[0.03]" : ""
                  } ${focusRing}`}
                >
                  <span
                    className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                      unread ? "bg-[#0F766E]" : "bg-transparent"
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm text-neutral-800 ${
                        unread ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {item.title}
                    </p>
                    {item.message ? (
                      <p className="mt-0.5 text-sm text-neutral-500">{item.message}</p>
                    ) : null}
                    <p className="mt-1.5 text-xs text-neutral-400">
                      {formatClientNotificationRelativeTime(item.created_at, nowMs)}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 ${focusRing}`}
          >
            {loadingMore ? "Загрузка…" : "Показать ещё"}
          </button>
        </div>
      ) : null}

      <p className="text-xs text-neutral-400">
        <Link href="/orders" className={`hover:text-[#0F766E] ${focusRing} rounded-sm`}>
          ← К заказам
        </Link>
      </p>
    </div>
  );
}
