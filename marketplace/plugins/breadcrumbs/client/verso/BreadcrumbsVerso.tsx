// @ts-nocheck
"use client";

/**
 * Verso block "Breadcrumbs" — renders the navigation trail of the current page:
 * Inicio › Section › Current page, with optional BreadcrumbList JSON-LD.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 *
 * The block runs in the Verso editor iframe AND on the public page (same versoConfig on both):
 * - Editor iframe (window.self !== window.top): the iframe's location is NOT the page's real
 *   public URL, so we render a representative sample trail (driven by the block's props) plus
 *   a small hint. No fetch, no JSON-LD.
 * - Public page: the trail is derived from location.pathname on mount. The LAST segment tries
 *   to resolve its real title via GET /api/v1/posts/slug/:slug (the response is the post JSON
 *   itself; the title lives in `data.title` as a plain string). Guarded with res.ok — a 404
 *   (not a post: archives, plugin routes, …) quietly keeps the prettified segment.
 * - On the home page itself ("/") the block renders nothing on the public site.
 */

import React, { useEffect, useState } from "react";

const STYLES = `
.wjbc-nav { font-size: .8125rem; line-height: 1.4; color: var(--wjs-color-text-muted, #6b7280); padding: .25rem 0; }
.wjbc-list { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; list-style: none; margin: 0; padding: 0; }
.wjbc-item { display: inline-flex; align-items: center; gap: .4rem; min-width: 0; }
.wjbc-link { color: var(--wjs-color-text-muted, #6b7280); text-decoration: none; transition: color .15s ease; }
.wjbc-link:hover { color: var(--wjs-color-text, #111827); text-decoration: underline; }
.wjbc-current { color: var(--wjs-color-text, #111827); font-weight: 500; }
.wjbc-sep { color: var(--wjs-border-subtle, #9ca3af); user-select: none; }
.wjbc-hint { margin-top: .35rem; font-size: .6875rem; font-style: italic; color: var(--wjs-color-text-muted, #9ca3af); }
`;

/** True when running inside the Verso editor canvas iframe (public pages render top-level). */
function isEditorIframe() {
    try {
        return typeof window !== "undefined" && window.self !== window.top;
    } catch (e) {
        // Cross-origin weirdness — assume framed (editor-like) and stay harmless.
        return true;
    }
}

