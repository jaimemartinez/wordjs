/**
 * Code 128 (subset B) barcodes for the registration codes — no dependency, pure functions.
 *
 * `code128Widths(text)` returns the run-length widths of the symbol, bar first (start B, data, check
 * symbol, stop), in modules. `code128Svg()` renders it as an SVG string (admin page, print view) and
 * `code128Png()` rasterises it in the browser for the Excel export. The registration codes only use
 * A-Z and 2-9, which subset B encodes directly; any printable ASCII (32-126) is accepted.
 */

// Width patterns for values 0-105 (6 elements, 11 modules each) and the stop symbol (7 elements, 13).
const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232',
];
const STOP = '2331112';
const START_B = 104;
/** Light modules on each side (the specification asks for at least 10). */
export const QUIET_ZONE = 10;

export function code128Values(text: string): number[] {
    const s = String(text ?? '');
    if (!s.length) throw new Error('code128: empty text');
    const values = [START_B];
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 32 || c > 126) throw new Error(`code128: character not encodable in subset B (${JSON.stringify(ch)})`);
        values.push(c - 32);
    }
    let sum = START_B;
    for (let i = 1; i < values.length; i++) sum += values[i] * i;
    values.push(sum % 103);
    return values;
}

/** Bar/space widths in modules, bar first, start + data + check + stop (no quiet zone). */
export function code128Widths(text: string): number[] {
    const widths: number[] = [];
    for (const v of code128Values(text)) for (const d of PATTERNS[v]) widths.push(Number(d));
    for (const d of STOP) widths.push(Number(d));
    return widths;
}

export type BarcodeOptions = {
    /** Pixels per module (default 2). */
    module?: number;
    /** Bar height in pixels (default 50). */
    height?: number;
    /** Print the text under the bars (default true). */
    showText?: boolean;
    /** Font size of the text (default 12). */
    fontSize?: number;
};

function layout(text: string, o: BarcodeOptions) {
    const module = o.module ?? 2;
    const height = o.height ?? 50;
    const showText = o.showText ?? true;
    const fontSize = o.fontSize ?? 12;
    const widths = code128Widths(text);
    const totalModules = widths.reduce((a, b) => a + b, 0) + 2 * QUIET_ZONE;
    const bars: { x: number; w: number }[] = [];
    let x = QUIET_ZONE * module;
    widths.forEach((w, i) => { if (i % 2 === 0) bars.push({ x, w: w * module }); x += w * module; });
    const width = totalModules * module;
    const fullHeight = height + (showText ? fontSize + 6 : 0);
    return { bars, width, height, fullHeight, showText, fontSize };
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** The barcode as a standalone SVG document string (white background, black bars). */
export function code128Svg(text: string, opts: BarcodeOptions = {}): string {
    const l = layout(text, opts);
    const rects = l.bars.map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="${l.height}"/>`).join('');
    const label = l.showText
        ? `<text x="${l.width / 2}" y="${l.height + l.fontSize + 2}" text-anchor="middle" font-family="monospace" font-size="${l.fontSize}" fill="#000">${escapeXml(text)}</text>`
        : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.fullHeight}" viewBox="0 0 ${l.width} ${l.fullHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g>${label}</svg>`;
}

/** Rasterise the barcode to PNG bytes in the browser (canvas). Returns the bytes and the pixel size. */
/** Same shape as exports.ts BarcodeImage, so the Excel export can use the result as is. */
export async function code128Png(text: string, opts: BarcodeOptions = {}): Promise<{ png: Uint8Array; width: number; height: number }> {
    const l = layout(text, opts);
    const canvas = document.createElement('canvas');
    canvas.width = l.width;
    canvas.height = l.fullHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('code128: canvas 2D context unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, l.width, l.fullHeight);
    ctx.fillStyle = '#000';
    for (const b of l.bars) ctx.fillRect(b.x, 0, b.w, l.height);
    if (l.showText) {
        ctx.font = `${l.fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(text, l.width / 2, l.height + 3);
    }
    const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('code128: PNG encoding failed'))), 'image/png'));
    return { png: new Uint8Array(await blob.arrayBuffer()), width: l.width, height: l.fullHeight };
}
