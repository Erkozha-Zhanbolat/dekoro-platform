"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useProfile } from "@/context/ProfileContext";
import { canAccessProductSupplies } from "@/types/database";
import SupplyDocumentViewer from "@/components/staff/supply/SupplyDocumentViewer";

export default function StaffSupplyDocumentPage() {
  const params = useParams();
  const supplyId = typeof params.id === "string" ? params.id : "";
  const documentId = typeof params.documentId === "string" ? params.documentId : "";
  const router = useRouter();
  const { profile, profileLoading } = useProfile();
  const allowed = canAccessProductSupplies(profile?.role);

  useEffect(() => {
    if (!profileLoading && profile && !allowed) {
      router.replace("/staff");
    }
  }, [profile, profileLoading, allowed, router]);

  if (!allowed) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-neutral-500">Загрузка...</p>
      </div>
    );
  }

  if (!supplyId || !documentId) {
    return <p className="text-sm text-neutral-500">Документ не найден</p>;
  }

  return <SupplyDocumentViewer supplyId={supplyId} documentId={documentId} />;
}
