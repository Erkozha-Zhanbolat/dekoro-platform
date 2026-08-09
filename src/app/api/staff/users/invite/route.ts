import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AuthRouteError,
  extractBearerToken,
  requireActiveAdminUser,
} from "@/lib/supabase/routeAuth";
import {
  createSupabaseServiceClient,
  getAppBaseUrl,
  isServiceRoleConfigured,
} from "@/lib/supabase/admin";

export const runtime = "nodejs";

const ALLOWED_ROLES = new Set(["admin", "manager", "accountant", "warehouse"]);

/**
 * Best-effort in-memory rate limit (per process).
 * Not a security boundary under serverless / multi-instance — keyed by
 * active admin id + normalized email.
 */
const inviteHits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function checkRateLimit(adminId: string, email: string): boolean {
  const key = `${adminId}:${email}`;
  const now = Date.now();
  const entry = inviteHits.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    inviteHits.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }
  entry.count += 1;
  return true;
}

function genericInviteError(): NextResponse {
  return NextResponse.json(
    { error: "Не удалось отправить приглашение. Проверьте данные и попробуйте снова." },
    { status: 400 },
  );
}

function isAlreadyRegisteredError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already been registered") ||
    m.includes("already registered") ||
    m.includes("user already exists") ||
    m.includes("email_exists") ||
    m.includes("already exists")
  );
}

type InviteBody = {
  full_name?: unknown;
  email?: unknown;
  role?: unknown;
};

type ExistingProfile = {
  profile_id: string;
  role: string;
  is_active: boolean;
  full_name: string;
  email: string | null;
  email_confirmed: boolean;
  is_pending_staff_invite: boolean;
};

