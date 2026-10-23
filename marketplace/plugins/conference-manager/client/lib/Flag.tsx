// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * Country flags as images (conference-manager 2.33.2): Windows has no flag emoji, so the phone country selector
 * draws the bundled flag-icons SVGs instead. They come from GET /public/flags in batches (the codes asked within
 * one frame go in one request) and are kept for the page's life; a `lazy` flag waits until it scrolls into view,
 * so opening the list loads only the rows on screen. Until a flag arrives (or if it cannot), the ISO letters show.
 */
import React, { useEffect, useRef, useState } from "react";

const URL_OF = new Map<string, string | null>();   // ISO → data URL (null = none)
const waiting = new Map<string, Set<(u: string | null) => void>>();
let queued: string[] = [];
let timer: any = null;

function flush() {
    timer = null;
    const batch = queued.splice(0, 48);
    if (queued.length) timer = setTimeout(flush, 0);
    if (!batch.length) return;
    fetch(`/api/v1/plugin/conference-manager/public/flags?iso=${batch.join(',')}`, { credentials: 'omit' })
        .then(r => (r.ok ? r.json() : { flags: {} }))
        .catch(() => ({ flags: {} }))
        .then(({ flags }) => {
            for (const iso of batch) {
                const svg = flags && flags[iso];
                const url = svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
                URL_OF.set(iso, url);
                for (const cb of waiting.get(iso) || []) cb(url);
                waiting.delete(iso);
            }
        });
}
/** The flag's data URL: now if loaded, else through `cb` once its batch answers. */
export function loadFlag(iso: string, cb: (u: string | null) => void): string | null | undefined {
    const k = String(iso || '').toUpperCase();
    if (URL_OF.has(k)) return URL_OF.get(k);
    if (!waiting.has(k)) { waiting.set(k, new Set()); queued.push(k); if (!timer) timer = setTimeout(flush, 16); }
    waiting.get(k)!.add(cb);
    return undefined;
}

export function Flag({ iso, width = 22, lazy = false, className = '' }: { iso: string; width?: number; lazy?: boolean; className?: string }) {
    const height = Math.round(width * 0.75);
    const [url, setUrl] = useState<string | null | undefined>(() => URL_OF.get(String(iso || '').toUpperCase()));
    const [seen, setSeen] = useState(!lazy);
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (seen || typeof IntersectionObserver === 'undefined' || !ref.current) { setSeen(true); return undefined; }
        const io = new IntersectionObserver((entries) => { if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '64px' });
        io.observe(ref.current);
        return () => io.disconnect();
    }, [seen]);
    useEffect(() => {
        if (!seen) return undefined;
        let alive = true;
        const now = loadFlag(iso, (u) => { if (alive) setUrl(u); });
        setUrl(now);
        return () => { alive = false; };
    }, [iso, seen]);
    const box = { width, height, minWidth: width };
    return (
        <span ref={ref} className={`inline-flex items-center justify-center shrink-0 overflow-hidden rounded-[3px] ${className}`} style={box} aria-hidden="true" data-flag={iso}>
            {url
                ? <img src={url} alt="" width={width} height={height} style={{ width, height, objectFit: 'cover', display: 'block' }} />
                : <span className="w-full h-full inline-flex items-center justify-center bg-gray-100 text-gray-500 font-black" style={{ fontSize: Math.max(8, Math.round(height * 0.55)) }}>{String(iso || '').toUpperCase()}</span>}
        </span>
    );
}
