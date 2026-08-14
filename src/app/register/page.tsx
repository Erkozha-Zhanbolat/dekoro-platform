"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import type { SignUpMetadata } from "@/context/AuthContext";
import { getSafeNextPath, isSafeNextPath } from "@/lib/safeNextPath";
import { flushAnalytics, linkVisitorToProfile, recordAuthEvent } from "@/lib/analytics/track";
import {
  normalizeCustomerEmail,
  normalizeCustomerPhone,
} from "@/lib/staff/customerDetails";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIN_PATTERN = /^\d{12}$/;

type RegistrationKind = "individual" | "ip" | "too";

interface FormState {
  name: string;
  companyName: string;
  bin: string;
  city: string;
  address: string;
  contactPerson: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

const initialFormState: FormState = {
  name: "",
  companyName: "",
  bin: "",
  city: "",
  address: "",
  contactPerson: "",
  phone: "",
  email: "",
  password: "",
  confirmPassword: "",
};

function validate(form: FormState, kind: RegistrationKind): FormErrors {
  const errors: FormErrors = {};
  const phone = normalizeCustomerPhone(form.phone);
  const email = normalizeCustomerEmail(form.email);
  const city = form.city.trim();

  if (!phone) {
    errors.phone = "Укажите телефон";
  }

  if (!EMAIL_PATTERN.test(email)) {
    errors.email = "Введите корректный email";
  }

  if (!city) {
    errors.city = "Укажите город";
  }

  if (form.password.length < 6) {
    errors.password = "Пароль должен содержать не менее 6 символов";
  }

  if (form.confirmPassword !== form.password) {
    errors.confirmPassword = "Пароли не совпадают";
  }

  if (kind === "individual") {
    if (!form.name.trim()) {
      errors.name = "Укажите ФИО";
    }
    return errors;
  }

  if (!form.companyName.trim()) {
    errors.companyName =
      kind === "ip" ? "Укажите наименование ИП" : "Укажите юридическое название";
  }

  if (!BIN_PATTERN.test(form.bin.trim())) {
    errors.bin =
      kind === "ip"
        ? "БИН / ИИН должен содержать ровно 12 цифр"
        : "БИН должен содержать ровно 12 цифр";
  }

  if (!form.address.trim()) {
    errors.address = "Укажите юридический адрес";
  }

  if (!form.contactPerson.trim()) {
    errors.contactPerson = "Укажите контактное лицо";
  }

  return errors;
}

function buildSignUpMetadata(form: FormState, kind: RegistrationKind): SignUpMetadata {
  const phone = normalizeCustomerPhone(form.phone);
  const city = form.city.trim();

  if (kind === "individual") {
    return {
      customer_type: "individual",
      name: form.name.trim(),
      phone,
      city,
    };
  }

  return {
    customer_type: "company",
    company_name: form.companyName.trim(),
    bin: form.bin.trim(),
    contact_person: form.contactPerson.trim(),
    phone,
    city,
    address: form.address.trim(),
  };
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signUp } = useAuth();
  const [kind, setKind] = useState<RegistrationKind | null>(null);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);

  const rawNext = searchParams.get("next");
  const nextPath = getSafeNextPath(rawNext);
  const loginHref =
    rawNext != null && isSafeNextPath(rawNext)
      ? `/login?next=${encodeURIComponent(rawNext)}`
      : "/login";

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function selectKind(nextKind: RegistrationKind) {
    if (nextKind === kind) {
      return;
    }
    setKind(nextKind);
    setErrors({});
    setFormError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!kind) {
      setFormError("Выберите тип клиента");
      return;
    }

    const validationErrors = validate(form, kind);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);

    const { error, needsEmailConfirmation: requiresConfirmation } = await signUp(
      normalizeCustomerEmail(form.email),
      form.password,
      buildSignUpMetadata(form, kind),
    );

    setIsSubmitting(false);

    if (error) {
      setFormError(error);
      return;
    }

    if (requiresConfirmation) {
      await flushAnalytics();
      setNeedsEmailConfirmation(true);
      return;
    }

    await linkVisitorToProfile();
    await recordAuthEvent("register");
    await flushAnalytics();
    router.replace(nextPath);
  }

  if (needsEmailConfirmation) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">Регистрация</h1>
        <p className="mt-4 text-neutral-600">
          Мы отправили письмо для подтверждения на адрес{" "}
          <span className="font-medium text-neutral-800">
            {normalizeCustomerEmail(form.email)}
          </span>
          . Перейдите по ссылке из письма, чтобы подтвердить email и войти в
          личный кабинет.
        </p>
        <Link
          href={loginHref}
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
        Сначала выберите тип клиента — форма покажет только нужные поля.
      </p>

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Тип клиента">
        <TypeToggle
          label="Физическое лицо"
          active={kind === "individual"}
          onClick={() => selectKind("individual")}
        />
        <TypeToggle
          label="ИП"
          active={kind === "ip"}
          onClick={() => selectKind("ip")}
        />
        <TypeToggle
          label="ТОО"
          active={kind === "too"}
          onClick={() => selectKind("too")}
        />
      </div>

      {!kind ? (
        <p className="mt-8 text-sm text-neutral-500">Выберите тип клиента, чтобы продолжить.</p>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-8">
          {kind === "individual" ? (
            <section className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Личные данные
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField
                  label="ФИО"
                  value={form.name}
                  onChange={(value) => updateField("name", value)}
                  error={errors.name}
                  autoComplete="name"
                  className="sm:col-span-2"
                />
                <TextField
                  label="Город"
                  value={form.city}
                  onChange={(value) => updateField("city", value)}
                  error={errors.city}
                  autoComplete="address-level2"
                  placeholder="Алматы"
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
              </div>
            </section>
          ) : (
            <>
              <section className="flex flex-col gap-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  {kind === "ip" ? "Об ИП" : "О компании"}
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    label={kind === "ip" ? "Юридическое название / Наименование ИП" : "Юридическое название"}
                    value={form.companyName}
                    onChange={(value) => updateField("companyName", value)}
                    error={errors.companyName}
                    autoComplete="organization"
                    placeholder={kind === "ip" ? "ИП Иванов" : "ТОО DEKORO TRADE"}
                    className="sm:col-span-2"
                  />
                  <TextField
                    label={kind === "ip" ? "БИН / ИИН бизнеса" : "БИН"}
                    value={form.bin}
                    onChange={(value) => updateField("bin", value)}
                    error={errors.bin}
                    inputMode="numeric"
                    maxLength={12}
                    placeholder="123456789012"
                  />
                </div>
              </section>

              <section className="flex flex-col gap-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Адрес
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    label="Город"
                    value={form.city}
                    onChange={(value) => updateField("city", value)}
                    error={errors.city}
                    autoComplete="address-level2"
                    placeholder="Алматы"
                  />
                  <TextField
                    label="Юридический адрес"
                    value={form.address}
                    onChange={(value) => updateField("address", value)}
                    error={errors.address}
                    autoComplete="street-address"
                    placeholder="г. Алматы, ул. Абая, 150, офис 25"
                    className="sm:col-span-2"
                  />
                </div>
              </section>

              <section className="flex flex-col gap-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  Контактные данные
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    label="Контактное лицо"
                    value={form.contactPerson}
                    onChange={(value) => updateField("contactPerson", value)}
                    error={errors.contactPerson}
                    autoComplete="name"
                    className="sm:col-span-2"
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
                  />
                </div>
              </section>
            </>
          )}

          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Доступ
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Пароль"
                value={form.password}
                onChange={(value) => updateField("password", value)}
                error={errors.password}
                type="password"
                autoComplete="new-password"
              />
              <TextField
                label="Подтверждение пароля"
                value={form.confirmPassword}
                onChange={(value) => updateField("confirmPassword", value)}
                error={errors.confirmPassword}
                type="password"
                autoComplete="new-password"
              />
            </div>
          </section>

          {formError && <p className="text-sm text-red-600">{formError}</p>}

          <button
            type="submit"
            disabled={isSubmitting}
            className={`self-start rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
          >
            {isSubmitting ? "Регистрируем..." : "Зарегистрироваться"}
          </button>
        </form>
      )}

      <p className="mt-6 text-sm text-neutral-600">
        Уже есть аккаунт?{" "}
        <Link href={loginHref} className={`font-medium text-[#0F766E] hover:underline ${focusRing}`}>
          Войти
        </Link>
      </p>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl px-6 py-16">
          <h1 className="text-3xl font-bold text-neutral-800">Регистрация</h1>
          <p className="mt-4 text-neutral-600">Загрузка...</p>
        </div>
      }
    >
      <RegisterForm />
    </Suspense>
  );
}

function TypeToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors ${focusRing} ${
        active
          ? "border-[#0F766E] bg-[#0F766E] text-white"
          : "border-neutral-200 text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
      }`}
    >
      {label}
    </button>
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
  placeholder,
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
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-neutral-700">
        {label} <span className="text-red-500">*</span>
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
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
