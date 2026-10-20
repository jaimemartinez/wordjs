/**
 * Receipts on a phone (2.18.0, owner decision D-P11) — a photo of a bank receipt is compressed IN THE
 * BROWSER before it is sent, so a 4–8 MB camera picture travels as a ≤ 1 MB JPEG data URL (the server keeps
 * at most 1.4 M characters; nothing changes there).
 *
 * Pipeline (`prepareProof`):
 *   1. refuse what is not an image, and anything over 15 MB, before decoding;
 *   2. decode with the photo's EXIF orientation applied (`createImageBitmap(file, { imageOrientation:
 *      'from-image' })`; an <img> fallback where that is missing — current browsers apply the orientation
 *      to an <img> themselves). iOS already hands a HEIC photo over as JPEG for `accept="image/*"`;
 *   3. draw it on a canvas with its longest side at 1600 px, export JPEG at quality 0.82, then 0.7, then
 *      0.6; still too big → the same at 1280 px, then 1024 px — the first result ≤ PROOF_MAX_CHARS wins;
 *   4. when decoding or the canvas fails, a file that is already a small PNG / JPEG / GIF / WebP is sent as
 *      it is; otherwise the caller says «No pudimos reducir la imagen; prueba con una captura de pantalla».
 *
 * The async functions take their browser APIs as injectable dependencies (tests run in node, no DOM).
 */

/** The longest a receipt data URL may be after compression (the server's cap is 1.4 M). */
export const PROOF_MAX_CHARS = 1_000_000;
/** Files above this are refused before decoding (a phone would run out of memory). */
export const PROOF_MAX_FILE_BYTES = 15 * 1024 * 1024;
/** The attempts, in order: longest side, then JPEG quality. */
export const COMPRESSION_PLAN: readonly { side: number; quality: number }[] = [
    { side: 1600, quality: 0.82 }, { side: 1600, quality: 0.7 }, { side: 1600, quality: 0.6 },
    { side: 1280, quality: 0.82 }, { side: 1280, quality: 0.7 }, { side: 1280, quality: 0.6 },
    { side: 1024, quality: 0.82 }, { side: 1024, quality: 0.7 }, { side: 1024, quality: 0.6 },
];
const RAW_OK = /^image\/(png|jpe?g|gif|webp)$/i;

