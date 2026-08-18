"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { mediaApi } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import ConfirmationModal from "@/components/ConfirmationModal";
import { useToast } from "@/contexts/ToastContext";
import { PageHeader, Button, EmptyState } from "@/components/ui";
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
const MIME_FILTERS: Array<{ label: string; value: string }> = [
    { label: "Todos los tipos", value: "" },
    { label: "Imágenes", value: "image" },
    { label: "Vídeo", value: "video" },
    { label: "Audio", value: "audio" },
    { label: "PDF", value: "application/pdf" },
    { label: "Texto", value: "text" },
];

const fieldClass =
    "w-full px-4 py-3 bg-gray-50 border-2 border-gray-100 rounded-2xl text-sm font-medium text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all placeholder:text-gray-300";
const labelClass = "text-[10px] font-black uppercase tracking-widest text-gray-400 block mb-1.5";

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
            addToast("Detalles del archivo guardados", "success");
        } catch (error) {
            console.error("Failed to update media:", error);
            // The backend answers a 403 `rest_forbidden` with a human message when the file belongs to
            // another user; show it instead of a generic error so nobody retries a denied edit.
            const message = error instanceof Error && error.message ? error.message : "No se pudieron guardar los cambios";
            addToast(message, "error");
        } finally {
            setSaving(false);
        }
    };

    const setField = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft((d) => ({ ...d, [key]: e.target.value }));

    return (
        <div className="fixed inset-0 z-[6000] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md animate-in fade-in duration-300">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div className="relative bg-white rounded-[40px] overflow-y-auto md:overflow-hidden shadow-2xl max-w-5xl w-full max-h-[85vh] flex flex-col md:flex-row animate-in zoom-in-95 duration-300">
                <div className="flex-1 bg-gray-100/50 flex items-center justify-center p-8 min-h-[300px] relative">
                    <div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] opacity-50"></div>
                    {item.mimeType.startsWith('image/') ? (
                        <div className="relative w-full h-full flex items-center justify-center z-10">
                            <img
                                src={item.sourceUrl}
                                alt={item.alt || item.title}
                                className="max-w-full max-h-[60vh] object-contain shadow-2xl rounded-2xl"
                            />
                        </div>
                    ) : (
                        <i className="fa-solid fa-file text-9xl text-gray-300 relative z-10"></i>
                    )}
                </div>
                <div className="w-full md:w-[26rem] p-8 bg-white border-l border-gray-100 flex flex-col h-full overflow-y-auto">
                    <button onClick={onClose} aria-label={t('common.close')} className="absolute top-6 right-6 w-10 h-10 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-900 flex items-center justify-center transition-colors">
                        <i className="fa-solid fa-xmark text-lg"></i>
                    </button>

                    <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter mb-1 pr-12 break-words" title={item.title}>
                        {item.title}
                    </h3>
                    <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-6">Detalles del archivo</p>

                    {/* Editable metadata — the four fields PUT /media/:id accepts. */}
                    <div className="space-y-4">
                        <div>
                            <label className={labelClass} htmlFor="media-title">Título</label>
                            <input id="media-title" type="text" className={fieldClass} value={draft.title} onChange={setField("title")} />
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="media-alt">Texto alternativo</label>
                            <input
                                id="media-alt"
                                type="text"
                                className={fieldClass}
                                value={draft.alt}
                                onChange={setField("alt")}
                                placeholder="Describe la imagen para quien no puede verla"
                                aria-describedby="media-alt-help"
                            />
                            <p id="media-alt-help" className="text-[11px] font-medium text-gray-400 mt-1.5 leading-snug">
                                Lo que anuncian los lectores de pantalla. Déjalo vacío solo si la imagen es decorativa.
                            </p>
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="media-caption">Leyenda</label>
                            <input id="media-caption" type="text" className={fieldClass} value={draft.caption} onChange={setField("caption")} />
                        </div>
                        <div>
                            <label className={labelClass} htmlFor="media-description">Descripción</label>
                            <textarea id="media-description" rows={3} className={`${fieldClass} resize-y`} value={draft.description} onChange={setField("description")} />
                        </div>
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
                            {saving ? t('common.saving') : "Guardar cambios"}
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
        </div>
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
            const res = await mediaApi.listPaged(buildMediaQuery({ page, perPage: LIBRARY_PAGE_SIZE, search, mimeType }));
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
    }, [page, search, mimeType, refreshKey]);

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
            });
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
            className="p-8 md:p-12 h-full w-full overflow-auto bg-gray-50/50 flex flex-col relative"
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
                    <div className="w-40 h-40 rounded-[40px] border-4 border-dashed border-white/50 flex items-center justify-center mb-8 animate-bounce">
                        <i className="fa-solid fa-cloud-arrow-up text-6xl"></i>
                    </div>
                    <h2 className="text-5xl font-black italic tracking-tighter mb-4">{t('media.drop.file')}</h2>
                    <p className="text-xl font-medium text-blue-100">{t('media.drop.description')}</p>
                </div>
            )}

            {/* Header */}
            <PageHeader
                title={t('media.title')}
                subtitle={`${total} ${t('media.files.count')}`}
                actions={
                    <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center">
                        {/* Search */}
                        <div className="relative group">
                            <i className="fa-solid fa-search absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                            <input
                                type="text"
                                placeholder={t('media.search.placeholder')}
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                className="w-full md:w-64 pl-12 pr-6 py-4 bg-white border-2 border-gray-100 rounded-2xl text-sm font-bold text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all placeholder:text-gray-300 shadow-sm"
                            />
                        </div>

                        {/* Filtro por tipo — consulta al SERVIDOR (mime_type), igual que la búsqueda:
                            el total y el paginador se recalculan con el filtro puesto. */}
                        <div className="relative group">
                            <i className="fa-solid fa-filter absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors pointer-events-none"></i>
                            <label className="sr-only" htmlFor="media-type-filter">Filtrar por tipo de archivo</label>
                            <select
                                id="media-type-filter"
                                value={mimeType}
                                onChange={(e) => { setMimeType(e.target.value); setPage(1); }}
                                className="w-full md:w-52 pl-12 pr-6 py-4 bg-white border-2 border-gray-100 rounded-2xl text-sm font-bold text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all shadow-sm appearance-none cursor-pointer"
                            >
                                {MIME_FILTERS.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* View Toggles */}
                        <div className="flex bg-white rounded-2xl p-1.5 border-2 border-gray-100 shadow-sm">
                            <button
                                onClick={() => setViewMode('grid')}
                                aria-label={t('media.grid.view')}
                                className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${viewMode === 'grid' ? 'bg-gray-100 text-gray-900 shadow-inner' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <i className="fa-solid fa-grid-2"></i>
                            </button>
                            <button
                                onClick={() => setViewMode('list')}
                                aria-label={t('media.list.view')}
                                className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${viewMode === 'list' ? 'bg-gray-100 text-gray-900 shadow-inner' : 'text-gray-400 hover:text-gray-600'}`}
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
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                            <div key={i} className="aspect-square bg-white rounded-[32px] animate-pulse border-2 border-gray-100"></div>
                        ))}
                    </div>
                ) : media.length === 0 ? (
                    <EmptyState
                        icon="fa-images"
                        title={t('media.no.files.found')}
                        description={t('media.upload.new')}
                    />
                ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                        {media.map((item) => (
                            <div
                                key={item.id}
                                onClick={() => setPreviewItem(item)}
                                className="group relative bg-white border-2 border-gray-50 rounded-[32px] overflow-hidden shadow-lg shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-2 hover:border-blue-100 transition-all duration-500 cursor-pointer"
                            >
                                <div className="aspect-square bg-gray-50 flex items-center justify-center overflow-hidden relative">
                                    {item.mimeType.startsWith('image/') ? (
                                        <div className="relative w-full h-full">
                                            <img src={item.sourceUrl} alt={item.alt || item.title} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                                            <div className="absolute inset-0 bg-blue-900/0 group-hover:bg-blue-900/20 transition-colors duration-500"></div>
                                        </div>
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center bg-gray-50 group-hover:bg-blue-50 transition-colors duration-500">
                                            <i className="fa-solid fa-file-pdf text-5xl text-gray-300 group-hover:text-blue-500 group-hover:scale-110 transition-transform duration-500"></i>
                                        </div>
                                    )}

                                    {/* Quick Actions Overlay */}
                                    <div className="absolute inset-0 flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity duration-300 gap-3">
                                        <button
                                            onClick={(e) => confirmDelete(e, item.id)}
                                            className="w-12 h-12 bg-white text-red-500 rounded-2xl shadow-xl flex items-center justify-center transform translate-y-0 md:translate-y-4 md:group-hover:translate-y-0 md:group-focus-within:translate-y-0 transition-all duration-300 hover:scale-110 hover:bg-red-50"
                                            title={t('common.delete')}
                                            aria-label={t('common.delete')}
                                        >
                                            <i className="fa-solid fa-trash-can"></i>
                                        </button>
                                        <button
                                            className="w-12 h-12 bg-white text-blue-600 rounded-2xl shadow-xl flex items-center justify-center transform translate-y-0 md:translate-y-4 md:group-hover:translate-y-0 md:group-focus-within:translate-y-0 transition-all duration-300 delay-75 hover:scale-110 hover:bg-blue-50"
                                            title={t('common.edit')}
                                            aria-label={t('common.edit')}
                                        >
                                            <i className="fa-solid fa-pen-to-square"></i>
                                        </button>
                                    </div>
                                </div>

                                <div className="p-5">
                                    <h4 className="text-sm font-bold text-gray-900 truncate mb-1" title={item.title}>{item.title}</h4>
                                    <div className="flex justify-between items-center">
                                        <span className="text-[9px] uppercase font-black text-gray-400 tracking-wider bg-gray-100 px-2 py-1 rounded-lg">
                                            {item.mimeType.split('/')[1]}
                                        </span>
                                        <span className="text-[10px] font-bold text-gray-400">
                                            {new Date(item.date).toLocaleDateString()}
                                        </span>
                                    </div>
                                    {/* Missing alt text is invisible until someone audits the site; surface it here. */}
                                    {item.mimeType.startsWith('image/') && !item.alt && (
                                        <span className="mt-2 inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider text-amber-600 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg">
                                            <i className="fa-solid fa-triangle-exclamation"></i> Sin texto alternativo
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="bg-white rounded-[40px] border-2 border-gray-50 shadow-xl shadow-gray-100/50 overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left">
                                <thead className="bg-gray-50/50 border-b border-gray-100">
                                    <tr>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('common.preview')}</th>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('common.name')}</th>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('media.type')}</th>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('common.date')}</th>
                                        <th className="px-8 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('common.actions')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                    {media.map((item) => (
                                        <tr key={item.id} className="group hover:bg-blue-50/5 transition-colors cursor-pointer" onClick={() => setPreviewItem(item)}>
                                            <td className="px-8 py-4 w-32">
                                                <div className="w-16 h-16 bg-gray-100 rounded-2xl overflow-hidden shadow-sm group-hover:shadow-md transition-all flex items-center justify-center">
                                                    {item.mimeType.startsWith('image/') ? (
                                                        <img src={item.sourceUrl} alt={item.alt || item.title} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <i className="fa-solid fa-file text-gray-300 text-xl"></i>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-8 py-4">
                                                <span className="font-bold text-gray-700 group-hover:text-blue-600 transition-colors italic tracking-tight text-lg">{item.title}</span>
                                                {item.mimeType.startsWith('image/') && !item.alt && (
                                                    <span className="ml-3 inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider text-amber-600 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg align-middle">
                                                        <i className="fa-solid fa-triangle-exclamation"></i> Sin texto alternativo
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-8 py-4">
                                                <span className="bg-gray-100 text-gray-500 px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wide">
                                                    {item.mimeType}
                                                </span>
                                            </td>
                                            <td className="px-8 py-4 font-bold text-gray-400 text-sm">{new Date(item.date).toLocaleDateString()}</td>
                                            <td className="px-8 py-4 text-right">
                                                <button
                                                    onClick={(e) => confirmDelete(e, item.id)}
                                                    aria-label={t('common.delete')}
                                                    title={t('common.delete')}
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-red-200 ml-auto opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 translate-x-0 md:translate-x-2 md:group-hover:translate-x-0 duration-300"
                                                >
                                                    <i className="fa-solid fa-trash-can text-sm"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Pager — the counter and the page count come from the server's X-WP-Total headers, so
                    they describe the whole library and not the slice currently on screen. */}
                {!loading && total > 0 && (
                    <div className="mt-8 bg-white rounded-[28px] border-2 border-gray-50 shadow-sm px-6 py-4 flex items-center justify-between gap-4">
                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                            {range.from}–{range.to} de {range.total} {t('media.files.count')}
                        </span>
                        {totalPages > 1 && (
                            <div className="flex items-center gap-4">
                                <button
                                    type="button"
                                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                                    disabled={page <= 1}
                                    className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                                >
                                    <i className="fa-solid fa-chevron-left mr-2"></i>{t('table.previous')}
                                </button>
                                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap">
                                    {t('table.pageOf').replace('{page}', String(page)).replace('{total}', String(totalPages))}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                                    disabled={page >= totalPages}
                                    className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-600 hover:border-blue-400 hover:text-blue-600 disabled:opacity-40 transition-all"
                                >
                                    {t('table.next')}<i className="fa-solid fa-chevron-right ml-2"></i>
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
