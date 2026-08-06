"use client";

import { getProductMainPhotoPublicUrl } from "@/lib/staff/productImages";

type Props = {
  path: string | null | undefined;
  alt: string;
  className?: string;
  /** products.updated_at — busts cache after in-place photo replace. */
  cacheBust?: string | null;
};

export function StaffProductPhotoThumb({ path, alt, className, cacheBust }: Props) {
  let url: string | null = null;
  if (path) {
    try {
      url = getProductMainPhotoPublicUrl(path, cacheBust);
    } catch {
      url = null;
    }
  }

  if (!url) {
    return (
      <div
        className={`flex items-center justify-center bg-neutral-100 text-[10px] uppercase tracking-wide text-neutral-400 ${className ?? ""}`}
        aria-hidden
      >
        Нет фото
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- public Storage URLs
    <img src={url} alt={alt} className={`object-cover ${className ?? ""}`} />
  );
}
