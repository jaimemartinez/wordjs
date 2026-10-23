// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
/**
 * The free-form badge designer's helpers (conference-manager 2.29.0): the faces (fetched once, registered with
 * the browser AND parsed, so the designer lays out with the server's own numbers), the templates, the
 * conversion of a pre-2.29 design, and the images (scaled and re-encoded before upload).
 *
 * The model and the layout are the server's own modules (server/badge-design.js, server/badge-font.js): the
 * designer draws exactly what the PDF prints.
 */
import { createMetrics, parseTtf, faceOf, FONTS } from '../../server/badge-font';
import { normalizeDesignV2, layoutDesign, cardOf } from '../../server/badge-design';
import { adoptBadgeFace, badgeFontFamily } from '../admin/BadgeSvg';
import { loadImage, readFile } from './badges';

export { normalizeDesignV2, layoutDesign, cardOf, FONTS, faceOf };

const FONT_API = '/api/v1/plugin/conference-manager/public/badge/font';

// ── faces ──
const parsed = new Map<string, any>();
const pending = new Map<string, Promise<boolean>>();
/** Fetch, register and parse a face; resolves true once the designer can measure and draw with it. */
export function loadFace(face: string | null): Promise<boolean> {
    if (!face) return Promise.resolve(true);
    if (parsed.has(face)) return Promise.resolve(true);
    let p = pending.get(face);
    if (!p) {
        p = (async () => {
            try {
                const res = await fetch(`${FONT_API}?f=${encodeURIComponent(face)}`, { credentials: 'omit' });
                if (!res.ok) return false;
                const { b64 } = await res.json();
                const bin = atob(String(b64 || ''));
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                if (typeof FontFace !== 'undefined') {
                    const ff = new FontFace(badgeFontFamily(face), bytes.buffer.slice(0));
                    await ff.load();
                    document.fonts.add(ff);
                }
                parsed.set(face, parseTtf(bytes));
                return true;
            } catch { return false; }
        })();
        pending.set(face, p);
        adoptBadgeFace(face, p);
        p.then((ok) => { if (!ok) pending.delete(face); });
    }
    return p;
}
/** The designer's measurer: a face not loaded yet measures as Helvetica until it arrives. */
export const editorMetrics = createMetrics((face: string) => parsed.get(face) || null);
export const faceLoaded = (face: string | null) => !face || parsed.has(face);
export const familyCss = (fontId: string, bold = false) => {
    const face = faceOf(fontId, bold);
    return face ? `'${badgeFontFamily(face)}', Helvetica, Arial, sans-serif` : 'Helvetica, Arial, sans-serif';
};

// ── ids ──
let seq = 0;
export const newId = () => `e${Date.now().toString(36).slice(-4)}${(seq++).toString(36)}`;

// ── templates ──
const T = (type: string, props: any) => ({ id: newId(), type, rot: 0, op: 1, ...props });
const text = (x, y, w, h, value, font, size, color, more = {}) => T('text', { x, y, w, h, text: value, font, size, color, bold: false, align: 'left', valign: 'top', upper: false, ls: 0, lh: 1.15, fit: 'shrink', ...more });
const rect = (x, y, w, h, fill, more = {}) => T('shape', { shape: 'rect', x, y, w, h, fill, stroke: null, sw: 0, r: 0, ...more });
const ellipse = (x, y, w, h, fill, more = {}) => T('shape', { shape: 'ellipse', x, y, w, h, fill, stroke: null, sw: 0, r: 0, ...more });
const line = (x, y, w, stroke, sw) => T('line', { x, y: y - 0.5, w, h: 1, stroke, sw });
const qr = (x, y, side, bg = true) => T('qr', { x, y, w: side, h: side, bg });

