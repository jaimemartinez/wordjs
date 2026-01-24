"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usersApi, User } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, EmptyState, StatusBadge } from "@/components/ui";
import UserFormModal from "./UserFormModal";

export default function UsersPage() {
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const type = searchParams.get("type"); // subscribers
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedUser, setSelectedUser] = useState<User | "new" | null>(null);

    const { alert, confirm } = useModal();

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
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">

            <PageHeader
                title={type === "subscribers" ? t('users.subscribers') : t('users.team.members')}
                subtitle={`${users.length} ${type === "subscribers" ? "subscribers" : "team members"}`}
                actions={
                    <Button icon="fa-plus" onClick={() => setSelectedUser("new")}>{t('users.new')}</Button>
                }
            />

            {/* Premium Table Container */}
            <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                    </div>
                ) : users.length === 0 ? (
                    <EmptyState
                        icon="fa-users"
                        title={t('users.not.found') || "No users found"}
                        description="Create your first user to get started."
                        action={
                            <Button icon="fa-plus" onClick={() => setSelectedUser("new")}>{t('users.new')}</Button>
                        }
                    />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                    <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('users.title')}
                                    </th>
                                    <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('users.email')}
                                    </th>
                                    <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('users.role')}
                                    </th>
                                    <th className="px-8 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('actions')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {users.map((user) => (
                                    <tr key={user.id} className="group hover:bg-blue-50/5 transition-colors">
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-4">
                                                <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-bold text-lg shadow-lg shadow-indigo-200 group-hover:scale-110 transition-transform">
                                                    {user.displayName?.[0]?.toUpperCase() || user.username[0]?.toUpperCase()}
                                                </div>
                                                <div>
                                                    <button onClick={() => setSelectedUser(user)} className="text-left">
                                                        <span className="text-lg font-bold text-gray-700 group-hover:text-blue-600 transition-colors italic tracking-tight">
                                                            {user.displayName || user.username}
                                                        </span>
                                                    </button>
                                                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block mt-0.5">
                                                        @{user.username}
                                                    </span>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <span className="text-sm font-bold text-gray-500">{user.email}</span>
                                        </td>
                                        <td className="px-8 py-6">
                                            <StatusBadge
                                                status={user.role === "administrator" ? "success" : user.role === "editor" ? "info" : "neutral"}
                                                label={user.role}
                                            />
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity translate-x-4 group-hover:translate-x-0 duration-300">
                                                <button
                                                    onClick={() => setSelectedUser(user)}
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-blue-200"
                                                    title={t('users.edit')}
                                                >
                                                    <i className="fa-solid fa-pen text-xs"></i>
                                                </button>
                                                <button
                                                    onClick={() => handleDelete(user.id)}
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-red-200"
                                                    title="Delete"
                                                >
                                                    <i className="fa-solid fa-trash text-xs"></i>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
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
