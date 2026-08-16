// @ts-nocheck
"use client";

/**
 * Verso block "RelatedPosts" — automatic per-post related articles (YARPP / Jetpack parity).
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 *
 * How it works (verified against the core API):
 *  - On the PUBLIC site the block takes the last URL segment as the current post slug and fetches
 *    GET /api/v1/posts/slug/:slug with the visitor's same-origin session.
 *  - Post.toJSON() does NOT expose taxonomy terms and the posts LIST endpoint ignores its
 *    `categories` query param on reads, so the block fetches the latest ~30 published posts and
 *    matches categories CLIENT-SIDE via meta._puck_data.root.props.category (the category NAME
 *    the post editor stores). Zero shared categories -> falls back to the most recent posts.
 *  - Post links follow the core public pattern "/" + (post.slug || post.id) (same as the search
 *    page and the (public)/[slug] route).
 *  - In the Verso editor iframe there is no real post URL, so the block renders a hint plus a
 *    preview built from the latest posts. On a non-post public page it renders nothing (height 0).
 */

import React, { useEffect, useState } from "react";

const STYLES = `
.wjrp-section { width: 100%; }
.wjrp-heading { font-size: 1.35rem; font-weight: 700; margin: 0 0 1rem; color: var(--wjs-color-text-heading, var(--wjs-color-text-main, #111827)); }
.wjrp-grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; }
@media (min-width: 640px) { .wjrp-grid { grid-template-columns: repeat(2, 1fr); } }
@media (min-width: 1024px) { .wjrp-grid { grid-template-columns: repeat(3, 1fr); } }
.wjrp-card { display: flex; flex-direction: column; overflow: hidden; background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.75rem); }
.wjrp-imgwrap { display: block; aspect-ratio: 16 / 9; overflow: hidden; background: var(--wjs-bg-muted, #f3f4f6); }
.wjrp-imgwrap img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .35s ease; }
.wjrp-card:hover .wjrp-imgwrap img { transform: scale(1.04); }
.wjrp-body { padding: 1rem 1.1rem 1.2rem; display: flex; flex-direction: column; gap: .4rem; }
.wjrp-date { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--wjs-color-text-muted, #6b7280); }
.wjrp-cardtitle { margin: 0; font-size: 1.02rem; font-weight: 650; line-height: 1.35; }
.wjrp-cardtitle a { color: var(--wjs-color-text-main, #111827); text-decoration: none; }
.wjrp-cardtitle a:hover { text-decoration: underline; }
.wjrp-excerpt { margin: 0; font-size: .875rem; line-height: 1.5; color: var(--wjs-color-text-muted, #6b7280); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.wjrp-hint { padding: 1rem 1.25rem; margin-bottom: 1rem; font-size: .85rem; line-height: 1.5; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #d1d5db); border-radius: var(--wjs-radius, 0.75rem); }
`;

/**
 * Origin-relative image URLs: featuredMedia.url is built server-side from the configured site URL
 * (or falls back to the attachment guid, which embeds the UPLOAD-TIME host). Serving the path
 * same-origin survives host/IP changes. Genuinely external images are left untouched.
 */
function toRelativeUrl(u) {
    const s = String(u == null ? "" : u);
    if (!s) return "";
    if (typeof window === "undefined") return s;
    try {
        const parsed = new URL(s, window.location.origin);
        if (parsed.pathname.indexOf("/uploads/") === 0) return parsed.pathname + parsed.search;
        if (parsed.origin === window.location.origin) return parsed.pathname + parsed.search;
    } catch (e) {
        /* unparseable -> use as-is */
    }
    return s;
}

/**
 * Collect the category identifiers a post exposes through the public API.
 * Verified sources: meta._puck_data.root.props.category (category NAME string saved by the post
 * editor). Defensively also accepts meta.categories when some content source stored an array.
 * Returned values are normalized (trimmed, lowercased) for matching.
 */
function extractCategoryNames(post) {
    const out = [];
    try {
        const meta = post && post.meta;
        // `_puck_data` is the post-meta key that holds the saved editor document. The editor is now
        // Verso, but the KEY deliberately keeps its historical name forever — renaming it would
        // require migrating every install's post_meta, for zero benefit and a real risk of data loss.
        const doc = meta && meta._puck_data;
        const root = doc && doc.root;
        const props = (root && root.props) || root;
        const single = props && props.category;
        if (typeof single === "string" && single.trim()) out.push(single.trim().toLowerCase());
        const arr = meta && meta.categories;
        if (Array.isArray(arr)) {
            for (let i = 0; i < arr.length; i++) {
                const v = String(arr[i] == null ? "" : arr[i]).trim().toLowerCase();
                if (v) out.push(v);
            }
        }
    } catch (e) {
        /* malformed meta -> no categories */
    }
    return out;
}

