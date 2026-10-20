/**
 * The free-form badge design (conference-manager 2.29.0) — the «Canva» designer's model and its layout,
 * shared by the server (preview, credential page, PDF) and the browser (the designer draws while you drag).
 *
 * MODEL. { version: 2, layout: 'horizontal' | 'vertical', background: '#rrggbb', elements: [...] } on a CR80
 * card (85.6 × 54 mm, or 54 × 85.6). Elements are in millimetres from the card's top-left corner, drawn in
 * array order (the last on top), each with x, y, w, h, rot (degrees, about its centre) and op (opacity 0..1):
 *   text   { text, font, bold, size (pt), color, align, valign, upper, ls (pt), lh, fit }
 *          `text` may hold DATA TOKENS — {{@name}}, {{@code}}, {{@location}}, {{@room}}, {{@dates}},
 *          {{@conference}} or a form field {{<column>}} — replaced by the person's values. A text whose tokens
 *          are all empty is not drawn («Habitación: {{@room}}» disappears for someone without a room).
 *          fit 'shrink' lowers the size (down to 40 %) until the text fits its box; 'none' keeps it and cuts.
 *   shape  { shape: 'rect' | 'ellipse', fill, stroke, sw (mm), r (corner radius, mm) }
 *   line   { stroke, sw } — along the box's horizontal middle (rotate it for any angle)
 *   image  { asset (sha of an uploaded image), fit: 'cover' | 'contain' | 'fill', r, mask: 'none' | 'circle' }
 *   qr     { bg (a white rounded panel behind) } — square; ALWAYS exactly one: it is what the meal scanner reads
 *          (the «Mi inscripción» link with the code, or the bare code).
 *
 * DISPLAY LIST. layoutDesign() turns a design + one person's data into the items the three renderers draw as
 * they are (rect / ellipse / line / image / text / qr, all in mm, each with its own rotation and opacity),
 * with every text already measured, wrapped, shrunk and placed — so the PDF, the page and the designer agree.
 */
'use strict';

const { printable } = require('./badge-text');
const { encodeQr, qrRows } = require('./badge-qr');
const { familyOf, faceOf } = require('./badge-font');

