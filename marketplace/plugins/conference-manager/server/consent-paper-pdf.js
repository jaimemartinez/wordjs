/**
 * The printable consent sheet as a real PDF (conference-manager 2.36.3). The HTML sheet (consent-paper-sheet.js)
 * printed fine from a computer, but a phone ignores window.print() from a frame or a popup, and «Descargar» saved
 * an .html file. This draws the same sheet, the same texts, columns, row height and pages, as a PDF a phone opens in
 * its own viewer (print, share) and a computer saves as a file. No dependency: Helvetica / Helvetica-Bold (WinAnsi,
 * with the badge PDF's metrics to wrap the texts) and a vector QR Code.
 *
 * Every page, landscape Letter («carta», by default) or A4, 8 mm margins:
 *   - the compact authorization on top (title and facts, the one authorization in two columns with its voluntary
 *     sentence, how to sign in a box) — whoever signs page 3 reads what they sign;
 *   - the signature rows under it (#, name, document, signature, the two «No autorizo» boxes, the minor's
 *     representative), the blank rows after the pre-filled ones;
 *   - the footer at the bottom: the QR («CMP:<id>:<i>/<n>»), the sheet id and «page i of n».
 */
'use strict';

const { toWinAnsi, textWidthMm, ellipsize } = require('./badge-text');
const { encodeQr } = require('./badge-qr');
const { TEXTS, oneAuthorization, langOf, paperOf, ROW_MM } = require('./consent-paper-sheet');

let deflate = null;
try { deflate = require('zlib').deflateSync; } catch (e) { deflate = null; }

const K = 72 / 25.4;                    // points per millimetre
const MARGIN = 8;                       // mm
const PAGES = { letter: { w: 279.4, h: 215.9 }, a4: { w: 297, h: 210 } };
const PT = 25.4 / 72;                   // mm per point
const num = (n) => { const v = Math.round(n * 100) / 100; return Object.is(v, -0) ? '0' : String(v); };

/** A PDF literal string of cp1252 bytes, escaped so the file stays 7-bit. */
function pdfString(text) {
    const { bytes } = toWinAnsi(text);
    let s = '(';
    for (const b of bytes) {
        if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
        else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
        else s += String.fromCharCode(b);
    }
    return s + ')';
}

/**
 * Word-wrap runs of text ([{ text, bold }]) into lines no wider than `maxMm`, each line a list of runs. A word
 * wider than the box is cut by characters.
 */
function wrapRuns(runs, sizePt, maxMm) {
    const words = [];
    for (const r of runs) for (const w of String(r.text || '').split(/\s+/).filter(Boolean)) words.push({ text: w, bold: !!r.bold });
    const lines = [];
    let line = [], width = 0;
    const space = (bold) => textWidthMm(' ', sizePt, bold);
    for (let w of words) {
        let ww = textWidthMm(w.text, sizePt, w.bold);
        while (ww > maxMm && w.text.length > 1) {
            // Cut a long word (an address, a hash) where it fits.
            let n = w.text.length - 1;
            while (n > 1 && textWidthMm(w.text.slice(0, n), sizePt, w.bold) > maxMm - (line.length ? width + space(w.bold) : 0)) n--;
            if (line.length && textWidthMm(w.text.slice(0, n), sizePt, w.bold) > maxMm - width - space(w.bold)) { lines.push(line); line = []; width = 0; continue; }
            line.push({ text: w.text.slice(0, n), bold: w.bold }); lines.push(line); line = []; width = 0;
            w = { text: w.text.slice(n), bold: w.bold }; ww = textWidthMm(w.text, sizePt, w.bold);
        }
        const add = (line.length ? space(w.bold) : 0) + ww;
        if (line.length && width + add > maxMm) { lines.push(line); line = []; width = 0; }
        line.push(w); width += (line.length > 1 ? space(w.bold) : 0) + ww;
    }
    if (line.length) lines.push(line);
    return lines;
}

