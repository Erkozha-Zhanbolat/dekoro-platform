"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import { searchStaffCustomers } from "@/lib/staff/customers";
import type { StaffCustomerSearchResult } from "@/lib/staff/customers";
import { CUSTOMER_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const SEARCH_DEBOUNCE_MS = 300;
const LIST_LIMIT = 50;

function statusLabel(customer: StaffCustomerSearchResult): string {
  return customer.is_registered ? "Зарегистрирован" : "Без аккаунта";
}

export default function StaffCustomersPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const canManage = profile?.role === "manager" || profile?.role === "admin";

  useEffect(() => {
    if (profile?.role === "warehouse") {
      router.replace("/staff/warehouse");
    }
  }, [profile?.role, router]);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [customers, setCustomers] = useState<StaffCustomerSearchResult[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (profile?.role === "warehouse" || loadedKey === debouncedSearch) {
      return;
    }

    let ignore = false;

    searchStaffCustomers(debouncedSearch, LIST_LIMIT)
      .then((result) => {
        if (ignore) {
          return;
        }
        setCustomers(result);
        setLoadError(null);
        setLoadedKey(debouncedSearch);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить клиентов");
        setLoadedKey(debouncedSearch);
      });

    return () => {
      ignore = true;
    };
  }, [profile?.role, debouncedSearch, loadedKey]);

  const loading = loadedKey !== debouncedSearch;

  if (profile?.role === "warehouse") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Клиенты</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Зарегистрированные на сайте и созданные менеджером — физлица, ИП и ТОО
          </p>
        </div>
        {canManage && (
          <Link
            href="/staff/customers/new"
            className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            + Новый клиент
          </Link>
        )}
      </div>

      <input
        type="search"
        value={searchInput}
        onChange={(event) => setSearchInput(event.target.value)}
        placeholder="Поиск по имени, телефону, email, ИИН/БИН, городу"
        className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] sm:max-w-md ${focusRing}`}
      />

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {loadError}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
        {loading ? (
          <p className="px-5 py-6 text-sm text-neutral-500">Загрузка...</p>
        ) : customers.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500">
            {debouncedSearch ? "Клиенты не найдены" : "Клиентов пока нет"}
          </p>
        ) : (
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                <th className="px-5 py-3">Клиент</th>
                <th className="px-5 py-3">Тип</th>
                <th className="px-5 py-3">БИН / ИИН</th>
                <th className="px-5 py-3">Город</th>
                <th className="px-5 py-3">Контакт</th>
                <th className="px-5 py-3">Телефон</th>
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Статус</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => {
                const isCompany = customer.customer_type === "company";
                const name = isCompany
                  ? (customer.legal_name || customer.display_name)
                  : customer.display_name;
                return (
                  <tr key={customer.id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-5 py-3 font-medium text-neutral-800">{name}</td>
                    <td className="px-5 py-3 text-neutral-600">
                      {CUSTOMER_TYPE_LABELS[customer.customer_type]}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">
                      {isCompany ? (customer.iin_bin ?? "—") : "—"}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">{customer.city ?? "—"}</td>
                    <td className="px-5 py-3 text-neutral-600">
                      {isCompany ? (customer.contact_person ?? "—") : "—"}
                    </td>
                    <td className="px-5 py-3 text-neutral-600">{customer.phone ?? "—"}</td>
                    <td className="px-5 py-3 text-neutral-600">{customer.email ?? "—"}</td>
                    <td className="px-5 py-3 text-neutral-600">{statusLabel(customer)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/staff/customers/${customer.id}`}
                        className={`text-sm font-medium text-[#0F766E] transition-colors hover:text-[#0c5f58] ${focusRing}`}
                      >
                        Открыть
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
