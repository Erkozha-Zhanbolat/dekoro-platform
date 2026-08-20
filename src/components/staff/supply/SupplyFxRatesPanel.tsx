"use client";

import { useState } from "react";
import {
  formatSupplyRate,
  getSupplyFxRate,
  setProductSupplyFxRates,
  type ProductSupplyFxRate,
  type ProductSupplyPayload,
} from "@/lib/staff/supplies";
import type { ProductSupplyCurrency, ProductSupplyHeader } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";
const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none transition-colors focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function toInput(value: number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

export default function SupplyFxRatesPanel({
  supply,
  fxRates,
  readOnly,
  onUpdated,
}: {
  supply: ProductSupplyHeader;
  fxRates: ProductSupplyFxRate[];
  readOnly: boolean;
  onUpdated: (payload: ProductSupplyPayload) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [cny, setCny] = useState("");
  const [usd, setUsd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const cnyRate = getSupplyFxRate(fxRates, "CNY", {
    currency: supply.default_currency,
    rate: supply.default_exchange_rate_to_kzt,
  });
  const usdRate = getSupplyFxRate(fxRates, "USD", {
    currency: supply.default_currency,
    rate: supply.default_exchange_rate_to_kzt,
  });

  function beginEdit() {
    setCny(toInput(cnyRate));
    setUsd(toInput(usdRate));
    setError(null);
    setInfo(null);
    setEditing(true);
  }

  async function save() {
    if (busy || readOnly) return;
    const rates: Array<{ currency: "CNY" | "USD"; rateToKzt: number }> = [];
    const cnyValue = cny.trim() === "" ? null : Number(cny.replace(",", "."));
    const usdValue = usd.trim() === "" ? null : Number(usd.replace(",", "."));

    if (cnyValue != null) {
      if (!Number.isFinite(cnyValue) || cnyValue <= 0) {
        setError("Курс CNY должен быть больше 0");
        return;
      }
      rates.push({ currency: "CNY", rateToKzt: cnyValue });
    }
    if (usdValue != null) {
      if (!Number.isFinite(usdValue) || usdValue <= 0) {
        setError("Курс USD должен быть больше 0");
        return;
      }
      rates.push({ currency: "USD", rateToKzt: usdValue });
    }
    if (rates.length === 0) {
      setError("Укажите хотя бы один курс (CNY или USD)");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const next = await setProductSupplyFxRates(supply.id, rates);
      onUpdated(next);
      const applied = next.fx_apply;
      setInfo(
        applied
          ? `Пересчитано ${applied.items} товарных позиций и ${applied.expenses} расходов`
          : "Курсы сохранены",
      );
      setEditing(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить курсы");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Курсы поставки
        </h2>
        {!readOnly && !editing ? (
          <button
            type="button"
            onClick={beginEdit}
            className={`rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
          >
            Изменить курсы
          </button>
        ) : null}
      </div>

      <p className="text-xs text-neutral-500">
        Один курс на поставку. Товары и расходы без своего override наследуют эти значения. KZT = 1.
      </p>

      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              CNY → KZT
            </span>
            <input
              value={cny}
              onChange={(e) => setCny(e.target.value)}
              className={inputClass}
              inputMode="decimal"
              placeholder="71.80"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              USD → KZT
            </span>
            <input
              value={usd}
              onChange={(e) => setUsd(e.target.value)}
              className={inputClass}
              inputMode="decimal"
              placeholder="535.00"
            />
          </label>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FxStat currency="CNY" rate={cnyRate} />
          <FxStat currency="USD" rate={usdRate} />
        </div>
      )}

      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      {info ? <p className="text-sm text-[#0F766E]">{info}</p> : null}

      {editing ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-60 ${focusRing}`}
          >
            {busy ? "Сохранение..." : "Сохранить курсы"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(false)}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 ${focusRing}`}
          >
            Отмена
          </button>
        </div>
      ) : null}
    </section>
  );
}

function FxStat({ currency, rate }: { currency: ProductSupplyCurrency; rate: number | null }) {
  return (
    <div className="rounded-md border border-neutral-100 bg-neutral-50 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{currency}</p>
      <p className="mt-1 text-lg font-semibold text-neutral-800">
        {rate == null ? (
          <span className="text-amber-700">Требуется курс {currency} → KZT</span>
        ) : (
          <>{formatSupplyRate(rate)} ₸</>
        )}
      </p>
    </div>
  );
}
