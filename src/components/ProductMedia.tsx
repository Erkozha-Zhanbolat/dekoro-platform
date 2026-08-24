import { ProductImagePlaceholder } from "@/components/ProductImagePlaceholder";

type Props = {
  src: string | null | undefined;
  alt: string;
  isPromotion?: boolean;
  className?: string;
  /** Browser native lazy-loading; default lazy for below-fold catalog images. */
  loading?: "lazy" | "eager";
};

/**
 * Catalog/product media: public image URL when present, else placeholder.
 * Uses <img> (not next/image) so Supabase Storage hosts need no remotePatterns.
 */
export function ProductMedia({
  src,
  alt,
  isPromotion = false,
  className = "",
  loading = "lazy",
}: Props) {
  if (!src) {
    return (
      <ProductImagePlaceholder isPromotion={isPromotion} className={className} />
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-md bg-neutral-100 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- public catalog Storage URLs */}
      <img
        src={src}
        alt={alt}
        className="h-full w-full object-cover"
        loading={loading}
        decoding="async"
      />
      {isPromotion && (
        <span className="absolute left-2 top-2 rounded-full bg-[#0F766E] px-2 py-0.5 text-[11px] font-semibold text-white">
          Акция
        </span>
      )}
    </div>
  );
}
