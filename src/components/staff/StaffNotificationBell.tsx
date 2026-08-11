"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { StaffNotification } from "@/types/database";
import {
  formatUnreadBadge,
  getUnreadNotificationCount,
  listStaffNotificationsHeader,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/staff/notifications";
import { supabase } from "@/lib/supabase/client";
import StaffNotificationPanel from "@/components/staff/StaffNotificationPanel";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const POLL_MS = 30_000;
const HEADER_LIMIT = 20;

function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

type StaffNotificationBellProps = {
  profileId: string;
};

export default function StaffNotificationBell({ profileId }: StaffNotificationBellProps) {
  const router = useRouter();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<StaffNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const refreshCount = useCallback(async () => {
    try {
      const count = await getUnreadNotificationCount();
      setUnread(count);
    } catch {
      // Soft-fail before migration is applied.
    }
  }, []);

  const refreshList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listStaffNotificationsHeader(HEADER_LIMIT);
      setItems(rows);
      setNowMs(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить уведомления");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial + polling (deferred so setState is not sync inside the effect body).
  useEffect(() => {
    const boot = window.setTimeout(() => {
      void refreshCount();
    }, 0);

    const poll = window.setInterval(() => {
      void refreshCount();
      if (openRef.current) void refreshList();
    }, POLL_MS);

    return () => {
      window.clearTimeout(boot);
      window.clearInterval(poll);
    };
  }, [refreshCount, refreshList]);

  // Safe Realtime: RLS limits rows to recipient_profile_id = auth.uid().
  useEffect(() => {
    const channel = supabase
      .channel(`staff_notifications:${profileId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "staff_notifications",
          filter: `recipient_profile_id=eq.${profileId}`,
        },
        () => {
          void refreshCount();
          if (openRef.current) void refreshList();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileId, refreshCount, refreshList]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function handleToggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next) void refreshList();
      return next;
    });
  }

  async function handleMarkAll() {
    setMarkingAll(true);
    setError(null);
    try {
      await markAllNotificationsRead();
      await Promise.all([refreshCount(), refreshList()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отметить все");
    } finally {
      setMarkingAll(false);
    }
  }

  async function handleItemClick(
    event: MouseEvent<HTMLAnchorElement>,
    item: StaffNotification,
  ) {
    event.preventDefault();
    try {
      if (!item.read_at) {
        await markNotificationRead(item.id);
        setUnread((c) => Math.max(0, c - 1));
        setItems((prev) =>
          prev.map((row) =>
            row.id === item.id ? { ...row, read_at: row.read_at ?? new Date().toISOString() } : row,
          ),
        );
      }
    } catch {
      // Still navigate.
    }
    setOpen(false);
    router.push(item.action_url || "/staff/notifications");
  }

  const badge = formatUnreadBadge(unread);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Уведомления, непрочитанных: ${unread}` : "Уведомления"}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={handleToggle}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
      >
        <BellIcon className="h-5 w-5" />
        {badge ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <StaffNotificationPanel
          panelId={panelId}
          items={items}
          loading={loading}
          error={error}
          unreadCount={unread}
          markingAll={markingAll}
          nowMs={nowMs}
          onMarkAll={() => void handleMarkAll()}
          onClose={() => setOpen(false)}
          onItemClick={(event, item) => void handleItemClick(event, item)}
        />
      ) : null}
    </div>
  );
}
