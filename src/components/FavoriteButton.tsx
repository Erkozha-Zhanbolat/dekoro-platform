"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useAuth } from "@/context/AuthContext";
import { useFavorites } from "@/context/FavoritesContext";
import { useSupabaseCatalog, useSupabaseFavorites } from "@/lib/featureFlags";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

function HeartIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20.5s-7.6-4.6-10.1-9.4C0.4 7.9 1.7 4.4 4.8 3.4c2.5-.8 5.1 0 7.2 2.6 2.1-2.6 4.7-3.4 7.2-2.6 3.1 1 4.4 4.5 2.9 7.7C19.6 15.9 12 20.5 12 20.5z" />
    </svg>
  );
}

interface FavoriteButtonProps {
  productId: string;
  variant?: "icon" | "labeled";
}

export default function FavoriteButton({ productId, variant = "icon" }: FavoriteButtonProps) {
  const { user } = useAuth();
  const { isFavorite, toggleFavorite } = useFavorites();
  const [isPending, setIsPending] = useState(false);
  const [showGuestHint, setShowGuestHint] = useState(false);
  const hintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hintTimeoutRef.current) {
        clearTimeout(hintTimeoutRef.current);
      }
    };
  }, []);

  if (!useSupabaseFavorites) {
    return null;
  }

  const favorite = isFavorite(productId);
  const label = favorite ? "Удалить из избранного" : "Добавить в избранное";

  async function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    // Sign-in is only required in Supabase mode (favorites are tied to a
    // user there). With the static catalog, favorites live in localStorage
    // and work for guests too.
    if (useSupabaseCatalog && !user) {
      setShowGuestHint(true);
      if (hintTimeoutRef.current) {
        clearTimeout(hintTimeoutRef.current);
      }
      hintTimeoutRef.current = setTimeout(() => setShowGuestHint(false), 5000);
      return;
    }

    if (isPending) {
      return;
    }

    setIsPending(true);
    try {
      await toggleFavorite(productId);
    } catch {
      // FavoritesContext already stores a readable error message.
    } finally {
      setIsPending(false);
    }
  }

  const buttonClassName =
    variant === "icon"
      ? `flex h-9 w-9 items-center justify-center rounded-full border bg-white shadow-sm transition-colors disabled:cursor-wait ${focusRing} ${
          favorite
            ? "border-[#0F766E] text-[#e11d48]"
            : "border-neutral-200 text-neutral-400 hover:text-[#e11d48]"
        }`
      : `inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-wait ${focusRing} ${
          favorite
            ? "border-[#0F766E] bg-[#0F766E]/5 text-[#0F766E]"
            : "border-neutral-200 text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
        }`;

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        aria-label={label}
        title={label}
        aria-pressed={favorite}
        className={buttonClassName}
      >
        <HeartIcon filled={favorite} className={variant === "icon" ? "h-5 w-5" : "h-4 w-4"} />
        {variant === "labeled" && <span>{favorite ? "В избранном" : "В избранное"}</span>}
      </button>

      {showGuestHint && (
        <div
          role="status"
          className="absolute right-0 top-full z-20 mt-2 w-56 rounded-md border border-neutral-200 bg-white p-3 text-xs text-neutral-600 shadow-md"
        >
          Войдите, чтобы добавлять товары в избранное.{" "}
          <Link
            href="/login"
            className={`font-medium text-[#0F766E] hover:underline rounded-sm ${focusRing}`}
            onClick={(event) => event.stopPropagation()}
          >
            Войти
          </Link>
        </div>
      )}
    </div>
  );
}
