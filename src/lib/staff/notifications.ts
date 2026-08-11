import { supabase } from "@/lib/supabase/client";
import type { StaffNotification, StaffNotificationType } from "@/types/database";

/**
 * Staff in-app notifications (supabase/migrations/029_staff_notifications.sql).
 * All access goes through SECURITY DEFINER RPCs — recipient is always auth.uid().
 */

export type { StaffNotification, StaffNotificationType };

const HEADER_LIMIT = 20;

function mapNotification(row: Record<string, unknown>): StaffNotification {
  return {
    id: String(row.id),
    notification_type: String(row.notification_type) as StaffNotificationType,
    title: String(row.title),
    message: row.message == null ? null : String(row.message),
    entity_type: row.entity_type == null ? null : String(row.entity_type),
    entity_id: row.entity_id == null ? null : String(row.entity_id),
    action_url: row.action_url == null ? null : String(row.action_url),
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    read_at: row.read_at == null ? null : String(row.read_at),
    created_at: String(row.created_at),
  };
}

/** Header dropdown: latest notifications for the current staff user. */
export async function listStaffNotificationsHeader(
  limit = HEADER_LIMIT,
): Promise<StaffNotification[]> {
  return listStaffNotifications({ limit, unreadOnly: false, offset: 0 });
}

export async function listStaffNotifications(options?: {
  limit?: number;
  unreadOnly?: boolean;
  offset?: number;
}): Promise<StaffNotification[]> {
  const { data, error } = await supabase.rpc("staff_list_notifications", {
    p_limit: options?.limit ?? 30,
    p_unread_only: options?.unreadOnly ?? false,
    p_offset: options?.offset ?? 0,
  });
  if (error) {
    throw new Error(error.message || "Не удалось загрузить уведомления");
  }
  return ((data as Record<string, unknown>[] | null) ?? []).map(mapNotification);
}

export async function getUnreadNotificationCount(): Promise<number> {
  const { data, error } = await supabase.rpc("staff_get_unread_notification_count");
  if (error) {
    throw new Error(error.message || "Не удалось получить число непрочитанных");
  }
  const n = Number(data ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function markNotificationRead(notificationId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("staff_mark_notification_read", {
    p_notification_id: notificationId,
  });
  if (error) {
    throw new Error(error.message || "Не удалось отметить уведомление");
  }
  return Boolean(data);
}

export async function markAllNotificationsRead(): Promise<number> {
  const { data, error } = await supabase.rpc("staff_mark_all_notifications_read");
  if (error) {
    throw new Error(error.message || "Не удалось отметить все уведомления");
  }
  const n = Number(data ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Relative time for notification lists (ru). */
export function formatNotificationRelativeTime(
  iso: string,
  nowMs: number = Date.now(),
): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";

  const diffSec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (diffSec < 60) return "только что";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} ${pluralRu(diffMin, "минуту", "минуты", "минут")} назад`;
  }

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour} ${pluralRu(diffHour, "час", "часа", "часов")} назад`;
  }

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) {
    return `${diffDay} ${pluralRu(diffDay, "день", "дня", "дней")} назад`;
  }

  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatUnreadBadge(count: number): string {
  if (count <= 0) return "";
  if (count > 99) return "99+";
  return String(count);
}
