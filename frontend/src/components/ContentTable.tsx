"use client";

/**
 * ContentTable — the shared admin list for posts & pages.
 *
 * Replaces the old fixed "first 10 items, no pager" lists with: real pagination (the backend
 * emits X-WP-Total headers via apiGetPaged), debounced search, status tabs (any is
 * privilege-scoped server-side), bulk selection + delete, and per-row View / Duplicate.
 * Drafts "View" opens the live-site draft preview (/preview/[slug], the dedicated dynamic route).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { postsApi, Post } from "@/lib/api";
import { previewHref } from "@/lib/previewHref";
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { Button, DataTable, EmptyState, Pagination, StatusBadge } from "@/components/ui";
import type { DataTableAction, DataTableColumn } from "@/components/ui";

const PER_PAGE = 20;

interface ContentTableProps {
    type: "post" | "page";
    /** Admin base path for edit links, e.g. /admin/posts */
    basePath: string;
    emptyIcon: string;
    emptyTitle: string;
    newLabel: string;
}

export const STATUS_TABS = [
    { key: "any", labelKey: "table.status.all" },
    { key: "publish", labelKey: "table.status.published" },
    { key: "future", labelKey: "table.status.scheduled" },
    { key: "draft", labelKey: "table.status.drafts" },
    { key: "pending", labelKey: "table.status.pending" },
];

/** Badge props for a row's status — 'future' (a scheduled post) renders as the "scheduled" badge. */
export function statusBadgeView(status: string, t: (k: string) => string): { status: string; label: string } {
    if (status === "publish") return { status: "published", label: t("posts.published") };
    if (status === "draft") return { status: "draft", label: t("posts.draft") };
    if (status === "future") return { status: "scheduled", label: t("posts.scheduled") || "Scheduled" };
    return { status, label: status };
}

