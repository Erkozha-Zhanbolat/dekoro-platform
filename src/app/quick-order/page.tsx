import { redirect } from "next/navigation";
import { enableQuickOrder } from "@/lib/featureFlags";
import QuickOrderClient from "./QuickOrderClient";

// Server component route guard: Quick Order is feature-flagged off by
// default, so a direct visit to /quick-order must not render the page (or
// even ship its client bundle) while the flag is disabled. redirect() only
// works reliably from a server context, which is why this file stays a
// server component and the actual (client) page logic lives in
// QuickOrderClient.tsx unchanged.
export default function QuickOrderPage() {
  if (!enableQuickOrder) {
    redirect("/catalog");
  }

  return <QuickOrderClient />;
}
