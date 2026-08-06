"use client";

import { usePathname } from "next/navigation";
import { AnalyticsConsentSettings } from "@/components/AnalyticsConsentBanner";

export default function Footer() {
  const pathname = usePathname();
  const year = new Date().getFullYear();

  // Same reasoning as Header.tsx: the Staff Platform has its own shell and
  // doesn't show the storefront footer.
  if (pathname?.startsWith("/staff")) {
    return null;
  }

  return (
    <footer className="border-t border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
        <div className="flex flex-col items-center gap-2 text-sm text-neutral-500 sm:flex-row sm:justify-between">
          <span className="font-semibold text-neutral-700">DEKORO</span>
          <span>B2B-платформа для партнёров</span>
          <span>© {year}</span>
        </div>
        <AnalyticsConsentSettings className="border-t border-neutral-100 pt-4" />
      </div>
    </footer>
  );
}
