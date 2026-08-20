"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { mediaApi, MediaItem, MediaListOptions } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import MSym from "./editor/MSym";

/* -------------------------------------------------------------------------------------------------
 * Shared media-library logic
 *
 * Both media screens (this picker and /admin/media) used to call `mediaApi.list()` with NO query
 * string: the endpoint has always paged (per_page defaults to 20), so they received the first 20 rows
 * and then filtered THAT truncated array client-side — a library of 500 files silently showed 20 and
 * the search box could never find anything past them.
 *
 * The pure pieces of the fix (query building, page maths, the metadata diff sent to PUT /media/:id)
 * live here as exported helpers so they can be unit-tested without a DOM, following the same
 * helpers-exported-from-the-component convention as ContentTable (STATUS_TABS / statusBadgeView).
 * ------------------------------------------------------------------------------------------------ */

/** Rows per page in the picker grid (5 columns × ~5 rows). */
export const SELECTOR_PAGE_SIZE = 25;
/** Rows per page in the full media library screen (6 columns × 4 rows). */
export const LIBRARY_PAGE_SIZE = 24;
/** The backend caps per_page at 100 (backend/src/routes/media.ts); asking for more silently returns 100. */
export const MAX_PER_PAGE = 100;

export interface MediaQueryState {
    page: number;
    perPage: number;
    /** Free text; blank/whitespace means "no search" and must NOT be sent as an empty param. */
    search?: string;
    /**
     * MIME family or exact type ("image", "image/", "application/pdf").
     *
     * El servidor lo HONRA: `GET /media` lo pasa a `Media.findAll` Y a `Media.count`, y
     * `Post.buildWhere` decide entre `=` (tipo completo) y `LIKE 'familia/%'`. Se manda a las dos
     * consultas a propósito — filtrar sólo las filas dejaría el total contando la biblioteca entera y
     * el paginador ofreciendo páginas vacías.
     */
    mimeType?: string;
}

const positiveInt = (value: number, fallback: number): number => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * The exact query the media list endpoint understands. Blank search / mimeType are omitted rather
 * than sent empty (an empty `search=` would still be truthy server-side in some drivers), and
 * perPage is clamped to the server's own cap so the page maths below agree with the server's totals.
 */
export function buildMediaQuery(state: MediaQueryState): MediaListOptions {
    const search = (state.search || "").trim();
    const mimeType = (state.mimeType || "").trim();
    const query: MediaListOptions = {
        page: positiveInt(state.page, 1),
        perPage: Math.min(positiveInt(state.perPage, 20), MAX_PER_PAGE),
    };
    if (search) query.search = search;
    if (mimeType) query.mimeType = mimeType;
    return query;
}

/**
 * Keep the requested page inside [1, totalPages]. Needed because the page number outlives the result
 * set: narrowing the search or deleting the last item of the last page leaves the UI pointing past
 * the end, where the server honestly returns an empty array and the grid looks broken.
 */
export function clampPage(page: number, totalPages: number): number {
    const max = positiveInt(totalPages, 1);
    return Math.min(max, positiveInt(page, 1));
}

/** The 1-based row range this page shows, for the "1–24 de 137" counter. Empty library → 0–0 of 0. */
export function pageRange(page: number, perPage: number, total: number): { from: number; to: number; total: number } {
    const size = positiveInt(perPage, 20);
    const count = Math.max(0, Math.floor(Number(total)) || 0);
    if (count === 0) return { from: 0, to: 0, total: 0 };
    const first = (positiveInt(page, 1) - 1) * size + 1;
    if (first > count) return { from: count, to: count, total: count };
    return { from: first, to: Math.min(count, first + size - 1), total: count };
}

/**
 * The four fields `PUT /media/:id` accepts. The list endpoint already returns all of them
 * (backend Media.formatAttachment), but the shared `MediaItem` type only declares `title`.
 */
export interface MediaMetaFields {
    title: string;
    description: string;
    caption: string;
    alt: string;
}

/** A media row with the metadata the detail panel edits. */
export type EditableMediaItem = MediaItem & Partial<Omit<MediaMetaFields, "title">>;

/** The editable metadata of an item, with every field a defined string (so inputs stay controlled). */
export function mediaMetaOf(item: EditableMediaItem): MediaMetaFields {
    return {
        title: item.title || "",
        description: item.description || "",
        caption: item.caption || "",
        alt: item.alt || "",
    };
}

/**
 * Only the fields the user actually changed. `Media.update` keys off `!== undefined`, so sending the
 * untouched ones back is a needless write — and, between two editors, an overwrite of a field this
 * user never looked at.
 */
