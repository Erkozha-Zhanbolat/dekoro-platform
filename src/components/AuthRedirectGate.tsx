"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getStoredAuthIntent } from "@/lib/auth/passwordSetup";

const SET_PASSWORD_PATH = "/set-password";
const RESET_PASSWORD_PATH = "/reset-password";

function currentAuthLocationSuffix(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return `${window.location.search}${window.location.hash}`;
}

/**
 * If an invite/recovery email lands on Site URL (or any page other than the
 * dedicated password screen), route the session to the right page.
 * Login/register/signup confirmation are left untouched.
 */
export default function AuthRedirectGate() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, needsPasswordSetup } = useAuth();

  useEffect(() => {
    if (loading) {
      return;
    }

    const intent = getStoredAuthIntent();
    const suffix = currentAuthLocationSuffix();
    const onPasswordPage =
      pathname === SET_PASSWORD_PATH || pathname === RESET_PASSWORD_PATH;

    if (!user) {
      if (onPasswordPage) {
        return;
      }
      if (intent === "recovery") {
        router.replace(`${RESET_PASSWORD_PATH}${suffix}`);
        return;
      }
      if (intent === "invite") {
        router.replace(`${SET_PASSWORD_PATH}${suffix}`);
      }
      return;
    }

    if (intent === "recovery" && pathname !== RESET_PASSWORD_PATH) {
      router.replace(RESET_PASSWORD_PATH);
      return;
    }

    if (
      (needsPasswordSetup || intent === "invite") &&
      pathname !== SET_PASSWORD_PATH
    ) {
      router.replace(SET_PASSWORD_PATH);
    }
  }, [loading, user, needsPasswordSetup, pathname, router]);

  return null;
}
