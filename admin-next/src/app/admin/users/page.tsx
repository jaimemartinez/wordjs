"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usersApi, User } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/contexts/I18nContext";

export default function UsersPage() {
    const { t } = useI18n();
    const searchParams = useSearchParams();
    const type = searchParams.get("type"); // subscribers
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);

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
        if (!confirm(t('users.delete.confirm'))) return;
        try {
            await usersApi.delete(id);
            setUsers(users.filter(u => u.id !== id));
        } catch (error) {
            console.error("Failed to delete user:", error);
            alert(t('users.delete.failed'));
        }
    };

    return (
        <div className="p-6 h-full overflow-auto">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800 capitalize">
                    {type === "subscribers" ? t('users.subscribers') : t('users.team.members')}
                </h1>
                <Link
                    href="/admin/users/new"
                    className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                >
                    <i className="fa-solid fa-plus"></i> {t('users.new')}
                </Link>
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-gray-500">{t('loading')}</div>
                ) : (
                    <table className="w-full">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('users.title')}</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('users.email')}</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('users.role')}</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">{t('actions')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {users.map((user) => (
                                <tr key={user.id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4 flex items-center gap-3">
                                        <div className="w-10 h-10 bg-purple-500 rounded-full flex items-center justify-center text-white font-bold">
                                            {user.displayName?.[0]?.toUpperCase() || user.username[0]?.toUpperCase()}
                                        </div>
                                        <div>
                                            <div className="font-medium text-gray-800">
                                                <Link href={`/admin/users/${user.id}`} className="hover:text-purple-600 hover:underline">
                                                    {user.displayName || user.username}
                                                </Link>
                                            </div>
                                            <div className="text-sm text-gray-500">@{user.username}</div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">{user.email}</td>
                                    <td className="px-6 py-4">
                                        <span className="px-2 py-1 text-xs rounded-full bg-blue-100 text-blue-800 capitalize">
                                            {user.role}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <Link
                                            href={`/admin/users/${user.id}`}
                                            className="text-blue-600 hover:text-blue-800 mr-4"
                                            title={t('users.edit')}
                                        >
                                            <i className="fa-solid fa-pen"></i>
                                        </Link>
                                        <button
                                            onClick={() => handleDelete(user.id)}
                                            className="text-red-600 hover:text-red-800"
                                            title="Delete"
                                        >
                                            <i className="fa-solid fa-trash"></i>
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
