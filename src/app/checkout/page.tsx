"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { useCart } from "@/context/CartContext";
import { useOrders } from "@/context/OrderContext";
import { FULFILLMENT_LABELS } from "@/context/OrderContext";
import type { FulfillmentType } from "@/context/OrderContext";
import { OrderSummaryPanel } from "@/components/OrderSummaryPanel";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIN_PATTERN = /^\d{12}$/;

interface FormState {
  companyName: string;
  bin: string;
  contactPerson: string;
  phone: string;
  email: string;
  fulfillmentType: FulfillmentType | null;
  pickupComment: string;
  comment: string;
}

type FormErrors = Partial<
  Record<
    | "companyName"
    | "bin"
    | "contactPerson"
    | "phone"
    | "email"
    | "fulfillmentType",
    string
  >
>;

const initialFormState: FormState = {
  companyName: "",
  bin: "",
  contactPerson: "",
  phone: "",
  email: "",
  fulfillmentType: null,
  pickupComment: "",
  comment: "",
};

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.companyName.trim()) {
    errors.companyName = "Укажите наименование компании";
  }

  if (!BIN_PATTERN.test(form.bin.trim())) {
    errors.bin = "БИН должен содержать ровно 12 цифр";
  }

  if (!form.contactPerson.trim()) {
    errors.contactPerson = "Укажите контактное лицо";
  }

  if (!form.phone.trim()) {
    errors.phone = "Укажите телефон";
  }

  if (!EMAIL_PATTERN.test(form.email.trim())) {
    errors.email = "Введите корректный email";
  }

  if (!form.fulfillmentType) {
    errors.fulfillmentType = "Выберите способ получения";
  }

  return errors;
}

