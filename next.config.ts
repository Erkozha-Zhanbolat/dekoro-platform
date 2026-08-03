import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @react-pdf/renderer uses its own reconciler; keep it external for any SSR paths.
  serverExternalPackages: ["@react-pdf/renderer"],
};

export default nextConfig;
