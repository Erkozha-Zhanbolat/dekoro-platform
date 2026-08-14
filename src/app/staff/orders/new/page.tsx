"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { getStaffCustomer, searchStaffCustomers } from "@/lib/staff/customers";
import type { StaffCustomerSearchResult } from "@/lib/staff/customers";
import { createStaffOrderForCustomer } from "@/lib/staff/orders";
import { CUSTOMER_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const SEARCH_DEBOUNCE_MS = 300;

function StaffNewOrderForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedCustomerId = searchParams.get("customer_id");
  const { profile, profileLoading } = useProfile();
  const canCreateOrder = profile?.role === "manager" || profile?.role === "admin";

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [results, setResults] = useState<StaffCustomerSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchedTerm, setSearchedTerm] = useState<string | undefined>(undefined);

  const [selectedCustomer, setSelectedCustomer] = useState<StaffCustomerSearchResult | null>(null);
  const [preselectError, setPreselectError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (!preselectedCustomerId) {
      return;
    }

    let ignore = false;

    getStaffCustomer(preselectedCustomerId)
      .then((customer) => {
        if (ignore) {
          return;
        }
        if (!customer) {
          setPreselectError("Клиент не найден");
          return;
        }
        setSelectedCustomer({
          id: customer.id,
          customer_type: customer.customer_type,
          display_name: customer.display_name,
          legal_name: customer.legal_name,
          phone: customer.phone,
          email: customer.email,
          city: customer.city,
          source: customer.source,
          profile_id: customer.profile_id,
          company_id: customer.company_id,
          orders_count: customer.orders_count,
          last_order_at: customer.last_order_at,
          iin_bin: customer.iin_bin,
          contact_person: customer.contact_person,
          is_registered: customer.is_registered,
          price_group_id: customer.price_group_id,
          price_group_name: customer.price_group_name,
        });
        setPreselectError(null);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setPreselectError(error instanceof Error ? error.message : "Не удалось загрузить клиента");
      });

    return () => {
      ignore = true;
    };
  }, [preselectedCustomerId]);

  useEffect(() => {
    if (searchedTerm === debouncedSearch) {
      return;
    }

    let ignore = false;

    searchStaffCustomers(debouncedSearch)
      .then((customers) => {
        if (ignore) {
          return;
        }
        setResults(customers);
        setSearchError(null);
        setSearchedTerm(debouncedSearch);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setSearchError(error instanceof Error ? error.message : "Не удалось выполнить поиск");
        setSearchedTerm(debouncedSearch);
      });

    return () => {
      ignore = true;
    };
  }, [debouncedSearch, searchedTerm]);

  const searching = searchedTerm !== debouncedSearch;

  function handleSelectCustomer(customer: StaffCustomerSearchResult) {
    if (creating) {
      return;
    }
    setSelectedCustomer(customer);
    setCreateError(null);
  }

  async function handleCreateOrder() {
    if (!selectedCustomer || creating) {
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const order = await createStaffOrderForCustomer(selectedCustomer.id);
      router.push(`/staff/orders/${order.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Не удалось создать заказ");
      setCreating(false);
    }
  }

  if (!profileLoading && !canCreateOrder) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Недостаточно прав</h1>
        <p className="mt-4 text-neutral-600">
          Создавать заказы могут только менеджер и администратор.
        </p>
        <Link
          href="/staff/orders"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          К списку заказов
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/staff/orders"
        className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
      >
        ← Назад к заказам
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Новый заказ</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Выберите клиента из базы или создайте нового — без клиента заказ создать нельзя.
          </p>
        </div>
        <Link
          href="/staff/customers/new?return=order"
          className={`rounded-md border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          + Новый клиент
        </Link>
      </div>

      {preselectError && (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
          {preselectError}
        </p>
      )}

      <div className="mt-6 flex flex-col gap-4">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.target.value);
          }}
          placeholder="Поиск по имени, телефону, email, ИИН/БИН"
          className={`w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
        />

        {searchError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
            {searchError}
          </p>
        ) : searching ? (
          <div className="rounded-lg border border-neutral-200 bg-white py-8 text-center text-sm text-neutral-500">
            Поиск...
          </div>
        ) : results.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white py-8 text-center text-sm text-neutral-500">
            {debouncedSearch ? "Клиенты не найдены" : "Последние клиенты появятся здесь"}
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-2">
            {results.map((customer) => {
              const isSelected = selectedCustomer?.id === customer.id;
              return (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => handleSelectCustomer(customer)}
                  className={`flex flex-col gap-0.5 rounded-md px-4 py-3 text-left transition-colors ${focusRing} ${
                    isSelected
                      ? "bg-[#0F766E]/10 ring-1 ring-[#0F766E]"
                      : "hover:bg-neutral-50"
                  }`}
                >
                  <span className="text-sm font-medium text-neutral-800">{customer.display_name}</span>
                  <span className="text-xs text-neutral-500">
                    {[
                      CUSTOMER_TYPE_LABELS[customer.customer_type],
                      customer.phone,
                      customer.email,
                      customer.city,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Нет дополнительных данных"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedCustomer && (
        <div className="mt-6 flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Выбранный клиент
            </p>
            <p className="mt-1 text-sm font-medium text-neutral-800">{selectedCustomer.display_name}</p>
            <p className="text-sm text-neutral-500">
              {[
                CUSTOMER_TYPE_LABELS[selectedCustomer.customer_type],
                selectedCustomer.phone,
                selectedCustomer.email,
                selectedCustomer.is_registered ? "Зарегистрирован" : "Без аккаунта",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>

          {createError && (
            <p className="text-sm text-red-600" role="alert">
              {createError}
            </p>
          )}

          <button
            type="button"
            onClick={handleCreateOrder}
            disabled={creating}
            className={`self-start rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:cursor-not-allowed disabled:bg-neutral-300 ${focusRing}`}
          >
            {creating ? "Создание..." : "Создать заказ"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function StaffNewOrderPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl py-8">
          <p className="text-sm text-neutral-500">Загрузка...</p>
        </div>
      }
    >
      <StaffNewOrderForm />
    </Suspense>
  );
}
