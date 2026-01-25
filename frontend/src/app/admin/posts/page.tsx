"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, Button, EmptyState, StatusBadge, Card } from "@/components/ui";

export default function PostsPage() {
    const { t } = useI18n();
    const { alert, confirm } = useModal();
    const [posts, setPosts] = useState<Post[]>([]);
    const [loading, setLoading] = useState(true);

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

    const handleDelete = async (postId: number) => {
        if (!await confirm(t('posts.delete.message'), t('posts.delete.title'), true)) return;

        try {
            await postsApi.delete(postId);
            setPosts((prevPosts) => prevPosts.filter((p) => p.id !== postId));
        } catch (error) {
            console.error("Failed to delete post:", error);
            await alert(t('posts.delete.failed'));
        }
    };

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">

            {/* Premium Header */}
            <PageHeader
                title={t('posts.title')}
                subtitle="Manage your blog content"
                actions={
                    <Link href="/admin/posts/new">
                        <Button icon="fa-plus">{t('posts.new')}</Button>
                    </Link>
                }
            />

            {/* Premium Table Container */}
            <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                    </div>
                ) : posts.length === 0 ? (
                    <EmptyState
                        icon="fa-file-pen"
                        title={t('posts.not.found')}
                        description={t('no.posts.desc') || 'Create your first post to get started.'}
                        action={
                            <Link href="/admin/posts/new">
                                <Button icon="fa-plus">{t('posts.new')}</Button>
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
                                        {t('posts.author')}
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
                                {posts.map((post) => (
                                    <tr key={post.id} className="group hover:bg-blue-50/5 transition-colors">
                                        <td className="px-8 py-6">
                                            <Link
                                                href={`/admin/posts/${post.id}`}
                                                className="block"
                                            >
                                                <span className="text-lg font-bold text-gray-700 group-hover:text-blue-600 transition-colors line-clamp-1 italic tracking-tight">
                                                    {post.title}
                                                </span>
                                                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider group-hover:text-blue-400 transition-colors">
                                                    ID: {post.id}
                                                </span>
                                            </Link>
                                        </td>
                                        <td className="px-8 py-6">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-xl bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">
                                                    {post.author?.displayName?.[0] || 'U'}
                                                </div>
                                                <span className="text-sm font-bold text-gray-600">
                                                    {post.author?.displayName || "Unknown"}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-8 py-6">
                                            <StatusBadge
                                                status={post.status === "publish" ? "published" : post.status}
                                                label={post.status === "publish" ? t('posts.published') : post.status === "draft" ? t('posts.draft') : post.status}
                                            />
                                        </td>
                                        <td className="px-8 py-6">
                                            <span className="text-sm font-bold text-gray-500">
                                                {new Date(post.date).toLocaleDateString()}
                                            </span>
                                        </td>
                                        <td className="px-8 py-6 text-right">
                                            <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity translate-x-4 group-hover:translate-x-0 duration-300">
                                                <Link
                                                    href={`/admin/posts/${post.id}`}
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-blue-200"
                                                    title={t('edit')}
                                                >
                                                    <i className="fa-solid fa-pen text-xs"></i>
                                                </Link>
                                                <button
                                                    onClick={() => handleDelete(post.id)}
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
