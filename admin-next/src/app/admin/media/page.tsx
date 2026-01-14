"use client";

import { useEffect, useState, useCallback } from "react";
import { mediaApi, MediaItem } from "@/lib/api";
import ConfirmationModal from "@/components/ConfirmationModal";
import Image from "next/image";
import { useToast } from "@/contexts/ToastContext";

// Image Preview Modal
function ImagePreviewModal({ item, onClose }: { item: MediaItem; onClose: () => void }) {
    const { addToast } = useToast();

    if (!item) return null;

    const copyUrl = () => {
        navigator.clipboard.writeText(item.guid);
        addToast("URL copied to clipboard!", "success");
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="absolute inset-0" onClick={onClose}></div>
            <div className="relative bg-white rounded-2xl overflow-hidden shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col md:flex-row">
                <div className="flex-1 bg-gray-100 flex items-center justify-center p-4 min-h-[300px]">
                    {item.mimeType.startsWith('image/') ? (
                        <div className="relative w-full h-full min-h-[300px] flex items-center justify-center">
                            <img
                                src={item.guid}
                                alt={item.title}
                                className="max-w-full max-h-[70vh] object-contain shadow-lg rounded-lg"
                            />
                        </div>
                    ) : (
                        <i className="fa-solid fa-file text-9xl text-gray-300"></i>
                    )}
                </div>
                <div className="w-full md:w-80 p-6 bg-white border-l border-gray-100 flex flex-col">
                    <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-700">
                        <i className="fa-solid fa-times text-xl"></i>
                    </button>

                    <h3 className="text-2xl font-oswald font-bold text-gray-900 mb-2 truncate" title={item.title}>
                        {item.title}
                    </h3>
                    <div className="text-sm text-gray-500 mb-6 space-y-2">
                        <div className="flex justify-between border-b pb-2">
                            <span>Type</span>
                            <span className="font-medium text-gray-700">{item.mimeType}</span>
                        </div>
                        <div className="flex justify-between border-b pb-2">
                            <span>Uploaded</span>
                            <span className="font-medium text-gray-700">{new Date(item.date).toLocaleDateString()}</span>
                        </div>
                    </div>

                    <div className="mt-auto space-y-3">
                        <button
                            onClick={copyUrl}
                            className="w-full py-2 px-4 bg-gray-100 hover:bg-brand-cyan hover:text-white text-gray-700 rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
                        >
                            <i className="fa-solid fa-link"></i> Copy URL
                        </button>
                        <a
                            href={item.guid}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-full py-2 px-4 bg-brand-blue hover:bg-blue-700 text-white rounded-lg transition-colors font-medium flex items-center justify-center gap-2 text-center block"
                        >
                            <i className="fa-solid fa-external-link-alt"></i> Open
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function MediaPage() {
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
            addToast("File uploaded successfully", "success");
        } catch (error) {
            console.error("Failed to upload file:", error);
            addToast("Failed to upload file", "error");
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
            addToast("File deleted", "success");
        } catch (error) {
            console.error("Failed to delete file:", error);
            addToast("Failed to delete file", "error");
        }
    };

    return (
        <div
            className="p-6 h-full overflow-hidden flex flex-col bg-gray-50/50"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={handleDelete}
                title="Delete File"
                message="Are you sure you want to delete this file? This action cannot be undone."
                confirmText="Delete"
                isDanger={true}
            />

            {previewItem && (
                <ImagePreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />
            )}

            {/* Drag Overlay */}
            {isDragging && (
                <div className="absolute inset-0 z-50 bg-brand-blue/90 flex flex-col items-center justify-center text-white backdrop-blur-sm animate-in fade-in">
                    <i className="fa-solid fa-cloud-arrow-up text-8xl mb-6 animate-bounce"></i>
                    <h2 className="text-4xl font-oswald font-bold">Sueltat tu archivo aquí</h2>
                    <p className="mt-2 text-lg text-blue-100">para subirlo a la librería</p>
                </div>
            )}

            {/* Header Toolbar */}
            <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-8 bg-white p-4 rounded-2xl shadow-sm border border-gray-100">
                <div className="flex items-center gap-4 w-full md:w-auto">
                    <div className="bg-brand-blue text-white w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-brand-blue/20">
                        <i className="fa-solid fa-photo-film text-lg"></i>
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-gray-900 font-oswald">Galería Multimedia</h1>
                        <p className="text-xs text-gray-500">{media.length} archivos</p>
                    </div>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    {/* Search */}
                    <div className="relative flex-1 md:w-64">
                        <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                        <input
                            type="text"
                            placeholder="Buscar..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-brand-cyan/50 focus:border-brand-cyan transition-all"
                        />
                    </div>

                    {/* View Toggles */}
                    <div className="flex bg-gray-100 rounded-lg p-1">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-2 rounded-md text-sm transition-all ${viewMode === 'grid' ? 'bg-white shadow text-brand-blue' : 'text-gray-500 hover:text-gray-700'}`}
                        >
                            <i className="fa-solid fa-grid-2"></i>
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-2 rounded-md text-sm transition-all ${viewMode === 'list' ? 'bg-white shadow text-brand-blue' : 'text-gray-500 hover:text-gray-700'}`}
                        >
                            <i className="fa-solid fa-list"></i>
                        </button>
                    </div>

                    {/* Upload Button */}
                    <label className={`bg-gradient-to-r from-brand-blue to-brand-cyan hover:brightness-110 text-white px-5 py-2.5 rounded-xl transition-all shadow-lg shadow-brand-blue/20 flex items-center gap-2 cursor-pointer transform hover:-translate-y-0.5 active:scale-95 ${uploading ? 'opacity-70 pointer-events-none' : ''}`}>
                        <i className={`fa-solid ${uploading ? 'fa-spinner fa-spin' : 'fa-cloud-upload'}`}></i>
                        <span className="font-medium font-oswald tracking-wide">{uploading ? 'Subiendo...' : 'Subir'}</span>
                        <input type="file" onChange={handleInputChange} className="hidden" multiple accept="image/*,video/*,application/pdf" />
                    </label>
                </div>
            </div>

            {/* Progress Bar */}
            {uploading && (
                <div className="w-full bg-gray-100 rounded-full h-1.5 mb-6 overflow-hidden">
                    <div
                        className="bg-brand-cyan h-full transition-all duration-300 ease-out relative"
                        style={{ width: `${uploadProgress}%` }}
                    >
                        <div className="absolute inset-0 bg-white/30 animate-pulse"></div>
                    </div>
                </div>
            )}

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {loading ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                            <div key={i} className="aspect-square bg-gray-200 rounded-xl animate-pulse"></div>
                        ))}
                    </div>
                ) : filteredMedia.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-[50vh] text-gray-400">
                        <div className="w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                            <i className="fa-regular fa-image text-4xl text-gray-300"></i>
                        </div>
                        <p className="text-lg font-medium">No se encontraron archivos</p>
                        <p className="text-sm">Sube algo nuevo o cambia tu búsqueda</p>
                    </div>
                ) : viewMode === 'grid' ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pb-20">
                        {filteredMedia.map((item) => (
                            <div
                                key={item.id}
                                onClick={() => setPreviewItem(item)}
                                className="group relative bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer"
                            >
                                <div className="aspect-square bg-gray-50 flex items-center justify-center overflow-hidden relative">
                                    {item.mimeType.startsWith('image/') ? (
                                        <div className="relative w-full h-full">
                                            <img src={item.guid} alt={item.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300"></div>
                                        </div>
                                    ) : (
                                        <i className="fa-solid fa-file-pdf text-5xl text-red-500/80 group-hover:scale-110 transition-transform duration-300"></i>
                                    )}

                                    {/* Quick Actions Overlay */}
                                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 gap-2">
                                        <button
                                            onClick={(e) => confirmDelete(e, item.id)}
                                            className="w-10 h-10 bg-white/90 hover:bg-red-500 hover:text-white text-red-500 rounded-full shadow-lg backdrop-blur-sm flex items-center justify-center transform scale-75 group-hover:scale-100 transition-all duration-300"
                                            title="Eliminar"
                                        >
                                            <i className="fa-solid fa-trash-can"></i>
                                        </button>
                                        <button
                                            className="w-10 h-10 bg-white/90 hover:bg-brand-blue hover:text-white text-brand-blue rounded-full shadow-lg backdrop-blur-sm flex items-center justify-center transform scale-75 group-hover:scale-100 transition-all duration-300 delay-75"
                                            title="Ver"
                                        >
                                            <i className="fa-solid fa-eye"></i>
                                        </button>
                                    </div>
                                </div>

                                <div className="p-3">
                                    <h4 className="text-sm font-medium text-gray-800 truncate" title={item.title}>{item.title}</h4>
                                    <div className="flex justify-between items-center mt-1">
                                        <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider bg-gray-100 px-1.5 py-0.5 rounded">
                                            {item.mimeType.split('/')[1]}
                                        </span>
                                        <span className="text-[10px] text-gray-400">
                                            {new Date(item.date).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                        <table className="w-full text-left text-sm text-gray-600">
                            <thead className="bg-gray-50 text-gray-800 font-oswald font-medium uppercase text-xs tracking-wider">
                                <tr>
                                    <th className="p-4 w-20">Preview</th>
                                    <th className="p-4">Name</th>
                                    <th className="p-4">Type</th>
                                    <th className="p-4">Date</th>
                                    <th className="p-4 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {filteredMedia.map((item) => (
                                    <tr key={item.id} className="hover:bg-gray-50/50 transition-colors group cursor-pointer" onClick={() => setPreviewItem(item)}>
                                        <td className="p-3">
                                            <div className="w-12 h-12 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center">
                                                {item.mimeType.startsWith('image/') ? (
                                                    <img src={item.guid} className="w-full h-full object-cover" />
                                                ) : (
                                                    <i className="fa-solid fa-file text-gray-400"></i>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-4 font-medium text-gray-900">{item.title}</td>
                                        <td className="p-4">{item.mimeType}</td>
                                        <td className="p-4">{new Date(item.date).toLocaleDateString()}</td>
                                        <td className="p-4 text-right">
                                            <button
                                                onClick={(e) => confirmDelete(e, item.id)}
                                                className="text-gray-400 hover:text-red-500 p-2 transition-colors"
                                            >
                                                <i className="fa-solid fa-trash-can"></i>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
