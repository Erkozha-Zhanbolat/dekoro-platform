"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";
import { getClientAppOrigin } from "@/lib/auth/passwordSetup";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Укажите корректный email");
      return;
    }

    setIsSubmitting(true);
    const redirectTo = `${getClientAppOrigin()}/reset-password`;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      trimmed,
      { redirectTo },
    );
    setIsSubmitting(false);

    if (resetError) {
      setError(
        "Не удалось отправить письмо. Проверьте email и попробуйте снова.",
      );
      return;
    }

    // Always show success to avoid email enumeration.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-3xl font-bold text-neutral-800">Проверьте почту</h1>
        <p className="mt-4 text-sm text-neutral-600">
          Если аккаунт с таким email существует, мы отправили ссылку для сброса
          пароля. Откройте письмо и задайте новый пароль.
        </p>
        <p className="mt-6 text-sm text-neutral-600">
          <Link href="/login" className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}>
            Вернуться ко входу
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-3xl font-bold text-neutral-800">Восстановление пароля</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Для уже созданного аккаунта (в том числе после приглашения без пароля)
        отправьте ссылку сброса на email. Новое приглашение не создаётся.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-4">
        <div>
          <label htmlFor="forgot-email" className="block text-sm font-medium text-neutral-700">
            Email
          </label>
          <input
            id="forgot-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={`mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className={`mt-2 rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
        >
          {isSubmitting ? "Отправляем..." : "Отправить ссылку"}
        </button>
      </form>

      <p className="mt-6 text-sm text-neutral-600">
        <Link href="/login" className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}>
          Вернуться ко входу
        </Link>
      </p>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-6 py-16">
          <h1 className="text-3xl font-bold text-neutral-800">Восстановление пароля</h1>
          <p className="mt-4 text-neutral-600">Загрузка...</p>
        </div>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  );
}
