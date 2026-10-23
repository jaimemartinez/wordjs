// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The badge designer (conference-manager 2.29.0) — a free-form canvas in the manner of Canva: templates to start
 * from; texts in 14 typefaces with the registrant's data as tokens ({{@name}}, {{@location}}, any form field…);
 * shapes, lines, images (uploaded once, kept in a gallery) and the QR the meal scanner reads. Every element is
 * dragged, resized and rotated on the card with magnetic guides (the card's edges and centre, the other
 * elements), ordered in layers, locked, duplicated, aligned; undo / redo; keyboard shortcuts.
 *
 * WYSIWYG: the canvas draws the display list of the SAME layout code the server runs for the PDF and the
 * credential pages (server/badge-design.js), measured with the same font files — what you see is what prints.
 * The parent holds the saved state: `onChange(design)` after every edit, `onImages(list)` for the gallery.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModal } from "@/contexts/ModalContext";
import { BadgeSvg as BadgeCard } from "./BadgeSvg";
import { badgesApi } from "../lib/badges";
import { Select } from "../lib/Select";
import {
    TEMPLATES, STICKER_TEMPLATES, STICKER_PRESETS, STICKER_MM, presetOf, scaleDesign, stickerTemplateFor, FONTS, editorMetrics, loadFace, faceOf, familyCss, layoutDesign, normalizeDesignV2, cardOf, newId, prepareImage,
} from "../lib/badgeEditor";

const btn = 'min-h-[36px] px-3 rounded-xl font-black text-[10px] uppercase tracking-widest inline-flex items-center justify-center gap-1.5 disabled:opacity-40';
const ghost = `${btn} bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-400`;
const icon = 'w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-xl border-2 border-gray-100 bg-white text-gray-600 hover:border-blue-400 hover:text-blue-700 disabled:opacity-40 disabled:hover:border-gray-100';
const iconOn = 'w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-xl border-2 border-blue-500 bg-blue-50 text-blue-700';
const lbl = 'block text-[9px] font-black uppercase tracking-widest text-gray-500 mb-1';
const inp = 'w-full border-2 border-gray-100 rounded-lg px-2 py-1.5 bg-white focus:border-blue-500 outline-none text-xs text-gray-900 font-bold';
const panel = 'bg-white rounded-3xl border border-gray-100 shadow-sm p-4 space-y-3';
const SWATCHES = ['#ffffff', '#000000', '#0f172a', '#1e3a8a', '#2563eb', '#0ea5e9', '#0d9488', '#16a34a', '#f59e0b', '#f97316', '#dc2626', '#db2777', '#7c3aed', '#b08d57', '#fdf8f0', '#94a3b8'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isTyping = (t: any) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
const HISTORY = 80;

// ── geometry ──
const rad = (deg: number) => (deg * Math.PI) / 180;
const rotateVec = (x: number, y: number, deg: number) => { const a = rad(deg), c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };
/** The axis-aligned bounds of an element (its rotated box). */
function bounds(el: any) {
    if (!el.rot) return { x: el.x, y: el.y, w: el.w, h: el.h };
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => rotateVec((sx * el.w) / 2, (sy * el.h) / 2, el.rot));
    const xs = pts.map(p => cx + p[0]), ys = pts.map(p => cy + p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A colour: the picker, the house swatches and (for fills and borders) «none». Outside the editor so an input keeps its focus. */
function ColorRow({ value, onPick, allowNone, title, editable, tx, big }: any) {
    return (
        <div>
            <span className={lbl}>{title}</span>
            <div className="flex flex-wrap items-center gap-1">
                <label className="relative w-8 h-8 rounded-lg border-2 border-gray-200 overflow-hidden cursor-pointer shrink-0" title={value || 'none'}
                    style={{ background: value || 'repeating-conic-gradient(#e5e7eb 0 25%, #fff 0 50%) 50% / 8px 8px' }}>
                    <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" value={value || '#ffffff'} disabled={!editable} onChange={(e) => onPick(e.target.value)} aria-label={title} />
                </label>
                {SWATCHES.map(c => (
                    <button key={c} type="button" disabled={!editable} onClick={() => onPick(c)} title={c} aria-label={c}
                        className={`${big ? 'w-7 h-7' : 'w-5 h-5'} rounded-md border ${value === c ? 'ring-2 ring-blue-500 border-white' : 'border-gray-200'}`} style={{ background: c }} />
                ))}
                {allowNone && <button type="button" disabled={!editable} onClick={() => onPick(null)} className={`h-5 px-1.5 rounded-md border text-[9px] font-black uppercase ${!value ? 'border-blue-500 text-blue-700' : 'border-gray-200 text-gray-500'}`}>{tx('badges.ed.none', 'Sin')}</button>}
            </div>
        </div>
    );
}
/** A number in mm / pt / degrees; typing a partial number («1.») does not reset it. */
function Num({ label, value, onSet, step = 0.5, min, max, suffix, editable }: any) {
    const [txt, setTxt] = React.useState(String(value));
    const focused = React.useRef(false);
    React.useEffect(() => { if (!focused.current) setTxt(String(value)); }, [value]);
    return (
        <label className="block min-w-0">
            <span className={lbl}>{label}</span>
            <span className="flex items-center gap-1">
                <input type="number" className={inp} value={txt} step={step} min={min} max={max} disabled={!editable}
                    onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setTxt(String(value)); }}
                    onChange={(e) => { setTxt(e.target.value); const v = parseFloat(e.target.value); if (Number.isFinite(v)) onSet(v); }} />
                {suffix && <span className="text-[9px] font-black text-gray-400">{suffix}</span>}
            </span>
        </label>
    );
}

