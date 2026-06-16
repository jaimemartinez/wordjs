"use client";

import { useState, useEffect } from "react";
import { commentsApi, Comment } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, EmptyState } from "@/components/ui";
import { sanitizeHTML } from "@/lib/sanitize";

type Tab = 'all' | 'pending' | 'approved' | 'spam' | 'trash';

export default function CommentsPage() {
    const [comments, setComments] = useState<Comment[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<Tab>('all');
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(false);
    const { alert, confirm } = useModal();
    const { t } = useI18n();

    const PER_PAGE = 20;

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
                per_page: PER_PAGE
            });
            setComments(data);
            // A full page implies there may be more; a short page is the last one.
            setHasMore(data.length === PER_PAGE);
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
            await alert(t('comments.action.failed'));
        } finally {
            setProcessingId(null);
        }
    };

    const handleDeletePermanently = async (commentId: number) => {
        if (!await confirm(t('comments.delete.confirm'), t('comments.delete.confirmTitle'), true)) return;
        try {
            await commentsApi.delete(commentId, true); // Force delete
            loadComments();
        } catch (err) {
            console.error(err);
            await alert(t('comments.delete.failed'));
        }
    };

    const tabs: { id: Tab; label: string }[] = [
        { id: 'all', label: t('comments.tab.all') },
        { id: 'pending', label: t('comments.tab.pending') },
        { id: 'approved', label: t('comments.tab.approved') },
        { id: 'spam', label: t('comments.tab.spam') },
        { id: 'trash', label: t('comments.tab.trash') },
    ];

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t('comments.title')}
                subtitle={`${t('comments.subtitle.page')} ${page}${hasMore ? '' : ` ${t('comments.subtitle.last')}`} · ${comments.length} ${t('comments.subtitle.onThisPage')}`}
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
                        <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('comments.loading')}</p>
                    </div>
                ) : comments.length === 0 ? (
                    <EmptyState
                        icon="fa-comments"
                        title={t('comments.empty.title')}
                        description={t('comments.empty.description')}
                    />
                ) : (
                    <div className="overflow-hidden">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-64">{t('comments.column.author')}</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{t('comments.column.comment')}</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-48">{t('comments.column.inResponseTo')}</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32">{t('comments.column.date')}</th>
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
                                                    <div className="text-xs text-gray-400 mt-1">{comment.status === '0' && <span className="text-yellow-600 font-bold">{t('comments.status.pending')}</span>}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="text-sm text-gray-900 mb-2">
                                                <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(comment.content) }} />
                                            </div>
                                            {/* Actions */}
                                            <div className="flex gap-3 text-xs opacity-0 group-hover:opacity-100 transition-opacity duration-200 action-row">
                                                {comment.status === '0' && (
                                                    <button
                                                        onClick={() => handleAction(comment.id, 'approve')}
                                                        disabled={processingId === comment.id}
                                                        className="text-green-600 hover:text-green-900 font-medium"
                                                    >
                                                        {t('comments.approve')}
                                                    </button>
                                                )}
                                                {comment.status === '1' && (
                                                    <button
                                                        onClick={() => handleAction(comment.id, 'unapprove')}
                                                        disabled={processingId === comment.id}
                                                        className="text-yellow-600 hover:text-yellow-900"
                                                    >
                                                        {t('comments.unapprove')}
                                                    </button>
                                                )}

                                                {activeTab !== 'spam' && activeTab !== 'trash' && (
                                                    <>
                                                        <button
                                                            onClick={() => handleAction(comment.id, 'spam')}
                                                            disabled={processingId === comment.id}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            {t('comments.spam')}
                                                        </button>
                                                        <button
                                                            onClick={() => handleAction(comment.id, 'trash')}
                                                            disabled={processingId === comment.id}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            {t('comments.trash')}
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
                                                            {t('comments.restore')}
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeletePermanently(comment.id)}
                                                            disabled={processingId === comment.id}
                                                            className="text-red-600 hover:text-red-900"
                                                        >
                                                            {t('comments.deletePermanently')}
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
                                                {t('comments.viewPost')} #{comment.postId}
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
                        {t('comments.pagination.previous')}
                    </button>
                    <span className="text-gray-600 text-sm">{t('comments.subtitle.page')} {page}</span>
                    <button
                        disabled={!hasMore}
                        onClick={() => setPage(p => p + 1)}
                        className="px-3 py-1 border rounded hover:bg-gray-50 disabled:opacity-50"
                    >
                        {t('comments.pagination.next')}
                    </button>
                </div>
            </div>
        </div>
    );
}

