/**
 * QR Codes for the registration codes (2.22.0) — no dependency, pure functions. The server draws the badges
 * with its own copy (server/badge-qr.js); a parity test keeps the two equal and a round-trip test decodes them.
 *
 * `encodeQr(text, ecl)` returns the module matrix (ISO/IEC 18004 model 2, versions 1-10; alphanumeric mode when
 * every character allows it — the registration codes: A-Z and 2-9 — else UTF-8 bytes; the smallest version
 * that holds the text, the mask with the lowest penalty). `qrSvg()` renders it as an SVG string (the code
 * viewer, its print view) and `qrPng()` rasterises it in the browser for the Excel export.
 */

export type QrEcl = 'L' | 'M' | 'Q' | 'H';
export type Qr = { version: number; size: number; modules: boolean[][] };

const MAX_VERSION = 10;
// Per version 1-10 (index 0 unused), from the specification's table 9.
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcl, number[]> = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_ERROR_CORRECTION_BLOCKS: Record<QrEcl, number[]> = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const FORMAT_BITS: Record<QrEcl, number> = { L: 1, M: 0, Q: 3, H: 2 };
export const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
/** The level the registration codes are drawn with: the highest (version 1 still holds 10 characters). */
export const REG_CODE_ECL: QrEcl = 'H';
/** The level for what a badge QR carries (server/badge-layout.js eclFor): H for a bare code, M for the «Mi inscripción» link. */
export const eclFor = (text: string): QrEcl => (text.length <= 20 ? 'H' : 'M');

function rawDataModules(ver: number): number {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}
const dataCodewords = (ver: number, ecl: QrEcl) => Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];

function alignmentPositions(ver: number, size: number): number[] {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}
function rsDivisor(degree: number): number[] {
    const result: number[] = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
    const result: number[] = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ (result.shift() as number);
        result.push(0);
        for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
}

/** The payload as bits: mode, character count, data (alphanumeric when possible, else UTF-8 bytes). */
function segmentBits(text: string) {
    const alnum = text.length > 0 && [...text].every((ch) => ALPHANUMERIC.includes(ch));
    const bits: number[] = [];
    const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    if (alnum) {
        for (let i = 0; i + 1 < text.length; i += 2) push(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
        if (text.length % 2) push(ALPHANUMERIC.indexOf(text[text.length - 1]), 6);
        return { mode: 0x2, count: text.length, bits, countBits: (ver: number) => (ver <= 9 ? 9 : 11) };
    }
    const bytes = [...new TextEncoder().encode(text)];
    for (const b of bytes) push(b, 8);
    return { mode: 0x4, count: bytes.length, bits, countBits: (ver: number) => (ver <= 9 ? 8 : 16) };
}

/** Encode `text` as a QR Code (modules[y][x], true = dark, without the quiet zone). */
export function encodeQr(text: string, ecl: QrEcl = 'M'): Qr {
    const s = String(text ?? '');
    if (!s.length) throw new Error('qr: empty text');
    if (!Object.prototype.hasOwnProperty.call(FORMAT_BITS, ecl)) throw new Error('qr: bad error-correction level');
    const seg = segmentBits(s);
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
        if (seg.count >= 1 << seg.countBits(ver)) continue;
        if (4 + seg.countBits(ver) + seg.bits.length <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error('qr: text too long');

    // Data codewords: mode, count, data, terminator, byte padding, pad codewords.
    const capacity = dataCodewords(ver, ecl) * 8;
    const bits: number[] = [];
    const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(seg.mode, 4);
    push(seg.count, seg.countBits(ver));
    for (const b of seg.bits) bits.push(b);
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        data.push(byte);
    }

    // Error correction per block, then interleaved.
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(blockEccLen);
    const blocks: number[][] = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const codewords: number[] = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(block[i]);
        });
    }

    // The matrix: function patterns, then the codewords in the zigzag order.
    const size = ver * 4 + 17;
    const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; isFunction[y][x] = true; };
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx: number, cy: number) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setFn(x, y, dist !== 2 && dist !== 4);
        }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const align = alignmentPositions(ver, size);
    for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask: number) => {
        const d = (FORMAT_BITS[ecl] << 3) | mask;
        let rem = d;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const f = ((d << 10) | rem) ^ 0x5412;
        const bit = (i: number) => ((f >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
        setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
        setFn(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const v = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((v >>> i) & 1) !== 0;
            const a = size - 11 + (i % 3), b = Math.floor(i / 3);
            setFn(a, b, dark); setFn(b, a, dark);
        }
    }
    let n = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y][x] && n < codewords.length * 8) {
                    modules[y][x] = ((codewords[n >>> 3] >>> (7 - (n & 7))) & 1) !== 0;
                    n++;
                }
            }
        }
    }

    const applyMask = (mask: number) => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (isFunction[y][x]) continue;
            let invert: boolean;
            switch (mask) {
                case 0: invert = (x + y) % 2 === 0; break;
                case 1: invert = y % 2 === 0; break;
                case 2: invert = x % 3 === 0; break;
                case 3: invert = (x + y) % 3 === 0; break;
                case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            }
            if (invert) modules[y][x] = !modules[y][x];
        }
    };
    let best = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        applyMask(mask);
        drawFormat(mask);
        const score = penalty(modules);
        if (score < bestScore) { best = mask; bestScore = score; }
        applyMask(mask);
    }
    applyMask(best);
    drawFormat(best);
    return { version: ver, size, modules };
}