export const TEMPLATES = [
    {
        id: 'noche', name: 'Noche azul', make: () => ({
            version: 2, layout: 'horizontal', background: '#0f172a', elements: [
                rect(0, 0, 85.6, 13, '#1e3a8a'),
                rect(0, 13, 85.6, 0.8, '#f59e0b'),
                text(5, 2, 75.6, 9, '{{@conference}}', 'oswald', 11, '#ffffff', { bold: true, upper: true, ls: 0.6, valign: 'middle' }),
                text(5, 18, 52, 16, '{{@name}}', 'montserrat', 18, '#ffffff', { bold: true, valign: 'middle' }),
                text(5, 36, 52, 6, '{{@location}}', 'poppins', 9, '#fbbf24', { upper: true, ls: 0.5 }),
                text(5, 45, 52, 5, '{{@code}}', 'roboto', 7, '#94a3b8', { ls: 1 }),
                qr(60.6, 22, 21),
            ],
        }),
    },
    {
        id: 'moderna', name: 'Blanca moderna', make: () => ({
            version: 2, layout: 'horizontal', background: '#ffffff', elements: [
                rect(0, 0, 6, 54, '#2563eb'),
                rect(6, 0, 1.2, 54, '#93c5fd'),
                text(11, 5, 48, 6, '{{@conference}}', 'poppins', 8, '#2563eb', { bold: true, upper: true, ls: 1.2 }),
                text(11, 14, 46, 18, '{{@name}}', 'poppins', 17, '#0f172a', { bold: true, valign: 'middle' }),
                line(11, 34.5, 20, '#2563eb', 0.6),
                text(11, 37, 46, 6, '{{@location}}', 'poppins', 9, '#475569'),
                text(11, 45, 46, 5, '{{@dates}}', 'poppins', 7, '#94a3b8'),
                qr(61, 15, 21),
                text(61, 37.5, 21, 4, '{{@code}}', 'roboto', 6.5, '#0f172a', { bold: true, align: 'center', ls: 0.8 }),
            ],
        }),
    },
    {
        id: 'elegante', name: 'Elegante', make: () => ({
            version: 2, layout: 'horizontal', background: '#fdf8f0', elements: [
                rect(2.5, 2.5, 80.6, 49, null, { stroke: '#b08d57', sw: 0.35, r: 1.5 }),
                text(6, 6.5, 52, 6, '{{@conference}}', 'playfair', 8, '#8a6a3a', { upper: true, ls: 1.5 }),
                text(6, 15, 52, 18, '{{@name}}', 'playfair', 18, '#1f2937', { bold: true, valign: 'middle' }),
                line(6, 35.5, 14, '#b08d57', 0.4),
                text(6, 38, 52, 6, '{{@location}}', 'lato', 9, '#4b5563'),
                qr(61, 16, 20),
                text(61, 37, 20, 4, '{{@code}}', 'lato', 6, '#8a6a3a', { bold: true, align: 'center', ls: 1 }),
            ],
        }),
    },
    {
        id: 'evento', name: 'Evento vertical', make: () => ({
            version: 2, layout: 'vertical', background: '#ffffff', elements: [
                rect(0, 0, 54, 26, '#7c3aed'),
                ellipse(34, -10, 32, 32, '#a78bfa', { op: 0.45 }),
                ellipse(-8, 14, 20, 20, '#6d28d9', { op: 0.5 }),
                text(5, 5, 44, 16, '{{@conference}}', 'montserrat', 11, '#ffffff', { bold: true, align: 'center', valign: 'middle', upper: true, ls: 0.5 }),
                text(4, 30, 46, 16, '{{@name}}', 'montserrat', 16, '#111827', { bold: true, align: 'center', valign: 'middle' }),
                rect(9, 48, 36, 7, '#ede9fe', { r: 3.5 }),
                text(9, 48, 36, 7, '{{@location}}', 'montserrat', 7.5, '#6d28d9', { bold: true, align: 'center', valign: 'middle', upper: true, ls: 0.5 }),
                qr(16, 58, 22),
                text(8, 81, 38, 3.5, '{{@code}}', 'roboto', 6, '#6b7280', { bold: true, align: 'center', ls: 1 }),
            ],
        }),
    },
    {
        id: 'minimal', name: 'Minimal', make: () => ({
            version: 2, layout: 'vertical', background: '#f8fafc', elements: [
                rect(-20, -6, 94, 20, '#0ea5e9', { rot: 348 }),
                rect(-20, 10, 94, 2.5, '#0284c7', { rot: 348 }),
                text(5, 29, 44, 16, '{{@name}}', 'raleway', 16, '#0f172a', { bold: true, align: 'center', valign: 'middle' }),
                text(5, 47, 44, 6, '{{@location}}', 'raleway', 9, '#0284c7', { align: 'center', upper: true, ls: 1 }),
                qr(16, 57, 22),
                text(4, 80.5, 46, 4, '{{@conference}}', 'raleway', 6, '#64748b', { bold: true, align: 'center', upper: true, ls: 0.8 }),
            ],
        }),
    },
    {
        id: 'juvenil', name: 'Juvenil', make: () => ({
            version: 2, layout: 'vertical', background: '#111827', elements: [
                ellipse(-14, -14, 50, 50, '#f43f5e', { op: 0.85 }),
                ellipse(26, -6, 40, 40, '#f59e0b', { op: 0.8 }),
                text(4, 4, 46, 10, '{{@conference}}', 'bebas', 14, '#ffffff', { align: 'center', valign: 'middle', ls: 1 }),
                text(3, 27, 48, 18, '{{@name}}', 'bebas', 24, '#ffffff', { align: 'center', valign: 'middle', ls: 0.5 }),
                text(4, 47, 46, 6, '{{@location}}', 'poppins', 8, '#fbbf24', { bold: true, align: 'center', upper: true, ls: 1 }),
                qr(16, 57, 22),
                text(8, 80.5, 38, 4, '{{@code}}', 'poppins', 6, '#e5e7eb', { align: 'center', ls: 1 }),
            ],
        }),
    },
];

