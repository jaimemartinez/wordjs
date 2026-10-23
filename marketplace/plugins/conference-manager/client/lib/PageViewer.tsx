// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The signed sheet's uploaded pages, shown in place (2.36.3): a photo as it is, a scanned PDF page by page
 * (lib/pdfScan: each page's picture, taken out of the file in the browser). Nothing is downloaded and no window is
 * opened — the admin's frame and some phones allow neither, and a coordinator only needs to look. Each page can be
 * zoomed (buttons, the wheel, a pinch, a double tap) and moved (drag) to read a signature.
 */
import React, { useEffect, useRef, useState } from "react";
import { dataUrlBytes, pageUrl, scanPages } from "./pdfScan";

type Page = { key: string; src?: string; note?: string; label: string };
const sq = "inline-flex w-8 h-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40";
const MIN = 1, MAX = 6;

/** One page, zoomable and movable. */
export function ZoomImage({ src, alt, t }: { src: string; alt: string; t: (k: string, v?: any) => string }) {
    const box = useRef<HTMLDivElement | null>(null);
    const [v, setV] = useState({ s: 1, x: 0, y: 0 });
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const pinch = useRef<{ d: number; s: number } | null>(null);
    useEffect(() => { setV({ s: 1, x: 0, y: 0 }); }, [src]);

    // Zoom to `s`, keeping the point (cx, cy) of the box where it is.
    const zoomAt = (s: number, cx?: number, cy?: number) => setV((cur) => {
        const r = box.current?.getBoundingClientRect();
        const px = cx ?? (r ? r.width / 2 : 0), py = cy ?? (r ? r.height / 2 : 0);
        const ns = Math.min(MAX, Math.max(MIN, s));
        if (ns === 1) return { s: 1, x: 0, y: 0 };
        const k = ns / cur.s;
        return { s: ns, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k };
    });
    const local = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    // The wheel zooms the page, not the screen behind it (a passive listener cannot stop the scroll).
    useEffect(() => {
        const el = box.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => { e.preventDefault(); const p = local(e); zoomAt(vRef.current.s * Math.exp(-e.deltaY * 0.0015), p.x, p.y); };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);
    const vRef = useRef(v);
    vRef.current = v;

    const down = (e: React.PointerEvent) => { (e.currentTarget as any).setPointerCapture?.(e.pointerId); pointers.current.set(e.pointerId, local(e)); if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v.s }; } };
    const move = (e: React.PointerEvent) => {
        const prev = pointers.current.get(e.pointerId);
        if (!prev) return;
        const p = local(e);
        pointers.current.set(e.pointerId, p);
        if (pointers.current.size === 2 && pinch.current) {
            const [a, b] = [...pointers.current.values()];
            zoomAt(pinch.current.s * Math.hypot(a.x - b.x, a.y - b.y) / (pinch.current.d || 1), (a.x + b.x) / 2, (a.y + b.y) / 2);
        } else if (v.s > 1) setV((cur) => ({ ...cur, x: cur.x + p.x - prev.x, y: cur.y + p.y - prev.y }));
    };
    const up = (e: React.PointerEvent) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null; };

    return (
        <div className="relative w-full h-full">
            <div ref={box} className="relative w-full h-full overflow-hidden rounded-lg bg-gray-100 select-none" style={{ touchAction: "none", cursor: v.s > 1 ? "grab" : "zoom-in" }}
                onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
                onDoubleClick={(e) => { const p = local(e); zoomAt(v.s > 1 ? 1 : 2.5, p.x, p.y); }} data-paper-zoom={Math.round(v.s * 100)}>
                <img src={src} alt={alt} draggable={false} className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                    style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, transformOrigin: "0 0" }} />
            </div>
            <div className="absolute right-2 bottom-2 flex items-center gap-1 rounded-xl bg-white/90 p-1 shadow">
                <button type="button" className={sq} onClick={() => zoomAt(v.s / 1.5)} disabled={v.s <= MIN} aria-label={t("paper.viewer.zoomOut")} data-paper-zoom-out=""><i className="fa-solid fa-minus" aria-hidden="true"></i></button>
                <span className="min-w-[3rem] text-center text-[11px] font-bold tabular-nums text-gray-700">{Math.round(v.s * 100)} %</span>
                <button type="button" className={sq} onClick={() => zoomAt(v.s * 1.5)} disabled={v.s >= MAX} aria-label={t("paper.viewer.zoomIn")} data-paper-zoom-in=""><i className="fa-solid fa-plus" aria-hidden="true"></i></button>
                <button type="button" className={sq} onClick={() => setV({ s: 1, x: 0, y: 0 })} disabled={v.s === 1} aria-label={t("paper.viewer.fit")}><i className="fa-solid fa-expand" aria-hidden="true"></i></button>
            </div>
        </div>
    );
}

