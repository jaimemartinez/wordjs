"use client";

import { useEffect, useState } from "react";
import { usersApi, User } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/contexts/I18nContext";
import { plural } from "@/lib/i18n";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, EmptyState, StatusBadge, DataTable } from "@/components/ui";
import UserFormModal from "./UserFormModal";
import { useRolesMap } from "@/lib/useRoleOptions";
import { roleDisplayName, roleNameFrom } from "@/lib/roleOptions";

export default function UsersPage() {
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const type = searchParams.get("type"); // subscribers
    const isSubscribers = type === "subscribers";
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedUser, setSelectedUser] = useState<User | "new" | null>(null);

    const { alert, confirm } = useModal();
    // Role names for the Role column (GET /roles; null for a non-administrator, who sees core names / slugs).
    const roles = useRolesMap();

    useEffect(() => {
        loadUsers();
    }, [type]);

    const loadUsers = async () => {
        setLoading(true);
        try {
            const data = await usersApi.list();
            // Filter based on type
            if (type === "subscribers") {
                setUsers(data.filter(u => u.role === "subscriber"));
            } else {
                setUsers(data.filter(u => u.role !== "subscriber"));
            }
        } catch (error) {
            console.error("Failed to load users:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm(t('users.delete.confirm'), t('users.delete.title'), true)) return;
        try {
            await usersApi.delete(id);
            setUsers(users.filter(u => u.id !== id));
        } catch (error) {
            console.error("Failed to delete user:", error);
            await alert(t('users.delete.failed'));
        }
    };

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">

            <PageHeader
                title={type === "subscribers" ? t('users.subscribers') : t('users.team.members')}
                subtitle={plural(t, type === "subscribers" ? "users.count.subscribers" : "users.count.team", users.length).replace("{n}", String(users.length))}
                actions={
                    <Button icon="fa-plus" onClick={() => setSelectedUser("new")}>{t(isSubscribers ? 'users.newSubscriber' : 'users.new')}</Button>
                }
            />

            <div className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                {loading ? (
                    <div className="p-20 text-center" role="status">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" aria-hidden="true"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                    </div>
                ) : users.length === 0 ? (
                    <EmptyState
                        icon={isSubscribers ? "fa-user-group" : "fa-users"}
                        title={isSubscribers ? t('users.subscribers.empty.title') : (t('users.not.found') || "No users found")}
                        description={t(isSubscribers ? 'users.subscribers.empty.description' : 'users.empty.description')}
                        action={
                            <Button icon="fa-plus" onClick={() => setSelectedUser("new")}>{t(isSubscribers ? 'users.newSubscriber' : 'users.new')}</Button>
                        }
                    />
                ) : (
                    <DataTable
                        rows={users}
                        rowKey={(u) => u.id}
                        caption={type === "subscribers" ? t('users.subscribers') : t('users.team.members')}
                        rowLabel={(u) => u.displayName || u.username}
                        actionsLabel={t('actions')}
                        columns={[
                            {
                                key: "user",
                                header: t('users.title'),
                                primary: true,
                                cell: (user) => (
                                    <div className="flex items-center gap-4">
                                        <div className="w-11 h-11 md:w-12 md:h-12 shrink-0 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-indigo-200" aria-hidden="true">
                                            {user.displayName?.[0]?.toUpperCase() || user.username[0]?.toUpperCase()}
                                        </div>
                                        <div className="min-w-0">
                                            <button type="button" onClick={() => setSelectedUser(user)} className="text-left pointer-coarse:min-h-11">
                                                <span className="text-base md:text-lg font-bold text-gray-700 hover:text-blue-600 transition-colors italic tracking-tight break-words">
                                                    {user.displayName || user.username}
                                                </span>
                                            </button>
                                            <span className="text-[11px] font-bold text-gray-400 tracking-wider block break-words">
                                                @{user.username}
                                            </span>
                                        </div>
                                    </div>
                                ),
                            },
                            {
                                key: "email",
                                header: t('users.email'),
                                cell: (user) => <span className="text-sm font-bold text-gray-500 break-words">{user.email}</span>,
                            },
                            {
                                key: "role",
                                header: t('users.role'),
                                // The role's name (lib/roleOptions.ts roleDisplayName), not its slug:
                                // «conference_manager_team» for a plugin team member.
                                cell: (user) => (
                                    <StatusBadge
                                        status={user.role === "administrator" ? "success" : user.role === "editor" ? "info" : "neutral"}
                                        label={roleDisplayName({ role: user.role, roleName: roleNameFrom(roles, user.role) }, t)}
                                    />
                                ),
                            },
                        ]}
                        actions={(user) => [
                            { key: "edit", label: t('users.edit'), icon: "fa-pen", onClick: () => setSelectedUser(user), tone: "primary" },
                            { key: "delete", label: t('delete'), icon: "fa-trash", onClick: () => handleDelete(user.id), tone: "danger" },
                        ]}
                    />
                )}
            </div>

            {selectedUser && (
                <UserFormModal
                    user={selectedUser}
                    onClose={() => setSelectedUser(null)}
                    onSuccess={loadUsers}
                />
            )}
        </div>
    );
}
