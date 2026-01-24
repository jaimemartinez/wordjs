"use client";

import Link from "next/link";
import { useEffect, useState, useRef } from "react";

interface HeaderProps {
    disableSticky?: boolean;
}

export default function Header({ disableSticky = false }: HeaderProps) {
    const [isScrolled, setIsScrolled] = useState(false);
    const [menuItems, setMenuItems] = useState<any[]>([]);
    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [siteTitle, setSiteTitle] = useState("");
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const headerRef = useRef<HTMLElement>(null);

    useEffect(() => {
        const handleScroll = () => {
            // Use the window of the document where header is rendered (handles iframes)
            const targetWindow = headerRef.current?.ownerDocument?.defaultView || window;
            setIsScrolled(targetWindow.scrollY > 10);
        };
        // Only add scroll listener if sticky (full page)
        if (!disableSticky) {
            const targetWindow = headerRef.current?.ownerDocument?.defaultView || window;
            targetWindow.addEventListener("scroll", handleScroll);

            // Check initial scroll
            handleScroll();

            return () => targetWindow.removeEventListener("scroll", handleScroll);
        }
    }, [disableSticky]);

    // Close mobile menu on resize to desktop
    useEffect(() => {
        const handleResize = () => {
            if (window.innerWidth >= 768) {
                setMobileMenuOpen(false);
            }
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    const fetchData = async () => {
        console.log("Header: fetching data...");
        try {
            const { menusApi, settingsApi } = await import("@/lib/api");

            // Parallel fetch
            const [menu, settings] = await Promise.all([
                menusApi.getByLocation('header').catch((e) => {
                    console.error("Header: menu fetch failed", e);
                    return null;
                }),
                settingsApi.get().catch((e) => {
                    console.error("Header: settings fetch failed", e);
                    return null;
                })
            ]);

            console.log("Header: data received", { menu, settings });

            if (menu && menu.items) {
                setMenuItems(menu.items.sort((a: any, b: any) => a.order - b.order));
            }

            if (settings) {
                if (settings.site_logo) setLogoUrl(settings.site_logo);
                if (settings.blogname) setSiteTitle(settings.blogname);
            }

        } catch (error) {
            console.log("Error loading header data", error);
        }
    };

    useEffect(() => {
        fetchData();
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

    return (
        <>
            <header ref={headerRef} className={`${disableSticky ? 'absolute' : 'fixed'} top-0 left-0 right-0 z-50 transition-all duration-300 ${isScrolled ? "bg-[var(--wjs-bg-surface-glass,white)] backdrop-blur-md shadow-sm py-4" : (disableSticky ? "bg-[var(--wjs-bg-surface-glass,white)] backdrop-blur-md shadow-sm py-4" : "bg-transparent py-6")
                }`}>
                <div className="wjs-header-container container mx-auto px-4 flex justify-between items-center">
                    <Link href="/" className="wjs-header-logo flex items-center gap-2">
                        {logoUrl ? (
                            <img src={logoUrl} alt={siteTitle} className="h-10 w-auto object-contain" />
                        ) : siteTitle ? (
                            <span className="text-2xl font-bold text-[var(--wjs-color-text-main,gray)]">
                                {siteTitle}
                            </span>
                        ) : null}
                    </Link>

                    {/* Desktop Navigation */}
                    <nav className="wjs-header-nav hidden md:flex items-center gap-8">
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

                    <div className="wjs-header-actions flex items-center gap-4">
                        {/* Mobile Menu Button */}
                        <button
                            className="md:hidden w-11 h-11 rounded-full bg-[#2F6D86] text-white flex items-center justify-center shadow-lg hover:bg-[#266073] transition-colors"
                            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                            aria-label="Toggle menu"
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
                    </div>
                </div>
            </header>

            {/* Mobile Menu Overlay */}
            <div
                className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300 md:hidden ${mobileMenuOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
                    }`}
                onClick={() => setMobileMenuOpen(false)}
            />

            {/* Mobile Menu Panel */}
            <div
                className={`fixed top-0 right-0 z-50 h-full w-72 bg-[var(--wjs-bg-surface,white)] shadow-2xl transform transition-transform duration-300 ease-out md:hidden ${mobileMenuOpen ? "translate-x-0" : "translate-x-full"
                    }`}
            >
                <div className="p-6">
                    {/* Close Button */}
                    <button
                        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center hover:bg-gray-200 transition-colors"
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
                            <img src={logoUrl} alt={siteTitle} className="h-8 w-auto object-contain" />
                        ) : siteTitle ? (
                            <span className="text-xl font-bold text-gray-800">{siteTitle}</span>
                        ) : null}
                    </div>

                    {/* Mobile Menu Items */}
                    <nav className="flex flex-col gap-4">
                        {menuItems.length > 0 ? (
                            menuItems.map((item) => (
                                <Link
                                    key={item.id}
                                    href={item.url}
                                    className="text-lg text-gray-700 hover:text-[#2F6D86] font-medium py-2 border-b border-gray-100 transition-colors"
                                    onClick={(e) => handleNavClick(e, item.url)}
                                >
                                    {item.title}
                                </Link>
                            ))
                        ) : (
                            <p className="text-gray-500 text-sm">No menu items</p>
                        )}
                    </nav>
                </div>
            </div>
        </>
    );
}