/** The specification's mask penalty (rules N1-N4); only used to pick a mask — every mask decodes. */
function penalty(m: boolean[][]): number {
    const size = m.length;
    let score = 0, dark = 0;
    const FINDER_LIKE = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            const at = (b: number) => (pass === 0 ? m[a][b] : m[b][a]);
            let run = 1;
            for (let b = 1; b <= size; b++) {
                if (b < size && at(b) === at(b - 1)) { run++; continue; }
                if (run >= 5) score += 3 + (run - 5);
                run = 1;
            }
            for (let b = 0; b + 11 <= size; b++) {
                for (const pat of FINDER_LIKE) {
                    let match = true;
                    for (let k = 0; k < 11 && match; k++) if ((at(b + k) ? 1 : 0) !== pat[k]) match = false;
                    if (match) score += 40;
                }
            }
        }
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (m[y][x]) dark++;
        if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
}

/** The modules as one '0'/'1' string per row (the badge display list's compact form). */
export const qrRows = (qr: Qr): string[] => qr.modules.map((row) => row.map((d) => (d ? '1' : '0')).join(''));

/**
 * The dark modules of '0'/'1' rows as rectangles, one per horizontal run (what the SVG and the PDF draw):
 * [x, y, width] in modules, height 1.
 */
export function qrRuns(rows: string[]): [number, number, number][] {
    const runs: [number, number, number][] = [];
    rows.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) {
            if (row[x] !== '1') continue;
            let w = 1;
            while (x + w < row.length && row[x + w] === '1') w++;
            runs.push([x, y, w]);
            x += w - 1;
        }
    });
    return runs;
}

export type QrImageOptions = {
    /** Pixels per module (default 6). */
    module?: number;
    /** Light modules around the symbol (default 4, what the specification asks for). */
    quiet?: number;
    /** Print the text under the symbol (default true). */
    showText?: boolean;
    /** Font size of the text (default 14). */
    fontSize?: number;
    /** Error-correction level (default eclFor(text): H for a code, M for a link). */
    ecl?: QrEcl;
};

function layout(text: string, o: QrImageOptions) {
    const module = o.module ?? 6;
    const quiet = o.quiet ?? 4;
    const showText = o.showText ?? true;
    const fontSize = o.fontSize ?? 14;
    const qr = encodeQr(text, o.ecl ?? eclFor(text));
    const side = (qr.size + 2 * quiet) * module;
    const fullHeight = side + (showText ? fontSize + 8 : 0);
    return { qr, module, quiet, side, fullHeight, showText, fontSize };
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** The QR as a standalone SVG document string (white background, black modules). */
export function qrSvg(text: string, opts: QrImageOptions = {}): string {
    const l = layout(text, opts);
    const rects = qrRuns(qrRows(l.qr)).map(([x, y, w]) => `<rect x="${(x + l.quiet) * l.module}" y="${(y + l.quiet) * l.module}" width="${w * l.module}" height="${l.module}"/>`).join('');
    const label = l.showText
        ? `<text x="${l.side / 2}" y="${l.side + l.fontSize + 2}" text-anchor="middle" font-family="monospace" font-size="${l.fontSize}" fill="#000">${escapeXml(text)}</text>`
        : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.side}" height="${l.fullHeight}" viewBox="0 0 ${l.side} ${l.fullHeight}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g>${label}</svg>`;
}

/** Rasterise the QR to PNG bytes in the browser (canvas). Same shape as exports.ts BarcodeImage. */
export async function qrPng(text: string, opts: QrImageOptions = {}): Promise<{ png: Uint8Array; width: number; height: number }> {
    const l = layout(text, opts);
    const canvas = document.createElement('canvas');
    canvas.width = l.side;
    canvas.height = l.fullHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('qr: canvas 2D context unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, l.side, l.fullHeight);
    ctx.fillStyle = '#000';
    for (const [x, y, w] of qrRuns(qrRows(l.qr))) ctx.fillRect((x + l.quiet) * l.module, (y + l.quiet) * l.module, w * l.module, l.module);
    if (l.showText) {
        ctx.font = `${l.fontSize}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(text, l.side / 2, l.side + 2);
    }
    const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('qr: PNG encoding failed'))), 'image/png'));
    return { png: new Uint8Array(await blob.arrayBuffer()), width: l.side, height: l.fullHeight };
}
