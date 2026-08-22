"use client";

import { FormEvent, useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useProfile } from "@/context/ProfileContext";
import { USER_ROLE_LABELS } from "@/types/database";
import {
  inviteStaffUser,
  listStaffUserActivity,
  listStaffUsers,
  setStaffActive,
  updateStaffRole,
  type StaffManagedRole,
  type StaffUserActivityItem,
  type StaffUserListItem,
  type StaffUserStatusFilter,
  STAFF_MANAGED_ROLES,
} from "@/lib/staff/users";

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E] focus-visible:ring-offset-2";

const inputClass =
  `mt-1 w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 ${focusRing}`;

const EVENT_LABELS: Record<string, string> = {
  staff_invited: "Приглашение",
  staff_reinvited: "Повторное приглашение",
  staff_role_changed: "Смена роли",
  staff_activated: "Активация",
  staff_deactivated: "Отключение",
  staff_promoted: "Повышение",
  invite_failed: "Ошибка приглашения",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function StaffUsersSettingsPage() {
  const router = useRouter();
  const { profile } = useProfile();
  const isAdmin = profile?.role === "admin" && profile.is_active;

  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<StaffManagedRole | "">("");
  const [statusFilter, setStatusFilter] = useState<StaffUserStatusFilter>("all");
  const [rows, setRows] = useState<StaffUserListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<StaffUserListItem | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listStaffUsers({
        query,
        role: roleFilter,
        status: statusFilter,
      });
      setRows(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить сотрудников");
    } finally {
      setLoading(false);
    }
  }, [query, roleFilter, statusFilter]);

  useEffect(() => {
    if (profile && (profile.role !== "admin" || !profile.is_active)) {
      router.replace("/staff");
    }
  }, [profile, router]);

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(() => {
      void reload();
    }, 250);
    return () => clearTimeout(t);
  }, [isAdmin, reload]);

  if (profile && !isAdmin) {
    return (
      <div className="py-16 text-center text-sm text-neutral-500">Перенаправление...</div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-800">Настройки</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Роли, доступ и приглашения. Клиенты в этом списке не показываются.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 border-b border-neutral-200 pb-3">
            <Link
              href="/staff/settings"
              className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
            >
              Организация
            </Link>
            <span className="rounded-md bg-[#0F766E]/10 px-3 py-1.5 text-sm font-medium text-[#0F766E]">
              Сотрудники
            </span>
            <Link
              href="/staff/settings/pricing"
              className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
            >
              Цены
            </Link>
            <Link
              href="/staff/settings/catalogs"
              className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
            >
              Заводские каталоги
            </Link>
            <Link
              href="/staff/settings/data"
              className={`rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-[#0F766E] ${focusRing}`}
            >
              Управление данными
            </Link>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className={`rounded-md bg-[#0F766E] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#0c5f58] ${focusRing}`}
        >
          Пригласить сотрудника
        </button>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <label className="block text-sm text-neutral-600 sm:col-span-1">
          Поиск
          <input
            className={inputClass}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ФИО, email, телефон"
          />
        </label>
        <label className="block text-sm text-neutral-600">
          Роль
          <select
            className={inputClass}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as StaffManagedRole | "")}
          >
            <option value="">Все роли</option>
            {STAFF_MANAGED_ROLES.map((role) => (
              <option key={role} value={role}>
                {USER_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-neutral-600">
          Статус
          <select
            className={inputClass}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StaffUserStatusFilter)}
          >
            <option value="all">Все</option>
            <option value="active">Активен</option>
            <option value="inactive">Отключён</option>
          </select>
        </label>
      </div>

      {error && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">ФИО</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Роль</th>
                <th className="px-4 py-3 font-medium">Статус</th>
                <th className="px-4 py-3 font-medium">Добавлен</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                    Загрузка...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-neutral-500">
                    Сотрудники не найдены
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.profile_id}
                    className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50"
                    onClick={() => setSelected(row)}
                  >
                    <td className="px-4 py-3 font-medium text-neutral-800">{row.full_name}</td>
                    <td className="px-4 py-3 text-neutral-600">{row.email ?? "—"}</td>
                    <td className="px-4 py-3 text-neutral-600">
                      {USER_ROLE_LABELS[row.role]}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge active={row.is_active} />
                    </td>
                    <td className="px-4 py-3 text-neutral-500">{formatDate(row.created_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <StaffUserModal
          key={selected.profile_id}
          user={selected}
          currentAdminId={profile?.id ?? null}
          onClose={() => setSelected(null)}
          onChanged={async (next) => {
            setSelected(next);
            await reload();
          }}
        />
      )}

      {inviteOpen && (
        <InviteStaffModal
          onClose={() => setInviteOpen(false)}
          onInvited={async () => {
            setInviteOpen(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
        active ? "bg-[#0F766E]/10 text-[#0F766E]" : "bg-neutral-200 text-neutral-600"
      }`}
    >
      {active ? "Активен" : "Отключён"}
    </span>
  );
}

function StaffUserModal({
  user,
  currentAdminId,
  onClose,
  onChanged,
}: {
  user: StaffUserListItem;
  currentAdminId: string | null;
  onClose: () => void;
  onChanged: (next: StaffUserListItem) => Promise<void>;
}) {
  const titleId = useId();
  const [role, setRole] = useState<StaffManagedRole>(user.role);
  const [reason, setReason] = useState("");
  const [activity, setActivity] = useState<StaffUserActivityItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | {
    kind: "role" | "deactivate" | "activate";
    message: string;
    warning?: string;
  }>(null);
  const [syncedKey, setSyncedKey] = useState(
    `${user.profile_id}:${user.role}:${user.is_active}`,
  );

  const isSelf = currentAdminId === user.profile_id;

  const userKey = `${user.profile_id}:${user.role}:${user.is_active}`;
  if (syncedKey !== userKey) {
    setSyncedKey(userKey);
    setRole(user.role);
    setReason("");
    setError(null);
    setConfirm(null);
  }

  useEffect(() => {
    let ignore = false;
    listStaffUserActivity({ profileId: user.profile_id, limit: 30 })
      .then((rows) => {
        if (!ignore) setActivity(rows);
      })
      .catch(() => {
        if (!ignore) setActivity([]);
      });
    return () => {
      ignore = true;
    };
  }, [user.profile_id]);

  function requestRoleChange() {
    if (role === user.role || busy) return;

    if (user.role === "admin" && role !== "admin") {
      setConfirm({
        kind: "role",
        message: `Снять роль администратора у «${user.full_name}» и назначить «${USER_ROLE_LABELS[role]}»?`,
        warning:
          isSelf
            ? "Вы меняете свою роль администратора. Если других активных admin нет, операция будет отклонена."
            : "Нельзя снять роль последнего активного администратора.",
      });
      return;
    }

    if (role === "admin") {
      setConfirm({
        kind: "role",
        message: `Назначить «${user.full_name}» администратором?`,
        warning: "Администратор получает полный доступ к настройкам и сотрудникам.",
      });
      return;
    }

    setConfirm({
      kind: "role",
      message: `Изменить роль «${user.full_name}»: ${USER_ROLE_LABELS[user.role]} → ${USER_ROLE_LABELS[role]}?`,
    });
  }

  function requestDeactivate() {
    if (!reason.trim()) {
      setError("Укажите причину отключения");
      return;
    }
    setConfirm({
      kind: "deactivate",
      message: `Отключить доступ сотрудника «${user.full_name}»?`,
      warning:
        "Вы отключаете доступ сотрудника. История его действий сохранится." +
        (isSelf
          ? " Вы отключаете самого себя — если других активных admin нет, операция будет отклонена."
          : user.role === "admin"
            ? " Нельзя отключить последнего активного администратора."
            : ""),
    });
  }

  async function runConfirmed() {
    if (!confirm || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm.kind === "role") {
        const next = await updateStaffRole(user.profile_id, role);
        await onChanged(next);
      } else if (confirm.kind === "deactivate") {
        const next = await setStaffActive(user.profile_id, false, reason);
        await onChanged(next);
      } else {
        const next = await setStaffActive(user.profile_id, true, null);
        await onChanged(next);
      }
      setConfirm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Операция не выполнена");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-neutral-200 px-5 py-4">
          <h2 id={titleId} className="text-lg font-semibold text-neutral-800">
            {user.full_name}
          </h2>
          <p className="mt-1 text-sm text-neutral-500">{user.email ?? "Без email"}</p>
        </div>

        <div className="space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-400">Телефон</p>
              <p className="mt-0.5 text-sm text-neutral-800">{user.phone ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-400">Статус</p>
              <div className="mt-1">
                <StatusBadge active={user.is_active} />
              </div>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-400">Добавлен</p>
              <p className="mt-0.5 text-sm text-neutral-800">{formatDate(user.created_at)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-400">Текущая роль</p>
              <p className="mt-0.5 text-sm text-neutral-800">{USER_ROLE_LABELS[user.role]}</p>
            </div>
          </div>

          <div>
            <label className="block text-sm text-neutral-600">
              Изменить роль
              <select
                className={inputClass}
                value={role}
                onChange={(e) => setRole(e.target.value as StaffManagedRole)}
                disabled={busy}
              >
                {STAFF_MANAGED_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {USER_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || role === user.role}
              onClick={requestRoleChange}
              className={`mt-2 rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:border-[#0F766E] hover:text-[#0F766E] disabled:opacity-50 ${focusRing}`}
            >
              Сохранить роль
            </button>
          </div>

          <div>
            <p className="text-sm font-medium text-neutral-800">Доступ</p>
            {user.is_active ? (
              <>
                <label className="mt-2 block text-sm text-neutral-600">
                  Причина отключения *
                  <textarea
                    className={inputClass}
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={busy}
                    placeholder="Например: увольнение, смена отдела"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={requestDeactivate}
                  className={`mt-2 rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:border-red-300 disabled:opacity-50 ${focusRing}`}
                >
                  Отключить доступ
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    kind: "activate",
                    message: `Включить доступ сотрудника «${user.full_name}»?`,
                  })
                }
                className={`mt-2 rounded-md bg-[#0F766E] px-3 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-50 ${focusRing}`}
              >
                Включить доступ
              </button>
            )}
          </div>

          <div>
            <p className="text-sm font-medium text-neutral-800">История действий</p>
            <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
              {activity.length === 0 ? (
                <li className="text-sm text-neutral-500">Пока нет записей</li>
              ) : (
                activity.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2 text-sm"
                  >
                    <p className="font-medium text-neutral-800">
                      {EVENT_LABELS[item.event_type] ?? item.event_type}
                    </p>
                    <p className="text-neutral-600">{item.description ?? "—"}</p>
                    <p className="mt-1 text-xs text-neutral-400">
                      {item.created_by_name ?? "—"} · {formatDateTime(item.created_at)}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </div>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:border-neutral-300 ${focusRing}`}
          >
            Закрыть
          </button>
        </div>
      </div>

      {confirm && (
        <ConfirmModal
          title="Подтверждение"
          message={confirm.message}
          warning={confirm.warning}
          busy={busy}
          confirmLabel={busy ? "Выполнение..." : "Подтвердить"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runConfirmed()}
        />
      )}
    </div>
  );
}

function InviteStaffModal({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: () => Promise<void>;
}) {
  const titleId = useId();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffManagedRole>("manager");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const result = await inviteStaffUser({ fullName, email, role });
      setOk(
        result.reinvited
          ? "Повторное приглашение отправлено"
          : "Приглашение отправлено. Сотрудник получит письмо со ссылкой.",
      );
      await onInvited();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось пригласить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <form
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <h2 id={titleId} className="text-lg font-semibold text-neutral-800">
          Пригласить сотрудника
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Письмо отправляется только с сервера. Пароль сотрудник задаёт сам по ссылке.
        </p>

        <label className="mt-4 block text-sm text-neutral-600">
          ФИО *
          <input
            className={inputClass}
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <label className="mt-3 block text-sm text-neutral-600">
          Email *
          <input
            type="email"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={busy}
          />
        </label>
        <label className="mt-3 block text-sm text-neutral-600">
          Роль *
          <select
            className={inputClass}
            value={role}
            onChange={(e) => setRole(e.target.value as StaffManagedRole)}
            disabled={busy}
          >
            {STAFF_MANAGED_ROLES.map((r) => (
              <option key={r} value={r}>
                {USER_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        {ok && (
          <p className="mt-3 text-sm text-[#0F766E]" role="status">
            {ok}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 ${focusRing}`}
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={busy}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:bg-neutral-300 ${focusRing}`}
          >
            {busy ? "Отправка..." : "Отправить приглашение"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  warning,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  warning?: string;
  busy: boolean;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-lg font-semibold text-neutral-800">
          {title}
        </h3>
        <p className="mt-2 text-sm text-neutral-700">{message}</p>
        {warning && <p className="mt-2 text-sm text-amber-700">{warning}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={`rounded-md border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 ${focusRing}`}
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-md bg-[#0F766E] px-4 py-2 text-sm font-medium text-white hover:bg-[#0c5f58] disabled:opacity-50 ${focusRing}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