export function BadgeEditor({ conferenceId, initial, onChange, images, onImages, sample, tokenLabels, tokenShown, qrSample, locked, tx, addToast, canManage, onSave, dirty, saving }: any) {
    const { confirm } = useModal();
    const [d, setD] = useState(() => normalizeDesignV2(initial));
    const [sel, setSel] = useState<string[]>([]);
    const [tab, setTab] = useState<'templates' | 'text' | 'elements' | 'images' | 'background'>('templates');
    const [showData, setShowData] = useState(true);
    const [zoom, setZoom] = useState(1);
    const [fontVer, setFontVer] = useState(0);
    const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
    const [fontMenu, setFontMenu] = useState(false);
    const [uploading, setUploading] = useState(false);
    const past = useRef<any[]>([]);
    const future = useRef<any[]>([]);
    const [, setHistVer] = useState(0);
    const dRef = useRef(d); dRef.current = d;
    const selRef = useRef<string[]>([]); selRef.current = sel;
    const drag = useRef<any>(null);
    const overlayRef = useRef<SVGSVGElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const textRef = useRef<HTMLTextAreaElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const clipboard = useRef<any[] | null>(null);
    const [wrapW, setWrapW] = useState(640);
    // The editor's own width decides its arrangement (the admin's content column, not the window, is what it has).
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [rootW, setRootW] = useState(1200);
    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([e]) => setRootW(e.contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const mode = rootW >= 1180 ? 'wide' : rootW >= 760 ? 'mid' : 'narrow';
    const hasSel = sel.length > 0;
    const area = (k: 'tools' | 'canvas' | 'props'): React.CSSProperties => {
        if (mode === 'wide') return { gridColumn: k === 'tools' ? 1 : k === 'canvas' ? 2 : 3, gridRow: 1, ...(k !== 'canvas' ? { position: 'sticky', top: 8 } : {}) };
        // Beside or under the canvas, what was just tapped comes first: its properties, then the tools.
        const first = hasSel ? 'props' : 'tools';
        if (mode === 'mid') return k === 'canvas' ? { gridColumn: 1, gridRow: '1 / span 2' } : { gridColumn: 2, gridRow: k === first ? 1 : 2 };
        return { gridColumn: 1, gridRow: k === 'canvas' ? 1 : k === first ? 2 : 3 };
    };
    const columns = mode === 'wide' ? '290px minmax(0,1fr) 290px' : mode === 'mid' ? 'minmax(0,1fr) 290px' : 'minmax(0,1fr)';

    const card = cardOf(d.layout, d.size);
    // 2.36.0: «Sticker para imprimir» — the same designer on a label of the chosen size (no orientation, no fixed QR).
    const isSticker = d.layout === 'sticker';
    // A sticker offers the starting points made for its label's shape (tall or wide).
    const templates = isSticker ? STICKER_TEMPLATES.filter((t: any) => !!t.wide === (card.w > card.h * 1.3)) : TEMPLATES;
    const editable = canManage && !locked;

    // ── committing (history) ──
    const commit = useCallback((next: any, keepSel?: string[]) => {
        const prev = dRef.current;
        if (next === prev) return;
        past.current.push(prev);
        if (past.current.length > HISTORY) past.current.shift();
        future.current = [];
        const norm = normalizeDesignV2(next);
        setD(norm);
        dRef.current = norm;
        if (keepSel) setSel(keepSel.filter(id => norm.elements.some((e: any) => e.id === id)));
        setHistVer(v => v + 1);
        onChange(norm);
    }, [onChange]);
    const undo = () => {
        if (!past.current.length) return;
        future.current.push(dRef.current);
        const prev = past.current.pop();
        setD(prev); dRef.current = prev; setHistVer(v => v + 1); onChange(prev);
        setSel(s => s.filter(id => prev.elements.some((e: any) => e.id === id)));
    };
    const redo = () => {
        if (!future.current.length) return;
        past.current.push(dRef.current);
        const next = future.current.pop();
        setD(next); dRef.current = next; setHistVer(v => v + 1); onChange(next);
        setSel(s => s.filter(id => next.elements.some((e: any) => e.id === id)));
    };
    const update = (ids: string[], patch: (el: any) => any) => commit({ ...dRef.current, elements: dRef.current.elements.map((e: any) => (ids.includes(e.id) ? { ...e, ...patch(e) } : e)) }, selRef.current);

    // ── faces: every face the design uses, loaded; the layout runs again when one arrives ──
    useEffect(() => {
        const faces = new Set<string>();
        for (const e of d.elements) if (e.type === 'text') { const f = faceOf(e.font, e.bold); if (f) faces.add(f); }
        for (const f of faces) loadFace(f).then((ok) => { if (ok) setFontVer(v => v + 1); });
    }, [d]);

    // ── canvas size ──
    useEffect(() => {
        const el = wrapRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([e]) => setWrapW(Math.max(240, e.contentRect.width)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // The whole card on screen: as wide as the canvas allows, as tall as the window leaves under the toolbars.
    const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
    useEffect(() => {
        const on = () => setVh(window.innerHeight);
        window.addEventListener('resize', on);
        return () => window.removeEventListener('resize', on);
    }, []);
    const maxCardH = mode === 'narrow' ? Math.max(260, vh * 0.5) : Math.max(300, vh - 380);
    const fitScale = Math.min((wrapW - 40) / card.w, maxCardH / card.h);
    const s = Math.max(2, fitScale * zoom);            // px per mm
    const M = 22 / s;                                   // overlay margin (mm) for the handles

    // ── the badge as it prints ──
    const imageMeta = useMemo(() => Object.fromEntries((images || []).map((i: any) => [i.id, { w: i.w, h: i.h }])), [images]);
    const imageUrls = useMemo(() => Object.fromEntries((images || []).map((i: any) => [i.id, i.url])), [images]);
    const data = showData ? sample : (tokenShown || tokenLabels);
    const badge = useMemo(() => layoutDesign(d, { data, qr: qrSample, metrics: editorMetrics, images: imageMeta }), [d, data, qrSample, imageMeta, fontVer]);

    const selected = d.elements.filter((e: any) => sel.includes(e.id));
    const one = selected.length === 1 ? selected[0] : null;

    // ── pointer: move / resize / rotate ──
    const toMm = (ev: any) => {
        const r = overlayRef.current!.getBoundingClientRect();
        return { x: (ev.clientX - r.left) / s - M, y: (ev.clientY - r.top) / s - M };
    };
    const startDrag = (ev: any, kind: string, extra: any = {}) => {
        if (!editable) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { overlayRef.current!.setPointerCapture(ev.pointerId); } catch { /* old browser */ }
        const p = toMm(ev);
        drag.current = { kind, p0: p, orig: new Map(dRef.current.elements.map((e: any) => [e.id, e])), base: dRef.current, moved: false, ...extra };
    };
    const onElementDown = (ev: any, el: any) => {
        ev.stopPropagation();
        let next = sel;
        if (ev.shiftKey) next = sel.includes(el.id) ? sel.filter(x => x !== el.id) : [...sel, el.id];
        else if (!sel.includes(el.id)) next = [el.id];
        setSel(next);
        if (ev.detail === 2 && el.type === 'text') { setTimeout(() => textRef.current && textRef.current.focus(), 0); return; }
        const movable = next.filter(id => { const e = d.elements.find((x: any) => x.id === id); return e && !e.locked; });
        if (movable.length && next.includes(el.id)) startDrag(ev, 'move', { ids: movable, sel: next });
    };
    const SNAP_PX = 6;
    const snapMove = (ids: string[], dx: number, dy: number, orig: Map<string, any>) => {
        // The moving group's bounds, against the card and the other elements: edges and centres.
        const boxes = ids.map(id => bounds({ ...orig.get(id), x: orig.get(id).x + dx, y: orig.get(id).y + dy }));
        const g = { x: Math.min(...boxes.map(b => b.x)), y: Math.min(...boxes.map(b => b.y)) };
        const g2 = { x: Math.max(...boxes.map(b => b.x + b.w)), y: Math.max(...boxes.map(b => b.y + b.h)) };
        const xs = [g.x, (g.x + g2.x) / 2, g2.x], ys = [g.y, (g.y + g2.y) / 2, g2.y];
        const tx = [0, card.w / 2, card.w], ty = [0, card.h / 2, card.h];
        for (const e of dRef.current.elements) {
            if (ids.includes(e.id)) continue;
            const b = bounds(e);
            tx.push(b.x, b.x + b.w / 2, b.x + b.w); ty.push(b.y, b.y + b.h / 2, b.y + b.h);
        }
        const th = SNAP_PX / s;
        let bx = null as any, by = null as any;
        for (const a of xs) for (const t of tx) { const dd = t - a; if (Math.abs(dd) <= th && (!bx || Math.abs(dd) < Math.abs(bx.d))) bx = { d: dd, at: t }; }
        for (const a of ys) for (const t of ty) { const dd = t - a; if (Math.abs(dd) <= th && (!by || Math.abs(dd) < Math.abs(by.d))) by = { d: dd, at: t }; }
        return { dx: dx + (bx ? bx.d : 0), dy: dy + (by ? by.d : 0), guides: { v: bx ? [bx.at] : [], h: by ? [by.at] : [] } };
    };
    const onMove = (ev: any) => {
        const g = drag.current;
        if (!g) return;
        const p = toMm(ev);
        const dx = p.x - g.p0.x, dy = p.y - g.p0.y;
        if (!g.moved && Math.hypot(dx, dy) * s < 2) return;
        g.moved = true;
        let els = g.base.elements;
        if (g.kind === 'move') {
            const snapped = ev.altKey ? { dx, dy, guides: { v: [], h: [] } } : snapMove(g.ids, dx, dy, g.orig);
            setGuides(snapped.guides);
            els = els.map((e: any) => (g.ids.includes(e.id) ? { ...e, x: r2(g.orig.get(e.id).x + snapped.dx), y: r2(g.orig.get(e.id).y + snapped.dy) } : e));
        } else if (g.kind === 'resize') {
            const o = g.orig.get(g.id);
            const [lx, ly] = rotateVec(dx, dy, -(o.rot || 0));
            const keepRatio = o.type === 'qr' || ((o.type === 'image' || ev.shiftKey) && g.sx && g.sy);
            let w = o.w + g.sx * lx, h = o.h + g.sy * ly;
            const minW = o.type === 'qr' ? 14 : 1, minH = o.type === 'line' ? o.h : o.type === 'qr' ? 14 : 1;
            if (keepRatio) {
                const k = Math.max(g.sx ? w / o.w : 0, g.sy ? h / o.h : 0, minW / o.w);
                w = o.w * k; h = o.h * k;
            }
            w = Math.max(minW, w); h = g.sy ? Math.max(minH, h) : o.h;
            if (!g.sx) w = o.w;
            const [cxs, cys] = rotateVec((g.sx * (w - o.w)) / 2, (g.sy * (h - o.h)) / 2, o.rot || 0);
            const cx = o.x + o.w / 2 + cxs, cy = o.y + o.h / 2 + cys;
            els = els.map((e: any) => (e.id === g.id ? { ...e, x: r2(cx - w / 2), y: r2(cy - h / 2), w: r2(w), h: r2(h) } : e));
        } else if (g.kind === 'rotate') {
            const o = g.orig.get(g.id);
            const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
            let deg = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
            deg = ((deg % 360) + 360) % 360;
            if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
            else for (const t of [0, 90, 180, 270, 360]) if (Math.abs(deg - t) < 4) deg = t % 360;
            els = els.map((e: any) => (e.id === g.id ? { ...e, rot: r2(deg % 360) } : e));
        }
        const live = { ...g.base, elements: els };
        dRef.current = live;
        setD(live);
    };
    const onUp = () => {
        const g = drag.current;
        drag.current = null;
        setGuides({ v: [], h: [] });
        if (!g || !g.moved) return;
        const final = dRef.current;
        dRef.current = g.base;
        commit(final, g.sel || selRef.current);
    };

    // ── keyboard ──
    useEffect(() => {
        const onKey = (ev: KeyboardEvent) => {
            if (!editable || isTyping(ev.target)) return;
            const mod = ev.ctrlKey || ev.metaKey;
            if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); return; }
            if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
            if (!sel.length) return;
            if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); remove(); return; }
            if (ev.key === 'Escape') { setSel([]); return; }
            if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicate(); return; }
            if (mod && ev.key.toLowerCase() === 'c') { clipboard.current = dRef.current.elements.filter((e: any) => sel.includes(e.id) && e.type !== 'qr'); return; }
            const step = ev.shiftKey ? 2 : 0.5;
            const arrows: any = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
            if (arrows[ev.key]) {
                ev.preventDefault();
                const [ax, ay] = arrows[ev.key];
                update(sel.filter(id => !dRef.current.elements.find((e: any) => e.id === id)?.locked), (e) => ({ x: r2(e.x + ax), y: r2(e.y + ay) }));
            }
        };
        const onPaste = (ev: KeyboardEvent) => {
            if (!editable || isTyping(ev.target)) return;
            if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v' && clipboard.current && clipboard.current.length) {
                ev.preventDefault();
                const copies = clipboard.current.map((e: any) => ({ ...e, id: newId(), x: r2(e.x + 3), y: r2(e.y + 3) }));
                commit({ ...dRef.current, elements: [...dRef.current.elements, ...copies] }, copies.map((c: any) => c.id));
            }
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('keydown', onPaste);
        return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onPaste); };
    });

    // ── actions ──
    const add = (el: any) => {
        const full = { id: newId(), rot: 0, op: 1, ...el };
        // A new element goes just under the QR? No: on top of everything, like any editor.
        commit({ ...dRef.current, elements: [...dRef.current.elements, full] }, [full.id]);
    };
    const remove = () => {
        // A sticker may drop its QR (a small label has no room); the virtual badge keeps it for the meal scanner.
        const ids = sel.filter(id => isSticker || dRef.current.elements.find((e: any) => e.id === id)?.type !== 'qr');
        if (!ids.length) { addToast(tx('badges.ed.qr.keep', 'El QR no se puede quitar: es lo que lee el escáner de comidas.'), 'info'); return; }
        commit({ ...dRef.current, elements: dRef.current.elements.filter((e: any) => !ids.includes(e.id)) }, []);
    };
    const duplicate = () => {
        const src = dRef.current.elements.filter((e: any) => sel.includes(e.id) && e.type !== 'qr');
        if (!src.length) return;
        const copies = src.map((e: any) => ({ ...e, id: newId(), x: r2(e.x + 3), y: r2(e.y + 3), locked: false }));
        commit({ ...dRef.current, elements: [...dRef.current.elements, ...copies] }, copies.map((c: any) => c.id));
    };
    const reorder = (how: 'up' | 'down' | 'top' | 'bottom') => {
        if (!one) return;
        const list = dRef.current.elements.slice();
        const i = list.findIndex((e: any) => e.id === one.id);
        const [el] = list.splice(i, 1);
        const j = how === 'top' ? list.length : how === 'bottom' ? 0 : how === 'up' ? Math.min(list.length, i + 1) : Math.max(0, i - 1);
        list.splice(j, 0, el);
        commit({ ...dRef.current, elements: list }, sel);
    };
    const align = (how: string) => {
        const ids = sel.filter(id => !dRef.current.elements.find((e: any) => e.id === id)?.locked);
        if (!ids.length) return;
        // One element aligns to the card; several, to their common bounds.
        const els = dRef.current.elements.filter((e: any) => ids.includes(e.id));
        const bs = els.map(bounds);
        const area = ids.length === 1 ? { x: 0, y: 0, w: card.w, h: card.h } : (() => {
            const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y));
            return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y };
        })();
        update(ids, (e) => {
            const b = bounds(e);
            if (how === 'left') return { x: r2(e.x + area.x - b.x) };
            if (how === 'hcenter') return { x: r2(e.x + area.x + area.w / 2 - (b.x + b.w / 2)) };
            if (how === 'right') return { x: r2(e.x + area.x + area.w - (b.x + b.w)) };
            if (how === 'top') return { y: r2(e.y + area.y - b.y) };
            if (how === 'vcenter') return { y: r2(e.y + area.y + area.h / 2 - (b.y + b.h / 2)) };
            return { y: r2(e.y + area.y + area.h - (b.y + b.h)) };
        });
    };
    // A sticker on another label size: everything scales with it (turning it = swapping width and height). When the
    // label's SHAPE changes (tall ↔ wide) scaling squeezes the design, so the designer offers a layout made for that
    // shape instead (an in-app question; «Ajustar mi diseño» keeps the scaling).
    const setStickerSize = async (size: { w: number; h: number }) => {
        const w = r2(clampN(Number(size.w) || 0, STICKER_MM.min, STICKER_MM.max)), h = r2(clampN(Number(size.h) || 0, STICKER_MM.min, STICKER_MM.max));
        if (w === card.w && h === card.h) return;
        const wideNow = card.w > card.h * 1.3, wideNext = w > h * 1.3;
        if (wideNow !== wideNext && await confirm(
            tx('badges.sticker.reshape', 'La etiqueta cambia de forma. ¿Usar un diseño pensado para esta forma? Puedes deshacerlo.'),
            tx('badges.sticker.reshape.title', 'Otra forma de etiqueta'), false,
            { confirmText: tx('badges.sticker.reshape.template', 'Usar ese diseño'), cancelText: tx('badges.sticker.reshape.scale', 'Ajustar mi diseño') })) {
            commit(scaleDesign(normalizeDesignV2(stickerTemplateFor({ w, h }).make()), { w, h }), []);
            return;
        }
        commit(scaleDesign(dRef.current, { w, h }), sel);
    };
    const [customSize, setCustomSize] = useState<{ w: string; h: string } | null>(null);
    const setOrientation = (layout: 'horizontal' | 'vertical') => {
        if (layout === d.layout) return;
        const from = cardOf(d.layout), to = cardOf(layout);
        // Centres move proportionally; sizes stay (and shrink to fit the new card when they no longer do).
        const elements = d.elements.map((e: any) => {
            let w = e.w, h = e.h;
            const k = Math.min(1, to.w / Math.max(w, 1e-6), to.h / Math.max(h, 1e-6));
            if (e.type === 'qr' || e.type === 'image') { w *= k; h *= k; } else { w = Math.min(w, to.w); h = Math.min(h, to.h); }
            const cx = ((e.x + e.w / 2) / from.w) * to.w, cy = ((e.y + e.h / 2) / from.h) * to.h;
            return { ...e, w: r2(w), h: r2(h), x: r2(clampN(cx - w / 2, -w / 2, to.w - w / 2)), y: r2(clampN(cy - h / 2, -h / 2, to.h - h / 2)) };
        });
        commit({ ...d, layout, elements }, sel);
    };
    // The host's in-app confirm (never the browser's native dialog).
    const applyTemplate = async (t: any) => {
        if (d.elements.length > 1 && !await confirm(tx('badges.ed.template.confirm', '¿Reemplazar el diseño actual por esta plantilla? Puedes deshacerlo.'), tx('badges.ed.template.title', 'Cambiar de plantilla'), false, { confirmText: tx('badges.ed.template.apply', 'Reemplazar') })) return;
        const made = t.make();
        // A sticker template is drawn for 62 × 100 mm: it lands on the label size in use.
        commit(isSticker ? scaleDesign(normalizeDesignV2(made), { w: card.w, h: card.h }) : made, []);
    };

    const tokenText = (key: string) => `{{${key}}}`;
    // The text field shows the data as «[Nombre completo]», never the raw {{@name}}; typing a known «[…]» back is the token.
    const friendly = (t: string) => String(t || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m: string, k: string) => (tokenLabels && tokenLabels[k] ? `[${tokenLabels[k]}]` : m));
    const unfriendly = (t: string) => {
        let out = String(t || '');
        for (const [k, label] of Object.entries(tokenLabels || {})) out = out.split(`[${label}]`).join(`{{${k}}}`);
        return out;
    };
    // The meal group letter (2.32.0, A–F): a big bold letter, centred; empty (not drawn) while the person has no group.
    const addMealGroup = () => {
        const side = Math.min(30, card.w - 6, card.h - 6);
        add({ type: 'text', x: r2((card.w - side) / 2), y: r2((card.h - side) / 2), w: side, h: side, text: '{{@meal_group}}', font: 'montserrat', bold: true,
            size: r2(side * 2.2), color: isSticker ? '#000000' : '#111827', align: 'center', valign: 'middle', upper: false, ls: 0, lh: 1, fit: 'shrink', name: tx('badges.ed.meal', 'Grupo de comida (letra)') });
    };
    const addText = (kind: 'title' | 'subtitle' | 'body' | string, token?: string) => {
        const w = Math.min(50, card.w - 8);
        const x = r2((card.w - w) / 2), y = r2(card.h / 2 - 5);
        if (token) return add({ type: 'text', x, y, w, h: 8, text: tokenText(token), font: 'montserrat', bold: token === '@name', size: token === '@name' ? 16 : 10, color: '#111827', align: 'left', valign: 'middle', upper: false, ls: 0, lh: 1.15, fit: 'shrink' });
        const presets: any = {
            title: { text: tx('badges.ed.text.title.sample', 'Título'), size: 20, bold: true, font: 'montserrat', h: 10 },
            subtitle: { text: tx('badges.ed.text.subtitle.sample', 'Subtítulo'), size: 12, bold: true, font: 'poppins', h: 7 },
            body: { text: tx('badges.ed.text.body.sample', 'Un texto'), size: 9, bold: false, font: 'poppins', h: 6 },
        };
        const p = presets[kind] || presets.body;
        return add({ type: 'text', x, y, w, h: p.h, text: p.text, font: p.font, bold: p.bold, size: p.size, color: '#111827', align: 'left', valign: 'middle', upper: false, ls: 0, lh: 1.15, fit: 'shrink' });
    };
    const addShape = (kind: string) => {
        const cx = card.w / 2, cy = card.h / 2;
        if (kind === 'rect') return add({ type: 'shape', shape: 'rect', x: r2(cx - 12), y: r2(cy - 8), w: 24, h: 16, fill: '#2563eb', stroke: null, sw: 0, r: 0 });
        if (kind === 'round') return add({ type: 'shape', shape: 'rect', x: r2(cx - 12), y: r2(cy - 8), w: 24, h: 16, fill: '#2563eb', stroke: null, sw: 0, r: 3 });
        if (kind === 'pill') return add({ type: 'shape', shape: 'rect', x: r2(cx - 15), y: r2(cy - 3.5), w: 30, h: 7, fill: '#ede9fe', stroke: null, sw: 0, r: 3.5 });
        if (kind === 'ellipse') return add({ type: 'shape', shape: 'ellipse', x: r2(cx - 10), y: r2(cy - 10), w: 20, h: 20, fill: '#f59e0b', stroke: null, sw: 0, r: 0 });
        if (kind === 'frame') return add({ type: 'shape', shape: 'rect', x: 2.5, y: 2.5, w: r2(card.w - 5), h: r2(card.h - 5), fill: null, stroke: '#111827', sw: 0.4, r: 1.5 });
        if (kind === 'band') return add({ type: 'shape', shape: 'rect', x: 0, y: 0, w: card.w, h: 12, fill: '#1e3a8a', stroke: null, sw: 0, r: 0 });
        if (kind === 'line') return add({ type: 'line', x: r2(cx - 15), y: r2(cy - 0.5), w: 30, h: 1, stroke: '#111827', sw: 0.5 });
    };
    const addImage = (img: any) => {
        const k = Math.min(30 / img.w, 30 / img.h);
        const w = r2(Math.max(5, img.w * k)), h = r2(Math.max(5, img.h * k));
        add({ type: 'image', asset: img.id, x: r2((card.w - w) / 2), y: r2((card.h - h) / 2), w, h, fit: 'cover', r: 0, mask: 'none' });
    };
    const asBackground = (img: any) => {
        const el = { id: newId(), type: 'image', asset: img.id, x: 0, y: 0, w: card.w, h: card.h, rot: 0, op: 1, fit: 'cover', r: 0, mask: 'none', locked: true, name: tx('badges.ed.bgimage', 'Imagen de fondo') };
        commit({ ...dRef.current, elements: [el, ...dRef.current.elements] }, [el.id]);
    };
    const upload = async (file: File | null) => {
        if (!file || uploading) return;
        setUploading(true);
        try {
            const img = await prepareImage(file);
            const r = await badgesApi.putImage(conferenceId, img.url, img.w, img.h);
            const entry = { id: r.id, w: img.w, h: img.h, url: img.url };
            onImages([...(images || []).filter((i: any) => i.id !== r.id), entry]);
            addImage(entry);
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
    };
    const dropFromGallery = async (img: any) => {
        if (d.elements.some((e: any) => e.type === 'image' && e.asset === img.id)) { addToast(tx('badges.ed.image.inuse', 'La escarapela usa esta imagen: quítala del diseño primero.'), 'info'); return; }
        try {
            await badgesApi.deleteAsset(conferenceId, `img_${img.id}`);
            onImages((images || []).filter((i: any) => i.id !== img.id));
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    // Faces for the font menu and the templates' thumbnails.
    useEffect(() => {
        if (!fontMenu) return;
        for (const f of FONTS) { const face = faceOf(f.id, false); if (face) loadFace(face).then(() => setFontVer(v => v + 1)); }
    }, [fontMenu]);
    const thumbs = useMemo(() => (tab === 'templates' ? templates.map(t => { const des = normalizeDesignV2(t.make()); return { t, des, badge: layoutDesign(des, { data: sample, qr: qrSample, metrics: editorMetrics, images: {} }) }; }) : []), [tab, sample, qrSample, fontVer, isSticker]);
    useEffect(() => {
        if (tab !== 'templates') return;
        const faces = new Set<string>();
        for (const t of templates) for (const e of t.make().elements) if (e.type === 'text') { const f = faceOf(e.font, e.bold); if (f) faces.add(f); }
        for (const f of faces) loadFace(f).then(() => setFontVer(v => v + 1));
    }, [tab]);

    // ── names in the layers list ──
    const nameOf = (e: any) => {
        if (e.name) return e.name;
        if (e.type === 'text') return (e.text || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_: string, k: string) => `[${(tokenLabels && tokenLabels[k]) || k}]`).slice(0, 40) || tx('badges.ed.layer.text', 'Texto');
        if (e.type === 'qr') return tx('badges.ed.layer.qr', 'Código QR');
        if (e.type === 'image') return tx('badges.ed.layer.image', 'Imagen');
        if (e.type === 'line') return tx('badges.ed.layer.line', 'Línea');
        return e.shape === 'ellipse' ? tx('badges.ed.layer.ellipse', 'Círculo') : tx('badges.ed.layer.rect', 'Rectángulo');
    };
    const iconOf = (e: any) => (e.type === 'text' ? 'fa-font' : e.type === 'qr' ? 'fa-qrcode' : e.type === 'image' ? 'fa-image' : e.type === 'line' ? 'fa-minus' : e.shape === 'ellipse' ? 'fa-circle' : 'fa-square');

    // ── render ──
    const handles = (el: any) => {
        const hs = 9 / s, rs = 18 / s;
        const list: [number, number][] = el.type === 'qr' ? [[-1, -1], [1, -1], [1, 1], [-1, 1]]
            : el.type === 'line' ? [[-1, 0], [1, 0]]
                : [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
        const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
        const cursor = (sx: number, sy: number) => {
            const a = (((Math.atan2(sy, sx) * 180) / Math.PI + (el.rot || 0)) % 180 + 180) % 180;
            return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
        };
        return (
            <g transform={el.rot ? `rotate(${el.rot} ${cx} ${cy})` : undefined}>
                <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke="#2563eb" strokeWidth={1.5 / s} pointerEvents="none" />
                {!el.locked && editable && (
                    <>
                        <line x1={cx} y1={el.y} x2={cx} y2={el.y - rs} stroke="#2563eb" strokeWidth={1.2 / s} pointerEvents="none" />
                        <circle cx={cx} cy={el.y - rs} r={hs * 0.65} fill="#fff" stroke="#2563eb" strokeWidth={1.5 / s} style={{ cursor: 'grab' }}
                            onPointerDown={(ev) => startDrag(ev, 'rotate', { id: el.id })} data-ed-rotate="" />
                        {list.map(([sx, sy]) => (
                            <rect key={`${sx}${sy}`} x={cx + (sx * el.w) / 2 - hs / 2} y={cy + (sy * el.h) / 2 - hs / 2} width={hs} height={hs} rx={hs * 0.25}
                                fill="#fff" stroke="#2563eb" strokeWidth={1.5 / s} style={{ cursor: cursor(sx, sy) }}
                                onPointerDown={(ev) => startDrag(ev, 'resize', { id: el.id, sx, sy })} data-ed-handle={`${sx},${sy}`} />
                        ))}
                    </>
                )}
                {el.locked && <text x={el.x + el.w - 1 / s} y={el.y - 3 / s} fontSize={10 / s} textAnchor="end" fill="#2563eb" pointerEvents="none">🔒</text>}
            </g>
        );
    };


    // The selection's actions, right under the canvas toolbar. Always there, always the same height (one row; two
    // on a phone, wrapping instead of hiding buttons): the canvas never moves under a finger.
    const actionBar = !editable ? null : selected.length === 0 ? (
        <div className={`${mode === 'narrow' ? 'h-[84px]' : 'h-[48px]'} flex items-center gap-2 rounded-2xl bg-white border-2 border-gray-100 px-3 text-[11px] font-bold text-gray-500`} data-ed-actionbar-empty="">
            <i className="fa-solid fa-hand-pointer text-gray-400" aria-hidden="true"></i>{tx('badges.ed.nosel', 'Toca un elemento del diseño para cambiarlo.')}
        </div>
    ) : (
        <div className={`${mode === 'narrow' ? 'h-[84px] flex-wrap content-center' : 'h-[48px] flex-nowrap overflow-x-auto'} flex items-center gap-1 rounded-2xl bg-white border-2 border-blue-100 shadow-sm px-2`} data-ed-actionbar="">
            {selected.some((e: any) => isSticker || e.type !== 'qr') && (
                <button type="button" onClick={remove} className={`${btn} min-h-[34px] shrink-0 bg-rose-600 text-white hover:bg-rose-700`} data-ed-bar-delete="">
                    <i className="fa-solid fa-trash-can" aria-hidden="true"></i>{tx('badges.ed.delete.short', 'Eliminar')}
                </button>
            )}
            {selected.some((e: any) => e.type !== 'qr') && (
                <button type="button" className={icon} onClick={duplicate} title={tx('badges.ed.duplicate', 'Duplicar (Ctrl+D)')} aria-label={tx('badges.ed.duplicate', 'Duplicar (Ctrl+D)')} data-ed-bar-duplicate=""><i className="fa-solid fa-clone"></i></button>
            )}
            {one && one.type === 'text' && (
                <>
                    {[['left', 'fa-align-left'], ['center', 'fa-align-center'], ['right', 'fa-align-right']].map(([a, ic]) => (
                        <button key={a} type="button" className={one.align === a ? iconOn : icon} onClick={() => update([one.id], () => ({ align: a }))} title={tx(`badges.ed.talign.${a}`, a)} aria-label={tx(`badges.ed.talign.${a}`, a)} aria-pressed={one.align === a} data-ed-bar-align={a}><i className={`fa-solid ${ic}`}></i></button>
                    ))}
                    <button type="button" className={one.bold ? iconOn : icon} onClick={() => update([one.id], (el) => ({ bold: !el.bold }))} title={tx('badges.ed.bold', 'Negrita')} aria-label={tx('badges.ed.bold', 'Negrita')} aria-pressed={!!one.bold}><i className="fa-solid fa-bold"></i></button>
                    <button type="button" className={icon} onClick={() => update([one.id], (el) => ({ size: Math.max(3, r2(el.size - 1)) }))} title={tx('badges.ed.smaller', 'Más pequeño')} aria-label={tx('badges.ed.smaller', 'Más pequeño')} data-ed-bar-smaller=""><span className="text-[11px] font-black">A−</span></button>
                    <button type="button" className={icon} onClick={() => update([one.id], (el) => ({ size: Math.min(120, r2(el.size + 1)) }))} title={tx('badges.ed.bigger', 'Más grande')} aria-label={tx('badges.ed.bigger', 'Más grande')} data-ed-bar-bigger=""><span className="text-[13px] font-black">A+</span></button>
                </>
            )}
            {one && (
                <>
                    <button type="button" className={icon} onClick={() => reorder('up')} title={tx('badges.ed.forward', 'Subir una capa')} aria-label={tx('badges.ed.forward', 'Subir una capa')}><i className="fa-solid fa-layer-group"></i><i className="fa-solid fa-arrow-up text-[8px] -ml-0.5"></i></button>
                    <button type="button" className={icon} onClick={() => reorder('down')} title={tx('badges.ed.backward', 'Bajar una capa')} aria-label={tx('badges.ed.backward', 'Bajar una capa')}><i className="fa-solid fa-layer-group"></i><i className="fa-solid fa-arrow-down text-[8px] -ml-0.5"></i></button>
                    <button type="button" className={one.locked ? iconOn : icon} onClick={() => update([one.id], (el) => ({ locked: !el.locked }))} title={tx('badges.ed.lock', 'Bloquear')} aria-label={tx('badges.ed.lock', 'Bloquear')} aria-pressed={!!one.locked}><i className={`fa-solid ${one.locked ? 'fa-lock' : 'fa-lock-open'}`}></i></button>
                </>
            )}
            <button type="button" className={icon} onClick={() => setSel([])} title={tx('badges.ed.deselect', 'Quitar la selección')} aria-label={tx('badges.ed.deselect', 'Quitar la selección')} data-ed-bar-close=""><i className="fa-solid fa-xmark"></i></button>
        </div>
    );

    const leftTabs: [string, string, string][] = [
        ['templates', 'fa-table-cells-large', tx('badges.ed.tab.templates', 'Plantillas')],
        ['text', 'fa-font', tx('badges.ed.tab.text', 'Texto')],
        ['elements', 'fa-shapes', tx('badges.ed.tab.elements', 'Formas')],
        ['images', 'fa-image', tx('badges.ed.tab.images', 'Imágenes')],
        ['background', 'fa-fill-drip', tx('badges.ed.tab.background', 'Fondo')],
    ];
    const tokens = Object.keys(tokenLabels || {});
    const narrow = mode === 'narrow';
    const sectionTitle = 'text-[10px] font-black uppercase tracking-widest text-gray-500';
    const tbtn = narrow ? 'w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-lg border-2 border-gray-100 bg-white text-gray-600 hover:border-blue-400 hover:text-blue-700 disabled:opacity-40' : icon;
    const tbtnOn = narrow ? 'w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-lg border-2 border-blue-500 bg-blue-50 text-blue-700' : iconOn;

    // ── the three areas ──
    const toolsPanel = (
        <div className={panel} style={area('tools')} data-ed-tools="">
            <div className="grid grid-cols-5 gap-1" role="tablist" aria-label={tx('badges.ed.tools', 'Herramientas')}>
                {leftTabs.map(([k, ic, name]) => (
                    <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k as any)} title={name} data-ed-tab={k}
                        className={`min-w-0 flex flex-col items-center gap-1 rounded-xl px-0.5 py-2 text-[9px] font-bold leading-tight tracking-tight ${tab === k ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'}`}>
                        <i className={`fa-solid ${ic} text-base`} aria-hidden="true"></i><span className="block w-full truncate text-center">{name}</span>
                    </button>
                ))}
            </div>
            {tab === 'templates' && (
                <div className="space-y-2" data-ed-templates="">
                    <p className="text-[11px] text-gray-500">{tx('badges.ed.templates.hint', 'Empieza con una plantilla y cámbiala a tu gusto.')}</p>
                    <div className="grid grid-cols-2 gap-2">
                        {thumbs.map(({ t, badge: b }) => (
                            <button key={t.id} type="button" disabled={!editable} onClick={() => applyTemplate(t)} className="group flex flex-col justify-between text-left rounded-xl border-2 border-gray-100 hover:border-blue-400 p-1.5 disabled:opacity-60" data-ed-template={t.id}>
                                <div className="flex-1 flex items-center justify-center">
                                    <div className={`${b.layout === 'vertical' || (b.layout === 'sticker' && b.h_mm > b.w_mm) ? 'w-[58%]' : 'w-full'} rounded overflow-hidden shadow ring-1 ring-black/5`}>
                                        <BadgeCard badge={b} images={{}} title={tx(`badges.ed.tpl.${t.id}`, t.name)} />
                                    </div>
                                </div>
                                <span className="block text-center text-[10px] font-bold text-gray-600 mt-1 truncate">{tx(`badges.ed.tpl.${t.id}`, t.name)}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {tab === 'text' && (
                <div className="space-y-3" data-ed-texts="">
                    <div className="grid gap-1.5">
                        <button type="button" disabled={!editable} onClick={() => addText('title')} className="text-left rounded-xl border-2 border-gray-100 hover:border-blue-400 px-3 py-2 text-lg font-black text-gray-900">{tx('badges.ed.text.title', 'Añadir un título')}</button>
                        <button type="button" disabled={!editable} onClick={() => addText('subtitle')} className="text-left rounded-xl border-2 border-gray-100 hover:border-blue-400 px-3 py-2 text-sm font-bold text-gray-800">{tx('badges.ed.text.subtitle', 'Añadir un subtítulo')}</button>
                        <button type="button" disabled={!editable} onClick={() => addText('body')} className="text-left rounded-xl border-2 border-gray-100 hover:border-blue-400 px-3 py-2 text-xs text-gray-700">{tx('badges.ed.text.body', 'Añadir un texto')}</button>
                    </div>
                    {tokenLabels && tokenLabels['@meal_group'] && (
                        <button type="button" disabled={!editable} onClick={addMealGroup} data-ed-meal-group=""
                            className="w-full text-left rounded-xl border-2 border-violet-100 bg-violet-50/60 hover:border-violet-400 px-3 py-2">
                            <span className="flex items-center gap-2 text-sm font-black text-violet-800"><span className="inline-flex w-7 h-7 shrink-0 items-center justify-center rounded-lg bg-violet-700 text-white text-base">C</span>{tx('badges.ed.meal', 'Grupo de comida (letra)')}</span>
                            <span className="block text-[11px] text-violet-700/80 mt-0.5">{tx('badges.ed.meal.hint', 'La letra del grupo (A–F) de cada persona, en grande. Si aún no tiene grupo, no se muestra nada.')}</span>
                        </button>
                    )}
                    <div>
                        <span className={sectionTitle}>{tx('badges.ed.data', 'Datos del inscrito')}</span>
                        <p className="text-[11px] text-gray-500 mb-1.5">{tx('badges.ed.data.hint', 'Cada escarapela muestra los de su persona.')}</p>
                        <div className="flex flex-wrap gap-1.5">
                            {tokens.map(k => (
                                <button key={k} type="button" disabled={!editable} onClick={() => addText('data', k)} data-ed-token={k}
                                    className="px-2.5 py-1.5 rounded-lg bg-violet-50 text-violet-700 border border-violet-100 hover:border-violet-400 text-[11px] font-bold">
                                    <i className="fa-solid fa-user-tag mr-1" aria-hidden="true"></i>{tokenLabels[k]}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
            {tab === 'elements' && (
                <div className="grid grid-cols-3 gap-1.5" data-ed-elements="">
                    {[['rect', 'fa-square', tx('badges.ed.el.rect', 'Rectángulo')], ['round', 'fa-square-full', tx('badges.ed.el.round', 'Redondeado')], ['ellipse', 'fa-circle', tx('badges.ed.el.ellipse', 'Círculo')],
                        ['pill', 'fa-capsules', tx('badges.ed.el.pill', 'Etiqueta')], ['band', 'fa-grip-lines', tx('badges.ed.el.band', 'Franja')], ['frame', 'fa-vector-square', tx('badges.ed.el.frame', 'Marco')],
                        ['line', 'fa-minus', tx('badges.ed.el.line', 'Línea')]].map(([k, ic, name]) => (
                        <button key={k} type="button" disabled={!editable} onClick={() => addShape(k)} data-ed-shape={k}
                            className="min-w-0 flex flex-col items-center gap-1 rounded-xl border-2 border-gray-100 hover:border-blue-400 py-2.5 px-1 text-[10px] font-bold text-gray-600">
                            <ShapeIcon kind={k} /><span className="block w-full truncate text-center">{name}</span>
                        </button>
                    ))}
                    <button type="button" onClick={() => {
                        const q = d.elements.find((e: any) => e.type === 'qr');
                        if (q) setSel([q.id]);
                        else if (editable) { const side = Math.max(14, Math.min(24, card.w - 6, card.h - 6)); add({ type: 'qr', x: r2((card.w - side) / 2), y: r2(card.h - side - 3), w: side, h: side, bg: !isSticker }); }
                    }} data-ed-qr="" className="min-w-0 flex flex-col items-center gap-1 rounded-xl border-2 border-gray-100 hover:border-blue-400 py-2.5 px-1 text-[10px] font-bold text-gray-600">
                        <i className="fa-solid fa-qrcode text-lg text-gray-700 h-6 flex items-center" aria-hidden="true"></i><span className="block w-full truncate text-center">{tx('badges.ed.el.qr', 'El QR')}</span>
                    </button>
                </div>
            )}
            {tab === 'images' && (
                <div className="space-y-2" data-ed-images="">
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files && e.target.files[0])} />
                    <button type="button" disabled={!editable || uploading} onClick={() => fileRef.current && fileRef.current.click()} className={`${ghost} w-full`} data-ed-upload="">
                        <i className={`fa-solid ${uploading ? 'fa-spinner animate-spin' : 'fa-upload'}`} aria-hidden="true"></i>{tx('badges.ed.upload', 'Subir una imagen')}
                    </button>
                    <p className="text-[11px] text-gray-500">{tx('badges.ed.upload.hint', 'Logos (PNG con transparencia), fotos o fondos. Se guardan en la galería de esta conferencia.')}</p>
                    {!(images || []).length && <p className="text-[11px] text-gray-400 italic">{tx('badges.ed.gallery.empty', 'Aún no hay imágenes en la galería.')}</p>}
                    <div className="grid grid-cols-3 gap-1.5">
                        {(images || []).map((img: any) => (
                            <div key={img.id} className="rounded-xl border-2 border-gray-100 overflow-hidden" data-ed-image={img.id}>
                                <button type="button" disabled={!editable} onClick={() => addImage(img)} className="block w-full aspect-square bg-[repeating-conic-gradient(#f3f4f6_0_25%,#fff_0_50%)] bg-[length:10px_10px]" title={tx('badges.ed.image.add', 'Añadir al diseño')} aria-label={tx('badges.ed.image.add', 'Añadir al diseño')}>
                                    <img src={img.url} alt="" className="w-full h-full object-contain" />
                                </button>
                                {editable && (
                                    <div className="flex border-t border-gray-100">
                                        <button type="button" onClick={() => asBackground(img)} className="flex-1 h-7 text-gray-600 hover:bg-gray-50 text-[11px]" title={tx('badges.ed.image.bg', 'Usar como fondo')} aria-label={tx('badges.ed.image.bg', 'Usar como fondo')}><i className="fa-solid fa-expand"></i></button>
                                        <button type="button" onClick={() => dropFromGallery(img)} className="flex-1 h-7 text-rose-600 hover:bg-rose-50 text-[11px] border-l border-gray-100" title={tx('badges.ed.image.drop', 'Borrar de la galería')} aria-label={tx('badges.ed.image.drop', 'Borrar de la galería')}><i className="fa-solid fa-trash-can"></i></button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {tab === 'background' && (
                <div className="space-y-3" data-ed-background="">
                    <ColorRow editable={editable} tx={tx} big={narrow} title={tx('badges.ed.bg.color', 'Color de fondo')} value={d.background} onPick={(c: string) => commit({ ...d, background: c || '#ffffff' }, sel)} />
                    <p className="text-[11px] text-gray-500">{tx('badges.ed.bg.hint', 'Para una imagen de fondo: súbela en «Imágenes» y toca «Usar como fondo».')}</p>
                </div>
            )}
        </div>
    );

    const canvasArea = (
        <div className="space-y-2 min-w-0" style={area('canvas')}>
            <div className="flex flex-nowrap items-center gap-1 sm:gap-1.5" data-ed-toolbar="">
                <button type="button" className={tbtn} disabled={!editable || !past.current.length} onClick={undo} title={tx('badges.ed.undo', 'Deshacer (Ctrl+Z)')} aria-label={tx('badges.ed.undo', 'Deshacer (Ctrl+Z)')} data-ed-undo=""><i className="fa-solid fa-rotate-left"></i></button>
                <button type="button" className={tbtn} disabled={!editable || !future.current.length} onClick={redo} title={tx('badges.ed.redo', 'Rehacer (Ctrl+Y)')} aria-label={tx('badges.ed.redo', 'Rehacer (Ctrl+Y)')} data-ed-redo=""><i className="fa-solid fa-rotate-right"></i></button>
                <span className="w-px h-6 bg-gray-200 mx-0.5" aria-hidden="true"></span>
                {isSticker ? (
                    <>
                        <Select className="h-9 min-w-[8.5rem] shrink-0 rounded-xl border-2 border-gray-100 bg-white px-2 text-[11px] font-bold text-gray-700" disabled={!editable}
                            aria-label={tx('badges.sticker.size', 'Tamaño de la etiqueta')} title={tx('badges.sticker.size', 'Tamaño de la etiqueta')} data-ed-sticker-size=""
                            value={customSize ? 'custom' : (presetOf(card) || { id: 'custom' }).id}
                            onChange={(e) => {
                                const p = STICKER_PRESETS.find(x => x.id === e.target.value);
                                if (p) { setCustomSize(null); setStickerSize(card.h > card.w && p.w > p.h ? { w: p.w, h: p.h } : p.w < p.h === card.w < card.h ? { w: p.w, h: p.h } : { w: p.h, h: p.w }); }
                                else setCustomSize({ w: String(card.w), h: String(card.h) });
                            }}>
                            {STICKER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            <option value="custom">{tx('badges.sticker.custom', 'Personalizado (mm)')}</option>
                        </Select>
                        <button type="button" className={tbtn} disabled={!editable} onClick={() => setStickerSize({ w: card.h, h: card.w })} title={tx('badges.sticker.turn', 'Girar la etiqueta')} aria-label={tx('badges.sticker.turn', 'Girar la etiqueta')} data-ed-sticker-turn=""><i className="fa-solid fa-arrows-rotate"></i></button>
                    </>
                ) : (
                    <>
                        <button type="button" className={d.layout === 'horizontal' ? tbtnOn : tbtn} disabled={!editable} onClick={() => setOrientation('horizontal')} title={tx('badges.layout.h', 'Horizontal')} aria-label={tx('badges.layout.h', 'Horizontal')} aria-pressed={d.layout === 'horizontal'}><i className="fa-solid fa-id-card"></i></button>
                        <button type="button" className={d.layout === 'vertical' ? tbtnOn : tbtn} disabled={!editable} onClick={() => setOrientation('vertical')} title={tx('badges.layout.v', 'Vertical')} aria-label={tx('badges.layout.v', 'Vertical')} aria-pressed={d.layout === 'vertical'}><i className="fa-solid fa-id-badge"></i></button>
                    </>
                )}
                <span className="w-px h-6 bg-gray-200 mx-0.5" aria-hidden="true"></span>
                <button type="button" className={tbtn} onClick={() => setZoom(z => Math.max(0.5, r2(z - 0.25)))} title={tx('badges.ed.zoomout', 'Alejar')} aria-label={tx('badges.ed.zoomout', 'Alejar')}><i className="fa-solid fa-magnifying-glass-minus"></i></button>
                {!narrow && <button type="button" className="h-9 px-2 rounded-xl shrink-0 border-2 border-gray-100 bg-white text-[10px] font-black text-gray-600" onClick={() => setZoom(1)} title={tx('badges.ed.zoomfit', 'Ajustar')}>{Math.round(zoom * 100)}%</button>}
                {isSticker && (
                    // About the label's real size on a 96 dpi screen (1 mm ≈ 3.78 px): how it will look in the hand.
                    <button type="button" className={tbtn} onClick={() => setZoom(r2((96 / 25.4) / Math.max(0.01, fitScale)))} title={tx('badges.sticker.real', 'Tamaño real')} aria-label={tx('badges.sticker.real', 'Tamaño real')} data-ed-real-size="">1:1</button>
                )}
                <button type="button" className={tbtn} onClick={() => setZoom(z => Math.min(3, r2(z + 0.25)))} title={tx('badges.ed.zoomin', 'Acercar')} aria-label={tx('badges.ed.zoomin', 'Acercar')}><i className="fa-solid fa-magnifying-glass-plus"></i></button>
                <button type="button" className={showData ? tbtnOn : tbtn} onClick={() => setShowData(v => !v)} aria-pressed={showData} data-ed-sample=""
                    title={showData ? tx('badges.ed.sample.on', 'Mostrando una persona de muestra (toca para ver los campos)') : tx('badges.ed.sample.off', 'Mostrando los campos (toca para ver una persona de muestra)')}
                    aria-label={tx('badges.ed.sample', 'Datos de muestra')}><i className={`fa-solid ${showData ? 'fa-user' : 'fa-tags'}`}></i></button>
                {onSave && (
                    <button type="button" onClick={onSave} disabled={!canManage || saving || !dirty} data-ed-save=""
                        className={`ml-auto shrink-0 ${narrow ? 'h-8 px-2.5 rounded-lg' : 'h-9 px-3 rounded-xl'} inline-flex items-center gap-1.5 font-black text-[10px] uppercase tracking-widest ${dirty ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400'}`}>
                        <i className={`fa-solid ${saving ? 'fa-spinner animate-spin' : dirty ? 'fa-floppy-disk' : 'fa-check'}`} aria-hidden="true"></i>
                        <span className={narrow ? 'sr-only' : ''}>{dirty ? tx('badges.save', 'Guardar diseño') : tx('badges.ed.saved', 'Guardado')}</span>
                    </button>
                )}
            </div>
            {isSticker && customSize && (
                <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-gray-100 bg-white px-3 py-2" data-ed-sticker-custom="">
                    {(['w', 'h'] as const).map(k => (
                        <label key={k} className="text-[10px] font-bold text-gray-600">
                            {k === 'w' ? tx('badges.sticker.width', 'Ancho (mm)') : tx('badges.sticker.height', 'Alto (mm)')}
                            <input type="number" inputMode="decimal" min={STICKER_MM.min} max={STICKER_MM.max} step="0.1" className="block w-24 h-8 rounded-lg border-2 border-gray-100 px-2 text-sm"
                                value={customSize[k]} onChange={(e) => setCustomSize({ ...customSize, [k]: e.target.value })} disabled={!editable} />
                        </label>
                    ))}
                    <button type="button" className="h-8 px-3 rounded-lg bg-gray-900 text-white text-[10px] font-black uppercase tracking-widest disabled:opacity-50" disabled={!editable}
                        onClick={() => { setStickerSize({ w: Number(customSize.w), h: Number(customSize.h) }); setCustomSize(null); }}>{tx('badges.sticker.apply', 'Aplicar')}</button>
                    <span className="text-[10px] text-gray-400">{tx('badges.sticker.range', 'Entre {min} y {max} mm.').replace('{min}', String(STICKER_MM.min)).replace('{max}', String(STICKER_MM.max))}</span>
                </div>
            )}
            {actionBar}
            <div ref={wrapRef} className="relative rounded-3xl bg-[radial-gradient(circle,#e5e7eb_1px,transparent_1px)] bg-[length:16px_16px] bg-gray-50 border border-gray-100 overflow-auto"
                onPointerDown={() => setSel([])} data-ed-canvas="">
                <div className="relative mx-auto my-[26px]" style={{ width: card.w * s, height: card.h * s }}>
                    <div className="absolute inset-0 shadow-xl ring-1 ring-black/10 rounded-[4px] overflow-hidden bg-white">
                        <BadgeCard badge={badge} images={imageUrls} title={tx('badges.preview', 'Vista previa')} />
                    </div>
                    <svg ref={overlayRef} className="absolute" style={{ left: -M * s, top: -M * s, width: (card.w + 2 * M) * s, height: (card.h + 2 * M) * s, touchAction: 'none', overflow: 'visible' }}
                        viewBox={`${-M} ${-M} ${card.w + 2 * M} ${card.h + 2 * M}`} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} data-ed-overlay="">
                        {d.elements.map((el: any) => {
                            const pad = el.type === 'line' ? Math.max(0, 3 / s - el.h / 2) : 0;
                            return (
                                <g key={el.id} transform={el.rot ? `rotate(${el.rot} ${el.x + el.w / 2} ${el.y + el.h / 2})` : undefined}>
                                    <rect x={el.x} y={el.y - pad} width={el.w} height={el.h + 2 * pad} fill="transparent" pointerEvents="all"
                                        style={{ cursor: editable && !el.locked ? 'move' : 'pointer' }} onPointerDown={(ev) => onElementDown(ev, el)} data-ed-el={el.id} />
                                </g>
                            );
                        })}
                        {guides.v.map((x, i) => <line key={`v${i}`} x1={x} y1={-M} x2={x} y2={card.h + M} stroke="#ec4899" strokeWidth={1 / s} strokeDasharray={`${4 / s} ${3 / s}`} pointerEvents="none" />)}
                        {guides.h.map((y, i) => <line key={`h${i}`} x1={-M} y1={y} x2={card.w + M} y2={y} stroke="#ec4899" strokeWidth={1 / s} strokeDasharray={`${4 / s} ${3 / s}`} pointerEvents="none" />)}
                        {selected.map((el: any) => <React.Fragment key={`s${el.id}`}>{selected.length === 1 ? handles(el) : (
                            <rect x={bounds(el).x} y={bounds(el).y} width={bounds(el).w} height={bounds(el).h} fill="none" stroke="#2563eb" strokeWidth={1.5 / s} pointerEvents="none" />
                        )}</React.Fragment>)}
                    </svg>
                </div>
                <p className="text-center text-[10px] text-gray-400 pb-2.5 px-3">
                    {`${String(card.w).replace('.', ',')} × ${String(card.h).replace('.', ',')} mm`} · {narrow
                        ? tx('badges.ed.canvas.hint.touch', 'Toca para elegir · arrastra para mover · esquinas: tamaño · círculo: girar')
                        : tx('badges.ed.canvas.hint', 'Arrastra para mover · esquinas para el tamaño · círculo para girar · Shift: mantener proporción')}
                </p>
            </div>
        </div>
    );

    const textEditor = one && one.type === 'text' ? (
        <div className="space-y-3">
            <div>
                <label className={lbl} htmlFor="ed-text">{tx('badges.ed.text', 'Texto')}</label>
                <textarea id="ed-text" ref={textRef} className={`${inp} min-h-[64px] font-medium`} value={friendly(one.text)} maxLength={400} disabled={!editable}
                    onChange={(e) => update([one.id], () => ({ text: unfriendly(e.target.value) }))} data-ed-textarea="" />
                <span className="block text-[10px] text-gray-500 mt-1">{tx('badges.ed.insert', 'Insertar un dato del inscrito:')}</span>
                <div className="flex flex-wrap gap-1 mt-1">
                    {tokens.map(k => (
                        <button key={k} type="button" disabled={!editable} onClick={() => update([one.id], (el) => ({ text: `${el.text}${el.text && !/\s$/.test(el.text) ? ' ' : ''}{{${k}}}` }))}
                            className="px-2 py-1 rounded-md bg-violet-50 text-violet-700 border border-violet-100 text-[10px] font-bold">+ {tokenLabels[k]}</button>
                    ))}
                </div>
            </div>
            <div className="relative">
                <span className={lbl}>{tx('badges.ed.font', 'Fuente')}</span>
                <button type="button" disabled={!editable} className={`${inp} text-left flex items-center justify-between`} onClick={() => setFontMenu(v => !v)} data-ed-font="" style={{ fontFamily: familyCss(one.font) }}>
                    <span className="truncate text-sm">{(FONTS.find(f => f.id === one.font) || FONTS[0]).label}</span><i className="fa-solid fa-chevron-down text-[10px] text-gray-400"></i>
                </button>
                {fontMenu && (
                    <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl p-1" role="listbox" data-ed-fontmenu="">
                        {FONTS.map(f => (
                            <button key={f.id} type="button" role="option" aria-selected={one.font === f.id} onClick={() => { update([one.id], () => ({ font: f.id })); setFontMenu(false); }}
                                className={`w-full text-left px-2.5 py-2 rounded-lg text-base ${one.font === f.id ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 text-gray-800'}`} style={{ fontFamily: familyCss(f.id) }}>{f.label}</button>
                        ))}
                    </div>
                )}
            </div>
            <div className="flex items-end gap-2">
                <div className="flex-1 min-w-0"><Num editable={editable} label={tx('badges.ed.size', 'Tamaño')} value={one.size} step={0.5} min={3} max={120} suffix="pt" onSet={(v: number) => update([one.id], () => ({ size: v }))} /></div>
                <button type="button" className={one.bold ? iconOn : icon} disabled={!editable} onClick={() => update([one.id], (el) => ({ bold: !el.bold }))} title={tx('badges.ed.bold', 'Negrita')} aria-label={tx('badges.ed.bold', 'Negrita')} aria-pressed={!!one.bold}><i className="fa-solid fa-bold"></i></button>
                <button type="button" className={one.upper ? iconOn : icon} disabled={!editable} onClick={() => update([one.id], (el) => ({ upper: !el.upper }))} title={tx('badges.ed.upper', 'Mayúsculas')} aria-label={tx('badges.ed.upper', 'Mayúsculas')} aria-pressed={!!one.upper}><span className="text-[11px] font-black">AA</span></button>
            </div>
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <span className={lbl}>{tx('badges.ed.talign', 'Alineación')}</span>
                    <div className="flex gap-1">
                        {[['left', 'fa-align-left'], ['center', 'fa-align-center'], ['right', 'fa-align-right']].map(([a, ic]) => (
                            <button key={a} type="button" className={one.align === a ? iconOn : icon} disabled={!editable} onClick={() => update([one.id], () => ({ align: a }))} title={tx(`badges.ed.talign.${a}`, a)} aria-label={tx(`badges.ed.talign.${a}`, a)} aria-pressed={one.align === a}><i className={`fa-solid ${ic}`}></i></button>
                        ))}
                    </div>
                </div>
                <div>
                    <span className={lbl}>{tx('badges.ed.valign', 'En su caja')}</span>
                    <div className="flex gap-1">
                        {[['top', 'arriba'], ['middle', 'medio'], ['bottom', 'abajo']].map(([a]) => (
                            <button key={a} type="button" className={one.valign === a ? iconOn : icon} disabled={!editable} onClick={() => update([one.id], () => ({ valign: a }))} title={tx(`badges.ed.valign.${a}`, a)} aria-label={tx(`badges.ed.valign.${a}`, a)} aria-pressed={one.valign === a}><VAlignIcon at={a} /></button>
                        ))}
                    </div>
                </div>
            </div>
            <ColorRow editable={editable} tx={tx} big={narrow} title={tx('badges.ed.color', 'Color')} value={one.color} onPick={(c: string) => update([one.id], () => ({ color: c || '#111827' }))} />
            <details className="group rounded-xl border border-gray-100 px-3 py-2">
                <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-gray-500 list-none flex items-center justify-between">{tx('badges.ed.more', 'Más opciones de texto')}<i className="fa-solid fa-chevron-down text-[9px] group-open:rotate-180 transition-transform"></i></summary>
                <div className="grid grid-cols-2 gap-2 mt-2">
                    <Num editable={editable} label={tx('badges.ed.ls', 'Espaciado')} value={one.ls} step={0.1} min={-3} max={30} suffix="pt" onSet={(v: number) => update([one.id], () => ({ ls: v }))} />
                    <Num editable={editable} label={tx('badges.ed.lh', 'Interlineado')} value={one.lh} step={0.05} min={0.7} max={3} onSet={(v: number) => update([one.id], () => ({ lh: v }))} />
                </div>
                <label className="flex items-center gap-2 mt-2 text-[11px] font-bold text-gray-600">
                    <input type="checkbox" className="w-4 h-4" checked={one.fit === 'shrink'} disabled={!editable} onChange={(e) => update([one.id], () => ({ fit: e.target.checked ? 'shrink' : 'none' }))} />
                    {tx('badges.ed.fit', 'Achicar si no cabe')}
                </label>
            </details>
        </div>
    ) : null;

    const propsPanel = (
        <div className="space-y-4" style={area('props')} data-ed-props="">
            {selected.length > 0 && (
                <div className={panel}>
                    {one && (
                        <div className="flex items-center gap-2 pb-1 border-b border-gray-100" data-ed-selected={one.type}>
                            <i className={`fa-solid ${iconOf(one)} text-gray-400`} aria-hidden="true"></i>
                            <span className="flex-1 min-w-0 truncate text-sm font-black text-gray-900">{nameOf(one)}</span>
                            <button type="button" className={icon} onClick={() => setSel([])} title={tx('badges.ed.deselect', 'Quitar la selección')} aria-label={tx('badges.ed.deselect', 'Quitar la selección')}><i className="fa-solid fa-xmark"></i></button>
                        </div>
                    )}
                    {selected.length > 1 && <p className="text-xs font-bold text-gray-700">{tx('badges.ed.multi', '{n} elementos seleccionados').replace('{n}', String(selected.length))}</p>}
                    {textEditor}
                    {one && one.type === 'shape' && (
                        <>
                            <ColorRow editable={editable} tx={tx} big={narrow} title={tx('badges.ed.fill', 'Relleno')} value={one.fill} allowNone onPick={(c: string) => update([one.id], () => ({ fill: c }))} />
                            <ColorRow editable={editable} tx={tx} big={narrow} title={tx('badges.ed.stroke', 'Borde')} value={one.stroke} allowNone onPick={(c: string) => update([one.id], (el) => ({ stroke: c, sw: c && !el.sw ? 0.4 : el.sw }))} />
                            <div className="grid grid-cols-2 gap-2">
                                <Num editable={editable} label={tx('badges.ed.sw', 'Grosor del borde')} value={one.sw} step={0.1} min={0} max={10} suffix="mm" onSet={(v: number) => update([one.id], () => ({ sw: v }))} />
                                {one.shape === 'rect' && <Num editable={editable} label={tx('badges.ed.radius', 'Esquinas')} value={one.r} step={0.5} min={0} max={50} suffix="mm" onSet={(v: number) => update([one.id], () => ({ r: v }))} />}
                            </div>
                        </>
                    )}
                    {one && one.type === 'line' && (
                        <>
                            <ColorRow editable={editable} tx={tx} big={narrow} title={tx('badges.ed.color', 'Color')} value={one.stroke} onPick={(c: string) => update([one.id], () => ({ stroke: c || '#111827' }))} />
                            <Num editable={editable} label={tx('badges.ed.sw.line', 'Grosor')} value={one.sw} step={0.1} min={0.05} max={10} suffix="mm" onSet={(v: number) => update([one.id], () => ({ sw: v }))} />
                        </>
                    )}
                    {one && one.type === 'image' && (
                        <>
                            <div>
                                <span className={lbl}>{tx('badges.ed.imgfit', 'Ajuste')}</span>
                                <div className="flex gap-1">
                                    {[['cover', tx('badges.ed.imgfit.cover', 'Llenar')], ['contain', tx('badges.ed.imgfit.contain', 'Completa')], ['fill', tx('badges.ed.imgfit.fill', 'Estirar')]].map(([k, name]) => (
                                        <button key={k} type="button" disabled={!editable} onClick={() => update([one.id], () => ({ fit: k }))} className={`flex-1 ${btn} ${one.fit === k ? 'bg-blue-50 text-blue-700 border-2 border-blue-500' : 'bg-white border-2 border-gray-100 text-gray-600'}`}>{name}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 items-end">
                                <Num editable={editable} label={tx('badges.ed.radius', 'Esquinas')} value={one.r} step={0.5} min={0} max={50} suffix="mm" onSet={(v: number) => update([one.id], () => ({ r: v, mask: 'none' }))} />
                                <label className="flex items-center gap-2 pb-1.5 text-[11px] font-bold text-gray-600">
                                    <input type="checkbox" className="w-4 h-4" checked={one.mask === 'circle'} disabled={!editable} onChange={(e) => update([one.id], () => ({ mask: e.target.checked ? 'circle' : 'none' }))} />
                                    {tx('badges.ed.circle', 'Recorte circular')}
                                </label>
                            </div>
                        </>
                    )}
                    {one && one.type === 'qr' && (
                        <>
                            <p className="text-[11px] text-gray-600">{isSticker ? tx('badges.sticker.qr.hint', 'El QR de la persona, el mismo que lee el escáner de comidas. En una etiqueta pequeña puedes quitarlo. Mínimo 14 mm de lado.') : tx('badges.ed.qr.hint', 'El QR lleva a «Mi inscripción» y es lo que lee el escáner de comidas: siempre está. Mínimo 14 mm de lado.')}</p>
                            <label className="flex items-center gap-2 text-[11px] font-bold text-gray-700">
                                <input type="checkbox" className="w-4 h-4" checked={one.bg !== false} disabled={!editable} onChange={(e) => update([one.id], () => ({ bg: e.target.checked }))} />
                                {tx('badges.ed.qr.bg', 'Fondo blanco detrás (recomendado)')}
                            </label>
                        </>
                    )}
                    {/* Where it sits: on the card (or against each other) and to the tenth of a millimetre. */}
                    <details className="group rounded-xl border border-gray-100 px-3 py-2" open={!narrow && one && one.type !== 'text'} data-ed-position="">
                        <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-gray-500 list-none flex items-center justify-between">{tx('badges.ed.position', 'Posición y tamaño')}<i className="fa-solid fa-chevron-down text-[9px] group-open:rotate-180 transition-transform"></i></summary>
                        <div className="space-y-2 mt-2">
                            <span className={lbl}>{selected.length > 1 ? tx('badges.ed.align.group', 'Alinear entre sí') : tx('badges.ed.align.card', 'Alinear en la escarapela')}</span>
                            <div className="flex flex-wrap gap-1">
                                {[['left', 'fa-align-left'], ['hcenter', 'fa-align-center'], ['right', 'fa-align-right'], ['top', null], ['vcenter', null], ['bottom', null]].map(([k, ic]) => (
                                    <button key={k} type="button" className={icon} disabled={!editable} onClick={() => align(k)} title={tx(`badges.ed.align.${k}`, k)} aria-label={tx(`badges.ed.align.${k}`, k)} data-ed-align={k}>
                                        {ic ? <i className={`fa-solid ${ic}`}></i> : <VAlignIcon at={k === 'top' ? 'top' : k === 'vcenter' ? 'middle' : 'bottom'} />}
                                    </button>
                                ))}
                            </div>
                            {one && (
                                <div className="grid grid-cols-3 gap-1.5">
                                    <Num editable={editable} label="X" value={one.x} step={0.5} suffix="" onSet={(v: number) => update([one.id], () => ({ x: v }))} />
                                    <Num editable={editable} label="Y" value={one.y} step={0.5} suffix="" onSet={(v: number) => update([one.id], () => ({ y: v }))} />
                                    <Num editable={editable} label={tx('badges.ed.rot', 'Giro')} value={one.rot} step={1} suffix="°" onSet={(v: number) => update([one.id], () => ({ rot: ((v % 360) + 360) % 360 }))} />
                                    <Num editable={editable} label={tx('badges.ed.w', 'Ancho')} value={one.w} step={0.5} min={1} suffix="" onSet={(v: number) => update([one.id], (el) => (el.type === 'qr' ? { w: v, h: v } : { w: v }))} />
                                    {one.type !== 'line' && <Num editable={editable} label={tx('badges.ed.h', 'Alto')} value={one.h} step={0.5} min={0.2} suffix="" onSet={(v: number) => update([one.id], (el) => (el.type === 'qr' ? { w: v, h: v } : { h: v }))} />}
                                </div>
                            )}
                            {one && (
                                <label className="block">
                                    <span className={lbl}>{tx('badges.ed.op', 'Transparencia')} · {Math.round((one.op ?? 1) * 100)}%</span>
                                    <input type="range" min={0.05} max={1} step={0.05} value={one.op ?? 1} disabled={!editable} className="w-full" onChange={(e) => update([one.id], () => ({ op: Number(e.target.value) }))} />
                                </label>
                            )}
                        </div>
                    </details>
                </div>
            )}
            <details className={`${panel} group`} open={!narrow} data-ed-layers="">
                <summary className="cursor-pointer list-none flex items-center justify-between"><span className={sectionTitle}>{tx('badges.ed.layers', 'Capas')} · {d.elements.length}</span><i className="fa-solid fa-chevron-down text-[9px] text-gray-400 group-open:rotate-180 transition-transform"></i></summary>
                <ul className="space-y-1 max-h-72 overflow-y-auto mt-2">
                    {d.elements.slice().reverse().map((e: any) => (
                        <li key={e.id}>
                            <button type="button" onClick={(ev) => setSel(ev.shiftKey ? (sel.includes(e.id) ? sel.filter(x => x !== e.id) : [...sel, e.id]) : [e.id])} data-ed-layer={e.id}
                                className={`w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px] font-bold ${sel.includes(e.id) ? 'bg-blue-50 text-blue-800' : 'text-gray-700 hover:bg-gray-50'}`}>
                                <i className={`fa-solid ${iconOf(e)} w-4 text-center text-gray-400`} aria-hidden="true"></i>
                                <span className="flex-1 min-w-0 truncate">{nameOf(e)}</span>
                                {e.locked && <i className="fa-solid fa-lock text-[9px] text-gray-400" aria-hidden="true"></i>}
                            </button>
                        </li>
                    ))}
                </ul>
            </details>
        </div>
    );

    return (
        <div ref={rootRef} className="grid gap-4 items-start" style={{ gridTemplateColumns: columns }} data-badge-editor="" data-ed-mode={mode}>
            {toolsPanel}
            {canvasArea}
            {propsPanel}
        </div>
    );
}

/** A small drawing of each shape for the «Elementos» buttons (an icon font has no rounded square, tag or frame). */
function ShapeIcon({ kind }: { kind: string }) {
    const c = 'currentColor';
    return (
        <svg width="26" height="24" viewBox="0 0 26 24" aria-hidden="true" className="text-gray-700">
            {kind === 'rect' && <rect x="3" y="5" width="20" height="14" fill={c} />}
            {kind === 'round' && <rect x="3" y="5" width="20" height="14" rx="4" fill={c} />}
            {kind === 'ellipse' && <circle cx="13" cy="12" r="8" fill={c} />}
            {kind === 'pill' && <rect x="2" y="8" width="22" height="8" rx="4" fill={c} />}
            {kind === 'band' && <rect x="1" y="4" width="24" height="6" fill={c} />}
            {kind === 'frame' && <rect x="3.5" y="4.5" width="19" height="15" rx="2" fill="none" stroke={c} strokeWidth="2" />}
            {kind === 'line' && <line x1="3" y1="12" x2="23" y2="12" stroke={c} strokeWidth="2.5" strokeLinecap="round" />}
        </svg>
    );
}
/** Where a text sits in its box (top / middle / bottom): a box with a bar. */
function VAlignIcon({ at }: { at: string }) {
    const y = at === 'top' ? 4 : at === 'middle' ? 8.5 : 13;
    return (
        <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
            <rect x="1" y="1" width="14" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <rect x="4" y={y} width="8" height="2" rx="1" fill="currentColor" />
        </svg>
    );
}
