"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  linkVisitorToProfile,
  trackEvent,
} from "@/lib/analytics/track";
import {
  getOrCreateSessionId,
  getOrCreateVisitorId,
} from "@/lib/analytics/identity";
import type { AnalyticsEventPayload } from "@/lib/analytics/types";

interface AnalyticsContextValue {
  track: (payload: AnalyticsEventPayload) => void;
  visitorId: string | null;
  sessionId: string | null;
}

const AnalyticsContext = createContext<AnalyticsContextValue | undefined>(
  undefined,
);

function AnalyticsInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const lastPageViewKey = useRef<string | null>(null);
  const linkedForUser = useRef<string | null>(null);

  const track = useCallback((payload: AnalyticsEventPayload) => {
    trackEvent(payload);
  }, []);

  // Ensure visitor/session exist on mount (client only).
  useEffect(() => {
    getOrCreateVisitorId();
    getOrCreateSessionId();
  }, []);

    // Page views — path only (no query) for privacy; one subscription, dedupe.
  useEffect(() => {
    if (!pathname || pathname.startsWith("/staff")) return;

    const page = pathname;
    const key = page;

    if (lastPageViewKey.current === key) return;
    lastPageViewKey.current = key;

    trackEvent({
      event_type: "page_view",
      page,
    });

    if (pathname === "/catalog") {
      trackEvent({ event_type: "catalog_open", page });
    }
    if (pathname === "/checkout") {
      trackEvent({ event_type: "checkout_start", page });
    }

    const productMatch = pathname.match(/^\/product\/([^/]+)$/);
    if (productMatch?.[1]) {
      const productId = productMatch[1];
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          productId,
        );
      trackEvent({
        event_type: "product_view",
        page,
        product_id: isUuid ? productId : null,
        metadata: isUuid ? {} : { static_product_id: productId },
      });
    }
  }, [pathname]);

  // Link visitor after auth (login/register events are emitted on those pages).
  useEffect(() => {
    if (authLoading) return;

    const userId = user?.id ?? null;

    if (userId && linkedForUser.current !== userId) {
      linkedForUser.current = userId;
      void linkVisitorToProfile();
    }
  }, [user, authLoading]);

  const value = useMemo<AnalyticsContextValue>(
    () => ({
      track,
      visitorId: null,
      sessionId: null,
    }),
    [track],
  );

  return (
    <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
  );
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  return (
    <AnalyticsInner>{children}</AnalyticsInner>
  );
}

export function useAnalytics(): AnalyticsContextValue {
  const context = useContext(AnalyticsContext);
  if (!context) {
    throw new Error("useAnalytics должен использоваться внутри AnalyticsProvider");
  }
  return context;
}
