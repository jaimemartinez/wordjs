// @ts-nocheck
"use client";

import { useState, useEffect } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import MediaPickerModal from "../../../../../frontend/src/components/MediaPickerModal";
import { useModal } from "@/contexts/ModalContext";

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
        return api<Gallery[]>("/card-galleries");
    },
    get: async (id: string): Promise<Gallery> => {
        return api<Gallery>(`/card-galleries/${id}`);
    },
    create: async (data: { name: string; cards?: Card[] }): Promise<Gallery> => {
        return apiPost<Gallery>("/card-galleries", data);
    },
    update: async (id: string, data: Partial<Gallery>): Promise<Gallery> => {
        return apiPut<Gallery>(`/card-galleries/${id}`, data);
    },
    delete: async (id: string): Promise<void> => {
        return apiDelete(`/card-galleries/${id}`);
    }
};

export default function CardGalleryAdminPage() {
    // View State
    const [view, setView] = useState<'list' | 'detail'>('list');
    const { alert, confirm } = useModal();

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
            await alert("Failed to create gallery");
        }
    };

    const handleDeleteGallery = async (id: string) => {
        if (!await confirm("Are you sure you want to delete this gallery and all its cards?", "Delete Gallery", true)) return;
        try {
            await galleriesApi.delete(id);
            setGalleries(galleries.filter(g => g.id !== id));
            if (selectedGallery?.id === id) {
                setView('list');
                setSelectedGallery(null);
            }
        } catch (err) {
            console.error(err);
            await alert("Failed to delete gallery");
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
            await alert("Failed to save card");
        } finally {
            setSaving(false);
        }
    };

    const deleteCard = async (index: number) => {
        if (!selectedGallery) return;
        if (!await confirm("Are you sure you want to delete this card?", "Delete Card", true)) return;

        setSaving(true);

        const updatedCards = selectedGallery.cards.filter((_, i) => i !== index);

        try {
            const updatedGallery = await galleriesApi.update(selectedGallery.id, {
                cards: updatedCards
            });
            setSelectedGallery(updatedGallery);
            setGalleries(galleries.map(g => g.id === updatedGallery.id ? updatedGallery : g));
        } catch (err) {
            console.error("Failed to delete card:", err);
            await alert("Failed to delete card");
        } finally {
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
            await alert("Failed to save new order");
        }
    };


    // --- RENDERING ---

    if (view === 'list') {
        return (
            <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
                    <div>
                        <h1 className="text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter mb-2 flex items-center gap-3">
                            <i className="fa-solid fa-images text-blue-600 text-3xl"></i> Galerías de Tarjetas
                        </h1>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            Administra tus colecciones de tarjetas
                        </p>
                    </div>
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
                            className="bg-white border-2 border-dashed border-gray-200 rounded-[40px] p-8 flex flex-col items-center justify-center text-gray-400 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50/10 transition-all cursor-pointer min-h-[240px] group shadow-sm hover:shadow-xl"
                        >
                            <div className="w-20 h-20 rounded-3xl bg-gray-50 group-hover:bg-blue-600 text-gray-400 group-hover:text-white flex items-center justify-center mb-6 text-3xl shadow-inner group-hover:shadow-lg transition-all duration-300 transform group-hover:scale-110 group-hover:-rotate-3">
                                <i className="fa-solid fa-plus"></i>
                            </div>
                            <span className="font-black text-lg uppercase tracking-wide group-hover:tracking-widest transition-all">Nueva Galería</span>
                        </div>

                        {galleries.map(g => (
                            <div
                                key={g.id}
                                onClick={() => loadGallery(g.id)}
                                className="bg-white border-2 border-gray-50 rounded-[40px] p-8 shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 hover:-translate-y-1 transition-all duration-300 cursor-pointer group relative flex flex-col justify-between min-h-[240px] overflow-hidden"
                            >
                                <div className="absolute top-0 right-0 w-32 h-32 bg-gray-50 rounded-full blur-[40px] -mr-16 -mt-16 transition-opacity opacity-50 group-hover:opacity-100"></div>

                                <div className="relative z-10">
                                    <div className="flex items-start justify-between mb-6">
                                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center text-2xl shadow-lg shadow-blue-200 group-hover:scale-110 transition-transform duration-500">
                                            <i className="fa-solid fa-layer-group"></i>
                                        </div>
                                        <div className="text-right">
                                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-300 block">Tarjetas</span>
                                            <span className="text-2xl font-black text-gray-900 leading-none">{(g.cards || []).length}</span>
                                        </div>
                                    </div>

                                    <div className="mb-4">
                                        <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter group-hover:text-blue-600 transition-colors line-clamp-1 mb-1">{g.name}</h3>
                                        <p className="text-xs font-bold text-gray-400 uppercase tracking-widest line-clamp-1 flex items-center gap-1">
                                            <i className="fa-solid fa-location-dot text-[10px]"></i> {g.location || "Sin ubicación"}
                                        </p>
                                    </div>
                                </div>

                                <button
                                    onClick={(e) => { e.stopPropagation(); handleDeleteGallery(g.id); }}
                                    className="absolute bottom-6 right-6 w-10 h-10 rounded-xl bg-gray-50 text-gray-300 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all z-20 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 duration-300 hover:shadow-lg hover:shadow-red-200"
                                    title="Eliminar galería"
                                >
                                    <i className="fa-solid fa-trash text-sm"></i>
                                </button>

                                <div className="mt-auto pt-4 border-t border-gray-100/50 flex items-center text-sm relative z-10">
                                    <span className="text-blue-600 font-bold uppercase text-[10px] tracking-widest group-hover:translate-x-1 transition-transform flex items-center gap-2">
                                        Gestionar Galería <i className="fa-solid fa-arrow-right"></i>
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
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 min-h-full animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
                <div className="flex items-center gap-6">
                    <button
                        onClick={() => { setView('list'); setSelectedGallery(null); }}
                        className="w-12 h-12 rounded-2xl bg-white border border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-200 hover:shadow-lg transition-all flex items-center justify-center group"
                    >
                        <i className="fa-solid fa-arrow-left group-hover:-translate-x-1 transition-transform"></i>
                    </button>
                    <div>
                        <h1 className="text-4xl font-black text-gray-900 italic tracking-tighter mb-1">{selectedGallery?.name}</h1>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            Gestionando tarjetas
                        </p>
                    </div>
                </div>
                <div>
                    <button
                        onClick={() => openCardEditor()}
                        className="px-8 py-4 bg-blue-600 text-white rounded-2xl hover:bg-blue-700 transition-all shadow-xl shadow-blue-200 hover:shadow-blue-500/30 flex items-center gap-3 transform hover:-translate-y-1 active:scale-95 group"
                    >
                        <i className="fa-solid fa-plus text-sm group-hover:rotate-90 transition-transform"></i>
                        <span className="font-black text-[10px] uppercase tracking-widest">Agregar Tarjeta</span>
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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
                    {selectedGallery.cards.map((card, index) => (
                        <div
                            key={index}
                            draggable
                            onDragStart={() => setDraggedIndex(index)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => handleDrop(e, index)}
                            className={`bg-white rounded-[32px] overflow-hidden shadow-xl shadow-gray-100/50 hover:shadow-2xl hover:shadow-blue-500/10 transition-all duration-300 group border-2 border-transparent hover:border-blue-100 flex flex-col cursor-grab active:cursor-grabbing relative ${draggedIndex === index ? 'opacity-50 scale-95 ring-4 ring-blue-500/20 rotate-1 grayscale' : 'hover:-translate-y-1 hover:rotate-1'}`}
                        >
                            {/* Drag Handle Indicator (Visible on Hover) */}
                            <div className="absolute top-4 right-4 z-20 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 backdrop-blur rounded-full p-2 shadow-sm text-gray-400">
                                <i className="fa-solid fa-grip-vertical"></i>
                            </div>

                            {/* Card Image area */}
                            <div className="relative aspect-video bg-gray-100 overflow-hidden">
                                {card.image ? (
                                    <img src={card.image} alt={card.title} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300 bg-gray-50 text-4xl">
                                        <i className="fa-solid fa-image"></i>
                                    </div>
                                )}

                                <div className="absolute inset-0 bg-blue-900/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3 backdrop-blur-[2px]">
                                    <button
                                        onClick={() => openCardEditor(index)}
                                        className="w-12 h-12 rounded-2xl bg-white text-blue-600 shadow-lg hover:scale-110 transition-transform flex items-center justify-center transform translate-y-4 group-hover:translate-y-0 duration-300"
                                        title="Editar"
                                    >
                                        <i className="fa-solid fa-pencil"></i>
                                    </button>
                                    <button
                                        onClick={() => deleteCard(index)}
                                        className="w-12 h-12 rounded-2xl bg-white text-red-500 shadow-lg hover:scale-110 transition-transform flex items-center justify-center transform translate-y-4 group-hover:translate-y-0 duration-300 delay-75"
                                        title="Eliminar"
                                    >
                                        <i className="fa-solid fa-trash"></i>
                                    </button>
                                </div>

                                <div className="absolute top-3 left-3 bg-black/60 backdrop-blur text-white text-[10px] font-black px-3 py-1 rounded-lg tracking-widest">
                                    #{index + 1}
                                </div>
                            </div>

                            {/* Card Content */}
                            <div className="p-6 flex flex-col flex-1">
                                <h3 className="text-lg font-black text-gray-900 italic tracking-tight line-clamp-1 mb-1" title={card.title}>{card.title}</h3>
                                {card.subtitle && <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3 line-clamp-1">{card.subtitle}</p>}

                                <div className="mt-auto pt-4 flex items-center justify-between border-t border-gray-50">
                                    <div className="flex flex-col">
                                        {card.dates && (
                                            <span className="text-[9px] font-black text-blue-500 uppercase tracking-widest bg-blue-50 px-2 py-1 rounded-md">
                                                {card.dates}
                                            </span>
                                        )}
                                    </div>
                                    {card.buttonText && (
                                        <div className="flex items-center gap-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                                            <i className="fa-solid fa-link text-xs"></i>
                                            BTN
                                        </div>
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


        </div>
    );
}