// ── stickers (2.36.0) ──
/**
 * The label sizes offered for «Sticker para imprimir» (mm, as designed: width × height). Brother QL's 62 mm roll
 * cut at 100 mm is the default; any other size is typed in mm («Personalizado»).
 */
export const STICKER_PRESETS: { id: string; w: number; h: number; label: string }[] = [
    { id: '62x100', w: 62, h: 100, label: '62 × 100 mm' },
    { id: '62x29', w: 62, h: 29, label: '62 × 29 mm' },
    { id: '100x50', w: 100, h: 50, label: '100 × 50 mm' },
    { id: '4x6', w: 101.6, h: 152.4, label: '4 × 6 in' },
    { id: '2x1', w: 50.8, h: 25.4, label: '2 × 1 in' },
];
export const STICKER_MM = { min: 15, max: 220 };
export const presetOf = (size: { w: number; h: number } | null | undefined) =>
    (size && STICKER_PRESETS.find(p => (p.w === size.w && p.h === size.h) || (p.w === size.h && p.h === size.w))) || null;

/**
 * The design moved to another label size: every element keeps its place and proportion on the label (x and widths
 * scale with the width, y and heights with the height), texts by the smaller of the two, the QR stays square.
 */
export function scaleDesign(d: any, size: { w: number; h: number }) {
    const from = cardOf(d.layout, d.size);
    const sx = size.w / from.w, sy = size.h / from.h, k = Math.min(sx, sy);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const elements = (d.elements || []).map((e: any) => {
        if (e.type === 'qr') {
            const side = r2(Math.max(14, Math.min(e.w * k, size.w, size.h)));
            const cx = (e.x + e.w / 2) * sx, cy = (e.y + e.h / 2) * sy;
            return { ...e, w: side, h: side, x: r2(cx - side / 2), y: r2(cy - side / 2) };
        }
        const out = { ...e, x: r2(e.x * sx), y: r2(e.y * sy), w: r2(e.w * sx), h: r2(e.h * sy) };
        if (e.type === 'text') out.size = r2(Math.max(3, e.size * k));
        if (e.type === 'line' || (e.type === 'shape' && e.sw)) out.sw = r2(e.sw * k);
        return out;
    });
    return normalizeDesignV2({ ...d, size: { w: size.w, h: size.h }, elements });
}

const S = (size: { w: number; h: number }, elements: any[]) => ({ version: 2, layout: 'sticker', size, background: '#ffffff', elements });
/**
 * Sticker starting points, each drawn for a tall (62 × 100 mm) or a wide (62 × 29 mm) label and scaled to the label
 * in use; `wide` says which. Black on white: label printers are thermal.
 */
