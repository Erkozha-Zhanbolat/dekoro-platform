"use client";

import Link from "next/link";
import { useState } from "react";
import type { SVGProps } from "react";
import { useCart } from "@/context/CartContext";
import { useAuth } from "@/context/AuthContext";

const primaryLinks = [
  { href: "/catalog", label: "Каталог" },
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
  const { totalQuantity } = useCart();
  const { user } = useAuth();
  const profileHref = user ? "/profile" : "/login";

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

          <nav className="ml-auto hidden items-center gap-6 md:flex">
            <Link
              href="/orders"
              className={`text-sm font-medium text-neutral-600 transition-colors hover:text-[#0F766E] rounded-sm ${focusRing}`}
            >
              Мои заказы
            </Link>
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

          <div className="ml-auto flex items-center gap-1 md:hidden">
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
            <Link
              href="/orders"
              onClick={() => setIsMenuOpen(false)}
              className={`rounded-md px-2 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 hover:text-[#0F766E] ${focusRing}`}
            >
              Мои заказы
            </Link>
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
