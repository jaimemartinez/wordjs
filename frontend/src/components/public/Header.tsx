"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";
import type { HeaderVariant } from "@/lib/themeLayout";

interface HeaderProps {
    disableSticky?: boolean;
    // Structure config from theme.json `layout` v2 (normalized upstream by PublicLayoutShell). The
    // defaults reproduce today's markup exactly, so a theme without `layout` renders unchanged.
    variant?: HeaderVariant;
    sticky?: boolean;
    transparent?: boolean;
    // SSR-provided chrome data (live site): when present the Header renders from it in the initial HTML
    // and SKIPS the client fetch — no per-visitor double-fetch of menu+settings. Omitted by the editor
    // preview, which falls back to fetching client-side.
    initialMenu?: any[];
    initialSettings?: Record<string, any>;
}

export default function Header({ disableSticky = false, variant = "classic", sticky = true, transparent = false, initialMenu, initialSettings }: HeaderProps) {
    const hasSSR = initialSettings !== undefined;
    const [isScrolled, setIsScrolled] = useState(false);
    const [menuItems, setMenuItems] = useState<any[]>(() =>
        initialMenu ? [...initialMenu].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : []);
    const [logoUrl, setLogoUrl] = useState<string | null>(initialSettings?.site_logo || null);
    const [siteTitle, setSiteTitle] = useState<string>(initialSettings?.blogname || "");
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const headerRef = useRef<HTMLElement>(null);

    useEffect(() => {
        // Only react to scroll when sticky (full page / editor preview).
        if (disableSticky) return;
        const targetWindow = headerRef.current?.ownerDocument?.defaultView || window;
        const handleScroll = (e?: Event) => {
            // The scroll container is the window on the live site, but inside the editor's NATIVE
            // preview the canvas scrolls in an overflow:auto <div>. Scroll events don't bubble, so a
            // capturing listener on the window catches BOTH; read the offset from whichever element
            // actually scrolled (the div in the editor, document/window on the live site).
            const target = e?.target as any;
            let top = targetWindow.scrollY || 0;
            if (target && target.nodeType === 1 && target !== targetWindow.document?.documentElement && typeof target.scrollTop === "number") {
                top = target.scrollTop;
            }
            setIsScrolled(top > 10);
        };
        // capture:true lets this window-level listener see scroll from nested scrollers too.
        targetWindow.addEventListener("scroll", handleScroll, { capture: true, passive: true });
        handleScroll();
        return () => targetWindow.removeEventListener("scroll", handleScroll, { capture: true } as any);
    }, [disableSticky]);

    // Close mobile menu on resize to desktop
    useEffect(() => {
        // minimal keeps the nav in the panel at every width — never auto-close it on desktop resize.
        if (variant === "minimal") return;
        const handleResize = () => {
            if (window.innerWidth >= 768) {
                setMobileMenuOpen(false);
            }
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [variant]);

    // The mobile panel is a drawer over the page: Escape must dismiss it (a keyboard user has no
    // other way back once focus is inside), and the page behind must not scroll under it.
    useEffect(() => {
        if (!mobileMenuOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileMenuOpen(false); };
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = previousOverflow;
        };
    }, [mobileMenuOpen]);

    const fetchData = async () => {
        try {
            const { menusApi, settingsApi } = await import("@/lib/api");

            // Parallel fetch
            const [menu, settings] = await Promise.all([
                menusApi.getByLocation('header').catch(() => null),
                settingsApi.get().catch(() => null)
            ]);

            if (menu && menu.items) {
                setMenuItems(menu.items.sort((a: any, b: any) => a.order - b.order));
            }

            if (settings) {
                if (settings.site_logo) setLogoUrl(settings.site_logo);
                if (settings.blogname) setSiteTitle(settings.blogname);
            }

        } catch { /* header renders with whatever it has (empty chrome degrades gracefully) */ }
    };

    useEffect(() => {
        // Live site: the server already provided menu+settings as props → skip the client fetch.
        // Editor preview (no SSR props): fetch client-side as before.
        if (hasSSR) return;
        fetchData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, url: string) => {
        setMobileMenuOpen(false);

        // Check if it's an anchor link (starts with # or /# or current path + #)
        const isAnchor = url.includes("#");
        if (!isAnchor) return;

        const [path, hash] = url.split("#");
        const currentPath = window.location.pathname;

        // Only handle manual scroll if we are on the same page
        if (path === "" || path === "/" || path === currentPath || window.location.href.includes(path)) {
            e.preventDefault();

            const scrollToElement = () => {
                const element = document.getElementById(hash);
                if (element) {
                    element.scrollIntoView({ behavior: "smooth" });
                    window.history.pushState({}, "", `#${hash}`);
                }
            };

            // Try immediately
            const element = document.getElementById(hash);
            if (element) {
                scrollToElement();
            } else {
                // Retry for dynamic content (up to 500ms)
                setTimeout(scrollToElement, 100);
                setTimeout(scrollToElement, 300);
                setTimeout(scrollToElement, 500);
            }
        }
    };

    const isMinimal = variant === "minimal";
    // sticky:false → header in normal flow (the Shell zeroes --wjs-header-offset so the main loses
    // the fixed-header padding). Default: fixed (absolute in the editor preview) — unchanged.
    const positionClass = sticky ? (disableSticky ? 'absolute' : 'fixed') : 'relative';
    const scrolledBg = "bg-[var(--wjs-bg-surface-glass,white)] backdrop-blur-md shadow-sm py-4";
    // transparent:true → background-free over the top of the page even where the chrome would
    // otherwise render solid (editor preview / static header); data-scrolled restores it on scroll.
    const topBg = transparent ? "bg-transparent py-6" : (disableSticky || !sticky ? scrolledBg : "bg-transparent py-6");

    const logo = (
        <Link href="/" className="wjs-header-logo flex items-center gap-2">
            {logoUrl ? (
                <img src={logoUrl} alt={siteTitle} width={160} height={40} className="h-10 w-auto object-contain" />
            ) : siteTitle ? (
                <span className="text-2xl font-bold text-[var(--wjs-color-text-main,gray)]">
                    {siteTitle}
                </span>
            ) : null}
        </Link>
    );

    // Desktop Navigation
    const desktopNav = (
        <nav aria-label="Primary" className="wjs-header-nav hidden md:flex items-center gap-8">
            {menuItems.length > 0 ? (
                menuItems.map((item) => (
                    <Link
                        key={item.id}
                        href={item.url}
                        onClick={(e) => handleNavClick(e, item.url)}
                        className="text-[var(--wjs-color-text-main,gray)] hover:text-[var(--wjs-color-primary,blue)] font-medium transition-colors"
                    >
                        {item.title}
                    </Link>
                ))
            ) : null}
        </nav>
    );

    // Mobile Menu Button (always visible in the minimal variant — its nav lives in the panel)
    const menuButton = (
        <button
            className={`${isMinimal ? "" : "md:hidden "}w-11 h-11 rounded-full bg-[var(--wjs-color-primary,#2F6D86)] text-[var(--wjs-color-on-primary,#ffffff)] flex items-center justify-center shadow-lg hover:bg-[var(--wjs-color-primary-dark,#266073)] transition-colors`}
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu-panel"
        >
            {mobileMenuOpen ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                </svg>
            )}
        </button>
    );

    return (
        <>
            {/* data-scrolled mirrors the class swap below as a stable target for theme CSS */}
            {/* wjs-header is the selector the theme contract maps `styles.header` to (the manifest's
                CHROME_ELEMENT_SEEDS). It was seeded but never emitted, so every theme that declared
                a header style compiled a rule matching nothing — silently. The children hooks
                (.wjs-header-logo / -nav / -container) were emitted all along; only the root was missing. */}
            <header ref={headerRef} data-scrolled={isScrolled ? "true" : "false"} className={`wjs-header ${positionClass} top-0 inset-x-0 z-50 transition-all duration-300 ${isScrolled ? scrolledBg : topBg}`}>
                {variant === "centered" ? (
                    /* centered: logo on top, nav in a row below; mobile keeps logo-left + burger-right */
                    <div className="wjs-header-container container mx-auto px-4 flex flex-col items-center gap-4">
                        <div className="w-full flex justify-between items-center md:justify-center">
                            {logo}
                            <div className="wjs-header-actions flex items-center gap-4 md:hidden">{menuButton}</div>
                        </div>
                        {desktopNav}
                    </div>
                ) : isMinimal ? (
                    /* minimal: logo + hamburger only, nav always in the panel */
                    <div className="wjs-header-container container mx-auto px-4 flex justify-between items-center">
                        {logo}
                        <div className="wjs-header-actions flex items-center gap-4">{menuButton}</div>
                    </div>
                ) : (
                    <div className="wjs-header-container container mx-auto px-4 flex justify-between items-center">
                        {logo}
                        {desktopNav}
                        <div className="wjs-header-actions flex items-center gap-4">{menuButton}</div>
                    </div>
                )}
            </header>

            {/* Mobile Menu Overlay */}
            <div
                className={`wjs-header-mobile-overlay fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300${isMinimal ? "" : " md:hidden"} ${mobileMenuOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
                    }`}
                onClick={() => setMobileMenuOpen(false)}
            />

            {/* Mobile Menu Panel */}
            <div
                id="mobile-menu-panel"
                inert={!mobileMenuOpen}
                aria-hidden={!mobileMenuOpen}
                className={`wjs-header-mobile-panel fixed top-0 end-0 z-50 h-full w-72 bg-[var(--wjs-bg-surface,white)] shadow-2xl transform transition-transform duration-300 ease-out${isMinimal ? "" : " md:hidden"} ${mobileMenuOpen ? "translate-x-0" : "translate-x-full rtl:-translate-x-full"
                    }`}
            >
                <div className="p-6">
                    {/* Close Button */}
                    <button
                        className="absolute top-4 end-4 w-10 h-10 rounded-full bg-[var(--wjs-bg-muted,#f3f4f6)] text-[var(--wjs-color-text-muted,#4b5563)] flex items-center justify-center hover:bg-[var(--wjs-border-subtle,#e5e7eb)] transition-colors"
                        onClick={() => setMobileMenuOpen(false)}
                        aria-label="Close menu"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>

                    {/* Logo in Mobile Menu */}
                    <div className="mb-8 pt-8">
                        {logoUrl ? (
                            <img src={logoUrl} alt={siteTitle} width={128} height={32} className="h-8 w-auto object-contain" />
                        ) : siteTitle ? (
                            <span className="text-xl font-bold text-[var(--wjs-color-heading,#1f2937)]">{siteTitle}</span>
                        ) : null}
                    </div>

                    {/* Mobile Menu Items */}
                    <nav aria-label="Mobile" className="flex flex-col gap-4">
                        {menuItems.length > 0 ? (
                            menuItems.map((item) => (
                                <Link
                                    key={item.id}
                                    href={item.url}
                                    className="text-lg text-[var(--wjs-color-text-main,#374151)] hover:text-[var(--wjs-color-primary,#2F6D86)] font-medium py-2 border-b border-[var(--wjs-border-subtle,#f3f4f6)] transition-colors"
                                    onClick={(e) => handleNavClick(e, item.url)}
                                >
                                    {item.title}
                                </Link>
                            ))
                        ) : (
                            <p className="text-[var(--wjs-color-text-muted,#6b7280)] text-sm">No menu items</p>
                        )}
                    </nav>
                </div>
            </div>
        </>
    );
}
