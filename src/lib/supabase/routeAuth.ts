import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

/**
 * Build a short-lived Supabase client authenticated as the caller (JWT),
 * for use inside Route Handlers. Does not persist a session.
 */
export function createSupabaseUserClient(accessToken: string): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY не заданы");
  }

  return createClient(url, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export async function requireActiveAdminUser(
  accessToken: string,
): Promise<{ user: User; client: SupabaseClient }> {
  const client = createSupabaseUserClient(accessToken);

  // Validates the JWT with Supabase Auth (server-side). User id comes only
  // from this verified result — never from request body.
  const { data, error } = await client.auth.getUser(accessToken);

  if (error || !data.user) {
    throw new AuthRouteError("Требуется авторизация", 401);
  }

  // Hardened get_my_role(): NULL when missing/inactive/non-matching.
  const { data: role, error: roleError } = await client.rpc("get_my_role");
  if (roleError) {
    throw new AuthRouteError("Не удалось проверить роль", 403);
  }

  if (role !== "admin") {
    throw new AuthRouteError("Только администратор может выполнять это действие", 403);
  }

  return { user: data.user, client };
}

export class AuthRouteError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthRouteError";
    this.status = status;
  }
}
