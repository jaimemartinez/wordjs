/**
 * The badge PDF (conference-manager 2.19.0), no dependency: it draws display lists (server/badge-layout.js) at
 * their exact physical size — one badge per page, or a Letter sheet of badges with hairline cut guides — with
 * the standard Helvetica / Helvetica-Bold fonts (WinAnsi), a vector QR Code and each conference's plate
 * JPEG embedded ONCE and reused on every page (a 500-badge PDF stays small).
 */
'use strict';

const { toWinAnsi } = require('./badge-text');

const K = 72 / 25.4;                       // points per millimetre
const LETTER = { w: 215.9, h: 279.4 };     // mm
const SHEET_MARGIN = 6, SHEET_GAP = 4;     // mm

let deflate = null;
try { deflate = require('zlib').deflateSync; } catch (e) { deflate = null; }

const num = (n) => {
    const v = Math.round(n * 1000) / 1000;
    return Object.is(v, -0) ? '0' : String(v);
};
const rgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')) || [null, '000000'];
    const n = parseInt(m[1], 16);
    return `${num(((n >> 16) & 255) / 255)} ${num(((n >> 8) & 255) / 255)} ${num((n & 255) / 255)}`;
};
// A PDF literal string of cp1252 bytes, escaped so the file stays 7-bit.
const pdfString = (text) => {
    const { bytes } = toWinAnsi(text);
    let s = '(';
    for (const b of bytes) {
        if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
        else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
        else s += String.fromCharCode(b);
    }
    return s + ')';
};

// A text string outside a content stream (the document title): UTF-16BE with its byte-order mark, in hex.
const pdfTextString = (text) => {
    let hex = 'FEFF';
    for (const ch of String(text == null ? '' : text)) {
        const cp = ch.codePointAt(0);
        const units = cp > 0xFFFF ? [0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)] : [cp];
        for (const u of units) hex += u.toString(16).toUpperCase().padStart(4, '0');
    }
    return `<${hex}>`;
};

/** Width, height and components of a baseline or progressive JPEG (null when it is not one). */
function jpegInfo(buf) {
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
            return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
        }
        i += 2 + len;
    }
    return null;
}

// The content-stream operators of one badge whose top-left corner is at (ox, oy) mm on a page `pageH` mm tall.
function badgeOps(badge, ox, oy, pageH, plateName) {
    const out = [];
    const X = (x) => num((ox + x) * K);
    const Y = (y) => num((pageH - (oy + y)) * K);
    const W = (w) => num(w * K);
    // Background, then the plate over the whole card.
    out.push(`${rgb(badge.background)} rg ${X(0)} ${Y(badge.h_mm)} ${W(badge.w_mm)} ${W(badge.h_mm)} re f`);
    if (plateName) out.push(`q ${W(badge.w_mm)} 0 0 ${W(badge.h_mm)} ${X(0)} ${Y(badge.h_mm)} cm /${plateName} Do Q`);
    for (const it of badge.items || []) {
        if (it.t === 'rect') {
            out.push(`${rgb(it.fill)} rg`);
            if (it.r) out.push(roundRect(ox + it.x, oy + it.y, it.w, it.h, it.r, pageH) + ' f');
            else out.push(`${X(it.x)} ${Y(it.y + it.h)} ${W(it.w)} ${W(it.h)} re f`);
        } else if (it.t === 'text') {
            out.push(`BT /${it.bold ? 'F2' : 'F1'} ${num(it.size)} Tf ${rgb(it.fill)} rg ${X(it.x)} ${Y(it.y)} Td ${pdfString(it.text)} Tj ET`);
        } else if (it.t === 'qr') {
            // One rectangle per horizontal run of dark modules (2.22.0).
            out.push('0 0 0 rg');
            const rects = [];
            it.rows.forEach((row, y) => {
                for (let x = 0; x < row.length; x++) {
                    if (row[x] !== '1') continue;
                    let w = 1;
                    while (x + w < row.length && row[x + w] === '1') w++;
                    rects.push(`${X(it.x + x * it.module)} ${Y(it.y + (y + 1) * it.module)} ${num(w * it.module * K)} ${W(it.module)} re`);
                    x += w - 1;
                }
            });
            out.push(rects.join(' ') + ' f');
        }
    }
    return out.join('\n');
}

function roundRect(x, y, w, h, r, pageH) {
    const k = 0.5523 * r;
    const P = (px, py) => `${num(px * K)} ${num((pageH - py) * K)}`;
    return [
        `${P(x + r, y)} m`,
        `${P(x + w - r, y)} l`, `${P(x + w - r + k, y)} ${P(x + w, y + r - k)} ${P(x + w, y + r)} c`,
        `${P(x + w, y + h - r)} l`, `${P(x + w, y + h - r + k)} ${P(x + w - r + k, y + h)} ${P(x + w - r, y + h)} c`,
        `${P(x + r, y + h)} l`, `${P(x + r - k, y + h)} ${P(x, y + h - r + k)} ${P(x, y + h - r)} c`,
        `${P(x, y + r)} l`, `${P(x, y + r - k)} ${P(x + r - k, y)} ${P(x + r, y)} c`, 'h',
    ].join(' ');
}

