"use client";

import { useEffect, useState } from "react";
import { menusApi, postsApi, Menu, MenuItem, Post } from "@/lib/api";
import { useToast } from "@/contexts/ToastContext";
import ConfirmationModal from "@/components/ConfirmationModal";
import ModernSelect from "@/components/ModernSelect";
import { useI18n } from "@/contexts/I18nContext";

export default function MenusPage() {
    const { addToast } = useToast();
    const { t } = useI18n();
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

    // System Pages
    const systemPages = [
        { title: 'Portal de Conferencias', url: '/portal/conference' },
        { title: 'Login / Acceso', url: '/login' }
    ];
    const [selectedSystemUrl, setSelectedSystemUrl] = useState<string>("");

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

    const addSystemLink = async () => {
        if (!activeMenuId || !selectedSystemUrl) return;
        const page = systemPages.find(p => p.url === selectedSystemUrl);
        if (!page) return;

        try {
            await menusApi.addItem(activeMenuId, {
                title: page.title,
                url: page.url,
                type: 'custom',
                order: activeMenu?.items.length || 0
            });
            loadMenu(activeMenuId);
            setSelectedSystemUrl("");
            addToast("System page added", "success");
        } catch (error) {
            addToast("Failed to add system page", "error");
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
            setEditingItemId(null);
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
        <div className="p-8 md:p-12 h-full overflow-auto bg-gray-50/50 flex flex-col pb-20">
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={deleteAction || (() => { })}
                title="Confirm Action"
                message={deleteMessage}
                confirmText="Confirm"
                isDanger={true}
            />

            {/* Premium Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12 flex-shrink-0">
                <div>
                    <h1 className="text-4xl md:text-5xl font-black text-gray-900 italic tracking-tighter mb-2">
                        {t('nav.menus')}
                    </h1>
                    <div className="flex items-center gap-2">
                        <div className="h-1 w-10 bg-blue-600 rounded-full"></div>
                        <p className="text-xs font-bold uppercase tracking-widest text-gray-400">
                            {menus.length} Menus Available
                        </p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* LEFT COLUMN - TOOLS */}
                <div className="lg:col-span-4 space-y-6">

                    {/* Selector & Create */}
                    <div className="bg-white p-8 rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 relative overflow-hidden group hover:border-blue-50 transition-all duration-300">
                        {/* Background Blob */}
                        <div className="absolute -right-10 -top-10 w-40 h-40 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full blur-[60px] opacity-10 group-hover:opacity-20 transition-opacity duration-700 pointer-events-none"></div>

                        <h3 className="font-black text-xl mb-4 text-gray-900 italic tracking-tight">Select Menu</h3>
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
                                className="w-12 h-12 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white rounded-2xl transition-all disabled:opacity-50 flex items-center justify-center shadow-lg hover:shadow-red-500/30 hover:-translate-y-1 transform"
                                title="Eliminar Menú"
                            >
                                <i className="fa-solid fa-trash-can"></i>
                            </button>
                        </div>

                        <div className="border-t border-gray-100 pt-6">
                            <h4 className="text-[10px] font-black text-gray-400 uppercase mb-3 tracking-widest">Create New Menu</h4>
                            <form onSubmit={handleCreateMenu} className="flex gap-2">
                                <input
                                    type="text"
                                    value={newMenuName}
                                    onChange={e => setNewMenuName(e.target.value)}
                                    placeholder="Menu Name..."
                                    className="flex-1 bg-gray-50 border-2 border-gray-100 rounded-xl px-4 py-3 text-sm font-bold text-gray-700 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all placeholder:font-normal"
                                    required
                                />
                                <button type="submit" className="w-12 h-12 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl transition-all shadow-xl hover:shadow-blue-500/30 hover:-translate-y-1 flex items-center justify-center">
                                    <i className="fa-solid fa-plus"></i>
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Add Items Tools */}
                    <div className="bg-white rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 overflow-hidden">
                        <div className="p-6 bg-gray-50/50 border-b border-gray-100">
                            <h3 className="font-black text-lg text-gray-900 italic tracking-tight">Add Items</h3>
                        </div>

                        <div className="divide-y divide-gray-100">
                            {/* Custom Links */}
                            <div className="p-6 group hover:bg-blue-50/5 transition-colors">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center text-xs">
                                        <i className="fa-solid fa-link"></i>
                                    </div>
                                    <h4 className="font-bold text-sm text-gray-700">Custom Link</h4>
                                </div>
                                <div className="space-y-3">
                                    <input
                                        type="text"
                                        value={customLink.url}
                                        onChange={e => setCustomLink({ ...customLink, url: e.target.value })}
                                        placeholder="https://"
                                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all"
                                    />
                                    <input
                                        type="text"
                                        value={customLink.title}
                                        onChange={e => setCustomLink({ ...customLink, title: e.target.value })}
                                        placeholder="Link Text"
                                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all"
                                    />
                                    <button
                                        onClick={addCustomLink}
                                        disabled={!activeMenuId || !customLink.title}
                                        className="w-full py-3 bg-white border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 text-gray-600 rounded-xl transition-all text-sm font-black uppercase tracking-widest disabled:opacity-50 hover:shadow-lg hover:-translate-y-0.5"
                                    >
                                        Add to Menu
                                    </button>
                                </div>
                            </div>

                            {/* Pages */}
                            <div className="p-6 group hover:bg-indigo-50/5 transition-colors">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-xs">
                                        <i className="fa-regular fa-file-lines"></i>
                                    </div>
                                    <h4 className="font-bold text-sm text-gray-700">Pages</h4>
                                </div>

                                {pages.length === 0 ? (
                                    <p className="text-sm text-gray-400 italic font-medium">No pages available.</p>
                                ) : (
                                    <div className="space-y-4">
                                        <div className="max-h-48 overflow-y-auto custom-scrollbar border-2 border-gray-100 rounded-xl bg-gray-50/30 p-2">
                                            {pages.map(page => (
                                                <label key={page.id} className="flex items-center p-3 hover:bg-white hover:shadow-sm rounded-lg cursor-pointer transition-all mb-1 last:mb-0">
                                                    <div className="relative flex items-center">
                                                        <input
                                                            type="radio"
                                                            name="pageSelect"
                                                            value={page.id}
                                                            checked={selectedPageId === String(page.id)}
                                                            onChange={e => setSelectedPageId(e.target.value)}
                                                            className="peer h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-gray-300 checked:border-indigo-500 checked:bg-indigo-500 transition-all"
                                                        />
                                                    </div>
                                                    <span className="ml-3 text-sm font-medium text-gray-700 truncate">{page.title}</span>
                                                </label>
                                            ))}
                                        </div>
                                        <button
                                            onClick={addPageLink}
                                            disabled={!activeMenuId || !selectedPageId}
                                            className="w-full py-3 bg-white border-2 border-gray-100 hover:border-indigo-500 hover:text-indigo-600 text-gray-600 rounded-xl transition-all text-sm font-black uppercase tracking-widest disabled:opacity-50 hover:shadow-lg hover:-translate-y-0.5"
                                        >
                                            Add Page
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* System Pages */}
                            <div className="p-6 group hover:bg-purple-50/5 transition-colors">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-8 h-8 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center text-xs">
                                        <i className="fa-solid fa-gear"></i>
                                    </div>
                                    <h4 className="font-bold text-sm text-gray-700">System Pages</h4>
                                </div>
                                <div className="space-y-4">
                                    <div className="max-h-48 overflow-y-auto custom-scrollbar border-2 border-gray-100 rounded-xl bg-gray-50/30 p-2">
                                        {systemPages.map((page, idx) => (
                                            <label key={idx} className="flex items-center p-3 hover:bg-white hover:shadow-sm rounded-lg cursor-pointer transition-all mb-1 last:mb-0">
                                                <div className="relative flex items-center">
                                                    <input
                                                        type="radio"
                                                        name="systemPageSelect"
                                                        value={page.url}
                                                        checked={selectedSystemUrl === page.url}
                                                        onChange={e => setSelectedSystemUrl(e.target.value)}
                                                        className="peer h-4 w-4 cursor-pointer appearance-none rounded-full border-2 border-gray-300 checked:border-purple-500 checked:bg-purple-500 transition-all"
                                                    />
                                                </div>
                                                <span className="ml-3 text-sm font-medium text-gray-700 truncate">{page.title}</span>
                                            </label>
                                        ))}
                                    </div>
                                    <button
                                        onClick={addSystemLink}
                                        disabled={!activeMenuId || !selectedSystemUrl}
                                        className="w-full py-3 bg-white border-2 border-gray-100 hover:border-purple-500 hover:text-purple-600 text-gray-600 rounded-xl transition-all text-sm font-black uppercase tracking-widest disabled:opacity-50 hover:shadow-lg hover:-translate-y-0.5"
                                    >
                                        Add System Page
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                {/* RIGHT COLUMN - STRUCTURE */}
                <div className="lg:col-span-8">
                    <div className="bg-white rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 h-[800px] flex flex-col overflow-hidden relative">
                        {/* Background Decoration */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-gray-50 to-transparent rounded-bl-[100px] pointer-events-none opacity-50"></div>

                        {/* Header */}
                        <div className="p-8 border-b border-gray-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white z-10">
                            <div>
                                <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-1">
                                    {activeMenu ? activeMenu.name : "Menu Structure"}
                                </h2>
                                <p className="text-sm font-bold text-gray-400 uppercase tracking-wide">
                                    {activeMenu ? "Drag items to reorder." : "Select a menu to start."}
                                </p>
                            </div>
                            {activeMenu && (
                                <div className="flex gap-4">
                                    {[
                                        { key: 'header', label: 'Main Menu' },
                                        { key: 'footer', label: 'Footer Menu' }
                                    ].map((loc) => (
                                        <label key={loc.key} className="flex items-center gap-3 cursor-pointer group bg-gray-50 px-4 py-2 rounded-xl border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-all">
                                            <div className="relative flex items-center">
                                                <input
                                                    type="checkbox"
                                                    className="peer h-5 w-5 cursor-pointer appearance-none rounded-lg border-2 border-gray-300 checked:border-blue-600 checked:bg-blue-600 transition-all"
                                                    checked={locations[loc.key] === activeMenu.id}
                                                    onChange={(e) => toggleLocation(loc.key, e.target.checked)}
                                                />
                                                <i className="fa-solid fa-check absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-[10px] opacity-0 peer-checked:opacity-100 pointer-events-none"></i>
                                            </div>
                                            <span className="text-xs font-black uppercase tracking-wider text-gray-500 group-hover:text-blue-700 transition-colors">
                                                {loc.label}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Menu List */}
                        <div className="p-8 flex-1 bg-gray-50/30 overflow-y-auto custom-scrollbar relative">
                            {!activeMenu ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-300 opacity-60">
                                    <div className="w-24 h-24 rounded-full bg-gray-100 flex items-center justify-center mb-6">
                                        <i className="fa-solid fa-arrow-left text-4xl"></i>
                                    </div>
                                    <p className="text-2xl font-black italic tracking-tight">Select a menu from the left</p>
                                </div>
                            ) : activeMenu.items.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-center p-8 border-4 border-dashed border-gray-100 rounded-[32px]">
                                    <div className="w-20 h-20 bg-blue-50 rounded-[40px] flex items-center justify-center mb-6 text-blue-300 animate-pulse">
                                        <i className="fa-solid fa-layer-group text-3xl"></i>
                                    </div>
                                    <h3 className="text-xl font-black text-gray-900 mb-2 italic tracking-tight">Empty Menu</h3>
                                    <p className="text-gray-400 font-bold max-w-sm">
                                        Add generic links or pages using the tools on the left sidebar.
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-4 max-w-3xl mx-auto">
                                    {activeMenu.items.sort((a, b) => a.order - b.order).map((item) => (
                                        <div
                                            key={item.id}
                                            className={`group bg-white rounded-2xl shadow-sm hover:shadow-xl transition-all duration-300 ${editingItemId === item.id ? 'border-2 border-blue-500 ring-4 ring-blue-500/10 z-20 relative scale-[1.02]' : 'border border-gray-100 hover:border-blue-200 hover:-translate-y-1'}`}
                                        >
                                            {/* Item Header */}
                                            <div className="p-4 pl-6 flex items-center justify-between cursor-move md:cursor-grab active:cursor-grabbing">
                                                <div className="flex items-center gap-5">
                                                    <div className="text-gray-300 hover:text-blue-500 transition-colors cursor-grab active:cursor-grabbing p-2">
                                                        <i className="fa-solid fa-grip-vertical text-lg"></i>
                                                    </div>
                                                    <div>
                                                        <span className="font-bold text-gray-800 block text-base mb-1">{item.title}</span>
                                                        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-lg ${item.type === 'post' ? 'bg-indigo-50 text-indigo-500' : 'bg-blue-50 text-blue-500'}`}>
                                                            {item.type === 'post' ? 'Page' : 'Link'}
                                                        </span>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => startEditing(item)}
                                                        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${editingItemId === item.id ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white hover:shadow-md'}`}
                                                    >
                                                        <i className={`fa-solid ${editingItemId === item.id ? 'fa-xmark' : 'fa-pen'}`}></i>
                                                    </button>
                                                    <button
                                                        onClick={() => confirmDeleteItem(item.id)}
                                                        className="w-10 h-10 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 hover:shadow-md"
                                                    >
                                                        <i className="fa-solid fa-trash-can"></i>
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Edit Form (Accordion) */}
                                            {editingItemId === item.id && (
                                                <div className="px-6 pb-6 pt-2 animate-in slide-in-from-top-4 duration-300">
                                                    <div className="bg-gray-50 rounded-xl p-6 border-2 border-gray-100 space-y-5">
                                                        <div>
                                                            <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">Navigation Label</label>
                                                            <input
                                                                type="text"
                                                                className="w-full bg-white border-2 border-gray-200 rounded-xl px-4 py-3 text-sm font-bold text-gray-700 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all"
                                                                value={editFormData.title || ''}
                                                                onChange={e => setEditFormData({ ...editFormData, title: e.target.value })}
                                                            />
                                                        </div>
                                                        {item.type === 'custom' && (
                                                            <div>
                                                                <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">URL</label>
                                                                <input
                                                                    type="text"
                                                                    className="w-full bg-white border-2 border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all"
                                                                    value={editFormData.url || ''}
                                                                    onChange={e => setEditFormData({ ...editFormData, url: e.target.value })}
                                                                />
                                                            </div>
                                                        )}
                                                        <div className="flex justify-end gap-3 pt-2">
                                                            <button
                                                                onClick={cancelEditing}
                                                                className="px-6 py-3 text-xs font-bold text-gray-500 hover:text-gray-900 uppercase tracking-widest transition-colors"
                                                            >
                                                                Cancel
                                                            </button>
                                                            <button
                                                                onClick={() => handleUpdateItem(item.id)}
                                                                className="px-6 py-3 bg-blue-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:bg-blue-700 shadow-xl shadow-blue-500/20 hover:shadow-blue-600/30 hover:-translate-y-1 transition-all"
                                                            >
                                                                Save Changes
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
    );
}
