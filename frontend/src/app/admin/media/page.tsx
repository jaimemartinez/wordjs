"use client";

import { useEffect, useState, useCallback } from "react";
import { mediaApi, MediaItem } from "@/lib/api";
import { useI18n } from "@/contexts/I18nContext";
import ConfirmationModal from "@/components/ConfirmationModal";
import { useToast } from "@/contexts/ToastContext";
import { PageHeader, Button, EmptyState } from "@/components/ui";

// Image Preview Modal
function ImagePreviewModal({ item, onClose }: { item: MediaItem; onClose: () => void }) {
    const { t } = useI18n();
    const { addToast } = useToast();

    if (!item) return null;

    const copyUrl = () => {
        navigator.clipboard.writeText(item.guid);
        addToast(t('media.url.copied'), "success");
    };

    return (
        <div className="fixed inset-0 z-[6000] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md animate-in fade-in duration-300">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div className="relative bg-white rounded-[40px] overflow-hidden shadow-2xl max-w-5xl w-full max-h-[85vh] flex flex-col md:flex-row animate-in zoom-in-95 duration-300">
                <div className="flex-1 bg-gray-100/50 flex items-center justify-center p-8 min-h-[300px] relative">
                    <div className="absolute inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px] opacity-50"></div>
                    {item.mimeType.startsWith('image/') ? (
                        <div className="relative w-full h-full flex items-center justify-center z-10">
                            <img
                                src={item.sourceUrl}
                                alt={item.title}
                                className="max-w-full max-h-[60vh] object-contain shadow-2xl rounded-2xl"
                            />
                        </div>
                    ) : (
                        <i className="fa-solid fa-file text-9xl text-gray-300 relative z-10"></i>
                    )}
                </div>
                <div className="w-full md:w-96 p-10 bg-white border-l border-gray-100 flex flex-col h-full overflow-y-auto">
                    <button onClick={onClose} className="absolute top-6 right-6 w-10 h-10 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-900 flex items-center justify-center transition-colors">
                        <i className="fa-solid fa-xmark text-lg"></i>
                    </button>

                    <h3 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-2 break-words" title={item.title}>
                        {item.title}
                    </h3>

                    <div className="space-y-6 my-8 flex-1">
                        <div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 block mb-1">{t('media.type')}</span>
                            <span className="font-bold text-gray-700 bg-gray-50 px-3 py-1 rounded-lg text-sm inline-block border border-gray-100">{item.mimeType}</span>
                        </div>
                        <div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 block mb-1">{t('media.uploaded')}</span>
                            <span className="font-bold text-gray-700 text-lg italic">{new Date(item.date).toLocaleDateString()}</span>
                        </div>
                        <div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 block mb-2">URL</span>
                            <div className="bg-gray-50 rounded-xl p-3 border border-gray-100break-all text-xs font-mono text-gray-500 select-all border border-gray-200">
                                {item.guid}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-3 mt-auto pt-6 border-t border-gray-100">
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
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function MediaPage() {
    const { t } = useI18n();
    const { addToast } = useToast();
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [filteredMedia, setFilteredMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [previewItem, setPreviewItem] = useState<MediaItem | null>(null);

    useEffect(() => {
        loadMedia();
    }, []);

    useEffect(() => {
        if (!searchQuery) {
            setFilteredMedia(media);
        } else {
            const lower = searchQuery.toLowerCase();
            setFilteredMedia(media.filter(m => m.title.toLowerCase().includes(lower)));
        }
    }, [searchQuery, media]);

    const loadMedia = async () => {
        try {
            const data = await mediaApi.list();
            setMedia(data);
        } catch (error) {
            console.error("Failed to load media:", error);
            addToast("Failed to load media", "error");
        } finally {
            setLoading(false);
        }
    };

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
            await loadMedia();
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
            setMedia((prevMedia) => prevMedia.filter((item) => item.id !== mediaToDelete));
            if (previewItem?.id === mediaToDelete) setPreviewItem(null);
            setDeleteModalOpen(false);
            addToast(t('common.success'), "success");
        } catch (error) {
            console.error("Failed to delete file:", error);
            addToast(t('common.error'), "error");
        }
    };

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
                <ImagePreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
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
                subtitle={`${media.length} ${t('media.files.count')}`}
                actions={
                    <div className="flex flex-col md:flex-row gap-4 items-stretch md:items-center">
                        {/* Search */}
                        <div className="relative group">
                            <i className="fa-solid fa-search absolute left-5 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 transition-colors"></i>
                            <input
                                type="text"
                                placeholder={t('media.search.placeholder')}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full md:w-64 pl-12 pr-6 py-4 bg-white border-2 border-gray-100 rounded-2xl text-sm font-bold text-gray-700 outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all placeholder:text-gray-300 shadow-sm"
                            />
                        </div>

                        {/* View Toggles */}
                        <div className="flex bg-white rounded-2xl p-1.5 border-2 border-gray-100 shadow-sm">
                            <button
                                onClick={() => setViewMode('grid')}
                                className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${viewMode === 'grid' ? 'bg-gray-100 text-gray-900 shadow-inner' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <i className="fa-solid fa-grid-2"></i>
                            </button>
                            <button
                                onClick={() => setViewMode('list')}
                                className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm transition-all duration-300 ${viewMode === 'list' ? 'bg-gray-100 text-gray-900 shadow-inner' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <i className="fa-solid fa-list"></i>
                            </button>
                        </div>

                        {/* Upload Button */}
                        <label className={`cursor-pointer ${uploading ? 'opacity-70 pointer-events-none' : ''}`}>
                            <Button icon={uploading ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'} loading={uploading}>
                                {uploading ? t('media.uploading') : t('media.upload')}
                            </Button>
                            <input type="file" onChange={handleInputChange} className="hidden" multiple accept="image/*,video/*,application/pdf" />
                        </label>
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
                ) : filteredMedia.length === 0 ? (
                    <EmptyState
                        icon="fa-images"
                        title={t('media.no.files.found')}
                        description={t('media.upload.new')}
                    />
                ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                        {filteredMedia.map((item) => (
                            <div
                                key={item.id}
                                onClick={() => setPreviewItem(item)}
                                className="group relative bg-white border-2 border-gray-50 rounded-[32px] overflow-hidden shadow-lg shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-2 hover:border-blue-100 transition-all duration-500 cursor-pointer"
                            >
                                <div className="aspect-square bg-gray-50 flex items-center justify-center overflow-hidden relative">
                                    {item.mimeType.startsWith('image/') ? (
                                        <div className="relative w-full h-full">
                                            <img src={item.sourceUrl} alt={item.title} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                                            <div className="absolute inset-0 bg-blue-900/0 group-hover:bg-blue-900/20 transition-colors duration-500"></div>
                                        </div>
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center bg-gray-50 group-hover:bg-blue-50 transition-colors duration-500">
                                            <i className="fa-solid fa-file-pdf text-5xl text-gray-300 group-hover:text-blue-500 group-hover:scale-110 transition-transform duration-500"></i>
                                        </div>
                                    )}

                                    {/* Quick Actions Overlay */}
                                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 gap-3">
                                        <button
                                            onClick={(e) => confirmDelete(e, item.id)}
                                            className="w-12 h-12 bg-white text-red-500 rounded-2xl shadow-xl flex items-center justify-center transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 hover:scale-110 hover:bg-red-50"
                                            title="Eliminar"
                                        >
                                            <i className="fa-solid fa-trash-can"></i>
                                        </button>
                                        <button
                                            className="w-12 h-12 bg-white text-blue-600 rounded-2xl shadow-xl flex items-center justify-center transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 delay-75 hover:scale-110 hover:bg-blue-50"
                                            title="Ver"
                                        >
                                            <i className="fa-solid fa-eye"></i>
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
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">Preview</th>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">Name</th>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">Type</th>
                                        <th className="px-8 py-6 text-left text-[10px] font-black text-gray-400 uppercase tracking-widest">Date</th>
                                        <th className="px-8 py-6 text-right text-[10px] font-black text-gray-400 uppercase tracking-widest">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                    {filteredMedia.map((item) => (
                                        <tr key={item.id} className="group hover:bg-blue-50/5 transition-colors cursor-pointer" onClick={() => setPreviewItem(item)}>
                                            <td className="px-8 py-4 w-32">
                                                <div className="w-16 h-16 bg-gray-100 rounded-2xl overflow-hidden shadow-sm group-hover:shadow-md transition-all flex items-center justify-center">
                                                    {item.mimeType.startsWith('image/') ? (
                                                        <img src={item.sourceUrl} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <i className="fa-solid fa-file text-gray-300 text-xl"></i>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-8 py-4">
                                                <span className="font-bold text-gray-700 group-hover:text-blue-600 transition-colors italic tracking-tight text-lg">{item.title}</span>
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
                                                    className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-600 hover:text-white flex items-center justify-center transition-all shadow-sm hover:shadow-red-200 ml-auto opacity-0 group-hover:opacity-100 translate-x-2 group-hover:translate-x-0 duration-300"
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
            </div>
        </div>
    );
}
