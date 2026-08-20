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
import { useI18n } from "@/contexts/I18nContext";
import { useModal } from "@/contexts/ModalContext";
import { Button, EmptyState, StatusBadge } from "@/components/ui";

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
        if (!await confirm(msg, t('posts.delete.title') || 'Confirm delete', true)) return;
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

    const viewHref = (p: Post) => p.status === "publish" ? `/${p.slug || p.id}` : `/preview/${p.slug || p.id}`;

    return (
        <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
            {/* Toolbar: search + status tabs */}
            <div className="px-8 pt-6 pb-4 flex flex-wrap items-center gap-4 border-b border-gray-100/50 bg-gray-50/30">
                <div className="relative flex-1 min-w-[220px] max-w-sm">
                    <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 text-xs"></i>
                    <input
                        type="text"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        placeholder={t('search') || 'Search…'}
                        aria-label={t('search') || 'Search…'}
                        className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                    />
                </div>
                <div className="flex items-center gap-1 bg-white border border-gray-100 rounded-xl p-1">
                    {STATUS_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => { setStatus(tab.key); setPage(1); }}
                            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${status === tab.key ? 'bg-blue-600 text-white shadow' : 'text-gray-400 hover:text-gray-600'}`}
                        >
                            {t(tab.labelKey)}
                        </button>
                    ))}
                </div>
                <span className="ml-auto text-[10px] font-black text-gray-400 uppercase tracking-widest">{total} {t('table.total')}</span>
            </div>

            {/* Bulk bar */}
            {selected.size > 0 && (
                <div className="px-8 py-3 bg-blue-50/60 border-b border-blue-100 flex items-center gap-4 animate-in fade-in duration-200">
                    <span className="text-xs font-bold text-blue-700">{selected.size} {t('table.selected')}</span>
                    <button
                        onClick={() => handleDelete(Array.from(selected))}
                        disabled={busy}
                        className="px-4 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-50 transition-all"
                    >
                        <i className="fa-solid fa-trash mr-1.5"></i>{t('delete') || 'Delete'}
                    </button>
                    <button onClick={() => setSelected(new Set())} className="text-xs font-bold text-gray-400 hover:text-gray-600">{t('table.clear')}</button>
                </div>
            )}

            {loading ? (
                <div className="p-20 text-center">
                    <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading')}</p>
                </div>
            ) : items.length === 0 ? (
                <EmptyState
                    icon={emptyIcon}
                    title={search || status !== 'any' ? (t('no.results') || 'Nothing matches your filters.') : emptyTitle}
                    description={search || status !== 'any' ? '' : (t('no.posts.desc') || 'Create your first one to get started.')}
                    action={
                        <Link href={`${basePath}/new`}>
                            <Button icon="fa-plus">{newLabel}</Button>
                        </Link>
                    }
                />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="border-b border-gray-100/50 bg-gray-50/30">
                                <th className="pl-8 pr-2 py-6 w-10">
                                    <input type="checkbox" checked={selected.size === items.length && items.length > 0} onChange={toggleAll}
                                        aria-label={t('table.selectAll')}
                                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400" />
                                </th>
                                <th className="px-6 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('posts.title.field')}</th>
                                <th className="px-6 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('posts.author')}</th>
                                <th className="px-6 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('posts.status')}</th>
                                <th className="px-6 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('posts.date')}</th>
                                <th className="px-6 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('actions')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {items.map((post) => (
                                <tr key={post.id} className={`group transition-colors ${selected.has(post.id) ? 'bg-blue-50/40' : 'hover:bg-blue-50/5'}`}>
                                    <td className="pl-8 pr-2 py-6">
                                        <input type="checkbox" checked={selected.has(post.id)} onChange={() => toggle(post.id)}
                                            aria-label={t('table.selectRow').replace('{title}', post.title || `#${post.id}`)}
                                            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400" />
                                    </td>
                                    <td className="px-6 py-6">
                                        <Link href={`${basePath}/${post.id}`} className="block">
                                            <span className="text-lg font-bold text-gray-700 group-hover:text-blue-600 transition-colors line-clamp-1 italic tracking-tight">
                                                {post.title || '(untitled)'}
                                            </span>
                                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider group-hover:text-blue-400 transition-colors">
                                                /{post.slug || post.id}
                                            </span>
                                        </Link>
                                    </td>
                                    <td className="px-6 py-6">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-xl bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">
                                                {post.author?.displayName?.[0] || 'U'}
                                            </div>
                                            <span className="text-sm font-bold text-gray-600">{post.author?.displayName || "Unknown"}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-6">
                                        <StatusBadge {...statusBadgeView(post.status, t)} />
                                    </td>
                                    <td className="px-6 py-6">
                                        <span className="text-sm font-bold text-gray-500">{new Date(post.date).toLocaleDateString()}</span>
                                    </td>
                                    <td className="px-6 py-6 text-right">
                                        <div className="flex items-center justify-end gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity translate-x-0 md:translate-x-4 md:group-hover:translate-x-0 md:group-focus-within:translate-x-0 duration-300">
                                            <a href={viewHref(post)} target="_blank" rel="noopener noreferrer"
                                                className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-emerald-600 hover:text-white flex items-center justify-center transition-all shadow-sm"
                                                title={post.status === 'publish' ? 'View' : 'Preview draft'}>
                                                <i className="fa-solid fa-eye text-xs"></i>
                                            </a>
                                            <button onClick={() => handleDuplicate(post)} disabled={busy}
                                                className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-amber-500 hover:text-white flex items-center justify-center transition-all shadow-sm disabled:opacity-50"
                                                title="Duplicate">
                                                <i className="fa-solid fa-copy text-xs"></i>
                                            </button>
                                            <Link href={`${basePath}/${post.id}`}
                                                className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all shadow-sm"
                                                title={t('edit')}>
                                                <i className="fa-solid fa-pen text-xs"></i>
                                            </Link>
                                            <button onClick={() => handleDelete([post.id])} disabled={busy}
                                                className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm disabled:opacity-50"
                                                title={t('delete')}>
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

            {/* Pager */}
            {!loading && totalPages > 1 && (
                <div className="px-8 py-5 border-t border-gray-100/50 bg-gray-50/30 flex items-center justify-between">
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                        className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all">
                        <i className="fa-solid fa-chevron-left mr-2"></i>{t('table.previous')}
                    </button>
                    <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('table.pageOf').replace('{page}', String(page)).replace('{total}', String(totalPages))}</span>
                    <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                        className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all">
                        {t('table.next')}<i className="fa-solid fa-chevron-right ml-2"></i>
                    </button>
                </div>
            )}
        </div>
    );
}
