import type { SVGProps } from "react";

function ImagePlaceholderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.1 0L4 19" />
    </svg>
  );
}

export function ProductImagePlaceholder({
  isPromotion = false,
  className = "",
}: {
  isPromotion?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`relative flex items-center justify-center rounded-md bg-neutral-100 text-neutral-300 ${className}`}
    >
      <ImagePlaceholderIcon className="h-10 w-10" />
      {isPromotion && (
        <span className="absolute left-2 top-2 rounded-full bg-[#0F766E] px-2 py-0.5 text-[11px] font-semibold text-white">
          Акция
        </span>
      )}
    </div>
  );
}
