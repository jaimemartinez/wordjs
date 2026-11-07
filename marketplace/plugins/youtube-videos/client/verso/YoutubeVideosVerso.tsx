// @ts-nocheck
"use client";

/**
 * Verso block "YoutubeVideos" — a carousel of a YouTube channel's videos.
 *
 * Registered via manifest.frontend.versoComponents; the generated versoPluginRegistry composes
 * { ...versoComponentDef, render: default export }, so versoComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page (same versoConfig on both), so data arrives via
 * a client-mount fetch against the plugin's PUBLIC endpoint, guarded with res.ok (an inactive
 * plugin 404s — the block degrades to a quiet placeholder instead of crashing the page).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

// Visitor-facing strings follow the page language (<html lang>); Spanish is the default.
const STRINGS = {
    es: { loading: "Cargando videos…", more: "Cargar más", prev: "Anterior", next: "Siguiente", page: "Página", pages: "Páginas de videos" },
    en: { loading: "Loading videos…", more: "Load more", prev: "Previous", next: "Next", page: "Page", pages: "Video pages" },
    pt: { loading: "Carregando vídeos…", more: "Carregar mais", prev: "Anterior", next: "Próxima", page: "Página", pages: "Páginas de vídeos" },
};
function pageLang() {
    const l = (typeof document !== "undefined" && String(document.documentElement.lang || "").slice(0, 2).toLowerCase()) || "es";
    return STRINGS[l] ? l : "es";
}
function dateLabel(v, lang) {
    if (v.publishedAt) {
        const d = new Date(v.publishedAt);
        if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
    }
    return v.publishedText || "";
}



const STYLES = `
.ytv-carousel { position: relative; width: 100%; max-width: 100%; overflow: hidden; border-radius: var(--wjs-radius, 0.5rem); background: #000; }
.ytv-track { display: flex; transition: transform .45s cubic-bezier(.22,.9,.35,1); }
.ytv-slide { position: relative; flex: 0 0 100%; aspect-ratio: 16 / 9; display: block; }
.ytv-slide img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytv-title { position: absolute; left: 0; right: 0; bottom: 0; padding: 2.25rem 1rem .9rem; color: #fff; font-weight: 600; font-size: .95rem; line-height: 1.3; text-decoration: none; background: linear-gradient(transparent, rgba(0,0,0,.78)); }
.ytv-play { position: absolute; top: 50%; left: 50%; width: 56px; height: 46px; transform: translate(-50%,-50%); background: rgba(0,0,0,.65); border-radius: 12px; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.ytv-play::after { content: ""; border-style: solid; border-width: 9px 0 9px 16px; border-color: transparent transparent transparent #fff; margin-left: 3px; }
.ytv-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 38px; height: 38px; border: none; border-radius: 50%; background: rgba(0,0,0,.55); color: #fff; font-size: 1rem; cursor: pointer; z-index: 2; display: flex; align-items: center; justify-content: center; }
.ytv-nav:hover { background: rgba(0,0,0,.8); }
.ytv-prev { left: 10px; }
.ytv-next { right: 10px; }
.ytv-dots { position: absolute; bottom: 8px; left: 0; right: 0; display: flex; gap: 6px; justify-content: center; z-index: 2; flex-wrap: wrap; padding: 0 12px; }
.ytv-dot { width: 8px; height: 8px; border-radius: 50%; border: none; padding: 0; background: rgba(255,255,255,.45); cursor: pointer; }
.ytv-dot.ytv-active { background: #fff; }
.ytv-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 0.5rem); font-size: .9rem; }
@media (max-width: 767.98px) { .ytv-title { font-size: .85rem; } .ytv-nav { width: 32px; height: 32px; } }

/* Estilo de Cuadrícula (grid) */
.ytv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1.25rem; width: 100%; }
.ytv-grid-card { position: relative; border-radius: var(--wjs-radius, 0.5rem); overflow: hidden; background: #000; aspect-ratio: 16 / 9; display: block; box-shadow: 0 4px 12px rgba(0,0,0,0.06); transition: transform 0.3s ease, box-shadow 0.3s ease; }
.ytv-grid-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,0,0,0.12); }
.ytv-grid-card img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.5s ease; }
.ytv-grid-card:hover img { transform: scale(1.04); }