export const STICKER_TEMPLATES = [
    {
        id: 'st-classic', name: 'Nombre, grupo y QR', make: () => S({ w: 62, h: 100 }, [
            text(3, 4, 56, 22, '{{@name}}', 'montserrat', 20, '#000000', { bold: true, align: 'center', valign: 'middle', lh: 1.1 }),
            text(3, 27, 56, 8, '{{@location}}', 'montserrat', 11, '#000000', { align: 'center', valign: 'middle', upper: true, ls: 0.5 }),
            { ...text(11, 37, 40, 33, '{{@meal_group}}', 'montserrat', 72, '#000000', { bold: true, align: 'center', valign: 'middle' }), name: 'Grupo de comida' },
            qr(19, 73, 24, false),
        ]),
    },
    {
        id: 'st-group', name: 'Grupo grande', make: () => S({ w: 62, h: 100 }, [
            { ...text(4, 3, 54, 52, '{{@meal_group}}', 'montserrat', 150, '#000000', { bold: true, align: 'center', valign: 'middle' }), name: 'Grupo de comida' },
            line(6, 58, 50, '#000000', 0.6),
            text(3, 61, 56, 20, '{{@name}}', 'montserrat', 18, '#000000', { bold: true, align: 'center', valign: 'middle', lh: 1.1 }),
            text(3, 83, 56, 8, '{{@location}}', 'montserrat', 11, '#000000', { align: 'center', valign: 'middle', upper: true, ls: 0.5 }),
        ]),
    },
    {
        id: 'st-band', name: 'Franja con el grupo', make: () => S({ w: 62, h: 100 }, [
            rect(0, 0, 62, 30, '#000000'),
            { ...text(3, 1, 56, 28, '{{@meal_group}}', 'montserrat', 64, '#ffffff', { bold: true, align: 'center', valign: 'middle' }), name: 'Grupo de comida' },
            text(3, 33, 56, 20, '{{@name}}', 'montserrat', 18, '#000000', { bold: true, align: 'center', valign: 'middle', lh: 1.1 }),
            text(3, 54, 56, 8, '{{@location}}', 'montserrat', 11, '#000000', { align: 'center', valign: 'middle', upper: true, ls: 0.5 }),
            qr(20, 70, 22, false),
        ]),
    },
    {
        id: 'st-wide', name: 'Etiqueta ancha', wide: true, make: () => S({ w: 62, h: 29 }, [
            text(2.5, 2, 39, 14, '{{@name}}', 'montserrat', 15, '#000000', { bold: true, valign: 'middle', lh: 1.05 }),
            text(2.5, 17, 39, 9, '{{@location}}', 'montserrat', 9, '#000000', { valign: 'middle', upper: true, ls: 0.4 }),
            { ...line(29.5, 14.5, 25, '#000000', 0.5), rot: 90 },
            { ...text(44, 1.5, 16, 26, '{{@meal_group}}', 'montserrat', 56, '#000000', { bold: true, align: 'center', valign: 'middle' }), name: 'Grupo de comida' },
        ]),
    },
];
/** The starting point that fits a label's shape: the wide one for a wide label, else the first tall one. */
export const stickerTemplateFor = (size: { w: number; h: number }) =>
    STICKER_TEMPLATES.find(t => !!(t as any).wide === (size.w > size.h * 1.3)) || STICKER_TEMPLATES[0];

/**
 * A pre-2.29 design (orientation, colours, panel, title, chosen fields, background and logo images) as a
 * free-form one that looks the same; `images` = { bg, logo } image ids already uploaded (or null).
 */
