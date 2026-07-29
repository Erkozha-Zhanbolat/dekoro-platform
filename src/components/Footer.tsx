"use client";

import { usePathname } from "next/navigation";

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
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-2 px-6 py-6 text-sm text-neutral-500 sm:flex-row sm:justify-between">
        <span className="font-semibold text-neutral-700">DEKORO</span>
        <span>B2B-платформа для партнёров</span>
        <span>© {year}</span>
      </div>
    </footer>
  );
}
