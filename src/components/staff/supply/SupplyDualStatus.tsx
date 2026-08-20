import {
  PRODUCT_SUPPLY_FINANCIAL_LABELS,
  PRODUCT_SUPPLY_LOGISTICS_LABELS,
  type ProductSupplyLogisticsStatus,
  type ProductSupplyStatus,
} from "@/types/database";

export default function SupplyDualStatus({
  logisticsStatus,
  financialStatus,
}: {
  logisticsStatus: ProductSupplyLogisticsStatus;
  financialStatus: ProductSupplyStatus;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-800">
        Логистика: {PRODUCT_SUPPLY_LOGISTICS_LABELS[logisticsStatus]}
      </span>
      <span
        className={
          financialStatus === "closed"
            ? "inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700"
            : "inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800"
        }
      >
        Себестоимость: {PRODUCT_SUPPLY_FINANCIAL_LABELS[financialStatus]}
      </span>
    </div>
  );
}