function sharedCategoryCount(candidateCats, currentCats) {
    if (!candidateCats.length || !currentCats.length) return 0;
    let n = 0;
    for (let i = 0; i < candidateCats.length; i++) {
        if (currentCats.indexOf(candidateCats[i]) !== -1) n++;
    }
    return n;
}

function postDateMs(p) {
    const t = new Date((p && (p.dateGmt || p.date)) || 0).getTime();
    return isNaN(t) ? 0 : t;
}

function formatDateEs(iso) {
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        return d.toLocaleDateString("es-ES", { year: "numeric", month: "long", day: "numeric" });
    } catch (e) {
        return "";
    }
}

/**
 * The entities this block decodes. Kept next to the single regex that consumes it so the two can
 * never drift: adding a row here is the ONLY way to teach cleanText a new entity.
 */
const ENTITIES = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
};

/**
 * Strip tags/entities from the API excerpt so the 2-line clamp shows clean text.
 *
 * Decoding is SINGLE-PASS on purpose. A chain of `.replace()` that turns `&amp;` into `&` before the
 * other entities re-reads its own output: `&amp;lt;` becomes `&lt;` and then `<`, so text that merely
 * QUOTED an entity comes out as the character it names. One regex over a lookup table cannot rescan
 * what it just produced, so the ordering trap cannot come back when a row is added above.
 */
function cleanText(s) {
    return String(s == null ? "" : s)
        .replace(/<[^>]*>/g, " ")
        .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
        .replace(/\s+/g, " ")
        .trim();
}

/** Map an API post to the card model the grid renders. */
function toCard(p) {
    return {
        id: p.id,
        href: "/" + (p.slug || p.id),
        title: cleanText(p.title) || "(sin título)",
        dateLabel: formatDateEs(p.date),
        img: toRelativeUrl(p.featuredMedia && p.featuredMedia.url),
        imgTitle: cleanText(p.featuredMedia && p.featuredMedia.title),
        excerpt: cleanText(p.excerpt),
    };
}

// Module-level (never define a component inside a component — remounting steals focus/state).
function RelatedGrid({ cards, showImages, showDate, showExcerpt }) {
    return (
        <div className="wjrp-grid">
            {cards.map((c) => (
                <article key={c.id} className="wjrp-card">
                    {showImages && c.img ? (
                        <a className="wjrp-imgwrap" href={c.href} tabIndex={-1} aria-hidden="true">
                            {/* Plain <img>; deliberately NOT loading="lazy" (cards can sit inside
                                transformed/overflow-hidden ancestors where the lazy heuristic
                                never fires). decoding="async" keeps paint unblocked. */}
                            <img src={c.img} alt={c.imgTitle || c.title} decoding="async" />
                        </a>
                    ) : null}
                    <div className="wjrp-body">
                        {showDate && c.dateLabel ? <div className="wjrp-date">{c.dateLabel}</div> : null}
                        <h3 className="wjrp-cardtitle">
                            <a href={c.href}>{c.title}</a>
                        </h3>
                        {showExcerpt && c.excerpt ? <p className="wjrp-excerpt">{c.excerpt}</p> : null}
                    </div>
                </article>
            ))}
        </div>
    );
}