/** "mi-seccion_interna" → "Mi seccion interna" (fallback label for unresolved segments). */
function prettify(segment) {
    const s = String(segment).replace(/[-_]+/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(segment);
}

/** Safe decodeURIComponent (malformed escapes fall back to the raw segment). */
function safeDecode(segment) {
    try {
        return decodeURIComponent(segment);
    } catch (e) {
        return segment;
    }
}

// Module-level (never define a component inside a component — remounting steals input focus).
// `items`: [{label, href}]; the LAST item is the current page when `currentIsLast` is true.
function BcTrail({ items, separator, currentIsLast }) {
    const lastIndex = items.length - 1;
    return (
        <nav className="wjbc-nav" aria-label="breadcrumb">
            <ol className="wjbc-list">
                {items.map((it, i) => {
                    const isCurrent = currentIsLast && i === lastIndex;
                    return (
                        <li key={it.href + "|" + i} className="wjbc-item">
                            {isCurrent ? (
                                <span className="wjbc-current" aria-current="page">{it.label}</span>
                            ) : (
                                <a className="wjbc-link" href={it.href}>{it.label}</a>
                            )}
                            {i < lastIndex && <span className="wjbc-sep" aria-hidden="true">{separator}</span>}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

export const versoComponentDef = {
    category: "Navegación",
    fields: {
        homeLabel: { type: "text", label: "Etiqueta de inicio" },
        separator: {
            type: "radio",
            label: "Separador",
            options: [
                { label: "›", value: "›" },
                { label: "/", value: "/" },
                { label: "•", value: "•" },
            ],
        },
        showJsonLd: {
            type: "radio",
            label: "Datos estructurados (JSON-LD)",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showCurrent: {
            type: "radio",
            label: "Mostrar página actual",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
    },
    defaultProps: {
        homeLabel: "Inicio",
        separator: "›",
        showJsonLd: true,
        showCurrent: true,
    },
};

export default function BreadcrumbsVerso({ homeLabel, separator, showJsonLd, showCurrent }) {
    // null = not resolved yet (first client render / SSR) — render nothing.
    // { mode: "editor" } | { mode: "home" } | { mode: "trail", items, origin }
    const [state, setState] = useState(null);

    const home = (typeof homeLabel === "string" && homeLabel.trim()) ? homeLabel.trim() : "Inicio";
    const sep = separator === "/" || separator === "•" ? separator : "›";

    useEffect(() => {
        if (typeof window === "undefined") return undefined;
        let alive = true;

        if (isEditorIframe()) {
            // The editor iframe's location is not the page's real path — show a sample trail.
            setState({ mode: "editor" });
            return undefined;
        }

        const pathname = window.location.pathname || "/";
        const rawSegments = pathname.split("/").filter(Boolean);
        if (rawSegments.length === 0) {
            // Home page: nothing to breadcrumb on the public site.
            setState({ mode: "home" });
            return undefined;
        }

        // Cumulative trail: hrefs keep the original (encoded) segments; labels use decoded text.
        const items = [{ label: home, href: "/" }];
        for (let i = 0; i < rawSegments.length; i++) {
            items.push({
                label: prettify(safeDecode(rawSegments[i])),
                href: "/" + rawSegments.slice(0, i + 1).join("/"),
            });
        }
        setState({ mode: "trail", items, origin: window.location.origin });

        // Try to resolve the real title of the LAST segment (only posts/pages match; anything
        // else 404s and the prettified segment stays).
        const lastSlug = safeDecode(rawSegments[rawSegments.length - 1]);
        fetch("/api/v1/posts/slug/" + encodeURIComponent(lastSlug))
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive || !data || typeof data.title !== "string" || !data.title.trim()) return;
                const title = data.title.trim();
                setState((prev) => {
                    if (!prev || prev.mode !== "trail") return prev;
                    const next = prev.items.slice();
                    const last = next.length - 1;
                    next[last] = { label: title, href: next[last].href };
                    return { mode: "trail", items: next, origin: prev.origin };
                });
            })
            .catch(() => { /* offline / inactive API — keep the prettified label */ });

        return () => { alive = false; };
    }, [home]);

    if (state === null) return null;

    if (state.mode === "home") return null; // public home page: render nothing

    if (state.mode === "editor") {
        // Representative preview inside the Verso editor, driven by the real props.
        const sample = [
            { label: home, href: "/" },
            { label: "Sección", href: "/seccion" },
            { label: "Página actual", href: "/seccion/pagina-actual" },
        ];
        const visible = showCurrent ? sample : sample.slice(0, -1);
        return (
            <div>
                <style dangerouslySetInnerHTML={{ __html: STYLES }} />
                <BcTrail items={visible} separator={sep} currentIsLast={!!showCurrent} />
                <div className="wjbc-hint">
                    Vista previa: en la página publicada se muestra la ruta real (en la portada no se muestra nada).
                </div>
            </div>
        );
    }

    // Public trail
    const visible = showCurrent ? state.items : state.items.slice(0, -1);
    if (visible.length === 0) return null;

    // JSON-LD always describes the FULL trail (including the current page) with absolute URLs;
    // a <script type="application/ld+json"> in the body is valid for Google.
    const jsonLd = showJsonLd
        ? {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: state.items.map((it, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: it.label,
                item: state.origin + it.href,
            })),
        }
        : null;

    return (
        <div>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            <BcTrail items={visible} separator={sep} currentIsLast={!!showCurrent} />
            {jsonLd && (
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
                />
            )}
        </div>
    );
}
