"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode, SVGProps } from "react";
import { useAuth } from "@/context/AuthContext";
import { USER_ROLE_LABELS } from "@/types/database";
import type { Profile } from "@/types/database";
import { getStaffNavItems } from "@/components/staff/staffNav";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function MenuIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}

function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  );
}

function SoonBadge() {
  return (
    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
      Скоро
    </span>
  );
}

function NavLinks({ role, pathname, onNavigate }: {
  role: Profile["role"];
  pathname: string;
  onNavigate?: () => void;
}) {
  const items = getStaffNavItems(role);

  function isItemActive(href: string): boolean {
    if (href === "/staff") {
      return pathname === "/staff";
    }
    if (!pathname.startsWith(href)) {
      return false;
    }
    // Prefer the most specific matching nav item (e.g. /staff/settings/users
    // over /staff/settings).
    const moreSpecificExists = items.some(
      (other) =>
        other.enabled &&
        other.href !== href &&
        other.href.startsWith(href) &&
        pathname.startsWith(other.href),
    );
    return !moreSpecificExists;
  }

  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        if (!item.enabled) {
          return (
            <span
              key={item.href}
              className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-neutral-400"
            >
              {item.label}
              <SoonBadge />
            </span>
          );
        }

        const isActive = isItemActive(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${focusRing} ${
              isActive
                ? "bg-[#0F766E]/10 text-[#0F766E]"
                : "text-neutral-600 hover:bg-neutral-50 hover:text-[#0F766E]"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function StaffShell({
  profile,
  children,
}: {
  profile: Profile;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/staff";
  const { signOut } = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  const roleLabel = USER_ROLE_LABELS[profile.role];

  return (
    <div className="flex min-h-screen bg-neutral-50">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-neutral-200 bg-white md:flex md:flex-col">
        <div className="flex flex-col px-5 py-5">
          <Link href="/staff" className={`flex flex-col leading-none rounded-sm ${focusRing}`}>
            <span className="text-lg font-bold tracking-tight text-neutral-800">DEKORO</span>
            <span className="mt-0.5 text-[11px] uppercase tracking-wide text-neutral-400">
              Панель сотрудника
            </span>
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <NavLinks role={profile.role} pathname={pathname} />
        </div>
        <div className="border-t border-neutral-200 px-5 py-4">
          <Link
            href="/"
            className={`text-xs font-medium text-neutral-400 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
          >
            ← На витрину DEKORO
          </Link>
        </div>
      </aside>

      <div className="flex min-h-screen flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 md:px-8">
          <button
            type="button"
            aria-label={isMenuOpen ? "Закрыть меню" : "Открыть меню"}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((open) => !open)}
            className={`flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] md:hidden ${focusRing}`}
          >
            {isMenuOpen ? <CloseIcon className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
          </button>

          <span className="text-sm font-semibold text-neutral-800 md:hidden">DEKORO Staff</span>

          <div className="ml-auto flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-neutral-800">{profile.full_name}</p>
              <p className="text-xs text-neutral-500">{roleLabel}</p>
            </div>
            <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600 sm:hidden">
              {roleLabel}
            </span>
            <button
              type="button"
              onClick={handleSignOut}
              className={`rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
            >
              Выйти
            </button>
          </div>
        </header>

        {/* Mobile nav drawer */}
        {isMenuOpen && (
          <div className="border-b border-neutral-200 bg-white px-4 py-3 md:hidden">
            <NavLinks
              role={profile.role}
              pathname={pathname}
              onNavigate={() => setIsMenuOpen(false)}
            />
          </div>
        )}

        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
