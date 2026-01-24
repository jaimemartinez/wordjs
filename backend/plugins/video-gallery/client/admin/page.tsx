// @ts-nocheck
"use client";

import { useState, useEffect } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader } from "../../../../../admin-next/src/components/ui/PageHeader";
import { Card } from "../../../../../admin-next/src/components/ui/Card";

interface Video {
    id?: number | string; // Updated to support string/legacy IDs
    title: string;
    youtube_url: string;
    thumbnail?: string;
    button_text: string;
    description?: string;
    sort_order?: number;
}

interface Gallery {
    id: string;
    name: string;
    description?: string;
    videoCount: number;
}



export default function VideosAdminPage() {
    // --- STATE ---
    const [view, setView] = useState<'list' | 'detail'>('list');
    const [galleries, setGalleries] = useState<Gallery[]>([]);
    const [selectedGallery, setSelectedGallery] = useState<Gallery | null>(null);

    // Gallery CRUD State
    const [isCreatingGallery, setIsCreatingGallery] = useState(false);
    const [newGalleryName, setNewGalleryName] = useState("");
    const [newGalleryDesc, setNewGalleryDesc] = useState("");

    // Video CRUD State (Existing logic adapted)
    const [videos, setVideos] = useState<Video[]>([]);
    const [editingVideo, setEditingVideo] = useState<Video | null>(null);
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadGalleries();
    }, []);

    const { alert, confirm } = useModal();

    // --- GALLERY ACTIONS ---
    const loadGalleries = async () => {
        setLoading(true);
        try {
            const data = await api<Gallery[]>("/videos/galleries");
            setGalleries(data);
        } catch (err) {
            console.error("Failed to load galleries:", err);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateGallery = async () => {
        if (!newGalleryName) return;
        try {
            await apiPost("/videos/galleries", { name: newGalleryName, description: newGalleryDesc });
            await loadGalleries();
            setIsCreatingGallery(false);
            setNewGalleryName("");
            setNewGalleryDesc("");
        } catch (err) {
            await alert("Failed to create gallery");
        }
    };

    const deleteGallery = async (id: string) => {
        if (!await confirm("Delete this gallery? All videos in it will be lost.", "Delete Gallery", true)) return;
        try {
            await apiDelete(`/videos/galleries/${id}`);
            loadGalleries();
        } catch (err) {
            await alert("Failed to delete gallery");
        }
    };

    const openGallery = async (gallery: Gallery) => {
        setSelectedGallery(gallery);
        setView('detail');
        setLoading(true);
        try {
            const data = await api<any>(`/videos/galleries/${gallery.id}`);
            setVideos(data.videos || []);
        } catch (err) {
            console.error("Error loading gallery videos:", err);
        } finally {
            setLoading(false);
        }
    };

    // --- VIDEO ACTIONS (Scoped to Selected Gallery) ---
    const handleSaveVideo = async () => {
        if (!editingVideo || !selectedGallery) return;
        setSaving(true);

        try {
            const endpoint = editingVideo.id
                ? `/videos/galleries/${selectedGallery.id}/videos/${editingVideo.id}`
                : `/videos/galleries/${selectedGallery.id}/videos`;

            if (editingVideo.id) {
                await apiPut(endpoint, editingVideo);
            } else {
                await apiPost(endpoint, editingVideo);
            }

            // Reload current gallery
            const updatedData = await api<any>(`/videos/galleries/${selectedGallery.id}`);
            setVideos(updatedData.videos || []);
            setEditingVideo(null);
        } catch (err) {
            console.error("Save error:", err);
            await alert("Failed to save video");
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteVideo = async (videoId: number | string) => {
        if (!selectedGallery || !await confirm("¿Eliminar este video?", "Eliminar Video", true)) return;

        try {
            await apiDelete(`/videos/galleries/${selectedGallery.id}/videos/${videoId}`);
            const updatedData = await api<any>(`/videos/galleries/${selectedGallery.id}`);
            setVideos(updatedData.videos || []);
        } catch (err) {
            console.error("Delete error:", err);
        }
    };

    // --- HELPERS ---
    const extractThumbnailPreview = (url: string): string | null => {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match?.[1]) {
                return `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`;
            }
        }
        return null;
    };

    const newVideo = (): Video => ({
        title: "",
        youtube_url: "",
        button_text: "VER EN YOUTUBE",
        description: "",
        sort_order: videos.length,
    });

    // --- RENDER ---

    if (view === 'list') {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <PageHeader
                    title="Galerías de Video"
                    subtitle="Administra tus colecciones de videos"
                    icon="fa-film"
                />

                {/* Create Modal */}
                {isCreatingGallery && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                        <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
                            <h3 className="text-xl font-bold mb-4">Nueva Galería</h3>
                            <input
                                className="w-full border p-2 rounded mb-3"
                                placeholder="Nombre de la galería"
                                value={newGalleryName}
                                onChange={e => setNewGalleryName(e.target.value)}
                            />
                            <textarea
                                className="w-full border p-2 rounded mb-4"
                                placeholder="Descripción (opcional)"
                                value={newGalleryDesc}
                                onChange={e => setNewGalleryDesc(e.target.value)}
                            />
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setIsCreatingGallery(false)} className="px-4 py-2 text-gray-600">Cancelar</button>
                                <button onClick={handleCreateGallery} disabled={!newGalleryName} className="px-4 py-2 bg-blue-600 text-white rounded">Crear</button>
                            </div>
                        </div>
                    </div>
                )}

                {loading ? (
                    <div className="text-center py-12 text-gray-500">Cargando galerías...</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {/* Add New Card */}
                        {/* Add New Card */}
                        <div
                            onClick={() => setIsCreatingGallery(true)}
                            className="bg-gray-50/50 border-2 border-dashed border-gray-300 rounded-[40px] p-6 flex flex-col items-center justify-center text-gray-400 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50/30 transition-all cursor-pointer min-h-[200px]"
                        >
                            <div className="w-16 h-16 rounded-full bg-white shadow-sm flex items-center justify-center mb-4 text-2xl group-hover:scale-110 transition-transform">
                                <i className="fa-solid fa-plus"></i>
                            </div>
                            <span className="font-bold text-lg">Nueva Galería</span>
                        </div>

                        {galleries.map(g => (
                            <Card
                                key={g.id}
                                onClick={() => openGallery(g)}
                                padding="md"
                                hoverable
                                className="group relative flex flex-col justify-between"
                            >
                                <div>
                                    <div className="flex items-center gap-3 mb-3">
                                        <div className="w-12 h-12 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-xl shrink-0">
                                            <i className="fa-solid fa-layer-group"></i>
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-lg text-gray-800 group-hover:text-blue-600 transition-colors line-clamp-1">{g.name}</h3>
                                            <p className="text-xs text-gray-500">{g.videoCount} videos</p>
                                        </div>
                                    </div>
                                    <p className="text-sm text-gray-500 line-clamp-2 mb-4">{g.description || "Sin descripción"}</p>
                                </div>

                                <button
                                    onClick={(e) => { e.stopPropagation(); deleteGallery(g.id); }}
                                    className="absolute top-4 right-4 text-gray-300 hover:text-red-500 transition-colors"
                                    title="Eliminar galería"
                                >
                                    <i className="fa-solid fa-trash"></i>
                                </button>

                                <div className="mt-auto pt-4 border-t border-gray-100 flex justify-between items-center text-sm">
                                    <span className="text-gray-400 text-xs font-mono">ID: {g.id}</span>
                                    <span className="text-blue-600 font-medium group-hover:translate-x-1 transition-transform">Gestionar &rarr;</span>
                                </div>
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // --- DETAIL VIEW ---
    return (

        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title={selectedGallery?.name || "Galería Detail"}
                subtitle="Gestionando videos de esta galería"
                icon="fa-photo-film"
                backButton={{
                    onClick: () => { setView('list'); setSelectedGallery(null); },
                    label: "Volver a Galerías"
                }}
                actions={
                    <button
                        onClick={() => setEditingVideo(newVideo())}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/20"
                    >
                        + Agregar Video
                    </button>
                }
            />

            {/* Video List Grid matches previous style */}
            {videos.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
                    <div className="text-gray-400 text-6xl mb-4"><i className="fa-solid fa-film"></i></div>
                    <p className="text-gray-500 mb-4">Esta galería está vacía.</p>
                    <button
                        onClick={() => setEditingVideo(newVideo())}
                        className="px-6 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium"
                    >
                        Agregar Video
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {videos.map((video, index) => (
                        <div
                            key={video.id}
                            draggable
                            onDragStart={() => setDraggedIndex(index)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={async (e) => {
                                e.preventDefault();
                                if (draggedIndex === null || draggedIndex === index) return;

                                // Optimistic update
                                const newVideos = [...videos];
                                const [movedVideo] = newVideos.splice(draggedIndex, 1);
                                newVideos.splice(index, 0, movedVideo);
                                setVideos(newVideos);
                                setDraggedIndex(null);

                                // API Persist
                                try {
                                    await apiPut(`/videos/galleries/${selectedGallery?.id}/reorder`, {
                                        videoIds: newVideos.map(v => v.id)
                                    });
                                } catch (err) {
                                    console.error("Failed to reorder:", err);
                                    await alert("Failed to save new order");
                                }
                            }}
                        >
                            <Card
                                padding="none"
                                className={`group overflow-hidden ${draggedIndex === index ? 'opacity-50 border-blue-400 dashed' : ''} cursor-grab active:cursor-grabbing`}
                            >
                                <div className="relative aspect-[16/9] overflow-hidden bg-gray-900">
                                    {video.thumbnail ? (
                                        <img
                                            src={video.thumbnail}
                                            alt={video.title}
                                            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-gray-700 bg-gray-100">
                                            <i className="fa-solid fa-video text-4xl opacity-50"></i>
                                        </div>
                                    )}

                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60"></div>

                                    {/* Order Badge */}
                                    <div className="absolute top-3 left-3 bg-black/50 backdrop-blur-md text-white text-xs px-2 py-1 rounded-full border border-white/20">
                                        #{index + 1}
                                    </div>

                                    {/* Hover Actions */}
                                    <div className="absolute inset-0 flex items-center justify-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300 backdrop-blur-[2px] bg-black/30">
                                        <button
                                            onClick={() => setEditingVideo(video)}
                                            className="w-12 h-12 bg-white text-blue-600 rounded-full shadow-lg hover:bg-blue-50 hover:scale-110 transition-all flex items-center justify-center"
                                            title="Editar"
                                        >
                                            <i className="fa-solid fa-pencil text-lg"></i>
                                        </button>
                                        <button
                                            onClick={() => handleDeleteVideo(video.id!)}
                                            className="w-12 h-12 bg-white text-red-500 rounded-full shadow-lg hover:bg-red-50 hover:scale-110 transition-all flex items-center justify-center"
                                            title="Eliminar"
                                        >
                                            <i className="fa-solid fa-trash-can text-lg"></i>
                                        </button>
                                    </div>
                                </div>

                                <div className="p-5">
                                    <h3 className="font-bold text-gray-900 line-clamp-2 mb-2 leading-tight h-10" title={video.title}>
                                        {video.title}
                                    </h3>

                                    <div className="flex items-center justify-between mt-4">
                                        <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded">
                                            {video.button_text || 'BOTÓN'}
                                        </span>
                                        <a
                                            href={video.youtube_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 uppercase tracking-wider"
                                        >
                                            YouTube <i className="fa-solid fa-arrow-up-right-from-square"></i>
                                        </a>
                                    </div>
                                </div>
                            </Card>
                        </div>
                    ))}
                </div>
            )}


            {/* Edit Video Modal (Modernized) */}
            {editingVideo && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-white/20">
                        {/* Header */}
                        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white">
                            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-3">
                                <span className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-lg">
                                    <i className={`fa-solid ${editingVideo.id ? 'fa-pen-to-square' : 'fa-plus'}`}></i>
                                </span>
                                {editingVideo.id ? "Editar Video" : "Nuevo Video"}
                            </h2>
                            <button
                                onClick={() => setEditingVideo(null)}
                                className="w-8 h-8 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600 flex items-center justify-center transition-colors"
                            >
                                <i className="fa-solid fa-xmark"></i>
                            </button>
                        </div>

                        <div className="p-8 overflow-y-auto max-h-[75vh] space-y-6 custom-scrollbar">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Título del Video</label>
                                <input
                                    type="text"
                                    value={editingVideo.title}
                                    onChange={(e) => setEditingVideo({ ...editingVideo, title: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all outline-none font-medium text-gray-800"
                                    placeholder="e.g. Conferencia Anual 2024"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">YouTube URL</label>
                                <div className="relative">
                                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                                        <i className="fa-brands fa-youtube text-red-500"></i>
                                    </div>
                                    <input
                                        type="url"
                                        value={editingVideo.youtube_url}
                                        onChange={(e) => setEditingVideo({ ...editingVideo, youtube_url: e.target.value })}
                                        className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all outline-none font-medium text-gray-800"
                                        placeholder="https://youtube.com/watch?v=..."
                                    />
                                </div>

                                {editingVideo.youtube_url && extractThumbnailPreview(editingVideo.youtube_url) && (
                                    <div className="mt-3 relative rounded-xl overflow-hidden aspect-video shadow-md border border-gray-100 group">
                                        <img
                                            src={extractThumbnailPreview(editingVideo.youtube_url)!}
                                            alt="Preview"
                                            className="w-full h-full object-cover"
                                        />
                                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                            <i className="fa-brands fa-youtube text-4xl text-white drop-shadow-lg"></i>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-6">
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Texto del Botón</label>
                                    <input
                                        type="text"
                                        value={editingVideo.button_text}
                                        onChange={(e) => setEditingVideo({ ...editingVideo, button_text: e.target.value })}
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                        placeholder="VER VIDEO"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Orden Manual</label>
                                    <input
                                        type="number"
                                        value={editingVideo.sort_order}
                                        onChange={(e) => setEditingVideo({ ...editingVideo, sort_order: Number(e.target.value) })}
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Descripción</label>
                                <textarea
                                    value={editingVideo.description || ""}
                                    onChange={(e) => setEditingVideo({ ...editingVideo, description: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none min-h-[100px] resize-y"
                                    placeholder="Breve descripción del contenido..."
                                />
                            </div>
                        </div>

                        <div className="p-6 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50">
                            <button
                                onClick={() => setEditingVideo(null)}
                                className="px-6 py-3 border border-gray-200 rounded-xl text-gray-600 font-medium hover:bg-white hover:border-gray-300 transition-colors shadow-sm"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSaveVideo}
                                disabled={saving || !editingVideo.title || !editingVideo.youtube_url}
                                className="px-8 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl font-bold hover:shadow-lg hover:from-blue-700 hover:to-blue-600 transition-all disabled:opacity-70 disabled:shadow-none flex items-center gap-2"
                            >
                                {saving ? (
                                    <><i className="fa-solid fa-circle-notch fa-spin"></i> Guardando...</>
                                ) : (
                                    <><i className="fa-solid fa-floppy-disk"></i> Guardar Video</>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
