"use client";

import { useEffect, useState } from "react";
import { formatPrice } from "@/lib/formatPrice";
import { getClientOrderPaymentSummary } from "@/lib/clientPayments";
import type { ClientOrderPaymentSummary } from "@/types/database";
import { ORDER_PAYMENT_STATUS_LABELS } from "@/types/database";

type Props = {
  orderId: string;
};

/**
 * Client-safe payment totals only — no staff comments, references, or reversal details.
 */
export function ClientOrderPaymentSummaryBlock({ orderId }: Props) {
  const [summary, setSummary] = useState<ClientOrderPaymentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;

    getClientOrderPaymentSummary(orderId)
      .then((result) => {
        if (ignore) {
          return;
        }
        setSummary(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ignore) {
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить сводку оплаты",
        );
        setSummary(null);
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

  if (loading) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
        <p className="mt-3 text-sm text-neutral-500">Загрузка...</p>
      </section>
    );
  }

  if (error || !summary) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
        <p className="mt-3 text-sm text-neutral-500">
          Сводка оплаты временно недоступна.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-neutral-800">Оплата</h2>
      {summary.invoice_number && (
        <p className="mt-1 text-sm text-neutral-500">
          По счёту {summary.invoice_number}
        </p>
      )}
      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            К оплате
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(summary.amount_due)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Оплачено
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(summary.amount_paid)}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Осталось
          </dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums text-neutral-900">
            {formatPrice(Math.max(summary.amount_remaining, 0))}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Статус
          </dt>
          <dd className="mt-1 text-lg font-semibold text-neutral-900">
            {ORDER_PAYMENT_STATUS_LABELS[summary.payment_status]}
          </dd>
        </div>
      </dl>
    </section>
  );
}
