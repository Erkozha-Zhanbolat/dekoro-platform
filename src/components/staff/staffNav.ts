import type { UserRole } from "@/types/database";

export type StaffNavItem = {
  href: string;
  label: string;
  /** false = shown greyed out with a "Скоро" badge, not a clickable link. */
  enabled: boolean;
  roles: readonly UserRole[];
};

/**
 * Full future Staff Platform menu (supabase/migrations/010_staff_role_access.sql
 * covers the read-only orders section only). Sections without a page yet
 * are listed here so every role sees its complete future menu, marked
 * "Скоро" instead of being missing entirely — but are not rendered as
 * links, so there are no dead 404 routes.
 */
const STAFF_NAV_ITEMS: readonly StaffNavItem[] = [
  {
    href: "/staff",
    label: "Главная",
    enabled: true,
    roles: ["manager", "accountant", "warehouse", "admin"],
  },
  {
    href: "/staff/analytics",
    label: "Аналитика",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/orders",
    label: "Заказы",
    enabled: true,
    roles: ["manager", "accountant", "admin"],
  },
  {
    href: "/staff/notifications",
    label: "Уведомления",
    enabled: true,
    roles: ["manager", "accountant", "warehouse", "admin"],
  },
  {
    href: "/staff/warehouse",
    label: "Склад",
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
    href: "/staff/inventory/reconciliation",
    label: "Сверка с 1С",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/customers",
    label: "Клиенты",
    enabled: true,
    roles: ["manager", "accountant", "admin"],
  },
  {
    href: "/staff/products",
    label: "Товары",
    enabled: true,
    roles: ["manager", "warehouse", "admin"],
  },
  {
    href: "/staff/supplies",
    label: "Поставки",
    enabled: true,
    roles: ["admin"],
  },
  {
    href: "/staff/inventory",
    label: "Остатки",
    enabled: false,
    roles: ["warehouse", "admin"],
  },
  {
    href: "/staff/accounting",
    label: "Бухгалтерия",
    enabled: false,
    roles: ["accountant", "admin"],
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
];

/** Nav items visible to a given staff role, in a fixed, predictable order. */
export function getStaffNavItems(role: UserRole | null | undefined): StaffNavItem[] {
  if (!role) {
    return [];
  }
  return STAFF_NAV_ITEMS.filter((item) => item.roles.includes(role));
}