async function findExistingProfile(
  client: SupabaseClient,
  email: string,
): Promise<ExistingProfile | null> {
  const { data, error } = await client.rpc("staff_find_profile_by_email", {
    p_email: email,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ExistingProfile | undefined) ?? null;
}

async function finalizeInvite(
  client: SupabaseClient,
  params: {
    profileId: string;
    role: string;
    fullName: string;
    isReinvite: boolean;
  },
) {
  const { data, error } = await client.rpc("staff_finalize_staff_invite", {
    p_profile_id: params.profileId,
    p_role: params.role,
    p_full_name: params.fullName,
    p_is_reinvite: params.isReinvite,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row as { profile_id?: string } | null;
}

async function waitForProfile(
  service: SupabaseClient,
  userId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data: profile } = await service
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .maybeSingle();
    if (profile?.id) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function sendInviteEmail(
  service: SupabaseClient,
  email: string,
  inviteMeta: Record<string, unknown>,
  redirectTo: string,
): Promise<{ userId: string | null; errorMessage: string | null }> {
  const { data, error } = await service.auth.admin.inviteUserByEmail(email, {
    data: inviteMeta,
    redirectTo,
  });
  if (error) {
    // Never log tokens / full admin payloads — message only.
    return { userId: null, errorMessage: error.message };
  }
  return { userId: data.user?.id ?? null, errorMessage: null };
}

/**
 * Invite state machine (server-only):
 *
 * none → inviteUserByEmail → wait profile → finalize
 * pending_staff_invite (unconfirmed + dekoro_staff_invite) → reinvite email → finalize
 * unconfirmed staff → reinvite email → finalize (is_reinvite)
 * confirmed staff → 409 already registered (no invite, no password reset)
 * confirmed / ordinary client → 409 (no auto-promote)
 */
export async function POST(request: Request) {
  try {
    // 1) Bearer present
    const token = extractBearerToken(request);
    if (!token) {
      return NextResponse.json({ error: "Требуется авторизация" }, { status: 401 });
    }

    // 2) JWT verified by Supabase Auth; user id only from verified token
    // 3) active admin via hardened get_my_role (inactive → null → 403)
    const { user, client } = await requireActiveAdminUser(token);

    // 4) Parse / validate body (no acting user id accepted)
    let body: InviteBody;
    try {
      body = (await request.json()) as InviteBody;
    } catch {
      return NextResponse.json({ error: "Некорректное тело запроса" }, { status: 400 });
    }

    const fullName =
      typeof body.full_name === "string" ? body.full_name.trim() : "";
    const email =
      typeof body.email === "string" ? normalizeEmail(body.email) : "";
    const role = typeof body.role === "string" ? body.role.trim() : "";

    if (!fullName || fullName.length < 2 || fullName.length > 200) {
      return NextResponse.json({ error: "Укажите корректное ФИО" }, { status: 400 });
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      return NextResponse.json({ error: "Укажите корректный email" }, { status: 400 });
    }

    if (!ALLOWED_ROLES.has(role)) {
      return NextResponse.json(
        { error: "Роль должна быть admin, manager, accountant или warehouse" },
        { status: 400 },
      );
    }

    // 5) Best-effort rate limit: admin + email
    if (!checkRateLimit(user.id, email)) {
      return NextResponse.json(
        { error: "Слишком много приглашений. Подождите минуту и попробуйте снова." },
        { status: 429 },
      );
    }

    // 6) Service role only after admin verification
    if (!isServiceRoleConfigured()) {
      return NextResponse.json(
        {
          error:
            "Приглашения недоступны: на сервере не задан SUPABASE_SERVICE_ROLE_KEY. Управление существующими сотрудниками через RPC доступно.",
        },
        { status: 503 },
      );
    }

    // Invite onboarding: confirm invite session → set password → /staff.
    // Never land invited staff on /login without a password setup step.
    const redirectTo = `${getAppBaseUrl()}/set-password`;
    const inviteMeta = {
      dekoro_staff_invite: true,
      staff_role: role,
      full_name: fullName,
      name: fullName,
    };

    let existing = await findExistingProfile(client, email);

    // --- Confirmed / ordinary client: never auto-promote ---
    if (existing?.role === "client" && !existing.is_pending_staff_invite) {
      await client.rpc("staff_record_invite_failure", {
        p_email: email,
        p_reason: "existing_client",
      });
      return NextResponse.json(
        {
          error:
            "Этот email уже зарегистрирован как клиент. Используйте отдельное подтверждённое повышение до сотрудника, а не приглашение.",
        },
        { status: 409 },
      );
    }

    // --- Confirmed staff: no invite, no password-reset fallback ---
    if (existing && ALLOWED_ROLES.has(existing.role) && existing.email_confirmed) {
      await client.rpc("staff_record_invite_failure", {
        p_email: email,
        p_reason: "already_registered_staff",
      });
      return NextResponse.json(
        { error: "Сотрудник уже зарегистрирован" },
        { status: 409 },
      );
    }

    const service = createSupabaseServiceClient();

    // --- Pending incomplete invite OR unconfirmed staff: safe reinvite + finalize ---
    const canCompletePending =
      existing &&
      (existing.is_pending_staff_invite ||
        (ALLOWED_ROLES.has(existing.role) && !existing.email_confirmed));

    if (canCompletePending && existing) {
      const { errorMessage: reinviteError } = await sendInviteEmail(
        service,
        email,
        inviteMeta,
        redirectTo,
      );

      // Resend may fail if invite was already sent recently; still try finalize
      // so a previous auth-create + failed-finalize can be recovered.
      if (reinviteError && !isAlreadyRegisteredError(reinviteError)) {
        // Continue to finalize — email may already be outstanding.
      }

      try {
        // Pending client bootstrap → first-time finalize (is_reinvite=false)
        // Unconfirmed staff → reinvite finalize
        const row = await finalizeInvite(client, {
          profileId: existing.profile_id,
          role,
          fullName,
          isReinvite: existing.role !== "client",
        });
        return NextResponse.json({
          ok: true,
          reinvited: existing.role !== "client",
          recovered: Boolean(existing.is_pending_staff_invite || existing.role === "client"),
          profile_id: row?.profile_id ?? existing.profile_id,
        });
      } catch (finalizeErr: unknown) {
        await client.rpc("staff_record_invite_failure", {
          p_email: email,
          p_reason: "finalize_pending_failed",
        });
        return NextResponse.json(
          {
            error:
              finalizeErr instanceof Error
                ? finalizeErr.message
                : "Не удалось завершить настройку приглашения",
          },
          { status: 400 },
        );
      }
    }

    // --- New email: create auth user + finalize ---
    const { userId, errorMessage: inviteError } = await sendInviteEmail(
      service,
      email,
      inviteMeta,
      redirectTo,
    );

    if (inviteError || !userId) {
      if (inviteError && isAlreadyRegisteredError(inviteError)) {
        // Auth user exists but profile lookup missed — re-enter decision tree once.
        existing = await findExistingProfile(client, email);
        if (existing?.role === "client" && !existing.is_pending_staff_invite) {
          await client.rpc("staff_record_invite_failure", {
            p_email: email,
            p_reason: "existing_client",
          });
          return NextResponse.json(
            {
              error:
                "Этот email уже зарегистрирован как клиент. Используйте отдельное подтверждённое повышение до сотрудника, а не приглашение.",
            },
            { status: 409 },
          );
        }
        if (existing && ALLOWED_ROLES.has(existing.role) && existing.email_confirmed) {
          await client.rpc("staff_record_invite_failure", {
            p_email: email,
            p_reason: "already_registered_staff",
          });
          return NextResponse.json(
            { error: "Сотрудник уже зарегистрирован" },
            { status: 409 },
          );
        }
        if (
          existing &&
          (existing.is_pending_staff_invite ||
            (ALLOWED_ROLES.has(existing.role) && !existing.email_confirmed))
        ) {
          try {
            const row = await finalizeInvite(client, {
              profileId: existing.profile_id,
              role,
              fullName,
              isReinvite: existing.role !== "client",
            });
            return NextResponse.json({
              ok: true,
              reinvited: existing.role !== "client",
              recovered: true,
              profile_id: row?.profile_id ?? existing.profile_id,
            });
          } catch (finalizeErr: unknown) {
            await client.rpc("staff_record_invite_failure", {
              p_email: email,
              p_reason: "finalize_recover_failed",
            });
            return NextResponse.json(
              {
                error:
                  finalizeErr instanceof Error
                    ? finalizeErr.message
                    : "Не удалось завершить настройку приглашения",
              },
              { status: 409 },
            );
          }
        }
      }

      await client.rpc("staff_record_invite_failure", {
        p_email: email,
        p_reason: "invite_failed",
      });
      return genericInviteError();
    }

    const profileReady = await waitForProfile(service, userId);
    if (!profileReady) {
      await client.rpc("staff_record_invite_failure", {
        p_email: email,
        p_reason: "profile_missing",
      });
      return NextResponse.json(
        {
          error:
            "Пользователь создан, но профиль ещё не готов. Повторите приглашение — дубликат не создастся, настройка будет завершена.",
        },
        { status: 409 },
      );
    }

    try {
      const row = await finalizeInvite(client, {
        profileId: userId,
        role,
        fullName,
        isReinvite: false,
      });
      return NextResponse.json({
        ok: true,
        reinvited: false,
        profile_id: row?.profile_id ?? userId,
      });
    } catch (finalizeErr: unknown) {
      // Partial failure compensation: auth user exists; retry invite completes finalize.
      await client.rpc("staff_record_invite_failure", {
        p_email: email,
        p_reason: "finalize_failed_after_auth_create",
      });
      return NextResponse.json(
        {
          error:
            (finalizeErr instanceof Error ? finalizeErr.message + ". " : "") +
            "Auth-пользователь создан, но профиль сотрудника не настроен. Повторите приглашение — система завершит настройку без дубликата. Восстановление пароля не выполняется автоматически.",
        },
        { status: 409 },
      );
    }
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    // Never log secrets / tokens / service keys.
    console.error("[staff invite]", error instanceof Error ? error.message : "unknown");
    return NextResponse.json(
      { error: "Не удалось отправить приглашение" },
      { status: 500 },
    );
  }
}
