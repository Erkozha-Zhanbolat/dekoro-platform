"use client";

import type { ComponentType } from "react";
import type { ToastItem, ToastType } from "@/context/ToastContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 2.8 19.5a1 1 0 0 0 .9 1.5h16.6a1 1 0 0 0 .9-1.5L12 3.5z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ErrorIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6" />
      <path d="M9 9l6 6" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

const ICON_BY_TYPE: Record<ToastType, ComponentType<{ className?: string }>> = {
  success: CheckIcon,
  info: InfoIcon,
  warning: WarningIcon,
  error: ErrorIcon,
};

const ICON_CLASS_BY_TYPE: Record<ToastType, string> = {
  success: "text-[#0F766E]",
  info: "text-neutral-500",
  warning: "text-amber-600",
  error: "text-red-600",
};

const ACCENT_BAR_BY_TYPE: Record<ToastType, string> = {
  success: "bg-[#0F766E]",
  info: "bg-neutral-300",
  warning: "bg-amber-500",
  error: "bg-red-500",
};

type ToastCardProps = {
  item: ToastItem;
  onDismiss: (id: string) => void;
};

function ToastCard({ item, onDismiss }: ToastCardProps) {
  const Icon = ICON_BY_TYPE[item.type];
  const showClose = item.type === "error" || item.type === "warning";
  const live = item.type === "error" ? "assertive" : "polite";
  const role = item.type === "error" ? "alert" : "status";

  return (
    <div
      role={role}
      aria-live={live}
      aria-atomic="true"
      className="pointer-events-auto relative flex w-full max-w-sm overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md toast-enter motion-reduce:animate-none"
    >
      <span
        className={`w-1 shrink-0 ${ACCENT_BAR_BY_TYPE[item.type]}`}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5">
        <span
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${ICON_CLASS_BY_TYPE[item.type]}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5 text-neutral-800">{item.title}</p>
          {item.description ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-neutral-500">
              {item.description}
            </p>
          ) : null}
        </div>
        {showClose ? (
          <button
            type="button"
            onClick={() => onDismiss(item.id)}
            aria-label="Закрыть уведомление"
            className={`-mr-1 -mt-0.5 rounded-md p-1 text-neutral-400 transition-colors hover:text-neutral-700 ${focusRing}`}
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

type ToastViewportProps = {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
};

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-stretch gap-2 p-3 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:items-end sm:p-0"
      aria-label="Уведомления"
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
