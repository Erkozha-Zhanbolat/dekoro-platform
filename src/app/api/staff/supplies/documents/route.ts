import { createHash, randomUUID } from "node:crypto";
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
import {
  isExcelFileName,
  parseSupplyExcelBuffer,
  SUPPLY_IMPORT_MAX_FILE_BYTES,
} from "@/lib/staff/supplyImports";
import {
  isAllowedSupplyDocumentName,
  originalDisplayFileName,
  supplyDocumentStoragePath,
} from "@/lib/staff/supplyDocumentStorage";

export const runtime = "nodejs";

const BUCKET = "supply-documents";
const IMPORT_TYPES = new Set(["factory_order", "factory_shipment"]);

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

    const form = await request.formData();
    const supplyId = String(form.get("supply_id") ?? "").trim();
    const documentType = String(form.get("document_type") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    const documentDate = String(form.get("document_date") ?? "").trim() || null;
    const notes = String(form.get("notes") ?? "").trim() || null;
    const linkedExpenseId = String(form.get("linked_expense_id") ?? "").trim() || null;
    const file = form.get("file");

    if (!supplyId) {
      return NextResponse.json({ error: "id поставки обязателен" }, { status: 400 });
    }
    if (!documentType) {
      return NextResponse.json({ error: "Тип документа обязателен" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Файл обязателен" }, { status: 400 });
    }
    if (file.size <= 0) {
      return NextResponse.json({ error: "Файл пустой" }, { status: 400 });
    }
    if (file.size > SUPPLY_IMPORT_MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Файл слишком большой (максимум 20 МБ)" }, { status: 400 });
    }

    const originalName = originalDisplayFileName(file.name);
    if (!isAllowedSupplyDocumentName(originalName)) {
      return NextResponse.json(
        { error: "Допустимы Excel, PDF и изображения (PNG/JPEG/WEBP)" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const documentId = randomUUID();
    const storagePath = supplyDocumentStoragePath(supplyId, documentId, originalName);

    const { data: registered, error: regError } = await client.rpc(
      "staff_register_product_supply_document",
      {
        p_supply_id: supplyId,
        p_document_id: documentId,
        p_document_type: documentType,
        p_title: title || originalName,
        p_original_filename: originalName,
        p_storage_path: storagePath,
        p_mime_type: file.type || "application/octet-stream",
        p_file_size: file.size,
        p_document_date: documentDate,
        p_notes: notes,
        p_linked_expense_id: linkedExpenseId,
        p_content_sha256: sha256,
      },
    );

    if (regError) {
      return NextResponse.json({ error: regError.message }, { status: 400 });
    }

    const service = createSupabaseServiceClient();
    const { error: uploadError } = await service.storage.from(BUCKET).upload(storagePath, buffer, {
      upsert: false,
      contentType: file.type || "application/octet-stream",
      cacheControl: "31536000",
    });

    if (uploadError) {
      await client.rpc("staff_delete_product_supply_document", {
        p_document_id: documentId,
      });
      return NextResponse.json(
        { error: uploadError.message || "Не удалось сохранить файл" },
        { status: 400 },
      );
    }

    let parserError: string | null = null;
    let parsedRowCount = 0;
    const shouldParse = IMPORT_TYPES.has(documentType) && isExcelFileName(originalName);

    if (shouldParse) {
      try {
        const parsed = parseSupplyExcelBuffer(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          originalName,
        );
        const { data: prepared, error: prepError } = await client.rpc(
          "staff_prepare_product_supply_import",
          {
            p_document_id: documentId,
            p_parse: parsed,
          },
        );
        if (prepError) {
          parserError = prepError.message;
          await client.rpc("staff_mark_product_supply_document_parser", {
            p_document_id: documentId,
            p_status: "error",
            p_metadata: { error: prepError.message },
          });
        } else {
          const prep = (prepared ?? {}) as Record<string, unknown>;
          parsedRowCount = Array.isArray(prep.rows) ? prep.rows.length : parsed.rows.length;
        }
      } catch (error: unknown) {
        parserError = error instanceof Error ? error.message : "Не удалось разобрать Excel";
        await client.rpc("staff_mark_product_supply_document_parser", {
          p_document_id: documentId,
          p_status: "error",
          p_metadata: { error: parserError },
        });
      }
    } else if (IMPORT_TYPES.has(documentType) && !isExcelFileName(originalName)) {
      await client.rpc("staff_mark_product_supply_document_parser", {
        p_document_id: documentId,
        p_status: "skipped",
        p_metadata: { reason: "PDF/изображение сохранено в архив без разбора" },
      });
    }

    const { data: payload } = await client.rpc("staff_get_product_supply", {
      p_supply_id: supplyId,
    });

    const meta = (registered ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      document_id: documentId,
      duplicate_file: Boolean(meta.duplicate_file),
      already_imported: Boolean(meta.already_imported),
      supply_status: meta.supply_status,
      parsed_row_count: parsedRowCount,
      parser_error: parserError,
      payload,
    });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка загрузки документа" },
      { status: 500 },
    );
  }
}
