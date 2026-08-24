"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { ToastViewport } from "@/components/toast/ToastViewport";

export type ToastType = "success" | "error" | "warning" | "info";

export type ToastInput = {
  title: string;
  description?: string;
  duration?: number;
};

export type ToastItem = {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  duration: number;
  createdAt: number;
};

type ToastOptions = {
  duration?: number;
};

export type ToastApi = {
  success: (title: string, description?: string, options?: ToastOptions) => string;
  error: (title: string, description?: string, options?: ToastOptions) => string;
  warning: (title: string, description?: string, options?: ToastOptions) => string;
  info: (title: string, description?: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
};

const MAX_VISIBLE_TOASTS = 3;

const DEFAULT_DURATION_MS: Record<ToastType, number> = {
  success: 2800,
  info: 2800,
  warning: 4000,
  error: 5000,
};

type ToastContextValue = {
  toasts: ToastItem[];
  toast: ToastApi;
};

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

function createToastId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((current) => current.filter((item) => item.id !== id));
    },
    [clearTimer],
  );

  const dismissAll = useCallback(() => {
    for (const id of timersRef.current.keys()) {
      clearTimer(id);
    }
    setToasts([]);
  }, [clearTimer]);

  const push = useCallback(
    (type: ToastType, title: string, description?: string, options?: ToastOptions) => {
      const id = createToastId();
      const duration = options?.duration ?? DEFAULT_DURATION_MS[type];
      const nextItem: ToastItem = {
        id,
        type,
        title,
        description: description?.trim() ? description.trim() : undefined,
        duration,
        createdAt: Date.now(),
      };

      setToasts((current) => {
        const next = [...current, nextItem];
        if (next.length <= MAX_VISIBLE_TOASTS) {
          return next;
        }
        const overflow = next.slice(0, next.length - MAX_VISIBLE_TOASTS);
        for (const item of overflow) {
          clearTimer(item.id);
        }
        return next.slice(-MAX_VISIBLE_TOASTS);
      });

      if (duration > 0) {
        const timer = setTimeout(() => {
          dismiss(id);
        }, duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [clearTimer, dismiss],
  );

  const toast = useMemo<ToastApi>(
    () => ({
      success: (title, description, options) =>
        push("success", title, description, options),
      error: (title, description, options) =>
        push("error", title, description, options),
      warning: (title, description, options) =>
        push("warning", title, description, options),
      info: (title, description, options) =>
        push("info", title, description, options),
      dismiss,
      dismissAll,
    }),
    [push, dismiss, dismissAll],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, toast }),
    [toasts, toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast должен использоваться внутри ToastProvider");
  }
  return context.toast;
}
