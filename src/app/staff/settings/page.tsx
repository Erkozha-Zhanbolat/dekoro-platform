"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
  DOCUMENT_TAX_MODE_LABELS,
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

  useEffect(() => {
    if (profile && profile.role !== "admin") {
      router.replace("/staff");
    }
  }, [profile, router]);

  useEffect(() => {
    let ignore = false;
    getOrganizationSettings()
      .then((row) => {
        if (ignore) return;
        setSettings(row);
        setForm(emptyOrganizationForm(row));
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
      <h1 className="text-2xl font-bold text-neutral-800">Настройки организации</h1>
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
          <h2 className="text-lg font-semibold text-neutral-800">Банковские реквизиты</h2>
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
