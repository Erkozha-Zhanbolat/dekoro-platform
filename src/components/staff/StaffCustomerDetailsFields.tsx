import type { CustomerSource, CustomerType } from "@/types/database";
import { CUSTOMER_SOURCE_LABELS, CUSTOMER_SOURCES } from "@/types/database";
import type { CustomerDetailsFormValues } from "@/lib/staff/customerDetails";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass = `w-full rounded-md border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">
      {children}
    </span>
  );
}

export function StaffCustomerDetailsFields({
  customerType,
  values,
  onChange,
  disabled = false,
}: {
  customerType: CustomerType;
  values: CustomerDetailsFormValues;
  onChange: (patch: Partial<CustomerDetailsFormValues>) => void;
  disabled?: boolean;
}) {
  const isCompany = customerType === "company";

  return (
    <>
      {isCompany ? (
        <>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Юридическое название *</FieldLabel>
            <input
              required
              disabled={disabled}
              value={values.legal_name}
              onChange={(event) => onChange({ legal_name: event.target.value })}
              className={inputClass}
              placeholder="ТОО «…»"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>БИН / ИИН *</FieldLabel>
            <input
              required
              disabled={disabled}
              value={values.iin_bin}
              onChange={(event) => onChange({ iin_bin: event.target.value })}
              className={inputClass}
              inputMode="numeric"
              placeholder="12 цифр"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Юридический адрес *</FieldLabel>
            <textarea
              required
              disabled={disabled}
              value={values.address}
              onChange={(event) => onChange({ address: event.target.value })}
              rows={2}
              className={inputClass}
              placeholder="г. Алматы, ул. Абая, 150, офис 25"
            />
            <span className="text-xs text-neutral-500">
              Адрес для счёта. Не путать с адресом доставки или складом.
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>Контактное лицо *</FieldLabel>
            <input
              required
              disabled={disabled}
              value={values.contact_person}
              onChange={(event) => onChange({ contact_person: event.target.value })}
              className={inputClass}
            />
          </label>
        </>
      ) : (
        <label className="flex flex-col gap-1.5">
          <FieldLabel>ФИО *</FieldLabel>
          <input
            required
            disabled={disabled}
            value={values.display_name}
            onChange={(event) => onChange({ display_name: event.target.value })}
            className={inputClass}
            placeholder="Иван Иванов"
          />
        </label>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Телефон *</FieldLabel>
          <input
            required
            disabled={disabled}
            value={values.phone}
            onChange={(event) => onChange({ phone: event.target.value })}
            className={inputClass}
            placeholder="+7 …"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Email *</FieldLabel>
          <input
            required
            type="email"
            disabled={disabled}
            value={values.email}
            onChange={(event) => onChange({ email: event.target.value })}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Город *</FieldLabel>
          <input
            required
            disabled={disabled}
            value={values.city}
            onChange={(event) => onChange({ city: event.target.value })}
            className={inputClass}
            placeholder="Алматы"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Источник</FieldLabel>
          <select
            disabled={disabled}
            value={values.source}
            onChange={(event) => onChange({ source: event.target.value as CustomerSource })}
            className={inputClass}
          >
            {CUSTOMER_SOURCES.map((value) => (
              <option key={value} value={value}>
                {CUSTOMER_SOURCE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <FieldLabel>Заметка</FieldLabel>
        <textarea
          disabled={disabled}
          value={values.notes}
          onChange={(event) => onChange({ notes: event.target.value })}
          rows={3}
          className={inputClass}
        />
      </label>
    </>
  );
}
