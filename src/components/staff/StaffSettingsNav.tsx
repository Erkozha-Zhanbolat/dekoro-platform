"use client";

import Link from "next/link";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export type StaffSettingsTab = "org" | "users" | "pricing" | "catalogs" | "data";

export default function StaffSettingsNav({ active }: { active: StaffSettingsTab }) {
  const tabClass = (isActive: boolean) =>
    isActive
      ? "rounded-md bg-[#0F766E]/10 px-3 py-1.5 text-sm font-medium text-[#0F766E]"
      : `rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`;

  return (
    <div className="mt-4 flex flex-wrap gap-2 border-b border-neutral-200 pb-3">
      {active === "org" ? (
        <span className={tabClass(true)}>Организация</span>
      ) : (
        <Link href="/staff/settings" className={tabClass(false)}>
          Организация
        </Link>
      )}
      {active === "users" ? (
        <span className={tabClass(true)}>Сотрудники</span>
      ) : (
        <Link href="/staff/settings/users" className={tabClass(false)}>
          Сотрудники
        </Link>
      )}
      {active === "pricing" ? (
        <span className={tabClass(true)}>Цены</span>
      ) : (
        <Link href="/staff/settings/pricing" className={tabClass(false)}>
          Цены
        </Link>
      )}
      {active === "catalogs" ? (
        <span className={tabClass(true)}>Заводские каталоги</span>
      ) : (
        <Link href="/staff/settings/catalogs" className={tabClass(false)}>
          Заводские каталоги
        </Link>
      )}
      {active === "data" ? (
        <span className={tabClass(true)}>Управление данными</span>
      ) : (
        <Link href="/staff/settings/data" className={tabClass(false)}>
          Управление данными
        </Link>
      )}
    </div>
  );
}
