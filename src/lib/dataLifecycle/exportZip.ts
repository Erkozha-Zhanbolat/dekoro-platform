import JSZip from "jszip";
import * as XLSX from "xlsx";

function sheetFromRows(name: string, rows: unknown[]): XLSX.WorkSheet {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return XLSX.utils.aoa_to_sheet([["(пусто)"]]);
  }
  const normalized = list.map((item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value != null && typeof value === "object") {
          out[key] = JSON.stringify(value);
        } else {
          out[key] = value;
        }
      }
      return out;
    }
    return { value: item };
  });
  return XLSX.utils.json_to_sheet(normalized);
}

function workbookToArrayBuffer(sheets: Record<string, unknown[]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const safeName = name.slice(0, 31) || "Sheet";
    XLSX.utils.book_append_sheet(wb, sheetFromRows(safeName, rows), safeName);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

/** Build Excel workbook + JSON inside a ZIP from a period archive payload. */
export async function buildPeriodArchiveZip(
  title: string,
  payload: Record<string, unknown>,
): Promise<Blob> {
  const zip = new JSZip();
  const sheets: Record<string, unknown[]> = {
    Orders: Array.isArray(payload.orders) ? payload.orders : [],
    OrderItems: Array.isArray(payload.order_items) ? payload.order_items : [],
    Payments: Array.isArray(payload.payments) ? payload.payments : [],
    Receivables: Array.isArray(payload.receivables) ? payload.receivables : [],
    TopProducts: Array.isArray(payload.top_products) ? payload.top_products : [],
    TopCustomers: Array.isArray(payload.top_customers) ? payload.top_customers : [],
    Inventory: Array.isArray(payload.inventory) ? payload.inventory : [],
    Sources: Array.isArray(payload.sources) ? payload.sources : [],
    Sales: payload.sales ? [payload.sales] : [],
    Conversion: payload.conversion ? [payload.conversion] : [],
    Monitoring: payload.monitoring ? [payload.monitoring] : [],
    DashboardKPI: payload.dashboard_kpi ? [payload.dashboard_kpi] : [],
  };

  zip.file("report.xlsx", workbookToArrayBuffer(sheets));
  zip.file(
    "payload.json",
    JSON.stringify({ title, generated_at: new Date().toISOString(), ...payload }, null, 2),
  );
  zip.file(
    "README.txt",
    [
      "DEKORO Data Archive",
      title,
      "",
      "report.xlsx — Excel выгрузка разделов архива",
      "payload.json — полный JSON payload",
      "",
      "Production заказы НЕ удаляются при создании архива.",
    ].join("\n"),
  );

  return zip.generateAsync({ type: "blob" });
}

export async function buildDatasetExportZip(
  dataset: string,
  period: { date_from: string; date_to: string },
  rows: Record<string, unknown>[],
): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    `${dataset}.xlsx`,
    workbookToArrayBuffer({ [dataset]: rows }),
  );
  zip.file(
    `${dataset}.json`,
    JSON.stringify({ dataset, period, rows, row_count: rows.length }, null, 2),
  );
  return zip.generateAsync({ type: "blob" });
}

export async function buildTestOrdersArchiveZip(
  title: string,
  payload: Record<string, unknown>,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    "test-orders.xlsx",
    workbookToArrayBuffer({
      Orders: Array.isArray(payload.orders) ? payload.orders : [],
      Items: Array.isArray(payload.order_items) ? payload.order_items : [],
      Payments: Array.isArray(payload.payments) ? payload.payments : [],
      Reservations: Array.isArray(payload.reservations) ? payload.reservations : [],
    }),
  );
  zip.file("payload.json", JSON.stringify({ title, ...payload }, null, 2));
  zip.file(
    "README.txt",
    [
      "DEKORO Test Orders Archive",
      title,
      "",
      "Проверьте содержимое перед удалением тестовых заказов.",
      "Удаление восстанавливает inventory и доступно только вручную.",
    ].join("\n"),
  );
  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function slugFilename(value: string): string {
  return value
    .trim()
    .replace(/[^\w.\-А-Яа-яЁё]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80) || "archive";
}
