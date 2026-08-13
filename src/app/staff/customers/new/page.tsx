"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { StaffCustomerDetailsFields } from "@/components/staff/StaffCustomerDetailsFields";
import {
  emptyCustomerDetailsForm,
  validateCustomerDetailsForm,
  type CustomerDetailsFormValues,
} from "@/lib/staff/customerDetails";
import { createStaffCustomer } from "@/lib/staff/customers";
import type { CustomerType } from "@/types/database";
import { CUSTOMER_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function StaffNewCustomerForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnToOrder = searchParams.get("return") === "order";
  const { profile, profileLoading } = useProfile();
  const canManage = profile?.role === "manager" || profile?.role === "admin";

  const [customerType, setCustomerType] = useState<CustomerType>("individual");
  const [values, setValues] = useState<CustomerDetailsFormValues>(emptyCustomerDetailsForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch(next: Partial<CustomerDetailsFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) {
      return;
    }

    const validationError = validateCustomerDetailsForm(customerType, values);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const isCompany = customerType === "company";
      const customer = await createStaffCustomer({
        customer_type: customerType,
        display_name: isCompany ? values.legal_name.trim() : values.display_name,
        legal_name: isCompany ? values.legal_name : null,
        phone: values.phone,
        email: values.email,
        iin_bin: isCompany ? values.iin_bin : null,
        contact_person: isCompany ? values.contact_person : null,
        address: isCompany ? values.address : null,
        city: values.city || null,
        source: values.source,
        notes: values.notes || null,
      });

      if (returnToOrder) {
        router.push(`/staff/orders/new?customer_id=${customer.id}`);
      } else {
        router.push(`/staff/customers/${customer.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать клиента");
      setSaving(false);
    }
  }

  if (!profileLoading && !canManage) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Недостаточно прав</h1>
        <p className="mt-4 text-neutral-600">Создавать клиентов могут только менеджер и администратор.</p>
        <Link
          href="/staff/customers"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          К списку клиентов
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={returnToOrder ? "/staff/orders/new" : "/staff/customers"}
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
      >
        ← Назад
      </Link>

      <h1 className="mt-4 text-2xl font-bold text-neutral-800">Новый клиент</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Создайте карточку клиента без регистрации на сайте
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Тип клиента</span>
          <select
            value={customerType}
            onChange={(event) => setCustomerType(event.target.value as CustomerType)}
            className={inputClass}
          >
            {(Object.keys(CUSTOMER_TYPE_LABELS) as CustomerType[]).map((type) => (
              <option key={type} value={type}>
                {CUSTOMER_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>

        <StaffCustomerDetailsFields
          customerType={customerType}
          values={values}
          onChange={patch}
          disabled={saving}
        />

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className={`self-start rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-300 ${focusRing}`}
        >
          {saving ? "Сохранение..." : "Создать клиента"}
        </button>
      </form>
    </div>
  );
}

export default function StaffNewCustomerPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl py-8">
          <p className="text-sm text-neutral-500">Загрузка...</p>
        </div>
      }
    >
      <StaffNewCustomerForm />
    </Suspense>
  );
}
