/**
 * The badge's DISPLAY LIST (conference-manager 2.19.0): one person's badge as rectangles, text runs and
 * its QR Code (2.22.0; Code 128 bars before), in millimetres from the card's top-left corner. Computed once, here, and drawn as it is by the
 * PDF (server/badge-pdf.js) and by the credential page and the designer's preview (SVG), so the three agree.
 *
 * The card is a CR80 ID card (85.6 × 54 mm), horizontal or vertical. Its STATIC layer — background colour or
 * image, the legibility panel and the logo — is the PLATE: a JPEG the designer composites in the browser from
 * the zones below (`zonesOf`) and uploads once; without a plate the background colour is filled. Everything
 * personal (title, name, lines, code) is drawn on top.
 */
'use strict';

const { fit, ellipsize, textWidthMm, printable } = require('./badge-text');
const { encodeQr, qrRows } = require('./badge-qr');

/**
 * Error-correction level of the badge's QR: the highest for a bare registration code (it still fits version 1,
 * 21×21); M for the «Mi inscripción» link (2.23.0) — a link at H would need a denser symbol than the badge can
 * print at a size a phone reads easily.
 */
const QR_ECL = 'H';
const QR_ECL_LINK = 'M';
const eclFor = (text) => (text.length <= 20 ? QR_ECL : QR_ECL_LINK);
/** Light modules around the QR inside its white panel (the panel's own padding adds about one more). */
const QR_QUIET = 2;

const CARD = { w: 85.6, h: 54 };
const LAYOUTS = ['horizontal', 'vertical'];
const M = 3.5;                                  // margin
const PT = 25.4 / 72;                           // mm per point

/** Fixed zones of a layout, in mm: what the designer composites the plate against and the layout draws in. */
function zonesOf(layout) {
    const vertical = layout === 'vertical';
    const W = vertical ? CARD.h : CARD.w, H = vertical ? CARD.w : CARD.h;
    const inner = W - 2 * M;
    if (vertical) {
        return {
            w: W, h: H,
            logo: { x: M, y: M, w: 12, h: 12 },
            header: { x: M, y: M, w: inner, h: 12 },
            accent: { x: M, y: 17, w: inner, h: 0.6 },
            panel: { x: M - 1, y: 18.5, w: inner + 2, h: 44.5 },
            name: { x: M, y: 19.5, w: inner, h: 14 },
            // 2.23.0: the rows keep their 6 places in less height and the QR strip grows (a link is a denser QR).
            lines: { x: M, y: 35, w: inner, h: 23.6 },
            code: { x: M, y: 60, w: inner, h: 22.1 },
        };
    }
    // 2.22.0: the QR is square, so it takes a column on the right (it was a strip of bars along the bottom);
    // the name and the field rows keep the left part.
    const codeW = 24;
    const left = inner - codeW - 2.5;
    return {
        w: W, h: H,
        logo: { x: M, y: M, w: 10, h: 10 },
        header: { x: M, y: M, w: inner, h: 10 },
        accent: { x: M, y: 14.3, w: inner, h: 0.6 },
        panel: { x: M - 1, y: 15.6, w: inner + 2, h: 24 },
        name: { x: M, y: 16.3, w: left, h: 10.5 },
        lines: { x: M, y: 27.4, w: left, h: 10.8 },
        code: { x: W - M - codeW, y: 16.3, w: codeW, h: H - M - 16.3 },
    };
}

const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLORS = Object.freeze({ background: '#1e3a8a', text: '#ffffff', label: '#bfdbfe', accent: '#fbbf24' });
const colorOr = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);

/**
 * The display list of one badge.
 *   design: { layout, colors{background,text,label,accent}, has_logo, plate:{ sha, w, h }|null }
 *   data:   { title, name, lines:[{ label|null, value }], code, qr? } — `qr` = what the QR carries (default: code)
 */
