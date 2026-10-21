"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { mediaApi } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import { plural } from "@/lib/i18n";
import ConfirmationModal from "@/components/ConfirmationModal";
import DialogLayer from "@/components/DialogLayer";
import AiSuggestion from "@/components/AiSuggest";
import { useToast } from "@/contexts/ToastContext";
import { PageHeader, Button, EmptyState, DataTable, Pagination } from "@/components/ui";
import {
    LIBRARY_PAGE_SIZE,
    buildMediaQuery,
    clampPage,
    pageRange,
    mediaMetaOf,
    mediaMetaPayload,
    hasMediaMetaChanges,
    type EditableMediaItem,
} from "@/components/MediaLibrarySelector";

const SEARCH_DEBOUNCE_MS = 400;

/**
 * Filtro por tipo de archivo. Los valores son lo que entiende `GET /media?mime_type=…`: una FAMILIA
 * ('image') filtra todo `image/*`, un tipo completo ('application/pdf') filtra exacto. '' = sin filtro.
 * Se limita a las familias que la biblioteca puede recibir de verdad (ver Media.getAllowedMimeTypes).
 */
const MIME_FILTERS: Array<{ labelKey: string; value: string }> = [
    { labelKey: "media.filter.allTypes", value: "" },
    { labelKey: "media.filter.images", value: "image" },
    { labelKey: "media.filter.video", value: "video" },
    { labelKey: "media.filter.audio", value: "audio" },
    { labelKey: "media.filter.pdf", value: "application/pdf" },
    { labelKey: "media.filter.text", value: "text" },
];

/**
 * Visibility filter. PRIVATE items live outside the public uploads folder and never appear in a public
 * listing; only people who may upload see them here (backend/src/core/private-media.ts).
 */
const VISIBILITY_FILTERS: Array<{ labelKey: string; value: "" | "public" | "private" }> = [
    { labelKey: "media.filter.anyVisibility", value: "" },
    { labelKey: "media.filter.publicOnly", value: "public" },
    { labelKey: "media.filter.privateOnly", value: "private" },
];

/** Small "Privado" badge shown on private items. */
function PrivateBadge() {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-violet-700 bg-violet-50 border border-violet-100 px-2 py-1 rounded-lg">
            <i className="fa-solid fa-lock" aria-hidden="true"></i> {t('media.private')}
        </span>
    );
}

const fieldClass =
    "w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-2xl text-sm font-medium text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all placeholder:text-gray-300";
const labelClass = "text-[11px] font-black uppercase tracking-widest text-gray-500 block mb-1.5";

/** An image without alt text is invisible until someone audits the site; the library says so. */
function MissingAltBadge() {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg">
            <i className="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> {t('media.missingAlt')}
        </span>
    );
}

/**
 * File detail panel: preview + the four metadata fields `PUT /media/:id` accepts.
 *
 * Until now nothing in the admin could call that endpoint, so `alt` — the accessibility text screen
 * readers announce, and the only description search engines get for an image — could never be set
 * after upload.
 */
