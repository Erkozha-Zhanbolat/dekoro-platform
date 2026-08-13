"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canAccessWarehouseHistory, type UserRole } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function WarehouseSectionNav({
  role,
}: {
  role: UserRole | null | undefined;
}) {
  const pathname = usePathname() ?? "";
  const showHistory = canAccessWarehouseHistory(role);
  const onHistory = pathname.startsWith("/staff/warehouse/history");

  return (
    <div className="flex gap-1 overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-50 p-1">
      <Link
        href="/staff/warehouse"
        className={`min-w-[8.5rem] flex-1 rounded-md px-3 py-2.5 text-center text-sm font-medium transition-colors ${focusRing} ${
          !onHistory
            ? "bg-white text-[#0F766E] shadow-sm"
            : "text-neutral-600 hover:text-neutral-800"
        }`}
      >
        Текущие заказы
      </Link>
      {showHistory && (
        <Link
          href="/staff/warehouse/history"
          className={`min-w-[8.5rem] flex-1 rounded-md px-3 py-2.5 text-center text-sm font-medium transition-colors ${focusRing} ${
            onHistory
              ? "bg-white text-[#0F766E] shadow-sm"
              : "text-neutral-600 hover:text-neutral-800"
          }`}
        >
          История отгрузок
        </Link>
      )}
    </div>
  );
}