const CARD = { w: 85.6, h: 54 };
const LAYOUTS = ['horizontal', 'vertical'];
const TYPES = new Set(['text', 'shape', 'line', 'image', 'qr']);
const MAX_ELEMENTS = 60;
const MAX_TEXT = 400;
const HEX = /^#[0-9a-f]{6}$/i;
const SHA = /^[0-9a-f]{16,64}$/;
const ID = /^[A-Za-z0-9_-]{1,24}$/;
const TOKEN = /\{\{\s*(@?[A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;
const PT_MM = 25.4 / 72;
const QR_QUIET = 2;

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const num = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const color = (v, d) => {
    if (typeof v !== 'string') return d;
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return HEX.test(v) ? v.toLowerCase() : d;
};
const colorOrNull = (v) => (v === null || v === '' || v === 'none' ? null : color(v, null));
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
const cardOf = (layout) => (layout === 'vertical' ? { w: CARD.h, h: CARD.w } : { w: CARD.w, h: CARD.h });

/** The data keys a design's texts use (without the braces). */
function tokensOf(text) {
    const out = [];
    String(text || '').replace(TOKEN, (_, k) => { out.push(k); return ''; });
    return out;
}

/**
 * A design as stored: unknown keys dropped, every value bounded, exactly one QR. `opts.known` (Set of data keys)
 * leaves tokens of unknown keys as plain text; `opts.assets` (Set of image shas) drops images that do not exist.
 * null opts = keep what is there (reading a stored design).
 */
function normalizeDesignV2(src, opts = {}) {
    const d = src && typeof src === 'object' ? src : {};
    const layout = pick(d.layout, LAYOUTS, 'horizontal');
    const card = cardOf(layout);
    const elements = [];
    const ids = new Set();
    let qrSeen = false;
    for (const raw of Array.isArray(d.elements) ? d.elements : []) {
        if (elements.length >= MAX_ELEMENTS) break;
        if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) continue;
        if (raw.type === 'qr' && qrSeen) continue;
        let id = typeof raw.id === 'string' && ID.test(raw.id) && !ids.has(raw.id) ? raw.id : null;
        if (!id) { let k = elements.length + 1; while (ids.has(`e${k}`)) k++; id = `e${k}`; }
        ids.add(id);
        const base = {
            id, type: raw.type,
            x: r2(num(raw.x, -card.w, 2 * card.w, 0)), y: r2(num(raw.y, -card.h, 2 * card.h, 0)),
            w: r2(num(raw.w, 1, 3 * card.w, 20)), h: r2(num(raw.h, 0.2, 3 * card.h, 10)),
            rot: r2(((num(raw.rot, -360, 360, 0) % 360) + 360) % 360),
            op: r2(num(raw.op, 0, 1, 1)),
        };
        if (raw.name && typeof raw.name === 'string') base.name = String(raw.name).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
        if (raw.locked) base.locked = true;
        let el = null;
        if (raw.type === 'text') {
            const text = String(raw.text == null ? '' : raw.text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT);
            el = {
                ...base, text,
                font: familyOf(raw.font), bold: !!raw.bold,
                size: r2(num(raw.size, 3, 120, 10)),
                color: color(raw.color, '#111827'),
                align: pick(raw.align, ['left', 'center', 'right'], 'left'),
                valign: pick(raw.valign, ['top', 'middle', 'bottom'], 'top'),
                upper: !!raw.upper,
                ls: r2(num(raw.ls, -3, 30, 0)),
                lh: r2(num(raw.lh, 0.7, 3, 1.15)),
                fit: pick(raw.fit, ['shrink', 'none'], 'shrink'),
            };
        } else if (raw.type === 'shape') {
            el = {
                ...base, shape: pick(raw.shape, ['rect', 'ellipse'], 'rect'),
                fill: raw.fill === undefined ? '#1e3a8a' : colorOrNull(raw.fill), stroke: colorOrNull(raw.stroke),
                sw: r2(num(raw.sw, 0, 10, 0)), r: r2(num(raw.r, 0, 50, 0)),
            };
        } else if (raw.type === 'line') {
            el = { ...base, stroke: color(raw.stroke, '#111827'), sw: r2(num(raw.sw, 0.05, 10, 0.5)) };
        } else if (raw.type === 'image') {
            const asset = typeof raw.asset === 'string' && SHA.test(raw.asset) ? raw.asset : null;
            if (!asset || (opts.assets && !opts.assets.has(asset))) continue;
            el = { ...base, asset, fit: pick(raw.fit, ['cover', 'contain', 'fill'], 'cover'), r: r2(num(raw.r, 0, 50, 0)), mask: pick(raw.mask, ['none', 'circle'], 'none') };
        } else if (raw.type === 'qr') {
            qrSeen = true;
            const side = r2(num(raw.w, 14, Math.min(card.w, card.h), 22));
            el = { ...base, w: side, h: side, bg: raw.bg !== false };
        }
        if (el) elements.push(el);
    }
    if (!qrSeen) {
        const side = 22;
        elements.push({ id: ids.has('qr') ? `qr${elements.length}` : 'qr', type: 'qr', x: r2(card.w - side - 3.5), y: r2(card.h - side - 3.5), w: side, h: side, rot: 0, op: 1, bg: true });
    }
    return { version: 2, layout, background: color(d.background, '#ffffff'), elements };
}

// ── layout ───────────────────────────────────────────────────────────────────────────────────────
/** Resolve a text's tokens with `data` (key → string). null = it has tokens and none has a value (not drawn). */
function resolveText(text, data) {
    const keys = tokensOf(text);
    let any = false;
    const out = String(text || '').replace(TOKEN, (_, k) => {
        const v = data && data[k] != null ? String(data[k]).trim() : '';
        if (v) any = true;
        return v;
    });
    if (keys.length && !any) return null;
    return out;
}

/** Word-wrap one paragraph into lines no wider than `maxMm`; a word wider than the box is split. */
function wrapParagraph(par, maxMm, measure) {
    const words = par.split(/ +/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let cur = '';
    const pushWord = (w) => {
        if (measure(w) <= maxMm) { cur = w; return; }
        // Split a long word by characters.
        let piece = '';
        for (const ch of w) {
            if (piece && measure(piece + ch) > maxMm) { lines.push(piece); piece = ch; } else piece += ch;
        }
        cur = piece;
    };
    for (const w of words) {
        if (!cur) { pushWord(w); continue; }
        const next = `${cur} ${w}`;
        if (measure(next) <= maxMm) cur = next;
        else { lines.push(cur); cur = ''; pushWord(w); }
    }
    lines.push(cur);
    return lines;
}

function ellipsizeTo(s, maxMm, measure) {
    if (measure(s) <= maxMm) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measure(s.slice(0, mid).trimEnd() + '…') <= maxMm) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo).trimEnd() + '…' : '…';
}

/** A text element's lines at the size that fits: { size, lines } (lines already printable). */
function fitText(el, content, metrics) {
    const face = faceOf(el.font, el.bold);
    const paras = content.split('\n');
    const minSize = el.fit === 'shrink' ? Math.max(3, Math.round(el.size * 0.4 * 2) / 2) : el.size;
    let last = null;
    for (let size = el.size; size >= minSize - 1e-9; size = Math.round((size - 0.5) * 100) / 100) {
        const measure = (s) => metrics.widthMm(s, face, el.bold, size, el.ls);
        const lines = [];
        let overflowWord = false;
        for (const p of paras) {
            for (const l of wrapParagraph(p, el.w, measure)) lines.push(l);
            if (p.split(/ +/).some(w => measure(w) > el.w + 1e-6)) overflowWord = true;
        }
        const lineH = size * PT_MM * el.lh;
        const fitsH = lines.length * lineH <= el.h + 1e-6 || lines.length === 1;
        last = { size, lines, lineH, measure };
        if (fitsH && !overflowWord) return last;
        if (el.fit !== 'shrink') break;
    }
    // Still too big: keep the lines that fit the box (at least one), the last one ellipsized.
    const { size, lineH, measure } = last;
    const keep = Math.max(1, Math.floor((el.h + 1e-6) / lineH));
    let lines = last.lines;
    if (lines.length > keep) {
        lines = lines.slice(0, keep);
        lines[keep - 1] = ellipsizeTo(lines[keep - 1] + '…', el.w, measure).replace(/……$/, '…');
    }
    return { size, lines: lines.map(l => ellipsizeTo(l, el.w, measure)), lineH, measure };
}

/** Image placement in its box for a fit: the drawn rectangle (may exceed the box: the box clips it). */
function placeImage(el, iw, ih) {
    if (!(iw > 0 && ih > 0) || el.fit === 'fill') return { dx: el.x, dy: el.y, dw: el.w, dh: el.h };
    const s = el.fit === 'contain' ? Math.min(el.w / iw, el.h / ih) : Math.max(el.w / iw, el.h / ih);
    const dw = iw * s, dh = ih * s;
    return { dx: r2(el.x + (el.w - dw) / 2), dy: r2(el.y + (el.h - dh) / 2), dw: r2(dw), dh: r2(dh) };
}

/**
 * The display list of one badge.
 *   ctx.data     key → value (strings) for the tokens ('@name', '@code', '@location', …, form columns)
 *   ctx.qr       what the QR carries (the «Mi inscripción» link or the code)
 *   ctx.metrics  createMetrics(...) from badge-font.js
 *   ctx.images   sha → { w, h } intrinsic pixel size (for cover / contain)
 *   ctx.only     optional Set of element ids to lay out (the designer re-lays one element while dragging)
 */
function layoutDesign(design, ctx) {
    const d = design;
    const card = cardOf(d.layout);
    const items = [];
    const faces = new Set();
    const images = new Set();
    const data = ctx.data || {};
    for (const el of d.elements || []) {
        if (ctx.only && !ctx.only.has(el.id)) continue;
        const common = {};
        if (el.op < 1) common.op = el.op;
        if (el.rot) { common.rot = el.rot; common.cx = r2(el.x + el.w / 2); common.cy = r2(el.y + el.h / 2); }
        const tag = { el: el.id };
        if (el.type === 'shape') {
            if (!el.fill && !(el.stroke && el.sw > 0)) continue;
            const it = { t: el.shape === 'ellipse' ? 'ellipse' : 'rect', x: el.x, y: el.y, w: el.w, h: el.h, ...common, ...tag };
            if (el.fill) it.fill = el.fill;
            if (el.stroke && el.sw > 0) { it.stroke = el.stroke; it.sw = el.sw; }
            if (el.shape !== 'ellipse' && el.r) it.r = Math.min(el.r, el.w / 2, el.h / 2);
            items.push(it);
        } else if (el.type === 'line') {
            const y = r2(el.y + el.h / 2);
            items.push({ t: 'line', x1: el.x, y1: y, x2: r2(el.x + el.w), y2: y, stroke: el.stroke, sw: el.sw, ...common, ...tag });
        } else if (el.type === 'image') {
            const meta = ctx.images && ctx.images[el.asset];
            if (!meta) continue;
            images.add(el.asset);
            const p = placeImage(el, meta.w, meta.h);
            const it = { t: 'image', sha: el.asset, x: el.x, y: el.y, w: el.w, h: el.h, ...p, ...common, ...tag };
            if (el.mask === 'circle') it.clip = 'ellipse';
            else if (el.r) it.r = Math.min(el.r, el.w / 2, el.h / 2);
            items.push(it);
        } else if (el.type === 'qr') {
            const qrText = String(ctx.qr || data['@code'] || 'ABCDEFGHJK').replace(/[^\x20-\x7e]/g, '').slice(0, 300) || 'ABCDEFGHJK';
            const qr = encodeQr(qrText, qrText.length <= 20 ? 'H' : 'M');
            const side = Math.min(el.w, el.h);
            const pad = el.bg ? Math.max(0.6, side * 0.03) : 0;
            const module = (side - 2 * pad) / (qr.size + 2 * QR_QUIET);
            if (el.bg) items.push({ t: 'rect', x: el.x, y: el.y, w: side, h: side, fill: '#ffffff', r: r2(Math.min(1.6, side * 0.08)), ...common, ...tag });
            items.push({ t: 'qr', x: r2(el.x + pad + QR_QUIET * module), y: r2(el.y + pad + QR_QUIET * module), module: r4(module), size: qr.size, rows: qrRows(qr), ...common, ...tag });
        } else if (el.type === 'text') {
            const resolved = resolveText(el.text, data);
            if (resolved == null) continue;
            let content = printable(el.upper ? resolved.toLocaleUpperCase('es') : resolved).replace(/[ \t]+$/gm, '');
            if (!content.trim()) continue;
            const face = faceOf(el.font, el.bold);
            if (face) faces.add(face);
            const fitted = fitText(el, content, ctx.metrics);
            const v = ctx.metrics.vmetrics(face);
            const pt = fitted.size * PT_MM;
            const blockH = fitted.lines.length * fitted.lineH;
            const top = el.valign === 'middle' ? el.y + (el.h - blockH) / 2 : el.valign === 'bottom' ? el.y + el.h - blockH : el.y;
            fitted.lines.forEach((line, i) => {
                if (!line) return;
                const lw = fitted.measure(line);
                const x = el.align === 'center' ? el.x + (el.w - lw) / 2 : el.align === 'right' ? el.x + el.w - lw : el.x;
                const base = top + i * fitted.lineH + fitted.lineH / 2 + ((v.ascent + v.descent) / 2) * pt;
                const it = { t: 'text', x: r2(x), y: r2(base), size: fitted.size, face, bold: !!el.bold, fill: el.color, text: line, ...common, ...tag };
                if (el.ls) it.ls = el.ls;
                items.push(it);
            });
        }
    }
    return { version: 2, layout: d.layout, w_mm: card.w, h_mm: card.h, background: d.background, plate: null, items, faces: [...faces], images: [...images] };
}

/** A design's image shas. */
const assetsOfDesign = (d) => [...new Set((d && d.elements || []).filter(e => e.type === 'image').map(e => e.asset))];
/** A design's data keys (the tokens of its texts). */
const keysOfDesign = (d) => [...new Set((d && d.elements || []).filter(e => e.type === 'text').flatMap(e => tokensOf(e.text)))];

module.exports = { normalizeDesignV2, layoutDesign, resolveText, tokensOf, assetsOfDesign, keysOfDesign, cardOf, CARD, LAYOUTS, MAX_ELEMENTS, MAX_TEXT, PT_MM };
