"use client";

import type { ClientOrderStatusHistoryEntry, OrderStatus } from "@/types/database";
import {
  CLIENT_ORDER_STATUS_LABELS,
  ORDER_WORKFLOW_STATUSES,
} from "@/types/database";

type Props = {
  currentStatus: OrderStatus;
  createdAt: string;
  history: ClientOrderStatusHistoryEntry[];
  /** When timeline RPC failed (e.g. migration not applied) — show local notice. */
  loadError?: string | null;
};

/**
 * Client timeline from real status transitions only.
 * Seeds «Создан» from order.created_at; never shows notes / staff / warehouse.
 */
export function OrderStatusTimeline({
  currentStatus,
  createdAt,
  history,
  loadError = null,
}: Props) {
  if (loadError) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-neutral-800">Статус заказа</h2>
        <p className="mt-3 text-sm text-amber-800" role="status">
          {loadError}
        </p>
        <p className="mt-2 text-sm text-neutral-600">
          Текущий статус:{" "}
          <span className="font-medium text-neutral-800">
            {CLIENT_ORDER_STATUS_LABELS[currentStatus]}
          </span>
        </p>
      </section>
    );
  }

  const steps = buildTimelineSteps(currentStatus, createdAt, history);

  return (
    <section>
      <h2 className="text-lg font-semibold text-neutral-800">Статус заказа</h2>
      <ol className="mt-4 space-y-0">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          return (
            <li key={step.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                    step.reached
                      ? step.isCancel
                        ? "bg-red-500"
                        : "bg-[#0F766E]"
                      : "bg-neutral-200"
                  }`}
                  aria-hidden
                />
                {!isLast && (
                  <span
                    className={`w-px flex-1 ${
                      step.reached && steps[index + 1]?.reached
                        ? step.isCancel || steps[index + 1]?.isCancel
                          ? "bg-red-200"
                          : "bg-[#0F766E]/40"
                        : "bg-neutral-200"
                    }`}
                    aria-hidden
                  />
                )}
              </div>
              <div className={`min-w-0 pb-5 ${isLast ? "pb-0" : ""}`}>
                <p
                  className={`text-sm font-medium ${
                    step.reached
                      ? step.isCancel
                        ? "text-red-700"
                        : "text-neutral-800"
                      : "text-neutral-400"
                  }`}
                >
                  {step.label}
                </p>
                {step.at && (
                  <time className="mt-0.5 block text-xs text-neutral-500">
                    {new Date(step.at).toLocaleString("ru-RU")}
                  </time>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type TimelineStep = {
  key: string;
  label: string;
  at: string | null;
  reached: boolean;
  isCancel: boolean;
};

function buildTimelineSteps(
  currentStatus: OrderStatus,
  createdAt: string,
  history: ClientOrderStatusHistoryEntry[],
): TimelineStep[] {
  if (currentStatus === "cancelled") {
    const cancelEntry = [...history]
      .reverse()
      .find((h) => h.to_status === "cancelled");

    const beforeCancel = history.filter((h) => h.to_status !== "cancelled");
    const steps: TimelineStep[] = [
      {
        key: "created",
        label: CLIENT_ORDER_STATUS_LABELS.new,
        at: createdAt,
        reached: true,
        isCancel: false,
      },
    ];

    for (const entry of beforeCancel) {
      if (entry.to_status === "new") {
        continue;
      }
      steps.push({
        key: entry.id,
        label: CLIENT_ORDER_STATUS_LABELS[entry.to_status],
        at: entry.created_at,
        reached: true,
        isCancel: false,
      });
    }

    steps.push({
      key: cancelEntry?.id ?? "cancelled",
      label: CLIENT_ORDER_STATUS_LABELS.cancelled,
      at: cancelEntry?.created_at ?? null,
      reached: true,
      isCancel: true,
    });

    return steps;
  }

  const reachedByTransition = new Map<OrderStatus, string>();
  for (const entry of history) {
    if (entry.to_status !== "cancelled") {
      reachedByTransition.set(entry.to_status, entry.created_at);
    }
  }

  const currentIndex = ORDER_WORKFLOW_STATUSES.indexOf(currentStatus);

  return ORDER_WORKFLOW_STATUSES.map((status, index) => {
    const reached = currentIndex >= 0 && index <= currentIndex;
    const at =
      status === "new"
        ? createdAt
        : reachedByTransition.get(status) ?? null;

    return {
      key: status,
      label: CLIENT_ORDER_STATUS_LABELS[status],
      at: reached ? at : null,
      reached,
      isCancel: false,
    };
  });
}
