import { notFound } from "next/navigation";
import { products } from "@/data/products";
import ProductDetail from "@/components/ProductDetail";
import SupabaseProductPage from "@/components/SupabaseProductPage";

const useSupabaseCatalog = process.env.NEXT_PUBLIC_USE_SUPABASE_CATALOG === "true";

export function generateStaticParams() {
  if (useSupabaseCatalog) {
    // Product ids come from Supabase at runtime in this mode, so there is
    // nothing to pre-render at build time — fall back to on-demand rendering.
    return [];
  }
  return products.map((product) => ({ id: product.id }));
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (useSupabaseCatalog) {
    return <SupabaseProductPage productId={id} />;
  }

  const product = products.find((item) => item.id === id);

  if (!product) {
    notFound();
  }

  return <ProductDetail product={product} />;
}
