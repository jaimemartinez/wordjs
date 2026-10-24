// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
/**
 * Any PDF, page by page, in place (2.36.4): the signed sheet's viewer draws every page of an uploaded PDF — typed,
 * vector or scanned — with pdf.js (Apache-2.0), never as a download and never through the browser's own PDF viewer
 * (Android Chrome has none inline).
 *
 * pdf.js is 1.8 MB, so it is not in the plugin's bundles: the first PDF opened fetches it from the plugin
 * (GET /public/pdfjs, server/pdfjs-legacy.js — cached), and it is imported as two blob: modules (the admin's CSP
 * allows blob: scripts). It runs on the page itself — its "worker" is registered as the main-thread handler, so no
 * Worker has to be allowed — with eval off. Each page is drawn onto a canvas and handed over as a PNG blob: URL
 * (the caller revokes it), which the zoomable viewer shows like a photo.
 */
import { scanPages } from './pdfScan';

const PDFJS_URL = '/api/v1/plugin/conference-manager/public/pdfjs';
const PDFJS_VERSION = '4.10.38';
let loading: Promise<any> | null = null;

async function moduleUrl(part: 'main' | 'worker'): Promise<string> {
    const r = await fetch(`${PDFJS_URL}?part=${part}&v=${PDFJS_VERSION}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`pdf.js ${part}: ${r.status}`);
    const d = await r.json();
    const bin = atob(String(d.b64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
}

/** pdf.js, loaded once (a failure lets the next PDF try again). */
export function loadPdfjs(): Promise<any> {
    if (!loading) {
        loading = (async () => {
            const [mainUrl, workerUrl] = await Promise.all([moduleUrl('main'), moduleUrl('worker')]);
            const worker = await import(/* webpackIgnore: true */ workerUrl);
            // The main-thread handler: pdf.js then needs no Worker (nothing to allow in the sandbox or the CSP).
            (globalThis as any).pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
            return import(/* webpackIgnore: true */ mainUrl);
        })().catch((e) => { loading = null; throw e; });
    }
    return loading;
}

/** The options a document is opened with: no eval, the system's fonts for the ones not embedded, all in memory. */
export const PDF_OPEN = Object.freeze({ isEvalSupported: false, useSystemFonts: true, disableAutoFetch: true, disableStream: true, disableRange: true });

/**
 * A PDF whose every page is a picture this browser can show without pdf.js (a phone's «scan to PDF»): the same pages,
 * no 1.8 MB download. Pages are counted from the page objects; a PDF that hides them in object streams, or has a
 * page without a picture, goes to pdf.js.
 */
export function scansCoverEveryPage(bytes: Uint8Array): boolean {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any);
    const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
    if (!pages) return false;
    const scans = scanPages(bytes);
    return scans.length === pages && scans.every((p) => p.kind === 'jpeg' || p.kind === 'raw');
}

/**
 * Draw every page of a PDF: `onPage(index, total, url)` as each is ready (a PNG blob: URL, about `width` px wide).
 * Resolves with the page count.
 */
export async function renderPdf(bytes: Uint8Array, onPage: (i: number, total: number, url: string) => void, width = 1600): Promise<number> {
    const lib = await loadPdfjs();
    const doc = await lib.getDocument({ data: bytes, ...PDF_OPEN }).promise;
    try {
        const total = doc.numPages;
        for (let n = 1; n <= total; n++) {
            const page = await doc.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: Math.max(0.5, Math.min(4, width / base.width)) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            const blob: Blob = await new Promise((resolve) => canvas.toBlob(resolve as any, 'image/png'));
            page.cleanup();
            onPage(n - 1, total, blob ? URL.createObjectURL(blob) : '');
        }
        return total;
    } finally { doc.destroy(); }
}
