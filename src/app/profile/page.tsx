"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useProfile } from "@/context/ProfileContext";
import { USER_ROLE_LABELS } from "@/types/database";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

export default function ProfilePage() {
  const router = useRouter();
  const { user, loading: authLoading, signOut } = useAuth();
  const { profile, company, profileLoading } = useProfile();

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  if (authLoading || (user && profileLoading)) {
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
          Войдите в личный кабинет или зарегистрируйте компанию, чтобы
          оформлять заказы и отслеживать их статус.
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

  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <h1 className="text-3xl font-bold text-neutral-800">Профиль</h1>

      <div className="mt-6 max-w-xl rounded-md border border-neutral-200 p-6">
        <dl className="flex flex-col gap-4">
          <ProfileField label="Компания" value={company?.name ?? "—"} />
          <ProfileField label="БИН" value={company?.bin ?? "—"} />
          <ProfileField label="Контактное лицо" value={profile.full_name} />
          <ProfileField label="Телефон" value={profile.phone ?? "—"} />
          <ProfileField label="Email" value={user.email ?? "—"} />
          <ProfileField label="Роль" value={USER_ROLE_LABELS[profile.role]} />
        </dl>
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
