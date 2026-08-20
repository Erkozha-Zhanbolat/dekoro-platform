import { supabase } from "@/lib/supabase/client";
import type {
  ProductSupplyDocument,
  ProductSupplyPayload,
  SupplyDocumentProductCandidate,
  SupplyDocumentRowMatchStatus,
} from "@/types/database";
import { mapProductSupplyPayload } from "@/lib/staff/supplies";
import { isExcelFileName } from "@/lib/staff/supplyImports";
import { isBrowserPreviewableFileName } from "@/lib/staff/supplyDocumentStorage";

async function authHeaders(json = true): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Требуется авторизация");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function throwRpc(error: { message?: string } | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  const text = asString(value);
  return text ? text : null;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = asNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

export type UploadSupplyDocumentResult = {
  payload: ProductSupplyPayload | null;
  documentId: string;
  duplicateFile: boolean;
  alreadyImported: boolean;
  parserError: string | null;
  supplyClosed: boolean;
  parsedRowCount: number;
};

export type SupplyDocumentParsedRow = {
  id: string;
  document_id: string;
  supply_id: string;
  source_row_number: number;
  sort_order: number;
  source_own_code: string | null;
  source_supplier_code: string | null;
  source_name: string | null;
  source_spec: string | null;
  source_unit: string | null;
  source_quantity: number | null;
  source_price: number | null;
  source_amount: number | null;
  source_notes: string | null;
  source_issues: string[];
  own_code: string | null;
  supplier_code: string | null;
  product_name: string | null;
  specification: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  matched_product_id: string | null;
  matched_sku: string | null;
  matched_name: string | null;
  matched_original_sku: string | null;
  matched_unit: string | null;
  matched_status: string | null;
  matched_category_name: string | null;
  matched_subcategory_name: string | null;
  matched_dimensions: string | null;
  match_status: SupplyDocumentRowMatchStatus;
  match_method: string | null;
  match_candidates: SupplyDocumentProductCandidate[];
  linked_supply_item_id: string | null;
  linked_item_quantity: number | null;
  linked_item_sku: string | null;
  linked_item_name: string | null;
};

export type SupplyDocumentDetail = {
  document: ProductSupplyDocument;
  supply_id: string;
  supply_status: "draft" | "closed";
  supply_number: string;
  supply_title: string;
  parser_status: string | null;
  parser_metadata: Record<string, unknown>;
  rows: SupplyDocumentParsedRow[];
  match_summary: {
    matched: number;
    needs_selection: number;
    unmatched: number;
    skipped: number;
    invalid: number;
  };
};

export function isSupplyImportDocumentType(type: string): boolean {
  return type === "factory_order" || type === "factory_shipment";
}

export function supplyDocumentOpenMode(
  doc: Pick<ProductSupplyDocument, "document_type" | "original_filename" | "parser_status" | "parsed_row_count">,
): "internal" | "browser" | "download_only" {
  const importExcel =
    isSupplyImportDocumentType(doc.document_type) && isExcelFileName(doc.original_filename);
  if (importExcel && (doc.parsed_row_count > 0 || doc.parser_status === "preview" || doc.parser_status === "committed" || doc.parser_status === "error")) {
    return "internal";
  }
  if (isBrowserPreviewableFileName(doc.original_filename)) return "browser";
  return "download_only";
}

export function supplyDocumentInternalPath(supplyId: string, documentId: string): string {
  return `/staff/supplies/${supplyId}/documents/${documentId}`;
}

