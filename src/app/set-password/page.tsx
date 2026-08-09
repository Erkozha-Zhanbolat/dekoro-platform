"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";
import {
  MIN_PASSWORD_LENGTH,
  readAuthRedirectError,
  validateNewPassword,
} from "@/lib/auth/passwordSetup";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const INVALID_INVITE_MESSAGE =
  "Ссылка приглашения недействительна или устарела. Запросите новое приглашение у администратора.";

type GateStatus = "loading" | "ready" | "invalid";

function SetPasswordForm() {
  const router = useRouter();
  const [gate, setGate] = useState<GateStatus>("loading");
  const [gateError, setGateError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let settled = false;

    function markReady() {
      if (cancelled || settled) return;
      settled = true;
      setGate("ready");
      setGateError(null);
    }

    function markInvalid(message: string) {
      if (cancelled || settled) return;
      settled = true;
      setGate("invalid");
      setGateError(message);
    }

    const redirectError = readAuthRedirectError(INVALID_INVITE_MESSAGE);
    if (redirectError) {
      markInvalid(redirectError);
      return;
    }

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (cancelled) return;
        if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "PASSWORD_RECOVERY" || event === "TOKEN_REFRESHED")) {
          markReady();
        }
      },
    );

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) {
        markReady();
        return;
      }

      // Allow supabase-js to finish detectSessionInUrl (hash / PKCE code).
      await new Promise((r) => setTimeout(r, 1200));
      if (cancelled || settled) return;

      const { data: again } = await supabase.auth.getSession();
      if (again.session) {
        markReady();
      } else {
        markInvalid(INVALID_INVITE_MESSAGE);
      }
    })();

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const validationError = validateNewPassword(password, confirmPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password,
    });
    setIsSubmitting(false);

    if (updateError) {
      setError(
        updateError.message.toLowerCase().includes("session")
          ? INVALID_INVITE_MESSAGE
          : "Не удалось сохранить пароль. Попробуйте ещё раз или запросите новое приглашение.",
      );
      return;
    }

    router.replace("/staff");
  }

  if (gate === "loading") {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-bold text-neutral-800">Установка пароля</h1>
        <p className="mt-4 text-neutral-600">Проверяем приглашение...</p>
      </div>
    );
  }

  if (gate === "invalid") {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-bold text-neutral-800">Установка пароля</h1>
        <p className="mt-4 text-sm text-red-600">{gateError ?? INVALID_INVITE_MESSAGE}</p>
        <p className="mt-6 text-sm text-neutral-600">
          Уже устанавливали пароль?{" "}
          <Link href="/login" className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}>
            Войти
          </Link>
          {" · "}
          <Link
            href="/forgot-password"
            className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}
          >
            Восстановить пароль
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold text-neutral-800">Установка пароля</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Задайте пароль для входа в Staff Platform. Минимум {MIN_PASSWORD_LENGTH}{" "}
        символов.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-4">
        <div>
          <label htmlFor="set-password" className="block text-sm font-medium text-neutral-700">
            Новый пароль
          </label>
          <input
            id="set-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={`mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
          />
        </div>

        <div>
          <label
            htmlFor="set-password-confirm"
            className="block text-sm font-medium text-neutral-700"
          >
            Подтверждение пароля
          </label>
          <input
            id="set-password-confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className={`mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className={`mt-2 rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
        >
          {isSubmitting ? "Сохраняем..." : "Сохранить пароль"}
        </button>
      </form>
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-6 py-16">
          <h1 className="text-3xl font-bold text-neutral-800">Установка пароля</h1>
          <p className="mt-4 text-neutral-600">Загрузка...</p>
        </div>
      }
    >
      <SetPasswordForm />
    </Suspense>
  );
}