/** A page's drawing: text, lines, rectangles (mm from the top-left of the page). */
function painter(pageH) {
    const ops = [];
    const y = (top) => num((pageH - top) * K);
    return {
        ops,
        /** One line of runs, its baseline at `top` mm; `align` left / right (x = the right edge) / center. */
        line(runs, x, top, sizePt, align = 'left') {
            const parts = runs.map((r, i) => ({ ...r, text: (i ? ' ' : '') + r.text }));
            const w = parts.reduce((n, r) => n + textWidthMm(r.text, sizePt, r.bold), 0);
            let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
            for (const r of parts) {
                ops.push(`BT /${r.bold ? 'F2' : 'F1'} ${num(sizePt)} Tf ${num(cx * K)} ${y(top)} Td ${pdfString(r.text)} Tj ET`);
                cx += textWidthMm(r.text, sizePt, r.bold);
            }
        },
        rect(x, top, w, h, { stroke = '0 0 0', fill = null, width = 0.3 } = {}) {
            ops.push(`q ${fill ? `${fill} rg ` : ''}${stroke ? `${stroke} RG ${num(width)} w ` : ''}${num(x * K)} ${num((pageH - top - h) * K)} ${num(w * K)} ${num(h * K)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`);
        },
        hline(x1, x2, top, width = 0.3) { ops.push(`q ${num(width)} w ${num(x1 * K)} ${y(top)} m ${num(x2 * K)} ${y(top)} l S Q`); },
        qr(text, x, top, sizeMm) {
            const m = encodeQr(text, 'M').modules;
            const n = m.length, q = 2, cell = sizeMm / (n + 2 * q);
            let d = '';
            m.forEach((row, ry) => row.forEach((on, rx) => { if (on) d += `${num((x + (rx + q) * cell) * K)} ${num((pageH - top - (ry + q + 1) * cell) * K)} ${num(cell * K)} ${num(cell * K)} re `; }));
            ops.push(`q 0 0 0 rg ${d}f Q`);
        },
    };
}

/** Lines of runs drawn top-down from `top`; returns the bottom. */
function paragraph(p, lines, x, top, sizePt, lead = 1.25) {
    const lh = sizePt * PT * lead;
    lines.forEach((ln, i) => p.line(ln, x, top + sizePt * PT * 0.95 + i * lh, sizePt));
    return top + lines.length * lh;
}

/**
 * The sheet's PDF. `s` as sheetHtml's: { lang, paper, code, created_utc, conference, location, policy: { url,
 * version, sha256 }, responsible, contact, texts, people: [{ row, name }], blank }.
 */
