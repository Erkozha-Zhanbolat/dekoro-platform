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
import type { CustomerSource } from "@/types/database";
import {
  CUSTOMER_SOURCE_LABELS,
  CUSTOMER_SOURCES,
  CUSTOMER_TYPE_LABELS,
  ORDER_STATUS_LABELS,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

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
  const canCreateOrder = canManage;

  const [customer, setCustomer] = useState<StaffCustomerDetails | null>(null);
  const [orders, setOrders] = useState<StaffCustomerOrderListItem[]>([]);
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
    </div>
  );
}
