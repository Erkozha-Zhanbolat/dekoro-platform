/**
 * Browser-side product main photo optimization (resize + WebP).
 * Pure helpers below are safe for Node selfchecks; encode path needs DOM APIs.
 */

export const PRODUCT_IMAGE_MAX_LONG_SIDE = 1200;
export const PRODUCT_IMAGE_WEBP_QUALITY = 0.82;

export type ProductImageExt = "png" | "jpg" | "webp";

export type TargetDimensions = {
  width: number;
  height: number;
  /** True when long side was reduced (never upscales). */
  resized: boolean;
};

export type OptimizeProductImageResult = {
  file: File;
  mime: string;
  ext: ProductImageExt;
  originalSize: number;
  optimizedSize: number;
  originalWidth: number;
  originalHeight: number;
  finalWidth: number;
  finalHeight: number;
  wasOptimized: boolean;
};

const EXT_BY_MIME: Record<string, ProductImageExt> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Fit inside maxLongSide without upscaling; preserve aspect ratio. */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxLongSide: number = PRODUCT_IMAGE_MAX_LONG_SIDE,
): TargetDimensions {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    throw new Error("Некорректные размеры изображения");
  }
  if (!Number.isFinite(maxLongSide) || maxLongSide <= 0) {
    throw new Error("Некорректный лимит длинной стороны");
  }

  const long = Math.max(width, height);
  if (long <= maxLongSide) {
    return {
      width: Math.round(width),
      height: Math.round(height),
      resized: false,
    };
  }

  const scale = maxLongSide / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/** Use WebP only when it is strictly smaller than the source file. */
export function shouldUseOptimizedFile(
  originalSize: number,
  optimizedSize: number,
): boolean {
  return (
    Number.isFinite(originalSize)
    && Number.isFinite(optimizedSize)
    && originalSize > 0
    && optimizedSize > 0
    && optimizedSize < originalSize
  );
}

function extFromMime(mime: string): ProductImageExt | null {
  return EXT_BY_MIME[mime] ?? null;
}

function unoptimizedResult(
  file: File,
  dims?: { width: number; height: number },
): OptimizeProductImageResult {
  const ext = extFromMime(file.type) ?? "jpg";
  const w = dims?.width ?? 0;
  const h = dims?.height ?? 0;
  return {
    file,
    mime: file.type,
    ext,
    originalSize: file.size,
    optimizedSize: file.size,
    originalWidth: w,
    originalHeight: h,
    finalWidth: w,
    finalHeight: h,
    wasOptimized: false,
  };
}

function imageDataHasTransparency(imageData: ImageData): boolean {
  const { data } = imageData;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}

async function decodeBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, {
      // Honor EXIF orientation when the browser supports it.
      imageOrientation: "from-image",
    } as ImageBitmapOptions);
  } catch {
    return await createImageBitmap(file);
  }
}

function canvasToWebpBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (blob) => resolve(blob),
        "image/webp",
        quality,
      );
    } catch {
      resolve(null);
    }
  });
}

async function webpPreservesTransparency(blob: Blob): Promise<boolean> {
  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    return imageDataHasTransparency(
      ctx.getImageData(0, 0, canvas.width, canvas.height),
    );
  } catch {
    return false;
  } finally {
    bitmap?.close();
    canvas = null;
  }
}

/**
 * Resize (max long side) + WebP encode in the browser.
 * On any failure, or when WebP is not smaller, returns the original file.
 * Never upscales; never square-crops; does not flatten alpha onto a background.
 */
export async function optimizeProductImage(
  file: File,
): Promise<OptimizeProductImageResult> {
  const sourceExt = extFromMime(file.type);
  if (!sourceExt) {
    return unoptimizedResult(file);
  }

  if (
    typeof window === "undefined"
    || typeof createImageBitmap !== "function"
    || typeof document === "undefined"
  ) {
    return unoptimizedResult(file);
  }

  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;

  try {
    bitmap = await decodeBitmap(file);
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const target = computeTargetDimensions(
      originalWidth,
      originalHeight,
      PRODUCT_IMAGE_MAX_LONG_SIDE,
    );

    canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return unoptimizedResult(file, {
        width: originalWidth,
        height: originalHeight,
      });
    }

    // Keep transparent pixels transparent (default composite; no fill).
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);

    const sourceHasAlpha = imageDataHasTransparency(
      ctx.getImageData(0, 0, target.width, target.height),
    );

    const webpBlob = await canvasToWebpBlob(canvas, PRODUCT_IMAGE_WEBP_QUALITY);
    if (!webpBlob || webpBlob.size <= 0) {
      return unoptimizedResult(file, {
        width: originalWidth,
        height: originalHeight,
      });
    }

    if (sourceHasAlpha) {
      const alphaOk = await webpPreservesTransparency(webpBlob);
      if (!alphaOk) {
        return {
          ...unoptimizedResult(file, {
            width: originalWidth,
            height: originalHeight,
          }),
          finalWidth: originalWidth,
          finalHeight: originalHeight,
        };
      }
    }

    if (!shouldUseOptimizedFile(file.size, webpBlob.size)) {
      return {
        file,
        mime: file.type,
        ext: sourceExt,
        originalSize: file.size,
        optimizedSize: webpBlob.size,
        originalWidth,
        originalHeight,
        finalWidth: originalWidth,
        finalHeight: originalHeight,
        wasOptimized: false,
      };
    }

    const optimizedFile = new File([webpBlob], "main.webp", {
      type: "image/webp",
      lastModified: Date.now(),
    });

    return {
      file: optimizedFile,
      mime: "image/webp",
      ext: "webp",
      originalSize: file.size,
      optimizedSize: optimizedFile.size,
      originalWidth,
      originalHeight,
      finalWidth: target.width,
      finalHeight: target.height,
      wasOptimized: true,
    };
  } catch {
    return unoptimizedResult(file);
  } finally {
    bitmap?.close();
    canvas = null;
  }
}
