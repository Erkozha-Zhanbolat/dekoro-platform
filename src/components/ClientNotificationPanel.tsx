"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import type { ClientNotification } from "@/types/database";
import { formatClientNotificationRelativeTime } from "@/lib/client/notifications";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export type ClientNotificationPanelProps = {
  panelId: string;
  items: ClientNotification[];
  loading: boolean;
  error: string | null;
  unreadCount: number;
  markingAll: boolean;
  nowMs: number;
  onMarkAll: () => void;
  onClose: () => void;
  onItemClick: (event: MouseEvent<HTMLAnchorElement>, item: ClientNotification) => void;
};

export default function ClientNotificationPanel({
  panelId,
  items,
  loading,
  error,
  unreadCount,
  markingAll,
  nowMs,
  onMarkAll,
  onClose,
  onItemClick,
}: ClientNotificationPanelProps) {
  return (
    <div
      id={panelId}
      role="dialog"
      aria-label="Уведомления"
      className="absolute right-0 z-40 mt-2 w-[min(100vw-2rem,22rem)] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg sm:w-96"
    >
      <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
        <p className="text-sm font-semibold text-neutral-800">Уведомления</p>
        <button
          type="button"
          disabled={markingAll || unreadCount === 0}
          onClick={onMarkAll}
          className={`text-xs font-medium text-[#0F766E] transition-colors hover:text-[#0d635c] disabled:cursor-not-allowed disabled:text-neutral-300 ${focusRing} rounded-sm`}
        >
          Отметить все прочитанными
        </button>
      </div>

      <div className="max-h-[min(70vh,24rem)] overflow-y-auto">
        {loading && items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">Загрузка…</p>
        ) : error ? (
          <p className="px-4 py-6 text-center text-sm text-red-600">{error}</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-neutral-500">Нет уведомлений</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((item) => {
              const unreadItem = !item.read_at;
              return (
                <li key={item.id}>
                  <Link
                    href={item.action_url || "/notifications"}
                    onClick={(event) => onItemClick(event, item)}
                    className={`block px-4 py-3 transition-colors hover:bg-neutral-50 ${
                      unreadItem ? "bg-[#0F766E]/[0.04]" : ""
                    }`}
                  >
                    <div className="flex gap-2">
                      <span
                        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          unreadItem ? "bg-[#0F766E]" : "bg-transparent"
                        }`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm leading-snug text-neutral-800 ${
                            unreadItem ? "font-semibold" : "font-medium"
                          }`}
                        >
                          {item.title}
                        </p>
                        {item.message ? (
                          <p className="mt-0.5 truncate text-xs text-neutral-500">
                            {item.message}
                          </p>
                        ) : null}
                        <p className="mt-1 text-[11px] text-neutral-400">
                          {formatClientNotificationRelativeTime(item.created_at, nowMs)}
                        </p>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-neutral-100 px-4 py-2.5">
        <Link
          href="/notifications"
          onClick={onClose}
          className={`text-xs font-medium text-[#0F766E] hover:text-[#0d635c] ${focusRing} rounded-sm`}
        >
          Все уведомления
        </Link>
      </div>
    </div>
  );
}