function sheetPdf(s) {
    const L = TEXTS[langOf(s.lang)];
    const page = PAGES[paperOf(s.paper)];
    const W = page.w - 2 * MARGIN;
    const people = Array.isArray(s.people) ? s.people : [];
    const blank = Math.max(0, Number(s.blank) || 0);
    const rows = [...people.map(p => ({ row: p.row, name: p.name })), ...Array.from({ length: blank }, (_, i) => ({ row: people.length + i + 1, name: '' }))];
    const contact = s.contact || L.organizers;
    const printed = String(s.created_utc || '').replace('T', ' ').slice(0, 16);

    // The header, measured once (it is the same on every page).
    const colW = (W - 8) / 2;
    const metaRuns = [{ text: `${L.conference}:` }, { text: s.conference, bold: true }, { text: `· ${L.locality}:` }, { text: s.location, bold: true }, { text: `· ${L.sheet}` }, { text: s.code, bold: true }, { text: `· ${L.printed}: ${printed}` }];
    const titleW = textWidthMm(L.title, 13, true);
    const metaLines = wrapRuns(metaRuns, 9, Math.max(60, W - titleW - 6));
    const factL = [
        [{ text: `${L.controller}:`, bold: true }, { text: s.responsible || L.organizers }],
        [{ text: `${L.contact}:`, bold: true }, { text: contact }],
        [{ text: `${L.policy}:`, bold: true }, { text: `${s.policy.url} · ${L.version(s.policy.version)}` }],
    ].map(r => wrapRuns(r, 9.5, colW));
    const shaLines = wrapRuns([{ text: `SHA-256 ${s.policy.sha256}` }], 7.5, colW);
    const factR = [
        [{ text: `${L.purpose}:`, bold: true }, { text: L.purposeText(s.conference) }],
        [{ text: `${L.rights}:`, bold: true }, { text: L.rightsText(contact) }],
    ].map(r => wrapRuns(r, 9.5, colW));
    const authLines = wrapRuns([{ text: `${L.auth}.`, bold: true }, { text: oneAuthorization(s.texts) }, { text: L.voluntary, bold: true }], 10, colW);
    const half = Math.ceil(authLines.length / 2);
    const howLines = wrapRuns([{ text: L.how }], 9, W - 4);
    const lh = (pt, lead = 1.25) => pt * PT * lead;
    const topH = Math.max(13 * PT * 1.2, metaLines.length * lh(9, 1.2)) + 1.5;
    const factsH = Math.max(factL.reduce((n, l) => n + l.length * lh(9.5), 0) + shaLines.length * lh(7.5), factR.reduce((n, l) => n + l.length * lh(9.5), 0)) + 1.5;
    const authH = half * lh(10) + 3;
    const howH = howLines.length * lh(9) + 2.5;
    const headH = topH + factsH + authH + howH + 2;
    const THEAD = 14, FOOT = 18;
    const perPage = Math.max(3, Math.floor((page.h - 2 * MARGIN - headH - THEAD - FOOT) / ROW_MM));
    const total = Math.max(1, Math.ceil(rows.length / perPage));

    // The columns, as the HTML sheet's (mm); the representative's signature takes what is left.
    const cols = [8, 64, 30, 42, 17, 17, 38, 26];
    cols.push(Math.max(15, W - cols.reduce((a, b) => a + b, 0)));
    const xs = cols.reduce((a, w) => [...a, a[a.length - 1] + w], [MARGIN]);

    const pages = [];
    for (let pi = 0; pi < total; pi++) {
        const p = painter(page.h);
        let top = MARGIN;
        // Title and meta.
        p.line([{ text: L.title, bold: true }], MARGIN, top + 13 * PT * 0.95, 13);
        metaLines.forEach((ln, i) => p.line(ln, MARGIN + W, top + 9 * PT * 0.95 + i * lh(9, 1.2), 9, 'right'));
        top += topH;
        p.hline(MARGIN, MARGIN + W, top - 0.6, 0.6);
        // Facts, two columns.
        let yl = top + 0.8;
        for (const l of factL) yl = paragraph(p, l, MARGIN, yl, 9.5);
        paragraph(p, shaLines, MARGIN, yl, 7.5);
        let yr = top + 0.8;
        for (const l of factR) yr = paragraph(p, l, MARGIN + colW + 8, yr, 9.5);
        top += factsH;
        // The one authorization, two columns.
        p.hline(MARGIN, MARGIN + W, top, 0.3);
        paragraph(p, authLines.slice(0, half), MARGIN, top + 1, 10);
        paragraph(p, authLines.slice(half), MARGIN + colW + 8, top + 1, 10);
        top += authH;
        // How to sign, in a box.
        p.rect(MARGIN, top, W, howH - 0.5, { stroke: '0.6 0.6 0.6' });
        paragraph(p, howLines, MARGIN + 2, top + 0.7, 9);
        top += howH + 1;

        // The table head (two rows: the representative's three columns under one heading).
        const th = top;
        p.rect(MARGIN, th, W, THEAD, { stroke: null, fill: '0.945 0.945 0.945' });
        const headCell = (i, text, y0, h, span = 1) => {
            const w = xs[i + span] - xs[i];
            p.rect(xs[i], y0, w, h, { stroke: '0.2 0.2 0.2' });
            const ls = wrapRuns([{ text, bold: true }], 7.5, w - 1.5).slice(0, 3);
            const startTop = y0 + (h - ls.length * lh(7.5, 1.1)) / 2;
            ls.forEach((ln, k) => p.line(ln, xs[i] + w / 2, startTop + 7.5 * PT * 0.95 + k * lh(7.5, 1.1), 7.5, 'center'));
        };
        [[0, L.col.n], [1, L.col.name], [2, L.col.doc], [3, L.col.sign], [4, L.col.health], [5, L.col.image]].forEach(([i, txt]) => headCell(i, txt, th, THEAD));
        headCell(6, L.col.rep, th, THEAD / 2, 3);
        headCell(6, L.col.repName, th + THEAD / 2, THEAD / 2);
        headCell(7, L.col.repDoc, th + THEAD / 2, THEAD / 2);
        headCell(8, L.col.repSign, th + THEAD / 2, THEAD / 2);
        top += THEAD;
        // The rows.
        for (const r of rows.slice(pi * perPage, (pi + 1) * perPage)) {
            if (!r.name) p.rect(xs[1], top, cols[1], ROW_MM, { stroke: null, fill: '0.98 0.98 0.98' });
            for (let i = 0; i < cols.length; i++) p.rect(xs[i], top, cols[i], ROW_MM, { stroke: '0.2 0.2 0.2' });
            const base = top + ROW_MM / 2 + 11 * PT * 0.35;
            p.line([{ text: String(r.row) }], xs[0] + cols[0] / 2, base, 10, 'center');
            if (r.name) p.line([{ text: ellipsize(r.name, 11, false, cols[1] - 2.5) }], xs[1] + 1.2, base, 11);
            for (const i of [4, 5]) p.rect(xs[i] + (cols[i] - 4.5) / 2, top + (ROW_MM - 4.5) / 2, 4.5, 4.5, { stroke: '0 0 0', width: 0.35 });
            top += ROW_MM;
        }
        // The footer, at the bottom of the page.
        const ft = page.h - MARGIN - 15;
        p.qr(`CMP:${s.code}:${pi + 1}/${total}`, MARGIN, ft, 15);
        p.line([{ text: `${L.sheet} ${s.code}`, bold: true }, { text: `· ${L.page(pi + 1, total)}` }], MARGIN + 18, ft + 6, 8.5);
        p.line([{ text: `${s.conference} · ${L.locality}: ${s.location} · ${L.policy} ${L.version(s.policy.version)}` }], MARGIN + 18, ft + 10.5, 8.5);
        pages.push(p.ops.join('\n'));
    }
    return writePdf(pages, page, `${L.sheet} ${s.code} — ${s.conference} · ${s.location}`);
}

function writePdf(pageOps, page, title) {
    const objs = [];
    const add = (body) => { objs.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')); return objs.length; };
    const reserve = () => { objs.push(null); return objs.length; };
    const stream = (data) => {
        let bytes = Buffer.from(data, 'latin1');
        let filter = '';
        if (deflate) { bytes = deflate(bytes); filter = ' /Filter /FlateDecode'; }
        return Buffer.concat([Buffer.from(`<<${filter} /Length ${bytes.length} >>\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1')]);
    };
    const catalog = reserve();
    const pagesObj = reserve();
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of pageOps) {
        const content = add(stream(ops));
        kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(page.w * K)} ${num(page.h * K)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(n => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
    objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1');
    let hex = 'FEFF';
    for (const ch of String(title || '')) {
        const cp = ch.codePointAt(0);
        const units = cp > 0xFFFF ? [0xD800 + ((cp - 0x10000) >> 10), 0xDC00 + ((cp - 0x10000) & 0x3FF)] : [cp];
        for (const u of units) hex += u.toString(16).toUpperCase().padStart(4, '0');
    }
    const info = add(`<< /Title <${hex}> /Producer (WordJS conference-manager) >>`);
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

module.exports = { sheetPdf, wrapRuns, PAGES };