export default function ContentTable({ type, basePath, emptyIcon, emptyTitle, newLabel }: ContentTableProps) {
    const { t } = useI18n();
    const { alert, confirm } = useModal();
    const [items, setItems] = useState<Post[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [page, setPage] = useState(1);
    const [status, setStatus] = useState("any");
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Debounce the search box → the `search` value that actually queries.
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 400);
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [searchInput]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await postsApi.listPaged({ type, status, page, perPage: PER_PAGE, search: search || undefined });
            setItems(res.data);
            setTotal(res.total);
            setTotalPages(res.totalPages);
            setSelected(new Set());
        } catch (error) {
            console.error("Failed to load content:", error);
        } finally {
            setLoading(false);
        }
    }, [type, status, page, search]);

    useEffect(() => { load(); }, [load]);

    const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const toggleAll = () => setSelected((s) => (s.size === items.length ? new Set<number>() : new Set(items.map((p) => p.id))));

    const handleDelete = async (ids: number[]) => {
        const msg = ids.length === 1 ? (t('posts.delete.message') || 'Delete this item?') : t('table.delete.many').replace('{n}', String(ids.length));
        if (!await confirm(msg, t('posts.delete.title') || 'Confirm delete', true, { confirmText: t('common.delete') })) return;
        setBusy(true);
        const failed: number[] = [];
        for (const id of ids) {
            try { await postsApi.delete(id); } catch { failed.push(id); }
        }
        setBusy(false);
        if (failed.length) await alert(t('table.delete.failed').replace('{n}', String(failed.length)));
        load();
    };

    const handleDuplicate = async (post: Post) => {
        setBusy(true);
        try {
            // Carry the full content + Puck layout over; land as a draft next to the original.
            const full = await postsApi.get(post.id);
            const created = await postsApi.create({
                title: `${full.title} (copy)`,
                content: full.content,
                excerpt: full.excerpt,
                type: full.type,
                status: "draft",
                ...(full.meta?._puck_data ? { meta: { _puck_data: full.meta._puck_data } } : {}),
            });
            if (created?.id) window.location.href = `${basePath}/${created.id}`;
            else load();
        } catch (error: any) {
            console.error("Duplicate failed:", error);
            await alert(error?.message || 'Could not duplicate.');
        } finally {
            setBusy(false);
        }
    };

    // A draft opens its preview AS ITS TYPE (lib/previewHref): a page sharing the slug must not answer for it.
    const viewHref = (p: Post) => p.status === "publish" ? `/${p.slug || p.id}` : previewHref(p.slug || p.id, p.type);

    const filtered = !!search || status !== 'any';

    const columns: DataTableColumn<Post>[] = [
        {
            key: "title",
            header: t('posts.title.field'),
            primary: true,
            cell: (post) => (
                <Link href={`${basePath}/${post.id}`} className="block min-h-11 py-1 group/title">
                    <span className="text-base md:text-lg font-bold text-gray-700 group-hover/title:text-blue-600 transition-colors line-clamp-2 italic tracking-tight">
                        {post.title || t('table.untitled')}
                    </span>
                    <span className="block text-[11px] font-bold text-gray-400 tracking-wide break-words">
                        /{post.slug || post.id}
                    </span>
                </Link>
            ),
        },
        {
            key: "author",
            header: t('posts.author'),
            showFrom: "lg",
            cell: (post) => (
                <div className="flex items-center justify-end md:justify-start gap-3">
                    <div className="w-8 h-8 shrink-0 rounded-xl bg-gray-100 hidden md:flex items-center justify-center text-xs font-bold text-gray-500" aria-hidden="true">
                        {post.author?.displayName?.[0] || 'U'}
                    </div>
                    <span className="text-sm font-bold text-gray-600">{post.author?.displayName || t('table.unknownAuthor')}</span>
                </div>
            ),
        },
        { key: "status", header: t('posts.status'), cell: (post) => <StatusBadge {...statusBadgeView(post.status, t)} /> },
        {
            key: "date",
            header: t('posts.date'),
            className: "whitespace-nowrap",
            cell: (post) => <span className="text-sm font-bold text-gray-500">{new Date(post.date).toLocaleDateString()}</span>,
        },
    ];

    const rowActions = (post: Post): DataTableAction[] => [
        { key: "edit", label: t('edit'), icon: "fa-pen", href: `${basePath}/${post.id}`, tone: "primary" },
        { key: "view", label: post.status === 'publish' ? t('common.view') : t('table.previewDraft'), icon: "fa-eye", href: viewHref(post), external: true, tone: "success" },
        { key: "duplicate", label: t('table.duplicate'), icon: "fa-copy", onClick: () => handleDuplicate(post), disabled: busy, tone: "warning", menu: true },
        { key: "delete", label: t('delete'), icon: "fa-trash", onClick: () => handleDelete([post.id]), disabled: busy, tone: "danger", menu: true },
    ];

    return (
        <div className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
            {/* Toolbar: search + status filter. Wraps on a phone instead of scrolling. */}
            <div className="px-4 sm:px-8 pt-5 pb-4 flex flex-wrap items-center gap-3 border-b border-gray-100/50 bg-gray-50/30">
                <div className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-sm">
                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs" aria-hidden="true"></i>
                    <input
                        type="search"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        placeholder={t('search') || 'Search…'}
                        aria-label={t('search') || 'Search…'}
                        className="w-full h-11 pl-10 pr-4 rounded-xl border border-gray-200 bg-white text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                    />
                </div>
                <div role="group" aria-label={t('posts.status')} className="w-full sm:w-auto flex flex-wrap items-center gap-1 bg-white border border-gray-100 rounded-xl p-1">
                    {STATUS_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            aria-pressed={status === tab.key}
                            onClick={() => { setStatus(tab.key); setPage(1); }}
                            className={`flex-auto sm:flex-none min-h-11 px-3 sm:px-4 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${status === tab.key ? 'bg-blue-600 text-white shadow' : 'text-gray-500 hover:text-gray-700'}`}
                        >
                            {t(tab.labelKey)}
                        </button>
                    ))}
                </div>
                <span className="ml-auto text-[11px] font-black text-gray-500 uppercase tracking-widest" aria-live="polite">{total} {t('table.total')}</span>
            </div>

            {/* Bulk bar */}
            {selected.size > 0 && (
                <div className="px-4 sm:px-8 py-3 bg-blue-50/60 border-b border-blue-100 flex flex-wrap items-center gap-3 animate-in fade-in duration-200">
                    <span className="text-xs font-bold text-blue-700">{selected.size} {t('table.selected')}</span>
                    <button
                        type="button"
                        onClick={() => handleDelete(Array.from(selected))}
                        disabled={busy}
                        className="min-h-11 px-4 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-50 transition-all"
                    >
                        <i className="fa-solid fa-trash mr-1.5" aria-hidden="true"></i>{t('delete') || 'Delete'}
                    </button>
                    <button type="button" onClick={() => setSelected(new Set())} className="min-h-11 px-3 text-xs font-bold text-gray-500 hover:text-gray-700">{t('table.clear')}</button>
                </div>
            )}

            {loading ? (
                <div className="p-20 text-center" role="status">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" aria-hidden="true"></div>
                    <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                </div>
            ) : items.length === 0 ? (
                <EmptyState
                    icon={filtered ? "fa-filter" : emptyIcon}
                    title={filtered ? (t('no.results') || 'Nothing matches your filters.') : emptyTitle}
                    description={filtered ? '' : (t('no.posts.desc') || 'Create your first one to get started.')}
                    action={filtered ? (
                        <Button variant="secondary" icon="fa-filter-circle-xmark" onClick={() => { setSearchInput(''); setSearch(''); setStatus('any'); setPage(1); }}>
                            {t('table.clearFilters')}
                        </Button>
                    ) : (
                        <Link href={`${basePath}/new`}>
                            <Button icon="fa-plus">{newLabel}</Button>
                        </Link>
                    )}
                />
            ) : (
                <DataTable
                    rows={items}
                    rowKey={(p) => p.id}
                    columns={columns}
                    caption={t(type === 'page' ? 'nav.pages' : 'nav.posts')}
                    actions={rowActions}
                    actionsLabel={t('actions')}
                    moreActionsLabel={t('table.moreActions')}
                    rowLabel={(p) => p.title || `#${p.id}`}
                    selectRowLabel={t('table.selectRow')}
                    selection={{ selected, onToggle: toggle, onToggleAll: toggleAll, allLabel: t('table.selectAll') }}
                />
            )}

            {!loading && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
        </div>
    );
}
