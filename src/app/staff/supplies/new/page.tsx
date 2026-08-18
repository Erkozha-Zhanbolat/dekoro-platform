"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useProfile } from "@/context/ProfileContext";
import { createProductSupply, parseSupplyNumber } from "@/lib/staff/supplies";
import {
  PRODUCT_SUPPLY_CURRENCIES,
  canAccessProductSupplies,
  type ProductSupplyCurrency,
} from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function StaffNewSupplyPage() {
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const allowed = canAccessProductSupplies(profile?.role);

  const [title, setTitle] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplyDate, setSupplyDate] = useState(todayIso);
  const [currency, setCurrency] = useState<ProductSupplyCurrency>("CNY");
  const [rate, setRate] = useState("");
  const [gross, setGross] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profileLoading && profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, allowed, router]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload = await createProductSupply({
        title,
        supplierName: supplierName.trim() || null,
        supplyDate,
        defaultCurrency: currency,
        defaultExchangeRateToKzt: currency === "KZT" ? 1 : parseSupplyNumber(rate),
        grossWeightKg: parseSupplyNumber(gross),
        notes: notes.trim() || null,
      });
      router.replace(`/staff/supplies/${payload.supply.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать поставку");
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <Link href="/staff/supplies" className={`text-sm text-[#0F766E] hover:underline ${focusRing}`}>
          ← К поставкам
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-neutral-900">Новая поставка</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Данные вводятся вручную. Импорт накладной можно будет добавить позже в эту же модель.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Название *
          </span>
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputClass}
            placeholder="Поставка бамбука, апрель"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Поставщик
          </span>
          <input
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
            className={inputClass}
            placeholder="Название фабрики / поставщика"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Дата</span>
            <input
              type="date"
              value={supplyDate}
              onChange={(e) => setSupplyDate(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Валюта закупки
            </span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as ProductSupplyCurrency)}
              className={inputClass}
            >
              {PRODUCT_SUPPLY_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        </div>

        {currency !== "KZT" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Курс к KZT
            </span>
            <input
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className={inputClass}
              inputMode="decimal"
              placeholder="Например 75.5"
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Фактический брутто-вес, кг
          </span>
          <input
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            className={inputClass}
            inputMode="decimal"
            placeholder="Можно указать позже"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Заметки
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className={`${inputClass} min-h-[90px]`}
          />
        </label>

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={saving}
            className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {saving ? "Создание..." : "Создать поставку"}
          </button>
          <Link
            href="/staff/supplies"
            className={`rounded-md border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 hover:border-neutral-300 ${focusRing}`}
          >
            Отмена
          </Link>
        </div>
      </form>
    </div>
  );
}