export async function uploadSupplyDocument(input: {
  supplyId: string;
  file: File;
  documentType: string;
  title?: string;
  documentDate?: string | null;
  notes?: string | null;
  linkedExpenseId?: string | null;
}): Promise<UploadSupplyDocumentResult> {
  const headers = await authHeaders(false);
  const form = new FormData();
  form.set("supply_id", input.supplyId);
  form.set("document_type", input.documentType);
  form.set("title", input.title?.trim() || "");
  if (input.documentDate) form.set("document_date", input.documentDate);
  if (input.notes?.trim()) form.set("notes", input.notes.trim());
  if (input.linkedExpenseId) form.set("linked_expense_id", input.linkedExpenseId);
  form.set("file", input.file);

  const res = await fetch("/api/staff/supplies/documents", {
    method: "POST",
    headers,
    body: form,
  });
  const json = (await res.json()) as {
    error?: string;
    document_id?: string;
    duplicate_file?: boolean;
    already_imported?: boolean;
    parser_error?: string | null;
    supply_status?: string;
    parsed_row_count?: number;
    payload?: unknown;
  };
  if (!res.ok) throw new Error(json.error || "Не удалось загрузить документ");
  return {
    payload: json.payload ? mapProductSupplyPayload(json.payload) : null,
    documentId: String(json.document_id ?? ""),
    duplicateFile: Boolean(json.duplicate_file),
    alreadyImported: Boolean(json.already_imported),
    parserError: json.parser_error ?? null,
    supplyClosed: json.supply_status === "closed",
    parsedRowCount: Number(json.parsed_row_count ?? 0),
  };
}

export async function getSupplyDocumentSignedUrl(
  documentId: string,
  download = false,
): Promise<{ signedUrl: string; filename: string }> {
  const headers = await authHeaders();
  const res = await fetch("/api/staff/supplies/documents/signed-url", {
    method: "POST",
    headers,
    body: JSON.stringify({ document_id: documentId, download }),
  });
  const json = (await res.json()) as {
    error?: string;
    signed_url?: string;
    original_filename?: string;
  };
  if (!res.ok || !json.signed_url) {
    throw new Error(json.error || "Не удалось получить ссылку на файл");
  }
  return {
    signedUrl: json.signed_url,
    filename: json.original_filename || "document",
  };
}

export async function openSupplyDocumentInBrowser(documentId: string): Promise<void> {
  const { signedUrl } = await getSupplyDocumentSignedUrl(documentId, false);
  window.open(signedUrl, "_blank", "noopener,noreferrer");
}

export async function downloadSupplyDocumentOriginal(documentId: string): Promise<void> {
  const { signedUrl, filename } = await getSupplyDocumentSignedUrl(documentId, true);
  const a = document.createElement("a");
  a.href = signedUrl;
  a.rel = "noopener";
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function updateSupplyDocument(
  documentId: string,
  input: {
    title?: string;
    notes?: string | null;
    documentDate?: string | null;
    linkedExpenseId?: string | null;
    clearNotes?: boolean;
    clearDate?: boolean;
    clearExpense?: boolean;
  },
): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_update_product_supply_document", {
    p_document_id: documentId,
    p_title: input.title ?? null,
    p_notes: input.notes ?? null,
    p_document_date: input.documentDate ?? null,
    p_linked_expense_id: input.linkedExpenseId ?? null,
    p_clear_notes: input.clearNotes ?? false,
    p_clear_date: input.clearDate ?? false,
    p_clear_expense: input.clearExpense ?? false,
  });
  if (error) throwRpc(error, "Не удалось сохранить документ");
  return mapProductSupplyPayload(data);
}

export async function deleteSupplyDocument(documentId: string): Promise<ProductSupplyPayload | null> {
  const headers = await authHeaders();
  const res = await fetch("/api/staff/supplies/documents/delete", {
    method: "POST",
    headers,
    body: JSON.stringify({ document_id: documentId }),
  });
  const json = (await res.json()) as { error?: string; payload?: unknown };
  if (!res.ok) throw new Error(json.error || "Не удалось удалить документ");
  return json.payload ? mapProductSupplyPayload(json.payload) : null;
}

