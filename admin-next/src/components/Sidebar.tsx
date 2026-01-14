"use client";

import Link from "next/link";
import SmartLink from "./SmartLink";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useMenu } from "@/contexts/MenuContext";
import { useEffect, useState } from "react";

interface SidebarMenuItem {
    href: string;
    label: string;
    icon: string;
    cap?: string;
}

// Core menu items with required capabilities
const coreMenuItems: SidebarMenuItem[] = [
    { href: "/admin", label: "Dashboard", icon: "fa-chart-pie", cap: "read" },
    { href: "/admin/posts", label: "Posts", icon: "fa-pen-to-square", cap: "edit_posts" },
    { href: "/admin/pages", label: "Pages", icon: "fa-file-lines", cap: "edit_pages" },
    { href: "/admin/media", label: "Media", icon: "fa-images", cap: "upload_files" },
    { href: "/admin/menus", label: "Menus", icon: "fa-bars", cap: "edit_theme_options" },
    { href: "/admin/footer", label: "Footer", icon: "fa-shoe-prints", cap: "edit_theme_options" },
    { href: "/admin/widgets", label: "Widgets", icon: "fa-shapes", cap: "edit_theme_options" },
    { href: "/admin/comments", label: "Comments", icon: "fa-comments", cap: "moderate_comments" },
    { href: "/admin/users", label: "Users", icon: "fa-users", cap: "list_users" },
    { href: "/admin/users/roles", label: "Roles", icon: "fa-shield-halved", cap: "manage_options" },
    { href: "/admin/categories", label: "Categories", icon: "fa-folder", cap: "manage_categories" },
    { href: "/admin/plugins", label: "Plugins", icon: "fa-plug", cap: "activate_plugins" },
    { href: "/admin/themes", label: "Themes", icon: "fa-palette", cap: "switch_themes" },
    { href: "/admin/settings", label: "Settings", icon: "fa-gear", cap: "manage_options" },
];

interface SidebarProps {
    isOpen: boolean;
    onClose: () => void;
    isCollapsed?: boolean;
}

