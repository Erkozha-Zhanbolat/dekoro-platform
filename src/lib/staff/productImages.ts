import { supabase } from "@/lib/supabase/client";
import { optimizeProductImage } from "@/lib/staff/optimizeProductImage";
import { setStaffProductMainPhoto } from "@/lib/staff/products";
import type { StaffProductDetails } from "@/types/database";

export const PRODUCT_IMAGES_BUCKET = "product-images";

export const PRODUCT_MAIN_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

const EXT_BY_MIME: Record<string, "png" | "jpg" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const PRODUCT_PHOTO_PATH_RE =
  /^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/main\.(png|jpe?g|webp)$/i;

function assertAllowedFile(file: File): "png" | "jpg" | "webp" {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error("Допустимы только PNG, JPEG или WEBP.");
  }

  if (file.size > PRODUCT_MAIN_PHOTO_MAX_BYTES) {
    throw new Error("Максимальный размер фото — 5 МБ");
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    throw new Error("Неподдерживаемый тип файла");
  }

  return ext;
}

export function productMainPhotoPath(productId: string, ext: string): string {
  return `products/${productId}/main.${ext}`;
}

function assertProductPhotoPath(path: string, productId?: string): void {
  if (!PRODUCT_PHOTO_PATH_RE.test(path)) {
    throw new Error("Некорректный Storage path фото товара");
  }
  if (productId && !path.startsWith(`products/${productId}/`)) {
    throw new Error("Path не принадлежит этому товару");
  }
}

/**
 * Public URL for a product main photo path (bucket product-images is public
 * after migration 020). Synchronous — no Storage round-trip / no N+1.
 * Optional cacheBust (e.g. products.updated_at) forces browsers to refetch
 * after an in-place overwrite of the same path.
 */
export function getProductMainPhotoPublicUrl(
  path: string,
  cacheBust?: string | number | null,
): string {
  const trimmed = path.trim();
  assertProductPhotoPath(trimmed);

  const { data } = supabase.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .getPublicUrl(trimmed);

  if (!data?.publicUrl) {
    throw new Error("Не удалось получить публичный URL фото");
  }

  let url = data.publicUrl;
  if (cacheBust != null && String(cacheBust).trim() !== "") {
    const raw = String(cacheBust).trim();
    const ms = Date.parse(raw);
    const token = Number.isFinite(ms) ? String(ms) : encodeURIComponent(raw);
    url = `${url}${url.includes("?") ? "&" : "?"}v=${token}`;
  }

  return url;
}

/** @deprecated Prefer getProductMainPhotoPublicUrl after migration 020. */
export async function getProductMainPhotoSignedUrl(
  path: string,
  expiresInSeconds = 60 * 10,
): Promise<string> {
  const trimmed = path.trim();
  assertProductPhotoPath(trimmed);

  const { data, error } = await supabase.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .createSignedUrl(trimmed, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Не удалось получить URL фото");
  }

  return data.signedUrl;
}

async function removeStoragePathBestEffort(path: string): Promise<void> {
  try {
    await supabase.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
  } catch {
    // Orphan scan / retry later — do not fail the primary operation.
  }
}

/**
 * Upload/replace the single main photo for a product.
 * Browser-optimizes to WebP when smaller; never deletes the previous object
 * until Storage upload + DB path update both succeed.
 */
export async function uploadProductMainPhoto(
  productId: string,
  file: File,
  previousPath?: string | null,
): Promise<StaffProductDetails> {
  assertAllowedFile(file);

  const prepared = await optimizeProductImage(file);
  if (prepared.file.size > PRODUCT_MAIN_PHOTO_MAX_BYTES) {
    throw new Error("Максимальный размер фото — 5 МБ");
  }

  const path = productMainPhotoPath(productId, prepared.ext);
  const replacingDifferentPath = Boolean(
    previousPath && previousPath !== path,
  );

  if (replacingDifferentPath && previousPath) {
    assertProductPhotoPath(previousPath, productId);
  }

  const { error: uploadError } = await supabase.storage
    .from(PRODUCT_IMAGES_BUCKET)
    .upload(path, prepared.file, {
      upsert: true,
      contentType: prepared.mime,
      cacheControl: "3600",
    });

  if (uploadError) {
    // Previous object untouched when upload fails (new path) or left as-is
    // when same-path upsert never completed.
    throw new Error(uploadError.message || "Не удалось загрузить фото");
  }

  try {
    const details = await setStaffProductMainPhoto(productId, path);

    if (replacingDifferentPath && previousPath) {
      // Best-effort: DB already points at the new path.
      await removeStoragePathBestEffort(previousPath);
    }

    return details;
  } catch (error: unknown) {
    // Upload of a *new* path succeeded but DB did not — drop the orphan so
    // the catalog still resolves previousPath. Same-path upsert cannot restore
    // prior bytes; leave the object and rethrow.
    if (replacingDifferentPath || !previousPath) {
      await removeStoragePathBestEffort(path);
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Не удалось сохранить фото");
  }
}

export async function clearProductMainPhoto(
  productId: string,
  path: string | null,
): Promise<StaffProductDetails> {
  if (path) {
    assertProductPhotoPath(path, productId);
    const { error } = await supabase.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
    if (error) {
      throw new Error(error.message || "Не удалось удалить фото из Storage");
    }
  }

  return setStaffProductMainPhoto(productId, null);
}

/**
 * After staff_copy_product: duplicate source object into the new product path.
 */
export async function copyProductMainPhoto(input: {
  newProductId: string;
  sourcePath: string | null;
}): Promise<StaffProductDetails | null> {
  if (!input.sourcePath) {
    return null;
  }

  assertProductPhotoPath(input.sourcePath);

  const match = input.sourcePath.match(/\.(png|jpe?g|webp)$/i);
  let ext = (match?.[1] ?? "jpg").toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  const destPath = productMainPhotoPath(input.newProductId, ext);

  const { error } = await supabase.storage.from(PRODUCT_IMAGES_BUCKET).copy(input.sourcePath, destPath);

  if (error) {
    throw new Error(error.message || "Не удалось скопировать фото товара");
  }

  return setStaffProductMainPhoto(input.newProductId, destPath);
}
