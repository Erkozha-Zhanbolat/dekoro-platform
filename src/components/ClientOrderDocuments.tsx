"use client";

import { useEffect, useState } from "react";
import {
  downloadClientOrderDocument,
  listClientOrderDocuments,
} from "@/lib/clientDocuments";
import type { ClientOrderDocumentListItem } from "@/lib/clientDocuments";
import { ORDER_DOCUMENT_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

type Props = {
  orderId: string;
};

function friendlyDocumentsError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /Could not find the function|PGRST202|function .* does not exist/i.test(
      message,
    )
  ) {
    return "Документы временно недоступны. Обновите страницу позже.";
  }
  return message || "Не удалось загрузить документы";
}

/**
 * Client documents on /orders/[id] only.
 * List = one RPC without metadata; metadata fetched only on download.
 */
export function ClientOrderDocuments({ orderId }: Props) {
  const [documents, setDocuments] = useState<ClientOrderDocumentListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    listClientOrderDocuments(orderId)
      .then((rows) => {
        if (ignore) {
          return;
        }
        setDocuments(rows);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setDocuments([]);
        setLoadError(friendlyDocumentsError(error));
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [orderId]);

  async function handleDownload(documentId: string) {
    if (busyId) {
      return;
    }
    setBusyId(documentId);
    setActionError(null);
    try {
      // Full metadata loaded only here via client_get_order_document.
      await downloadClientOrderDocument(orderId, documentId);
    } catch (error: unknown) {
      setActionError(
        error instanceof Error ? error.message : "Не удалось скачать документ",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-neutral-800">Документы</h2>

      {loading ? (
        <p className="mt-3 text-sm text-neutral-500">Загрузка документов…</p>
      ) : loadError ? (
        <p className="mt-3 text-sm text-amber-800" role="status">
          {loadError}
        </p>
      ) : documents.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">
          Документы пока не сформированы
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {documents.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => handleDownload(doc.id)}
                disabled={busyId === doc.id}
                className={`inline-flex min-h-11 items-center justify-center rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
              >
                {busyId === doc.id
                  ? "Скачивание…"
                  : `${ORDER_DOCUMENT_TYPE_LABELS[doc.document_type]} · ${doc.number}`}
              </button>
            </li>
          ))}
        </ul>
      )}

      {actionError && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
