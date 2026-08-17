"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import {
  captureAuthRedirectIntent,
  clearAuthRedirectIntent,
  userNeedsPasswordSetup,
} from "@/lib/auth/passwordSetup";

export type IndividualSignUpMetadata = {
  customer_type: "individual";
  name: string;
  phone: string;
  city: string;
};

export type CompanySignUpMetadata = {
  customer_type: "company";
  company_name: string;
  bin: string;
  contact_person: string;
  phone: string;
  city: string;
  address: string;
};

export type SignUpMetadata = IndividualSignUpMetadata | CompanySignUpMetadata;

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  needsPasswordSetup: boolean;
  completePasswordSetup: () => void;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    metadata: SignUpMetadata,
  ) => Promise<{ error: string | null; needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordSetupCleared, setPasswordSetupCleared] = useState(false);

  useEffect(() => {
    captureAuthRedirectIntent();

    supabase.auth.getSession().then(({ data }) => {
      captureAuthRedirectIntent();
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        captureAuthRedirectIntent();
        setSession(nextSession);
        setLoading(false);
      },
    );

    return () => {
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (!error) {
      clearAuthRedirectIntent();
      setPasswordSetupCleared(false);
    }
    return { error: error?.message ?? null };
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, metadata: SignUpMetadata) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: metadata,
        },
      });

      if (error) {
        return { error: error.message, needsEmailConfirmation: false };
      }

      const needsEmailConfirmation = data.session === null;
      return { error: null, needsEmailConfirmation };
    },
    [],
  );

  const signOut = useCallback(async () => {
    clearAuthRedirectIntent();
    setPasswordSetupCleared(false);
    await supabase.auth.signOut();
    // Shared-computer boundary: rotate visitor so the next account cannot
    // link/inherit this browser's prior anonymous or linked history.
    try {
      const { rotateAnalyticsIdentity } = await import(
        "@/lib/analytics/identity"
      );
      const { resetAnalyticsClientState } = await import(
        "@/lib/analytics/track"
      );
      rotateAnalyticsIdentity();
      resetAnalyticsClientState();
    } catch {
      /* analytics optional */
    }
  }, []);

  const completePasswordSetup = useCallback(() => {
    clearAuthRedirectIntent();
    setPasswordSetupCleared(true);
  }, []);

  const needsPasswordSetup =
    !passwordSetupCleared && userNeedsPasswordSetup(session?.user ?? null);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      session,
      loading,
      needsPasswordSetup,
      completePasswordSetup,
      signIn,
      signUp,
      signOut,
    }),
    [session, loading, needsPasswordSetup, completePasswordSetup, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth должен использоваться внутри AuthProvider");
  }
  return context;
}
