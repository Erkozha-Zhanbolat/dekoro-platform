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

  return <SupabaseProductPage productId={id} />;
}
