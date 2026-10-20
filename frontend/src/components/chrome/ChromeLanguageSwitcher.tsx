"use client";

// Composable-chrome block (contract v1): links to the CURRENT page in its other languages.
//
// The layout that renders the chrome is shared by every page and cached per route, so it cannot know
// which translations the page in front of it has. The page itself does: on a multilingual site every
// post that belongs to a translation group emits <link rel="alternate" hreflang> for each version
// (server-api.ts buildMetadata). This island READS that set — the one source of truth search engines
// already consume — and renders nothing when it is empty, i.e. on a monolingual site or a page without
// translations. Re-read on every client navigation (the head is swapped, the chrome is not).
//
// SECURITY: an alternate href is page data. Only http(s) URLs pass; a same-origin one is rendered as a
// path, anything else as the absolute URL. Labels are text. No portal, no document listener, no body
// state — just a MutationObserver on <head> scoped to this instance.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

interface Alternate {
    lang: string;
    href: string;
    current: boolean;
}

function readAlternates(): Alternate[] {
    const out: Alternate[] = [];
    const seen = new Set<string>();
    const here = window.location.pathname.replace(/\/+$/, "") || "/";
    for (const link of Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]'))) {
        const lang = (link.getAttribute("hreflang") || "").trim();
        if (!lang || lang.toLowerCase() === "x-default" || seen.has(lang.toLowerCase())) continue;
        let url: URL;
        try { url = new URL(link.getAttribute("href") || "", window.location.href); } catch { continue; }
        if (url.protocol !== "http:" && url.protocol !== "https:") continue;
        const sameOrigin = url.origin === window.location.origin;
        const path = url.pathname.replace(/\/+$/, "") || "/";
        seen.add(lang.toLowerCase());
        out.push({ lang, href: sameOrigin ? `${url.pathname}${url.search}` : url.href, current: sameOrigin && path === here });
    }
    return out;
}

function label(lang: string, mode: "native" | "code"): string {
    if (mode === "code") return lang.toUpperCase();
    try {
        return new Intl.DisplayNames([lang], { type: "language" }).of(lang) || lang.toUpperCase();
    } catch {
        return lang.toUpperCase();
    }
}

export interface ChromeLanguageSwitcherViewProps {
    style?: "inline" | "dropdown";
    labels?: "native" | "code";
    // Editor canvas only: show a sample instead of nothing, so the block stays visible and selectable.
    preview?: boolean;
}

export default function ChromeLanguageSwitcher({ style = "inline", labels = "native", preview = false }: ChromeLanguageSwitcherViewProps) {
    const pathname = usePathname();
    const [alternates, setAlternates] = useState<Alternate[]>([]);

    useEffect(() => {
        if (preview) return;
        const update = () => setAlternates(readAlternates());
        update();
        // Next swaps the <head> links after a client navigation; watch it instead of guessing a delay.
        const observer = new MutationObserver(update);
        observer.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "hreflang"] });
        return () => observer.disconnect();
    }, [pathname, preview]);

    const items = preview ? [{ lang: "en", href: "#", current: true }, { lang: "es", href: "#", current: false }, { lang: "pt", href: "#", current: false }] : alternates;
    if (items.length < 2) return null;

    const link = (alt: Alternate) =>
        alt.current ? (
            <span className="wjs-lang-switcher__current font-semibold" lang={alt.lang} aria-current="page">{label(alt.lang, labels)}</span>
        ) : (
            <a className="wjs-lang-switcher__link" lang={alt.lang} hrefLang={alt.lang} href={alt.href}>{label(alt.lang, labels)}</a>
        );

    if (style === "dropdown") {
        const current = items.find((a) => a.current) || items[0];
        return (
            <details className="wjs-chrome-lang wjs-lang-switcher relative inline-block">
                <summary className="wjs-lang-switcher__summary cursor-pointer inline-flex items-center gap-2 select-none list-none">
                    <i className="fa-solid fa-language" aria-hidden="true"></i>
                    <span lang={current.lang}>{label(current.lang, labels)}</span>
                </summary>
                <ul className="wjs-lang-switcher__menu absolute end-0 z-50 mt-1 min-w-[8rem] flex flex-col gap-1 list-none m-0 p-2 rounded-lg shadow-lg bg-[var(--wjs-bg-surface,white)] border border-[var(--wjs-border-subtle,#e5e7eb)] text-[var(--wjs-color-text-main,#374151)]">
                    {items.map((alt) => <li key={alt.lang}>{link(alt)}</li>)}
                </ul>
            </details>
        );
    }
    return (
        <nav aria-label="Language" className="wjs-chrome-lang wjs-lang-switcher">
            <ul className="flex flex-wrap items-center gap-3 list-none m-0 p-0 text-sm">
                {items.map((alt) => <li key={alt.lang}>{link(alt)}</li>)}
            </ul>
        </nav>
    );
}