export const versoComponentDef = {
    category: "Contenido",
    fields: {
        title: { type: "text", label: "Título" },
        maxPosts: { type: "number", label: "Cantidad de artículos" },
        showImages: {
            type: "radio",
            label: "Mostrar imágenes",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showDate: {
            type: "radio",
            label: "Mostrar fecha",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        showExcerpt: {
            type: "radio",
            label: "Mostrar extracto",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
    },
    defaultProps: {
        title: "Artículos relacionados",
        maxPosts: 3,
        showImages: true,
        showDate: true,
        showExcerpt: false,
    },
};

export default function RelatedPostsVerso({ title, maxPosts, showImages, showDate, showExcerpt }) {
    // status: "loading" | "ready" (cards may still be empty) — cards stay FULLY sorted so
    // maxPosts changes in the editor re-slice live without refetching.
    const [state, setState] = useState({ status: "loading", cards: [], isEditor: false, note: "" });

    useEffect(() => {
        let alive = true;

        // Editor detection: the Verso editor renders blocks inside a same-origin iframe; the
        // public page is top-level. A cross-origin frameElement access throws -> not our editor.
        let isEditor = false;
        try {
            isEditor = !!window.frameElement;
        } catch (e) {
            isEditor = false;
        }
        try {
            if (!isEditor && window.location.pathname.indexOf("/admin") === 0) isEditor = true;
        } catch (e) {
            /* no location -> leave as-is */
        }

        const fetchJsonOk = async (url) => {
            const res = await fetch(url);
            if (!res.ok) return null; // inactive plugin / non-post slug / API error -> degrade
            return res.json().catch(() => null);
        };

        const run = async () => {
            // 1) Current post from the URL (public only — the editor iframe has no post URL).
            let current = null;
            if (!isEditor) {
                let slug = "";
                try {
                    const segs = window.location.pathname.split("/").filter(Boolean);
                    slug = segs.length ? decodeURIComponent(segs[segs.length - 1]) : "";
                } catch (e) {
                    slug = "";
                }
                if (slug) {
                    current = await fetchJsonOk("/api/v1/posts/slug/" + encodeURIComponent(slug));
                }
                if (current && current.type !== "post") current = null; // pages get no related posts
                if (!current) {
                    // Non-post public page: render nothing (height 0).
                    if (alive) setState({ status: "ready", cards: [], isEditor: false, note: "" });
                    return;
                }
            }

            // 2) Candidates: latest published posts (the list endpoint has NO category filter,
            //    so matching happens client-side below).
            const list = await fetchJsonOk("/api/v1/posts?type=post&status=publish&per_page=30&orderby=date&order=desc");
            const posts = Array.isArray(list) ? list : [];

            if (isEditor) {
                // Editor preview: no real post context — show the latest posts as a mock-up.
                const cards = posts.filter((p) => p && p.id != null).map(toCard);
                if (alive) {
                    setState({
                        status: "ready",
                        cards: cards,
                        isEditor: true,
                        note: cards.length
                            ? "Vista previa: en el sitio público este bloque detecta el artículo actual y muestra artículos de su misma categoría (o los más recientes si no hay coincidencias)."
                            : "Aún no hay artículos publicados. Publica algunos artículos para que este bloque pueda mostrar contenido relacionado.",
                    });
                }
                return;
            }

            // 3) Score: shared categories desc, then date desc; exclude self. With zero shared
            //    categories the same sort degrades to "most recent posts" — the spec fallback.
            const currentCats = extractCategoryNames(current);
            const scored = posts
                .filter((p) => p && p.id != null && p.id !== current.id && p.slug !== current.slug)
                .map((p) => ({ p: p, score: sharedCategoryCount(extractCategoryNames(p), currentCats) }));
            scored.sort((a, b) => (b.score - a.score) || (postDateMs(b.p) - postDateMs(a.p)));

            const cards = scored.map((s) => toCard(s.p));
            if (alive) setState({ status: "ready", cards: cards, isEditor: false, note: "" });
        };

        run().catch(() => {
            if (alive) setState({ status: "ready", cards: [], isEditor: isEditor, note: isEditor ? "No se pudieron cargar los artículos relacionados." : "" });
        });

        return () => {
            alive = false;
        };
    }, []);

    const limit = Math.min(Math.max(parseInt(maxPosts, 10) || 3, 1), 12);
    const visible = state.cards.slice(0, limit);

    // Public page with nothing to show (or still loading): render nothing — zero height.
    if (!state.isEditor && (state.status === "loading" || visible.length === 0)) {
        return null;
    }

    return (
        <section className="wjrp-section" aria-label={title || "Artículos relacionados"}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {state.isEditor && (
                <div className="wjrp-hint">
                    <strong>Artículos relacionados</strong> — {state.status === "loading" ? "Cargando vista previa…" : state.note}
                </div>
            )}
            {visible.length > 0 && (
                <>
                    {title ? <h2 className="wjrp-heading">{title}</h2> : null}
                    <RelatedGrid cards={visible} showImages={!!showImages} showDate={!!showDate} showExcerpt={!!showExcerpt} />
                </>
            )}
        </section>
    );
}
