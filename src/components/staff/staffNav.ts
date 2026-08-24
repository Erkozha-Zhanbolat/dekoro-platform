import type { UserRole } from "@/types/database";

export type StaffNavItem = {
  href: string;
  label: string;
  /** false = shown greyed out with a "Скоро" badge, not a clickable link. */
  enabled: boolean;
  roles: readonly UserRole[];
};

export type StaffNavGroupId =
  | "sales"
  | "warehouse"
  | "procurement"
  | "catalog"
  | "system";

export type StaffNavGroupDef = {
  id: StaffNavGroupId;
  label: string;
  /** Child hrefs in display order; permissions still come from each item. */
  hrefs: readonly string[];
};

/**
 * Full future Staff Platform menu (supabase/migrations/010_staff_role_access.sql
 * covers the read-only orders section only). Sections without a page yet
 * are listed here so every role sees its complete future menu, marked
 * "Скоро" instead of being missing entirely — but are not rendered as
 * links, so there are no dead 404 routes.
 *
 * Permissions on each item remain the source of truth for visibility.
 */
const STAFF_NAV_ITEMS: readonly StaffNavItem[] = [
  {
    href: "/staff",
    label: "Главная",
    enabled: true,
    roles: ["manager", "accountant", "warehouse", "admin"],
  },
  {
    href: "/staff/notifications",
    label: "Уведомления",
    enabled: true,
    roles: ["manager", "accountant", "warehouse", "admin"],
  },
  {
    href: "/staff/orders",
    label: "Заказы",
    enabled: true,
    roles: ["manager", "accountant", "admin"],
  },
  {
    href: "/staff/customers",
    label: "Клиенты",
    enabled: true,
    roles: ["manager", "accountant", "admin"],
  },
  {
    href: "/staff/analytics",
    label: "Аналитика продаж",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/warehouse",
    label: "Склад",
    enabled: true,
    roles: ["warehouse", "manager", "admin"],
  },
  {
    href: "/staff/inventory",
    label: "Остатки",
    enabled: true,
    roles: ["warehouse", "manager", "admin"],
  },
  {
    href: "/staff/warehouse/history",
    label: "История отгрузок",
    enabled: true,
    roles: ["warehouse", "admin"],
  },
  {
    href: "/staff/procurement",
    label: "Закупки",
    enabled: true,
    roles: ["admin", "manager"],
  },
  {
    href: "/staff/supplies",
    label: "Поставки",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/products",
    label: "Товары",
    enabled: true,
    roles: ["manager", "warehouse", "admin"],
  },
  {
    href: "/staff/inventory/reconciliation",
    label: "Сверка с 1С",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/settings",
    label: "Настройки",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/settings/users",
    label: "Сотрудники",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/settings/data",
    label: "Управление данными",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/accounting",
    label: "Бухгалтерия",
    enabled: false,
    roles: ["accountant", "admin"],
  },
];

const STAFF_NAV_ITEM_BY_HREF = new Map(
  STAFF_NAV_ITEMS.map((item) => [item.href, item] as const),
);

/** Top-level items that sit outside collapsible groups. */
export const STAFF_NAV_STANDALONE_HREFS = ["/staff", "/staff/notifications"] as const;

/**
 * Collapsible sidebar groups. Child order is presentation-only;
 * visibility is still filtered via each item's `roles`.
 */
export const STAFF_NAV_GROUPS: readonly StaffNavGroupDef[] = [
  {
    id: "sales",
    label: "Продажи",
    hrefs: ["/staff/orders", "/staff/customers", "/staff/analytics"],
  },
  {
    id: "warehouse",
    label: "Склад",
    hrefs: ["/staff/warehouse", "/staff/inventory", "/staff/warehouse/history"],
  },
  {
    id: "procurement",
    label: "Закупки",
    hrefs: ["/staff/procurement", "/staff/supplies"],
  },
  {
    id: "catalog",
    label: "Каталог",
    hrefs: ["/staff/products"],
  },
  {
    id: "system",
    label: "Система",
    hrefs: [
      "/staff/inventory/reconciliation",
      "/staff/settings",
      "/staff/settings/users",
      "/staff/settings/data",
      "/staff/accounting",
    ],
  },
];

export type StaffNavSection =
  | { type: "item"; item: StaffNavItem }
  | { type: "group"; id: StaffNavGroupId; label: string; items: StaffNavItem[] };

/** Nav items visible to a given staff role, in a fixed, predictable order. */
export function getStaffNavItems(role: UserRole | null | undefined): StaffNavItem[] {
  if (!role) {
    return [];
  }
  return STAFF_NAV_ITEMS.filter((item) => item.roles.includes(role));
}

/**
 * Grouped sidebar sections for a role. Empty groups are omitted.
 * Permissions remain on individual items — this only rearranges presentation.
 */
export function getStaffNavSections(role: UserRole | null | undefined): StaffNavSection[] {
  const visible = getStaffNavItems(role);
  const visibleByHref = new Map(visible.map((item) => [item.href, item] as const));
  const sections: StaffNavSection[] = [];

  for (const href of STAFF_NAV_STANDALONE_HREFS) {
    const item = visibleByHref.get(href);
    if (item) {
      sections.push({ type: "item", item });
    }
  }

  for (const group of STAFF_NAV_GROUPS) {
    const items = group.hrefs
      .map((href) => visibleByHref.get(href))
      .filter((item): item is StaffNavItem => item != null);
    if (items.length === 0) {
      continue;
    }
    sections.push({
      type: "group",
      id: group.id,
      label: group.label,
      items,
    });
  }

  return sections;
}

/** True when `pathname` is covered by this nav href (most-specific wins). */
export function isStaffNavItemActive(
  pathname: string,
  href: string,
  candidates: readonly StaffNavItem[],
): boolean {
  if (href === "/staff") {
    return pathname === "/staff";
  }
  if (!pathname.startsWith(href)) {
    return false;
  }
  const moreSpecificExists = candidates.some(
    (other) =>
      other.enabled &&
      other.href !== href &&
      other.href.startsWith(href) &&
      pathname.startsWith(other.href),
  );
  return !moreSpecificExists;
}

/**
 * Which collapsible group owns the current route, if any.
 * Uses the same specificity rules as item active state so
 * `/staff/inventory/reconciliation` maps to Система, not Склад.
 */
export function getActiveStaffNavGroupId(
  pathname: string,
  sections: readonly StaffNavSection[],
): StaffNavGroupId | null {
  const allItems = sections.flatMap((section) =>
    section.type === "item" ? [section.item] : section.items,
  );

  for (const section of sections) {
    if (section.type !== "group") {
      continue;
    }
    const hasActiveChild = section.items.some((item) =>
      isStaffNavItemActive(pathname, item.href, allItems),
    );
    if (hasActiveChild) {
      return section.id;
    }
  }

  // Settings sub-routes (pricing, catalogs) that are not separate sidebar items
  // still belong under Система when Настройки is visible.
  const settingsSection = sections.find(
    (section) => section.type === "group" && section.id === "system",
  );
  if (
    settingsSection?.type === "group" &&
    pathname.startsWith("/staff/settings") &&
    settingsSection.items.some((item) => item.href.startsWith("/staff/settings"))
  ) {
    return "system";
  }

  return null;
}

/** Lookup helper for tests / debugging. */
export function getStaffNavItemByHref(href: string): StaffNavItem | undefined {
  return STAFF_NAV_ITEM_BY_HREF.get(href);
}