export function mediaMetaPayload(original: MediaMetaFields, draft: MediaMetaFields): Partial<MediaMetaFields> {
    const payload: Partial<MediaMetaFields> = {};
    (Object.keys(original) as (keyof MediaMetaFields)[]).forEach((key) => {
        if (draft[key] !== original[key]) payload[key] = draft[key];
    });
    return payload;
}

/** True when there is something to save (an empty payload must not fire a request). */
export function hasMediaMetaChanges(original: MediaMetaFields, draft: MediaMetaFields): boolean {
    return Object.keys(mediaMetaPayload(original, draft)).length > 0;
}

/**
 * Thumbnail URL for a grid tile.
 *
 * Preview from the RELATIVE sourceUrl, NOT guid: guid embeds the upload-time host/IP (e.g.
 * https://192.168.1.11:3000/...), so browsing from another origin (localhost / the real domain) makes
 * the thumbnail 404 / fail the cert check and the tile renders blank. sourceUrl is origin-relative
 * and always loads.
 */
export function mediaThumbnailUrl(item: MediaItem): string {
    const base = item.sourceUrl || item.guid || "";
    const thumb = item.mediaDetails?.sizes?.thumbnail?.file;
    if (!thumb) return base;
    const slash = base.lastIndexOf("/");
    if (slash < 0) return base;
    return base.substring(0, slash + 1) + thumb;
}

/* ---------------------------------------------------------------------------------------------- */

interface MediaLibrarySelectorProps {
    onSelect: (item: MediaItem) => void;
    selectedId?: number | null;
}

