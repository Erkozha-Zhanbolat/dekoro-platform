"use client";

import type { ChangeEvent } from "react";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export interface QuantitySelectorProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}

function clampQuantity(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(min, Math.trunc(value)), max);
}

export function QuantitySelector({
  value,
  onChange,
  min = 1,
  max,
  unit,
  disabled = false,
  size = "md",
}: QuantitySelectorProps) {
  const isDecreaseDisabled = disabled || value <= min;
  const isIncreaseDisabled = disabled || value >= max;

  function handleDecrease() {
    onChange(clampQuantity(value - 1, min, max));
  }

  function handleIncrease() {
    onChange(clampQuantity(value + 1, min, max));
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(clampQuantity(Number(event.target.value), min, max));
  }

  const buttonSizeClass = size === "sm" ? "h-8 w-8" : "h-9 w-9";
  const inputSizeClass = size === "sm" ? "h-8 w-10 text-sm" : "h-9 w-14 text-sm";

  return (
    <div className="inline-flex items-center gap-2">
      <div
        className={`inline-flex items-center rounded-md border border-neutral-200 ${
          disabled ? "opacity-50" : ""
        }`}
      >
        <button
          type="button"
          onClick={handleDecrease}
          disabled={isDecreaseDisabled}
          aria-label="Уменьшить количество"
          className={`flex ${buttonSizeClass} items-center justify-center text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent ${focusRing}`}
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={handleInputChange}
          disabled={disabled}
          aria-label={unit ? `Количество, ${unit}` : "Количество"}
          className={`${inputSizeClass} border-x border-neutral-200 text-center font-medium text-neutral-800 outline-none disabled:bg-neutral-50 disabled:text-neutral-300 ${focusRing}`}
        />
        <button
          type="button"
          onClick={handleIncrease}
          disabled={isIncreaseDisabled}
          aria-label="Увеличить количество"
          className={`flex ${buttonSizeClass} items-center justify-center text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent ${focusRing}`}
        >
          +
        </button>
      </div>
      {unit && <span className="text-xs text-neutral-500">{unit}</span>}
    </div>
  );
}
