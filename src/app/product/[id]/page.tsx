import { Suspense } from "react";
import { notFound } from "next/navigation";
import SupabaseProductPage from "@/components/SupabaseProductPage";

export function generateStaticParams() {
  // Product ids come from Supabase at runtime — nothing to pre-render.
  return [];
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!id) {
    notFound();
  }

  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-5xl px-6 py-16 text-center text-neutral-500">
          Загрузка товара...
        </div>
      }
    >
      <SupabaseProductPage productId={id} />
    </Suspense>
  );
}