function buildBadge(design, data) {
    const layout = LAYOUTS.includes(design && design.layout) ? design.layout : 'horizontal';
    const z = zonesOf(layout);
    const c = design && design.colors ? design.colors : {};
    const colors = {
        background: colorOr(c.background, DEFAULT_COLORS.background),
        text: colorOr(c.text, DEFAULT_COLORS.text),
        label: colorOr(c.label, DEFAULT_COLORS.label),
        accent: colorOr(c.accent, DEFAULT_COLORS.accent),
    };
    const items = [];
    const text = (x, y, sizePt, bold, fill, s) => items.push({ t: 'text', x: r2(x), y: r2(y), size: sizePt, bold: !!bold, fill, text: s });

    // Title, right of the logo zone (when there is a logo), centred vertically in the header; up to 2 lines.
    const logoW = design && design.has_logo ? z.logo.w + 2 : 0;
    const titleBox = { x: z.header.x + logoW, w: z.header.w - logoW };
    const title = fit(String(data.title || ''), { minPt: 6.5, maxPt: layout === 'vertical' ? 11 : 12, bold: true, maxMm: titleBox.w, maxLines: 2, maxHeightMm: z.header.h, lineFactor: 1.15 });
    if (title.lines.length && title.lines[0]) {
        const lh = title.sizePt * PT * 1.15;
        const blockH = lh * title.lines.length;
        let y = z.header.y + (z.header.h - blockH) / 2 + title.sizePt * PT * 0.82;
        for (const l of title.lines) { text(titleBox.x, y, title.sizePt, true, colors.text, l); y += lh; }
    }
    // Accent rule under the header.
    items.push({ t: 'rect', x: z.accent.x, y: z.accent.y, w: z.accent.w, h: z.accent.h, fill: colors.accent });

    // The name: as large as fits, up to 2 lines.
    const name = fit(String(data.name || ''), { minPt: 8, maxPt: layout === 'vertical' ? 18 : 17, bold: true, maxMm: z.name.w, maxLines: 2, maxHeightMm: z.name.h, lineFactor: 1.1 });
    {
        const lh = name.sizePt * PT * 1.1;
        let y = z.name.y + name.sizePt * PT * 0.82 + Math.max(0, (z.name.h - lh * name.lines.length) / 2);
        for (const l of name.lines) { text(z.name.x, y, name.sizePt, true, colors.text, l); y += lh; }
    }

    // The chosen fields, one per row: «LABEL value», as many as the zone holds.
    const { rowH, valuePt, labelPt } = rowMetrics(layout);
    const maxRows = rowsOf(layout);
    let y = z.lines.y + valuePt * PT * 0.82;
    let shown = 0;
    for (const line of (data.lines || [])) {
        if (shown >= maxRows) break;
        const value = line && line.value != null ? String(line.value).trim() : '';
        if (!value) continue;
        let x = z.lines.x;
        if (line.label) {
            const label = ellipsize(String(line.label).toUpperCase(), labelPt, true, z.lines.w * 0.45);
            text(x, y, labelPt, true, colors.label, label);
            x += textWidthMm(label, labelPt, true) + 1.4;
        }
        text(x, y, valuePt, false, colors.text, ellipsize(value, valuePt, false, z.lines.x + z.lines.w - x));
        y += rowH;
        shown++;
    }

    // The code: a white panel with the QR (its quiet zone inside) and the code in letters. Never optional.
    // Landscape: the QR on top of the right column and the code under it, the panel sized to both and centred
    // in the column. Portrait: the QR at the left of the bottom strip and the code beside it, larger.
    const code = printable(String(data.code || '')).replace(/[^\x20-\x7e]/g, '');
    if (!code) {
        items.push({ t: 'rect', x: z.code.x, y: z.code.y, w: z.code.w, h: z.code.h, fill: '#ffffff', r: 1.6 });
    } else {
        // What the QR carries: the «Mi inscripción» link when given (2.23.0), else the code itself.
        const qrText = data.qr ? String(data.qr).replace(/[^\x20-\x7e]/g, '').slice(0, 300) || code : code;
        const qr = encodeQr(qrText, eclFor(qrText));
        const span = qr.size + 2 * QR_QUIET;
        const pad = 1;
        if (layout === 'vertical') {
            const side = z.code.h - 2 * pad;
            const module = side / span;
            items.push({ t: 'rect', x: z.code.x, y: z.code.y, w: z.code.w, h: z.code.h, fill: '#ffffff', r: 1.6 });
            items.push({ t: 'qr', x: r2(z.code.x + pad + QR_QUIET * module), y: r2(z.code.y + pad + QR_QUIET * module), module: r4(module), size: qr.size, rows: qrRows(qr) });
            const tx0 = z.code.x + pad + side + 1.5, tw = z.code.x + z.code.w - 1.5 - tx0;
            const codePt = Math.min(11, fitPt(code, tw));
            text(tx0 + (tw - textWidthMm(code, codePt, true)) / 2, z.code.y + z.code.h / 2 + codePt * PT * 0.35, codePt, true, '#111111', code);
        } else {
            const side = z.code.w - 2 * pad;
            const module = side / span;
            const codePt = Math.min(7.5, fitPt(code, z.code.w - 2));
            const panelH = pad + side + codePt * PT * 1.3 + pad;
            const py = z.code.y + Math.max(0, (z.code.h - panelH) / 2);
            items.push({ t: 'rect', x: z.code.x, y: r2(py), w: z.code.w, h: r2(panelH), fill: '#ffffff', r: 1.6 });
            items.push({ t: 'qr', x: r2(z.code.x + pad + QR_QUIET * module), y: r2(py + pad + QR_QUIET * module), module: r4(module), size: qr.size, rows: qrRows(qr) });
            text(z.code.x + (z.code.w - textWidthMm(code, codePt, true)) / 2, py + pad + side + codePt * PT * 0.95, codePt, true, '#111111', code);
        }
    }

    const plate = design && design.plate && design.plate.sha ? { sha: String(design.plate.sha) } : null;
    return { layout, w_mm: z.w, h_mm: z.h, background: colors.background, plate, items };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
/** The largest size (pt, half-point steps, at least 5) at which `s` in bold fits `maxMm`. */
function fitPt(s, maxMm) {
    let pt = 12;
    while (pt > 5 && textWidthMm(s, pt, true) > maxMm) pt -= 0.5;
    return pt;
}
// The field rows: a landscape card holds 3 (smaller type), a portrait one 6.
const rowMetrics = (layout) => (layout === 'vertical' ? { rowH: 3.9, valuePt: 8.5, labelPt: 6 } : { rowH: 3.55, valuePt: 7.6, labelPt: 5.5 });
/** How many field rows a layout prints (the designer says so; the rest are not printed). */
function rowsOf(layout) { return Math.max(0, Math.floor(zonesOf(layout === 'vertical' ? 'vertical' : 'horizontal').lines.h / rowMetrics(layout).rowH)); }

module.exports = { buildBadge, zonesOf, rowsOf, CARD, LAYOUTS, DEFAULT_COLORS, QR_ECL, QR_QUIET };
