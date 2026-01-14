"use client";

import { useEffect, useState } from "react";
import { postsApi, usersApi, commentsApi, Comment } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

interface Stats {
    posts: number;
    pages: number;
    comments: number;
    users: number;
}

export default function DashboardPage() {
    const { user, can } = useAuth();
    const [stats, setStats] = useState<Stats>({ posts: 0, pages: 0, comments: 0, users: 0 });
    const [recentComments, setRecentComments] = useState<Comment[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const fetchUsers = can('list_users') ? usersApi.list() : Promise.resolve([]);
            const fetchComments = can('moderate_comments') ? commentsApi.list({ per_page: 5 }) : Promise.resolve([]);

            const [posts, pages, users, comments] = await Promise.all([
                postsApi.list("post"),
                postsApi.list("page"),
                fetchUsers,
                fetchComments
            ]);

            setStats({
                posts: posts.length,
                pages: pages.length,
                comments: comments?.length || 0,
                users: users?.length || 0,
            });
            setRecentComments(Array.isArray(comments) ? comments.slice(0, 5) : []);
        } catch (error) {
            console.error("Failed to load data:", error);
        } finally {
            setLoading(false);
        }
    };

    const statCards = [
        { label: "Posts", value: stats.posts, icon: "fa-pen-to-square", color: "bg-blue-600 shadow-blue-200" },
        { label: "Pages", value: stats.pages, icon: "fa-file-lines", color: "bg-indigo-600 shadow-indigo-200" },
        { label: "Comments", value: stats.comments, icon: "fa-comments", color: "bg-amber-500 shadow-amber-200" },
        { label: "Users", value: stats.users, icon: "fa-users", color: "bg-emerald-600 shadow-emerald-200" },
    ];

    return (
        <div className="p-6 h-full overflow-auto bg-gray-50/50">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Dashboard Overview</h1>
                <div className="text-sm text-gray-500 bg-white px-3 py-1 rounded-full shadow-sm border border-gray-100 italic">
                    Welcome back, {user?.displayName || user?.username || 'User'}
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                {statCards.map((stat) => (
                    <div
                        key={stat.label}
                        className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex items-center gap-5 hover:shadow-md transition-all duration-300"
                    >
                        <div className={`${stat.color} text-white p-4 rounded-xl shadow-lg`}>
                            <i className={`fa-solid ${stat.icon} text-2xl`}></i>
                        </div>
                        <div>
                            <div className="text-3xl font-extrabold text-gray-900 leading-none mb-1">{stat.value}</div>
                            <div className="text-gray-500 text-sm font-medium uppercase tracking-wider">{stat.label}</div>
                        </div>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Quick Actions & Recent Activity Container */}
                <div className="lg:col-span-2 space-y-8">
                    {/* Quick Actions */}
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                        <h2 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                            <i className="fa-solid fa-bolt text-yellow-500"></i>
                            Quick Actions
                        </h2>
                        <div className="flex flex-wrap gap-4">
                            <a
                                href="/admin/posts/new"
                                className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl transition-all flex items-center gap-2 shadow-sm font-medium"
                            >
                                <i className="fa-solid fa-plus text-xs"></i> New Post
                            </a>
                            <a
                                href="/admin/pages/new"
                                className="bg-white border-2 border-gray-100 hover:border-blue-600 hover:text-blue-600 text-gray-600 px-6 py-2.5 rounded-xl transition-all flex items-center gap-2 font-medium"
                            >
                                <i className="fa-solid fa-file-plus text-xs"></i> New Page
                            </a>
                            <a
                                href="/admin/media"
                                className="bg-white border-2 border-gray-100 hover:border-purple-600 hover:text-purple-600 text-gray-600 px-6 py-2.5 rounded-xl transition-all flex items-center gap-2 font-medium"
                            >
                                <i className="fa-solid fa-cloud-arrow-up text-xs"></i> Add Media
                            </a>
                        </div>
                    </div>

                    {/* Recent Content Table (Placeholder for now) */}
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                        <h2 className="text-xl font-bold text-gray-900 mb-6">Recent Posts</h2>
                        <div className="text-center py-12 text-gray-400">
                            <p className="italic">Post activity visualization coming soon...</p>
                        </div>
                    </div>
                </div>

                {/* Sidebar: Recent Comments */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex flex-col h-full">
                    <h2 className="text-xl font-bold text-gray-900 mb-6 flex items-center gap-2">
                        <i className="fa-solid fa-comment-dots text-amber-500"></i>
                        Recent Comments
                    </h2>

                    {loading ? (
                        <div className="flex-1 flex items-center justify-center py-10">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
                        </div>
                    ) : recentComments.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center py-10 opacity-50">
                            <i className="fa-solid fa-comments text-4xl mb-3"></i>
                            <p className="text-sm">No activity yet</p>
                        </div>
                    ) : (
                        <div className="space-y-6 flex-1">
                            {recentComments.map((comment) => (
                                <div key={comment.id} className="group relative">
                                    <div className="flex gap-4">
                                        <div className="flex-shrink-0">
                                            <img
                                                src={comment.authorAvatarUrl || `https://ui-avatars.com/api/?name=${comment.author}&background=random`}
                                                alt=""
                                                className="w-10 h-10 rounded-xl"
                                            />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-gray-900 truncate">
                                                {comment.author}
                                            </p>
                                            <div
                                                className="text-sm text-gray-600 line-clamp-2 mt-1 italic leading-relaxed"
                                                dangerouslySetInnerHTML={{ __html: comment.content }}
                                            />
                                            <p className="text-[10px] text-gray-400 mt-2 uppercase font-bold tracking-tighter">
                                                {new Date(comment.date).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="absolute inset-0 bg-blue-50/0 group-hover:bg-blue-50/5 rounded-2xl -m-2 transition-colors cursor-pointer" onClick={() => window.location.href = '/admin/comments'} />
                                </div>
                            ))}
                        </div>
                    )}

                    <a
                        href="/admin/comments"
                        className="mt-8 text-center text-sm font-bold text-blue-600 hover:text-blue-800 transition-colors py-2 border-t border-gray-50 flex items-center justify-center gap-2"
                    >
                        View all moderation <i className="fa-solid fa-arrow-right-long text-xs"></i>
                    </a>
                </div>
            </div>
        </div>
    );
}
