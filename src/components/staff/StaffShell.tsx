"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { ReactNode, SVGProps } from "react";
import { useAuth } from "@/context/AuthContext";
import { USER_ROLE_LABELS } from "@/types/database";
import type { Profile } from "@/types/database";
import {
  getActiveStaffNavGroupId,
  getStaffNavSections,
  isStaffNavItemActive,
  type StaffNavGroupId,
  type StaffNavItem,
  type StaffNavSection,
} from "@/components/staff/staffNav";
import StaffNotificationBell from "@/components/staff/StaffNotificationBell";

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

function ChevronIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""} ${className ?? ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
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

function NavItemLink({
  item,
  isActive,
  indented,
  onNavigate,
}: {
  item: StaffNavItem;
  isActive: boolean;
  indented?: boolean;
  onNavigate?: () => void;
}) {
  if (!item.enabled) {
    return (
      <span
        className={`flex cursor-not-allowed items-center justify-between rounded-md py-2 text-sm font-medium text-neutral-400 ${
          indented ? "px-3 pl-8" : "px-3"
        }`}
      >
        {item.label}
        <SoonBadge />
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`block rounded-md py-2 text-sm font-medium transition-colors ${focusRing} ${
        indented ? "px-3 pl-8" : "px-3"
      } ${
        isActive
          ? "bg-[#0F766E]/10 text-[#0F766E]"
          : "text-neutral-600 hover:bg-neutral-50 hover:text-[#0F766E]"
      }`}
    >
      {item.label}
    </Link>
  );
}

function NavGroup({
  section,
  pathname,
  allItems,
  open,
  onToggle,
  onNavigate,
}: {
  section: Extract<StaffNavSection, { type: "group" }>;
  pathname: string;
  allItems: StaffNavItem[];
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const panelId = useId();
  const hasActiveChild = section.items.some((item) =>
    isStaffNavItemActive(pathname, item.href, allItems),
  );
  // Settings sub-routes without their own sidebar entry still mark Система.
  const settingsActive =
    section.id === "system" &&
    pathname.startsWith("/staff/settings") &&
    !hasActiveChild;

  const groupActive = hasActiveChild || settingsActive;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${focusRing} ${
          groupActive
            ? "text-[#0F766E]"
            : "text-neutral-700 hover:bg-neutral-50 hover:text-[#0F766E]"
        }`}
      >
        <span>{section.label}</span>
        <ChevronIcon open={open} className={groupActive ? "text-[#0F766E]" : "text-neutral-400"} />
      </button>

      <div
        id={panelId}
        role="region"
        aria-label={section.label}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-0.5 pb-1 pt-0.5">
            {section.items.map((item) => (
              <NavItemLink
                key={item.href}
                item={item}
                indented
                isActive={isStaffNavItemActive(pathname, item.href, allItems)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavLinks({
  role,
  pathname,
  onNavigate,
}: {
  role: Profile["role"];
  pathname: string;
  onNavigate?: () => void;
}) {
  const sections = getStaffNavSections(role);
  const allItems = sections.flatMap((section) =>
    section.type === "item" ? [section.item] : section.items,
  );
  const activeGroupId = getActiveStaffNavGroupId(pathname, sections);

  // User-expanded groups only. Active group is always treated as open
  // (derived), so it can never stay collapsed while its route is current.
  const [expandedByUser, setExpandedByUser] = useState<ReadonlySet<StaffNavGroupId>>(
    () => new Set(),
  );

  function isGroupOpen(id: StaffNavGroupId): boolean {
    return id === activeGroupId || expandedByUser.has(id);
  }

  function toggleGroup(id: StaffNavGroupId) {
    if (id === activeGroupId) {
      return;
    }
    setExpandedByUser((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <nav className="flex flex-col gap-1" aria-label="Навигация сотрудника">
      {sections.map((section) => {
        if (section.type === "item") {
          return (
            <NavItemLink
              key={section.item.href}
              item={section.item}
              isActive={isStaffNavItemActive(pathname, section.item.href, allItems)}
              onNavigate={onNavigate}
            />
          );
        }

        return (
          <NavGroup
            key={section.id}
            section={section}
            pathname={pathname}
            allItems={allItems}
            open={isGroupOpen(section.id)}
            onToggle={() => toggleGroup(section.id)}
            onNavigate={onNavigate}
          />
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

          <div className="ml-auto flex items-center gap-3 sm:gap-4">
            <StaffNotificationBell profileId={profile.id} />
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