export default function Sidebar({ isOpen, onClose, isCollapsed = false }: SidebarProps) {
    const pathname = usePathname();
    const { logout, user } = useAuth();
    const { pluginMenus } = useMenu(); // Use global context
    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [siteTitle, setSiteTitle] = useState("WordJS");
    const [hoveredItem, setHoveredItem] = useState<{ label: string; top: number } | null>(null);

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

    // Combine core + plugin menus and FILTER by capability
    const allMenuItems = [
        ...coreMenuItems.slice(0, 6).filter(item => can(item.cap)),
        ...pluginMenus.filter(item => can(item.cap)),
        ...coreMenuItems.slice(6).filter(item => can(item.cap))
    ];

    return (
        <>
            {/* Mobile Backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-30 md:hidden glass"
                    onClick={onClose}
                />
            )}

            <aside className={`
                fixed inset-y-0 left-0 z-40 bg-[#0f172a] text-white h-screen flex flex-col transition-all duration-300 ease-in-out border-r border-white/5 shadow-2xl
                md:relative md:translate-x-0
                ${isCollapsed ? "w-24" : "w-80"}
                ${isOpen ? "translate-x-0" : "-translate-x-full"}
            `}>
                {/* Logo - Fixed */}
                <div className={`
                    flex justify-between items-center flex-shrink-0 transition-all duration-300
                    ${isCollapsed ? "p-6" : "p-8 pb-10"}
                `}>
                    <Link href="/admin" className="text-2xl font-black flex items-center gap-3 tracking-tight group overflow-hidden">
                        {logoUrl ? (
                            <div className={`
                                flex-shrink-0 bg-white/5 rounded-xl p-1.5 ring-4 ring-white/5 group-hover:ring-blue-500/20 transition-all
                                ${isCollapsed ? "h-11 w-11" : "h-12 w-12"}
                            `}>
                                <img src={logoUrl} alt={siteTitle} className="h-full w-full object-contain" />
                            </div>
                        ) : (
                            <div className={`
                                bg-blue-600 rounded-xl shadow-lg shadow-blue-500/30 ring-4 ring-blue-500/10 group-hover:rotate-12 transition-transform
                                ${isCollapsed ? "p-2.5" : "p-3"}
                            `}>
                                <i className={`fa-solid fa-rocket text-white ${isCollapsed ? "text-lg" : "text-xl"}`}></i>
                            </div>
                        )}
                        {!isCollapsed && (
                            <span className="bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent truncate max-w-[180px] transition-all duration-300 opacity-100 translate-x-0">
                                {siteTitle}
                            </span>
                        )}
                    </Link>
                    <button onClick={onClose} className="md:hidden text-gray-400 hover:text-white transition-colors">
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>

                {/* Navigation - Scrollable */}
                <nav className={`
                    flex-1 overflow-y-auto min-h-0 space-y-3 custom-scrollbar transition-all duration-300
                    ${isCollapsed ? "px-4 py-8 scrollbar-hide" : "px-5 py-2"}
                `}>
                    {allMenuItems.map((item) => {
                        const isActive = pathname === item.href ||
                            (item.href !== "/admin" && pathname.startsWith(item.href));

                        return (
                            <div
                                key={item.href}
                                className="w-full relative"
                                onMouseEnter={(e) => {
                                    if (isCollapsed) {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setHoveredItem({ label: item.label, top: rect.top + (rect.height / 2) });
                                    }
                                }}
                                onMouseLeave={() => setHoveredItem(null)}
                            >
                                <SmartLink
                                    href={item.href}
                                    onClick={() => onClose()} // Close on navigation (mobile)
                                    title={undefined} // Remove title to prevent native tooltip
                                    className={`flex items-center gap-3.5 rounded-2xl transition-all duration-200 group relative pointer-events-auto ${isActive
                                        ? (isCollapsed ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-blue-600/10 text-blue-400 font-bold")
                                        : "text-gray-400 hover:bg-white/5 hover:text-white"
                                        } ${isCollapsed ? "w-14 h-14 justify-center mx-auto" : "px-4 py-3"}`}
                                >
                                    {isActive && !isCollapsed && (
                                        <div className="absolute -left-[4px] bottom-3 top-3 w-1.5 bg-blue-500 rounded-r-full shadow-[0_0_15px_rgba(59,130,246,0.5)]"></div>
                                    )}
                                    <i className={`fa-solid ${item.icon} transition-transform group-hover:scale-110 ${isCollapsed ? 'text-lg' : 'w-5 text-center text-sm'} ${isActive ? (isCollapsed ? 'text-white' : 'text-blue-500') : 'text-gray-500 group-hover:text-blue-400'}`}></i>
                                    {!isCollapsed && (
                                        <span className="text-sm tracking-wide truncate transition-all duration-300 opacity-100 translate-x-0">
                                            {item.label}
                                        </span>
                                    )}
                                </SmartLink>
                            </div>
                        );
                    })}
                </nav>

                {/* User info & Logout - Fixed at bottom */}
                <div className={`mt-auto transition-all duration-300 ${isCollapsed ? "p-4 space-y-4" : "p-6"}`}>
                    <div className={`
                        bg-white/5 rounded-3xl border border-white/5 group hover:bg-white/10 transition-colors
                        ${isCollapsed ? "w-14 h-14 flex items-center justify-center mx-auto rounded-2xl" : "p-4 mb-4"}
                    `}>
                        <div className="flex items-center gap-3">
                            <div className={`
                                rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg ring-4 ring-blue-500/10 transition-transform group-hover:rotate-6
                                ${isCollapsed ? "w-9 h-9 rounded-xl" : "w-10 h-10 rounded-2xl"}
                            `}>
                                <i className={`fa-solid fa-user text-white ${isCollapsed ? "text-sm" : "text-sm"}`}></i>
                            </div>
                            {!isCollapsed && (
                                <div className="flex-1 min-w-0 transition-all duration-300 opacity-100 translate-x-0">
                                    <p className="truncate font-bold text-gray-100 text-sm">{user?.displayName || user?.username}</p>
                                    <p className="truncate text-[10px] text-gray-500 uppercase font-black tracking-widest leading-none mt-1">{user?.role}</p>
                                </div>
                            )}
                        </div>
                    </div>

                    <button
                        onClick={logout}
                        title={isCollapsed ? "Sign Out" : undefined}
                        className={`
                            bg-red-500/5 hover:bg-red-500/10 text-red-400/80 hover:text-red-400 rounded-2xl transition-all flex items-center gap-3 font-bold text-sm border border-red-500/10 group overflow-hidden relative mx-auto
                            ${isCollapsed ? "w-14 h-14 justify-center" : "py-3.5 px-4 justify-center w-full"}
                        `}
                    >
                        <i className="fa-solid fa-right-from-bracket transition-transform group-hover:translate-x-1"></i>
                        {!isCollapsed && <span className="transition-all duration-300 opacity-100 translate-x-0">Sign Out</span>}
                        <div className="absolute inset-0 bg-red-500/5 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                    </button>
                </div>
            </aside >

            {/* Global Fixed Tooltip Portal */}
            {isCollapsed && hoveredItem && (
                <div
                    className="fixed z-[100] px-3 py-2 bg-gray-900 text-white text-[11px] font-bold rounded-xl shadow-2xl border border-white/5 uppercase tracking-wider backdrop-blur-md bg-opacity-95 pointer-events-none animate-in fade-in zoom-in-95 duration-150"
                    style={{
                        top: hoveredItem.top,
                        left: '104px', // w-24 (96px) + 8px gap
                        transform: 'translateY(-50%)'
                    }}
                >
                    {hoveredItem.label}
                    {/* Tooltip Arrow */}
                    <div className="absolute right-full top-1/2 -translate-y-1/2 border-[5px] border-transparent border-r-gray-900"></div>
                </div>
            )}
        </>
    );
}

