"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  getAnalyticsConsent,
  subscribeAnalyticsConsent,
  type AnalyticsConsent,
} from "@/lib/analytics/consent";
import { applyAnalyticsConsentDecision } from "@/lib/analytics/track";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const equalButton =
  `rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-neutral-400 ${focusRing}`;

function subscribe(onStoreChange: () => void): () => void {
  return subscribeAnalyticsConsent(() => onStoreChange());
}

function useHasMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function useAnalyticsConsentState(): AnalyticsConsent {
  return useSyncExternalStore(
    subscribe,
    getAnalyticsConsent,
    () => "unset" as const,
  );
}

/**
 * First-visit consent banner — rendered only while consent is unset.
 * Client-only after mount so a stored granted/denied decision never
 * leaves a leftover SSR banner on screen.
 */
export function AnalyticsConsentBanner() {
  const mounted = useHasMounted();
  const consent = useAnalyticsConsentState();

  const deny = useCallback(() => {
    applyAnalyticsConsentDecision("denied");
  }, []);

  const allow = useCallback(() => {
    applyAnalyticsConsentDecision("granted");
  }, []);

  if (!mounted || consent !== "unset") {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label="Настройки аналитики"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-neutral-200 bg-white px-4 py-4 shadow-[0_-4px_24px_rgba(0,0,0,0.06)]"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-neutral-700">
          Мы используем аналитику, чтобы улучшать каталог и работу платформы.
        </p>
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          <button type="button" onClick={deny} className={equalButton}>
            Отказаться
          </button>
          <button type="button" onClick={allow} className={equalButton}>
            Разрешить
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compact controls for profile / footer «Настройки аналитики». */
export function AnalyticsConsentSettings({
  className,
}: {
  className?: string;
}) {
  const consent = useAnalyticsConsentState();

  const label =
    consent === "granted"
      ? "Разрешена"
      : consent === "denied"
        ? "Отключена"
        : "Не выбрано";

  return (
    <div className={className}>
      <p className="text-sm font-medium text-neutral-800">Настройки аналитики</p>
      <p className="mt-1 text-sm text-neutral-500">
        Сейчас: {label}. Помогает улучшать каталог DEKORO.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => applyAnalyticsConsentDecision("granted")}
          className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${focusRing} ${
            consent === "granted"
              ? "bg-[#0F766E] text-white"
              : "border border-neutral-200 text-neutral-700 hover:border-[#0F766E]"
          }`}
        >
          Разрешить аналитику
        </button>
        <button
          type="button"
          onClick={() => applyAnalyticsConsentDecision("denied")}
          className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${focusRing} ${
            consent === "denied"
              ? "bg-neutral-800 text-white"
              : "border border-neutral-200 text-neutral-700 hover:border-neutral-400"
          }`}
        >
          Отказаться
        </button>
      </div>
    </div>
  );
}
