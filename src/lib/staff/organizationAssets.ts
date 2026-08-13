import { supabase } from "@/lib/supabase/client";
import type {
  OrderDocumentType,
  OrganizationAssetKind,
  OrganizationSettings,
} from "@/types/database";
import { getOrganizationSettings, setOrganizationAssetPath } from "./organization";

export const ORGANIZATION_ASSETS_BUCKET = "organization-assets";

export const ORGANIZATION_ASSET_LIMITS: Record<
  OrganizationAssetKind,
  { maxBytes: number; label: string }
> = {
  logo: { maxBytes: 2 * 1024 * 1024, label: "Логотип" },
  stamp: { maxBytes: 3 * 1024 * 1024, label: "Печать" },
  signature: { maxBytes: 2 * 1024 * 1024, label: "Подпись" },
  kaspi_qr: { maxBytes: 2 * 1024 * 1024, label: "Kaspi QR для оплаты" },
};

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

const EXT_BY_MIME: Record<string, "png" | "jpg" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const LIVE_PATH_RE =
  /^organization\/(logo|stamp|signature|kaspi_qr)\.(png|jpe?g|webp)$/i;
const SNAPSHOT_PATH_RE =
  /^organization\/doc-snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(logo|stamp|signature)\.(png|jpe?g|webp)$/i;

export type DocumentAssetCopyPair = {
  kind: OrganizationAssetKind;
  source_path: string;
  dest_path: string;
};

export type DocumentAssetSnapshotIntent = {
  intent_id: string;
  order_id: string;
  document_type: OrderDocumentType;
  expires_at: string;
  assets: DocumentAssetCopyPair[];
};

function liveAssetPath(kind: OrganizationAssetKind, ext: string): string {
  return `organization/${kind}.${ext}`;
}

function assertAllowedFile(kind: OrganizationAssetKind, file: File): string {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(
      "Допустимы только PNG, JPEG или WEBP. PDF, SVG и другие форматы запрещены.",
    );
  }

  const limit = ORGANIZATION_ASSET_LIMITS[kind];
  if (file.size > limit.maxBytes) {
    const mb = (limit.maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`${limit.label}: максимальный размер ${mb} МБ`);
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    throw new Error("Неподдерживаемый тип файла");
  }

  return ext;
}

export function getAssetPathFromSettings(
  settings: OrganizationSettings,
  kind: OrganizationAssetKind,
): string | null {
  if (kind === "logo") return settings.logo_path;
  if (kind === "stamp") return settings.stamp_path;
  if (kind === "kaspi_qr") return settings.kaspi_qr_path;
  return settings.signature_path;
}

function assertLiveOrganizationPath(path: string): void {
  if (!LIVE_PATH_RE.test(path)) {
    throw new Error(
      "Разрешены только live path: organization/{logo|stamp|signature|kaspi_qr}.{ext}",
    );
  }
}

/**
 * Signed URL for live organization assets only (settings preview).
 * Snapshot paths must use getDocumentAssetSignedUrl.
 */
export async function getOrganizationAssetSignedUrl(
  path: string,
  expiresInSeconds = 60 * 10,
): Promise<string> {
  const trimmed = path.trim();
  assertLiveOrganizationPath(trimmed);

  const { data, error } = await supabase.storage
    .from(ORGANIZATION_ASSETS_BUCKET)
    .createSignedUrl(trimmed, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Не удалось получить URL изображения");
  }

  return data.signedUrl;
}

/**
 * Signed URL for an image sealed in document metadata.
 * Verifies path belongs to that document before asking Storage to sign.
 */
export async function getDocumentAssetSignedUrl(
  orderId: string,
  documentId: string,
  path: string,
  expiresInSeconds = 60 * 15,
): Promise<string> {
  const trimmed = path.trim();
  if (!SNAPSHOT_PATH_RE.test(trimmed) && !LIVE_PATH_RE.test(trimmed)) {
    throw new Error("Некорректный Storage path изображения документа");
  }

  const { getStaffDocument } = await import("@/lib/staff/documents");
  const document = await getStaffDocument(orderId, documentId);
  if (!document) {
    throw new Error("Документ не найден или недоступен");
  }

  const supplier = document.metadata.supplier ?? {};
  const allowed = new Set(
    [supplier.logo_path, supplier.stamp_path, supplier.signature_path]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim()),
  );

  if (!allowed.has(trimmed)) {
    throw new Error("Path не принадлежит metadata этого документа");
  }

  const { data, error } = await supabase.storage
    .from(ORGANIZATION_ASSETS_BUCKET)
    .createSignedUrl(trimmed, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Не удалось получить URL изображения документа");
  }

  return data.signedUrl;
}

