import { NextResponse } from "next/server";
import {
  AuthRouteError,
  extractBearerToken,
  requireActiveAdminUser,
} from "@/lib/supabase/routeAuth";
import {
  createSupabaseServiceClient,
  isServiceRoleConfigured,
} from "@/lib/supabase/admin";

export const runtime = "nodejs";

const BUCKET = "data-archives";

export async function POST(request: Request) {
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return NextResponse.json({ error: "Требуется авторизация" }, { status: 401 });
    }

    const { client } = await requireActiveAdminUser(token);

    if (!isServiceRoleConfigured()) {
      return NextResponse.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY не задан на сервере" },
        { status: 503 },
      );
    }

    const body = (await request.json()) as { archive_id?: unknown };
    const archiveId = typeof body.archive_id === "string" ? body.archive_id : "";
    if (!archiveId) {
      return NextResponse.json({ error: "archive_id обязателен" }, { status: 400 });
    }

    const { data: archive, error } = await client.rpc("admin_get_data_archive", {
      p_archive_id: archiveId,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const arch = (archive ?? {}) as Record<string, unknown>;
    const path = typeof arch.export_file_path === "string" ? arch.export_file_path : "";
    if (!path) {
      return NextResponse.json(
        { error: "ZIP ещё не экспортирован. Сначала выполните export." },
        { status: 400 },
      );
    }

    const service = createSupabaseServiceClient();
    const { data: signed, error: signError } = await service.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 10);

    if (signError || !signed?.signedUrl) {
      return NextResponse.json(
        { error: signError?.message || "Не удалось создать signed URL" },
        { status: 400 },
      );
    }

    return NextResponse.json({
      signed_url: signed.signedUrl,
      export_file_path: path,
      archive_number: arch.archive_number,
      expires_in_seconds: 600,
    });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка download" },
      { status: 500 },
    );
  }
}
