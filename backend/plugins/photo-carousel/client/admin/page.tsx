// @ts-nocheck
"use client";

import { useState, useEffect } from "react";
// Removed ConfirmationModal import
import MediaPickerModal from "../../../../../frontend/src/components/MediaPickerModal";
import { useModal } from "@/contexts/ModalContext";
import { PageHeader } from "../../../../../frontend/src/components/ui/PageHeader";
import { Card } from "../../../../../frontend/src/components/ui/Card";

// Local type definitions - plugin is self-contained
interface CarouselImage {
    url: string;
    title?: string;
    description?: string;
    text?: string;
    buttonText?: string;
    buttonLink?: string;
}

interface Carousel {
    id: string;
    name: string;
    images: CarouselImage[];
    autoplay?: boolean;
    interval?: number;
    location?: string;
}

interface MediaItem {
    id: number;
    title: string;
    guid: string;
    mime_type: string;
}

// Direct API functions - no external dependencies
// Direct API functions - no external dependencies
// We use the main app's API helper to ensure auth tokens are sent
import { api } from "../../../../../frontend/src/lib/api";

const carouselsApi = {
    list: () => api<Carousel[]>('/carousels'),
    create: (data: Partial<Carousel>) => api<Carousel>('/carousels', {
        method: 'POST',
        body: data
    }),
    update: (id: string, data: Partial<Carousel>) => api<Carousel>(`/carousels/${id}`, {
        method: 'PUT',
        body: data
    }),
    delete: (id: string) => api<void>(`/carousels/${id}`, { method: 'DELETE' })
};

