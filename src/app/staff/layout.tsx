"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useProfile } from "@/context/ProfileContext";
import { canAccessStaff } from "@/types/database";
import StaffShell from "@/components/staff/StaffShell";

/**
 * Gate for the entire /staff/** section.
 *
 * This check is client-side and exists purely for UX (redirect people who
 * clearly shouldn't be here before they see a flash of staff UI). It is
 * NOT the security boundary — the actual security boundary is Postgres RLS
 * (orders_select_staff / order_items_select_staff in
 * supabase/migrations/010_staff_role_access.sql, backed by
 * has_staff_role()/get_my_role()). A client user who somehow renders this
 * layout still cannot read any data they're not entitled to: every staff
 * data call in src/lib/staff/** goes through the same Supabase client and
 * the same RLS policies as the rest of the app.
 */
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { profile, profileLoading } = useProfile();

  const loading = authLoading || (!!user && profileLoading);
  const role = profile?.role ?? null;
  const isActive = profile?.is_active === true;
  const allowed = !loading && !!user && canAccessStaff(role) && isActive;

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent("/staff")}`);
      return;
    }
    if (!canAccessStaff(role) || !isActive) {
      router.replace("/");
    }
  }, [loading, user, role, isActive, router]);

  if (loading || !allowed || !profile) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  return <StaffShell profile={profile}>{children}</StaffShell>;
}
