"use client";

import { useEffect, useState } from "react";
import { getProductMainPhotoSignedUrl } from "@/lib/staff/productImages";

type Props = {
  path: string | null | undefined;
  alt: string;
  className?: string;
};

export function StaffProductPhotoThumb({ path, alt, className }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [resolvedFor, setResolvedFor] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!path) {
      return;
    }

    let ignore = false;
    getProductMainPhotoSignedUrl(path)
      .then((signed) => {
        if (!ignore) {
          setUrl(signed);
          setResolvedFor(path);
        }
      })
      .catch(() => {
        if (!ignore) {
          setUrl(null);
          setResolvedFor(path);
        }
      });

    return () => {
      ignore = true;
    };
  }, [path]);

  if (!path || resolvedFor !== path || !url) {
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
    // eslint-disable-next-line @next/next/no-img-element -- signed Storage URLs are ephemeral
    <img src={url} alt={alt} className={`object-cover ${className ?? ""}`} />
  );
}