/** How many badges of `w`×`h` mm fit a Letter sheet, and where (top-left corners, mm). */
function sheetSlots(w, h) {
    const cols = Math.max(1, Math.floor((LETTER.w - 2 * SHEET_MARGIN + SHEET_GAP) / (w + SHEET_GAP)));
    const rows = Math.max(1, Math.floor((LETTER.h - 2 * SHEET_MARGIN + SHEET_GAP) / (h + SHEET_GAP)));
    const gw = cols * w + (cols - 1) * SHEET_GAP, gh = rows * h + (rows - 1) * SHEET_GAP;
    const x0 = (LETTER.w - gw) / 2, y0 = (LETTER.h - gh) / 2;
    const slots = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slots.push({ x: x0 + c * (w + SHEET_GAP), y: y0 + r * (h + SHEET_GAP) });
    return slots;
}

/**
 * The PDF of `badges` (display lists). `plates` maps a plate sha to its JPEG bytes (a Buffer); a badge whose
 * plate is missing or not a JPEG is drawn on its background colour. `sheet`: 'single' (one per page, the
 * card's own size) | 'letter' (as many as fit a Letter sheet, with hairline cut guides).
 */
function buildBadgePdf({ badges, plates, sheet = 'single', title = 'Escarapelas' }) {
    const list = Array.isArray(badges) ? badges : [];
    if (!list.length) throw new Error('badge-pdf: no badge');
    const objs = [];                                  // index = object number - 1; each entry a Buffer
    const add = (body) => { objs.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objs.length; };
    const reserve = () => { objs.push(null); return objs.length; };
    const stream = (dict, data) => {
        let bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
        let filter = '';
        if (deflate && !/\/Filter/.test(dict)) { bytes = deflate(bytes); filter = ' /Filter /FlateDecode'; }
        return Buffer.concat([Buffer.from(`<< ${dict}${filter} /Length ${bytes.length} >>\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1')]);
    };

    const catalog = reserve();
    const pagesObj = reserve();
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    // Each plate once.
    const plateNames = new Map();                     // sha -> { name, obj }
    for (const b of list) {
        const sha = b.plate && b.plate.sha;
        if (!sha || plateNames.has(sha)) continue;
        const bytes = plates && (plates.get ? plates.get(sha) : plates[sha]);
        const info = jpegInfo(bytes);
        if (!info || (info.comps !== 3 && info.comps !== 1)) continue;
        const cs = info.comps === 1 ? '/DeviceGray' : '/DeviceRGB';
        const obj = add(stream(`/Type /XObject /Subtype /Image /Width ${info.w} /Height ${info.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, bytes));
        plateNames.set(sha, { name: `Im${plateNames.size + 1}`, obj });
    }
    const xobjects = [...plateNames.values()].map(p => `/${p.name} ${p.obj} 0 R`).join(' ');
    const resources = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >>`;

    const pageObjs = [];
    const addPage = (wMm, hMm, ops) => {
        const content = add(stream('', ops));
        pageObjs.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(wMm * K)} ${num(hMm * K)}] /Resources ${resources} /Contents ${content} 0 R >>`));
    };
    const plateOf = (b) => (b.plate && plateNames.has(b.plate.sha) ? plateNames.get(b.plate.sha).name : null);

    if (sheet === 'letter') {
        // Badges of one size per sheet run; a size change starts a new sheet.
        let i = 0;
        while (i < list.length) {
            const { w_mm: w, h_mm: h } = list[i];
            const slots = sheetSlots(w, h);
            const ops = [];
            let n = 0;
            while (i < list.length && n < slots.length && list[i].w_mm === w && list[i].h_mm === h) {
                const s = slots[n];
                ops.push(badgeOps(list[i], s.x, s.y, LETTER.h, plateOf(list[i])));
                // Hairline cut guide on the card's edge.
                ops.push(`q 0.75 0.75 0.75 RG 0.25 w ${num(s.x * K)} ${num((LETTER.h - s.y - h) * K)} ${num(w * K)} ${num(h * K)} re S Q`);
                i++; n++;
            }
            addPage(LETTER.w, LETTER.h, ops.join('\n'));
        }
    } else {
        for (const b of list) addPage(b.w_mm, b.h_mm, badgeOps(b, 0, 0, b.h_mm, plateOf(b)));
    }

    objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageObjs.map(n => `${n} 0 R`).join(' ')}] /Count ${pageObjs.length} >>`, 'latin1');
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1');
    const info = add(`<< /Title ${pdfTextString(title)} /Producer (WordJS conference-manager) >>`);

    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = parts[0].length;
    const offsets = [];
    objs.forEach((body, i) => {
        offsets.push(offset);
        const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
        parts.push(chunk);
        offset += chunk.length;
    });
    const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f ', ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
    parts.push(Buffer.from(`${xref}\ntrailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
}

module.exports = { buildBadgePdf, jpegInfo, sheetSlots };