/** Upload/replace live asset only (never snapshots). */
export async function uploadOrganizationAsset(
  kind: OrganizationAssetKind,
  file: File,
): Promise<OrganizationSettings> {
  const ext = assertAllowedFile(kind, file);
  const path = liveAssetPath(kind, ext);
  const settings = await getOrganizationSettings();
  const previous = getAssetPathFromSettings(settings, kind);

  const { error: uploadError } = await supabase.storage
    .from(ORGANIZATION_ASSETS_BUCKET)
    .upload(path, file, {
      upsert: true,
      contentType: file.type,
      cacheControl: "3600",
    });

  if (uploadError) {
    throw new Error(uploadError.message || "Не удалось загрузить изображение");
  }

  if (previous && previous !== path) {
    assertLiveOrganizationPath(previous);
    await supabase.storage.from(ORGANIZATION_ASSETS_BUCKET).remove([previous]);
  }

  return setOrganizationAssetPath(kind, path);
}

/** Deletes only the live asset + clears settings path. Never touches snapshots. */
export async function deleteOrganizationAsset(
  kind: OrganizationAssetKind,
): Promise<OrganizationSettings> {
  const settings = await getOrganizationSettings();
  const path = getAssetPathFromSettings(settings, kind);

  if (path) {
    assertLiveOrganizationPath(path);
    const { error } = await supabase.storage
      .from(ORGANIZATION_ASSETS_BUCKET)
      .remove([path]);
    if (error) {
      throw new Error(error.message || "Не удалось удалить файл из Storage");
    }
  }

  return setOrganizationAssetPath(kind, null);
}

export async function beginDocumentAssetSnapshot(
  orderId: string,
  documentType: OrderDocumentType,
): Promise<DocumentAssetSnapshotIntent> {
  const { data, error } = await supabase.rpc("staff_begin_document_asset_snapshot", {
    p_order_id: orderId,
    p_document_type: documentType,
  });

  if (error || !data) {
    throw new Error(error?.message || "Не удалось подготовить снимок изображений");
  }

  const row = data as {
    intent_id: string;
    order_id: string;
    document_type: OrderDocumentType;
    expires_at: string;
    assets: DocumentAssetCopyPair[];
  };

  return {
    intent_id: row.intent_id,
    order_id: row.order_id,
    document_type: row.document_type,
    expires_at: row.expires_at,
    assets: Array.isArray(row.assets) ? row.assets : [],
  };
}

export async function failDocumentAssetSnapshot(intentId: string): Promise<void> {
  const { error } = await supabase.rpc("staff_fail_document_asset_snapshot", {
    p_intent_id: intentId,
  });
  if (error) {
    // Best-effort cleanup marker; do not mask original generate error.
    console.error(error.message);
  }
}

/**
 * Copy live→snapshot for server-issued pairs only.
 * Downloads ALL sources first (consistent set), then uploads (no upsert).
 */
export async function copyDocumentAssetSnapshot(
  intent: DocumentAssetSnapshotIntent,
): Promise<void> {
  const downloads: { pair: DocumentAssetCopyPair; blob: Blob }[] = [];

  for (const pair of intent.assets) {
    assertLiveOrganizationPath(pair.source_path);
    if (!SNAPSHOT_PATH_RE.test(pair.dest_path)) {
      throw new Error(`Недопустимый dest_path: ${pair.dest_path}`);
    }
    if (!pair.dest_path.includes(intent.intent_id)) {
      throw new Error("dest_path не принадлежит выданному intent");
    }

    const { data: blob, error } = await supabase.storage
      .from(ORGANIZATION_ASSETS_BUCKET)
      .download(pair.source_path);

    if (error || !blob) {
      throw new Error(error?.message || `Не удалось прочитать ${pair.kind}`);
    }

    downloads.push({ pair, blob });
  }

  for (const { pair, blob } of downloads) {
    const { error } = await supabase.storage
      .from(ORGANIZATION_ASSETS_BUCKET)
      .upload(pair.dest_path, blob, {
        upsert: false,
        contentType: blob.type || "image/png",
        cacheControl: "31536000",
      });

    if (error) {
      throw new Error(
        error.message ||
          `Не удалось сохранить снимок ${pair.kind} (повторная запись запрещена)`,
      );
    }
  }
}

/**
 * Full secure prepare: begin intent → copy frozen sources → return intent_id.
 */
export async function prepareDocumentAssetSnapshot(
  orderId: string,
  documentType: OrderDocumentType,
): Promise<string> {
  const intent = await beginDocumentAssetSnapshot(orderId, documentType);
  try {
    await copyDocumentAssetSnapshot(intent);
    return intent.intent_id;
  } catch (error) {
    await failDocumentAssetSnapshot(intent.intent_id);
    throw error;
  }
}
