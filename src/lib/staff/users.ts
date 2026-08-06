import { supabase } from "@/lib/supabase/client";
import type { UserRole } from "@/types/database";

export const STAFF_MANAGED_ROLES = [
  "admin",
  "manager",
  "accountant",
  "warehouse",
] as const satisfies readonly UserRole[];

export type StaffManagedRole = (typeof STAFF_MANAGED_ROLES)[number];

export type StaffUserListItem = {
  profile_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: StaffManagedRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type StaffUserDetails = StaffUserListItem & {
  last_sign_in_at: string | null;
};

export type StaffUserActivityItem = {
  id: string;
  target_profile_id: string | null;
  target_full_name: string | null;
  event_type: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
};

export type StaffUserStatusFilter = "all" | "active" | "inactive";

export async function listStaffUsers(params?: {
  query?: string;
  role?: StaffManagedRole | "";
  status?: StaffUserStatusFilter;
  limit?: number;
}): Promise<StaffUserListItem[]> {
  const { data, error } = await supabase.rpc("staff_list_staff_users", {
    p_query: params?.query?.trim() || null,
    p_role: params?.role || null,
    p_status: params?.status && params.status !== "all" ? params.status : "all",
    p_limit: params?.limit ?? 100,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сотрудников");
  }

  return (data ?? []) as StaffUserListItem[];
}

export async function getStaffUser(profileId: string): Promise<StaffUserDetails> {
  const { data, error } = await supabase.rpc("staff_get_staff_user", {
    p_profile_id: profileId,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить сотрудника");
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("Сотрудник не найден");
  }

  return row as StaffUserDetails;
}

export async function updateStaffRole(
  profileId: string,
  role: StaffManagedRole,
): Promise<StaffUserListItem> {
  const { data, error } = await supabase.rpc("staff_update_staff_role", {
    p_profile_id: profileId,
    p_role: role,
  });

  if (error) {
    throw new Error(error.message || "Не удалось изменить роль");
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("Не удалось изменить роль");
  }

  return row as StaffUserListItem;
}

export async function setStaffActive(
  profileId: string,
  isActive: boolean,
  reason?: string | null,
): Promise<StaffUserListItem> {
  const { data, error } = await supabase.rpc("staff_set_staff_active", {
    p_profile_id: profileId,
    p_is_active: isActive,
    p_reason: reason?.trim() || null,
  });

  if (error) {
    throw new Error(error.message || "Не удалось изменить статус доступа");
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error("Не удалось изменить статус доступа");
  }

  return row as StaffUserListItem;
}

export async function listStaffUserActivity(params?: {
  profileId?: string | null;
  limit?: number;
}): Promise<StaffUserActivityItem[]> {
  const { data, error } = await supabase.rpc("staff_list_staff_user_activity", {
    p_profile_id: params?.profileId ?? null,
    p_limit: params?.limit ?? 100,
  });

  if (error) {
    throw new Error(error.message || "Не удалось загрузить историю");
  }

  return (data ?? []) as StaffUserActivityItem[];
}

export async function inviteStaffUser(input: {
  fullName: string;
  email: string;
  role: StaffManagedRole;
}): Promise<{ ok: true; profile_id: string | null; reinvited: boolean }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) {
    throw new Error("Требуется авторизация");
  }

  const response = await fetch("/api/staff/users/invite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      full_name: input.fullName,
      email: input.email,
      role: input.role,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    profile_id?: string | null;
    reinvited?: boolean;
  };

  if (!response.ok) {
    throw new Error(payload.error || "Не удалось отправить приглашение");
  }

  return {
    ok: true,
    profile_id: payload.profile_id ?? null,
    reinvited: Boolean(payload.reinvited),
  };
}
