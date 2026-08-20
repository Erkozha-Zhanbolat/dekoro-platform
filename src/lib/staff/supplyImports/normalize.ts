import type { ExcelCell } from "./types";

export function safeExcelFileName(name: string): string {
  const trimmed = name.trim();
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const cleaned = base.replace(/\u0000/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "document.xlsx";
  }
  return cleaned.slice(0, 180);
}

export function isExcelFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls");
}

export function normalizeHeader(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[（(].*?[）)]/g, " ")
    .replace(/[*＊]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function cellToDisplay(value: ExcelCell): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    if (Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-9) {
      return String(Math.round(value));
    }
    return String(value);
  }
  return String(value).replace(/\u00a0/g, " ").trim();
}

export function parseNumericCell(value: ExcelCell): {
  ok: boolean;
  value: number | null;
  error: string | null;
} {
  if (value == null || value === "") {
    return { ok: true, value: null, error: null };
  }
  if (typeof value === "boolean" || value instanceof Date) {
    return { ok: false, value: null, error: "Некорректное число" };
  }

  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else {
    const asText = String(value).replace(/\u00a0/g, " ").trim();
    if (!asText) return { ok: true, value: null, error: null };
    if (asText.startsWith("=")) {
      return { ok: false, value: null, error: "Формула без вычисленного значения" };
    }
    const raw = asText.replace(/\s/g, "").replace(",", ".");
    const lower = raw.toLowerCase();
    if (
      lower === "nan" ||
      lower === "infinity" ||
      lower === "+infinity" ||
      lower === "-infinity" ||
      lower === "inf"
    ) {
      return { ok: false, value: null, error: "Некорректное число" };
    }
    if (!/^[+-]?[0-9]+(\.[0-9]+)?$/.test(raw)) {
      return { ok: false, value: null, error: "Некорректное число" };
    }
    numeric = Number(raw);
  }

  if (!Number.isFinite(numeric)) {
    return { ok: false, value: null, error: "Некорректное число" };
  }
  return { ok: true, value: numeric, error: null };
}

export function rowPreview(cells: ExcelCell[], limit = 8): string {
  return cells
    .slice(0, limit)
    .map((cell) => cellToDisplay(cell))
    .filter(Boolean)
    .join(" · ")
    .slice(0, 120);
}
