"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { printStaffOrderDocument } from "@/lib/staff/documents";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

/**
 * Print entry — generates PDF from metadata and opens it.
 * Bound to order via staff_get_document(order_id, document_id).
 */
export default function StaffDocumentPrintPage() {
  const params = useParams<{ id: string; documentId: string }>();
  const orderId = params.id;
  const documentId = params.documentId;
  const autoStarted = useRef(false);

  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("Формирование PDF...");
  const [error, setError] = useState<string | null>(null);

  const runPrint = useCallback(async () => {
    setStatus("working");
    setError(null);
    setMessage("Формирование PDF...");
    try {
      const result = await printStaffOrderDocument(orderId, documentId);
      setStatus("done");
      setMessage(
        result.markedPrinted
          ? `PDF ${result.document.number} сформирован. Первая печать зафиксирована.`
          : `PDF ${result.document.number} сформирован (повторная печать).`,
      );
    } catch (err: unknown) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Не удалось сформировать PDF");
    }
  }, [documentId, orderId]);

  useEffect(() => {
    if (autoStarted.current) {
      return;
    }
    autoStarted.current = true;
    void runPrint();
  }, [runPrint]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-2xl font-bold text-neutral-800">Печать документа</h1>

      {status === "working" && <p className="mt-4 text-neutral-500">{message}</p>}
      {status === "done" && <p className="mt-4 text-neutral-700">{message}</p>}
      {status === "error" && (
        <p className="mt-4 text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href={`/staff/orders/${orderId}/documents/${documentId}`}
          className={`rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          Просмотр
        </Link>
        <Link
          href={`/staff/orders/${orderId}`}
          className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
        >
          К заказу
        </Link>
        {status === "error" && (
          <button
            type="button"
            onClick={() => void runPrint()}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 ${focusRing}`}
          >
            Повторить
          </button>
        )}
      </div>
    </div>
  );
}
