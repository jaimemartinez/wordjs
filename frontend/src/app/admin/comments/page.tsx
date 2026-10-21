"use client";

import { useState, useEffect } from "react";
import { commentsApi, Comment } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { useI18n } from "@/contexts/I18nContext";
import { PageHeader, EmptyState, DataTable, Pagination } from "@/components/ui";
import type { DataTableAction } from "@/components/ui";
import { sanitizeHTML } from "@/lib/sanitize";
import { commentActions, commentState, type CommentActionKey } from "@/lib/commentModeration";
import { formatServerDateTime } from "@/lib/serverDate";

type Tab = 'all' | 'pending' | 'approved' | 'spam' | 'trash';

const AVATAR_COLORS = [
    'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
    'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-teal-500',
];

function getInitials(name: string): string {
    const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) hash = (hash + name.charCodeAt(i)) % AVATAR_COLORS.length;
    return AVATAR_COLORS[hash];
}

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

    const handleAction = async (id: number, action: Exclude<CommentActionKey, 'deletePermanently'>) => {
        setProcessingId(id);
        try {
            if (action === 'approve') {
                await commentsApi.approve(id);
            } else if (action === 'spam') {
                await commentsApi.spam(id);
            } else if (action === 'trash') {
                await commentsApi.delete(id, false); // Trash
            } else {
                // Unapprove, Not spam and Restore all send the comment back to the moderation queue,
                // through the moderate_comments route (PUT needs edit_comments, which editors lack).
                await commentsApi.unapprove(id);
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
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={t('comments.title')}
                subtitle={`${t('comments.subtitle.page')} ${page}${hasMore ? '' : ` ${t('comments.subtitle.last')}`} · ${comments.length} ${t('comments.subtitle.onThisPage')}`}
            />

            {/* Premium Tabs */}
            <div role="group" aria-label={t("comments.title")} className="flex gap-2 mb-6 md:mb-8 flex-wrap">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        type="button"
                        aria-pressed={activeTab === tab.id}
                        onClick={() => { setActiveTab(tab.id); setPage(1); }}
                        className={`min-h-11 px-4 sm:px-6 py-3 rounded-2xl font-bold text-xs uppercase tracking-widest transition-all duration-300 ${activeTab === tab.id
                            ? "bg-gray-900 text-white shadow-lg shadow-gray-900/20"
                            : "bg-white text-gray-500 hover:bg-gray-50 border border-gray-100"
                            }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* List */}
            <div className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
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
                    <>
                    <DataTable
                        rows={comments}
                        rowKey={(c) => c.id}
                        caption={t('comments.title')}
                        rowLabel={(c) => c.author}
                        actionsLabel={t('actions')}
                        stackBelow="lg"
                        rowClassName={(c) => (commentState(c.status) === 'pending' ? 'bg-yellow-50/70' : '')}
                        columns={[
                            {
                                key: "author",
                                header: t('comments.column.author'),
                                primary: true,
                                className: "lg:w-64",
                                cell: (comment) => (
                                    <div className="flex items-center">
                                        {comment.authorAvatarUrl ? (
                                            <img className="h-10 w-10 shrink-0 rounded-full mr-3" src={comment.authorAvatarUrl} alt="" />
                                        ) : (
                                            <div
                                                className={`h-10 w-10 shrink-0 rounded-full mr-3 flex items-center justify-center text-white text-sm font-bold ${avatarColor(comment.author)}`}
                                                aria-hidden="true"
                                            >
                                                {getInitials(comment.author)}
                                            </div>
                                        )}
                                        <div className="min-w-0">
                                            <div className="text-sm font-bold text-gray-900 break-words">{comment.author}</div>
                                            <div className="text-xs text-gray-500 break-all">{comment.authorEmail}</div>
                                            {comment.authorUrl && (
                                                <a href={comment.authorUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline break-all">
                                                    {comment.authorUrl}
                                                </a>
                                            )}
                                            {commentState(comment.status) === 'pending' && <div className="text-xs mt-1 text-yellow-700 font-bold">{t('comments.status.pending')}</div>}
                                            {commentState(comment.status) === 'spam' && activeTab !== 'spam' && <div className="text-xs mt-1 text-red-700 font-bold">{t('comments.status.spam')}</div>}
                                        </div>
                                    </div>
                                ),
                            },
                            {
                                key: "comment",
                                header: t('comments.column.comment'),
                                className: "max-lg:!block max-lg:text-left",
                                cell: (comment) => (
                                    <div className="text-sm text-gray-900 break-words text-left max-lg:mt-1" dangerouslySetInnerHTML={{ __html: sanitizeHTML(comment.content) }} />
                                ),
                            },
                            {
                                key: "post",
                                header: t('comments.column.inResponseTo'),
                                className: "lg:w-48",
                                cell: (comment) => (
                                    <a href={`/post/${comment.postId}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center pointer-coarse:min-h-11 text-sm text-gray-600 hover:text-blue-600 hover:underline">
                                        {t('comments.viewPost')} #{comment.postId}
                                    </a>
                                ),
                            },
                            {
                                key: "date",
                                header: t('comments.column.date'),
                                className: "lg:w-40",
                                cell: (comment) => <span className="text-sm text-gray-500">{formatServerDateTime(comment.dateGmt, comment.date)}</span>,
                            },
                        ]}
                        actions={(comment) => {
                            const busy = processingId === comment.id;
                            // Derived from the comment's own state, not the tab: "All" lists every state.
                            const spec: Record<CommentActionKey, Omit<DataTableAction, 'key' | 'disabled'>> = {
                                approve: { label: t('comments.approve'), icon: "fa-check", onClick: () => handleAction(comment.id, 'approve'), tone: "success" },
                                unapprove: { label: t('comments.unapprove'), icon: "fa-rotate-left", onClick: () => handleAction(comment.id, 'unapprove'), tone: "warning" },
                                spam: { label: t('comments.spam'), icon: "fa-ban", onClick: () => handleAction(comment.id, 'spam'), tone: "warning" },
                                trash: { label: t('comments.trash'), icon: "fa-trash", onClick: () => handleAction(comment.id, 'trash'), tone: "danger" },
                                notSpam: { label: t('comments.notSpam'), icon: "fa-circle-check", onClick: () => handleAction(comment.id, 'notSpam'), tone: "success" },
                                restore: { label: t('comments.restore'), icon: "fa-trash-arrow-up", onClick: () => handleAction(comment.id, 'restore'), tone: "success" },
                                deletePermanently: { label: t('comments.deletePermanently'), icon: "fa-xmark", onClick: () => handleDeletePermanently(comment.id), tone: "danger" },
                            };
                            return commentActions(comment.status).map((key) => ({ key, ...spec[key], disabled: busy }));
                        }}
                    />
                    <Pagination page={page} hasNext={hasMore} onChange={setPage} />
                    </>
                )}
            </div>
        </div>
    );
}

