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

/**
 * Storage cleanup AFTER db_cleaned.
 * Does NOT re-run inventory restore / order delete.
 * On failure leaves status storage_cleanup_pending for retry.
 */
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

    const body = (await request.json()) as {
      archive_id?: unknown;
      delete_zip?: unknown;
    };
    const archiveId = typeof body.archive_id === "string" ? body.archive_id : "";
    const deleteZip = body.delete_zip !== false;
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
    const status = String(arch.status ?? "");
    const path = typeof arch.export_file_path === "string" ? arch.export_file_path : "";

    if (!["db_cleaned", "storage_cleanup_pending", "exported", "cleaned"].includes(status)) {
      return NextResponse.json(
        { error: `Некорректный статус для storage cleanup: ${status}` },
        { status: 400 },
      );
    }

    if (status === "cleaned") {
      return NextResponse.json({ idempotent: true, status });
    }

    if (deleteZip && path) {
      const service = createSupabaseServiceClient();
      const { error: removeError } = await service.storage.from(BUCKET).remove([path]);
      if (removeError) {
        // Leave retryable — do not re-run inventory restore
        try {
          await client.rpc("admin_mark_archive_storage_cleaned", {
            p_archive_id: archiveId,
            p_keep_zip: true,
          });
        } catch {
          // ignore mark failure; status already pending-capable
        }
        return NextResponse.json(
          {
            error: removeError.message || "Storage delete failed",
            status: "storage_cleanup_pending",
            retryable: true,
          },
          { status: 400 },
        );
      }
    }

    const { data: marked, error: markError } = await client.rpc(
      "admin_mark_archive_storage_cleaned",
      {
        p_archive_id: archiveId,
        p_keep_zip: !deleteZip,
      },
    );
    if (markError) {
      return NextResponse.json({ error: markError.message }, { status: 400 });
    }

    return NextResponse.json({ archive: marked, deleted_zip: deleteZip && Boolean(path) });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка storage cleanup" },
      { status: 500 },
    );
  }
}
