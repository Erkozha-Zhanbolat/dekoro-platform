import {
  PRODUCT_SUPPLY_COMPARISON_LABELS,
  type ProductSupplyComparisonRow,
} from "@/types/database";
import { formatSupplyRate } from "@/lib/staff/supplies";

const STATUS_CLASS: Record<string, string> = {
  match: "bg-emerald-50 text-emerald-800",
  under_shipped: "bg-amber-50 text-amber-800",
  over_shipped: "bg-orange-50 text-orange-800",
  new_in_shipment: "bg-sky-50 text-sky-800",
  missing_in_shipment: "bg-red-50 text-red-800",
  manual: "bg-neutral-100 text-neutral-600",
};

function flagLabel(flag: string): string {
  if (flag === "price_changed") return "Изменение цены";
  if (flag in PRODUCT_SUPPLY_COMPARISON_LABELS) {
    return PRODUCT_SUPPLY_COMPARISON_LABELS[flag as keyof typeof PRODUCT_SUPPLY_COMPARISON_LABELS];
  }
  return flag;
}

export default function SupplyComparisonPanel({
  rows,
}: {
  rows: ProductSupplyComparisonRow[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Пока нет сопоставления. Загрузите заказ заводу и/или накладную завода.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[960px] w-full text-left text-sm">
        <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th className="px-2 py-2 font-medium">Артикул</th>
            <th className="px-2 py-2 font-medium text-right">Заказано</th>
            <th className="px-2 py-2 font-medium text-right">Отгружено</th>
            <th className="px-2 py-2 font-medium text-right">Разница</th>
            <th className="px-2 py-2 font-medium text-right">Цена заказ</th>
            <th className="px-2 py-2 font-medium text-right">Цена факт</th>
            <th className="px-2 py-2 font-medium text-right">Отклонение</th>
            <th className="px-2 py-2 font-medium">Статус</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((row) => (
            <tr key={row.item_id}>
              <td className="px-2 py-2">
                <p className="font-medium text-neutral-800">{row.sku}</p>
                <p className="text-xs text-neutral-500">{row.name}</p>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.ordered_quantity ?? "—"}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.shipped_quantity ?? "—"}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {row.quantity_diff == null
                  ? "—"
                  : row.quantity_diff > 0
                    ? `+${row.quantity_diff}`
                    : row.quantity_diff}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatSupplyRate(row.ordered_price_per_unit)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatSupplyRate(row.shipped_price_per_unit)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatSupplyRate(row.price_diff)}
              </td>
              <td className="px-2 py-2">
                <div className="flex flex-wrap gap-1">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      STATUS_CLASS[row.status] ?? STATUS_CLASS.manual
                    }`}
                  >
                    {PRODUCT_SUPPLY_COMPARISON_LABELS[row.status]}
                  </span>
                  {row.flags
                    .filter((flag) => flag !== row.status && flag !== "match")
                    .map((flag) => (
                      <span
                        key={flag}
                        className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600"
                      >
                        {flagLabel(flag)}
                      </span>
                    ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
