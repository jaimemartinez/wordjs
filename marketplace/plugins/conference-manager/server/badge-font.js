/**
 * Badge typefaces (conference-manager 2.29.0) — shared by the server (layout, PDF) and the browser (the
 * designer, the credential page), so a text is measured with the SAME numbers everywhere and the three
 * renderers agree to the hundredth of a millimetre.
 *
 *   FONTS          the catalogue: a family id, its label, its weights. «helvetica» is the PDF's standard font
 *                  (Adobe metrics, nothing to embed; Arial on screen); every other family is a TrueType file
 *                  shipped in fonts/<id>-<weight>.js (base64; see fonts/README.md for licences).
 *   faceOf         family + bold → the face id that is really drawn ('montserrat-700'), or null for Helvetica.
 *                  A family without a bold face draws its regular one (never a synthetic bold).
 *   parseTtf       the metrics of a TrueType file: units per em, ascent / descent, the advance of each
 *                  character (through its Unicode cmap), and the WinAnsi widths a PDF needs.
 *   createMetrics  a measurer over a face loader: width of a string in mm at a size (with letter spacing),
 *                  and a face's vertical metrics. The server loads faces from the font modules, the browser
 *                  from the bytes it fetched; both hand them to the same function.
 *
 * Text is printed in WinAnsi (cp1252, server/badge-text.js): every Spanish / Portuguese letter, the usual
 * punctuation; anything else becomes «?» in the PDF, so it is shown as «?» everywhere.
 */
'use strict';

const { toWinAnsi, charWidthUnits } = require('./badge-text');

const FONTS = [
    { id: 'helvetica', label: 'Helvetica', group: 'sans', weights: [400, 700] },
    { id: 'montserrat', label: 'Montserrat', group: 'sans', weights: [400, 700] },
    { id: 'poppins', label: 'Poppins', group: 'sans', weights: [400, 700] },
    { id: 'lato', label: 'Lato', group: 'sans', weights: [400, 700] },
    { id: 'raleway', label: 'Raleway', group: 'sans', weights: [400, 700] },
    { id: 'opensans', label: 'Open Sans', group: 'sans', weights: [400, 700] },
    { id: 'roboto', label: 'Roboto', group: 'sans', weights: [400, 700] },
    { id: 'nunito', label: 'Nunito', group: 'sans', weights: [400, 700] },
    { id: 'oswald', label: 'Oswald', group: 'display', weights: [400, 700] },
    { id: 'bebas', label: 'Bebas Neue', group: 'display', weights: [400] },
    { id: 'playfair', label: 'Playfair Display', group: 'serif', weights: [400, 700] },
    { id: 'merriweather', label: 'Merriweather', group: 'serif', weights: [400, 700] },
    { id: 'lora', label: 'Lora', group: 'serif', weights: [400, 700] },
    { id: 'dancing', label: 'Dancing Script', group: 'script', weights: [400, 700] },
];
const BY_ID = new Map(FONTS.map(f => [f.id, f]));
const FACE_RE = /^([a-z]+)-(400|700)$/;

/** The family id as stored: a known one, else Helvetica. */
const familyOf = (id) => (BY_ID.has(id) ? id : 'helvetica');
/** The face really drawn for a family and weight; null = Helvetica (the PDF's standard font). */
function faceOf(family, bold) {
    const f = BY_ID.get(familyOf(family));
    if (f.id === 'helvetica') return null;
    const w = bold && f.weights.includes(700) ? 700 : 400;
    return `${f.id}-${w}`;
}
/** Is `face` a shipped face id ('montserrat-700')? */
function isFace(face) {
    const m = typeof face === 'string' ? FACE_RE.exec(face) : null;
    if (!m) return false;
    const f = BY_ID.get(m[1]);
    return !!f && f.id !== 'helvetica' && f.weights.includes(Number(m[2]));
}
/** Every shipped face id. */
const allFaces = () => FONTS.filter(f => f.id !== 'helvetica').flatMap(f => f.weights.map(w => `${f.id}-${w}`));

