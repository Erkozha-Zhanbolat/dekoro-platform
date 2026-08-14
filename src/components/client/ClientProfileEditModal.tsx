"use client";

import { useEffect, useState } from "react";
import {
  normalizeCustomerEmail,
  normalizeCustomerPhone,
} from "@/lib/staff/customerDetails";
import {
  updateMyCustomerDetails,
  type ClientCustomerDetails,
} from "@/lib/client/customer";
import { CUSTOMER_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIN_RE = /^\d{12}$/;

type FormValues = {
  display_name: string;
  legal_name: string;
  iin_bin: string;
  city: string;
  address: string;
  contact_person: string;
  phone: string;
  email: string;
};

function valuesFromCustomer(customer: ClientCustomerDetails): FormValues {
  return {
    display_name: customer.display_name ?? "",
    legal_name: customer.legal_name ?? "",
    iin_bin: customer.iin_bin ?? "",
    city: customer.city ?? "",
    address: customer.address ?? "",
    contact_person: customer.contact_person ?? "",
    phone: customer.phone ?? "",
    email: customer.email ?? "",
  };
}

function validate(customerType: ClientCustomerDetails["customer_type"], values: FormValues): string | null {
  const phone = normalizeCustomerPhone(values.phone);
  const email = normalizeCustomerEmail(values.email);

  if (!values.city.trim()) {
    return "Укажите город";
  }
  if (!phone) {
    return "Укажите телефон";
  }
  if (!email || !EMAIL_RE.test(email)) {
    return "Укажите корректный email";
  }

  if (customerType === "individual") {
    if (!values.display_name.trim()) {
      return "Укажите ФИО";
    }
    return null;
  }

  if (!values.legal_name.trim()) {
    return "Укажите юридическое название";
  }
  if (!BIN_RE.test(values.iin_bin.trim())) {
    return "БИН / ИИН должен содержать ровно 12 цифр";
  }
  if (!values.address.trim()) {
    return "Укажите юридический адрес";
  }
  if (!values.contact_person.trim()) {
    return "Укажите контактное лицо";
  }
  return null;
}

export default function ClientProfileEditModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: ClientCustomerDetails;
  onClose: () => void;
  onSaved: (updated: ClientCustomerDetails) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => valuesFromCustomer(customer));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCompany = customer.customer_type === "company";

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  function patch(next: Partial<FormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) {
      return;
    }

    const validationError = validate(customer.customer_type, values);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const updated = await updateMyCustomerDetails(
        isCompany
          ? {
              legal_name: values.legal_name,
              iin_bin: values.iin_bin,
              city: values.city,
              address: values.address,
              contact_person: values.contact_person,
              phone: values.phone,
              email: values.email,
            }
          : {
              display_name: values.display_name,
              city: values.city,
              phone: values.phone,
              email: values.email,
            },
      );
      onSaved(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-profile-edit-title"
      onClick={() => {
        if (!saving) {
          onClose();
        }
      }}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <div>
            <h2 id="client-profile-edit-title" className="text-lg font-semibold text-neutral-800">
              Редактировать данные
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              {CUSTOMER_TYPE_LABELS[customer.customer_type]}
              {" · тип нельзя сменить"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Закрыть"
            className={`flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 ${focusRing}`}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            {isCompany ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Юридическое название *
                  </span>
                  <input
                    required
                    disabled={saving}
                    value={values.legal_name}
                    onChange={(event) => patch({ legal_name: event.target.value })}
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    БИН / ИИН *
                  </span>
                  <input
                    required
                    disabled={saving}
                    value={values.iin_bin}
                    onChange={(event) => patch({ iin_bin: event.target.value })}
                    className={inputClass}
                    inputMode="numeric"
                    maxLength={12}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Город *
                  </span>
                  <input
                    required
                    disabled={saving}
                    value={values.city}
                    onChange={(event) => patch({ city: event.target.value })}
                    className={inputClass}
                    placeholder="Алматы"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Юридический адрес *
                  </span>
                  <textarea
                    required
                    disabled={saving}
                    value={values.address}
                    onChange={(event) => patch({ address: event.target.value })}
                    rows={2}
                    className={inputClass}
                    placeholder="г. Алматы, ул. Абая, 150, офис 25"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Контактное лицо *
                  </span>
                  <input
                    required
                    disabled={saving}
                    value={values.contact_person}
                    onChange={(event) => patch({ contact_person: event.target.value })}
                    className={inputClass}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    ФИО *
                  </span>
                  <input
                    required
                    disabled={saving}
                    value={values.display_name}
                    onChange={(event) => patch({ display_name: event.target.value })}
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Город *
                  </span>
                  <input
                    required
                    disabled={saving}
                    value={values.city}
                    onChange={(event) => patch({ city: event.target.value })}
                    className={inputClass}
                    placeholder="Алматы"
                  />
                </label>
              </>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Телефон *
              </span>
              <input
                required
                disabled={saving}
                value={values.phone}
                onChange={(event) => patch({ phone: event.target.value })}
                className={inputClass}
                type="tel"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Email *
              </span>
              <input
                required
                disabled={saving}
                value={values.email}
                onChange={(event) => patch({ email: event.target.value })}
                className={inputClass}
                type="email"
              />
            </label>

            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="flex gap-2 border-t border-neutral-200 px-5 py-4">
            <button
              type="submit"
              disabled={saving}
              className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
            >
              {saving ? "Сохранение..." : "Сохранить"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className={`rounded-md border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-600 ${focusRing}`}
            >
              Отмена
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
