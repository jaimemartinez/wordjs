"use client";

import { useEffect, useState } from "react";
import { menusApi, pluginsApi, postsApi, categoriesApi, tagsApi, Menu, MenuItem, Post, Category, Tag } from "@/lib/api";
import MenuSourcePicker, { type MenuSourceEntry } from "./MenuSourcePicker";
import { flattenMenu, indent, moveWithinSiblings, outdent, parentCandidates, type MenuWrite } from "@/lib/menuTree";
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
    // The other things a menu can point at (QA S1-14): published posts, categories and tags.
    const [posts, setPosts] = useState<Post[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [tags, setTags] = useState<Tag[]>([]);
    const [locations, setLocations] = useState<Record<string, number>>({});

    // Forms
    const [newMenuName, setNewMenuName] = useState("");
    const [customLink, setCustomLink] = useState({ title: "", url: "http://" });
    const [selectedPageId, setSelectedPageId] = useState<string>("");

    // Deletion Modal State
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [deleteAction, setDeleteAction] = useState<(() => void) | null>(null);
    const [deleteMessage, setDeleteMessage] = useState("");

    // System Pages: the plugin portals served right now (/portal/<slug>), then the login page.
    const [portals, setPortals] = useState<{ slug: string; title?: string }[]>([]);
    const systemPages = [
        ...portals.map((p) => ({ title: p.title || `/portal/${p.slug}`, url: `/portal/${p.slug}` })),
        { title: t('menus.systemLoginAccess'), url: '/login' }
    ];
    const [selectedSystemUrl, setSelectedSystemUrl] = useState<string>("");

    useEffect(() => {
        loadMenus();
        loadPages();
        loadLocations();
        loadPortals();
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

    const loadPortals = async () => {
        try {
            const data = await pluginsApi.portals();
            setPortals(Array.isArray(data) ? data : []);
        } catch {
            setPortals([]);
        }
    };

    const loadMenus = async () => {
        try {
            const data = await menusApi.list();
            setMenus(data);
            if (data.length > 0 && !activeMenuId) {
                setActiveMenuId(data[0].id);
            }
        } catch {
            addToast(t('menus.loadMenusError'), "error");
        }
    };

    const loadMenu = async (id: number) => {
        try {
            const data = await menusApi.get(id);
            setActiveMenu(data);
        } catch {
            addToast(t('menus.loadMenuError'), "error");
        }
    };

    const loadPages = async () => {
        try {
            const data = await postsApi.list("page", "any");
            setPages(data);
        } catch {
            addToast(t('menus.loadPagesError'), "error");
        }
        postsApi.list("post", "publish").then(setPosts).catch(() => setPosts([]));
        categoriesApi.listAll().then((r) => setCategories(r.data)).catch(() => setCategories([]));
        tagsApi.list({ perPage: 100, orderby: "name", order: "asc" }).then(setTags).catch(() => setTags([]));
    };

    /** Add the picked entries at the end of the menu's top level, in the order they were listed. */
    const addEntries = async (entries: MenuSourceEntry[]) => {
        if (!activeMenuId || entries.length === 0) return;
        const topLevel = (activeMenu?.items || []).filter((i) => !(Number(i.parent) > 0)).length;
        try {
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                await menusApi.addItem(activeMenuId, { title: e.title, url: e.url, type: e.type, objectId: e.objectId, order: topLevel + i });
            }
            loadMenu(activeMenuId);
            addToast(t('menus.pageAddedSuccess'), "success");
        } catch {
            addToast(t('menus.pageAddedError'), "error");
        }
    };

    /** Persist a tree move (lib/menuTree), then reload. */
    const applyMove = async (writes: MenuWrite[]) => {
        if (!activeMenuId || writes.length === 0) return;
        try {
            for (const w of writes) await menusApi.updateItem(w.id, { ...(w.order !== undefined ? { order: w.order } : {}), ...(w.parent !== undefined ? { parent: w.parent } : {}) });
            loadMenu(activeMenuId);
            addToast(t('menus.reorderSuccess'), "success");
        } catch {
            addToast(t('menus.itemUpdatedError'), "error");
        }
    };

    const handleCreateMenu = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const menu = await menusApi.create({ name: newMenuName, slug: newMenuName.toLowerCase().replace(/\s+/g, '-') });
            setMenus([...menus, menu]);
            setActiveMenuId(menu.id);
            setNewMenuName("");
            addToast(t('menus.createSuccess'), "success");
        } catch {
            addToast(t('menus.createError'), "error");
        }
    };

    // Prepare Delete Menu
    const confirmDeleteMenu = () => {
        if (!activeMenuId) return;
        setDeleteMessage(t('menus.deleteMenuConfirm'));
        setDeleteAction(() => async () => {
            try {
                await menusApi.delete(activeMenuId);
                const remaining = menus.filter(m => m.id !== activeMenuId);
                setMenus(remaining);
                setActiveMenuId(remaining.length ? remaining[0].id : null);
                setDeleteModalOpen(false);
                addToast(t('menus.deleteMenuSuccess'), "success");
            } catch {
                addToast(t('menus.deleteMenuError'), "error");
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
            addToast(t('menus.linkAddedSuccess'), "success");
        } catch {
            addToast(t('menus.linkAddedError'), "error");
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
            addToast(t('menus.pageAddedSuccess'), "success");
        } catch {
            addToast(t('menus.pageAddedError'), "error");
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
            addToast(t('menus.systemPageAddedSuccess'), "success");
        } catch {
            addToast(t('menus.systemPageAddedError'), "error");
        }
    };

    const confirmDeleteItem = (itemId: number) => {
        setDeleteMessage(t('menus.deleteItemConfirm'));
        setDeleteAction(() => async () => {
            try {
                await menusApi.deleteItem(itemId);
                loadMenu(activeMenuId!);
                setDeleteModalOpen(false);
                addToast(t('menus.itemRemovedSuccess'), "success");
            } catch {
                addToast(t('menus.itemRemovedError'), "error");
            }
        });
        setDeleteModalOpen(true);
    };

    const toggleLocation = async (location: string, isChecked: boolean) => {
        if (activeMenuId && isChecked) {
            try {
                await menusApi.setLocation(activeMenuId, location);
                setLocations({ ...locations, [location]: activeMenuId });
                addToast(`${t('menus.locationAssignedSuccess')} ${location}`, "success");
            } catch {
                addToast(t('menus.locationAssignedError'), "error");
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
            setEditFormData({ title: item.title, url: item.url, target: item.target || "_self", parent: Number(item.parent) || 0 });
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
            addToast(t('menus.itemUpdatedSuccess'), "success");
        } catch {
            addToast(t('menus.itemUpdatedError'), "error");
        }
    };

    // Reorder a menu item by swapping positions with its neighbour and persisting
    // the new `order` values via the existing update API. Index-based so it stays
    // correct even if stored orders are sparse or duplicated.
    // Up/down among its siblings; indent/outdent change the level (submenus). lib/menuTree computes the writes.
    const moveItem = (item: MenuItem, direction: 'up' | 'down') => applyMove(moveWithinSiblings(activeMenu?.items || [], item, direction));

    return (
        <div className="px-4 py-6 sm:p-8 md:p-12 h-full overflow-auto bg-gray-50/50 flex flex-col pb-20">
            <ConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={deleteAction || (() => { })}
                title={t('menus.confirmActionTitle')}
                message={deleteMessage}
                confirmText={t('menus.confirmButton')}
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
                            {menus.length} {t('menus.menusAvailable')}
                        </p>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                {/* LEFT COLUMN - TOOLS */}
                <div className="lg:col-span-4 space-y-6">

                    {/* Selector & Create */}
                    <div className="bg-white p-5 sm:p-8 rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 relative overflow-hidden group hover:border-blue-50 transition-all duration-300">
                        {/* Background Blob */}
                        <div className="absolute -right-10 -top-10 w-40 h-40 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full blur-[60px] opacity-10 group-hover:opacity-20 transition-opacity duration-700 pointer-events-none"></div>

                        <h3 className="font-black text-xl mb-4 text-gray-900 italic tracking-tight">{t('menus.selectMenu')}</h3>
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
                                className="w-12 h-12 shrink-0 bg-red-50 hover:bg-red-500 text-red-500 hover:text-white rounded-2xl transition-all disabled:opacity-50 flex items-center justify-center shadow-lg hover:shadow-red-500/30 hover:-translate-y-1 transform"
                                title={t('menus.deleteMenu')}
                                aria-label={t('menus.deleteMenu')}
                            >
                                <i className="fa-solid fa-trash-can"></i>
                            </button>
                        </div>

                        <div className="border-t border-gray-100 pt-6">
                            <h4 className="text-[11px] font-black text-gray-400 uppercase mb-3 tracking-widest">{t('menus.createNewMenu')}</h4>
                            <form onSubmit={handleCreateMenu} className="flex gap-2">
                                <input
                                    type="text"
                                    value={newMenuName}
                                    onChange={e => setNewMenuName(e.target.value)}
                                    placeholder={t('menus.menuNamePlaceholder')}
                                    aria-label={t('menus.createNewMenu')}
                                    className="flex-1 bg-gray-50 border-2 border-gray-100 rounded-xl px-4 py-3 text-sm font-bold text-gray-700 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all placeholder:font-normal"
                                    required
                                />
                                <button type="submit" aria-label={t('menus.createMenuButton')} className="w-12 h-12 shrink-0 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl transition-all shadow-xl hover:shadow-blue-500/30 hover:-translate-y-1 flex items-center justify-center">
                                    <i className="fa-solid fa-plus"></i>
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Add Items Tools */}
                    <div className="bg-white rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 overflow-hidden">
                        <div className="p-6 bg-gray-50/50 border-b border-gray-100">
                            <h3 className="font-black text-lg text-gray-900 italic tracking-tight">{t('menus.addItems')}</h3>
                        </div>

                        <div className="divide-y divide-gray-100">
                            {/* Custom Links */}
                            <div className="p-6 group hover:bg-blue-50/5 transition-colors">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-8 h-8 shrink-0 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center text-xs">
                                        <i className="fa-solid fa-link"></i>
                                    </div>
                                    <h4 className="font-bold text-sm text-gray-700">{t('menus.customLink')}</h4>
                                </div>
                                <div className="space-y-3">
                                    <input
                                        type="text"
                                        value={customLink.url}
                                        onChange={e => setCustomLink({ ...customLink, url: e.target.value })}
                                        placeholder="https://"
                                        aria-label={t('menus.url')}
                                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all"
                                    />
                                    <input
                                        type="text"
                                        value={customLink.title}
                                        onChange={e => setCustomLink({ ...customLink, title: e.target.value })}
                                        placeholder={t('menus.linkTextPlaceholder')}
                                        aria-label={t('menus.linkTextPlaceholder')}
                                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all"
                                    />
                                    <button
                                        onClick={addCustomLink}
                                        disabled={!activeMenuId || !customLink.title}
                                        className="w-full py-3 bg-white border-2 border-gray-100 hover:border-blue-500 hover:text-blue-600 text-gray-600 rounded-xl transition-all text-sm font-black uppercase tracking-widest disabled:opacity-50 hover:shadow-lg hover:-translate-y-0.5"
                                    >
                                        {t('menus.addToMenu')}
                                    </button>
                                </div>
                            </div>

                            {/* Pages, posts, categories, tags — several at once (QA S1-14) */}
                            <MenuSourcePicker title={t('menus.pages')} icon="fa-file-lines" disabled={!activeMenuId} onAdd={addEntries}
                                entries={pages.map((p) => ({ key: "page-" + p.id, title: p.title || "#" + p.id, url: "/" + (p.slug || p.id), type: "post", objectId: p.id }))} />
                            <MenuSourcePicker title={t('menus.posts')} icon="fa-newspaper" disabled={!activeMenuId} onAdd={addEntries}
                                entries={posts.map((p) => ({ key: "post-" + p.id, title: p.title || "#" + p.id, url: "/" + (p.slug || p.id), type: "post", objectId: p.id }))} />
                            <MenuSourcePicker title={t('menus.categories')} icon="fa-folder" disabled={!activeMenuId} onAdd={addEntries}
                                entries={categories.map((c) => ({ key: "cat-" + c.id, title: c.name, url: "/category/" + encodeURIComponent(c.slug), type: "taxonomy", objectId: c.id }))} />
                            <MenuSourcePicker title={t('menus.tags')} icon="fa-tag" disabled={!activeMenuId} onAdd={addEntries}
                                entries={tags.map((c) => ({ key: "tag-" + c.id, title: c.name, url: "/tag/" + encodeURIComponent(c.slug), type: "taxonomy", objectId: c.id }))} />

                            {/* System Pages */}
                            <div className="p-6 group hover:bg-purple-50/5 transition-colors">
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="w-8 h-8 shrink-0 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center text-xs">
                                        <i className="fa-solid fa-gear"></i>
                                    </div>
                                    <h4 className="font-bold text-sm text-gray-700">{t('menus.systemPages')}</h4>
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
                                        {t('menus.addSystemPage')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                {/* RIGHT COLUMN - STRUCTURE */}
                <div className="lg:col-span-8">
                    <div className="bg-white rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 h-[800px] flex flex-col overflow-hidden relative">
                        {/* Background Decoration */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-bl from-gray-50 to-transparent rounded-bl-[100px] pointer-events-none opacity-50"></div>

                        {/* Header */}
                        <div className="p-8 border-b border-gray-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white z-10">
                            <div>
                                <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter mb-1">
                                    {activeMenu ? activeMenu.name : t('menus.menuStructure')}
                                </h2>
                                <p className="text-sm font-bold text-gray-400 uppercase tracking-wide">
                                    {activeMenu ? t('menus.reorderHint') : t('menus.selectMenuToStart')}
                                </p>
                            </div>
                            {activeMenu && (
                                <div className="flex flex-wrap gap-4">
                                    {[
                                        { key: 'header', label: t('menus.mainMenu') },
                                        { key: 'footer', label: t('menus.footerMenu') }
                                    ].map((loc) => (
                                        <label key={loc.key} className="flex items-center gap-3 cursor-pointer group bg-gray-50 px-4 py-2 rounded-xl border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-all">
                                            <div className="relative flex items-center">
                                                <input
                                                    type="checkbox"
                                                    className="peer h-5 w-5 cursor-pointer appearance-none rounded-lg border-2 border-gray-300 checked:border-blue-600 checked:bg-blue-600 transition-all"
                                                    checked={locations[loc.key] === activeMenu.id}
                                                    onChange={(e) => toggleLocation(loc.key, e.target.checked)}
                                                />
                                                <i className="fa-solid fa-check absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-[11px] opacity-0 peer-checked:opacity-100 pointer-events-none"></i>
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
                                    <div className="w-24 h-24 shrink-0 rounded-full bg-gray-100 flex items-center justify-center mb-6">
                                        <i className="fa-solid fa-arrow-left text-4xl"></i>
                                    </div>
                                    <p className="text-2xl font-black italic tracking-tight">{t('menus.selectMenuFromLeft')}</p>
                                </div>
                            ) : activeMenu.items.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-center p-8 border-4 border-dashed border-gray-100 rounded-[32px]">
                                    <div className="w-20 h-20 shrink-0 bg-blue-50 rounded-3xl md:rounded-[40px] flex items-center justify-center mb-6 text-blue-300 animate-pulse">
                                        <i className="fa-solid fa-layer-group text-3xl"></i>
                                    </div>
                                    <h3 className="text-xl font-black text-gray-900 mb-2 italic tracking-tight">{t('menus.emptyMenu')}</h3>
                                    <p className="text-gray-400 font-bold max-w-sm">
                                        {t('menus.emptyMenuHint')}
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-4 max-w-3xl mx-auto">
                                    {flattenMenu(activeMenu.items).map(({ item, depth }) => (
                                        <div
                                            key={item.id}
                                            style={depth ? { marginInlineStart: Math.min(depth, 4) * 2 + "rem" } : undefined}
                                            data-menu-depth={depth}
                                            className={`group bg-white rounded-2xl shadow-sm hover:shadow-xl transition-all duration-300 ${editingItemId === item.id ? 'border-2 border-blue-500 ring-4 ring-blue-500/10 relative' : 'border border-gray-100 hover:border-blue-200'}`}
                                        >
                                            {/* Item Header */}
                                            <div className="p-3 sm:p-4 sm:pl-6 flex items-center justify-between gap-2">
                                                <div className="flex items-center gap-2 sm:gap-5 min-w-0">
                                                    {/* Stacked arrows for a mouse; side by side where each needs a finger's room. */}
                                                    <div className="flex flex-col pointer-coarse:flex-row shrink-0">
                                                        <button
                                                            onClick={() => moveItem(item, 'up')}
                                                            disabled={moveWithinSiblings(activeMenu.items, item, 'up').length === 0}
                                                            aria-label={t('menus.moveUp')}
                                                            className="w-7 h-6 flex items-center justify-center text-gray-300 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-gray-300 disabled:cursor-not-allowed transition-colors"
                                                        >
                                                            <i className="fa-solid fa-chevron-up text-sm"></i>
                                                        </button>
                                                        <button
                                                            onClick={() => moveItem(item, 'down')}
                                                            disabled={moveWithinSiblings(activeMenu.items, item, 'down').length === 0}
                                                            aria-label={t('menus.moveDown')}
                                                            className="w-7 h-6 flex items-center justify-center text-gray-300 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-gray-300 disabled:cursor-not-allowed transition-colors"
                                                        >
                                                            <i className="fa-solid fa-chevron-down text-sm"></i>
                                                        </button>
                                                    </div>
                                                    <div>
                                                        <span className="font-bold text-gray-800 block text-base mb-1">{item.title}</span>
                                                        <span className={`text-[11px] font-black uppercase tracking-widest px-2 py-1 rounded-lg ${item.type === 'post' ? 'bg-indigo-50 text-indigo-500' : 'bg-blue-50 text-blue-500'}`}>
                                                            {item.type === 'post' ? t('menus.typePage') : t('menus.typeLink')}
                                                        </span>
                                                    </div>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <button type="button" onClick={() => applyMove(outdent(activeMenu.items, item))} disabled={outdent(activeMenu.items, item).length === 0}
                                                        aria-label={t('menus.outdent')} title={t('menus.outdent')}
                                                        className="w-11 h-11 shrink-0 rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all disabled:opacity-30 disabled:pointer-events-none">
                                                        <i className="fa-solid fa-outdent" aria-hidden="true"></i>
                                                    </button>
                                                    <button type="button" onClick={() => applyMove(indent(activeMenu.items, item))} disabled={indent(activeMenu.items, item).length === 0}
                                                        aria-label={t('menus.indent')} title={t('menus.indent')}
                                                        className="w-11 h-11 shrink-0 rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white flex items-center justify-center transition-all disabled:opacity-30 disabled:pointer-events-none">
                                                        <i className="fa-solid fa-indent" aria-hidden="true"></i>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => startEditing(item)}
                                                        aria-label={editingItemId === item.id ? t('common.close') : t('common.edit')}
                                                        aria-expanded={editingItemId === item.id}
                                                        title={editingItemId === item.id ? t('common.close') : t('common.edit')}
                                                        className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center transition-all ${editingItemId === item.id ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white hover:shadow-md'}`}
                                                    >
                                                        <i className={`fa-solid ${editingItemId === item.id ? 'fa-xmark' : 'fa-pen'}`}></i>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => confirmDeleteItem(item.id)}
                                                        aria-label={t('common.delete')}
                                                        title={t('common.delete')}
                                                        className="w-11 h-11 shrink-0 rounded-xl bg-gray-50 text-gray-400 hover:bg-red-500 hover:text-white flex items-center justify-center transition-all opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:shadow-md"
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
                                                            <label className="block text-[11px] font-black text-gray-400 uppercase tracking-widest mb-2">{t('menus.navigationLabel')}</label>
                                                            <input
                                                                type="text"
                                                                className="w-full bg-white border-2 border-gray-200 rounded-xl px-4 py-3 text-sm font-bold text-gray-700 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all"
                                                                value={editFormData.title || ''}
                                                                onChange={e => setEditFormData({ ...editFormData, title: e.target.value })}
                                                            />
                                                        </div>
                                                        {item.type === 'custom' && (
                                                            <div>
                                                                <label htmlFor={`menu-item-url-${item.id}`} className="block text-[11px] font-black text-gray-400 uppercase tracking-widest mb-2">{t('menus.url')}</label>
                                                                <input id={`menu-item-url-${item.id}`}
                                                                    type="text"
                                                                    className="w-full bg-white border-2 border-gray-200 rounded-xl px-4 py-3 text-sm font-medium text-gray-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none transition-all"
                                                                    value={editFormData.url || ''}
                                                                    onChange={e => setEditFormData({ ...editFormData, url: e.target.value })}
                                                                />
                                                            </div>
                                                        )}
                                                        <label className="flex items-center gap-3 text-sm font-medium text-gray-700 min-h-11">
                                                            <input type="checkbox" checked={editFormData.target === "_blank"}
                                                                onChange={(e) => setEditFormData({ ...editFormData, target: e.target.checked ? "_blank" : "_self" })} className="h-4 w-4" />
                                                            {t('menus.openNewTab')}
                                                        </label>
                                                        <div>
                                                            <label htmlFor={`menu-item-parent-${item.id}`} className="block text-[11px] font-black text-gray-400 uppercase tracking-widest mb-2">{t('menus.parentItem')}</label>
                                                            <select id={`menu-item-parent-${item.id}`} value={String(editFormData.parent ?? 0)}
                                                                onChange={(e) => setEditFormData({ ...editFormData, parent: Number(e.target.value) })}
                                                                className="w-full min-h-11 bg-white border-2 border-gray-200 rounded-xl px-3 text-sm font-medium text-gray-700">
                                                                <option value="0">{t('menus.parentNone')}</option>
                                                                {parentCandidates(activeMenu.items, item).map((p) => (
                                                                    <option key={p.id} value={String(p.id)}>{p.title}</option>
                                                                ))}
                                                            </select>
                                                        </div>
                                                        <div className="flex justify-end gap-3 pt-2">
                                                            <button
                                                                onClick={cancelEditing}
                                                                className="px-6 py-3 text-xs font-bold text-gray-500 hover:text-gray-900 uppercase tracking-widest transition-colors"
                                                            >
                                                                {t('menus.cancel')}
                                                            </button>
                                                            <button
                                                                onClick={() => handleUpdateItem(item.id)}
                                                                className="px-6 py-3 bg-blue-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:bg-blue-700 shadow-xl shadow-blue-500/20 hover:shadow-blue-600/30 hover:-translate-y-1 transition-all"
                                                            >
                                                                {t('menus.saveChanges')}
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