/**
 * Every uploaded file of a sheet as pages: a photo is one, a scanned PDF one per page. `load` fetches a file
 * ({ mime, data_url, name }); pages appear as they are ready.
 */
export function PageViewer({ t, files, load }: { t: (k: string, v?: any) => string; files: any[]; load: (f: any) => Promise<any> }) {
    const [pages, setPages] = useState<Page[] | null>(null);
    const [i, setI] = useState(0);
    const ids = (files || []).map((f) => f.id).join(",");
    useEffect(() => {
        let alive = true;
        const urls: string[] = [];
        (async () => {
            const out: Page[] = [];
            for (const f of files || []) {
                const name = f.name || `#${f.id}`;
                try {
                    const r = await load(f);
                    if (r.mime === "application/pdf") {
                        const scan = scanPages(dataUrlBytes(r.data_url));
                        if (!scan.length) out.push({ key: `${f.id}`, note: t("paper.viewer.pdf.none"), label: name });
                        for (let n = 0; n < scan.length; n++) {
                            const url = await pageUrl(scan[n]).catch(() => null);
                            if (url) urls.push(url);
                            out.push({ key: `${f.id}-${n}`, src: url || undefined, note: url ? undefined : t("paper.viewer.pdf.page"), label: `${name} · ${t("paper.viewer.pdfpage", { n: n + 1, of: scan.length })}` });
                        }
                    } else out.push({ key: `${f.id}`, src: r.data_url, label: name });
                } catch (e: any) { out.push({ key: `${f.id}`, note: e?.message || "Error", label: name }); }
                if (alive) setPages([...out]);
            }
            if (alive) setPages([...out]);
        })();
        return () => { alive = false; for (const u of urls) URL.revokeObjectURL(u); };
        // The files, by id: a new list object with the same files is the same viewer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ids]);
    useEffect(() => { setI(0); }, [ids]);

    const page = pages && pages[Math.min(i, pages.length - 1)];
    return (
        <div className="flex flex-col w-full h-full min-h-0" data-paper-viewer="" data-paper-viewer-pages={pages ? pages.length : 0}>
            <div className="flex items-center justify-between gap-2 pb-2">
                <span className="min-w-0 truncate text-[11px] font-semibold text-gray-600" title={page?.label}>{page ? page.label : t("paper.photo.loading")}</span>
                {pages && pages.length > 1 && (
                    <span className="flex items-center gap-1">
                        <button type="button" className={sq} disabled={i <= 0} onClick={() => setI(i - 1)} aria-label={t("paper.viewer.prev")} data-paper-page-prev=""><i className="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
                        <span className="text-[11px] font-bold tabular-nums text-gray-700" data-paper-page={i + 1}>{t("paper.viewer.page", { i: i + 1, n: pages.length })}</span>
                        <button type="button" className={sq} disabled={i >= pages.length - 1} onClick={() => setI(i + 1)} aria-label={t("paper.viewer.next")} data-paper-page-next=""><i className="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
                    </span>
                )}
            </div>
            <div className="flex-1 min-h-0">
                {!page ? <div className="w-full h-full rounded-lg bg-gray-100 flex items-center justify-center text-sm text-gray-500">{t("paper.photo.loading")}</div>
                    : page.src ? <ZoomImage src={page.src} alt={page.label} t={t} />
                        : <div className="w-full h-full rounded-lg bg-amber-50 border border-amber-100 flex items-center justify-center p-4 text-center text-xs font-semibold text-amber-900" role="note">{page.note}</div>}
            </div>
        </div>
    );
}

export default PageViewer;
