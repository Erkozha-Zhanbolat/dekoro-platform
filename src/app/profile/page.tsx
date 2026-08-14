"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useProfile } from "@/context/ProfileContext";
import { AnalyticsConsentSettings } from "@/components/AnalyticsConsentBanner";
import ClientProfileEditModal from "@/components/client/ClientProfileEditModal";
import { getMyCustomerDetails, type ClientCustomerDetails } from "@/lib/client/customer";
import { CUSTOMER_TYPE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function ProfilePage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();
  const { profile, company, profileLoading, refreshProfile } = useProfile();
  const [customer, setCustomer] = useState<ClientCustomerDetails | null>(null);
  const [customerError, setCustomerError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | undefined>(undefined);

  const isClient = profile?.role === "client";
  const fetchKey = user && isClient ? user.id : null;

  useEffect(() => {
    if (!fetchKey || loadedKey === fetchKey) {
      return;
    }

    let ignore = false;

    getMyCustomerDetails()
      .then((row) => {
        if (ignore) {
          return;
        }
        setCustomer(row);
        setCustomerError(null);
        setLoadedKey(fetchKey);
      })
      .catch((error: unknown) => {
        if (ignore) {
          return;
        }
        setCustomer(null);
        setCustomerError(
          error instanceof Error ? error.message : "Не удалось загрузить данные клиента",
        );
        setLoadedKey(fetchKey);
      });

    return () => {
      ignore = true;
    };
  }, [fetchKey, loadedKey]);

  const customerLoading = fetchKey !== null && loadedKey !== fetchKey;

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  if (authLoading || (user && profileLoading) || (user && isClient && customerLoading)) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h1 className="text-3xl font-bold text-neutral-800">Профиль</h1>
        <p className="mt-4 text-neutral-600">Загрузка...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h1 className="text-3xl font-bold text-neutral-800">Профиль</h1>
        <p className="mt-4 text-neutral-600">
          Войдите в личный кабинет или зарегистрируйтесь, чтобы оформлять
          заказы и отслеживать их статус.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/login"
            className={`rounded-md bg-[#0F766E] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Войти
          </Link>
          <Link
            href="/register"
            className={`rounded-md border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
          >
            Зарегистрироваться
          </Link>
        </div>
        <div className="mt-10 max-w-xl rounded-md border border-neutral-200 p-6">
          <AnalyticsConsentSettings />
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h1 className="text-3xl font-bold text-neutral-800">Профиль</h1>
        <p className="mt-4 text-neutral-600">
          Профиль пользователя ещё не подготовлен. Обновите страницу или
          обратитесь к администратору.
        </p>
        <button
          type="button"
          onClick={handleSignOut}
          className={`mt-6 rounded-md border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
        >
          Выйти
        </button>
      </div>
    );
  }

  const card = customer;
  const isIndividual = (card?.customer_type ?? profile.customer_type) === "individual";
  const isCompanyWithoutData =
    profile.customer_type === "company" && !card && company === null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="flex max-w-xl flex-wrap items-start justify-between gap-3">
        <h1 className="text-3xl font-bold text-neutral-800">
          {isIndividual ? "Личный профиль" : "Профиль компании"}
        </h1>
        {isClient && card && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`rounded-md bg-[#0F766E] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#0c5f58] ${focusRing}`}
          >
            Редактировать данные
          </button>
        )}
      </div>

      {customerError && (
        <p className="mt-4 max-w-xl rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {customerError}
        </p>
      )}

      {isCompanyWithoutData && (
        <p className="mt-4 max-w-xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Данные компании не найдены. Обратитесь в поддержку или заполните
          реквизиты позже.
        </p>
      )}

      {isClient && card && !card.city?.trim() && (
        <p className="mt-4 max-w-xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Укажите город — он нужен для карточки клиента и счетов.
        </p>
      )}

      {isClient && card?.customer_type === "company" && !card.address?.trim() && (
        <p className="mt-4 max-w-xl rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Укажите юридический адрес — без него автоматический счёт не сформируется.
        </p>
      )}

      <div className="mt-6 max-w-xl rounded-md border border-neutral-200 p-6">
        <dl className="flex flex-col gap-4">
          {isClient && card ? (
            isIndividual ? (
              <>
                <ProfileField label="ФИО" value={card.display_name} />
                <ProfileField label="Город" value={card.city ?? "—"} />
                <ProfileField label="Телефон" value={card.phone ?? "—"} />
                <ProfileField label="Email" value={card.email ?? user.email ?? "—"} />
                <ProfileField
                  label="Тип покупателя"
                  value={CUSTOMER_TYPE_LABELS.individual}
                />
              </>
            ) : (
              <>
                <ProfileField
                  label="Юридическое название"
                  value={card.legal_name ?? "—"}
                />
                <ProfileField label="БИН / ИИН" value={card.iin_bin ?? "—"} />
                <ProfileField label="Город" value={card.city ?? "—"} />
                <ProfileField label="Юридический адрес" value={card.address ?? "—"} />
                <ProfileField
                  label="Контактное лицо"
                  value={card.contact_person ?? "—"}
                />
                <ProfileField label="Телефон" value={card.phone ?? "—"} />
                <ProfileField label="Email" value={card.email ?? user.email ?? "—"} />
                <ProfileField label="Тип покупателя" value="ИП / ТОО" />
              </>
            )
          ) : isIndividual ? (
            <>
              <ProfileField label="Имя" value={profile.full_name} />
              <ProfileField label="Телефон" value={profile.phone ?? "—"} />
              <ProfileField label="Email" value={user.email ?? "—"} />
              <ProfileField label="Тип покупателя" value="Физическое лицо" />
            </>
          ) : (
            <>
              <ProfileField
                label="Название компании / ИП"
                value={company?.name ?? "—"}
              />
              <ProfileField label="БИН / ИИН" value={company?.bin ?? "—"} />
              <ProfileField label="Контактное лицо" value={profile.full_name} />
              <ProfileField label="Телефон" value={profile.phone ?? "—"} />
              <ProfileField label="Email" value={user.email ?? "—"} />
              <ProfileField label="Тип покупателя" value="Компания / ИП" />
            </>
          )}
        </dl>
      </div>

      {editing && card && (
        <ClientProfileEditModal
          customer={card}
          onClose={() => setEditing(false)}
          onSaved={async (updated) => {
            setCustomer(updated);
            setEditing(false);
            await refreshProfile();
          }}
        />
      )}

      <div className="mt-8 max-w-xl rounded-md border border-neutral-200 p-6">
        <AnalyticsConsentSettings />
      </div>

      <button
        type="button"
        onClick={handleSignOut}
        className={`mt-6 rounded-md border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700 transition-colors hover:border-[#0F766E] hover:text-[#0F766E] ${focusRing}`}
      >
        Выйти
      </button>
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-neutral-800">{value}</dd>
    </div>
  );
}