/* Estilo de Galería Deslizable (gallery) */
.ytv-gallery-wrapper { position: relative; width: 100%; overflow: hidden; }
.ytv-gallery-container { display: flex; gap: 1.25rem; overflow-x: auto; scroll-behavior: smooth; padding: 0.5rem 0 1rem; scroll-snap-type: x mandatory; }
.ytv-gallery-container::-webkit-scrollbar { height: 6px; }
.ytv-gallery-container::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 3px; }
.ytv-gallery-container::-webkit-scrollbar-track { background: transparent; }
.ytv-gallery-item { flex: 0 0 260px; scroll-snap-align: start; }
@media (min-width: 768px) { .ytv-gallery-item { flex: 0 0 320px; } }
.ytv-gallery-wrapper .ytv-nav { top: 40%; }

/* 1.1: columns, dates, list layout, load more and pages */
.ytv-grid.ytv-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ytv-grid.ytv-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ytv-grid.ytv-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 767.98px) { .ytv-grid.ytv-cols-3, .ytv-grid.ytv-cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 479.98px) { .ytv-grid[class*="ytv-cols-"] { grid-template-columns: 1fr; } }
.ytv-date { display: block; margin-top: .2rem; font-weight: 400; font-size: .78rem; opacity: .85; }
.ytv-list { display: flex; flex-direction: column; gap: .9rem; }
.ytv-row { display: grid; grid-template-columns: minmax(120px, 220px) 1fr; gap: 1rem; align-items: center; text-decoration: none; color: inherit; }
.ytv-row-thumb { position: relative; display: block; aspect-ratio: 16 / 9; border-radius: var(--wjs-radius, 0.5rem); overflow: hidden; background: #000; }
.ytv-row-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytv-row-thumb .ytv-play { width: 40px; height: 32px; }
.ytv-row-title { font-weight: 600; line-height: 1.35; color: var(--wjs-color-text, inherit); }
.ytv-row:hover .ytv-row-title { text-decoration: underline; }
.ytv-row-date { display: block; margin-top: .25rem; font-size: .82rem; color: var(--wjs-color-text-muted, #6b7280); }
@media (max-width: 479.98px) { .ytv-row { grid-template-columns: 120px 1fr; gap: .75rem; } }
.ytv-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .4rem; margin-top: 1.25rem; }
.ytv-pager button { min-width: 40px; height: 40px; padding: 0 .9rem; border-radius: var(--wjs-radius, 0.5rem); border: 1px solid var(--wjs-border-subtle, #e5e7eb); background: var(--wjs-bg-surface, #fff); color: var(--wjs-color-text, #111827); font-weight: 600; font-size: .9rem; cursor: pointer; }
.ytv-pager button:hover:not(:disabled) { border-color: var(--wjs-color-primary, #EF4444); }
.ytv-pager button:disabled { opacity: .5; cursor: default; }
.ytv-pager button[aria-current="page"] { background: var(--wjs-color-primary, #EF4444); border-color: var(--wjs-color-primary, #EF4444); color: #fff; }
.ytv-pager .ytv-gap { padding: 0 .25rem; color: var(--wjs-color-text-muted, #6b7280); }
`;

// Module-level (never define a component inside a component – remounting steals input focus).
function YtCarousel({ videos, autoplay, interval, showTitles, showDates, lang, resetKey }) {
    const [current, setCurrent] = useState(0);
    const hoverRef = useRef(false);
    const total = videos.length;

    useEffect(() => { setCurrent(0); }, [resetKey]);
    useEffect(() => { setCurrent((c) => (c < total ? c : 0)); }, [total]);

    useEffect(() => {
        if (!autoplay || total < 2) return;
        const ms = Math.max(1500, Number(interval) || 5000);
        const t = setInterval(() => {
            if (!hoverRef.current) setCurrent((c) => (c + 1) % total);
        }, ms);
        return () => clearInterval(t);
    }, [autoplay, interval, total]);

    const go = (i) => setCurrent(((i % total) + total) % total);

    return (
        <div
            className="ytv-carousel"
            onMouseEnter={() => { hoverRef.current = true; }}
            onMouseLeave={() => { hoverRef.current = false; }}
        >
            <div className="ytv-track" style={{ transform: `translateX(-${current * 100}%)` }}>
                {videos.map((v) => (
                    <a key={v.id} className="ytv-slide" href={v.url} target="_blank" rel="noopener noreferrer" title={v.title}>
                        {/* Plain <img>: thumbnails live on i.ytimg.com — next/image is unavailable in plugin
                            bundles. Deliberately NOT loading="lazy": slides sit translated inside an
                            overflow:hidden track, where Chrome's viewport-based lazy heuristic never fires
                            (even the visible slide stayed unloaded). The payload is already bounded by the
                            block's maxVideos limit. */}
                        <img 
                            src={v.thumb} 
                            alt={v.title} 
                            decoding="async" 
                            onError={(e) => {
                                const img = e.currentTarget;
                                if (img.src.includes('maxresdefault.jpg')) {
                                    img.src = img.src.replace('maxresdefault.jpg', 'sddefault.jpg');
                                } else if (img.src.includes('sddefault.jpg')) {
                                    img.src = img.src.replace('sddefault.jpg', 'hqdefault.jpg');
                                } else {
                                    img.onerror = null;
                                }
                            }}
                        />
                        <span className="ytv-play" aria-hidden="true"></span>
                        {showTitles && <span className="ytv-title">{v.title}{showDates && dateLabel(v, lang) ? <span className="ytv-date">{dateLabel(v, lang)}</span> : null}</span>}
                    </a>
                ))}
            </div>
            {total > 1 && (
                <>
                    <button type="button" className="ytv-nav ytv-prev" aria-label="Anterior" onClick={(e) => { e.preventDefault(); go(current - 1); }}>‹</button>
                    <button type="button" className="ytv-nav ytv-next" aria-label="Siguiente" onClick={(e) => { e.preventDefault(); go(current + 1); }}>›</button>
                    <div className="ytv-dots">
                        {videos.map((v, i) => (
                            <button key={v.id} type="button" className={`ytv-dot${i === current ? " ytv-active" : ""}`} aria-label={`Video ${i + 1}`} onClick={() => go(i)} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function YtGallery({ videos, showTitles, showDates, lang }) {
    const containerRef = useRef(null);

    const scroll = (direction) => {
        if (!containerRef.current) return;
        const offset = direction === "left" ? -300 : 300;
        containerRef.current.scrollBy({ left: offset, behavior: "smooth" });
    };

    return (
        <div className="ytv-gallery-wrapper">
            <div className="ytv-gallery-container custom-scrollbar" ref={containerRef}>
                {videos.map((v) => (
                    <div key={v.id} className="ytv-gallery-item">
                        <a href={v.url} target="_blank" rel="noopener noreferrer" className="ytv-grid-card group" title={v.title}>
                            <img 
                                src={v.thumb} 
                                alt={v.title} 
                                decoding="async" 
                                onError={(e) => {
                                    const img = e.currentTarget;
                                    if (img.src.includes('maxresdefault.jpg')) {
                                        img.src = img.src.replace('maxresdefault.jpg', 'sddefault.jpg');
                                    } else if (img.src.includes('sddefault.jpg')) {
                                        img.src = img.src.replace('sddefault.jpg', 'hqdefault.jpg');
                                    } else {
                                        img.onerror = null;
                                    }
                                }}
                            />
                            <span className="ytv-play" aria-hidden="true"></span>
                            {showTitles && <span className="ytv-title">{v.title}{showDates && dateLabel(v, lang) ? <span className="ytv-date">{dateLabel(v, lang)}</span> : null}</span>}
                        </a>
                    </div>
                ))}
            </div>
            {videos.length > 1 && (
                <>
                    <button type="button" className="ytv-nav ytv-prev" aria-label="Anterior" onClick={(e) => { e.preventDefault(); scroll("left"); }}>‹</button>
                    <button type="button" className="ytv-nav ytv-next" aria-label="Siguiente" onClick={(e) => { e.preventDefault(); scroll("right"); }}>›</button>
                </>
            )}
        </div>
    );
}

function Thumb({ v }) {
    return (
        <img
            src={v.thumb}
            alt={v.title}
            decoding="async"
            onError={(e) => {
                const img = e.currentTarget;
                if (img.src.includes("maxresdefault.jpg")) img.src = img.src.replace("maxresdefault.jpg", "sddefault.jpg");
                else if (img.src.includes("sddefault.jpg")) img.src = img.src.replace("sddefault.jpg", "hqdefault.jpg");
                else img.onerror = null;
            }}
        />
    );
}

/** Page numbers to show: first, last, and one either side of the current one, with gaps. */
function pageList(current, count) {
    const out = [];
    for (let i = 1; i <= count; i++) {
        if (i === 1 || i === count || Math.abs(i - current) <= 1) out.push(i);
        else if (out[out.length - 1] !== "…") out.push("…");
    }
    return out;
}

const YES_NO = [
    { label: "Sí", value: true },
    { label: "No", value: false },
];

export const versoComponentDef = {
    category: "YouTube",
    fields: {
        layout: {
            type: "select",
            label: "Diseño",
            options: [
                { label: "Carrusel (un video a la vez)", value: "classic" },
                { label: "Cuadrícula", value: "grid" },
                { label: "Galería horizontal (varias tarjetas)", value: "gallery" },
                { label: "Lista (miniatura + título)", value: "list" },
            ],
        },
        titleFilter: { type: "text", label: "Mostrar solo títulos con… (palabras separadas por comas)" },
        excludeFilter: { type: "text", label: "Ocultar títulos con… (palabras separadas por comas)" },
        order: {
            type: "select",
            label: "Orden",
            options: [
                { label: "Más recientes primero", value: "newest" },
                { label: "Más antiguos primero", value: "oldest" },
                { label: "Por título (A–Z)", value: "title" },
            ],
        },
        maxVideos: { type: "number", label: "Videos por página (1–200)" },
        pagination: {
            type: "select",
            label: "Paginación",
            options: [
                { label: "Ninguna (solo los primeros)", value: "none" },
                { label: "Botón «Cargar más»", value: "loadMore" },
                { label: "Páginas numeradas", value: "pages" },
            ],
        },
        columns: {
            type: "select",
            label: "Columnas (cuadrícula)",
            options: [
                { label: "Automático", value: "auto" },
                { label: "2", value: "2" },
                { label: "3", value: "3" },
                { label: "4", value: "4" },
            ],
        },
        showTitles: { type: "radio", label: "Mostrar títulos", options: YES_NO },
        showDates: { type: "radio", label: "Mostrar fechas", options: YES_NO },
        autoplay: { type: "radio", label: "Autoplay (carrusel)", options: YES_NO },
        interval: { type: "number", label: "Intervalo del autoplay (ms)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        layout: "classic",
        titleFilter: "",
        excludeFilter: "",
        order: "newest",
        maxVideos: 8,
        pagination: "none",
        columns: "auto",
        autoplay: true,
        interval: 5000,
        showTitles: true,
        showDates: false,
        elementId: "",
    },
};

export default function YoutubeVideosVerso({ layout, titleFilter, excludeFilter, order, maxVideos, pagination, columns, autoplay, interval, showTitles, showDates, elementId, isEditing, puck }) {
    // Setup hints are for the editor; visitors never see admin instructions (an unconfigured or empty block renders nothing).
    const editing = !!(isEditing || (puck && puck.isEditing));
    const lang = useMemo(pageLang, []);
    const s = STRINGS[lang];
    const perPage = Math.min(200, Math.max(1, Math.floor(Number(maxVideos) || 8)));
    const mode = pagination === "loadMore" || pagination === "pages" ? pagination : "none";
    const [videos, setVideos] = useState(null); // null = loading, [] = loaded-empty
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loadingMore, setLoadingMore] = useState(false);
    const topRef = useRef(null);

    const base = useMemo(() => {
        const p = new URLSearchParams();
        if (titleFilter) p.set("q", titleFilter);
        if (excludeFilter) p.set("exclude", excludeFilter);
        if (order && order !== "newest") p.set("order", order);
        p.set("limit", String(perPage));
        return p.toString();
    }, [titleFilter, excludeFilter, order, perPage]);

    const fetchPage = (offset) => fetch(`/api/v1/plugin/youtube-videos/?${base}&offset=${offset}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);

    // Back to the first page whenever the options change.
    useEffect(() => { setPage(1); }, [base, mode]);
    useEffect(() => {
        let alive = true;
        if (mode !== "pages") setVideos(null);
        fetchPage(mode === "pages" ? (page - 1) * perPage : 0).then((data) => {
            if (!alive) return;
            setVideos((data && data.videos) || []);
            setTotal((data && data.total) || 0);
        });
        return () => { alive = false; };
    }, [base, mode, page]);

    const loadMore = async () => {
        setLoadingMore(true);
        const data = await fetchPage((videos || []).length);
        setLoadingMore(false);
        if (data && data.videos) {
            setVideos((prev) => {
                const seen = new Set((prev || []).map((v) => v.id));
                return [...(prev || []), ...data.videos.filter((v) => !seen.has(v.id))];
            });
            setTotal(data.total || 0);
        }
    };
    const goPage = (n) => {
        setPage(n);
        if (topRef.current && topRef.current.scrollIntoView) topRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    if (!editing && Array.isArray(videos) && videos.length === 0) return null;

    const pageCount = Math.max(1, Math.ceil(total / perPage));
    const shown = videos || [];
    const colsClass = columns && columns !== "auto" ? ` ytv-cols-${columns}` : "";
    const caption = (v) => (showTitles ? <span className="ytv-title">{v.title}{showDates && dateLabel(v, lang) ? <span className="ytv-date">{dateLabel(v, lang)}</span> : null}</span> : null);

    let body;
    if (videos === null) {
        body = <div className="ytv-empty">{s.loading}</div>;
    } else if (videos.length === 0) {
        body = (
            <div className="ytv-empty">
                No hay videos para mostrar — configura el canal en Admin → YouTube Videos
                {titleFilter || excludeFilter ? " (o ajusta los filtros)" : ""}.
            </div>
        );
    } else if (layout === "grid") {
        body = (
            <div className={`ytv-grid${colsClass}`}>
                {shown.map((v) => (
                    <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className="ytv-grid-card group" title={v.title}>
                        <Thumb v={v} />
                        <span className="ytv-play" aria-hidden="true"></span>
                        {caption(v)}
                    </a>
                ))}
            </div>
        );
    } else if (layout === "list") {
        body = (
            <div className="ytv-list">
                {shown.map((v) => (
                    <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className="ytv-row">
                        <span className="ytv-row-thumb"><Thumb v={v} /><span className="ytv-play" aria-hidden="true"></span></span>
                        <span>
                            <span className="ytv-row-title">{v.title}</span>
                            {showDates && dateLabel(v, lang) ? <span className="ytv-row-date">{dateLabel(v, lang)}</span> : null}
                        </span>
                    </a>
                ))}
            </div>
        );
    } else if (layout === "gallery") {
        body = <YtGallery videos={shown} showTitles={showTitles} showDates={showDates} lang={lang} />;
    } else {
        body = <YtCarousel videos={shown} autoplay={autoplay} interval={interval} showTitles={showTitles} showDates={showDates} lang={lang} resetKey={`${base}|${page}`} />;
    }

    return (
        <div id={elementId || undefined} ref={topRef}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {body}
            {mode === "loadMore" && videos && videos.length > 0 && videos.length < total && (
                <div className="ytv-pager">
                    <button type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? s.loading : s.more}</button>
                </div>
            )}
            {mode === "pages" && videos && videos.length > 0 && pageCount > 1 && (
                <nav className="ytv-pager" aria-label={s.pages}>
                    <button type="button" onClick={() => goPage(page - 1)} disabled={page <= 1} aria-label={s.prev}>‹</button>
                    {pageList(page, pageCount).map((n, i) => (n === "…"
                        ? <span key={`gap${i}`} className="ytv-gap">…</span>
                        : <button key={n} type="button" onClick={() => goPage(n)} aria-current={n === page ? "page" : undefined} aria-label={`${s.page} ${n}`}>{n}</button>))}
                    <button type="button" onClick={() => goPage(page + 1)} disabled={page >= pageCount} aria-label={s.next}>›</button>
                </nav>
            )}
        </div>
    );
}
