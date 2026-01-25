"use client";

import Link from "next/link";
import SmartLink from "./SmartLink";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useMenu } from "@/contexts/MenuContext";
import { useI18n } from "@/contexts/I18nContext";
import { useEffect, useState } from "react";
import NotificationCenter from "./NotificationCenter";

interface SidebarMenuItem {
    href: string;
    label: string;
    icon: string;
    cap?: string;
}

// Core menu items - labels will be translated in component
const coreMenuItems: SidebarMenuItem[] = [
    { href: "/admin", label: "nav.dashboard", icon: "fa-chart-pie", cap: "read" },
    { href: "/admin/posts", label: "nav.posts", icon: "fa-pen-to-square", cap: "edit_posts" },
    { href: "/admin/pages", label: "nav.pages", icon: "fa-file-lines", cap: "edit_pages" },
    { href: "/admin/media", label: "nav.media", icon: "fa-images", cap: "upload_files" },
    { href: "/admin/menus", label: "nav.menus", icon: "fa-bars", cap: "edit_theme_options" },
    { href: "/admin/footer", label: "nav.footer", icon: "fa-shoe-prints", cap: "edit_theme_options" },
    { href: "/admin/widgets", label: "nav.widgets", icon: "fa-shapes", cap: "edit_theme_options" },
    { href: "/admin/comments", label: "nav.comments", icon: "fa-comments", cap: "moderate_comments" },
    { href: "/admin/users", label: "nav.users", icon: "fa-users", cap: "list_users" },
    { href: "/admin/users?type=subscribers", label: "nav.subscribers", icon: "fa-user-group", cap: "list_users" },
    { href: "/admin/users/roles", label: "nav.roles", icon: "fa-shield-halved", cap: "manage_options" },
    { href: "/admin/categories", label: "nav.categories", icon: "fa-folder", cap: "manage_categories" },
    { href: "/admin/plugins", label: "nav.plugins", icon: "fa-plug", cap: "activate_plugins" },
    { href: "/admin/themes", label: "nav.themes", icon: "fa-palette", cap: "switch_themes" },
    { href: "/admin/fonts", label: "nav.fonts", icon: "fa-font", cap: "manage_options" },
    { href: "/admin/settings", label: "nav.settings", icon: "fa-gear", cap: "manage_options" },
    { href: "/admin/settings/backups", label: "Backups", icon: "fa-box-archive", cap: "manage_options" },
    { href: "/admin/security", label: "Security", icon: "fa-lock", cap: "manage_options" },
];

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
    isCollapsed?: boolean;
}