function mapCandidate(row: Record<string, unknown>): SupplyDocumentProductCandidate {
  return {
    product_id: asString(row.product_id ?? row.id),
    sku: asString(row.sku),
    name: asString(row.name),
    original_sku: asNullableString(row.original_sku),
    unit: asString(row.unit, "шт."),
    status: asString(row.status),
    dimensions: asNullableString(row.dimensions),
    category_id: asNullableString(row.category_id),
    category_name: asNullableString(row.category_name),
    subcategory_id: asNullableString(row.subcategory_id),
    subcategory_name: asNullableString(row.subcategory_name),
  };
}

function mapParsedRow(row: Record<string, unknown>): SupplyDocumentParsedRow {
  const issuesRaw = row.source_issues;
  const issues = Array.isArray(issuesRaw)
    ? issuesRaw.map((item) => String(item))
    : [];
  const candidatesRaw = row.match_candidates;
  const candidates = Array.isArray(candidatesRaw)
    ? candidatesRaw.map((item) => mapCandidate((item ?? {}) as Record<string, unknown>))
    : [];
  const status = asString(row.match_status, "unmatched") as SupplyDocumentRowMatchStatus;
  return {
    id: asString(row.id),
    document_id: asString(row.document_id),
    supply_id: asString(row.supply_id),
    source_row_number: asNumber(row.source_row_number),
    sort_order: asNumber(row.sort_order),
    source_own_code: asNullableString(row.source_own_code),
    source_supplier_code: asNullableString(row.source_supplier_code),
    source_name: asNullableString(row.source_name),
    source_spec: asNullableString(row.source_spec),
    source_unit: asNullableString(row.source_unit),
    source_quantity: asNullableNumber(row.source_quantity),
    source_price: asNullableNumber(row.source_price),
    source_amount: asNullableNumber(row.source_amount),
    source_notes: asNullableString(row.source_notes),
    source_issues: issues,
    own_code: asNullableString(row.own_code),
    supplier_code: asNullableString(row.supplier_code),
    product_name: asNullableString(row.product_name),
    specification: asNullableString(row.specification),
    unit: asNullableString(row.unit),
    quantity: asNullableNumber(row.quantity),
    price: asNullableNumber(row.price),
    amount: asNullableNumber(row.amount),
    matched_product_id: asNullableString(row.matched_product_id),
    matched_sku: asNullableString(row.matched_sku),
    matched_name: asNullableString(row.matched_name),
    matched_original_sku: asNullableString(row.matched_original_sku),
    matched_unit: asNullableString(row.matched_unit),
    matched_status: asNullableString(row.matched_status),
    matched_category_name: asNullableString(row.matched_category_name),
    matched_subcategory_name: asNullableString(row.matched_subcategory_name),
    matched_dimensions: asNullableString(row.matched_dimensions),
    match_status: status,
    match_method: asNullableString(row.match_method),
    match_candidates: candidates,
    linked_supply_item_id: asNullableString(row.linked_supply_item_id),
    linked_item_quantity: asNullableNumber(row.linked_item_quantity),
    linked_item_sku: asNullableString(row.linked_item_sku),
    linked_item_name: asNullableString(row.linked_item_name),
  };
}

function mapDocumentLite(row: Record<string, unknown>): ProductSupplyDocument {
  return {
    id: asString(row.id),
    supply_id: asString(row.supply_id),
    document_type: asString(row.document_type, "other") as ProductSupplyDocument["document_type"],
    title: asString(row.title),
    original_filename: asString(row.original_filename),
    storage_path: asString(row.storage_path),
    mime_type: asNullableString(row.mime_type),
    file_size: asNullableNumber(row.file_size),
    content_sha256: asNullableString(row.content_sha256),
    uploaded_by: asString(row.uploaded_by),
    uploaded_by_name: asNullableString(row.uploaded_by_name),
    uploaded_at: asString(row.uploaded_at),
    document_date: asNullableString(row.document_date),
    notes: asNullableString(row.notes),
    source_kind: row.source_kind === "import" ? "import" : "upload",
    linked_expense_id: asNullableString(row.linked_expense_id),
    linked_expense_name: asNullableString(row.linked_expense_name),
    parser_status: asNullableString(row.parser_status) as ProductSupplyDocument["parser_status"],
    imported_at: asNullableString(row.imported_at),
    imported_by: asNullableString(row.imported_by),
    already_imported: Boolean(row.already_imported),
    parsed_row_count: asNumber(row.parsed_row_count, 0),
  };
}

