import { NextResponse } from "next/server";
import JSZip from "jszip";
import * as XLSX from "xlsx";
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
const MAX_ORDERS = 5000;

function sheetFromRows(name: string, rows: unknown[]): XLSX.WorkSheet {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return XLSX.utils.aoa_to_sheet([["(пусто)"]]);
  const normalized = list.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[key] =
          value != null && typeof value === "object" ? JSON.stringify(value) : value;
      }
      return out;
    }
    return { value: item };
  });
  return XLSX.utils.json_to_sheet(normalized);
}

function workbookBuffer(sheets: Record<string, unknown[]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, sheetFromRows(name.slice(0, 31), rows), name.slice(0, 31));
  }
  return Buffer.from(XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer);
}

type Body = {
  archive_id?: unknown;
};

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

    const body = (await request.json()) as Body;
    const archiveId = typeof body.archive_id === "string" ? body.archive_id : "";
    if (!archiveId) {
      return NextResponse.json({ error: "archive_id обязателен" }, { status: 400 });
    }

    const { data: archive, error: archError } = await client.rpc("admin_get_data_archive", {
      p_archive_id: archiveId,
    });
    if (archError) {
      return NextResponse.json({ error: archError.message }, { status: 400 });
    }

    const arch = (archive ?? {}) as Record<string, unknown>;
    const archiveType = String(arch.archive_type ?? "");
    const archiveNumber = String(arch.archive_number ?? "DEKORO-AR");
    const title = String(arch.title ?? archiveNumber);

    if (arch.export_file_path) {
      return NextResponse.json(
        { error: "ZIP уже существует (immutable). Повторная выгрузка запрещена." },
        { status: 409 },
      );
    }

    let dataset: Record<string, unknown>;
    if (archiveType === "test_orders") {
      const { data, error } = await client.rpc("admin_get_test_archive_export_dataset", {
        p_archive_id: archiveId,
      });
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      dataset = (data ?? {}) as Record<string, unknown>;
    } else {
      const periodFrom = String(arch.period_from ?? "");
      const periodTo = String(arch.period_to ?? "");
      const { data, error } = await client.rpc("admin_get_period_export_dataset", {
        p_date_from: periodFrom,
        p_date_to: periodTo,
        p_max_orders: MAX_ORDERS,
      });
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      dataset = (data ?? {}) as Record<string, unknown>;
    }

    const zip = new JSZip();
    const sheets: Record<string, unknown[]> = {
      Orders: Array.isArray(dataset.orders) ? dataset.orders : [],
      OrderItems: Array.isArray(dataset.order_items) ? dataset.order_items : [],
      Payments: Array.isArray(dataset.payments) ? dataset.payments : [],
      TopProducts: Array.isArray(dataset.top_products) ? dataset.top_products : [],
      TopCustomers: Array.isArray(dataset.top_customers) ? dataset.top_customers : [],
      Sources: Array.isArray(dataset.sources) ? dataset.sources : [],
      AnalyticsDaily: Array.isArray(dataset.analytics_daily_aggregates)
        ? dataset.analytics_daily_aggregates
        : [],
      Reservations: Array.isArray(dataset.reservations) ? dataset.reservations : [],
    };

    zip.file("report.xlsx", workbookBuffer(sheets));
    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          title,
          archive_id: archiveId,
          archive_number: archiveNumber,
          archive_type: archiveType,
          manifest: arch.manifest ?? null,
          generated_at: new Date().toISOString(),
          note:
            archiveType === "weekly" || archiveType === "monthly"
              ? "Отчёт. НЕ удаляет рабочие заказы."
              : "Test orders archive.",
        },
        null,
        2,
      ),
    );
    zip.file(
      "README.txt",
      [
        "DEKORO Data Archive",
        archiveNumber,
        title,
        "",
        archiveType === "weekly" || archiveType === "monthly"
          ? "Еженедельный/месячный архив создаёт отчёт и НЕ удаляет рабочие заказы."
          : "Тестовый архив. Cleanup только через admin_execute_test_order_cleanup.",
        "",
        "Full datasets are NOT stored in PostgreSQL — only compact manifest.",
      ].join("\n"),
    );

    const zipBuffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const filePath = `archives/${archiveId}/${archiveNumber}.zip`;

    const service = createSupabaseServiceClient();
    const { error: uploadError } = await service.storage.from(BUCKET).upload(filePath, zipBuffer, {
      contentType: "application/zip",
      upsert: false,
    });
    if (uploadError) {
      return NextResponse.json(
        { error: uploadError.message || "Не удалось загрузить ZIP в Storage" },
        { status: 400 },
      );
    }

    const { data: marked, error: markError } = await client.rpc("admin_mark_archive_exported", {
      p_archive_id: archiveId,
      p_export_file_path: filePath,
      p_export_bytes: zipBuffer.byteLength,
      p_file_checksum: null,
    });
    if (markError) {
      return NextResponse.json(
        {
          error:
            markError.message ||
            "ZIP загружен, но не удалось пометить exported — проверьте архив вручную",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({
      archive: marked,
      export_file_path: filePath,
      export_bytes: zipBuffer.byteLength,
    });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ошибка export архива" },
      { status: 500 },
    );
  }
}
