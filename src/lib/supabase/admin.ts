import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// This module must only be imported from server code (Route Handlers,
// Server Actions). Never from Client Components.

/**
 * Server-only Supabase client with the service role key.
 * Never import this module from Client Components or any file that
 * ends up in the browser bundle.
 */
export function createSupabaseServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (и NEXT_PUBLIC_SUPABASE_URL) должны быть заданы на сервере",
    );
  }

  if (serviceKey.startsWith("eyJ") === false && serviceKey.length < 20) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY выглядит некорректно");
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function getAppBaseUrl(): string {
  // Prefer server-only APP_URL for invite redirectTo. NEXT_PUBLIC_APP_URL is
  // the documented public mirror for local/prod config — never take redirect
  // from request body / query.
  const configured =
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "";

  if (configured) {
    return configured.replace(/\/$/, "");
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/$/, "")}`;
  }

  return "http://localhost:3000";
}

export function isServiceRoleConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
