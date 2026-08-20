import {
  PRODUCT_SUPPLY_FINANCIAL_LABELS,
  PRODUCT_SUPPLY_LOGISTICS_LABELS,
  PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS,
  type ProductSupplyLogisticsStatus,
  type ProductSupplyReceivingStatus,
  type ProductSupplyStatus,
} from "@/types/database";

export default function SupplyDualStatus({
  logisticsStatus,
  financialStatus,
  receivingStatus,
}: {
  logisticsStatus: ProductSupplyLogisticsStatus;
  financialStatus: ProductSupplyStatus;
  receivingStatus: ProductSupplyReceivingStatus;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-3 py-1 text-xs font-medium text-sky-800">
        Логистика: {PRODUCT_SUPPLY_LOGISTICS_LABELS[logisticsStatus]}
      </span>
      <span
        className={
          receivingStatus === "completed"
            ? "inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800"
            : receivingStatus === "in_progress"
              ? "inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-800"
              : "inline-flex items-center gap-1.5 rounded-full bg-neutral-50 px-3 py-1 text-xs font-medium text-neutral-600"
        }
      >
        Приёмка: {PRODUCT_SUPPLY_RECEIVING_STATUS_LABELS[receivingStatus]}
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