export function mapSupplyDocumentDetail(data: unknown): SupplyDocumentDetail {
  const row = (data ?? {}) as Record<string, unknown>;
  const document = mapDocumentLite((row.document ?? {}) as Record<string, unknown>);
  const summary = (row.match_summary ?? {}) as Record<string, unknown>;
  const meta = row.parser_metadata;
  return {
    document,
    supply_id: asString(row.supply_id, document.supply_id),
    supply_status: asString(row.supply_status, "draft") === "closed" ? "closed" : "draft",
    supply_number: asString(row.supply_number),
    supply_title: asString(row.supply_title),
    parser_status: asNullableString(row.parser_status),
    parser_metadata:
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {},
    rows: ((row.rows as Record<string, unknown>[] | null) ?? []).map(mapParsedRow),
    match_summary: {
      matched: asNumber(summary.matched),
      needs_selection: asNumber(summary.needs_selection),
      unmatched: asNumber(summary.unmatched),
      skipped: asNumber(summary.skipped),
      invalid: asNumber(summary.invalid),
    },
  };
}

export async function getSupplyDocumentDetail(documentId: string): Promise<SupplyDocumentDetail> {
  const { data, error } = await supabase.rpc("staff_get_product_supply_document_detail", {
    p_document_id: documentId,
  });
  if (error) throwRpc(error, "Не удалось загрузить документ");
  return mapSupplyDocumentDetail(data);
}

export async function patchSupplyDocumentRow(input: {
  rowId: string;
  matchedProductId?: string | null;
  clearMatch?: boolean;
  skip?: boolean | null;
  quantity?: number | null;
  price?: number | null;
  unit?: string | null;
  specification?: string | null;
  clearSpecification?: boolean;
}): Promise<SupplyDocumentDetail> {
  const { data, error } = await supabase.rpc("staff_patch_product_supply_document_row", {
    p_row_id: input.rowId,
    p_matched_product_id: input.matchedProductId ?? null,
    p_clear_match: input.clearMatch ?? false,
    p_skip: input.skip ?? null,
    p_quantity: input.quantity ?? null,
    p_price: input.price ?? null,
    p_unit: input.unit ?? null,
    p_specification: input.specification ?? null,
    p_clear_specification: input.clearSpecification ?? false,
  });
  if (error) throwRpc(error, "Не удалось сохранить строку документа");
  return mapSupplyDocumentDetail(data);
}

export async function createDraftForSupplyDocumentRow(input: {
  rowId: string;
  sku?: string | null;
  name?: string | null;
  unit?: string | null;
  originalSku?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
}): Promise<SupplyDocumentDetail> {
  const { data, error } = await supabase.rpc("staff_create_draft_for_supply_document_row", {
    p_row_id: input.rowId,
    p_sku: input.sku ?? null,
    p_name: input.name ?? null,
    p_unit: input.unit ?? null,
    p_original_sku: input.originalSku ?? null,
    p_category_id: input.categoryId ?? null,
    p_subcategory_id: input.subcategoryId ?? null,
  });
  if (error) throwRpc(error, "Не удалось создать товар");
  return mapSupplyDocumentDetail(data);
}

export async function commitSupplyImport(input: {
  documentId: string;
  replace?: boolean;
}): Promise<ProductSupplyPayload> {
  const { data, error } = await supabase.rpc("staff_commit_product_supply_import", {
    p_document_id: input.documentId,
    p_resolutions: [],
    p_replace: input.replace ?? false,
  });
  if (error) throwRpc(error, "Не удалось подтвердить импорт");
  return mapProductSupplyPayload(data);
}
