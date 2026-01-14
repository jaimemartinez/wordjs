// @ts-nocheck
"use client";

import { useState, useEffect } from "react";
import ConfirmationModal from "../../../../../admin-next/src/components/ConfirmationModal";
import MediaPickerModal from "../../../../../admin-next/src/components/MediaPickerModal";

const API_BASE = "http://localhost:3000/api/v1";

// Types
interface Card {
    title: string;
    subtitle?: string;
    location?: string;
    dates?: string;
    image?: string;
    buttonText?: string;
    buttonLink?: string;
    order?: number;
}

interface Gallery {
    id: string;
    name: string;
    cards: Card[];
    location?: string;
    cardCount?: number;
}

// API functions
const galleriesApi = {
    list: async (): Promise<Gallery[]> => {
        const token = localStorage.getItem("wordjs_token");
        const res = await fetch(`${API_BASE}/card-galleries`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            console.error("Gallery List Error:", res.status, res.statusText, await res.text());
            throw new Error(`Failed to load galleries: ${res.status} ${res.statusText}`);
        }
        return res.json();
    },
    get: async (id: string): Promise<Gallery> => {
        const token = localStorage.getItem("wordjs_token");
        const res = await fetch(`${API_BASE}/card-galleries/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Gallery not found");
        return res.json();
    },
    create: async (data: { name: string; cards?: Card[] }): Promise<Gallery> => {
        const token = localStorage.getItem("wordjs_token");
        const res = await fetch(`${API_BASE}/card-galleries`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error("Failed to create gallery");
        return res.json();
    },
    update: async (id: string, data: Partial<Gallery>): Promise<Gallery> => {
        const token = localStorage.getItem("wordjs_token");
        const res = await fetch(`${API_BASE}/card-galleries/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(data)
        });
        if (!res.ok) throw new Error("Failed to update gallery");
        return res.json();
    },
    delete: async (id: string): Promise<void> => {
        const token = localStorage.getItem("wordjs_token");
        const res = await fetch(`${API_BASE}/card-galleries/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Failed to delete gallery");
    }
};

export default function CardGalleryAdminPage() {
    // View State
    const [view, setView] = useState<'list' | 'detail'>('list');

    // Data State
    const [galleries, setGalleries] = useState<Gallery[]>([]);
    const [selectedGallery, setSelectedGallery] = useState<Gallery | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Gallery CRUD
    const [isCreatingGallery, setIsCreatingGallery] = useState(false);
    const [newGalleryName, setNewGalleryName] = useState("");

    // Card CRUD
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [editingCardIndex, setEditingCardIndex] = useState<number | null>(null); // Index or null
    const [isNewCard, setIsNewCard] = useState(false);
    const [cardForm, setCardForm] = useState<Card>({ title: "" });
    const [isMediaPickerOpen, setIsMediaPickerOpen] = useState(false);

    // Delete confirmation
    const [deleteTarget, setDeleteTarget] = useState<{ type: "gallery" | "card"; galleryId: string; cardIndex?: number } | null>(null);

    useEffect(() => {
        loadGalleries();
    }, []);

    const loadGalleries = async () => {
        setLoading(true);
        try {
            const data = await galleriesApi.list();
            setGalleries(data);
        } catch (err: any) {
            console.error("Failed to load galleries", err);
        } finally {
            setLoading(false);
        }
    };

    const loadGallery = async (id: string) => {
        try {
            const data = await galleriesApi.get(id);
            setSelectedGallery(data);
            setView('detail');
        } catch (err) {
            console.error("Failed to load gallery:", err);
        }
    };

    const handleCreateGallery = async () => {
        if (!newGalleryName.trim()) return;
        try {
            const newGallery = await galleriesApi.create({ name: newGalleryName, cards: [] });
            setGalleries([...galleries, newGallery]);
            setIsCreatingGallery(false);
            setNewGalleryName("");
            loadGallery(newGallery.id); // Open it immediately
        } catch (err) {
            console.error("Failed to create gallery:", err);
            alert("Failed to create gallery");
        }
    };

    const handleDeleteGallery = async () => {
        if (!deleteTarget || deleteTarget.type !== "gallery") return;
        try {
            await galleriesApi.delete(deleteTarget.galleryId);
            setGalleries(galleries.filter(g => g.id !== deleteTarget.galleryId));
            if (selectedGallery?.id === deleteTarget.galleryId) {
                setView('list');
                setSelectedGallery(null);
            }
        } catch (err) {
            console.error(err);
            alert("Failed to delete gallery");
        } finally {
            setDeleteTarget(null);
        }
    };

    // --- CARD MANAGEMENT ---

    const openCardEditor = (index?: number) => {
        if (index !== undefined && selectedGallery) {
            setEditingCardIndex(index);
            setIsNewCard(false);
            setCardForm({ ...selectedGallery.cards[index] });
        } else {
            setEditingCardIndex(null);
            setIsNewCard(true);
            setCardForm({
                title: "",
                subtitle: "",
                dates: "",
                image: "",
                buttonText: "INSCRÍBETE AQUÍ",
                buttonLink: "",
                // order: selectedGallery?.cards.length || 0 // Order handled by array position
            });
        }
    };

    const saveCard = async () => {
        if (!selectedGallery || !cardForm.title) return;
        setSaving(true);

        const updatedCards = [...selectedGallery.cards];
        if (isNewCard) {
            updatedCards.push(cardForm);
        } else if (editingCardIndex !== null) {
            updatedCards[editingCardIndex] = cardForm;
        }

        try {
            const updatedGallery = await galleriesApi.update(selectedGallery.id, {
                cards: updatedCards
            });
            setSelectedGallery(updatedGallery);

            // Update list too
            setGalleries(galleries.map(g => g.id === updatedGallery.id ? updatedGallery : g));

            setEditingCardIndex(null);
            setIsNewCard(false);
        } catch (err) {
            console.error("Failed to save card:", err);
            alert("Failed to save card");
        } finally {
            setSaving(false);
        }
    };

    const deleteCard = async () => {
        if (!deleteTarget || deleteTarget.type !== "card" || !selectedGallery) return;
        setSaving(true);

        const updatedCards = selectedGallery.cards.filter((_, i) => i !== deleteTarget.cardIndex);

        try {
            const updatedGallery = await galleriesApi.update(selectedGallery.id, {
                cards: updatedCards
            });
            setSelectedGallery(updatedGallery);
            setGalleries(galleries.map(g => g.id === updatedGallery.id ? updatedGallery : g));
        } catch (err) {
            console.error("Failed to delete card:", err);
            alert("Failed to delete card");
        } finally {
            setDeleteTarget(null);
            setSaving(false);
        }
    };

    const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
        e.preventDefault();
        if (draggedIndex === null || draggedIndex === targetIndex || !selectedGallery) return;

        const newCards = [...selectedGallery.cards];
        const [movedCard] = newCards.splice(draggedIndex, 1);
        newCards.splice(targetIndex, 0, movedCard);

        // Optimistic update
        setSelectedGallery({ ...selectedGallery, cards: newCards });
        setDraggedIndex(null);

        // Save to API
        try {
            await galleriesApi.update(selectedGallery.id, { cards: newCards });
        } catch (err) {
            console.error("Failed to save reorder:", err);
            // Revert on error would be ideal here
            alert("Failed to save new order");
        }
    };


    // --- RENDERING ---

    if (view === 'list') {
        return (
            <div className="p-6 h-full overflow-auto">
                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
                        <i className="fa-solid fa-images text-blue-600"></i> Galerías de Tarjetas
                    </h1>
                </div>

                {/* Create Modal */}
                {isCreatingGallery && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-in fade-in duration-200">
                        <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
                            <h3 className="text-xl font-bold mb-4">Nueva Galería</h3>
                            <input
                                className="w-full border p-3 rounded-xl mb-4 focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="Nombre de la galería"
                                value={newGalleryName}
                                onChange={e => setNewGalleryName(e.target.value)}
                                autoFocus
                            />
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setIsCreatingGallery(false)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
                                <button onClick={handleCreateGallery} disabled={!newGalleryName} className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium">Crear</button>
                            </div>
                        </div>
                    </div>
                )}

                {loading ? (
                    <div className="text-center py-12 text-gray-400">
                        <i className="fa-solid fa-circle-notch fa-spin text-3xl mb-3"></i>
                        <p>Cargando galerías...</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {/* New Gallery Card */}
                        <div
                            onClick={() => setIsCreatingGallery(true)}
                            className="bg-gray-50/50 border-2 border-dashed border-gray-300 rounded-2xl p-6 flex flex-col items-center justify-center text-gray-400 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50/30 transition-all cursor-pointer min-h-[200px]"
                        >
                            <div className="w-16 h-16 rounded-full bg-white shadow-sm flex items-center justify-center mb-4 text-2xl group-hover:scale-110 transition-transform">
                                <i className="fa-solid fa-plus"></i>
                            </div>
                            <span className="font-bold text-lg">Nueva Galería</span>
                        </div>

                        {galleries.map(g => (
                            <div
                                key={g.id}
                                onClick={() => loadGallery(g.id)}
                                className="bg-white border hover:border-blue-400 border-gray-200 rounded-2xl p-6 shadow-sm hover:shadow-xl transition-all cursor-pointer group relative flex flex-col justify-between min-h-[200px]"
                            >
                                <div>
                                    <div className="flex items-center gap-3 mb-4">
                                        <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-xl shrink-0">
                                            <i className="fa-solid fa-layer-group"></i>
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-lg text-gray-800 group-hover:text-blue-600 transition-colors line-clamp-1">{g.name}</h3>
                                            <p className="text-xs text-gray-500 font-medium">{(g.cards || []).length} tarjetas</p>
                                        </div>
                                    </div>
                                    <p className="text-sm text-gray-500 line-clamp-2">{g.location || "Sin ubicación definida"}</p>
                                </div>

                                <button
                                    onClick={(e) => { e.stopPropagation(); setDeleteTarget({ type: 'gallery', galleryId: g.id }); }}
                                    className="absolute top-4 right-4 text-gray-300 hover:text-red-500 transition-colors w-8 h-8 flex items-center justify-center rounded-full hover:bg-red-50"
                                    title="Eliminar galería"
                                >
                                    <i className="fa-solid fa-trash"></i>
                                </button>

                                <div className="mt-auto pt-4 border-t border-gray-100 flex justify-between items-center text-sm">
                                    <span className="text-gray-400 text-xs font-mono opacity-50">ID: {g.id}</span>
                                    <span className="text-blue-600 font-medium group-hover:translate-x-1 transition-transform flex items-center gap-1">
                                        Gestionar <i className="fa-solid fa-arrow-right"></i>
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // --- DETAIL VIEW ---
    return (
        <div className="p-6 h-full overflow-auto">
            {/* Header */}
            <div className="flex items-center gap-4 mb-8">
                <button
                    onClick={() => { setView('list'); setSelectedGallery(null); }}
                    className="w-10 h-10 rounded-full bg-white border border-gray-200 text-gray-500 hover:text-gray-800 hover:shadow-md transition-all flex items-center justify-center"
                >
                    <i className="fa-solid fa-arrow-left"></i>
                </button>
                <div>
                    <h1 className="text-2xl font-bold text-gray-800">{selectedGallery?.name}</h1>
                    <p className="text-sm text-gray-500">Gestionando tarjetas</p>
                </div>
                <div className="ml-auto">
                    <button
                        onClick={() => openCardEditor()}
                        className="px-5 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20 font-medium flex items-center gap-2"
                    >
                        <i className="fa-solid fa-plus"></i> Agregar Tarjeta
                    </button>
                </div>
            </div>

            {/* Cards Grid */}
            {!selectedGallery?.cards || selectedGallery.cards.length === 0 ? (
                <div className="text-center py-20 bg-gray-50 rounded-3xl border-2 border-dashed border-gray-200">
                    <div className="text-gray-300 text-7xl mb-6"><i className="fa-solid fa-images"></i></div>
                    <h3 className="text-xl font-bold text-gray-700 mb-2">Esta galería está vacía</h3>
                    <p className="text-gray-500 mb-6">Agrega tarjetas para mostrar contenido visual atractivo.</p>
                    <button
                        onClick={() => openCardEditor()}
                        className="px-6 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium"
                    >
                        Comenzar
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {selectedGallery.cards.map((card, index) => (
                        <div
                            key={index}
                            draggable
                            onDragStart={() => setDraggedIndex(index)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => handleDrop(e, index)}
                            className={`bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-xl transition-all duration-300 group border border-gray-100 flex flex-col cursor-move ${draggedIndex === index ? 'opacity-40 ring-2 ring-blue-500 border-transparent' : ''}`}
                        >
                            {/* Card Image area */}
                            <div className="relative aspect-video bg-gray-100 overflow-hidden">
                                {card.image ? (
                                    <img src={card.image} alt={card.title} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300 text-4xl">
                                        <i className="fa-solid fa-image"></i>
                                    </div>
                                )}

                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3 backdrop-blur-[2px]">
                                    <button
                                        onClick={() => openCardEditor(index)}
                                        className="w-10 h-10 rounded-full bg-white text-blue-600 shadow-lg hover:scale-110 transition-transform flex items-center justify-center"
                                        title="Editar"
                                    >
                                        <i className="fa-solid fa-pencil"></i>
                                    </button>
                                    <button
                                        onClick={() => setDeleteTarget({ type: 'card', galleryId: selectedGallery.id, cardIndex: index })}
                                        className="w-10 h-10 rounded-full bg-white text-red-500 shadow-lg hover:scale-110 transition-transform flex items-center justify-center"
                                        title="Eliminar"
                                    >
                                        <i className="fa-solid fa-trash"></i>
                                    </button>
                                </div>

                                <div className="absolute top-2 left-2 bg-black/60 backdrop-blur text-white text-[10px] px-2 py-0.5 rounded-md font-mono">
                                    #{index + 1}
                                </div>
                            </div>

                            {/* Card Content */}
                            <div className="p-5 flex flex-col flex-1">
                                <h3 className="font-bold text-gray-800 line-clamp-1 mb-1" title={card.title}>{card.title}</h3>
                                {card.subtitle && <p className="text-sm text-gray-500 mb-2 line-clamp-1">{card.subtitle}</p>}

                                <div className="mt-auto pt-3 flex items-center justify-between border-t border-gray-50">
                                    <div className="flex flex-col">
                                        {card.dates && (
                                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                                <i className="fa-regular fa-calendar mr-1"></i> {card.dates}
                                            </span>
                                        )}
                                    </div>
                                    {card.buttonText && (
                                        <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded font-medium">
                                            BTN: {card.buttonText}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Edit Card Modal (Modernized) */}
            {(isNewCard || editingCardIndex !== null) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 border border-white/20 max-h-[90vh]">

                        {/* Header */}
                        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-white sticky top-0 z-10">
                            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-3">
                                <span className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center text-lg">
                                    <i className={`fa-solid ${isNewCard ? 'fa-plus' : 'fa-pen-to-square'}`}></i>
                                </span>
                                {isNewCard ? "Nueva Tarjeta" : "Editar Tarjeta"}
                            </h2>
                            <button
                                onClick={() => { setEditingCardIndex(null); setIsNewCard(false); }}
                                className="w-8 h-8 rounded-full bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600 flex items-center justify-center transition-colors"
                            >
                                <i className="fa-solid fa-xmark"></i>
                            </button>
                        </div>

                        <div className="p-8 overflow-y-auto space-y-6 custom-scrollbar">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="col-span-1 md:col-span-2">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Título *</label>
                                    <input
                                        type="text"
                                        value={cardForm.title || ""}
                                        onChange={(e) => setCardForm({ ...cardForm, title: e.target.value })}
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none font-medium text-lg"
                                        placeholder="Nombre del evento o tarjeta"
                                    />
                                </div>

                                <div className="col-span-1 md:col-span-2">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Subtítulo</label>
                                    <input
                                        type="text"
                                        value={cardForm.subtitle || ""}
                                        onChange={(e) => setCardForm({ ...cardForm, subtitle: e.target.value })}
                                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                        placeholder="Ubicación o detalle corto"
                                    />
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Fechas</label>
                                    <div className="relative">
                                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                                            <i className="fa-regular fa-calendar text-gray-400"></i>
                                        </div>
                                        <input
                                            type="text"
                                            value={cardForm.dates || ""}
                                            onChange={(e) => setCardForm({ ...cardForm, dates: e.target.value })}
                                            className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none"
                                            placeholder="Ej: 15-18 ENE 2026"
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Imagen</label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={cardForm.image || ""}
                                            onChange={(e) => setCardForm({ ...cardForm, image: e.target.value })}
                                            className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none text-sm text-gray-600"
                                            placeholder="URL de imagen"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setIsMediaPickerOpen(true)}
                                            className="px-4 bg-gray-100 hover:bg-blue-50 text-gray-600 hover:text-blue-600 rounded-xl border border-gray-200 transition-colors"
                                        >
                                            <i className="fa-solid fa-image"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Image Preview */}
                            {cardForm.image && (
                                <div className="rounded-xl overflow-hidden shadow-md border border-gray-100 h-48 w-full bg-gray-50 relative group">
                                    <img src={cardForm.image} alt="Preview" className="w-full h-full object-cover" />
                                    <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded">Vista Previa</div>
                                </div>
                            )}

                            <div className="p-4 bg-gray-50/80 rounded-2xl border border-gray-100">
                                <h4 className="text-sm font-bold text-gray-700 mb-3 flex items-center gap-2">
                                    <i className="fa-solid fa-link text-blue-500"></i> Acción del Botón
                                </h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Texto</label>
                                        <input
                                            type="text"
                                            value={cardForm.buttonText || ""}
                                            onChange={(e) => setCardForm({ ...cardForm, buttonText: e.target.value })}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                                            placeholder="INSCRÍBETE"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Enlace</label>
                                        <input
                                            type="text"
                                            value={cardForm.buttonLink || ""}
                                            onChange={(e) => setCardForm({ ...cardForm, buttonLink: e.target.value })}
                                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg focus:ring-1 focus:ring-blue-500 outline-none"
                                            placeholder="https://..."
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border-t border-gray-100 flex justify-end gap-3 bg-gray-50/50 sticky bottom-0">
                            <button
                                onClick={() => { setEditingCardIndex(null); setIsNewCard(false); }}
                                className="px-6 py-3 border border-gray-200 rounded-xl text-gray-600 font-medium hover:bg-white hover:border-gray-300 transition-colors shadow-sm"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={saveCard}
                                disabled={saving || !cardForm.title}
                                className="px-8 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl font-bold hover:shadow-lg hover:from-blue-700 hover:to-blue-600 transition-all disabled:opacity-70 disabled:shadow-none flex items-center gap-2"
                            >
                                {saving ? (
                                    <><i className="fa-solid fa-circle-notch fa-spin"></i> Guardando...</>
                                ) : (
                                    <><i className="fa-solid fa-floppy-disk"></i> Guardar Tarjeta</>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Media Picker */}
            <MediaPickerModal
                isOpen={isMediaPickerOpen}
                onClose={() => setIsMediaPickerOpen(false)}
                onSelect={(item) => {
                    setCardForm({ ...cardForm, image: item.guid });
                    setIsMediaPickerOpen(false);
                }}
            />

            {/* Delete Confirmation */}
            <ConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={deleteTarget?.type === "gallery" ? handleDeleteGallery : deleteCard}
                title={deleteTarget?.type === "gallery" ? "Eliminar Galería" : "Eliminar Tarjeta"}
                message={
                    deleteTarget?.type === "gallery"
                        ? "¿Estás seguro de que deseas eliminar esta galería y todas sus tarjetas?"
                        : "¿Estás seguro de que deseas eliminar esta tarjeta?"
                }
                confirmText="Eliminar"
                isDanger={true}
            />
        </div>
    );
}