function MediaDetailModal({
    item,
    onClose,
    onRequestDelete,
    onSaved,
}: {
    item: EditableMediaItem;
    onClose: () => void;
    onRequestDelete: (id: number) => void;
    onSaved: (updated: EditableMediaItem) => void;
}) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const original = useMemo(() => mediaMetaOf(item), [item]);
    const [draft, setDraft] = useState(original);
    const [saving, setSaving] = useState(false);
    const [changingVisibility, setChangingVisibility] = useState(false);
    const isPrivate = item.visibility === "private";

    // Private <-> public moves the stored files between the private store and the public uploads
    // folder on the server; it is its own request so it never mixes with an unsaved metadata draft.
    const toggleVisibility = async () => {
        setChangingVisibility(true);
        try {
            const updated = await mediaApi.update(item.id, { visibility: isPrivate ? "public" : "private" });
            onSaved(updated as EditableMediaItem);
            addToast(isPrivate ? t('media.nowPublic') : t('media.nowPrivate'), "success");
        } catch (error) {
            console.error("Failed to change media visibility:", error);
            const message = error instanceof Error && error.message ? error.message : t('media.visibilityFailed');
            addToast(message, "error");
        } finally {
            setChangingVisibility(false);
        }
    };

    // Re-seed the form when the item changes (including after a successful save, which swaps in the
    // server's own copy — the source of truth for what is now stored).
    useEffect(() => { setDraft(original); }, [original]);

    const dirty = hasMediaMetaChanges(original, draft);

    const copyUrl = () => {
        navigator.clipboard.writeText(item.sourceUrl);
        addToast(t('media.url.copied'), "success");
    };

    const handleSave = async () => {
        const payload = mediaMetaPayload(original, draft);
        if (Object.keys(payload).length === 0) return;
        setSaving(true);
        try {
            const updated = await mediaApi.update(item.id, payload);
            onSaved(updated as EditableMediaItem);
            addToast(t('media.detailsSaved'), "success");
        } catch (error) {
            console.error("Failed to update media:", error);
            // The backend answers a 403 `rest_forbidden` with a human message when the file belongs to
            // another user; show it instead of a generic error so nobody retries a denied edit.
            const message = error instanceof Error && error.message ? error.message : t('media.saveFailed');
            addToast(message, "error");
        } finally {
            setSaving(false);
        }
    };

    const setField = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value }));

    return (
        <DialogLayer className="flex items-center justify-center p-3 sm:p-6 bg-black/90 backdrop-blur-md animate-in fade-in duration-300">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div role="dialog" aria-modal="true" aria-label={item.title} className="relative bg-white rounded-3xl md:rounded-[40px] overflow-y-auto md:overflow-hidden shadow-2xl max-w-5xl w-full max-h-[calc(100dvh-1.5rem)] sm:max-h-[85dvh] flex flex-col md:flex-row animate-in zoom-in-95 duration-300">
                <div className="shrink-0 md:shrink md:flex-1 bg-gray-100/50 flex items-center justify-center p-4 sm:p-8 min-h-[200px] sm:min-h-[300px] relative">
                    <div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] opacity-50"></div>
                    {item.mimeType.startsWith('image/') ? (
                        <div className="relative w-full h-full flex items-center justify-center z-10">
                            <img
                                src={item.sourceUrl}
                                alt={item.alt || item.title}
                                className="max-w-full max-h-[40dvh] md:max-h-[60vh] object-contain shadow-2xl rounded-2xl"
                            />
                        </div>
                    ) : (
                        <i className="fa-solid fa-file text-9xl text-gray-300 relative z-10"></i>
                    )}
                </div>
                <div className="w-full md:w-[26rem] p-5 sm:p-8 bg-white md:border-l border-gray-100 flex flex-col md:h-full md:overflow-y-auto">
                    <button type="button" onClick={onClose} aria-label={t('common.close')} className="absolute top-3 right-3 sm:top-6 sm:right-6 z-20 w-11 h-11 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-900 flex items-center justify-center transition-colors">
                        <i className="fa-solid fa-xmark text-lg"></i>
                    </button>

                    <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter mb-1 pr-12 break-words" title={item.title}>
                        {item.title}
                    </h3>
                    <p className="text-[11px] font-black uppercase tracking-widest text-gray-500 mb-6">{t('media.detailsTitle')}</p>

                    {/* Editable metadata — the four fields PUT /media/:id accepts. */}
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass} htmlFor="media-title">{t('media.field.title')}</label>
                            <input id="media-title" type="text" className={fieldClass} value={draft.title} onChange={setField("title")} />
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="media-alt">{t('media.field.alt')}</label>
                            <input
                                id="media-alt"
                                type="text"
                                className={fieldClass}
                                value={draft.alt}
                                onChange={setField("alt")}
                                placeholder={t('media.field.altPlaceholder')}
                                aria-describedby="media-alt-help"
                            />
                            <p id="media-alt-help" className="text-[11px] font-medium text-gray-500 mt-1.5 leading-snug">
                                {t('media.field.altHelp')}
                            </p>
                            {/^image\/(png|jpe?g|webp|gif|avif)$/i.test(item.mimeType) && (
                                <div className="mt-2">
                                    <AiSuggestion
                                        task="alt_text"
                                        tone="admin"
                                        getInput={() => ({ mediaId: item.id })}
                                        onAccept={(s) => setDraft((d) => ({ ...d, alt: s }))}
                                    />
                                </div>
                            )}
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="media-caption">{t('media.field.caption')}</label>
                            <input id="media-caption" type="text" className={fieldClass} value={draft.caption} onChange={setField("caption")} />
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="media-description">{t('media.field.description')}</label>
                            <textarea id="media-description" rows={3} className={`${fieldClass} resize-y`} value={draft.description} onChange={setField("description")} />
                        </div>
                    </div>

                    <div className="mt-6">
                        <label className="flex items-start gap-3 cursor-pointer min-h-11">
                            <input
                                type="checkbox"
                                className="mt-1 h-5 w-5 shrink-0"
                                checked={isPrivate}
                                disabled={changingVisibility}
                                onChange={toggleVisibility}
                                aria-describedby="media-private-help"
                            />
                            <span>
                                <span className="text-sm font-bold text-gray-700">{t('media.field.private')}</span>
                                <span id="media-private-help" className="block text-[11px] font-medium text-gray-500 mt-1 leading-snug">
                                    {t('media.field.privateHelp')}
                                </span>
                            </span>
                        </label>
                    </div>

                    <div className="space-y-4 my-6">
                        <div>
                            <span className={labelClass}>{t('media.type')}</span>
                            <span className="font-bold text-gray-700 bg-gray-50 px-3 py-1 rounded-lg text-sm inline-block border border-gray-100">{item.mimeType}</span>
                        </div>
                        <div>
                            <span className={labelClass}>{t('media.uploaded')}</span>
                            <span className="font-bold text-gray-700 text-base italic">{new Date(item.date).toLocaleDateString()}</span>
                        </div>
                        <div>
                            <span className={labelClass}>URL</span>
                            <div className="bg-gray-50 rounded-xl p-3 break-all text-xs font-mono text-gray-500 select-all border border-gray-200">
                                {item.sourceUrl}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-3 mt-auto pt-6 border-t border-gray-100">
                        <Button
                            icon="fa-floppy-disk"
                            loading={saving}
                            disabled={!dirty || saving}
                            onClick={handleSave}
                            className="w-full"
                        >
                            {saving ? t('common.saving') : t('media.saveChanges')}
                        </Button>
                        <button
                            onClick={copyUrl}
                            className="w-full py-4 px-6 bg-gray-50 hover:bg-gray-100 text-gray-900 rounded-2xl transition-all font-bold flex items-center justify-center gap-3 group border border-gray-200 hover:border-gray-300"
                        >
                            <i className="fa-solid fa-copy text-gray-400 group-hover:text-gray-900 transition-colors"></i>
                            {t('media.copy.url')}
                        </button>
                        <a
                            href={item.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full py-4 px-6 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl transition-all font-bold flex items-center justify-center gap-3 shadow-xl shadow-gray-200 hover:shadow-blue-500/30 transform hover:-translate-y-1"
                        >
                            <i className="fa-solid fa-external-link-alt"></i> {t('media.open')}
                        </a>
                        <button
                            onClick={() => onRequestDelete(item.id)}
                            className="w-full py-4 px-6 bg-red-50 hover:bg-red-600 text-red-600 hover:text-white rounded-2xl transition-all font-bold flex items-center justify-center gap-3 border border-red-100 hover:border-red-600"
                        >
                            <i className="fa-solid fa-trash-can"></i> {t('common.delete')}
                        </button>
                    </div>
                </div>
            </div>
        </DialogLayer>
    );
}

