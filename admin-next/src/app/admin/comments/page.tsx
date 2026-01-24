"use client";

import { useState, useEffect } from "react";
import { commentsApi, Comment } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader, EmptyState } from "@/components/ui";

type Tab = 'all' | 'pending' | 'approved' | 'spam' | 'trash';

export default function CommentsPage() {
    const [comments, setComments] = useState<Comment[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<Tab>('all');
    const [page, setPage] = useState(1);
    const { alert, confirm } = useModal();

    // Actions
    const [processingId, setProcessingId] = useState<number | null>(null);

    useEffect(() => {
        loadComments();
    }, [activeTab, page]);

    const loadComments = async () => {
        setLoading(true);
        try {
            const statusMap: Record<Tab, string | undefined> = {
                all: 'any',
                pending: '0',
                approved: '1',
                spam: 'spam',
                trash: 'trash'
            };

            const data = await commentsApi.list({
                status: statusMap[activeTab],
                page,
                per_page: 20
            });
            setComments(data);
        } catch (err) {
            console.error("Failed to load comments", err);
        } finally {
            setLoading(false);
        }
    };

    const handleAction = async (id: number, action: 'approve' | 'unapprove' | 'spam' | 'trash' | 'restore') => {
        setProcessingId(id);
        try {
            if (action === 'approve') {
                await commentsApi.approve(id);
            } else if (action === 'spam') {
                await commentsApi.spam(id);
            } else if (action === 'trash') {
                await commentsApi.delete(id, false); // Trash
            } else if (action === 'restore') {
                await commentsApi.update(id, { status: '1' }); // Restore to approved
            } else if (action === 'unapprove') {
                await commentsApi.update(id, { status: '0' });
            }
            loadComments();
        } catch (err) {
            console.error(err);
            await alert("Failed to perform action");
        } finally {
            setProcessingId(null);
        }
    };

    const handleDeletePermanently = async (commentId: number) => {
        if (!await confirm("Are you sure? This action cannot be undone.", "Delete Comment Permanently", true)) return;
        try {
            await commentsApi.delete(commentId, true); // Force delete
            loadComments();
        } catch (err) {
            console.error(err);
            await alert("Failed to delete comment");
        }
    };

    const tabs: { id: Tab; label: string }[] = [
        { id: 'all', label: 'All' },
        { id: 'pending', label: 'Pending' },
        { id: 'approved', label: 'Approved' },
        { id: 'spam', label: 'Spam' },
        { id: 'trash', label: 'Trash' },
    ];

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title="Comments"
                subtitle={`${comments.length} comments`}
            />

            {/* Premium Tabs */}
            <div className="flex gap-2 mb-8 flex-wrap">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => { setActiveTab(tab.id); setPage(1); }}
                        className={`px-6 py-3 rounded-2xl font-bold text-xs uppercase tracking-widest transition-all duration-300 ${activeTab === tab.id
                            ? "bg-gray-900 text-white shadow-lg shadow-gray-900/20"
                            : "bg-white text-gray-500 hover:bg-gray-50 border border-gray-100"
                            }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* List */}
            <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                {loading ? (
                    <div className="p-20 text-center">
                        <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">Loading...</p>
                    </div>
                ) : comments.length === 0 ? (
                    <EmptyState
                        icon="fa-comments"
                        title="No comments found"
                        description="Comments will appear here when visitors interact with your content."
                    />
                ) : (
                    <div className="overflow-hidden">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-64">Author</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Comment</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-48">In Response To</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32">Date</th>
                                </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                                {comments.map((comment) => (
                                    <tr key={comment.id} className={comment.status === '0' ? 'bg-yellow-50' : ''}>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center">
                                                <img
                                                    className="h-10 w-10 rounded-full mr-3"
                                                    src={comment.authorAvatarUrl || `https://ui-avatars.com/api/?name=${comment.author}&background=random`}
                                                    alt=""
                                                />
                                                <div>
                                                    <div className="text-sm font-medium text-gray-900">{comment.author}</div>
                                                    <div className="text-xs text-gray-500">{comment.authorEmail}</div>
                                                    {comment.authorUrl && (
                                                        <a href={comment.authorUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                                                            {comment.authorUrl}
                                                        </a>
                                                    )}
                                                    <div className="text-xs text-gray-400 mt-1">{comment.status === '0' && <span className="text-yellow-600 font-bold">Pending</span>}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="text-sm text-gray-900 mb-2">
                                                <div dangerouslySetInnerHTML={{ __html: comment.content }} />
                                            </div>
                                            {/* Actions */}
                                            <div className="flex gap-3 text-xs opacity-0 group-hover:opacity-100 transition-opacity duration-200 action-row">
                                                {comment.status === '0' && (
                                                    <button
                                                        onClick={() => handleAction(comment.id, 'approve')}
                                                        disabled={processingId === comment.id}
                                                        className="text-green-600 hover:text-green-900 font-medium"
                                                    >
                                                        Approve
                                                    </button>
                                                )}
                                                {comment.status === '1' && (
                                                    <button
                                                        onClick={() => handleAction(comment.id, 'unapprove')}
                                                        disabled={processingId === comment.id}
                                                        className="text-yellow-600 hover:text-yellow-900"
                                                    >
                                                        Unapprove
                                                    </button>
                                                )}

                                                {activeTab !== 'spam' && activeTab !== 'trash' && (
                                                    <>
                                                        <button
                                                            onClick={() => handleAction(comment.id, 'spam')}
                                                            disabled={processingId === comment.id}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            Spam
                                                        </button>
                                                        <button
                                                            onClick={() => handleAction(comment.id, 'trash')}
                                                            disabled={processingId === comment.id}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            Trash
                                                        </button>
                                                    </>
                                                )}

                                                {activeTab === 'trash' && (
                                                    <>
                                                        <button
                                                            onClick={() => handleAction(comment.id, 'restore')}
                                                            disabled={processingId === comment.id}
                                                            className="text-green-600 hover:text-green-900"
                                                        >
                                                            Restore
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeletePermanently(comment.id)}
                                                            disabled={processingId === comment.id}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            Delete Permanently
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                            <style jsx>{`
                                            tr:hover .action-row { opacity: 1; }
                                        `}</style>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-500">
                                            <a href={`/post/${comment.postId}`} target="_blank" className="hover:text-blue-600 hover:underline">
                                                View Post #{comment.postId}
                                            </a>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-500">
                                            {new Date(comment.date).toLocaleString()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex justify-between items-center mt-4">
                    <button
                        disabled={page === 1}
                        onClick={() => setPage(p => p - 1)}
                        className="px-3 py-1 border rounded disabled:opacity-50"
                    >
                        Previous
                    </button>
                    <span className="text-gray-600 text-sm">Page {page}</span>
                    <button
                        onClick={() => setPage(p => p + 1)}
                        className="px-3 py-1 border rounded hover:bg-gray-50"
                    >
                        Next
                    </button>
                </div>
            </div>
        </div>
    );
}

