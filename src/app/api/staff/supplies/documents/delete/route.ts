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

    const body = (await request.json()) as { document_id?: unknown };
    const documentId = typeof body.document_id === "string" ? body.document_id : "";
    if (!documentId) {
      return NextResponse.json({ error: "document_id обязателен" }, { status: 400 });
    }

    const { data, error } = await client.rpc("staff_delete_product_supply_document", {
      p_document_id: documentId,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    const row = (data ?? {}) as Record<string, unknown>;
    const path = typeof row.storage_path === "string" ? row.storage_path : "";
    const supplyId = typeof row.supply_id === "string" ? row.supply_id : "";

    if (path) {
      const service = createSupabaseServiceClient();
      await service.storage.from(BUCKET).remove([path]);
    }

    let payload: unknown = null;
    if (supplyId) {
      const got = await client.rpc("staff_get_product_supply", { p_supply_id: supplyId });
      payload = got.data;
    }

    return NextResponse.json({ deleted: true, payload });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка удаления документа" },
      { status: 500 },
    );
  }
}
