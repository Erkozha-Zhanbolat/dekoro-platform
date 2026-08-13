"use client";

import { useEffect, useState } from "react";
import { StaffCustomerDetailsFields } from "@/components/staff/StaffCustomerDetailsFields";
import {
  emptyCustomerDetailsForm,
  validateCustomerDetailsForm,
  type CustomerDetailsFormValues,
} from "@/lib/staff/customerDetails";
import { updateStaffCustomer } from "@/lib/staff/customers";
import type { Customer, StaffCustomerDetails } from "@/types/database";
import { CUSTOMER_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function valuesFromCustomer(customer: StaffCustomerDetails): CustomerDetailsFormValues {
  return {
    ...emptyCustomerDetailsForm(customer.source ?? "staff"),
    display_name: customer.display_name,
    legal_name: customer.legal_name ?? "",
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    iin_bin: customer.iin_bin ?? "",
    contact_person: customer.contact_person ?? "",
    address: customer.address ?? "",
    city: customer.city ?? "",
    notes: customer.notes ?? "",
  };
}

export default function StaffCustomerEditModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: StaffCustomerDetails;
  onClose: () => void;
  onSaved: (updated: Customer) => void;
}) {
  const [values, setValues] = useState<CustomerDetailsFormValues>(() =>
    valuesFromCustomer(customer),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  function patch(next: Partial<CustomerDetailsFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) {
      return;
    }

    const validationError = validateCustomerDetailsForm(customer.customer_type, values);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const isCompany = customer.customer_type === "company";
      const updated = await updateStaffCustomer(customer.id, {
        display_name: isCompany
          ? values.legal_name.trim() || customer.display_name
          : values.display_name,
        legal_name: isCompany ? values.legal_name : undefined,
        phone: values.phone,
        email: values.email,
        iin_bin: isCompany ? values.iin_bin : undefined,
        contact_person: isCompany ? values.contact_person : undefined,
        address: isCompany ? values.address : undefined,
        city: values.city,
        source: values.source,
        notes: values.notes,
      });
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
      aria-labelledby="customer-edit-title"
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
            <h2 id="customer-edit-title" className="text-lg font-semibold text-neutral-800">
              Редактировать клиента
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
            <StaffCustomerDetailsFields
              customerType={customer.customer_type}
              values={values}
              onChange={patch}
              disabled={saving}
            />
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
