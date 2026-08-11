"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { SVGProps } from "react";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";
import { useProfile } from "@/context/ProfileContext";
import { useFavorites } from "@/context/FavoritesContext";
import { canAccessStaff } from "@/types/database";
import { enableQuickOrder, useSupabaseCatalog, useSupabaseFavorites } from "@/lib/featureFlags";
import ClientNotificationBell from "@/components/ClientNotificationBell";

// Shared by both the desktop nav and the mobile menu below, so the Quick
// Order link only needs to be added/removed here, once, to affect both.
const primaryLinks = [
  { href: "/catalog", label: "Каталог" },
  ...(enableQuickOrder ? [{ href: "/quick-order", label: "Быстрый заказ" }] : []),
  { href: "/promotions", label: "Акции" },
];

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function SearchIcon(props: SVGProps<SVGSVGElement>) {
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
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CartIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M3 4h2l2.4 12.4a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.6L20 8H6" />
      <circle cx="9" cy="20" r="1" />
      <circle cx="17" cy="20" r="1" />
    </svg>
  );
}

function HeartIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M12 20.5s-7.6-4.6-10.1-9.4C0.4 7.9 1.7 4.4 4.8 3.4c2.5-.8 5.1 0 7.2 2.6 2.1-2.6 4.7-3.4 7.2-2.6 3.1 1 4.4 4.5 2.9 7.7C19.6 15.9 12 20.5 12 20.5z" />
    </svg>
  );
}

function ProfileIcon(props: SVGProps<SVGSVGElement>) {
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
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" />
    </svg>
  );
}

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

function SearchField({ id }: { id: string }) {
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        Поиск по товарам и артикулам
      </label>
      <input
        id={id}
        type="search"
        name="q"
        placeholder="Поиск по товарам и артикулам"
        className={`w-full rounded-md border border-neutral-200 bg-neutral-50 py-2.5 pl-4 pr-11 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:bg-white focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
      />
      <button
        type="submit"
        aria-label="Найти"
        className={`absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
      >
        <SearchIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const pathname = usePathname();
  const { totalQuantity } = useCart();
  const { user } = useAuth();
  const { profile } = useProfile();
  const { favoriteProductIds } = useFavorites();
  const profileHref = user ? "/profile" : "/login";
  // Local (static catalog) favorites work for guests too, so the count is
  // always shown there. In Supabase mode favorites are per signed-in user,
  // so the count only makes sense once someone is authenticated.
  const showFavoritesCount = !useSupabaseCatalog || !!user;
  const favoritesLabel = showFavoritesCount
    ? `Избранное (${favoriteProductIds.length})`
    : "Избранное";
  const showStaffLink = canAccessStaff(profile?.role ?? null);

  // The Staff Platform (/staff/**) has its own dedicated shell/navigation
  // (see src/components/staff/StaffShell.tsx) — the customer-facing header
  // is only for the storefront.
  if (pathname?.startsWith("/staff")) {
    return null;
  }

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex items-center gap-4 py-3 md:gap-6 md:py-4">
          <Link
            href="/"
            className={`flex flex-col leading-none rounded-sm ${focusRing}`}
          >
            <span className="text-xl font-bold tracking-tight text-neutral-800">
              DEKORO
            </span>
            <span className="mt-0.5 text-[11px] uppercase tracking-wide text-neutral-400">
              B2B Platform
            </span>
          </Link>

          <nav className="hidden items-center gap-5 md:flex">
            {primaryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm font-medium text-neutral-600 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <form
            onSubmit={(event) => event.preventDefault()}
            className="hidden flex-1 max-w-xl md:block"
          >
            <SearchField id="header-search-desktop" />
          </form>

          <div className="ml-auto flex items-center gap-2 md:gap-6">
            {user ? (
              <ClientNotificationBell key={user.id} profileId={user.id} />
            ) : null}

            <nav className="hidden items-center gap-6 md:flex">
              {showStaffLink && (
                <Link
                  href="/staff"
                  className={`text-sm font-medium text-[#0F766E] transition-colors hover:text-[#0c5f58] rounded-sm ${focusRing}`}
                >
                  Панель сотрудников
                </Link>
              )}
              <Link
                href="/orders"
                className={`text-sm font-medium text-neutral-600 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
              >
                Мои заказы
              </Link>
              {useSupabaseFavorites && (
                <Link
                  href="/favorites"
                  className={`flex items-center gap-2 text-sm font-medium text-neutral-600 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
                >
                  <HeartIcon className="h-5 w-5" />
                  {favoritesLabel}
                </Link>
              )}
              <Link
                href="/cart"
                className={`flex items-center gap-2 text-sm font-medium text-neutral-600 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
              >
                <span className="relative">
                  <CartIcon className="h-5 w-5" />
                  <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#0F766E] px-1 text-[10px] font-semibold leading-none text-white">
                    {totalQuantity}
                  </span>
                </span>
                Корзина
              </Link>
              <Link
                href={profileHref}
                className={`flex items-center gap-2 text-sm font-medium text-neutral-600 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
              >
                <ProfileIcon className="h-5 w-5" />
                Профиль
              </Link>
            </nav>

            <div className="flex items-center gap-1 md:hidden">
              <Link
                href="/cart"
                aria-label="Корзина"
                className={`relative flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
              >
                <CartIcon className="h-5 w-5" />
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#0F766E] px-1 text-[10px] font-semibold leading-none text-white">
                  {totalQuantity}
                </span>
              </Link>
              <button
                type="button"
                aria-label={isMenuOpen ? "Закрыть меню" : "Открыть меню"}
                aria-expanded={isMenuOpen}
                onClick={() => setIsMenuOpen((open) => !open)}
                className={`flex h-9 w-9 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
              >
                {isMenuOpen ? (
                  <CloseIcon className="h-5 w-5" />
                ) : (
                  <MenuIcon className="h-5 w-5" />
                )}
              </button>
            </div>
          </div>
        </div>

        <form
          onSubmit={(event) => event.preventDefault()}
          className="pb-3 md:hidden"
        >
          <SearchField id="header-search-mobile" />
        </form>
      </div>

      {isMenuOpen && (
        <div className="border-t border-neutral-100 md:hidden">
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3 sm:px-6">
            {primaryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setIsMenuOpen(false)}
                className={`rounded-md px-2 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-[#0F766E] ${focusRing}`}
              >
                {link.label}
              </Link>
            ))}
            {showStaffLink && (
              <Link
                href="/staff"
                onClick={() => setIsMenuOpen(false)}
                className={`rounded-md px-2 py-2 text-sm font-medium text-[#0F766E] transition-colors hover:bg-neutral-50 ${focusRing}`}
              >
                Панель сотрудников
              </Link>
            )}
            {user ? (
              <Link
                href="/notifications"
                onClick={() => setIsMenuOpen(false)}
                className={`rounded-md px-2 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-[#0F766E] ${focusRing}`}
              >
                Уведомления
              </Link>
            ) : null}
            <Link
              href="/orders"
              onClick={() => setIsMenuOpen(false)}
              className={`rounded-md px-2 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-[#0F766E] ${focusRing}`}
            >
              Мои заказы
            </Link>
            {useSupabaseFavorites && (
              <Link
                href="/favorites"
                onClick={() => setIsMenuOpen(false)}
                className={`rounded-md px-2 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-[#0F766E] ${focusRing}`}
              >
                {favoritesLabel}
              </Link>
            )}
            <Link
              href={profileHref}
              onClick={() => setIsMenuOpen(false)}
              className={`rounded-md px-2 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-[#0F766E] ${focusRing}`}
            >
              Профиль
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}
