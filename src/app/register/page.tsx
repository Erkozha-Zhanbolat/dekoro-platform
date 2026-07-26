"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIN_PATTERN = /^\d{12}$/;

interface FormState {
  companyName: string;
  bin: string;
  contactPerson: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

const initialFormState: FormState = {
  companyName: "",
  bin: "",
  contactPerson: "",
  phone: "",
  email: "",
  password: "",
  confirmPassword: "",
};

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.companyName.trim()) {
    errors.companyName = "Укажите наименование компании";
  }

  if (!BIN_PATTERN.test(form.bin.trim())) {
    errors.bin = "БИН должен содержать ровно 12 цифр";
  }

  if (!form.contactPerson.trim()) {
    errors.contactPerson = "Укажите контактное лицо";
  }

  if (!form.phone.trim()) {
    errors.phone = "Укажите телефон";
  }

  if (!EMAIL_PATTERN.test(form.email.trim())) {
    errors.email = "Введите корректный email";
  }

  if (form.password.length < 6) {
    errors.password = "Пароль должен содержать не менее 6 символов";
  }

  if (form.confirmPassword !== form.password) {
    errors.confirmPassword = "Пароли не совпадают";
  }

  return errors;
}

export default function RegisterPage() {
  const router = useRouter();
  const { signUp } = useAuth();
  const [form, setForm] = useState<FormState>(initialFormState);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const validationErrors = validate(form);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);

    const { error, needsEmailConfirmation: requiresConfirmation } = await signUp(
      form.email.trim(),
      form.password,
      {
        company_name: form.companyName.trim(),
        bin: form.bin.trim(),
        contact_person: form.contactPerson.trim(),
        phone: form.phone.trim(),
      },
    );

    setIsSubmitting(false);

    if (error) {
      setFormError(error);
      return;
    }

    if (requiresConfirmation) {
      setNeedsEmailConfirmation(true);
      return;
    }

    router.push("/profile");
  }

  if (needsEmailConfirmation) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">Регистрация</h1>
        <p className="mt-4 text-neutral-600">
          Мы отправили письмо для подтверждения на адрес{" "}
          <span className="font-medium text-neutral-800">{form.email.trim()}</span>.
          Перейдите по ссылке из письма, чтобы подтвердить email и войти в
          личный кабинет.
        </p>
        <Link
          href="/login"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          Перейти ко входу
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold text-neutral-800">Регистрация</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Создайте аккаунт компании, чтобы оформлять заказы и отслеживать их
        статус.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Компания"
            value={form.companyName}
            onChange={(value) => updateField("companyName", value)}
            error={errors.companyName}
            autoComplete="organization"
          />
          <TextField
            label="БИН"
            value={form.bin}
            onChange={(value) => updateField("bin", value)}
            error={errors.bin}
            inputMode="numeric"
            maxLength={12}
          />
          <TextField
            label="Контактное лицо"
            value={form.contactPerson}
            onChange={(value) => updateField("contactPerson", value)}
            error={errors.contactPerson}
            autoComplete="name"
          />
          <TextField
            label="Телефон"
            value={form.phone}
            onChange={(value) => updateField("phone", value)}
            error={errors.phone}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
          />
          <TextField
            label="Email"
            value={form.email}
            onChange={(value) => updateField("email", value)}
            error={errors.email}
            type="email"
            inputMode="email"
            autoComplete="email"
            className="sm:col-span-2"
          />
          <TextField
            label="Пароль"
            value={form.password}
            onChange={(value) => updateField("password", value)}
            error={errors.password}
            type="password"
            autoComplete="new-password"
          />
          <TextField
            label="Повтор пароля"
            value={form.confirmPassword}
            onChange={(value) => updateField("confirmPassword", value)}
            error={errors.confirmPassword}
            type="password"
            autoComplete="new-password"
          />
        </div>

        {formError && <p className="text-sm text-red-600">{formError}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className={`mt-2 self-start rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
        >
          {isSubmitting ? "Регистрируем..." : "Зарегистрироваться"}
        </button>
      </form>

      <p className="mt-6 text-sm text-neutral-600">
        Уже есть аккаунт?{" "}
        <Link href="/login" className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}>
          Войти
        </Link>
      </p>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  type = "text",
  inputMode,
  maxLength,
  autoComplete,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: string;
  inputMode?: "text" | "numeric" | "tel" | "email";
  maxLength?: number;
  autoComplete?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-neutral-700">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        className={`mt-1 w-full rounded-md border px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 ${
          error
            ? "border-red-300 focus:border-red-400 focus:ring-1 focus:ring-red-400"
            : "border-neutral-200 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E]"
        } ${focusRing}`}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
