"use client";

import Link from "next/link";
import SmartLink from "./SmartLink";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useMenu } from "@/contexts/MenuContext";
import { useI18n } from "@/contexts/I18nContext";
import { menuLabel as pickMenuLabel } from "@/lib/menuLabel";
import { useEffect, useRef, useState } from "react";
import NotificationCenter from "./NotificationCenter";
import { firstAllowedAdminPath, visibleSidebarSections, type AdminMenuItem } from "@/lib/adminAccess";
import { roleDisplayName } from "@/lib/roleOptions";

// The core entries, their capabilities and the section split live in lib/adminAccess.ts: the admin
// layout's route guard reads the SAME map, so a page you cannot see here is a page you cannot open.
type SidebarMenuItem = AdminMenuItem;

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
    const menuLabel = (item: any) => pickMenuLabel(item, language, t);
    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [siteTitle, setSiteTitle] = useState("WordJS");
    const [hoveredItem, setHoveredItem] = useState<{ label: string; top: number } | null>(null);
    const [isLangMenuOpen, setIsLangMenuOpen] = useState(false);

    const asideRef = useRef<HTMLElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    // Below lg the open sidebar is a modal drawer over the page. Above it, it is the page's own nav and
    // isOpen never applies.
    const [isDrawer, setIsDrawer] = useState(false);
    useEffect(() => {
        if (!isOpen) { setIsDrawer(false); return; }
        setIsDrawer(!window.matchMedia("(min-width: 1024px)").matches);
    }, [isOpen]);

    // The off-canvas menu behaves as a dialog: Escape closes it, focus moves INTO it on open (it used
    // to stay on "Open menu", and Tab walked the page behind the overlay), Tab stays inside it, and
    // focus goes back to the button that opened it on close.
    useEffect(() => {
        if (!isDrawer) return;
        const opener = document.activeElement as HTMLElement | null;
        // The drawer slides in with visibility still transitioning from hidden, and nothing inside a
        // hidden box can take focus — so keep asking until it lands (or give up after ~3s).
        let tries = 0;
        const focusIn = window.setInterval(() => {
            closeRef.current?.focus();
            if (document.activeElement === closeRef.current || ++tries > 60) window.clearInterval(focusIn);
        }, 50);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { onClose(); return; }
            if (e.key !== "Tab" || !asideRef.current) return;
            const items = [...asideRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])')]
                .filter((el) => el.offsetParent !== null);
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey && (active === first || !asideRef.current.contains(active))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (active === last || !asideRef.current.contains(active))) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            window.clearInterval(focusIn);
            document.removeEventListener("keydown", onKey);
            if (opener && document.contains(opener)) opener.focus();
        };
    }, [isDrawer, onClose]);

    const languages = [
        { code: 'es', label: 'Español' },
        { code: 'en', label: 'English' },
        { code: 'pt', label: 'Português' },
    ];

    const currentLang = languages.find(l => l.code === language) || languages[0];

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

    // Core entries + plugin entries, filtered by capability and by what the route guard lets this user
    // open, in display order (lib/adminAccess.ts sidebarSections — also what the post-login landing uses).
    // A section with no entry for this user is not drawn at all: no heading over nothing.
    const sections = visibleSidebarSections(user, pluginMenus as unknown as AdminMenuItem[]);
    // The logo leads "home": the dashboard for whoever may open it, otherwise the first page this user's
    // sidebar offers (a plugin team member's plugin screen) — never a page the route guard would refuse.
    const homeHref = firstAllowedAdminPath(user, pluginMenus as unknown as AdminMenuItem[]);

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
                        const labelText = String(menuLabel(item));
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
                            ? (isCollapsed ? "lg:bg-gradient-to-br lg:from-blue-600 lg:to-blue-500 lg:text-white lg:shadow-lg lg:shadow-blue-500/30 bg-blue-600/10 text-blue-400 font-bold" : "bg-gradient-to-br from-blue-600 to-blue-500 text-white font-bold shadow-lg shadow-blue-500/20")
                            : "text-gray-400 hover:bg-white/5 hover:text-white"
                        } 
                    ${isCollapsed ? "lg:w-12 lg:h-12 lg:justify-center lg:mx-auto px-4 py-3.5" : "px-4 py-3.5 mx-2"}
                    `}
                >
                    {isActive && (
                        <div className={`absolute -left-[4px] bottom-3 top-3 w-1.5 bg-blue-300 rounded-r-full shadow-[0_0_15px_rgba(255,255,255,0.5)] ${isCollapsed ? "lg:hidden block" : "hidden"}`}></div>
                    )}

                    <i className={`fa-solid ${item.icon} transition-all duration-300 group-hover:scale-110 ${isCollapsed ? 'lg:text-lg w-5 text-center text-sm' : 'w-5 text-center text-sm'} ${isActive ? 'text-white' : 'text-gray-500 group-hover:text-white'}`}></i>

                    <span className={`text-sm font-medium tracking-wide truncate transition-all duration-300 opacity-100 translate-x-0 ${isCollapsed ? "lg:hidden block" : "block"}`}>
                        {typeof item.label === 'string' || typeof item.label === 'number'
                            ? menuLabel(item)
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
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[5001] lg:hidden animate-in fade-in duration-300"
                    onClick={onClose}
                />
            )}

            {/* h-dvh, not h-screen: on iOS 100vh is the LARGE viewport, so the bottom of the menu sat
                under Safari's toolbar (same reason as the shell in DashboardLayoutClient). */}
            <aside
                ref={asideRef}
                id="wjs-admin-sidebar"
                data-wjs-host-ui=""
                {...(isDrawer ? { role: "dialog", "aria-modal": true, "aria-label": t("nav.menu") } : {})}
                className={`
                fixed inset-y-0 left-0 z-[5002] bg-[#0f172a] text-white h-dvh flex flex-col transition-all duration-500 [transition-timing-function:cubic-bezier(0.4,0,0.2,1)] border-r border-white/5 lg:shadow-2xl
                lg:relative lg:translate-x-0
                ${isCollapsed ? "lg:w-28 w-80 max-w-[85vw]" : "lg:w-80 w-80 max-w-[85vw]"}
                ${isOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full shadow-none max-lg:invisible"}
            `}>
                {/* Logo - Fixed */}
                <div className={`
                    flex flex-shrink-0 transition-all duration-300
                    ${isCollapsed ? "lg:flex-col lg:items-center lg:gap-6 lg:p-6 justify-between items-center p-6 pb-8" : "justify-between items-center p-8 pb-10"}
                `}>
                    {/* No overflow-hidden here: it cut the logo's glow to a hard-edged box. The site name truncates on
                        its own (`truncate`), and the logo keeps its square (shrink-0) beside a long name. */}
                    <Link href={homeHref} data-sidebar-home="" className=" relative z-10 text-2xl font-black flex items-center gap-3 tracking-tight group flex-1 min-w-0 mr-2">
                        {logoUrl ? (
                            <div className={`
                                flex-shrink-0 bg-white/5 rounded-2xl p-1.5 ring-1 ring-white/10 group-hover:ring-blue-500/50 transition-all shadow-lg shadow-black/20
                                ${isCollapsed ? "lg:h-12 lg:w-12 h-12 w-12" : "h-12 w-12"}
                            `}>
                                <img src={logoUrl} alt={siteTitle} className="h-full w-full object-contain drop-shadow-md" />
                            </div>
                        ) : (
                            <div data-sidebar-logo="" className={`
                                shrink-0 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg shadow-blue-500/30 ring-1 ring-white/20 group-hover:rotate-12 transition-transform
                                ${isCollapsed ? "lg:p-3 p-3" : "p-3"}
                            `}>
                                <i className={`fa-solid fa-rocket text-white ${isCollapsed ? "lg:text-lg text-xl" : "text-xl"}`}></i>
                            </div>
                        )}
                        <span className={`bg-gradient-to-r from-white to-gray-400 bg-clip-text text-transparent truncate max-w-[180px] transition-all duration-300 opacity-100 translate-x-0 font-black italic tracking-tighter ${isCollapsed ? "lg:hidden block" : "block"}`}>
                            {typeof siteTitle === 'string' ? siteTitle : JSON.stringify(siteTitle)}
                        </span>
                    </Link>
                    <div className={`flex items-center ${isCollapsed ? "lg:gap-0 gap-3" : "gap-3"}`}>
                        <div className="hidden lg:block">
                            <NotificationCenter variant="inline" isCollapsed={isCollapsed} />
                        </div>
                        <button ref={closeRef} type="button" onClick={onClose} aria-label={t("nav.closeMenu")} className="lg:hidden w-11 h-11 shrink-0 flex items-center justify-center text-gray-400 hover:text-white transition-colors hover:bg-white/10 rounded-xl">
                            <i className="fa-solid fa-xmark text-xl" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>

                {/* Navigation - Scrollable */}
                <nav className={`
                    flex-1 overflow-y-auto min-h-0 space-y-8 custom-scrollbar transition-all duration-300
                    ${isCollapsed ? "lg:px-2 lg:py-8 lg:scrollbar-hide px-4 py-2" : "px-4 py-2"}
                `}>
                    {sections.map((section) => (
                        <div key={section.key} className="space-y-2" data-sidebar-section={section.key}>
                            <div className={`px-6 mb-3 ${isCollapsed ? "lg:hidden block" : "block"}`}>
                                <span className="text-[11px] font-black uppercase tracking-[0.2em] text-blue-500/80">{t(section.labelKey)}</span>
                            </div>
                            {section.items.map((item) => renderMenuItem(item))}
                        </div>
                    ))}
                </nav>

                {/* User info & Logout - Fixed at bottom */}
                <div className={`mt-auto transition-all duration-300 ${isCollapsed ? "lg:p-4 lg:space-y-4 p-6" : "p-6"}`}>
                    <div className={`
                        bg-gradient-to-br from-white/5 to-white/0 rounded-[30px] border border-white/5 backdrop-blur-sm group hover:bg-white/10 transition-colors
                        ${isCollapsed ? "lg:w-14 lg:h-14 lg:flex lg:items-center lg:justify-center lg:mx-auto lg:rounded-2xl p-4 mb-4" : "p-4 mb-4"}
                    `}>
                        <div className="flex items-center gap-4">
                            <div className={`
                                shrink-0 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-900/50 ring-2 ring-white/10 transition-transform group-hover:scale-105
                                ${isCollapsed ? "lg:w-9 lg:h-9 lg:rounded-xl w-10 h-10 rounded-2xl" : "w-10 h-10 rounded-2xl"}
                            `}>
                                <i className={`fa-solid fa-user text-white ${isCollapsed ? "lg:text-sm text-sm" : "text-sm"}`}></i>
                            </div>
                            <div className={`flex-1 min-w-0 transition-all duration-300 opacity-100 translate-x-0 ${isCollapsed ? "lg:hidden block" : "block"}`}>
                                <p className="truncate font-bold text-gray-100 text-sm">
                                    {(() => {
                                        const name = user?.displayName || user?.username;
                                        return typeof name === 'string' ? name : 'User';
                                    })()}
                                </p>
                                <p className="truncate text-[11px] text-blue-400 uppercase font-black tracking-widest leading-none mt-1" data-sidebar-role="">
                                    {roleDisplayName(user, t) || 'Member'}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Custom Language Selector */}
                    <div className={`mb-3 relative ${isCollapsed ? "lg:hidden block" : "block"}`}>
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
                                            <span className="text-[11px] font-black uppercase tracking-wider w-7 text-center px-1.5 py-0.5 rounded-md bg-white/10">{lang.code.toUpperCase()}</span>
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
                                <span className="text-[11px] font-black uppercase tracking-wider w-7 text-center px-1.5 py-0.5 rounded-md bg-white/10 text-gray-300 group-hover:text-white transition-colors">{currentLang.code.toUpperCase()}</span>
                                <span className="font-bold text-gray-400 group-hover:text-white transition-colors text-[11px] uppercase tracking-wider">{currentLang.label}</span>
                            </div>
                            <i className={`fa-solid fa-chevron-up text-[11px] text-gray-600 transition-transform duration-200 ${isLangMenuOpen ? 'rotate-180 text-blue-400' : ''}`}></i>
                        </button>
                    </div>

                    <button
                        onClick={logout}
                        title={isCollapsed ? t('nav.sign.out') : undefined}
                        className={`
                            bg-red-500/5 hover:bg-red-500/10 text-red-400/60 hover:text-red-400 rounded-2xl transition-all flex items-center gap-3 font-bold text-sm border border-transparent hover:border-red-500/20 group overflow-hidden relative mx-auto
                            ${isCollapsed ? "lg:w-14 lg:h-14 lg:justify-center py-4 px-4 justify-center w-full" : "py-4 px-4 justify-center w-full"}
                        `}
                    >
                        <i className="fa-solid fa-right-from-bracket transition-transform group-hover:translate-x-1"></i>
                        <span className={`transition-all duration-300 opacity-100 translate-x-0 font-bold text-[11px] uppercase tracking-widest ${isCollapsed ? "lg:hidden block" : "block"}`}>{t('nav.sign.out')}</span>
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
