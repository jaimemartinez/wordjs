"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, EmptyState, StatusBadge } from "@/components/ui";

export default function PagesPage() {
    const { t } = useI18n();
    const { confirm } = useModal();
    const [pages, setPages] = useState<Post[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPages();
    }, []);

    const loadPages = async () => {
        try {
            const data = await postsApi.list("page", "any");
            setPages(data);
        } catch (error) {
            console.error("Failed to load pages:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id: number) => {
        if (!await confirm(t('pages.delete.message'), t('pages.delete.title'), true)) return;
        try {
            await postsApi.delete(id);
            setPages((prevPages) => prevPages.filter((p) => p.id !== id));
        } catch (error) {
            console.error("Failed to delete page:", error);
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">

            {/* Premium Header */}
            <PageHeader
                title={t('pages.title')}
                subtitle="Manage your static pages"
                actions={
                    <Link href="/admin/pages/new">
                        <Button icon="fa-plus">{t('pages.new')}</Button>
                    </Link>
                }
            />

            {/* Premium Table Container */}
            <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                    </div>
                ) : pages.length === 0 ? (
                    <EmptyState
                        icon="fa-file-lines"
                        title={t('pages.not.found')}
                        description={t('no.pages.desc') || 'Create your first page to get started.'}
                        action={
                            <Link href="/admin/pages/new">
                                <Button icon="fa-plus">{t('pages.new')}</Button>
                            </Link>
                        }
                    />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                    <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('posts.title.field')}
                                    </th>
                                    <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('posts.status')}
                                    </th>
                                    <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('posts.date')}
                                    </th>
                                    <th className="px-8 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">
                                        {t('actions')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {pages.map((page) => (
                                    <tr key={page.id} className="group hover:bg-indigo-50/5 transition-colors">
                                        <td className="px-8 py-6">
                                            <Link
                                                href={`/admin/pages/${page.id}`}
                                                className="block"
                                            >
                                                <span className="text-lg font-bold text-gray-700 group-hover:text-indigo-600 transition-colors line-clamp-1 italic tracking-tight">
                                                    {page.title}
                                                </span>
                                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider group-hover:text-indigo-400 transition-colors">
                                                    ID: {page.id}
                                                </span>
                                            </Link>
                                        </td>
                                        <td className="px-8 py-6">
                                            <StatusBadge
                                                status={page.status === "publish" ? "published" : page.status}
                                                label={page.status === "publish" ? t('posts.published') : page.status === "draft" ? t('posts.draft') : page.status}
                                            />
                                        </td>
                                        <td className="px-8 py-6">
                                            <span className="text-sm font-bold text-gray-500">
                                                {new Date(page.date).toLocaleDateString()}
                                            </span>
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity translate-x-4 group-hover:translate-x-0 duration-300">
                                                <Link
                                                    href={`/admin/pages/${page.id}`}
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-indigo-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-indigo-200"
                                                    title={t('edit')}
                                                >
                                                    <i className="fa-solid fa-pen text-xs"></i>
                                                </Link>
                                                <button
                                                    onClick={() => handleDelete(page.id)}
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-red-200"
                                                    title={t('delete')}
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
        </div>
    );
}
