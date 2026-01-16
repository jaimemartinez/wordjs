"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import ConfirmationModal from "@/components/ConfirmationModal";

export default function PagesPage() {
    const { t } = useI18n();
    const [pages, setPages] = useState<Post[]>([]);
    const [loading, setLoading] = useState(true);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [pageToDelete, setPageToDelete] = useState<number | null>(null);

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

    const confirmDelete = (id: number) => {
        setPageToDelete(id);
        setDeleteModalOpen(true);
    };

    const handleDelete = async () => {
        if (!pageToDelete) return;

        try {
            await postsApi.delete(pageToDelete);
            setPages((prevPages) => prevPages.filter((p) => p.id !== pageToDelete));
        } catch (error) {
            console.error("Failed to delete page:", error);
        }
    };

    return (
        <div className="p-6 h-full overflow-auto">
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={handleDelete}
                title={t('pages.delete.title')}
                message={t('pages.delete.message')}
                confirmText={t('pages.delete.confirm')}
                isDanger={true}
            />
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800">{t('pages.title')}</h1>
                <Link
                    href="/admin/pages/new"
                    className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                >
                    <i className="fa-solid fa-plus"></i> {t('pages.new')}
                </Link>
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-gray-500">{t('loading')}</div>
                ) : pages.length === 0 ? (
                    <div className="p-8 text-center text-gray-500">{t('pages.not.found')}</div>
                ) : (
                    <table className="w-full">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('posts.title.field')}</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('posts.status')}</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">{t('posts.date')}</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">{t('actions')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {pages.map((page) => (
                                <tr key={page.id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4">
                                        <Link href={`/admin/pages/${page.id}`} className="text-blue-600 hover:underline font-medium">
                                            {page.title}
                                        </Link>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-2 py-1 text-xs rounded-full ${page.status === "publish" ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}`}>
                                            {page.status === "publish" ? t('posts.published') : 
                                             page.status === "draft" ? t('posts.draft') : 
                                             page.status === "pending" ? t('posts.pending') : 
                                             page.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">{new Date(page.date).toLocaleDateString()}</td>
                                    <td className="px-6 py-4 text-right">
                                        <Link href={`/admin/pages/${page.id}`} className="text-blue-600 hover:text-blue-800 mr-4">
                                            <i className="fa-solid fa-pen"></i>
                                        </Link>
                                        <button onClick={() => confirmDelete(page.id)} className="text-red-600 hover:text-red-800">
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
