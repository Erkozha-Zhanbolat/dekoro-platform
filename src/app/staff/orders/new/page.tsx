"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { searchStaffClients } from "@/lib/staff/clients";
import type { StaffClientSearchResult } from "@/lib/staff/clients";
import { createStaffOrder } from "@/lib/staff/orders";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const SEARCH_DEBOUNCE_MS = 300;

export default function StaffNewOrderPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const canCreateOrder = profile?.role === "manager" || profile?.role === "admin";

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [results, setResults] = useState<StaffClientSearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  // undefined = not searched yet for this term.
  const [searchedTerm, setSearchedTerm] = useState<string | undefined>(undefined);

  const [selectedClient, setSelectedClient] = useState<StaffClientSearchResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);

  useEffect(() => {
    if (searchedTerm === debouncedSearch) {
      return;
    }

    let ignore = false;

    searchStaffClients(debouncedSearch)
      .then((clients) => {
        if (ignore) {
          return;
        }
        setResults(clients);
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

  function handleSelectClient(client: StaffClientSearchResult) {
    if (creating) {
      return;
    }
    setSelectedClient(client);
    setCreateError(null);
  }

  async function handleCreateOrder() {
    // Guards against double-click / double-submit: bail immediately if a
    // create request is already in flight.
    if (!selectedClient || creating) {
      return;
    }

    setCreating(true);
    setCreateError(null);

    try {
      const order = await createStaffOrder(selectedClient.profile_id);
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

      <h1 className="mt-4 text-2xl font-bold text-neutral-800">Новый заказ</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Найдите существующего клиента, чтобы создать для него заказ вручную.
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.target.value);
            setSelectedClient(null);
          }}
          placeholder="Поиск по имени, компании, телефону или email"
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
            {debouncedSearch
              ? "Клиенты не найдены"
              : "Начните вводить имя, компанию, телефон или email"}
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-2">
            {results.map((client) => {
              const isSelected = selectedClient?.profile_id === client.profile_id;
              return (
                <button
                  key={client.profile_id}
                  type="button"
                  onClick={() => handleSelectClient(client)}
                  className={`flex flex-col gap-0.5 rounded-md px-4 py-3 text-left transition-colors ${focusRing} ${
                    isSelected
                      ? "bg-[#0F766E]/10 ring-1 ring-[#0F766E]"
                      : "hover:bg-neutral-50"
                  }`}
                >
                  <span className="text-sm font-medium text-neutral-800">{client.full_name}</span>
                  <span className="text-xs text-neutral-500">
                    {[client.company_name, client.phone, client.email].filter(Boolean).join(" · ") ||
                      "Нет дополнительных данных"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedClient && (
        <div className="mt-6 flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Выбранный клиент
            </p>
            <p className="mt-1 text-sm font-medium text-neutral-800">{selectedClient.full_name}</p>
            {selectedClient.company_name && (
              <p className="text-sm text-neutral-500">{selectedClient.company_name}</p>
            )}
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