/** Matches ContentTable's search debounce, so typing does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 400;

export default function MediaLibrarySelector({ onSelect, selectedId }: MediaLibrarySelectorProps) {
    const { t } = useI18n();
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [refreshKey, setRefreshKey] = useState(0);
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Debounce the search box → the `search` value that actually queries the SERVER (the old
    // client-side .filter() only ever saw the first page).
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => {
            setSearch(searchInput.trim());
            setPage(1);
        }, SEARCH_DEBOUNCE_MS);
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    }, [searchInput]);

    const loadMedia = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const res = await mediaApi.listPaged(buildMediaQuery({ page, perPage: SELECTOR_PAGE_SIZE, search }));
            setMedia(res.data);
            setTotal(res.total);
            setTotalPages(res.totalPages);
            const safe = clampPage(page, res.totalPages);
            if (safe !== page) setPage(safe);
        } catch (error) {
            console.error("Failed to load media:", error);
            setMedia([]);
            setTotal(0);
            setTotalPages(1);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
        // `refreshKey` is intentionally a dependency: bumping it is how the refresh button re-runs
        // this exact query. eslint cannot see that, since the value is never read in the body.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, search, refreshKey]);

    useEffect(() => { loadMedia(); }, [loadMedia]);

    const range = pageRange(page, SELECTOR_PAGE_SIZE, total);

    return (
        <div className="flex flex-col h-full min-h-0 bg-[var(--ed-surface-container-lowest)] sm:rounded-xl overflow-hidden">
            {/* Toolbar */}
            <div className="p-3 sm:p-4 border-b border-[var(--ed-outline-variant)] flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 bg-[var(--ed-surface-container-low)]">
                <label htmlFor="media-library-search" className="sr-only">{t('media.search')}</label>
                <input
                    id="media-library-search"
                    type="text"
                    inputMode="search"
                    autoComplete="off"
                    placeholder={t('media.search')}
                    className="min-h-11 px-3 border border-[var(--ed-outline-variant)] rounded-xl text-sm w-full sm:max-w-sm bg-[var(--ed-surface-container-lowest)] text-[var(--ed-on-surface)] placeholder:text-[var(--ed-outline)]"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                />
                <div className="flex items-center justify-between sm:justify-end gap-3">
                    {total > 0 && (
                        <span className="text-xs font-medium text-[var(--ed-on-surface-variant)] whitespace-nowrap" aria-live="polite">
                            {range.from}–{range.to} de {range.total}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => setRefreshKey((k) => k + 1)}
                        disabled={loading}
                        className="verso-icon-button w-11 h-11 rounded-xl flex items-center justify-center text-[var(--ed-on-surface-variant)] hover:bg-[var(--ed-surface-container-high)] hover:text-[var(--ed-primary)] disabled:opacity-40 transition-colors"
                        title={t('common.refresh')}
                        aria-label={t('common.refresh')}
                    >
                        <MSym name="refresh" size={20} className={loading ? "animate-spin" : ""} />
                    </button>
                </div>
            </div>

            {/* Grid */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-4 custom-scrollbar">
                {loading ? (
                    <div role="status" aria-label={t('common.loading')} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                        {Array.from({ length: 10 }, (_, i) => (
                            <div key={i} className="aspect-square rounded-xl bg-[var(--ed-surface-container)] animate-pulse" aria-hidden="true" />
                        ))}
                    </div>
                ) : loadError ? (
                    <div role="alert" className="min-h-64 flex flex-col items-center justify-center gap-3 text-center text-[var(--ed-on-surface-variant)]">
                        <span className="w-12 h-12 rounded-2xl bg-[var(--ed-error-container)] text-[var(--ed-on-error-container)] flex items-center justify-center"><MSym name="info" size={24} /></span>
                        <p className="text-sm font-medium text-[var(--ed-on-surface)]">{t('media.load.failed')}</p>
                        <button type="button" onClick={loadMedia} className="min-h-11 px-4 rounded-xl border border-[var(--ed-outline-variant)] text-sm font-semibold hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] transition-colors">
                            {t('common.refresh')}
                        </button>
                    </div>
                ) : media.length === 0 ? (
                    <div className="min-h-64 flex flex-col items-center justify-center gap-3 text-center text-[var(--ed-on-surface-variant)]">
                        <span className="w-12 h-12 rounded-2xl bg-[var(--ed-surface-container)] flex items-center justify-center"><MSym name="image" size={24} /></span>
                        <p className="text-sm">{t('media.no.media')}</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
                        {media.map((item) => (
                            <button
                                type="button"
                                key={item.id}
                                onClick={() => onSelect(item)}
                                aria-label={`${t('media.select')}: ${item.title || `#${item.id}`}`}
                                aria-pressed={selectedId === item.id}
                                className={`
                                    group relative aspect-square min-h-0 bg-[var(--ed-surface-container)] rounded-xl overflow-hidden cursor-pointer border-2 transition-[border-color,box-shadow]
                                    ${selectedId === item.id ? 'border-[var(--ed-primary)] ring-2 ring-[var(--ed-primary-fixed)]' : 'border-transparent hover:border-[var(--ed-outline)]'}
                                `}
                            >
                                {item.mimeType.startsWith('image/') ? (
                                    <Image
                                        src={mediaThumbnailUrl(item)}
                                        alt=""
                                        fill
                                        sizes="(max-width: 639px) 50vw, (max-width: 767px) 33vw, (max-width: 1023px) 25vw, 20vw"
                                        unoptimized
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <div aria-hidden="true" className="flex items-center justify-center h-full w-full text-[var(--ed-on-surface-variant)]">
                                        <span className="px-2 text-sm font-semibold uppercase tracking-wider truncate">
                                            {item.mimeType.split("/")[1]?.split(/[+.]/)[0]?.slice(0, 8) || "file"}
                                        </span>
                                    </div>
                                )}

                                <div aria-hidden="true" className="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity flex items-center justify-center">
                                    <span className="text-white font-medium text-sm px-2 py-1 bg-black/50 rounded">{t('media.select')}</span>
                                </div>

                                {selectedId === item.id && (
                                    <div aria-hidden="true" className="absolute top-2 right-2 bg-[var(--ed-primary-solid)] text-white w-7 h-7 rounded-full flex items-center justify-center shadow-sm">
                                        <MSym name="check_circle" size={18} fill />
                                    </div>
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Pager — server-side, so the picker reaches the whole library and not just page 1. */}
            {!loading && totalPages > 1 && (
                <div className="px-3 sm:px-4 py-3 border-t border-[var(--ed-outline-variant)] bg-[var(--ed-surface-container-low)] flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page <= 1}
                        className="min-h-11 px-3 sm:px-4 rounded-xl border border-[var(--ed-outline-variant)] text-xs font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-40 transition-colors"
                    >
                        <MSym name="chevron_left" size={18} className="align-[-4px]" />{t('table.previous')}
                    </button>
                    <span className="text-[11px] font-semibold text-[var(--ed-on-surface-variant)] text-center">
                        {t('table.pageOf').replace('{page}', String(page)).replace('{total}', String(totalPages))}
                    </span>
                    <button
                        type="button"
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        disabled={page >= totalPages}
                        className="min-h-11 px-3 sm:px-4 rounded-xl border border-[var(--ed-outline-variant)] text-xs font-semibold text-[var(--ed-on-surface)] hover:border-[var(--ed-primary)] hover:text-[var(--ed-primary)] disabled:opacity-40 transition-colors"
                    >
                        {t('table.next')}<MSym name="chevron_right" size={18} className="align-[-4px]" />
                    </button>
                </div>
            )}
        </div>
    );
}
