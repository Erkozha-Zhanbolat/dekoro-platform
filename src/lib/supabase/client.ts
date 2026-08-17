import { createClient } from "@supabase/supabase-js";
import { captureAuthRedirectIntent } from "@/lib/auth/passwordSetup";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Не заданы переменные окружения NEXT_PUBLIC_SUPABASE_URL и NEXT_PUBLIC_SUPABASE_ANON_KEY",
  );
}

// Read type=invite|recovery from the URL before GoTrue strips the hash.
captureAuthRedirectIntent();

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Invite and recovery emails use the implicit hash callback
    // (`#access_token&type=invite|recovery`). Keep detection on so any page
    // can establish the session; AuthRedirectGate then sends invite users
    // to /set-password even if Site URL was used as fallback.
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});
