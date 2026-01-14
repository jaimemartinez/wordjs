"use client";

import { useEffect, useState } from "react";
import { menusApi, postsApi, Menu, MenuItem, Post } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import ConfirmationModal from "@/components/ConfirmationModal";
import ModernSelect from "@/components/ModernSelect";

export default function MenusPage() {
    const { addToast } = useToast();
    const [menus, setMenus] = useState<Menu[]>([]);
    const [activeMenuId, setActiveMenuId] = useState<number | null>(null);
    const [activeMenu, setActiveMenu] = useState<Menu | null>(null);
    const [pages, setPages] = useState<Post[]>([]);
    const [locations, setLocations] = useState<Record<string, number>>({});

    // Forms
    const [newMenuName, setNewMenuName] = useState("");
    const [customLink, setCustomLink] = useState({ title: "", url: "http://" });
    const [selectedPageId, setSelectedPageId] = useState<string>("");

    // Deletion Modal State
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [deleteAction, setDeleteAction] = useState<(() => void) | null>(null);
    const [deleteMessage, setDeleteMessage] = useState("");

    useEffect(() => {
        loadMenus();
        loadPages();
        loadLocations();
    }, []);

    useEffect(() => {
        if (activeMenuId) {
            loadMenu(activeMenuId);
        } else {
            setActiveMenu(null);
        }
    }, [activeMenuId]);

    const loadLocations = async () => {
        try {
            const data = await menusApi.getLocations();
            setLocations(data || {});
        } catch (error) {
            console.error("Failed to load locations", error);
        }
    };

    const loadMenus = async () => {
        try {
            const data = await menusApi.list();
            setMenus(data);
            if (data.length > 0 && !activeMenuId) {
                setActiveMenuId(data[0].id);
            }
        } catch (error) {
            addToast("Failed to load menus", "error");
        }
    };

    const loadMenu = async (id: number) => {
        try {
            const data = await menusApi.get(id);
            setActiveMenu(data);
        } catch (error) {
            addToast("Failed to load menu", "error");
        }
    };

    const loadPages = async () => {
        try {
            const data = await postsApi.list("page", "any");
            setPages(data);
        } catch (error) {
            addToast("Failed to load pages", "error");
        }
    };

    const handleCreateMenu = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const menu = await menusApi.create({ name: newMenuName, slug: newMenuName.toLowerCase().replace(/\s+/g, '-') });
            setMenus([...menus, menu]);
            setActiveMenuId(menu.id);
            setNewMenuName("");
            addToast("Menu created successfully!", "success");
        } catch (error) {
            addToast("Failed to create menu", "error");
        }
    };

    // Prepare Delete Menu
    const confirmDeleteMenu = () => {
        if (!activeMenuId) return;
        setDeleteMessage("Are you sure you want to delete this menu? This action cannot be undone.");
        setDeleteAction(() => async () => {
            try {
                await menusApi.delete(activeMenuId);
                const remaining = menus.filter(m => m.id !== activeMenuId);
                setMenus(remaining);
                setActiveMenuId(remaining.length ? remaining[0].id : null);
                setDeleteModalOpen(false);
                addToast("Menu deleted", "success");
            } catch (error) {
                addToast("Failed to delete menu", "error");
            }
        });
        setDeleteModalOpen(true);
    };

    const addCustomLink = async () => {
        if (!activeMenuId || !customLink.title) return;
        try {
            await menusApi.addItem(activeMenuId, {
                title: customLink.title,
                url: customLink.url,
                type: 'custom',
                order: activeMenu?.items.length || 0
            });
            loadMenu(activeMenuId);
            setCustomLink({ title: "", url: "http://" });
            addToast("Link added", "success");
        } catch (error) {
            addToast("Failed to add link", "error");
        }
    };

    const addPageLink = async () => {
        if (!activeMenuId || !selectedPageId) return;
        const page = pages.find(p => p.id === Number(selectedPageId));
        if (!page) return;

        try {
            await menusApi.addItem(activeMenuId, {
                title: page.title,
                url: `/pages/${page.slug}`,
                type: 'post',
                objectId: page.id,
                order: activeMenu?.items.length || 0
            });
            loadMenu(activeMenuId);
            setSelectedPageId("");
            addToast("Page added to menu", "success");
        } catch (error) {
            addToast("Failed to add page", "error");
        }
    };

    const confirmDeleteItem = (itemId: number) => {
        setDeleteMessage("Remove this item from the menu?");
        setDeleteAction(() => async () => {
            try {
                await menusApi.deleteItem(itemId);
                loadMenu(activeMenuId!);
                setDeleteModalOpen(false);
                addToast("Item removed", "success");
            } catch (error) {
                addToast("Failed to delete item", "error");
            }
        });
        setDeleteModalOpen(true);
    };

    const toggleLocation = async (location: string, isChecked: boolean) => {
        if (activeMenuId && isChecked) {
            try {
                await menusApi.setLocation(activeMenuId, location);
                setLocations({ ...locations, [location]: activeMenuId });
                addToast(`Menu assigned to ${location}`, "success");
            } catch (err) {
                addToast("Failed to set location", "error");
            }
        }
    };

    const [editingItemId, setEditingItemId] = useState<number | null>(null);
    const [editFormData, setEditFormData] = useState<Partial<MenuItem>>({});

    const startEditing = (item: MenuItem) => {
        if (editingItemId === item.id) {
            setEditingItemId(null); // Toggle off
        } else {
            setEditingItemId(item.id);
            setEditFormData({ title: item.title, url: item.url, target: item.target });
        }
    };

    const cancelEditing = () => {
        setEditingItemId(null);
        setEditFormData({});
    };

    const handleUpdateItem = async (itemId: number) => {
        try {
            await menusApi.updateItem(itemId, editFormData);
            setEditingItemId(null);
            loadMenu(activeMenuId!);
            addToast("Item updated", "success");
        } catch (error) {
            addToast("Failed to update item", "error");
        }
    };

    return (
        <div className="p-8 h-full overflow-y-auto bg-gray-50 min-h-screen">
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={deleteAction || (() => { })}
                title="Confirm Action"
                message={deleteMessage}
                confirmText="Confirm"
                isDanger={true}
            />

            <div className="max-w-7xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-900 font-oswald flex items-center gap-3">
                        <span className="bg-brand-blue/10 text-brand-blue w-10 h-10 rounded-lg flex items-center justify-center text-xl">
                            <i className="fa-solid fa-compass"></i>
                        </span>
                        Gestión de Menús
                    </h1>
                </div>

                {/* ... (rest of the layout remains similar, just changing handlers) ... */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                    {/* LEFT COLUMN - TOOLS */}
                    <div className="lg:col-span-4 space-y-6">

                        {/* Selector & Create */}
                        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                            <h3 className="font-oswald font-bold text-lg mb-4 text-gray-800">Seleccionar Menú</h3>
                            <div className="flex items-center gap-3 mb-6">
                                <ModernSelect
                                    containerClassName="flex-1"
                                    value={activeMenuId || ""}
                                    onChange={(e) => setActiveMenuId(Number(e.target.value))}
                                    options={menus.map(m => ({ value: m.id, label: m.name }))}
                                />
                                <button
                                    onClick={confirmDeleteMenu}
                                    disabled={!activeMenuId}
                                    className="bg-red-50 hover:bg-red-100 text-red-600 px-3 py-2.5 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center shadow-sm"
                                    title="Eliminar Menú"
                                >
                                    <i className="fa-solid fa-trash-can"></i>
                                </button>
                            </div>

                            <div className="border-t pt-4">
                                <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wider">Crear Nuevo</h4>
                                <form onSubmit={handleCreateMenu} className="flex gap-2">
                                    <input
                                        type="text"
                                        value={newMenuName}
                                        onChange={e => setNewMenuName(e.target.value)}
                                        placeholder="Nombre del menú..."
                                        className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-brand-cyan/50 focus:outline-none"
                                        required
                                    />
                                    <button type="submit" className="bg-brand-blue hover:bg-brand-cyan text-white px-4 py-2 rounded-xl transition-colors shadow-lg shadow-brand-blue/20">
                                        <i className="fa-solid fa-plus"></i>
                                    </button>
                                </form>
                            </div>
                        </div>

                        {/* Add Items Tools */}
                        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                            <div className="p-4 bg-gray-50 border-b border-gray-100">
                                <h3 className="font-oswald font-bold text-gray-800">Agregar Elementos</h3>
                            </div>

                            <div className="divide-y divide-gray-100">
                                {/* Custom Links */}
                                <div className="p-5">
                                    <div className="flex items-center gap-2 mb-3 text-brand-blue">
                                        <i className="fa-solid fa-link text-sm"></i>
                                        <h4 className="font-semibold text-sm">Enlace Personalizado</h4>
                                    </div>
                                    <div className="space-y-3">
                                        <input
                                            type="text"
                                            value={customLink.url}
                                            onChange={e => setCustomLink({ ...customLink, url: e.target.value })}
                                            placeholder="https://"
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-brand-cyan/20 focus:outline-none"
                                        />
                                        <input
                                            type="text"
                                            value={customLink.title}
                                            onChange={e => setCustomLink({ ...customLink, title: e.target.value })}
                                            placeholder="Texto del enlace"
                                            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-brand-cyan/20 focus:outline-none"
                                        />
                                        <button
                                            onClick={addCustomLink}
                                            disabled={!activeMenuId || !customLink.title}
                                            className="w-full py-2.5 bg-white border border-gray-200 hover:border-brand-blue hover:text-brand-blue text-gray-600 rounded-xl transition-all text-sm font-medium disabled:opacity-50"
                                        >
                                            Añadir al Menú
                                        </button>
                                    </div>
                                </div>

                                {/* Pages */}
                                <div className="p-5">
                                    <div className="flex items-center gap-2 mb-3 text-brand-blue">
                                        <i className="fa-regular fa-file-lines text-sm"></i>
                                        <h4 className="font-semibold text-sm">Páginas</h4>
                                    </div>

                                    {pages.length === 0 ? (
                                        <p className="text-sm text-gray-400 italic">No hay páginas disponibles.</p>
                                    ) : (
                                        <div className="space-y-3">
                                            <div className="max-h-48 overflow-y-auto custom-scrollbar border border-gray-100 rounded-xl">
                                                {pages.map(page => (
                                                    <label key={page.id} className="flex items-center p-3 hover:bg-gray-50 cursor-pointer transition-colors border-b border-gray-50 last:border-0">
                                                        <div className="relative flex items-center">
                                                            <input
                                                                type="radio"
                                                                name="pageSelect"
                                                                value={page.id}
                                                                checked={selectedPageId === String(page.id)}
                                                                onChange={e => setSelectedPageId(e.target.value)}
                                                                className="peer h-4 w-4 cursor-pointer appearance-none rounded-full border border-gray-300 checked:border-brand-blue checked:bg-brand-blue transition-all"
                                                            />
                                                            <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 peer-checked:opacity-100">
                                                                <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4">
                                                                    <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                                                                </svg>
                                                            </div>
                                                        </div>
                                                        <span className="ml-3 text-sm text-gray-700 truncate">{page.title}</span>
                                                    </label>
                                                ))}
                                            </div>
                                            <button
                                                onClick={addPageLink}
                                                disabled={!activeMenuId || !selectedPageId}
                                                className="w-full py-2.5 bg-white border border-gray-200 hover:border-brand-blue hover:text-brand-blue text-gray-600 rounded-xl transition-all text-sm font-medium disabled:opacity-50"
                                            >
                                                Añadir al Menú
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                    </div>

                    {/* RIGHT COLUMN - STRUCTURE */}
                    <div className="lg:col-span-8">
                        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 h-full flex flex-col overflow-hidden">
                            {/* Header */}
                            <div className="p-6 border-b border-gray-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gray-50/50">
                                <div>
                                    <h2 className="font-oswald font-bold text-xl text-gray-900">
                                        {activeMenu ? activeMenu.name : "Estructura del Menú"}
                                    </h2>
                                    <p className="text-sm text-gray-500">
                                        {activeMenu ? "Arrastra los elementos para reordenar." : "Selecciona un menú para comenzar."}
                                    </p>
                                </div>
                                {activeMenu && (
                                    <div className="flex flex-col gap-2">
                                        {[
                                            { key: 'header', label: 'Menú Principal (Header)' },
                                            { key: 'footer', label: 'Menú del Footer' }
                                        ].map((loc) => (
                                            <label key={loc.key} className="flex items-center gap-3 cursor-pointer group bg-white px-4 py-2 rounded-xl border border-gray-200 hover:border-brand-blue transition-all">
                                                <div className="relative flex items-center">
                                                    <input
                                                        type="checkbox"
                                                        className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-gray-300 checked:border-brand-blue checked:bg-brand-blue transition-all"
                                                        checked={locations[loc.key] === activeMenu.id}
                                                        onChange={(e) => toggleLocation(loc.key, e.target.checked)}
                                                    />
                                                    <i className="fa-solid fa-check absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-[10px] opacity-0 peer-checked:opacity-100 pointer-events-none"></i>
                                                </div>
                                                <span className="text-sm font-medium text-gray-700 group-hover:text-brand-blue transition-colors">
                                                    {loc.label}
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Menu List */}
                            <div className="p-6 flex-1 bg-gray-50/30 overflow-y-auto min-h-[500px]">
                                {!activeMenu ? (
                                    <div className="h-full flex flex-col items-center justify-center text-gray-400 opacity-60">
                                        <i className="fa-solid fa-arrow-left text-4xl mb-4"></i>
                                        <p className="text-lg">Selecciona un menú a la izquierda</p>
                                    </div>
                                ) : activeMenu.items.length === 0 ? (
                                    <div className="h-full flex flex-col items-center justify-center text-center p-8 border-2 border-dashed border-gray-200 rounded-2xl">
                                        <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4 text-gray-400">
                                            <i className="fa-solid fa-list-ul text-2xl"></i>
                                        </div>
                                        <h3 className="text-lg font-bold text-gray-800 mb-1">Menú Vacío</h3>
                                        <p className="text-gray-500 max-w-sm">
                                            Añade enlaces personalizados o páginas usando las herramientas de la izquierda.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {activeMenu.items.sort((a, b) => a.order - b.order).map((item) => (
                                            <div
                                                key={item.id}
                                                className={`group bg-white rounded-xl shadow-sm border transition-all duration-200 ${editingItemId === item.id ? 'border-brand-blue ring-1 ring-brand-blue/20' : 'border-gray-200 hover:border-brand-cyan/50 hover:shadow-md'}`}
                                            >
                                                {/* Item Header */}
                                                <div className="p-4 flex items-center justify-between cursor-move">
                                                    <div className="flex items-center gap-4">
                                                        <div className="text-gray-300 cursor-grab active:cursor-grabbing hover:text-brand-blue transition-colors">
                                                            <i className="fa-solid fa-grip-vertical"></i>
                                                        </div>
                                                        <div>
                                                            <span className="font-bold text-gray-800 block text-sm">{item.title}</span>
                                                            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                                                                {item.type === 'post' ? 'Página' : 'Enlace'}
                                                            </span>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                                                        <button
                                                            onClick={() => startEditing(item)}
                                                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${editingItemId === item.id ? 'bg-brand-blue text-white' : 'bg-gray-100 text-gray-500 hover:bg-brand-blue hover:text-white'}`}
                                                        >
                                                            <i className={`fa-solid ${editingItemId === item.id ? 'fa-chevron-up' : 'fa-pen'}`}></i>
                                                        </button>
                                                        <button
                                                            onClick={() => confirmDeleteItem(item.id)}
                                                            className="w-8 h-8 rounded-lg bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-all"
                                                        >
                                                            <i className="fa-solid fa-trash-can"></i>
                                                        </button>
                                                    </div>
                                                </div>

                                                {/* Edit Form (Accordion) */}
                                                {editingItemId === item.id && (
                                                    <div className="px-4 pb-4 pt-0 animate-in slide-in-from-top-2 duration-200">
                                                        <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 space-y-4">
                                                            <div>
                                                                <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">Etiqueta de Navegación</label>
                                                                <input
                                                                    type="text"
                                                                    className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-blue/20 focus:border-brand-blue outline-none"
                                                                    value={editFormData.title || ''}
                                                                    onChange={e => setEditFormData({ ...editFormData, title: e.target.value })}
                                                                />
                                                            </div>
                                                            {item.type === 'custom' && (
                                                                <div>
                                                                    <label className="block text-xs font-bold text-gray-500 uppercase mb-1.5">URL del Enlace</label>
                                                                    <input
                                                                        type="text"
                                                                        className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-blue/20 focus:border-brand-blue outline-none"
                                                                        value={editFormData.url || ''}
                                                                        onChange={e => setEditFormData({ ...editFormData, url: e.target.value })}
                                                                    />
                                                                </div>
                                                            )}
                                                            <div className="flex justify-end gap-3 pt-2">
                                                                <button
                                                                    onClick={cancelEditing}
                                                                    className="px-4 py-2 text-xs font-bold text-gray-500 hover:text-gray-800 uppercase tracking-wide transition-colors"
                                                                >
                                                                    Cancelar
                                                                </button>
                                                                <button
                                                                    onClick={() => handleUpdateItem(item.id)}
                                                                    className="px-4 py-2 bg-brand-blue text-white text-xs font-bold uppercase tracking-wide rounded-lg hover:bg-brand-cyan shadow-lg shadow-brand-blue/20 transition-all"
                                                                >
                                                                    Guardar Cambios
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