/** Width × height scaled so the longest side is at most `max` (never enlarged; at least 1 px). */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
    const w = Math.max(1, Math.round(Number(width) || 1)), h = Math.max(1, Math.round(Number(height) || 1));
    const scale = Math.min(1, max / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Approximate bytes of a base64 data URL's payload (for «312 KB»). */
export function dataUrlBytes(url: string | null | undefined): number {
    const s = String(url || '');
    const i = s.indexOf(',');
    if (i < 0) return 0;
    const b64 = s.slice(i + 1).replace(/\s+/g, '');
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}
/** «312 KB» / «1,2 MB». */
export function formatBytes(n: number): string {
    const b = Math.max(0, Number(n) || 0);
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    return `${(b / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** A receipt the browser may render with <img>: an image data URL of an allowed type (coordinator input is untrusted). */
export const isImageDataUrl = (p?: string | null): boolean =>
    typeof p === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(p.trim());

export type ProofError = 'not_image' | 'too_large' | 'unreadable';
export type ProofResult = { ok: true; dataUrl: string; bytes: number; width?: number; height?: number; compressed: boolean } | { ok: false; error: ProofError };

type FileLike = { type: string; size: number };
type Bitmap = { width: number; height: number; close?: () => void };
type Canvas = { width: number; height: number; getContext: (k: '2d') => { drawImage: (img: any, x: number, y: number, w: number, h: number) => void } | null; toDataURL: (type: string, q?: number) => string };
export type ProofDeps = {
    decode?: (file: any) => Promise<Bitmap>;
    canvas?: () => Canvas;
    readAsDataUrl?: (file: any) => Promise<string>;
};

/** Decode with orientation: createImageBitmap when available, else an <img> on an object URL. */
async function defaultDecode(file: any): Promise<Bitmap> {
    const g: any = globalThis as any;
    if (typeof g.createImageBitmap === 'function') {
        try { return await g.createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch { /* the options bag is not supported everywhere: try without it */ }
        try { return await g.createImageBitmap(file); } catch { /* fall through to <img> */ }
    }
    if (typeof g.Image !== 'function' || !g.URL || typeof g.URL.createObjectURL !== 'function') throw new Error('no decoder');
    const url = g.URL.createObjectURL(file);
    try {
        const img = new g.Image();
        await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('decode')); img.src = url; });
        return { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, draw: img } as any;
    } finally {
        setTimeout(() => { try { g.URL.revokeObjectURL(url); } catch { /* ignore */ } }, 0);
    }
}
const defaultCanvas = (): Canvas => (globalThis as any).document.createElement('canvas');
const defaultRead = (file: any): Promise<string> => new Promise((resolve, reject) => {
    const r = new (globalThis as any).FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read'));
    r.readAsDataURL(file);
});

/** Turn a picked file into a receipt data URL ≤ PROOF_MAX_CHARS (see the header). Never throws. */
export async function prepareProof(file: FileLike | null | undefined, deps: ProofDeps = {}, maxChars = PROOF_MAX_CHARS): Promise<ProofResult> {
    if (!file || !/^image\//i.test(String(file.type || ''))) return { ok: false, error: 'not_image' };
    if (file.size > PROOF_MAX_FILE_BYTES) return { ok: false, error: 'too_large' };
    const decode = deps.decode || defaultDecode;
    const makeCanvas = deps.canvas || defaultCanvas;
    const read = deps.readAsDataUrl || defaultRead;
    try {
        const bmp = await decode(file);
        try {
            for (const step of COMPRESSION_PLAN) {
                const size = fitWithin(bmp.width, bmp.height, step.side);
                const canvas = makeCanvas();
                canvas.width = size.width; canvas.height = size.height;
                const ctx = canvas.getContext('2d');
                if (!ctx) throw new Error('no 2d context');
                ctx.drawImage((bmp as any).draw || bmp, 0, 0, size.width, size.height);
                const url = canvas.toDataURL('image/jpeg', step.quality);
                if (url && url.startsWith('data:image/') && url.length <= maxChars) {
                    return { ok: true, dataUrl: url, bytes: dataUrlBytes(url), width: size.width, height: size.height, compressed: true };
                }
            }
        } finally {
            try { bmp.close && bmp.close(); } catch { /* ignore */ }
        }
    } catch { /* decoding or the canvas failed: maybe the raw file is fine */ }
    // Fallback: a small image of an allowed type goes as it is.
    if (RAW_OK.test(file.type)) {
        try {
            const url = await read(file);
            if (isImageDataUrl(url) && url.length <= maxChars) return { ok: true, dataUrl: url, bytes: dataUrlBytes(url), compressed: false };
        } catch { /* unreadable */ }
    }
    return { ok: false, error: 'unreadable' };
}

/**
 * A tiny least-recently-used cache (the receipts fetched on demand: a review queue flips back and forth
 * between a few payments; ten receipts of ≤ 1 MB is the most kept in memory).
 */
export function createLru<V>(max = 10) {
    const map = new Map<string, V>();
    return {
        get(key: string): V | undefined {
            if (!map.has(key)) return undefined;
            const v = map.get(key)!;
            map.delete(key); map.set(key, v);
            return v;
        },
        set(key: string, v: V): void {
            if (map.has(key)) map.delete(key);
            map.set(key, v);
            while (map.size > max) map.delete(map.keys().next().value as string);
        },
        delete(key: string): void { map.delete(key); },
        keys: (): string[] => [...map.keys()],
        get size() { return map.size; },
    };
}

/** The message for a ProofError (i18n key + Spanish fallback). */
export const PROOF_ERROR_TEXT: Record<ProofError, { key: string; fallback: string }> = {
    not_image: { key: 'fees.proof.error.not.image', fallback: 'El comprobante debe ser una imagen (foto o captura de pantalla).' },
    too_large: { key: 'fees.proof.error.too.large', fallback: 'La imagen pesa más de 15 MB; prueba con una captura de pantalla.' },
    unreadable: { key: 'fees.proof.error.unreadable', fallback: 'No pudimos reducir la imagen; prueba con una captura de pantalla.' },
};

/**
 * One receipt being prepared at a time, the LATEST pick winning: `next()` when a photo is picked, then
 * `isLatest(token)` before applying its result. A photo picked while another is still shrinking (an older
 * phone takes seconds; someone taps again) supersedes it — the older one, finishing later, must neither
 * replace the receipt nor end the «Preparando foto…» state the newer one is in.
 */
export function pickSequence() {
    let n = 0;
    return { next: () => ++n, isLatest: (token: number) => token === n };
}
