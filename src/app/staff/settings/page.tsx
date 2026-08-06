"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import {
  emptyOrganizationForm,
  getOrganizationSettings,
  updateOrganizationSettings,
} from "@/lib/staff/organization";
import type { OrganizationSettings, OrganizationSettingsUpdate } from "@/lib/staff/organization";
import {
  ORGANIZATION_ASSET_LIMITS,
  deleteOrganizationAsset,
  getOrganizationAssetSignedUrl,
  uploadOrganizationAsset,
} from "@/lib/staff/organizationAssets";
import {
  emptyPaymentProfileForm,
  listOrganizationPaymentProfiles,
  upsertOrganizationPaymentProfile,
  type OrganizationPaymentProfile,
  type OrganizationPaymentProfileUpdate,
} from "@/lib/staff/paymentProfiles";
import {
  CUSTOMER_TYPE_LABELS,
  DOCUMENT_TAX_MODE_LABELS,
  type CustomerType,
  type DocumentTaxMode,
  type OrganizationAssetKind,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass =
  `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

const ASSET_KINDS: OrganizationAssetKind[] = ["logo", "stamp", "signature"];

const ASSET_HINTS: Record<OrganizationAssetKind, string> = {
  logo: "PNG / JPEG / WEBP, до 2 МБ",
  stamp: "Предпочтительно PNG с прозрачностью, до 3 МБ",
  signature: "Предпочтительно PNG с прозрачностью, до 2 МБ",
};

export default function StaffOrganizationSettingsPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const isAdmin = profile?.role === "admin";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<OrganizationSettingsUpdate>(emptyOrganizationForm());
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  const [individualPayment, setIndividualPayment] =
    useState<OrganizationPaymentProfileUpdate>(emptyPaymentProfileForm("individual"));
  const [companyPayment, setCompanyPayment] =
    useState<OrganizationPaymentProfileUpdate>(emptyPaymentProfileForm("company"));
  const [paymentBusyType, setPaymentBusyType] = useState<CustomerType | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentOkType, setPaymentOkType] = useState<CustomerType | null>(null);

  useEffect(() => {
    if (profile && profile.role !== "admin") {
      router.replace("/staff");
    }
  }, [profile, router]);

  useEffect(() => {
    let ignore = false;
    Promise.all([getOrganizationSettings(), listOrganizationPaymentProfiles()])
      .then(([row, profiles]) => {
        if (ignore) return;
        setSettings(row);
        setForm(emptyOrganizationForm(row));
        applyPaymentProfiles(profiles, setIndividualPayment, setCompanyPayment);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setLoadError(
          error instanceof Error ? error.message : "Не удалось загрузить настройки",
        );
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSavePaymentProfile(customerType: CustomerType) {
    if (!isAdmin || paymentBusyType) return;
    const draft = customerType === "individual" ? individualPayment : companyPayment;
    setPaymentBusyType(customerType);
    setPaymentError(null);
    setPaymentOkType(null);
    try {
      const saved = await upsertOrganizationPaymentProfile({
        ...draft,
        customer_type: customerType,
      });
      if (customerType === "individual") {
        setIndividualPayment(emptyPaymentProfileForm("individual", saved));
      } else {
        setCompanyPayment(emptyPaymentProfileForm("company", saved));
      }
      setPaymentOkType(customerType);
    } catch (error: unknown) {
      setPaymentError(
        error instanceof Error ? error.message : "Не удалось сохранить платёжный профиль",
      );
    } finally {
      setPaymentBusyType(null);
    }
  }

  function patch<K extends keyof OrganizationSettingsUpdate>(
    key: K,
    value: OrganizationSettingsUpdate[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaveOk(false);
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!isAdmin || saveBusy) return;

    setSaveBusy(true);
    setSaveError(null);
    setSaveOk(false);

    try {
      if (
        form.default_tax_mode === "with_vat" &&
        (form.vat_rate == null || Number.isNaN(Number(form.vat_rate)))
      ) {
        throw new Error("Укажите ставку НДС для режима «С НДС»");
      }

      const saved = await updateOrganizationSettings({
        ...form,
        logo_path: settings?.logo_path ?? null,
        stamp_path: settings?.stamp_path ?? null,
        signature_path: settings?.signature_path ?? null,
      });
      setSettings(saved);
      setForm(emptyOrganizationForm(saved));
      setSaveOk(true);
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : "Не удалось сохранить");
    } finally {
      setSaveBusy(false);
    }
  }

  function onAssetChanged(next: OrganizationSettings) {
    setSettings(next);
    setForm((prev) => ({
      ...prev,
      logo_path: next.logo_path,
      stamp_path: next.stamp_path,
      signature_path: next.signature_path,
    }));
  }

  if (profile && !isAdmin) {
    return (
      <div className="py-16 text-center text-sm text-neutral-500">Перенаправление...</div>
    );
  }

  if (loading) {
    return (
      <div className="py-16 text-center text-sm text-neutral-500">Загрузка...</div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Настройки организации</h1>
        <p className="mt-4 text-red-600" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-neutral-800">Настройки</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Организация и сотрудники. Реквизиты используются в счетах и накладных.
      </p>

      <div className="mt-4 flex flex-wrap gap-2 border-b border-neutral-200 pb-3">
        <span className="rounded-md bg-[#0F766E]/10 px-3 py-1.5 text-sm font-medium text-[#0F766E]">
          Организация
        </span>
        <Link
          href="/staff/settings/users"
          className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
        >
          Сотрудники
        </Link>
      </div>

      <h2 className="mt-6 text-lg font-semibold text-neutral-800">Организация</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Реквизиты DEKORO для счетов и накладных. Изображения хранятся в private Storage.
      </p>

      <form onSubmit={(e) => void handleSave(e)} className="mt-6 space-y-6">
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Основные реквизиты</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Юридическое название *" className="sm:col-span-2">
              <input
                className={inputClass}
                value={form.legal_name}
                onChange={(e) => patch("legal_name", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
            <Field label="БИН (12 цифр) *">
              <input
                className={inputClass}
                value={form.bin}
                onChange={(e) => patch("bin", e.target.value)}
                required
                pattern="\d{12}"
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Город">
              <input
                className={inputClass}
                value={form.city}
                onChange={(e) => patch("city", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Адрес *" className="sm:col-span-2">
              <input
                className={inputClass}
                value={form.address}
                onChange={(e) => patch("address", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Телефон *">
              <input
                className={inputClass}
                value={form.phone}
                onChange={(e) => patch("phone", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                className={inputClass}
                value={form.email}
                onChange={(e) => patch("email", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Сайт">
              <input
                className={inputClass}
                value={form.website}
                onChange={(e) => patch("website", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="WhatsApp">
              <input
                className={inputClass}
                value={form.whatsapp}
                onChange={(e) => patch("whatsapp", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Директор *" className="sm:col-span-2">
              <input
                className={inputClass}
                value={form.director_name}
                onChange={(e) => patch("director_name", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">
            Банковские реквизиты (общие)
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Используются в snapshot поставщика и накладной. Для счетов настройте профили ниже.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Банк *" className="sm:col-span-2">
              <input
                className={inputClass}
                value={form.bank_name}
                onChange={(e) => patch("bank_name", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
            <Field label="БИК *">
              <input
                className={inputClass}
                value={form.bank_bik}
                onChange={(e) => patch("bank_bik", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
            <Field label="КБе *">
              <input
                className={inputClass}
                value={form.bank_kbe}
                onChange={(e) => patch("bank_kbe", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
            <Field label="ИИК *" className="sm:col-span-2">
              <input
                className={inputClass}
                value={form.bank_iik}
                onChange={(e) => patch("bank_iik", e.target.value)}
                required
                disabled={!isAdmin}
              />
            </Field>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">
            Банковские реквизиты для выставления счетов
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Отдельные счета DEKORO как получателя платежа для физлиц и юрлиц. Шаблон счёта
            выбирается автоматически по типу покупателя. Сохранение создаёт новую версию
            профиля и деактивирует предыдущую — уже сформированные счета не меняются.
          </p>

          {paymentError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {paymentError}
            </p>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <PaymentProfileCard
              title={`Для физических лиц (${CUSTOMER_TYPE_LABELS.individual})`}
              form={individualPayment}
              busy={paymentBusyType === "individual"}
              saved={paymentOkType === "individual"}
              disabled={!isAdmin}
              onChange={setIndividualPayment}
              onSave={() => void handleSavePaymentProfile("individual")}
            />
            <PaymentProfileCard
              title={`Для юридических лиц (${CUSTOMER_TYPE_LABELS.company})`}
              form={companyPayment}
              busy={paymentBusyType === "company"}
              saved={paymentOkType === "company"}
              disabled={!isAdmin}
              onChange={setCompanyPayment}
              onSave={() => void handleSavePaymentProfile("company")}
            />
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">НДС</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Режим по умолчанию">
              <select
                className={inputClass}
                value={form.default_tax_mode}
                onChange={(e) =>
                  patch("default_tax_mode", e.target.value as DocumentTaxMode)
                }
                disabled={!isAdmin}
              >
                {(Object.keys(DOCUMENT_TAX_MODE_LABELS) as DocumentTaxMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {DOCUMENT_TAX_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ставка НДС, %">
              <input
                type="number"
                min={0}
                max={100}
                step={0.01}
                className={inputClass}
                value={form.vat_rate ?? ""}
                onChange={(e) =>
                  patch(
                    "vat_rate",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                disabled={!isAdmin}
                placeholder="например 12"
              />
            </Field>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Склад</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Название склада">
              <input
                className={inputClass}
                value={form.warehouse_name}
                onChange={(e) => patch("warehouse_name", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Код склада">
              <input
                className={inputClass}
                value={form.warehouse_code}
                onChange={(e) => patch("warehouse_code", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
            <Field label="Адрес склада" className="sm:col-span-2">
              <input
                className={inputClass}
                value={form.warehouse_address}
                onChange={(e) => patch("warehouse_address", e.target.value)}
                disabled={!isAdmin}
              />
            </Field>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-neutral-800">Изображения документов</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Необязательно. При генерации документа файлы копируются в immutable snapshot.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {ASSET_KINDS.map((kind) => {
              const path =
                kind === "logo"
                  ? settings?.logo_path ?? null
                  : kind === "stamp"
                    ? settings?.stamp_path ?? null
                    : settings?.signature_path ?? null;
              return (
                <AssetCard
                  key={`${kind}:${path ?? "empty"}`}
                  kind={kind}
                  path={path}
                  disabled={!isAdmin}
                  onChanged={onAssetChanged}
                />
              );
            })}
          </div>
        </section>

        {saveError && (
          <p className="text-sm text-red-600" role="alert">
            {saveError}
          </p>
        )}
        {saveOk && (
          <p className="text-sm text-[#0F766E]" role="status">
            Настройки сохранены
          </p>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={!isAdmin || saveBusy}
            className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
          >
            {saveBusy ? "Сохранение..." : "Сохранить настройки"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-sm text-neutral-600 ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function applyPaymentProfiles(
  profiles: OrganizationPaymentProfile[],
  setIndividual: (v: OrganizationPaymentProfileUpdate) => void,
  setCompany: (v: OrganizationPaymentProfileUpdate) => void,
) {
  const individual = profiles.find((p) => p.customer_type === "individual");
  const company = profiles.find((p) => p.customer_type === "company");
  setIndividual(emptyPaymentProfileForm("individual", individual));
  setCompany(emptyPaymentProfileForm("company", company));
}

function PaymentProfileCard({
  title,
  form,
  busy,
  saved,
  disabled,
  onChange,
  onSave,
}: {
  title: string;
  form: OrganizationPaymentProfileUpdate;
  busy: boolean;
  saved: boolean;
  disabled: boolean;
  onChange: (next: OrganizationPaymentProfileUpdate) => void;
  onSave: () => void;
}) {
  function patch<K extends keyof OrganizationPaymentProfileUpdate>(
    key: K,
    value: OrganizationPaymentProfileUpdate[K],
  ) {
    onChange({ ...form, [key]: value });
  }

  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-800">{title}</h3>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            form.is_active
              ? "bg-[#0F766E]/10 text-[#0F766E]"
              : "bg-neutral-200 text-neutral-600"
          }`}
        >
          {form.is_active ? "Активный профиль" : "Будет неактивен"}
        </span>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        При сохранении текущий активный профиль деактивируется и создаётся новая запись.
        Старые счета продолжают использовать свой snapshot.
      </p>
      <div className="mt-3 grid gap-3">
        <Field label="Получатель *">
          <input
            className={inputClass}
            value={form.beneficiary_name}
            onChange={(e) => patch("beneficiary_name", e.target.value)}
            disabled={disabled || busy}
            required
          />
        </Field>
        <Field label="ИИН/БИН *">
          <input
            className={inputClass}
            value={form.bin_iin}
            onChange={(e) => patch("bin_iin", e.target.value)}
            disabled={disabled || busy}
            required
          />
        </Field>
        <Field label="Банк *">
          <input
            className={inputClass}
            value={form.bank_name}
            onChange={(e) => patch("bank_name", e.target.value)}
            disabled={disabled || busy}
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="БИК *">
            <input
              className={inputClass}
              value={form.bank_bik}
              onChange={(e) => patch("bank_bik", e.target.value)}
              disabled={disabled || busy}
              required
            />
          </Field>
          <Field label="КБе *">
            <input
              className={inputClass}
              value={form.bank_kbe}
              onChange={(e) => patch("bank_kbe", e.target.value)}
              disabled={disabled || busy}
              required
            />
          </Field>
        </div>
        <Field label="ИИК *">
          <input
            className={inputClass}
            value={form.bank_iik}
            onChange={(e) => patch("bank_iik", e.target.value)}
            disabled={disabled || busy}
            required
          />
        </Field>
        <Field label="КНП">
          <input
            className={inputClass}
            value={form.payment_purpose_code}
            onChange={(e) => patch("payment_purpose_code", e.target.value)}
            disabled={disabled || busy}
            placeholder="например 710"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            className="accent-[#0F766E]"
            checked={form.is_active}
            onChange={(e) => patch("is_active", e.target.checked)}
            disabled={disabled || busy}
          />
          Активен (используется при создании счёта)
        </label>
      </div>
      {saved && (
        <p className="mt-2 text-sm text-[#0F766E]" role="status">
          Профиль сохранён
        </p>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={disabled || busy}
        className={`mt-3 rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
      >
        {busy ? "Сохранение..." : "Сохранить новую версию"}
      </button>
    </div>
  );
}

function AssetCard({
  kind,
  path,
  disabled,
  onChanged,
}: {
  kind: OrganizationAssetKind;
  path: string | null;
  disabled: boolean;
  onChanged: (settings: OrganizationSettings) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    if (!path) {
      return;
    }
    getOrganizationAssetSignedUrl(path)
      .then((url) => {
        if (!ignore) setPreviewUrl(url);
      })
      .catch(() => {
        if (!ignore) setPreviewUrl(null);
      });
    return () => {
      ignore = true;
    };
  }, [path]);

  async function onFileSelected(file: File | null) {
    if (!file || disabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await uploadOrganizationAsset(kind, file);
      onChanged(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onDelete() {
    if (disabled || busy || !path) return;
    setBusy(true);
    setError(null);
    try {
      const next = await deleteOrganizationAsset(kind);
      onChanged(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Ошибка удаления");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
      <p className="text-sm font-medium text-neutral-800">
        {ORGANIZATION_ASSET_LIMITS[kind].label}
      </p>
      <p className="mt-0.5 text-xs text-neutral-400">{ASSET_HINTS[kind]}</p>

      <div className="mt-3 flex h-28 items-center justify-center overflow-hidden rounded border border-dashed border-neutral-200 bg-white">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-xs text-neutral-400">Нет файла</span>
        )}
      </div>

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        disabled={disabled || busy}
        onChange={(e) => void onFileSelected(e.target.files?.[0] ?? null)}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        <label
          htmlFor={inputId}
          className={`cursor-pointer rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${
            disabled || busy ? "pointer-events-none opacity-50" : ""
          } ${focusRing}`}
        >
          {busy ? "..." : path ? "Заменить" : "Загрузить"}
        </label>
        {path && (
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={disabled || busy}
            className={`rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-300 disabled:opacity-50 ${focusRing}`}
          >
            Удалить
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      {path && (
        <p className="mt-2 break-all text-[10px] text-neutral-400">{path}</p>
      )}
    </div>
  );
}
