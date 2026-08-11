"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { formatPrice } from "@/lib/formatPrice";
import {
  getStaffCustomer,
  listStaffCustomerOrders,
  updateStaffCustomer,
} from "@/lib/staff/customers";
import type { StaffCustomerDetails, StaffCustomerOrderListItem } from "@/lib/staff/customers";
import { getStaffCustomerReceivables } from "@/lib/staff/payments";
import {
  deleteCustomerProductPrice,
  listCustomerProductPrices,
  listStaffPriceGroups,
  setCustomerPriceGroup,
  upsertCustomerProductPrice,
} from "@/lib/staff/pricing";
import { searchStaffProducts } from "@/lib/staff/inventory";
import type { StaffProductSearchResult } from "@/lib/staff/inventory";
import type { CustomerProductPriceRow, CustomerSource, PriceGroup, StaffCustomerReceivables } from "@/types/database";
import {
  CUSTOMER_SOURCE_LABELS,
  CUSTOMER_SOURCES,
  CUSTOMER_TYPE_LABELS,
  ORDER_STATUS_LABELS,
} from "@/types/database";
import { StaffCustomerActivity } from "@/components/staff/StaffCustomerActivity";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

const SEARCH_DEBOUNCE_MS = 300;

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function formatOptionalPrice(value: number | null | undefined): string {
  if (value == null) return "—";
  return formatPrice(value);
}

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function StaffCustomerDetailPage() {
  const params = useParams();
  const customerId = typeof params.id === "string" ? params.id : "";
  const { profile } = useProfile();
  const canManage = profile?.role === "manager" || profile?.role === "admin";
  const canEditPricing = profile?.role === "admin";
  const canCreateOrder = canManage;

  const [customer, setCustomer] = useState<StaffCustomerDetails | null>(null);
  const [orders, setOrders] = useState<StaffCustomerOrderListItem[]>([]);
  const [receivables, setReceivables] = useState<StaffCustomerReceivables | null>(null);
  const [receivablesError, setReceivablesError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [iinBin, setIinBin] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [source, setSource] = useState<CustomerSource>("staff");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tab, setTab] = useState<"info" | "activity">("info");

  const [priceGroups, setPriceGroups] = useState<PriceGroup[]>([]);
  const [selectedPriceGroupId, setSelectedPriceGroupId] = useState("");
  const [priceGroupSaving, setPriceGroupSaving] = useState(false);
  const [priceGroupError, setPriceGroupError] = useState<string | null>(null);

  const [individualPrices, setIndividualPrices] = useState<CustomerProductPriceRow[]>([]);
  const [individualPricesError, setIndividualPricesError] = useState<string | null>(null);
  const [individualPriceDrafts, setIndividualPriceDrafts] = useState<Record<string, string>>({});
  const [savingIndividualProductId, setSavingIndividualProductId] = useState<string | null>(null);
  const [deletingIndividualProductId, setDeletingIndividualProductId] = useState<string | null>(null);

  const [addProductSearch, setAddProductSearch] = useState("");
  const [debouncedAddProductSearch, setDebouncedAddProductSearch] = useState("");
  const [addProductResults, setAddProductResults] = useState<StaffProductSearchResult[]>([]);
  const [addProductSearchError, setAddProductSearchError] = useState<string | null>(null);
  const [addProductSearchedTerm, setAddProductSearchedTerm] = useState<string | undefined>(
    undefined,
  );
  const [selectedAddProduct, setSelectedAddProduct] = useState<StaffProductSearchResult | null>(null);
  const [addIndividualPrice, setAddIndividualPrice] = useState("");
  const [addIndividualBusy, setAddIndividualBusy] = useState(false);
  const [addIndividualError, setAddIndividualError] = useState<string | null>(null);

  useEffect(() => {
    if (!customerId) {
      return;
    }

    let ignore = false;

    Promise.all([getStaffCustomer(customerId), listStaffCustomerOrders(customerId)])
      .then(([customerResult, ordersResult]) => {
        if (ignore) {
          return;
        }
        if (!customerResult) {
          setLoadError("Клиент не найден");
          setCustomer(null);
          setOrders([]);
          setReceivables(null);
        } else {
          setCustomer(customerResult);
          setOrders(ordersResult);
          setLoadError(null);
          setDisplayName(customerResult.display_name);
          setLegalName(customerResult.legal_name ?? "");
          setPhone(customerResult.phone ?? "");
          setEmail(customerResult.email ?? "");
          setIinBin(customerResult.iin_bin ?? "");
          setContactPerson(customerResult.contact_person ?? "");
          setAddress(customerResult.address ?? "");
          setCity(customerResult.city ?? "");
          setSource(customerResult.source ?? "staff");
          setNotes(customerResult.notes ?? "");
          setSelectedPriceGroupId(customerResult.price_group_id ?? "");

          getStaffCustomerReceivables(customerId)
            .then((recv) => {
              if (ignore) {
                return;
              }
              setReceivables(recv);
              setReceivablesError(null);
            })
            .catch((error: unknown) => {
              if (ignore) {
                return;
              }
              setReceivables(null);
              setReceivablesError(
                error instanceof Error
                  ? error.message
                  : "Не удалось загрузить дебиторку",
              );
            });
        }
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить клиента");
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [customerId]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedAddProductSearch(addProductSearch.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [addProductSearch]);

  function syncIndividualPriceDrafts(rows: CustomerProductPriceRow[]) {
    const next: Record<string, string> = {};
    for (const row of rows) {
      if (row.individual_price != null) {
        next[row.product_id] = String(row.individual_price);
      }
    }
    setIndividualPriceDrafts(next);
  }

  async function refreshIndividualPrices() {
    if (!customerId) return;
    const rows = await listCustomerProductPrices(customerId);
    setIndividualPrices(rows);
    syncIndividualPriceDrafts(rows);
    setIndividualPricesError(null);
  }

  useEffect(() => {
    if (!customerId) return;

    let ignore = false;

    Promise.all([listStaffPriceGroups(false), listCustomerProductPrices(customerId)])
      .then(([groups, prices]) => {
        if (ignore) return;
        setPriceGroups(groups);
        setIndividualPrices(prices);
        syncIndividualPriceDrafts(prices);
        setIndividualPricesError(null);
        setPriceGroupError(null);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setIndividualPricesError(
          error instanceof Error ? error.message : "Не удалось загрузить цены",
        );
      });

    return () => {
      ignore = true;
    };
  }, [customerId]);

  useEffect(() => {
    if (!canEditPricing || !customerId) return;
    if (addProductSearchedTerm === debouncedAddProductSearch) return;

    let ignore = false;

    searchStaffProducts(debouncedAddProductSearch, 50, customerId)
      .then((results) => {
        if (ignore) return;
        setAddProductResults(results);
        setAddProductSearchError(null);
        setAddProductSearchedTerm(debouncedAddProductSearch);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setAddProductResults([]);
        setAddProductSearchError(
          error instanceof Error ? error.message : "Не удалось найти товары",
        );
        setAddProductSearchedTerm(debouncedAddProductSearch);
      });

    return () => {
      ignore = true;
    };
  }, [canEditPricing, customerId, debouncedAddProductSearch, addProductSearchedTerm]);

  const addProductSearchLoading = addProductSearchedTerm !== debouncedAddProductSearch;

  async function handleSavePriceGroup() {
    if (!customer || !canEditPricing || priceGroupSaving || !selectedPriceGroupId) return;

    setPriceGroupSaving(true);
    setPriceGroupError(null);

    try {
      await setCustomerPriceGroup(customer.id, selectedPriceGroupId);
      const refreshed = await getStaffCustomer(customer.id);
      if (refreshed) {
        setCustomer(refreshed);
        setSelectedPriceGroupId(refreshed.price_group_id ?? selectedPriceGroupId);
      }
      await refreshIndividualPrices();
    } catch (error: unknown) {
      setPriceGroupError(error instanceof Error ? error.message : "Не удалось сохранить группу");
    } finally {
      setPriceGroupSaving(false);
    }
  }

  async function handleSaveIndividualPrice(productId: string) {
    if (!customer || !canEditPricing || savingIndividualProductId) return;

    const price = parseOptionalNumber(individualPriceDrafts[productId] ?? "");
    if (price == null || price < 0) {
      setIndividualPricesError("Укажите корректную индивидуальную цену");
      return;
    }

    setSavingIndividualProductId(productId);
    setIndividualPricesError(null);

    try {
      await upsertCustomerProductPrice({
        customerId: customer.id,
        productId,
        price,
      });
      await refreshIndividualPrices();
    } catch (error: unknown) {
      setIndividualPricesError(error instanceof Error ? error.message : "Не удалось сохранить цену");
    } finally {
      setSavingIndividualProductId(null);
    }
  }

  async function handleDeleteIndividualPrice(productId: string) {
    if (!customer || !canEditPricing || deletingIndividualProductId) return;

    setDeletingIndividualProductId(productId);
    setIndividualPricesError(null);

    try {
      await deleteCustomerProductPrice({
        customerId: customer.id,
        productId,
      });
      await refreshIndividualPrices();
    } catch (error: unknown) {
      setIndividualPricesError(error instanceof Error ? error.message : "Не удалось удалить цену");
    } finally {
      setDeletingIndividualProductId(null);
    }
  }

  async function handleAddIndividualPrice(event: React.FormEvent) {
    event.preventDefault();
    if (!customer || !canEditPricing || addIndividualBusy || !selectedAddProduct) return;

    const price = parseOptionalNumber(addIndividualPrice);
    if (price == null || price < 0) {
      setAddIndividualError("Укажите корректную цену");
      return;
    }

    setAddIndividualBusy(true);
    setAddIndividualError(null);

    try {
      await upsertCustomerProductPrice({
        customerId: customer.id,
        productId: selectedAddProduct.product_id,
        price,
      });
      setSelectedAddProduct(null);
      setAddProductSearch("");
      setAddIndividualPrice("");
      await refreshIndividualPrices();
    } catch (error: unknown) {
      setAddIndividualError(error instanceof Error ? error.message : "Не удалось добавить цену");
    } finally {
      setAddIndividualBusy(false);
    }
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!customer || saving || !canManage) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const updated = await updateStaffCustomer(customer.id, {
        display_name: displayName,
        legal_name: legalName,
        phone: phone,
        email: email,
        iin_bin: iinBin,
        contact_person: contactPerson,
        address: address,
        city: city,
        source,
        notes: notes,
      });

      setCustomer({
        ...customer,
        ...updated,
        is_registered: customer.is_registered,
        orders_count: customer.orders_count,
        last_order_at: customer.last_order_at,
      });
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  if (!customerId) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Клиент не найден</h1>
        <Link
          href="/staff/customers"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          К списку клиентов
        </Link>
      </div>
    );
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Загрузка...</p>;
  }

  if (loadError || !customer) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-2xl font-bold text-neutral-800">Клиент не найден</h1>
        <p className="mt-4 text-neutral-600">{loadError ?? "Нет данных"}</p>
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
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <Link
          href="/staff/customers"
          className={`text-sm font-medium text-neutral-500 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
        >
          ← К клиентам
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-neutral-800">{customer.display_name}</h1>
            <p className="mt-1 text-sm text-neutral-500">
              {CUSTOMER_TYPE_LABELS[customer.customer_type]}
              {" · "}
              {customer.is_registered ? "Зарегистрирован" : "Без аккаунта"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage && !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className={`rounded-md border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
              >
                Редактировать
              </button>
            )}
            {canCreateOrder && (
              <Link
                href={`/staff/orders/new?customer_id=${customer.id}`}
                className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
              >
                Создать заказ
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-neutral-200">
        <button
          type="button"
          onClick={() => setTab("info")}
          className={`px-4 py-2.5 text-sm font-medium transition-colors ${focusRing} ${
            tab === "info"
              ? "border-b-2 border-[#0F766E] text-[#0F766E]"
              : "text-neutral-500 hover:text-neutral-800"
          }`}
        >
          Карточка
        </button>
        <button
          type="button"
          onClick={() => setTab("activity")}
          className={`px-4 py-2.5 text-sm font-medium transition-colors ${focusRing} ${
            tab === "activity"
              ? "border-b-2 border-[#0F766E] text-[#0F766E]"
              : "text-neutral-500 hover:text-neutral-800"
          }`}
        >
          Активность
        </button>
      </div>

      {tab === "activity" ? (
        <section className="rounded-lg border border-neutral-200 bg-white p-5">
          <StaffCustomerActivity customerId={customer.id} />
        </section>
      ) : (
        <>
      {editing ? (
        <form
          onSubmit={handleSave}
          className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Имя *</span>
            <input
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Юридическое название
            </span>
            <input
              value={legalName}
              onChange={(event) => setLegalName(event.target.value)}
              className={inputClass}
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Телефон</span>
              <input value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">ИИН / БИН</span>
              <input value={iinBin} onChange={(event) => setIinBin(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Контактное лицо
              </span>
              <input
                value={contactPerson}
                onChange={(event) => setContactPerson(event.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Адрес</span>
            <input value={address} onChange={(event) => setAddress(event.target.value)} className={inputClass} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Город</span>
              <input value={city} onChange={(event) => setCity(event.target.value)} className={inputClass} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Источник</span>
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as CustomerSource)}
                className={inputClass}
              >
                {CUSTOMER_SOURCES.map((value) => (
                  <option key={value} value={value}>
                    {CUSTOMER_SOURCE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заметка</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              className={inputClass}
            />
          </label>
          {saveError && (
            <p className="text-sm text-red-600" role="alert">
              {saveError}
            </p>
          )}
          <div className="flex gap-2">
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
              onClick={() => {
                setEditing(false);
                setSaveError(null);
                setDisplayName(customer.display_name);
                setLegalName(customer.legal_name ?? "");
                setPhone(customer.phone ?? "");
                setEmail(customer.email ?? "");
                setIinBin(customer.iin_bin ?? "");
                setContactPerson(customer.contact_person ?? "");
                setAddress(customer.address ?? "");
                setCity(customer.city ?? "");
                setSource(customer.source ?? "staff");
                setNotes(customer.notes ?? "");
              }}
              className={`rounded-md border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-600 ${focusRing}`}
            >
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <div className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-5 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Телефон</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.phone ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Email</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.email ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Юридическое название
            </p>
            <p className="mt-1 text-sm text-neutral-800">{customer.legal_name ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">ИИН / БИН</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.iin_bin ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Контактное лицо</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.contact_person ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Город</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.city ?? "—"}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Адрес</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.address ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Источник</p>
            <p className="mt-1 text-sm text-neutral-800">
              {customer.source ? CUSTOMER_SOURCE_LABELS[customer.source] : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заказов</p>
            <p className="mt-1 text-sm text-neutral-800">{customer.orders_count}</p>
          </div>
          {customer.notes && (
            <div className="sm:col-span-2">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Заметка</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-800">{customer.notes}</p>
            </div>
          )}
        </div>
      )}

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Ценовая категория</h2>
        {canEditPricing ? (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Группа
              </span>
              <select
                value={selectedPriceGroupId}
                onChange={(event) => setSelectedPriceGroupId(event.target.value)}
                className={inputClass}
              >
                <option value="">Выберите группу</option>
                {priceGroups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                    {group.is_default ? " (по умолчанию)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={
                priceGroupSaving ||
                !selectedPriceGroupId ||
                selectedPriceGroupId === (customer.price_group_id ?? "")
              }
              onClick={() => {
                handleSavePriceGroup().catch(() => undefined);
              }}
              className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
            >
              {priceGroupSaving ? "Сохранение..." : "Сохранить"}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-neutral-800">
            {customer.price_group_name ?? "—"}
            {customer.price_group_is_default ? " (по умолчанию)" : ""}
          </p>
        )}
        {priceGroupError && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {priceGroupError}
          </p>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Индивидуальные спеццены</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Переопределения цен для отдельных товаров. В таблице только активные индивидуальные цены.
        </p>

        {canEditPricing && (
          <form
            onSubmit={handleAddIndividualPrice}
            className="mt-4 flex flex-col gap-3 rounded-md border border-neutral-100 bg-neutral-50 p-4"
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Поиск товара
              </span>
              <input
                type="search"
                value={addProductSearch}
                onChange={(event) => {
                  setAddProductSearch(event.target.value);
                  setSelectedAddProduct(null);
                }}
                placeholder="Название или артикул"
                className={inputClass}
              />
            </label>
            {addProductSearchError && (
              <p className="text-sm text-red-600" role="alert">
                {addProductSearchError}
              </p>
            )}
            {addProductSearchLoading ? (
              <p className="text-sm text-neutral-500">Поиск...</p>
            ) : (
              addProductResults.length > 0 &&
              !selectedAddProduct && (
                <ul className="max-h-40 overflow-y-auto rounded-md border border-neutral-200 bg-white">
                  {addProductResults.map((product) => (
                    <li key={product.product_id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAddProduct(product);
                          setAddProductSearch(`${product.sku} — ${product.name}`);
                        }}
                        className={`flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-neutral-50 ${focusRing}`}
                      >
                        <span className="font-medium text-neutral-800">{product.name}</span>
                        <span className="text-xs text-neutral-500">
                          {product.sku}
                          {product.price != null ? ` · ${formatPrice(product.price)}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
            {selectedAddProduct && (
              <p className="text-sm text-neutral-700">
                Выбран: {selectedAddProduct.name} ({selectedAddProduct.sku})
              </p>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Спеццена
              </span>
              <input
                value={addIndividualPrice}
                onChange={(event) => setAddIndividualPrice(event.target.value)}
                className={inputClass}
                inputMode="decimal"
                placeholder="Цена"
              />
            </label>
            {addIndividualError && (
              <p className="text-sm text-red-600" role="alert">
                {addIndividualError}
              </p>
            )}
            <button
              type="submit"
              disabled={addIndividualBusy || !selectedAddProduct}
              className={`self-start rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
            >
              {addIndividualBusy ? "Добавление..." : "Добавить спеццену"}
            </button>
          </form>
        )}

        {individualPricesError && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {individualPricesError}
          </p>
        )}

        {individualPrices.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">Спеццен пока нет</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-3">Товар</th>
                  <th className="px-3 py-3 text-right">Базовая</th>
                  <th className="px-3 py-3 text-right">Цена категории</th>
                  <th className="px-3 py-3 text-right">Спеццена</th>
                  <th className="px-3 py-3 text-right">Итоговая</th>
                  {canEditPricing && <th className="px-3 py-3" />}
                </tr>
              </thead>
              <tbody>
                {individualPrices.map((row) => {
                  const rowSaving = savingIndividualProductId === row.product_id;
                  const rowDeleting = deletingIndividualProductId === row.product_id;

                  return (
                    <tr key={row.product_id} className="border-b border-neutral-100 last:border-0">
                      <td className="px-3 py-3">
                        <p className="font-medium text-neutral-800">{row.name}</p>
                        <p className="text-xs text-neutral-500">{row.sku}</p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                        {formatOptionalPrice(row.base_price)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-neutral-600">
                        {formatOptionalPrice(row.group_price)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-neutral-800">
                        {canEditPricing ? (
                          <input
                            value={individualPriceDrafts[row.product_id] ?? ""}
                            onChange={(event) => {
                              setIndividualPriceDrafts((prev) => ({
                                ...prev,
                                [row.product_id]: event.target.value,
                              }));
                            }}
                            className={`${inputClass} ml-auto max-w-[120px] text-right`}
                            inputMode="decimal"
                          />
                        ) : (
                          formatOptionalPrice(row.individual_price)
                        )}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-neutral-800">
                        {formatOptionalPrice(row.effective_price)}
                      </td>
                      {canEditPricing && (
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              disabled={rowSaving || rowDeleting}
                              onClick={() => {
                                handleSaveIndividualPrice(row.product_id).catch(() => undefined);
                              }}
                              className={`rounded-md bg-[#0F766E] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
                            >
                              {rowSaving ? "..." : "Сохранить"}
                            </button>
                            <button
                              type="button"
                              disabled={rowSaving || rowDeleting}
                              onClick={() => {
                                handleDeleteIndividualPrice(row.product_id).catch(() => undefined);
                              }}
                              className={`text-xs font-medium text-neutral-500 hover:text-red-600 disabled:opacity-60 ${focusRing}`}
                            >
                              {rowDeleting ? "..." : "Удалить"}
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-neutral-800">Дебиторка</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Обязательства по незакрытым платежам (включая завершённые заказы с долгом).
        </p>
        {receivablesError ? (
          <p className="mt-3 text-sm text-neutral-500">{receivablesError}</p>
        ) : !receivables ? (
          <p className="mt-3 text-sm text-neutral-500">Загрузка...</p>
        ) : (
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Обязательства
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
                {formatPrice(receivables.open_obligation_total)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Оплачено
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
                {formatPrice(receivables.amount_paid_total)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Задолженность
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
                {formatPrice(receivables.amount_outstanding_total)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Заказов с долгом
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
                {receivables.orders_with_balance_count}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Просрочено
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-red-700">
                {formatPrice(receivables.overdue_outstanding_total)}
              </dd>
              <p className="mt-0.5 text-xs text-neutral-500">
                заказов: {receivables.overdue_orders_count}
              </p>
            </div>
          </dl>
        )}
      </section>

      <div className="rounded-lg border border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 className="text-lg font-semibold text-neutral-800">Заказы</h2>
        </div>
        {orders.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-500">Заказов пока нет</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  <th className="px-5 py-3">№</th>
                  <th className="px-5 py-3">Дата</th>
                  <th className="px-5 py-3">Статус</th>
                  <th className="px-5 py-3 text-right">Сумма</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-5 py-3 font-medium text-neutral-800">{order.order_number}</td>
                    <td className="px-5 py-3 text-neutral-600">{formatDateTime(order.created_at)}</td>
                    <td className="px-5 py-3 text-neutral-600">
                      {ORDER_STATUS_LABELS[order.status] ?? order.status}
                    </td>
                    <td className="px-5 py-3 text-right text-neutral-800">{formatPrice(order.total)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/staff/orders/${order.id}`}
                        className={`text-sm font-medium text-[#0F766E] hover:text-[#0c5f58] ${focusRing}`}
                      >
                        Открыть
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}
