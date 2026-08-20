/**
 * Storage object keys for supply documents must be ASCII-only.
 * Display / Content-Disposition use the original user filename separately.
 */

export const SUPPLY_DOCUMENT_ALLOWED_EXTENSIONS = [
  ".xlsx",
  ".xls",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
] as const;

const ALLOWED_EXT = new Set<string>(SUPPLY_DOCUMENT_ALLOWED_EXTENSIONS);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STORAGE_KEY_RE = /^[A-Za-z0-9._/-]+$/;

export function originalDisplayFileName(raw: string): string {
  const base = (raw.split(/[/\\]/).pop() ?? raw).replace(/\u0000/g, "").trim();
  if (!base || base === "." || base === "..") return "document";
  return base.slice(0, 255);
}

export function allowedFileExtension(fileName: string): string | null {
  const base = (fileName.split(/[/\\]/).pop() ?? fileName).trim();
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return null;
  let ext = lower.slice(dot);
  if (ext === ".jpeg") ext = ".jpg";
  return ALLOWED_EXT.has(ext) ? ext : null;
}

export function isAllowedSupplyDocumentName(fileName: string): boolean {
  return allowedFileExtension(fileName) != null;
}

export function isBrowserPreviewableFileName(fileName: string): boolean {
  const ext = allowedFileExtension(fileName);
  return ext === ".pdf" || ext === ".png" || ext === ".jpg" || ext === ".webp";
}

export function supplyDocumentStorageFileName(
  documentId: string,
  originalName: string,
): string {
  if (!UUID_RE.test(documentId)) {
    throw new Error("document_id должен быть UUID");
  }
  const ext = allowedFileExtension(originalName);
  if (ext) return `${documentId}${ext}`;
  return documentId;
}

export function supplyDocumentStoragePath(
  supplyId: string,
  documentId: string,
  originalName: string,
): string {
  if (!UUID_RE.test(supplyId) || !UUID_RE.test(documentId)) {
    throw new Error("supply_id и document_id должны быть UUID");
  }
  const objectName = supplyDocumentStorageFileName(documentId, originalName);
  const path = `supplies/${supplyId}/${documentId}/${objectName}`;
  if (!STORAGE_KEY_RE.test(path) || path.includes("..")) {
    throw new Error("Некорректный storage path");
  }
  return path;
}

/** ASCII fallback for Content-Disposition when original name is not Latin-1. */
export function contentDispositionFileName(originalName: string): string {
  const original = originalDisplayFileName(originalName);
  const ext = allowedFileExtension(original) ?? "";
  if (/^[\x20-\x7E]+$/.test(original) && !original.includes("\\") && !original.includes('"')) {
    return original;
  }
  return `document${ext || ""}`;
}

export function runSupplyStorageNameSelfCheck(): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };

  const supplyId = "c3facad4-18ae-48de-b315-942e28a68db4";
  const documentId = "20c8f951-afec-4c6c-9eee-9e6904c41032";

  const cases: { original: string; ext: string }[] = [
    { original: "ASLAN8.17订单.xlsx", ext: ".xlsx" },
    { original: "订单 17.08 (финал).xlsx", ext: ".xlsx" },
    { original: "Invoice №15.pdf", ext: ".pdf" },
    { original: "Packing List 08-17.pdf", ext: ".pdf" },
    { original: "test.xlsx", ext: ".xlsx" },
  ];

  for (const row of cases) {
    const display = originalDisplayFileName(row.original);
    const path = supplyDocumentStoragePath(supplyId, documentId, row.original);
    check(`${row.original} display preserved`, display === row.original);
    check(`${row.original} ascii key`, STORAGE_KEY_RE.test(path));
    check(`${row.original} no raw name in key`, !path.includes(row.original));
    check(
      `${row.original} key suffix`,
      path === `supplies/${supplyId}/${documentId}/${documentId}${row.ext}`,
    );
    check(`${row.original} not transliterated`, display.includes(row.original.slice(0, 4)));
  }

  check(
    "chinese not in storage key",
    !supplyDocumentStoragePath(supplyId, documentId, "ASLAN8.17订单.xlsx").includes("订单"),
  );
  check(
    "spaces not in storage key",
    !supplyDocumentStoragePath(supplyId, documentId, "订单 17.08 (финал).xlsx").includes(" "),
  );
  check(
    "numero not in storage key",
    !supplyDocumentStoragePath(supplyId, documentId, "Invoice №15.pdf").includes("№"),
  );
  check(
    "packing list display",
    originalDisplayFileName("Packing List 08-17.pdf") === "Packing List 08-17.pdf",
  );
  check(
    "packing list ascii disposition",
    contentDispositionFileName("Packing List 08-17.pdf") === "Packing List 08-17.pdf",
  );
  check(
    "unicode disposition fallback",
    contentDispositionFileName("ASLAN8.17订单.xlsx") === "document.xlsx",
  );
  check("plain test.xlsx display", originalDisplayFileName("test.xlsx") === "test.xlsx");
  check("xlsx not browser preview", isBrowserPreviewableFileName("ASLAN8.17订单.xlsx") === false);
  check("pdf browser preview", isBrowserPreviewableFileName("Invoice.pdf") === true);
  check("png browser preview", isBrowserPreviewableFileName("photo.PNG") === true);
  check(
    "path traversal stripped",
    originalDisplayFileName("/tmp/../ASLAN8.17订单.xlsx") === "ASLAN8.17订单.xlsx",
  );
  check("exe rejected", allowedFileExtension("malware.exe") == null);
  check("missing ext fallback object", supplyDocumentStorageFileName(documentId, "readme") === documentId);

  return failures;
}
