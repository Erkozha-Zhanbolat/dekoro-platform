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
import { contentDispositionFileName } from "@/lib/staff/supplyDocumentStorage";

export const runtime = "nodejs";

const BUCKET = "supply-documents";

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
      document_id?: unknown;
      download?: unknown;
    };
    const documentId = typeof body.document_id === "string" ? body.document_id : "";
    if (!documentId) {
      return NextResponse.json({ error: "document_id обязателен" }, { status: 400 });
    }

    const { data, error } = await client.rpc("staff_get_product_supply_document", {
      p_document_id: documentId,
    });
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message || "Документ не найден" },
        { status: 400 },
      );
    }

    const row = data as Record<string, unknown>;
    const path = typeof row.storage_path === "string" ? row.storage_path : "";
    const originalFilename =
      typeof row.original_filename === "string" ? row.original_filename : "document";
    if (!path) {
      return NextResponse.json({ error: "У документа нет файла" }, { status: 400 });
    }

    const service = createSupabaseServiceClient();
    const download = Boolean(body.download);
    const downloadName = contentDispositionFileName(originalFilename);
    const { data: signed, error: signError } = await service.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 10, download ? { download: downloadName } : undefined);

    if (signError || !signed?.signedUrl) {
      return NextResponse.json(
        { error: signError?.message || "Не удалось создать signed URL" },
        { status: 400 },
      );
    }

    return NextResponse.json({
      signed_url: signed.signedUrl,
      original_filename: originalFilename,
      expires_in_seconds: 600,
    });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка signed URL" },
      { status: 500 },
    );
  }
}
