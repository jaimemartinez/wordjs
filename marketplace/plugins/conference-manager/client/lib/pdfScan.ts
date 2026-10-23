// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
/**
 * The pages of a scanned PDF as images (2.36.3), to show a signed sheet in place — never a download, never a new
 * window (the admin's sandboxed frame and some phones have no PDF viewer). A scan or a phone's «scan to PDF» is one
 * picture per page, so each page's image XObject is taken out of the file as it is:
 *   - DCTDecode (JPEG): its bytes, shown as a JPEG;
 *   - FlateDecode (8-bit gray or RGB, with or without the PNG predictors): inflated in the browser
 *     (DecompressionStream) and drawn as a PNG;
 *   - anything else (JPEG 2000, fax, JBIG2), or a PDF with no picture in it (typed, not scanned): not shown, and
 *     the screen says so.
 * Small images (logos, masks) are left out; pages keep the file's order.
 */

export type ScanPage = { kind: 'jpeg'; bytes: Uint8Array; width: number; height: number }
    | { kind: 'raw'; bytes: Uint8Array; width: number; height: number; colors: 1 | 3; bpc: number; predictor: number; columns: number }
    | { kind: 'unsupported'; filter: string; width: number; height: number };

const MIN_SIDE = 200;
const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as any); return s; };
const num = (dict: string, key: string) => { const m = new RegExp(`/${key}\\s+(\\d+)\\b(?!\\s+\\d+\\s+R)`).exec(dict); return m ? Number(m[1]) : null; };
const filtersOf = (dict: string): string[] => {
    const m = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
    return m ? (m[1].match(/\/[A-Za-z0-9]+/g) || []).map((f) => f.slice(1)) : [];
};

/** The text of object `n 0 obj … endobj` (for a value given by reference, «7 0 R»). */
function objectText(text: string, n: number): string {
    const m = new RegExp(`(?:^|[\\r\\n\\s])${n}\\s+0\\s+obj\\b`).exec(text);
    if (!m) return '';
    const end = text.indexOf('endobj', m.index);
    return text.slice(m.index, end < 0 ? undefined : end);
}
/** Channels of an image's colour space: 1 (gray), 3 (RGB), or 0 (one this viewer does not draw). */
function colorsOf(dict: string, text: string, depth = 0): number {
    const ref = /\/ColorSpace\s*(\d+)\s+0\s+R/.exec(dict);
    const cs = ref && depth < 3 ? objectText(text, Number(ref[1])) : dict;
    if (/\/DeviceGray|\/CalGray/.test(cs) && !/\/DeviceRGB|\/CalRGB/.test(cs)) return 1;
    if (/\/DeviceRGB|\/CalRGB/.test(cs)) return 3;
    // [/ICCBased <stream>]: the profile's /N says how many channels.
    const icc = /\/ICCBased\s*(\d+)\s+0\s+R/.exec(cs);
    if (icc) { const n = num(objectText(text, Number(icc[1])), 'N'); return n === 1 || n === 3 ? n : 0; }
    return 0;
}

/** The page images of a PDF's bytes, in order (no decoding yet: see `pageUrl`). */
export function scanPages(bytes: Uint8Array): ScanPage[] {
    const text = latin1(bytes);
    if (!text.startsWith('%PDF-')) return [];
    const out: ScanPage[] = [];
    const re = /\/Subtype\s*\/Image/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        // The image's dictionary: from the last «<<» that opens it to the «stream» keyword after it.
        const start = text.lastIndexOf('obj', m.index);
        const streamAt = text.indexOf('stream', m.index);
        if (start < 0 || streamAt < 0) continue;
        const dict = text.slice(start, streamAt);
        if (/\/ImageMask\s+true/.test(dict)) continue;
        const width = num(dict, 'Width') || 0, height = num(dict, 'Height') || 0;
        if (width < MIN_SIDE && height < MIN_SIDE) continue;
        let from = streamAt + 6;
        if (text[from] === '\r') from++;
        if (text[from] === '\n') from++;
        const len = num(dict, 'Length');
        const end = len != null && text.slice(from + len, from + len + 20).includes('endstream') ? from + len : text.indexOf('endstream', from);
        if (end < 0) continue;
        re.lastIndex = end;
        const data = bytes.subarray(from, end);
        const filters = filtersOf(dict);
        const colors = colorsOf(dict, text);
        if (filters.length === 1 && filters[0] === 'DCTDecode') out.push({ kind: 'jpeg', bytes: data, width, height });
        else if (filters.length === 1 && filters[0] === 'FlateDecode' && colors && (num(dict, 'BitsPerComponent') || 8) === 8) {
            out.push({ kind: 'raw', bytes: data, width, height, colors: colors as 1 | 3, bpc: 8, predictor: num(dict, 'Predictor') || 1, columns: num(dict, 'Columns') || width });
        } else out.push({ kind: 'unsupported', filter: filters.join('+') || 'none', width, height });
    }
    return out;
}

/** Undo the PNG predictors (Predictor ≥ 10): one filter byte per row, then the row. */
export function unpredict(data: Uint8Array, width: number, bpp: number): Uint8Array {
    const stride = width * bpp, rows = Math.floor(data.length / (stride + 1));
    const out = new Uint8Array(rows * stride);
    for (let y = 0; y < rows; y++) {
        const f = data[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - stride + x] : 0, c = y && x >= bpp ? out[dst - stride + x - bpp] : 0;
            const v = data[src + x];
            let p = 0;
            if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
            else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            out[dst + x] = (v + p) & 0xff;
        }
    }
    return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const ds = new (globalThis as any).DecompressionStream('deflate');
    const buf = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
}

/** A Flate page's pixels: `colors` bytes per pixel, row after row. */
export async function rawPixels(p: ScanPage & { kind: 'raw' }): Promise<Uint8Array> {
    const px = await inflate(p.bytes);
    return p.predictor >= 10 ? unpredict(px, p.columns, p.colors) : px;
}

/** A page as a URL an <img> shows (a blob: URL; the caller revokes it), or null when it cannot be drawn here. */
export async function pageUrl(p: ScanPage): Promise<string | null> {
    if (p.kind === 'jpeg') return URL.createObjectURL(new Blob([p.bytes], { type: 'image/jpeg' }));
    if (p.kind !== 'raw' || typeof (globalThis as any).DecompressionStream !== 'function') return null;
    const px = await rawPixels(p);
    const canvas = document.createElement('canvas');
    canvas.width = p.width; canvas.height = p.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(p.width, p.height);
    for (let i = 0, j = 0; i < p.width * p.height; i++) {
        if (p.colors === 1) { const g = px[i]; img.data[j++] = g; img.data[j++] = g; img.data[j++] = g; }
        else { img.data[j++] = px[i * 3]; img.data[j++] = px[i * 3 + 1]; img.data[j++] = px[i * 3 + 2]; }
        img.data[j++] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob: Blob = await new Promise((resolve) => canvas.toBlob(resolve as any, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
}

/** The bytes of a data: URL. */
export function dataUrlBytes(url: string): Uint8Array {
    const b64 = String(url || '').replace(/^data:[^,]*;base64,/, '');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