export default function CarouselsPage() {
    const [carousels, setCarousels] = useState<Carousel[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const { alert, confirm } = useModal();

    // Modal states
    const [isEditing, setIsEditing] = useState(false);
    const [editingCarousel, setEditingCarousel] = useState<Carousel | null>(null);
    const [isMediaPickerOpen, setIsMediaPickerOpen] = useState(false);

    // Form state
    const [formName, setFormName] = useState("");
    const [formImages, setFormImages] = useState<{
        url: string;
        title?: string;
        description?: string;
        buttonText?: string;
        buttonLink?: string;
        text?: string;
    }[]>([]);
    const [editingImageIndex, setEditingImageIndex] = useState<number | null>(null);
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [formAutoplay, setFormAutoplay] = useState(true);
    const [formInterval, setFormInterval] = useState(5000);
    const [formLocation, setFormLocation] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadCarousels();
    }, []);

    const loadCarousels = async () => {
        try {
            setError(null);
            const data = await carouselsApi.list();
            setCarousels(data);
        } catch (err: any) {
            setError("Failed to load carousels. Make sure the Photo Carousel plugin is active.");
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const openCreateModal = () => {
        setEditingCarousel(null);
        setFormName("");
        setFormImages([]);
        setFormAutoplay(true);
        setFormInterval(5000);
        setFormLocation("");
        setIsEditing(true);
    };

    const openEditModal = (carousel: Carousel) => {
        setEditingCarousel(carousel);
        setFormName(carousel.name);
        setFormImages(carousel.images || []);
        setFormAutoplay(carousel.autoplay !== false);
        setFormInterval(carousel.interval || 5000);
        setFormLocation(carousel.location || "");
        setIsEditing(true);
    };

    const handleSave = async () => {
        if (!formName.trim()) {
            await alert("Please enter a name for the carousel");
            return;
        }

        setSaving(true);
        try {
            if (editingCarousel) {
                await carouselsApi.update(editingCarousel.id, {
                    name: formName,
                    images: formImages,
                    autoplay: formAutoplay,
                    interval: formInterval,
                    location: formLocation
                });
            } else {
                await carouselsApi.create({
                    name: formName,
                    images: formImages,
                    autoplay: formAutoplay,
                    interval: formInterval,
                    location: formLocation
                });
            }
            setIsEditing(false);
            loadCarousels();
        } catch (err: any) {
            await alert("Failed to save: " + (err.message || "Unknown error"));
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!await confirm("Are you sure you want to delete this carousel? This action cannot be undone.", "Delete Carousel", true)) return;
        try {
            await carouselsApi.delete(id);
            loadCarousels();
        } catch (err: any) {
            await alert("Failed to delete: " + (err.message || "Unknown error"));
        }
    };

    const handleSelectImage = (media: MediaItem) => {
        setFormImages([...formImages, { url: media.guid, title: media.title }]);
        setIsMediaPickerOpen(false);
    };

    const updateImageDetails = (index: number, field: string, value: string) => {
        const newImages = [...formImages];
        newImages[index] = { ...newImages[index], [field]: value };
        setFormImages(newImages);
    };

    const removeImage = (index: number) => {
        setFormImages(formImages.filter((_, i) => i !== index));
    };

    const copyShortcode = async (id: string) => {
        navigator.clipboard.writeText(`[carousel id="${id}"]`);
        await alert("Shortcode copied!");
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
        );
    }

    return (
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            <PageHeader
                title="Carruseles"
                subtitle="Administra tus presentaciones de imágenes"
                icon="fa-images"
            />

            {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg mb-6">
                    <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Add New Card */}
                {/* Add New Card */}
                <div
                    onClick={openCreateModal}
                    className="bg-gray-50/50 border-2 border-dashed border-gray-300 rounded-[40px] p-6 flex flex-col items-center justify-center text-gray-400 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50/30 transition-all cursor-pointer min-h-[320px] group"
                >
                    <div className="w-16 h-16 rounded-full bg-white shadow-sm flex items-center justify-center mb-4 text-2xl group-hover:scale-110 transition-transform">
                        <i className="fa-solid fa-plus"></i>
                    </div>
                    <span className="font-bold text-lg">New Carousel</span>
                    <p className="text-sm text-gray-400 mt-2 text-center max-w-[200px]">Create a new slideshow for your page headers or content.</p>
                </div>

                {carousels.map((carousel) => (
                    <Card
                        key={carousel.id}
                        padding="none"
                        className="group flex flex-col min-h-[320px]"
                    >
                        {/* Preview */}
                        <div className="aspect-video bg-gray-900 relative overflow-hidden">
                            {carousel.images && carousel.images.length > 0 ? (
                                <img
                                    src={typeof carousel.images[0] === 'string' ? carousel.images[0] : carousel.images[0].url}
                                    alt={carousel.name}
                                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105 opacity-90 group-hover:opacity-100"
                                />
                            ) : (
                                <div className="flex items-center justify-center h-full text-gray-700">
                                    <i className="fa-regular fa-image text-4xl opacity-50"></i>
                                </div>
                            )}

                            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60"></div>

                            <div className="absolute top-2 right-2 bg-black/50 backdrop-blur-md text-white px-2 py-1 rounded-lg text-xs font-medium border border-white/10">
                                {carousel.images?.length || 0} images
                            </div>

                            {carousel.location && (
                                <div className="absolute top-2 left-2 bg-blue-600/90 backdrop-blur-md text-white px-2 py-1 rounded-lg text-xs font-bold uppercase shadow-lg">
                                    {carousel.location}
                                </div>
                            )}

                            {/* Hover Actions */}
                            <div className="absolute inset-0 flex items-center justify-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300 backdrop-blur-[2px] bg-black/20">
                                <button
                                    onClick={() => openEditModal(carousel)}
                                    className="w-10 h-10 bg-white text-blue-600 rounded-full shadow-lg hover:bg-blue-50 hover:scale-110 transition-all flex items-center justify-center"
                                    title="Edit"
                                >
                                    <i className="fa-solid fa-pencil"></i>
                                </button>
                                <button
                                    onClick={() => handleDelete(carousel.id)}
                                    className="w-10 h-10 bg-white text-red-500 rounded-full shadow-lg hover:bg-red-50 hover:scale-110 transition-all flex items-center justify-center"
                                    title="Delete"
                                >
                                    <i className="fa-solid fa-trash-can"></i>
                                </button>
                            </div>
                        </div>

                        {/* Info */}
                        <div className="p-5 flex-1 flex flex-col">
                            <h3 className="font-bold text-gray-900 text-lg mb-1">{carousel.name}</h3>
                            <div className="flex items-center gap-3 text-xs text-gray-500 mb-4">
                                <span className={`flex items-center gap-1 ${carousel.autoplay ? 'text-green-600' : 'text-gray-400'}`}>
                                    <i className={`fa-solid ${carousel.autoplay ? 'fa-play-circle' : 'fa-pause-circle'}`}></i>
                                    {carousel.autoplay ? 'Autoplay' : 'Manual'}
                                </span>
                                <span className="w-1 h-1 bg-gray-300 rounded-full"></span>
                                <span>{(carousel.interval || 5000) / 1000}s interval</span>
                            </div>

                            <div className="mt-auto pt-4 border-t border-gray-100">
                                <div
                                    className="bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-200 rounded-lg p-2 text-xs font-mono text-gray-500 hover:text-blue-700 cursor-pointer transition-colors flex justify-between items-center group/code"
                                    onClick={() => copyShortcode(carousel.id)}
                                    title="Click to copy shortcode"
                                >
                                    <span className="truncate flex-1">[carousel id="{carousel.id}"]</span>
                                    <i className="fa-regular fa-copy opacity-0 group-hover/code:opacity-100 transition-opacity"></i>
                                </div>
                            </div>
                        </div>
                    </Card>
                ))}
            </div>

            {/* Edit/Create Modal */}
            {
                isEditing && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="bg-white rounded-[40px] shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-white/20">
                            {/* Header */}
                            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white">
                                <h2 className="text-xl font-bold text-gray-800 flex items-center gap-3">
                                    <span className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-lg">
                                        <i className={`fa-solid ${editingCarousel ? 'fa-pen-to-square' : 'fa-plus'}`}></i>
                                    </span>
                                    {editingCarousel ? 'Edit Carousel' : 'New Carousel'}
                                </h2>
                                <button
                                    onClick={() => setIsEditing(false)}
                                    className="w-8 h-8 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600 flex items-center justify-center transition-colors"
                                >
                                    <i className="fa-solid fa-xmark"></i>
                                </button>
                            </div>

                            <div className="p-8 overflow-y-auto space-y-8 custom-scrollbar">
                                {/* Name */}
                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Name</label>
                                    <input
                                        type="text"
                                        value={formName}
                                        onChange={(e) => setFormName(e.target.value)}
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all outline-none font-medium text-gray-800 placeholder:text-gray-400"
                                        placeholder="e.g. Homepage Hero"
                                    />
                                </div>

                                {/* Images */}
                                <div>
                                    <div className="flex justify-between items-center mb-3">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide">Images ({formImages.length})</label>
                                        <span className="text-xs text-gray-400">Drag to reorder</span>
                                    </div>

                                    <div className="grid grid-cols-4 gap-4 mb-4">
                                        {formImages.map((img, index) => (
                                            <div
                                                key={index}
                                                draggable
                                                onDragStart={() => setDraggedIndex(index)}
                                                onDragOver={(e) => {
                                                    e.preventDefault(); // Necessary to allow dropping
                                                }}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    if (draggedIndex === null || draggedIndex === index) return;

                                                    const newImages = [...formImages];
                                                    const [movedItem] = newImages.splice(draggedIndex, 1);
                                                    newImages.splice(index, 0, movedItem);

                                                    setFormImages(newImages);
                                                    setDraggedIndex(null);
                                                }}
                                                className={`relative aspect-square rounded-2xl overflow-hidden border-2 cursor-grab active:cursor-grabbing group transition-all ${editingImageIndex === index ? 'border-blue-500 ring-4 ring-blue-500/10' : 'border-gray-100 hover:border-blue-300'} ${draggedIndex === index ? 'opacity-50' : ''}`}
                                                onClick={() => setEditingImageIndex(index)}
                                            >
                                                <img src={img.url} alt="" className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />

                                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                                    <i className="fa-solid fa-pen text-white opacity-0 group-hover:opacity-100 drop-shadow-md transform scale-50 group-hover:scale-100 transition-all duration-300"></i>
                                                </div>

                                                <button
                                                    onClick={(e) => { e.stopPropagation(); removeImage(index); }}
                                                    className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-lg hover:scale-110 z-10 flex items-center justify-center text-xs"
                                                    title="Remove image"
                                                >
                                                    <i className="fa-solid fa-xmark"></i>
                                                </button>

                                                <div className="absolute bottom-1 right-1 bg-black/50 backdrop-blur-sm text-white text-[10px] px-1.5 py-0.5 rounded font-mono opacity-60">
                                                    #{index + 1}
                                                </div>
                                            </div>
                                        ))}
                                        <button
                                            onClick={() => setIsMediaPickerOpen(true)}
                                            className="aspect-square rounded-2xl border-2 border-dashed border-gray-300 hover:border-blue-500 hover:bg-blue-50/30 flex flex-col items-center justify-center gap-2 text-gray-400 hover:text-blue-600 transition-all group"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-gray-100 group-hover:bg-blue-100 flex items-center justify-center transition-colors">
                                                <i className="fa-solid fa-plus text-lg"></i>
                                            </div>
                                            <span className="text-xs font-bold uppercase tracking-wide">Add Image</span>
                                        </button>
                                    </div>

                                    {/* Image Details Editor */}
                                    {editingImageIndex !== null && formImages[editingImageIndex] && (
                                        <div className="bg-gray-50/80 p-5 rounded-2xl border border-gray-200 animate-in fade-in slide-in-from-top-2 relative">
                                            <div className="absolute -top-3 left-6 w-6 h-6 bg-gray-50 border-t border-l border-gray-200 transform rotate-45"></div>

                                            <div className="flex justify-between items-center mb-4 relative z-10">
                                                <div className="flex items-center gap-2">
                                                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold">
                                                        {editingImageIndex + 1}
                                                    </span>
                                                    <h4 className="font-bold text-gray-800 text-sm">Image Details</h4>
                                                </div>
                                                <button onClick={() => setEditingImageIndex(null)} className="text-gray-400 hover:text-gray-600 text-sm font-medium hover:underline">
                                                    Done
                                                </button>
                                            </div>

                                            <div className="space-y-4 relative z-10">
                                                <div>
                                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Big Title</label>
                                                    <input
                                                        type="text"
                                                        value={formImages[editingImageIndex].title || ''}
                                                        onChange={(e) => updateImageDetails(editingImageIndex, 'title', e.target.value)}
                                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                                        placeholder="e.g. CONFERENCIAS"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Subtitle</label>
                                                    <input
                                                        type="text"
                                                        value={formImages[editingImageIndex].description || ''}
                                                        onChange={(e) => updateImageDetails(editingImageIndex, 'description', e.target.value)}
                                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                                        placeholder="e.g. BUCARAMANGA"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Paragraph Text</label>
                                                    <textarea
                                                        value={formImages[editingImageIndex].text || ''}
                                                        onChange={(e) => updateImageDetails(editingImageIndex, 'text', e.target.value)}
                                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm h-20 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none resize-none"
                                                        placeholder="Detailed description or message..."
                                                    />
                                                </div>
                                                <div className="grid grid-cols-2 gap-4">
                                                    <div>
                                                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Button Text</label>
                                                        <input
                                                            type="text"
                                                            value={formImages[editingImageIndex].buttonText || ''}
                                                            onChange={(e) => updateImageDetails(editingImageIndex, 'buttonText', e.target.value)}
                                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                                            placeholder="Button Label"
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="block text-xs font-bold text-gray-400 uppercase mb-1.5">Button Link</label>
                                                        <input
                                                            type="text"
                                                            value={formImages[editingImageIndex].buttonLink || ''}
                                                            onChange={(e) => updateImageDetails(editingImageIndex, 'buttonLink', e.target.value)}
                                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                                            placeholder="/url-path"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* Settings */}
                                <div className="grid grid-cols-2 gap-6 bg-gray-50 rounded-2xl p-6 border border-gray-100">
                                    <div className="col-span-2">
                                        <h4 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
                                            <i className="fa-solid fa-sliders text-blue-500"></i> Settings
                                        </h4>
                                    </div>
                                    <div className="col-span-2 md:col-span-1">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Location</label>
                                        <div className="relative">
                                            <select
                                                value={formLocation}
                                                onChange={(e) => setFormLocation(e.target.value)}
                                                className="w-full appearance-none px-4 py-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none font-medium text-gray-700"
                                            >
                                                <option value="">None (Shortcode usage)</option>
                                                <option value="hero">Hero (Homepage)</option>
                                            </select>
                                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-gray-500">
                                                <i className="fa-solid fa-chevron-down text-xs"></i>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="col-span-2 md:col-span-1">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Autoplay</label>
                                        <div className="relative">
                                            <select
                                                value={formAutoplay ? "true" : "false"}
                                                onChange={(e) => setFormAutoplay(e.target.value === "true")}
                                                className="w-full appearance-none px-4 py-3 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none font-medium text-gray-700"
                                            >
                                                <option value="true">Enabled</option>
                                                <option value="false">Disabled</option>
                                            </select>
                                            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-gray-500">
                                                <i className="fa-solid fa-chevron-down text-xs"></i>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="col-span-2 md:col-span-2">
                                        <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Interval</label>
                                        <div className="flex gap-4 items-center">
                                            <input
                                                type="range"
                                                min="1000"
                                                max="10000"
                                                step="500"
                                                value={formInterval}
                                                onChange={(e) => setFormInterval(parseInt(e.target.value))}
                                                className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                            />
                                            <span className="font-mono text-sm bg-white px-3 py-1 rounded-lg border border-gray-200 w-20 text-center">
                                                {formInterval}ms
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="p-6 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50">
                                <button
                                    onClick={() => setIsEditing(false)}
                                    className="px-6 py-3 border border-gray-200 rounded-xl text-gray-600 font-medium hover:bg-white hover:border-gray-300 transition-colors shadow-sm"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-8 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl font-bold hover:shadow-lg hover:from-blue-700 hover:to-blue-600 transition-all disabled:opacity-70 disabled:shadow-none flex items-center gap-2"
                                >
                                    {saving ? (
                                        <><i className="fa-solid fa-circle-notch fa-spin"></i> Saving...</>
                                    ) : (
                                        <><i className="fa-solid fa-floppy-disk"></i> Save Carousel</>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Media Picker */}
            <MediaPickerModal
                isOpen={isMediaPickerOpen}
                onClose={() => setIsMediaPickerOpen(false)}
                onSelect={handleSelectImage}
            />


        </div >
    );
}
