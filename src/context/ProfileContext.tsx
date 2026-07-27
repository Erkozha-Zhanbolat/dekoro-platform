"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/context/AuthContext";
import type { Company, Profile } from "@/types/database";

interface ProfileContextValue {
  profile: Profile | null;
  company: Company | null;
  profileLoading: boolean;
  refreshProfile: () => Promise<void>;
}

interface ProfileAndCompany {
  profile: Profile | null;
  company: Company | null;
}

async function fetchProfileAndCompany(userId: string): Promise<ProfileAndCompany> {
  const { data: profileData } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  const profile = (profileData as Profile | null) ?? null;

  // Individual accounts never have a linked company. Company accounts without
  // company_id are treated as incomplete data (company stays null) and must
  // not crash the profile page.
  if (!profile || profile.customer_type !== "company" || !profile.company_id) {
    return { profile, company: null };
  }

  const { data: companyData } = await supabase
    .from("companies")
    .select("*")
    .eq("id", profile.company_id)
    .maybeSingle();

  return { profile, company: (companyData as Company | null) ?? null };
}

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const currentUserId = user?.id ?? null;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [renderedUserId, setRenderedUserId] = useState<string | null>(null);

  // Reset local profile/company state during render (not in an effect) as
  // soon as the signed-in user changes, e.g. on sign-out. This mirrors
  // React's recommended "adjust state when a prop changes" pattern.
  if (!authLoading && renderedUserId !== currentUserId) {
    setRenderedUserId(currentUserId);
    setProfile(null);
    setCompany(null);
    setLoadedUserId(null);
  }

  useEffect(() => {
    if (authLoading || !currentUserId || loadedUserId === currentUserId) {
      return;
    }

    let ignore = false;

    fetchProfileAndCompany(currentUserId).then(({ profile: nextProfile, company: nextCompany }) => {
      if (ignore) {
        return;
      }
      setProfile(nextProfile);
      setCompany(nextCompany);
      setLoadedUserId(currentUserId);
    });

    return () => {
      ignore = true;
    };
  }, [authLoading, currentUserId, loadedUserId]);

  const refreshProfile = useCallback(async () => {
    if (!currentUserId) {
      return;
    }
    const { profile: nextProfile, company: nextCompany } = await fetchProfileAndCompany(currentUserId);
    setProfile(nextProfile);
    setCompany(nextCompany);
    setLoadedUserId(currentUserId);
  }, [currentUserId]);

  const profileLoading = authLoading || (currentUserId !== null && loadedUserId !== currentUserId);

  const value = useMemo<ProfileContextValue>(
    () => ({ profile, company, profileLoading, refreshProfile }),
    [profile, company, profileLoading, refreshProfile],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error("useProfile должен использоваться внутри ProfileProvider");
  }
  return context;
}