export default function Sidebar({ isOpen, onClose, isCollapsed = false }: SidebarProps) {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { logout, user } = useAuth();
    const { pluginMenus } = useMenu(); // Use global context
    const { t, language, setLanguage } = useI18n();
    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [siteTitle, setSiteTitle] = useState("WordJS");
    const [hoveredItem, setHoveredItem] = useState<{ label: string; top: number } | null>(null);
    const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);

    const languages = [
        { code: 'es', label: 'Español', flag: '🇪🇸' },
        { code: 'en', label: 'English', flag: '🇺🇸' },
        { code: 'pt', label: 'Português', flag: '🇧🇷' },
    ];

    const currentLang = languages.find(l => l.code === language) || languages[0];

    // Helper to check capabilities
    const can = (cap: string | undefined) => {
        if (!cap) return true;
        if (!user || !user.capabilities) return false;
        if (user.capabilities.includes("*")) return true;
        return user.capabilities.includes(cap);
    };

    useEffect(() => {
        const fetchSettings = async () => {
            try {
                const { settingsApi } = await import("@/lib/api");
                const settings = await settingsApi.get();
                if (settings.site_logo) setLogoUrl(settings.site_logo);
                if (settings.blogname) setSiteTitle(settings.blogname);
            } catch (error) {
                console.error("Failed to load sidebar settings:", error);
            }
        };
        fetchSettings();
    }, []);

    // Deduplicate: Filter out plugin menus that conflict with core items
    // We filter out any item that is explicitly marked as 'core' plugin (provided by backend)
    // or has a URL collision with our hardcoded core items
    const uniquePluginMenus = pluginMenus.filter((pItem: any) => {
        if (pItem.plugin === 'core') return false;
        return !coreMenuItems.some(cItem => cItem.href === pItem.href);
    });

    // Combine core + unique plugin menus and FILTER by capability

    // Split plugins into sections
    const coreSectionPlugins = uniquePluginMenus.filter((p: any) => p.section !== 'management');
    const managementSectionPlugins = uniquePluginMenus.filter((p: any) => p.section === 'management');

    const coreSectionItems = [
        ...coreMenuItems.slice(0, 6).filter(item => can(item.cap)),
        ...coreSectionPlugins.filter(item => can(item.cap))
    ];

    const managementSectionItems = [
        ...managementSectionPlugins.filter(item => can(item.cap)),
        ...coreMenuItems.slice(6).filter(item => can(item.cap))
    ];

    const renderMenuItem = (item: SidebarMenuItem) => {
        const itemUrl = new URL(item.href, 'http://localhost'); // Dummy base for URL parsing
        const itemType = itemUrl.searchParams.get('type');
        const currentType = searchParams.get('type');

        const isActive = pathname === itemUrl.pathname && currentType === itemType;

        return (
            <div
                key={item.href}
                className="w-full relative px-2"
                onMouseEnter={(e) => {
                    if (isCollapsed) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const labelText = typeof item.label === 'string' && item.label.startsWith('nav.')
                            ? t(item.label)
                            : String(item.label);
                        setHoveredItem({ label: labelText, top: rect.top + (rect.height / 2) });
                    }
                }}
                onMouseLeave={() => setHoveredItem(null)}
            >
                <SmartLink
                    href={item.href}
                    onClick={() => onClose()} // Close on navigation (mobile)
                    title={undefined} // Remove title to prevent native tooltip
                    className={`flex items-center gap-4 rounded-[20px] transition-all duration-300 group relative pointer-events-auto overflow-hidden
                    ${isActive
                            ? (isCollapsed ? "md:bg-gradient-to-br md:from-blue-600 md:to-blue-500 md:text-white md:shadow-lg md:shadow-blue-500/30 bg-blue-600/10 text-blue-400 font-bold" : "bg-gradient-to-br from-blue-600 to-blue-500 text-white font-bold shadow-lg shadow-blue-500/20")
                            : "text-gray-400 hover:bg-white/5 hover:text-white"
                        } 
                    ${isCollapsed ? "md:w-12 md:h-12 md:justify-center md:mx-auto px-4 py-3.5" : "px-4 py-3.5 mx-2"}
                    `}
                >
                    {isActive && (
                        <div className={`absolute -left-[4px] bottom-3 top-3 w-1.5 bg-blue-300 rounded-r-full shadow-[0_0_15px_rgba(255,255,255,0.5)] ${isCollapsed ? "md:hidden block" : "hidden"}`}></div>
                    )}

                    <i className={`fa-solid ${item.icon} transition-all duration-300 group-hover:scale-110 ${isCollapsed ? 'md:text-lg w-5 text-center text-sm' : 'w-5 text-center text-sm'} ${isActive ? 'text-white' : 'text-gray-500 group-hover:text-white'}`}></i>

                    <span className={`text-sm font-medium tracking-wide truncate transition-all duration-300 opacity-100 translate-x-0 ${isCollapsed ? "md:hidden block" : "block"}`}>
                        {typeof item.label === 'string' && item.label.startsWith('nav.')
                            ? t(item.label)
                            : typeof item.label === 'string' || typeof item.label === 'number'
                                ? item.label
                                : <span className="text-red-500 font-mono text-xs">ERR</span>
                        }
                    </span>

                    {/* Hover Glow Effect */}
                    {!isActive && (
                        <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>
                    )}
                </SmartLink>
            </div>
        );
    };

    return (
        <>
            {/* Mobile Backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[5001] md:hidden animate-in fade-in duration-300"
                    onClick={onClose}
                />
            )}

            <aside className={`
                fixed inset-y-0 left-0 z-[5002] bg-[#0f172a] text-white h-screen flex flex-col transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] border-r border-white/5 shadow-2xl
                md:relative md:translate-x-0
                ${isCollapsed ? "md:w-28 w-80" : "md:w-80 w-80"}
                ${isOpen ? "translate-x-0" : "-translate-x-full"}
            `}>
                {/* Logo - Fixed */}
                <div className={`
                    flex flex-shrink-0 transition-all duration-300
                    ${isCollapsed ? "md:flex-col md:items-center md:gap-6 md:p-6 justify-between items-center p-6 pb-8" : "justify-between items-center p-8 pb-10"}
                `}>
                    <Link href="/admin" className=" relative z-10 text-2xl font-black flex items-center gap-3 tracking-tight group overflow-hidden flex-1 min-w-0 mr-2">
                        {logoUrl ? (
                            <div className={`
                                flex-shrink-0 bg-white/5 rounded-2xl p-1.5 ring-1 ring-white/10 group-hover:ring-blue-500/50 transition-all shadow-lg shadow-black/20
                                ${isCollapsed ? "md:h-12 md:w-12 h-12 w-12" : "h-12 w-12"}
                            `}>
                                <img src={logoUrl} alt={siteTitle} className="h-full w-full object-contain drop-shadow-md" />
                            </div>
                        ) : (
                            <div className={`
                                bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg shadow-blue-500/30 ring-1 ring-white/20 group-hover:rotate-12 transition-transform
                                ${isCollapsed ? "md:p-3 p-3" : "p-3"}
                            `}>
                                <i className={`fa-solid fa-rocket text-white ${isCollapsed ? "md:text-lg text-xl" : "text-xl"}`}></i>
                            </div>
                        )}
                        <span className={`bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent truncate max-w-[180px] transition-all duration-300 opacity-100 translate-x-0 font-black italic tracking-tighter ${isCollapsed ? "md:hidden block" : "block"}`}>
                            {typeof siteTitle === 'string' ? siteTitle : JSON.stringify(siteTitle)}
                        </span>
                    </Link>
                    <div className={`flex items-center ${isCollapsed ? "md:gap-0 gap-3" : "gap-3"}`}>
                        <div className="hidden md:block">
                            <NotificationCenter variant="inline" isCollapsed={isCollapsed} />
                        </div>
                        <button onClick={onClose} className="md:hidden text-gray-400 hover:text-white transition-colors p-2 hover:bg-white/10 rounded-xl">
                            <i className="fa-solid fa-xmark text-xl"></i>
                        </button>
                    </div>
                </div>

                {/* Navigation - Scrollable */}
                <nav className={`
                    flex-1 overflow-y-auto min-h-0 space-y-8 custom-scrollbar transition-all duration-300
                    ${isCollapsed ? "md:px-2 md:py-8 md:scrollbar-hide px-4 py-2" : "px-4 py-2"}
                `}>
                    <div className="space-y-2">
                        <div className={`px-6 mb-3 ${isCollapsed ? "md:hidden block" : "block"}`}>
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-500/80">Core</span>
                        </div>
                        {coreSectionItems.map((item) => renderMenuItem(item))}
                    </div>

                    <div className="space-y-2">
                        <div className={`px-6 mb-3 ${isCollapsed ? "md:hidden block" : "block"}`}>
                            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-500/80">System</span>
                        </div>
                        {managementSectionItems.map((item) => renderMenuItem(item))}
                    </div>
                </nav>

                {/* User info & Logout - Fixed at bottom */}
                <div className={`mt-auto transition-all duration-300 ${isCollapsed ? "md:p-4 md:space-y-4 p-6" : "p-6"}`}>
                    <div className={`
                        bg-gradient-to-br from-white/5 to-white/0 rounded-[30px] border border-white/5 backdrop-blur-sm group hover:bg-white/10 transition-colors
                        ${isCollapsed ? "md:w-14 md:h-14 md:flex md:items-center md:justify-center md:mx-auto md:rounded-2xl p-4 mb-4" : "p-4 mb-4"}
                    `}>
                        <div className="flex items-center gap-4">
                            <div className={`
                                rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-900/50 ring-2 ring-white/10 transition-transform group-hover:scale-105
                                ${isCollapsed ? "md:w-9 md:h-9 md:rounded-xl w-10 h-10 rounded-2xl" : "w-10 h-10 rounded-2xl"}
                            `}>
                                <i className={`fa-solid fa-user text-white ${isCollapsed ? "md:text-sm text-sm" : "text-sm"}`}></i>
                            </div>
                            <div className={`flex-1 min-w-0 transition-all duration-300 opacity-100 translate-x-0 ${isCollapsed ? "md:hidden block" : "block"}`}>
                                <p className="truncate font-bold text-gray-100 text-sm">
                                    {(() => {
                                        const name = user?.displayName || user?.username;
                                        return typeof name === 'string' ? name : 'User';
                                    })()}
                                </p>
                                <p className="truncate text-[9px] text-blue-400 uppercase font-black tracking-widest leading-none mt-1">
                                    {typeof user?.role === 'string' ? user.role : 'Member'}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Custom Language Selector */}
                    <div className={`mb-3 relative ${isCollapsed ? "md:hidden block" : "block"}`}>
                        {isLangMenuOpen && (
                            <>
                                <div className="fixed inset-0 z-10" onClick={() => setIsLangMenuOpen(false)}></div>
                                <div className="absolute bottom-full left-0 w-full mb-2 bg-[#1e293b] border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-20 animate-in slide-in-from-bottom-2 fade-in duration-200">
                                    {languages.map((lang) => (
                                        <button
                                            key={lang.code}
                                            onClick={() => {
                                                setLanguage(lang.code as any);
                                                setIsLangMenuOpen(false);
                                            }}
                                            className={`w-full px-5 py-3 text-left flex items-center gap-3 hover:bg-white/5 transition-colors text-sm ${language === lang.code ? 'bg-blue-600/20 text-blue-400 font-bold' : 'text-gray-300'}`}
                                        >
                                            <span className="text-lg">{lang.flag}</span>
                                            <span>{lang.label}</span>
                                            {language === lang.code && <i className="fa-solid fa-check ml-auto text-blue-400"></i>}
                                        </button>
                                    ))}
                                </div>
                            </>
                        )}
                        <button
                            onClick={() => setIsLangMenuOpen(!isLangMenuOpen)}
                            className="w-full px-4 py-3 bg-white/5 hover:bg-white/10 text-white text-sm rounded-2xl border border-white/5 flex items-center justify-between transition-all group hover:border-white/20"
                        >
                            <div className="flex items-center gap-3">
                                <span className="text-lg leading-none grayscale group-hover:grayscale-0 transition-all">{currentLang.flag}</span>
                                <span className="font-bold text-gray-400 group-hover:text-white transition-colors text-[11px] uppercase tracking-wider">{currentLang.label}</span>
                            </div>
                            <i className={`fa-solid fa-chevron-up text-[10px] text-gray-600 transition-transform duration-200 ${isLangMenuOpen ? 'rotate-180 text-blue-400' : ''}`}></i>
                        </button>
                    </div>

                    <button
                        onClick={logout}
                        title={isCollapsed ? t('nav.sign.out') : undefined}
                        className={`
                            bg-red-500/5 hover:bg-red-500/10 text-red-400/60 hover:text-red-400 rounded-2xl transition-all flex items-center gap-3 font-bold text-sm border border-transparent hover:border-red-500/20 group overflow-hidden relative mx-auto
                            ${isCollapsed ? "md:w-14 md:h-14 md:justify-center py-4 px-4 justify-center w-full" : "py-4 px-4 justify-center w-full"}
                        `}
                    >
                        <i className="fa-solid fa-right-from-bracket transition-transform group-hover:translate-x-1"></i>
                        <span className={`transition-all duration-300 opacity-100 translate-x-0 font-bold text-[10px] uppercase tracking-widest ${isCollapsed ? "md:hidden block" : "block"}`}>{t('nav.sign.out')}</span>
                    </button>
                </div>
            </aside >

            {/* Global Fixed Tooltip Portal */}
            {isCollapsed && hoveredItem && (
                <div
                    className="fixed z-[100] px-4 py-3 bg-gray-900 text-white text-[11px] font-black rounded-xl shadow-2xl border border-white/10 uppercase tracking-widest backdrop-blur-md bg-opacity-95 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
                    style={{
                        top: hoveredItem.top,
                        left: '120px',
                        transform: 'translateY(-50%)'
                    }}
                >
                    {hoveredItem.label}
                    {/* Tooltip Arrow */}
                    <div className="absolute right-full top-1/2 -translate-y-1/2 border-[6px] border-transparent border-r-gray-900"></div>
                </div>
            )}
        </>
    );
}