// ── TrueType parsing ─────────────────────────────────────────────────────────────────────────────
function parseTtf(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u16 = (o) => dv.getUint16(o), i16 = (o) => dv.getInt16(o), u32 = (o) => dv.getUint32(o);
    const tables = {};
    const n = u16(4);
    for (let i = 0; i < n; i++) {
        const r = 12 + i * 16;
        const tag = String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]);
        tables[tag] = { off: u32(r + 8), len: u32(r + 12) };
    }
    for (const t of ['head', 'hhea', 'hmtx', 'cmap']) if (!tables[t]) throw new Error(`badge font: no ${t} table`);
    const head = tables.head.off;
    const upm = u16(head + 18);
    const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];
    const hhea = tables.hhea.off;
    let ascent = i16(hhea + 4), descent = i16(hhea + 6);
    const numH = u16(hhea + 34);
    let capHeight = Math.round(ascent * 0.7);
    if (tables['OS/2']) {
        const os2 = tables['OS/2'].off;
        const version = u16(os2);
        // The Windows ascent / descent are what browsers lay a line out with when USE_TYPO_METRICS is off.
        if (tables['OS/2'].len >= 78) { ascent = u16(os2 + 74); descent = -u16(os2 + 76); }
        if (version >= 2 && tables['OS/2'].len >= 90) capHeight = i16(os2 + 88) || capHeight;
    }
    let italicAngle = 0;
    if (tables.post) italicAngle = dv.getInt32(tables.post.off + 4) / 65536;
    let psName = '';
    if (tables.name) {
        const no = tables.name.off, count = u16(no + 2), so = no + u16(no + 4);
        for (let i = 0; i < count; i++) {
            const r = no + 6 + i * 12;
            if (u16(r + 6) !== 6) continue;
            const pid = u16(r), len = u16(r + 8), o = so + u16(r + 10);
            let s = '';
            if (pid === 3 || pid === 0) for (let k = 0; k < len; k += 2) s += String.fromCharCode(u16(o + k));
            else for (let k = 0; k < len; k++) s += String.fromCharCode(b[o + k]);
            psName = s.replace(/[^A-Za-z0-9-]/g, '');
            if (psName) break;
        }
    }
    // Advances by glyph.
    const hm = tables.hmtx.off;
    const advanceOfGlyph = (g) => u16(hm + 4 * Math.min(g, numH - 1));
    // Unicode → glyph: the (3,10) format 12 subtable when present, else (3,1) / (0,x) format 4.
    const cm = tables.cmap.off;
    const subs = [];
    for (let i = 0; i < u16(cm + 2); i++) {
        const r = cm + 4 + i * 8;
        subs.push({ pid: u16(r), eid: u16(r + 2), off: cm + u32(r + 4) });
    }
    const pick = subs.find(s => s.pid === 3 && s.eid === 10 && u16(s.off) === 12)
        || subs.find(s => s.pid === 3 && s.eid === 1 && u16(s.off) === 4)
        || subs.find(s => s.pid === 0 && u16(s.off) === 4)
        || subs.find(s => s.pid === 0 && u16(s.off) === 12);
    if (!pick) throw new Error('badge font: no Unicode cmap');
    let glyphOf;
    if (u16(pick.off) === 4) {
        const o = pick.off, segX2 = u16(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
        glyphOf = (c) => {
            if (c > 0xFFFF) return 0;
            for (let s = 0; s < segX2; s += 2) {
                if (c > u16(ends + s)) continue;
                const start = u16(starts + s);
                if (c < start) return 0;
                const ro = u16(ranges + s);
                if (!ro) return (c + i16(deltas + s)) & 0xFFFF;
                const g = u16(ranges + s + ro + 2 * (c - start));
                return g ? (g + i16(deltas + s)) & 0xFFFF : 0;
            }
            return 0;
        };
    } else {
        const o = pick.off, groups = u32(o + 12);
        glyphOf = (c) => {
            for (let i = 0; i < groups; i++) {
                const r = o + 16 + i * 12, s = u32(r), e = u32(r + 4);
                if (c >= s && c <= e) return u32(r + 8) + (c - s);
                if (c < s) break;
            }
            return 0;
        };
    }
    const cache = new Map();
    /** Advance of a Unicode code point, in font units (the .notdef glyph's when the font lacks it). */
    const advance = (cp) => {
        if (cache.has(cp)) return cache.get(cp);
        const a = advanceOfGlyph(glyphOf(cp));
        cache.set(cp, a);
        return a;
    };
    return { upm, ascent, descent, capHeight, bbox, italicAngle, psName, advance, hasChar: (cp) => glyphOf(cp) !== 0 };
}

// cp1252 byte → Unicode (0x80..0x9F block; the rest is Latin-1 itself).
const CP1252_HIGH = [0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178];
const unicodeOfByte = (b) => (b >= 0x80 && b <= 0x9F ? CP1252_HIGH[b - 0x80] || 0x20 : b);

/** The /Widths of a TrueType font for WinAnsi codes 32..255 (1000-unit em). */
function winAnsiWidths(parsed) {
    const out = [];
    for (let c = 32; c <= 255; c++) out.push(Math.round(parsed.advance(unicodeOfByte(c)) * 1000 / parsed.upm));
    return out;
}

const PT_MM = 25.4 / 72;
const HELVETICA_V = { ascent: 0.718, descent: -0.207, capHeight: 0.718 };

/**
 * A measurer over `loadFace(faceId) → parsed | null` (parseTtf's result). A face not loaded yet measures as
 * Helvetica — the browser lays out again once it arrives; the server always has every face.
 */
function createMetrics(loadFace) {
    const widthsCache = new Map();
    const unitsOf = (face) => {
        if (!face) return null;
        if (widthsCache.has(face)) return widthsCache.get(face);
        const p = loadFace(face);
        if (!p) return null;
        const w = winAnsiWidths(p);
        widthsCache.set(face, w);
        return w;
    };
    /** Width of `text` (already printable) in mm at `sizePt`, with `lsPt` points of tracking after each character. */
    const widthMm = (text, face, bold, sizePt, lsPt = 0) => {
        const { bytes } = toWinAnsi(text);
        const table = unitsOf(face);
        let units = 0;
        for (const by of bytes) units += table ? table[by - 32] || 0 : charWidthUnits(by, !!bold);
        return (units / 1000) * sizePt * PT_MM + bytes.length * (lsPt || 0) * PT_MM;
    };
    /** Ascent / descent / cap height as fractions of the em (descent negative). */
    const vmetrics = (face) => {
        const p = face ? loadFace(face) : null;
        if (!p) return HELVETICA_V;
        return { ascent: p.ascent / p.upm, descent: p.descent / p.upm, capHeight: p.capHeight / p.upm };
    };
    return { widthMm, vmetrics, loaded: (face) => !face || !!loadFace(face) };
}

module.exports = { FONTS, familyOf, faceOf, isFace, allFaces, parseTtf, winAnsiWidths, createMetrics, unicodeOfByte, HELVETICA_V };