export default function CheckoutPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { items, totalAmount, hasUnpricedItems, clearCart } = useCart();
  const { createOrder } = useOrders();
  const [form, setForm] = useState<FormState>(initialFormState);
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!user) {
      router.replace(`/login?next=${encodeURIComponent("/checkout")}`);
    }
  }, [authLoading, user, router]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationErrors = validate(form);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    const fulfillmentType = form.fulfillmentType as FulfillmentType;

    const order = createOrder({
      companyName: form.companyName.trim(),
      bin: form.bin.trim(),
      contactPerson: form.contactPerson.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      fulfillmentType,
      pickupComment: form.pickupComment.trim(),
      comment: form.comment.trim(),
      items,
      knownTotal: totalAmount,
      hasUnpricedItems,
    });

    clearCart();
    router.push(`/order-success?orderId=${order.id}`);
  }

  if (authLoading || !user) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">
          Оформление заказа
        </h1>
        <p className="mt-4 text-neutral-600">Загрузка...</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-neutral-800">
          Оформление заказа
        </h1>
        <p className="mt-4 text-neutral-600">
          Ваша корзина пуста — добавьте товары, чтобы оформить заказ.
        </p>
        <Link
          href="/catalog"
          className={`mt-6 inline-block rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
        >
          Перейти в каталог
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <h1 className="text-3xl font-bold text-neutral-800">
        Оформление заказа
      </h1>

      <div className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_360px]">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-8">
          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Данные компании
            </h2>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Наименование компании"
                value={form.companyName}
                onChange={(value) => updateField("companyName", value)}
                error={errors.companyName}
              />
              <TextField
                label="БИН"
                value={form.bin}
                onChange={(value) => updateField("bin", value)}
                error={errors.bin}
                inputMode="numeric"
                maxLength={12}
              />
              <TextField
                label="Контактное лицо"
                value={form.contactPerson}
                onChange={(value) => updateField("contactPerson", value)}
                error={errors.contactPerson}
              />
              <TextField
                label="Телефон"
                value={form.phone}
                onChange={(value) => updateField("phone", value)}
                error={errors.phone}
                type="tel"
                inputMode="tel"
              />
              <TextField
                label="Email"
                value={form.email}
                onChange={(value) => updateField("email", value)}
                error={errors.email}
                type="email"
                inputMode="email"
                className="sm:col-span-2"
              />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Получение заказа
            </h2>
            <div className="mt-4 flex flex-wrap gap-3">
              <FulfillmentOption
                label={FULFILLMENT_LABELS.pickup}
                active={form.fulfillmentType === "pickup"}
                onClick={() => updateField("fulfillmentType", "pickup")}
              />
              <FulfillmentOption
                label={FULFILLMENT_LABELS.customer_transport}
                active={form.fulfillmentType === "customer_transport"}
                onClick={() =>
                  updateField("fulfillmentType", "customer_transport")
                }
              />
            </div>
            {errors.fulfillmentType && (
              <p className="mt-2 text-xs text-red-600">
                {errors.fulfillmentType}
              </p>
            )}

            {form.fulfillmentType === "pickup" && (
              <div className="mt-4 rounded-md bg-neutral-50 p-4 text-sm text-neutral-600">
                <p>
                  Заказ можно получить со склада DEKORO в Алматы. Точный
                  адрес и время выдачи подтвердит менеджер.
                </p>
              </div>
            )}

            {form.fulfillmentType === "customer_transport" && (
              <div className="mt-4 flex flex-col gap-4">
                <div className="rounded-md bg-neutral-50 p-4 text-sm text-neutral-600">
                  <p>
                    Вы самостоятельно организуете Газель, курьера или другую
                    машину. После подтверждения заказа сообщите менеджеру
                    данные водителя и автомобиля.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700">
                    Комментарий по забору товара
                  </label>
                  <textarea
                    value={form.pickupComment}
                    onChange={(event) =>
                      updateField("pickupComment", event.target.value)
                    }
                    rows={2}
                    placeholder="Например: заберём завтра после 14:00, данные водителя сообщим позже"
                    className={`mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
                  />
                </div>
              </div>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-800">
              Дополнительно
            </h2>
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700">
                  Комментарий к заказу
                </label>
                <textarea
                  value={form.comment}
                  onChange={(event) =>
                    updateField("comment", event.target.value)
                  }
                  rows={3}
                  className={`mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E] ${focusRing}`}
                />
              </div>
              <div className="rounded-md border border-[#0F766E]/20 bg-[#0F766E]/5 p-4">
                <p className="text-sm font-semibold text-neutral-800">
                  Оплата по счёту
                </p>
                <p className="mt-1 text-sm text-neutral-600">
                  После проверки заказа менеджер подтвердит наличие и цены и
                  сформирует счёт на оплату. Склад начнёт сборку только после
                  подтверждения 100% оплаты.
                </p>
              </div>
            </div>
          </section>

          <button
            type="submit"
            className={`self-start rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Подтвердить заказ
          </button>
        </form>

        <OrderSummaryPanel
          items={items}
          knownTotal={totalAmount}
          hasUnpricedItems={hasUnpricedItems}
          fulfillmentLabel={
            form.fulfillmentType
              ? FULFILLMENT_LABELS[form.fulfillmentType]
              : undefined
          }
        />
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  type = "text",
  inputMode,
  maxLength,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: string;
  inputMode?: "text" | "numeric" | "tel" | "email";
  maxLength?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-sm font-medium text-neutral-700">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={inputMode}
        maxLength={maxLength}
        className={`mt-1 w-full rounded-md border px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 ${
          error
            ? "border-red-300 focus:border-red-400 focus:ring-1 focus:ring-red-400"
            : "border-neutral-200 focus:border-[#0F766E] focus:ring-1 focus:ring-[#0F766E]"
        } ${focusRing}`}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function FulfillmentOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors ${focusRing} ${
        active
          ? "border-[#0F766E] bg-[#0F766E] text-white"
          : "border-neutral-200 text-neutral-600 hover:border-[#0F766E] hover:text-[#0F766E]"
      }`}
    >
      {label}
    </button>
  );
}
