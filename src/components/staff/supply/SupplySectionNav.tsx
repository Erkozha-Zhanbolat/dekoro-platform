const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export type SupplyTabId =
  | "overview"
  | "items"
  | "comparison"
  | "expenses"
  | "documents"
  | "history";

const TABS: { id: SupplyTabId; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "items", label: "Товары" },
  { id: "comparison", label: "Заказ / Отгрузка" },
  { id: "expenses", label: "Расходы" },
  { id: "documents", label: "Документы" },
  { id: "history", label: "История" },
];

export default function SupplySectionNav({
  active,
  onChange,
  counts,
}: {
  active: SupplyTabId;
  onChange: (id: SupplyTabId) => void;
  counts?: Partial<Record<SupplyTabId, number>>;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-neutral-200">
      {TABS.map((tab) => {
        const selected = tab.id === active;
        const count = counts?.[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`rounded-t-md px-3 py-2 text-sm font-medium ${focusRing} ${
              selected
                ? "border border-b-white border-neutral-200 bg-white text-[#0F766E]"
                : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {tab.label}
            {count != null ? (
              <span className="ml-1.5 text-xs text-neutral-400">{count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