export function fromLegacy(d: any, zones: any, images: { bg?: { id: string } | null; logo?: { id: string } | null }, labelOf: (k: string) => string, rows: number) {
    const layout = d && d.layout === 'vertical' ? 'vertical' : 'horizontal';
    const z = zones && zones[layout];
    const c = (d && d.colors) || {};
    const card = cardOf(layout);
    const els: any[] = [];
    if (images.bg) els.push(T('image', { x: 0, y: 0, w: card.w, h: card.h, asset: images.bg.id, fit: 'cover', r: 0, mask: 'none' }));
    if (!z) return normalizeDesignV2({ version: 2, layout, background: c.background || '#1e3a8a', elements: els });
    if (d.panel === 'light' || d.panel === 'dark') els.push(rect(z.panel.x, z.panel.y, z.panel.w, z.panel.h, d.panel === 'light' ? '#ffffff' : '#000000', { op: d.panel === 'light' ? 0.85 : 0.55, r: 1.5 }));
    let titleX = z.header.x;
    if (images.logo) { els.push(T('image', { x: z.logo.x, y: z.logo.y, w: z.logo.w, h: z.logo.h, asset: images.logo.id, fit: 'contain', r: 0, mask: 'none' })); titleX += z.logo.w + 2; }
    els.push(text(titleX, z.header.y, z.header.x + z.header.w - titleX, z.header.h, d.title || '{{@conference}}', 'helvetica', layout === 'vertical' ? 11 : 12, c.text || '#ffffff', { bold: true, valign: 'middle', lh: 1.15 }));
    els.push(rect(z.accent.x, z.accent.y, z.accent.w, z.accent.h, c.accent || '#fbbf24'));
    els.push(text(z.name.x, z.name.y, z.name.w, z.name.h, '{{@name}}', 'helvetica', layout === 'vertical' ? 18 : 17, c.text || '#ffffff', { bold: true, valign: 'middle', lh: 1.1 }));
    const rowH = layout === 'vertical' ? 3.9 : 3.55;
    (d.fields || []).slice(0, rows).forEach((f: any, i: number) => {
        const lbl = f.show_label ? `${String(f.label || labelOf(f.key)).toUpperCase()}  ` : '';
        els.push(text(z.lines.x, z.lines.y + i * rowH, z.lines.w, rowH, `${lbl}{{${f.key}}}`, 'helvetica', layout === 'vertical' ? 8.5 : 7.6, c.text || '#ffffff', { valign: 'middle', lh: 1 }));
    });
    // The white code panel: the QR and the code in letters on it, as before.
    if (layout === 'vertical') {
        els.push(rect(z.code.x, z.code.y, z.code.w, z.code.h, '#ffffff', { r: 1.6 }));
        els.push(qr(z.code.x, z.code.y, z.code.h, false));
        els.push(text(z.code.x + z.code.h + 1, z.code.y, z.code.w - z.code.h - 2, z.code.h, '{{@code}}', 'helvetica', 11, '#111111', { bold: true, valign: 'middle', align: 'center' }));
    } else {
        els.push(rect(z.code.x, z.code.y, z.code.w, z.code.w + 4.5, '#ffffff', { r: 1.6 }));
        els.push(qr(z.code.x, z.code.y, z.code.w, false));
        els.push(text(z.code.x, z.code.y + z.code.w, z.code.w, 4, '{{@code}}', 'helvetica', 7.5, '#111111', { bold: true, align: 'center', valign: 'middle' }));
    }
    return normalizeDesignV2({ version: 2, layout, background: c.background || '#1e3a8a', elements: els });
}

// ── images ──
/**
 * A picked image ready for upload: at most `max` px on its longer side, JPEG when it is opaque (smaller), PNG
 * when it has transparency (a logo) — a browser canvas writes both in the forms the PDF reads.
 */
export async function prepareImage(file: File, max = 1600): Promise<{ url: string; w: number; h: number }> {
    if (!/^image\//.test(file.type || '')) throw new Error('Elige una imagen (JPG, PNG, WebP…).');
    const raw = await readFile(file);
    const img = await loadImage(raw);
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, w, h);
    let opaque = true;
    try {
        const px = g.getImageData(0, 0, w, h).data;
        for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { opaque = false; break; }
    } catch { opaque = false; }
    if (opaque) return { url: c.toDataURL('image/jpeg', 0.9), w, h };
    return { url: c.toDataURL('image/png'), w, h };
}

/** The sample person the designer shows (tokens → values). */
export function sampleData(conference: any, available: any[]): Record<string, string> {
    const data: Record<string, string> = {
        '@name': 'María Fernanda Gómez', '@code': 'ABCD2345EF', '@location': 'Barranquilla', '@room': 'Hotel Central · 204',
        '@dates': '12 – 14 oct 2026', '@conference': (conference && conference.name) || 'Congreso Nacional', '@meal_group': 'C',
    };
    for (const f of available || []) if (!f.key.startsWith('@')) data[f.key] = f.label || f.key;
    return data;
}
