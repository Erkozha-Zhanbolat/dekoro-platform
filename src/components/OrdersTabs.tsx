"use client";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export type OrdersTab = "active" | "history";

type Props = {
  activeTab: OrdersTab;
  onChange: (tab: OrdersTab) => void;
  activeCount: number;
  historyCount: number;
};

export function OrdersTabs({
  activeTab,
  onChange,
  activeCount,
  historyCount,
}: Props) {
  return (
    <div className="sticky top-0 z-10 -mx-6 border-b border-neutral-200 bg-white/95 px-6 backdrop-blur-sm">
      <div className="flex gap-1" role="tablist" aria-label="Разделы заказов">
        <TabButton
          selected={activeTab === "active"}
          onClick={() => onChange("active")}
          label="Активные"
          count={activeCount}
        />
        <TabButton
          selected={activeTab === "history"}
          onClick={() => onChange("history")}
          label="История"
          count={historyCount}
        />
      </div>
    </div>
  );
}

function TabButton({
  selected,
  onClick,
  label,
  count,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`relative flex-1 px-3 py-3.5 text-sm font-semibold transition-colors sm:flex-none sm:px-5 ${focusRing} ${
        selected
          ? "text-[#0F766E]"
          : "text-neutral-500 hover:text-neutral-800"
      }`}
    >
      {label}
      <span
        className={`ml-1.5 tabular-nums ${
          selected ? "text-[#0F766E]/60" : "text-neutral-400"
        }`}
      >
        ({count})
      </span>
      {selected && (
        <span
          className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#0F766E]"
          aria-hidden
        />
      )}
    </button>
  );
}