export default function MediaPage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [media, setMedia] = useState<EditableMediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [searchInput, setSearchInput] = useState("");
    const [search, setSearch] = useState("");
    // Filtro por tipo. Va al SERVIDOR (no se filtra la página ya traída): filtrar aquí sólo escondería
    // filas de las 24 cargadas y el contador seguiría hablando de la biblioteca entera.
    const [mimeType, setMimeType] = useState("");
    const [visibility, setVisibility] = useState<"" | "public" | "private">("");
    // Upload the next file(s) as PRIVATE (stored outside the public uploads folder).
    const [uploadPrivate, setUploadPrivate] = useState(false);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    const [refreshKey, setRefreshKey] = useState(0);
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [previewItem, setPreviewItem] = useState<EditableMediaItem | null>(null);
    // A real <button> nested in a <label> swallows the click and never forwards it to the file input
    // (HTML: an interactive descendant cancels the label's activation behaviour), so the picker never
    // opened. Trigger the hidden input explicitly instead.
    const fileInputRef = useRef<HTMLInputElement>(null);
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Debounce the search box → the `search` value that queries the SERVER. The old code filtered the
    // first (and only) page it had fetched, so anything past row 20 was unfindable.
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
        try {
            const res = await mediaApi.listPaged(buildMediaQuery({ page, perPage: LIBRARY_PAGE_SIZE, search, mimeType, visibility: visibility || undefined }));
            setMedia(res.data);
            setTotal(res.total);
            setTotalPages(res.totalPages);
            // Deleting the last row of the last page (or narrowing the search) leaves `page` past the
            // end, where the server correctly returns nothing; step back instead of showing an empty grid.
            const safe = clampPage(page, res.totalPages);
            if (safe !== page) setPage(safe);
        } catch (error) {
            console.error("Failed to load media:", error);
            addToast(t('media.load.failed'), "error");
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, search, mimeType, visibility, refreshKey]);

    useEffect(() => { loadMedia(); }, [loadMedia]);

    const [uploadProgress, setUploadProgress] = useState(0);

    const handleFileUpload = async (files: FileList | null) => {
        if (!files || !files.length) return;

        setUploading(true);
        setUploadProgress(0);

        // Handle only first file for now, ideally loop
        const file = files[0];
        const formData = new FormData();
        formData.append("file", file);

        try {
            await mediaApi.uploadWithProgress(formData, (progress) => {
                setUploadProgress(Math.round(progress));
            }, { visibility: uploadPrivate ? "private" : "public" });
            // The upload lands newest-first on page 1, so go there and refetch.
            setPage(1);
            setRefreshKey((k) => k + 1);
            addToast(t('media.upload.success'), "success");
        } catch (error) {
            console.error("Failed to upload file:", error);
            addToast(t('media.upload.failed'), "error");
        } finally {
            setUploading(false);
            setUploadProgress(0);
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        handleFileUpload(e.target.files);
        e.target.value = ""; // Reset
    };

    // Drag and Drop
    const [isDragging, setIsDragging] = useState(false);
    const onDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);
    const onDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        // Prevent flickering: only hide if leaving the main container, not entering a child
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setIsDragging(false);
    }, []);
    const onDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        handleFileUpload(e.dataTransfer.files);
    }, []);

    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [mediaToDelete, setMediaToDelete] = useState<number | null>(null);

    const confirmDelete = (e: React.MouseEvent, id: number) => {
        e.stopPropagation(); // Prevent opening preview
        setMediaToDelete(id);
        setDeleteModalOpen(true);
    };

    const handleDelete = async () => {
        if (!mediaToDelete) return;
        try {
            await mediaApi.delete(mediaToDelete);
            if (previewItem?.id === mediaToDelete) setPreviewItem(null);
            setDeleteModalOpen(false);
            // Refetch instead of splicing locally: with paging, removing a row must pull the next
            // page's first item up, and the total must come from the server.
            setRefreshKey((k) => k + 1);
            addToast(t('common.success'), "success");
        } catch (error) {
            console.error("Failed to delete file:", error);
            addToast(t('common.error'), "error");
        }
    };

    const handleSaved = (updated: EditableMediaItem) => {
        setMedia((items) => items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
        setPreviewItem((current) => (current && current.id === updated.id ? { ...current, ...updated } : current));
    };

    const range = pageRange(page, LIBRARY_PAGE_SIZE, total);

    return (
        <div
            className="px-4 py-6 sm:p-8 md:p-12 h-full w-full overflow-auto bg-gray-50/50 flex flex-col relative"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={handleDelete}
                title={t('media.delete.title')}
                message={t('media.delete.message')}
                confirmText={t('media.delete.confirm')}
                isDanger={true}
            />

            {previewItem && (
                <MediaDetailModal
                    item={previewItem}
                    onClose={() => setPreviewItem(null)}
                    onSaved={handleSaved}
                    onRequestDelete={(id) => {
                        setPreviewItem(null);
                        setMediaToDelete(id);
                        setDeleteModalOpen(true);
                    }}
                />
            )}

            {/* Drag Overlay */}
            {isDragging && (
                <div className="absolute inset-0 z-[5000] bg-blue-600/90 flex flex-col items-center justify-center text-white backdrop-blur-md animate-in fade-in duration-300">
                    <div className="w-40 h-40 shrink-0 rounded-3xl md:rounded-[40px] border-4 border-dashed border-white/50 flex items-center justify-center mb-8 animate-bounce">
                        <i className="fa-solid fa-cloud-arrow-up text-6xl"></i>
                    </div>
                    <h2 className="text-5xl font-black italic tracking-tighter mb-4">{t('media.drop.file')}</h2>
                    <p className="text-xl font-medium text-blue-100">{t('media.drop.description')}</p>
                </div>
            )}

            {/* Header */}
            <PageHeader
                title={t('media.title')}
                subtitle={`${total} ${plural(t, 'media.files.count', total)}`}
                actions={
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap gap-3 md:gap-4 items-stretch lg:items-center w-full lg:w-auto">
                        {/* Search */}
                        <div className="relative group">
                            <i className="fa-solid fa-search absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                            <input
                                type="search"
                                aria-label={t('media.search.placeholder')}
                                placeholder={t('media.search.placeholder')}
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                className="w-full lg:w-64 pl-12 pr-6 py-3.5 lg:py-4 bg-white border-2 border-gray-100 rounded-2xl text-sm font-bold text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all placeholder:text-gray-300 shadow-sm"
                            />
                        </div>

                        {/* Filtro por tipo — consulta al SERVIDOR (mime_type), igual que la búsqueda:
                            el total y el paginador se recalculan con el filtro puesto. */}
                        <div className="relative group">
                            <i className="fa-solid fa-filter absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors pointer-events-none"></i>
                            <label className="sr-only" htmlFor="media-type-filter">{t('media.filter.byType')}</label>
                            <select
                                id="media-type-filter"
                                value={mimeType}
                                onChange={(e) => { setMimeType(e.target.value); setPage(1); }}
                                className="w-full lg:w-52 pl-12 pr-6 py-3.5 lg:py-4 bg-white border-2 border-gray-100 rounded-2xl text-sm font-bold text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all shadow-sm appearance-none cursor-pointer"
                            >
                                {MIME_FILTERS.map((option) => (
                                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                                ))}
                            </select>
                        </div>

                        {/* Visibility filter (public / private items). */}
                        <div className="relative group">
                            <i className="fa-solid fa-lock absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors pointer-events-none"></i>
                            <label className="sr-only" htmlFor="media-visibility-filter">{t('media.filter.byVisibility')}</label>
                            <select
                                id="media-visibility-filter"
                                value={visibility}
                                onChange={(e) => { setVisibility(e.target.value as "" | "public" | "private"); setPage(1); }}
                                className="w-full lg:w-52 pl-12 pr-6 py-3.5 lg:py-4 bg-white border-2 border-gray-100 rounded-2xl text-sm font-bold text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all shadow-sm appearance-none cursor-pointer"
                            >
                                {VISIBILITY_FILTERS.map((option) => (
                                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                                ))}
                            </select>
                        </div>

                        {/* View Toggles */}
                        <div role="group" aria-label={t('media.viewMode')} className="flex justify-center bg-white rounded-2xl p-1 border-2 border-gray-100 shadow-sm">
                            <button
                                type="button"
                                onClick={() => setViewMode('grid')}
                                aria-label={t('media.grid.view')}
                                aria-pressed={viewMode === 'grid'}
                                className={`flex-1 lg:flex-none w-11 h-11 shrink-0 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${viewMode === 'grid' ? 'bg-gray-100 text-gray-900 shadow-inner' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <i className="fa-solid fa-table-cells-large" aria-hidden="true"></i>
                            </button>
                            <button
                                type="button"
                                onClick={() => setViewMode('list')}
                                aria-label={t('media.list.view')}
                                aria-pressed={viewMode === 'list'}
                                className={`flex-1 lg:flex-none w-11 h-11 shrink-0 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${viewMode === 'list' ? 'bg-gray-100 text-gray-900 shadow-inner' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <i className="fa-solid fa-list"></i>
                            </button>
                        </div>

                        {/* Upload Button — the hidden input is triggered from the Button's own onClick
                            (a <button> inside a <label> does not forward the click to the input). */}
                        <Button
                            icon={uploading ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'}
                            loading={uploading}
                            disabled={uploading}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {uploading ? t('media.uploading') : t('media.upload')}
                        </Button>
                        <label className="flex items-center gap-2 min-h-11 text-xs font-bold text-gray-600 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" className="h-5 w-5" checked={uploadPrivate} onChange={(e) => setUploadPrivate(e.target.checked)} />
                            {t('media.uploadPrivate')}
                        </label>
                        <input ref={fileInputRef} type="file" onChange={handleInputChange} className="hidden" multiple accept="image/*,video/*,application/pdf" />
                    </div>
                }
            />

            {/* Progress Bar */}
            {uploading && (
                <div className="w-full bg-gray-100 rounded-full h-2 mb-8 overflow-hidden sticky top-0 z-10">
                    <div
                        className="bg-blue-600 h-full transition-all duration-300 ease-out relative"
                        style={{ width: `${uploadProgress}%` }}
                    >
                        <div className="absolute inset-0 bg-white/30 animate-pulse"></div>
                    </div>
                </div>
            )}

            {/* Content Area */}
            <div className="flex-1 pb-20">
                {loading ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-6" role="status" aria-label={t('loading')}>
                        {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                            <div key={i} className="aspect-square bg-white rounded-3xl md:rounded-[32px] animate-pulse border-2 border-gray-100"></div>
                        ))}
                    </div>
                ) : media.length === 0 ? (
                    <EmptyState
                        icon="fa-images"
                        title={t('media.no.files.found')}
                        description={t('media.upload.new')}
                        action={!search && !mimeType && !visibility ? (
                            <Button icon="fa-cloud-arrow-up" onClick={() => fileInputRef.current?.click()}>{t('media.upload')}</Button>
                        ) : (
                            <Button variant="secondary" icon="fa-filter-circle-xmark" onClick={() => { setSearchInput(''); setSearch(''); setMimeType(''); setVisibility(''); setPage(1); }}>
                                {t('table.clearFilters')}
                            </Button>
                        )}
                    />
                ) : viewMode === 'grid' ? (
                    <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 sm:gap-6" aria-label={t('media.title')}>
                        {media.map((item) => (
                            <li
                                key={item.id}
                                className="group relative bg-white border-2 border-gray-50 rounded-3xl md:rounded-[32px] overflow-hidden shadow-lg shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:border-blue-100 transition-all duration-500 focus-within:ring-2 focus-within:ring-blue-400"
                            >
                                {/* The whole card opens the file's details: one real button, so it is reachable by keyboard. */}
                                <button type="button" onClick={() => setPreviewItem(item)} className="block w-full text-left outline-none" aria-label={`${t('media.details')}: ${item.title}`}>
                                    <div className="aspect-square bg-gray-50 flex items-center justify-center overflow-hidden relative">
                                        {item.mimeType.startsWith('image/') ? (
                                            <img src={item.sourceUrl} alt="" className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                                        ) : (
                                            <i className="fa-solid fa-file-pdf text-5xl text-gray-300 group-hover:text-blue-500 transition-colors duration-500" aria-hidden="true"></i>
                                        )}
                                    </div>
                                    <div className="p-3 sm:p-5">
                                        <h4 className="text-sm font-bold text-gray-900 truncate mb-1" title={item.title}>{item.title}</h4>
                                        <div className="flex flex-wrap justify-between items-center gap-1">
                                            <span className="text-[11px] uppercase font-black text-gray-500 tracking-wider bg-gray-100 px-2 py-1 rounded-lg">
                                                {item.mimeType.split('/')[1]}
                                            </span>
                                            <span className="text-[11px] font-bold text-gray-500">
                                                {new Date(item.date).toLocaleDateString()}
                                            </span>
                                        </div>
                                        {item.visibility === "private" && <div className="mt-2"><PrivateBadge /></div>}
                                        {item.mimeType.startsWith('image/') && !item.alt && <div className="mt-2"><MissingAltBadge /></div>}
                                    </div>
                                </button>
                                {/* Delete sits on the image corner: always visible where nothing can hover. */}
                                <button
                                    type="button"
                                    onClick={(e) => confirmDelete(e, item.id)}
                                    className="absolute top-2 right-2 w-11 h-11 shrink-0 bg-white/95 text-red-500 rounded-2xl shadow-xl flex items-center justify-center opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity duration-300 hover:bg-red-50"
                                    title={t('common.delete')}
                                    aria-label={`${t('common.delete')}: ${item.title}`}
                                >
                                    <i className="fa-solid fa-trash-can" aria-hidden="true"></i>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <div className="bg-white rounded-3xl md:rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                        <DataTable
                            rows={media}
                            rowKey={(item) => item.id}
                            caption={t('media.title')}
                            rowLabel={(item) => item.title}
                            actionsLabel={t('common.actions')}
                            columns={[
                                {
                                    key: "name",
                                    header: t('common.name'),
                                    primary: true,
                                    cell: (item) => (
                                        <div className="flex items-center gap-4">
                                            <div className="w-14 h-14 md:w-16 md:h-16 shrink-0 bg-gray-100 rounded-2xl overflow-hidden shadow-sm flex items-center justify-center">
                                                {item.mimeType.startsWith('image/') ? (
                                                    <img src={item.sourceUrl} alt="" className="w-full h-full object-cover" />
                                                ) : (
                                                    <i className="fa-solid fa-file text-gray-300 text-xl" aria-hidden="true"></i>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <button type="button" onClick={() => setPreviewItem(item)} className="text-left font-bold text-gray-700 hover:text-blue-600 transition-colors italic tracking-tight text-base md:text-lg break-all">
                                                    {item.title}
                                                </button>
                                                <div className="flex flex-wrap gap-2 mt-1">
                                                    {item.visibility === "private" && <PrivateBadge />}
                                                    {item.mimeType.startsWith('image/') && !item.alt && <MissingAltBadge />}
                                                </div>
                                            </div>
                                        </div>
                                    ),
                                },
                                {
                                    key: "type",
                                    header: t('media.type'),
                                    cell: (item) => <span className="bg-gray-100 text-gray-600 px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wide break-all">{item.mimeType}</span>,
                                },
                                {
                                    key: "date",
                                    header: t('common.date'),
                                    cell: (item) => <span className="font-bold text-gray-500 text-sm">{new Date(item.date).toLocaleDateString()}</span>,
                                },
                            ]}
                            actions={(item) => [
                                { key: "details", label: t('media.details'), icon: "fa-pen-to-square", onClick: () => setPreviewItem(item), tone: "primary" },
                                { key: "delete", label: t('common.delete'), icon: "fa-trash-can", onClick: () => { setMediaToDelete(item.id); setDeleteModalOpen(true); }, tone: "danger" },
                            ]}
                        />
                    </div>
                )}

                {/* Pager — the counter and the page count come from the server's X-WP-Total headers, so
                    they describe the whole library and not the slice currently on screen. */}
                {!loading && total > 0 && (
                    <div className="mt-6 md:mt-8 bg-white rounded-3xl md:rounded-[28px] border-2 border-gray-50 shadow-sm overflow-hidden">
                        <Pagination
                            page={page}
                            totalPages={totalPages}
                            onChange={setPage}
                            className="border-t-0 bg-white"
                            label={`${t('media.range').replace('{from}', String(range.from)).replace('{to}', String(range.to)).replace('{total}', String(range.total))} ${plural(t, 'media.files.count', range.total)}`}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
