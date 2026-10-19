/**
 * Text for the badges (conference-manager 2.19.0): the WinAnsi (cp1252) encoding the PDF's standard fonts
 * speak, and the Helvetica / Helvetica-Bold advance widths that fit a name or a line in its box. The badge
 * layout is computed ONCE, here on the server, and both renderers (the PDF and the credential page's SVG,
 * which draws with Arial/Helvetica — metric-compatible) only draw it, so they agree.
 *
 * Widths are the standard Adobe metrics (units of 1/1000 em) for printable ASCII; a Latin-1 letter takes its
 * base letter's width (Á = A, ñ = n, í = 278), which is what the AFM files say for Spanish within a unit or two.
 */
'use strict';

// Printable ASCII 32..126.
const REGULAR = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Unicode → cp1252 byte for the 0x80..0x9F block (the rest of 0xA0..0xFF is Latin-1 itself).
const CP1252 = new Map([
    [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
    [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91],
    [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02DC, 0x98],
    [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F],
]);
// cp1252 byte → its Unicode code point.
const FROM_CP1252 = new Map([...CP1252].map(([u, b]) => [b, u]));
const unicodeOf = (byte) => (FROM_CP1252.has(byte) ? FROM_CP1252.get(byte) : byte);
// The width of a non-ASCII character (by code point): its base letter's, or a sensible default.
const BASE_OF = (code) => {
    const ch = String.fromCodePoint(code);
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (base.length === 1 && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126) return base.charCodeAt(0);
    return null;
};
// Keyed by Unicode code point: the Adobe metrics of the characters whose width is not their base letter's.
const COMMON = {
    0xA0: 278, 0xA1: 333, 0xA2: 556, 0xA3: 556, 0xA4: 556, 0xA5: 556, 0xA6: 260, 0xA7: 556, 0xA9: 737, 0xAB: 556, 0xAC: 584, 0xAD: 333, 0xAE: 737,
    0xAF: 333, 0xB0: 400, 0xB1: 584, 0xB2: 333, 0xB3: 333, 0xB4: 333, 0xB5: 556, 0xB6: 537, 0xB7: 278, 0xB8: 333, 0xB9: 333, 0xBB: 556, 0xBC: 834,
    0xBD: 834, 0xBE: 834, 0xBF: 611, 0xC6: 1000, 0xD0: 722, 0xD7: 584, 0xD8: 778, 0xDE: 667, 0xDF: 611, 0xE6: 889, 0xF0: 556, 0xF7: 584, 0xF8: 611,
    0xFE: 556, 0xED: 278, 0xEC: 278, 0xEE: 278, 0xEF: 278, 0x20AC: 556, 0x2026: 1000, 0x2013: 556, 0x2014: 1000, 0x2022: 350, 0x2030: 1000,
    0x2122: 1000, 0x0152: 1000, 0x0153: 944, 0x0160: 667, 0x0161: 500, 0x017D: 611, 0x017E: 500, 0x0178: 667, 0x0192: 556, 0x2020: 556, 0x2021: 556,
    0x02C6: 333, 0x02DC: 333, 0x2039: 333, 0x203A: 333, 0x201A: 222, 0x201E: 333,
};
const SPECIAL = {
    regular: { ...COMMON, 0xAA: 370, 0xBA: 365, 0x2018: 222, 0x2019: 222, 0x201C: 333, 0x201D: 333 },
    bold: { ...COMMON, 0xA6: 280, 0xAA: 370, 0xBA: 365, 0xB6: 556, 0x2018: 278, 0x2019: 278, 0x201C: 500, 0x201D: 500, 0x201A: 278, 0x201E: 500, 0x0153: 944, 0x0161: 556, 0x017E: 500, 0xFE: 611, 0xF0: 611 },
};

/** The cp1252 bytes of a string; a character outside cp1252 becomes «?» (`lossy` tells the caller). */
function toWinAnsi(text) {
    const out = [];
    let lossy = false;
    for (const ch of String(text == null ? '' : text).normalize('NFC')) {
        const c = ch.codePointAt(0);
        if (c >= 32 && c <= 126) out.push(c);
        else if (c >= 0xA0 && c <= 0xFF) out.push(c);
        else if (CP1252.has(c)) out.push(CP1252.get(c));
        else if (c === 9 || c === 10 || c === 13) out.push(32);
        else { out.push(63); lossy = true; }
    }
    return { bytes: out, lossy };
}

/** The text the PDF can print, as a JS string of the same characters (for the SVG to draw the same thing). */
function printable(text) {
    const { bytes } = toWinAnsi(text);
    const rev = new Map([...CP1252].map(([u, b]) => [b, u]));
    return bytes.map(b => String.fromCodePoint(rev.has(b) ? rev.get(b) : b)).join('');
}

function charWidth(byte, bold) {
    const table = bold ? BOLD : REGULAR;
    if (byte >= 32 && byte <= 126) return table[byte - 32];
    const code = unicodeOf(byte);
    const special = (bold ? SPECIAL.bold : SPECIAL.regular)[code];
    if (special) return special;
    const base = BASE_OF(code);
    return base != null ? table[base - 32] : 556;
}

/** Width of `text` in millimetres at `sizePt` points. */
function textWidthMm(text, sizePt, bold) {
    const { bytes } = toWinAnsi(text);
    let units = 0;
    for (const b of bytes) units += charWidth(b, bold);
    return (units / 1000) * sizePt * (25.4 / 72);
}

/** The longest prefix of `text` that fits `maxMm`, with «…» when it had to be cut. */
function ellipsize(text, sizePt, bold, maxMm) {
    const s = printable(text);
    if (textWidthMm(s, sizePt, bold) <= maxMm) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (textWidthMm(s.slice(0, mid).trimEnd() + '…', sizePt, bold) <= maxMm) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? s.slice(0, lo).trimEnd() + '…' : '…';
}

/**
 * Word-wrap `text` into at most `maxLines` lines of `maxMm`; the last line is ellipsized. A single word wider
 * than the box is cut. Returns the lines (never empty for a non-empty text).
 */
function wrap(text, sizePt, bold, maxMm, maxLines) {
    const words = printable(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const next = cur ? `${cur} ${w}` : w;
        if (textWidthMm(next, sizePt, bold) <= maxMm) { cur = next; continue; }
        if (cur) lines.push(cur);
        cur = w;
        if (lines.length === maxLines - 1) {
            cur = [w, ...words.slice(i + 1)].join(' ');
            break;
        }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) lines.length = maxLines;
    return lines.map((l, i) => (i === lines.length - 1 || textWidthMm(l, sizePt, bold) > maxMm ? ellipsize(l, sizePt, bold, maxMm) : l));
}

/**
 * The largest size in [minPt, maxPt] (half-point steps) at which `text` fits `maxMm` in at most `maxLines`
 * lines without being cut; else minPt with the last line ellipsized.
 */
function fit(text, { minPt, maxPt, bold, maxMm, maxLines, maxHeightMm, lineFactor = 1.1 }) {
    // A box `maxHeightMm` tall holds only so many lines at a given size.
    const linesAt = (pt) => (maxHeightMm ? Math.max(1, Math.min(maxLines, Math.floor(maxHeightMm / (pt * (25.4 / 72) * lineFactor)))) : maxLines);
    for (let pt = maxPt; pt >= minPt; pt -= 0.5) {
        const lines = wrap(text, pt, bold, maxMm, linesAt(pt));
        const whole = lines.join(' ').replace(/…$/, '') === printable(text).split(/\s+/).filter(Boolean).join(' ');
        if (whole && !lines.some(l => l.endsWith('…'))) return { sizePt: pt, lines };
    }
    return { sizePt: minPt, lines: wrap(text, minPt, bold, maxMm, linesAt(minPt)) };
}

module.exports = { toWinAnsi, printable, textWidthMm, ellipsize, wrap, fit };
