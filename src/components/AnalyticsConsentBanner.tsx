"use client";

import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
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

function consentLabel(consent: AnalyticsConsent): string {
  if (consent === "granted") return "Разрешена";
  if (consent === "denied") return "Отключена";
  return "Не выбрано";
}

function AnalyticsConsentModal({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const consent = useAnalyticsConsentState();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function choose(value: "granted" | "denied") {
    applyAnalyticsConsentDecision(value);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 py-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-semibold text-neutral-800">
          Аналитика
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          Текущий выбор:
          <span className="ml-1 font-medium text-neutral-800">{consentLabel(consent)}</span>
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => choose("granted")} className={equalButton}>
            Разрешить
          </button>
          <button type="button" onClick={() => choose("denied")} className={equalButton}>
            Отказаться
          </button>
        </div>
      </div>
    </div>
  );
}

/** Footer-only: quiet link. Never renders the full consent block. */
export function AnalyticsConsentFooterLink() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-sm text-neutral-500 transition-colors hover:text-[#0F766E] ${focusRing}`}
      >
        Настройки аналитики
      </button>
      {open ? <AnalyticsConsentModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Dedicated profile section — not for the storefront footer. */
export function AnalyticsConsentSettings({
  className,
}: {
  className?: string;
}) {
  const consent = useAnalyticsConsentState();

  return (
    <div className={className}>
      <p className="text-sm font-medium text-neutral-800">Настройки аналитики</p>
      <p className="mt-1 text-sm text-neutral-500">
        Текущий выбор: {consentLabel(consent)}. Помогает улучшать каталог DEKORO.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => applyAnalyticsConsentDecision("granted")}
          className={equalButton}
        >
          Разрешить
        </button>
        <button
          type="button"
          onClick={() => applyAnalyticsConsentDecision("denied")}
          className={equalButton}
        >
          Отказаться
        </button>
      </div>
    </div>
  );
}
