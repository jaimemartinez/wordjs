// @ts-nocheck
"use client";

/**
 * Puck block "YoutubeVideos" — a carousel of a YouTube channel's videos.
 *
 * Registered via manifest.frontend.puckComponents; the generated puckPluginRegistry composes
 * { ...puckComponentDef, render: default export }, so puckComponentDef must NOT carry a render.
 * Runs in the editor iframe AND on the public page (same puckConfig on both), so data arrives via
 * a client-mount fetch against the plugin's PUBLIC endpoint, guarded with res.ok (an inactive
 * plugin 404s — the block degrades to a quiet placeholder instead of crashing the page).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";



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
`;

// Module-level (never define a component inside a component – remounting steals input focus).
function YtCarousel({ videos, autoplay, interval, showTitles }) {
    const [current, setCurrent] = useState(0);
    const hoverRef = useRef(false);
    const total = videos.length;

    useEffect(() => { setCurrent(0); }, [total]);

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
                        {showTitles && <span className="ytv-title">{v.title}</span>}
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

function YtGallery({ videos, showTitles }) {
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
                            {showTitles && <span className="ytv-title">{v.title}</span>}
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

export const puckComponentDef = {
    category: "YouTube",
    fields: {
        layout: {
            type: "select",
            label: "Diseño del Carrusel",
            options: [
                { label: "Clásico (Pantalla completa)", value: "classic" },
                { label: "Cuadrícula de videos", value: "grid" },
                { label: "Carrusel Horizontal (Multi-tarjeta)", value: "gallery" },
            ],
        },
        titleFilter: { type: "text", label: "Filtro: el título contiene…" },
        maxVideos: { type: "number", label: "Cantidad de videos" },
        autoplay: {
            type: "radio",
            label: "Autoplay",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        interval: { type: "number", label: "Intervalo (ms)" },
        showTitles: {
            type: "radio",
            label: "Mostrar títulos",
            options: [
                { label: "Sí", value: true },
                { label: "No", value: false },
            ],
        },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        layout: "classic",
        titleFilter: "",
        maxVideos: 8,
        autoplay: true,
        interval: 5000,
        showTitles: true,
        elementId: "",
    },
};

export default function YoutubeVideosPuck({ layout, titleFilter, maxVideos, autoplay, interval, showTitles, elementId }) {
    const [videos, setVideos] = useState(null); // null = loading, [] = loaded-empty

    const query = useMemo(() => {
        const p = new URLSearchParams();
        if (titleFilter) p.set("q", titleFilter);
        p.set("limit", String(Math.max(1, Number(maxVideos) || 8)));
        return p.toString();
    }, [titleFilter, maxVideos]);

    useEffect(() => {
        let alive = true;
        fetch(`/api/v1/plugin/youtube-videos/?${query}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setVideos((data && data.videos) || []); })
            .catch(() => { if (alive) setVideos([]); });
        return () => { alive = false; };
    }, [query]);

    return (
        <div id={elementId || undefined}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />
            {videos === null ? (
                <div className="ytv-empty">Cargando videos…</div>
            ) : videos.length === 0 ? (
                <div className="ytv-empty">
                    No hay videos para mostrar — configura el canal en Admin → YouTube Videos
                    {titleFilter ? ` (o ajusta el filtro "${titleFilter}")` : ""}.
                </div>
            ) : (
                layout === "grid" ? (
                    <div className="ytv-grid">
                        {videos.map((v) => (
                            <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className="ytv-grid-card group" title={v.title}>
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
                                {showTitles && <span className="ytv-title">{v.title}</span>}
                            </a>
                        ))}
                    </div>
                ) : layout === "gallery" ? (
                    <YtGallery videos={videos} showTitles={showTitles} />
                ) : (
                    <YtCarousel videos={videos} autoplay={autoplay} interval={interval} showTitles={showTitles} />
                )
            )}
        </div>
    );
}
