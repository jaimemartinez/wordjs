"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import ConfirmationModal from "@/components/ConfirmationModal";

export default function PostsPage() {
    const { t } = useI18n();
    const [posts, setPosts] = useState<Post[]>([]);
    const [loading, setLoading] = useState(true);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [postToDelete, setPostToDelete] = useState<number | null>(null);

    useEffect(() => {
        loadPosts();
    }, []);

    const loadPosts = async () => {
        try {
            const data = await postsApi.list("post", "any");
            setPosts(data);
        } catch (error) {
            console.error("Failed to load posts:", error);
        } finally {
            setLoading(false);
        }
    };

    const confirmDelete = (id: number) => {
        setPostToDelete(id);
        setDeleteModalOpen(true);
    };

    const handleDelete = async () => {
        if (!postToDelete) return;

        try {
            await postsApi.delete(postToDelete);
            setPosts((prevPosts) => prevPosts.filter((p) => p.id !== postToDelete));
        } catch (error) {
            console.error("Failed to delete post:", error);
            alert(t('posts.delete.failed'));
        }
    };

    return (
        <div className="p-6 h-full overflow-auto">
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={handleDelete}
                title={t('posts.delete.title')}
                message={t('posts.delete.message')}
                confirmText={t('posts.delete.confirm')}
                isDanger={true}
            />
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-2xl font-bold text-gray-800">{t('posts.title')}</h1>
                <Link
                    href="/admin/posts/new"
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-2"
                >
                    <i className="fa-solid fa-plus"></i> {t('posts.new')}
                </Link>
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
                {loading ? (
                    <div className="p-8 text-center text-gray-500">{t('loading')}</div>
                ) : posts.length === 0 ? (
                    <div className="p-8 text-center text-gray-500">{t('posts.not.found')}</div>
                ) : (
                    <table className="w-full">
                        <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    {t('posts.title.field')}
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    {t('posts.author')}
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    {t('posts.status')}
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                                    {t('posts.date')}
                                </th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                                    {t('actions')}
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {posts.map((post) => (
                                <tr key={post.id} className="hover:bg-gray-50">
                                    <td className="px-6 py-4">
                                        <Link
                                            href={`/admin/posts/${post.id}`}
                                            className="text-blue-600 hover:underline font-medium"
                                        >
                                            {post.title}
                                        </Link>
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">
                                        {post.author?.displayName || "Unknown"}
                                    </td>
                                    <td className="px-6 py-4">
                                        <span
                                            className={`px-2 py-1 text-xs rounded-full ${post.status === "publish"
                                                ? "bg-green-100 text-green-800"
                                                : "bg-yellow-100 text-yellow-800"
                                                }`}
                                        >
                                            {post.status === "publish" ? t('posts.published') : 
                                             post.status === "draft" ? t('posts.draft') : 
                                             post.status === "pending" ? t('posts.pending') : 
                                             post.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-gray-500">
                                        {new Date(post.date).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <Link
                                            href={`/admin/posts/${post.id}`}
                                            className="text-blue-600 hover:text-blue-800 mr-4"
                                        >
                                            <i className="fa-solid fa-pen"></i>
                                        </Link>
                                        <button
                                            onClick={() => confirmDelete(post.id)}
                                            className="text-red-600 hover:text-red-800"
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
