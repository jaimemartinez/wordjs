/**
 * The payment receipt («Comprobante») a coordinator attaches: a photo taken or picked ON THE PHONE,
 * shrunk on the device before it travels (owner decision D-P11), so a 4–8 MB camera photo becomes a
 * JPEG data URL the server accepts.
 *
 * The server (conference-manager `assertProof`) takes an image data URL (PNG, JPG, GIF or WebP) of at most
 * 1,400,000 characters. The pipeline aims at 1,000,000 characters (~730 KB of JPEG), well inside:
 *   1. a file over 15 MB, or not an image, is refused before decoding (a phone would run out of memory);
 *   2. decode it (createImageBitmap honouring the EXIF orientation, else an <img>); iOS already hands
 *      a HEIC photo over as JPEG for `accept="image/*"`;
 *   3. draw it on a canvas with the longest side at 1600 px and export JPEG at quality 0.82, then 0.7, then
 *      0.6; still too big → 1280 px, then 1024 px — the first result within the target wins;
 *   4. a browser that cannot decode it still sends the original file when it is a small PNG/JPG/GIF/WebP.
 * Nothing here touches React; the browser bits are injected, so the pipeline is unit-tested.
 */

export const PROOF_TARGET_CHARS = 1_000_000;
export const PROOF_MAX_INPUT_BYTES = 15 * 1024 * 1024;
/** The attempts, in order: longest side in px and JPEG quality. */
export const PROOF_STEPS: readonly { side: number; quality: number }[] = [
    { side: 1600, quality: 0.82 },
    { side: 1600, quality: 0.7 },
    { side: 1600, quality: 0.6 },
    { side: 1280, quality: 0.7 },
    { side: 1280, quality: 0.6 },
    { side: 1024, quality: 0.6 },
];
/** The image types the server stores as they are (the fallback path only). */
const RAW_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

export type ProofErrorCode = "too_big" | "not_image" | "unreadable";
export const PROOF_ERROR_TEXT: Record<ProofErrorCode, string> = {
    too_big: "La foto pesa más de 15 MB. Prueba con una captura de pantalla del comprobante.",
    not_image: "El comprobante debe ser una imagen (una foto o una captura de pantalla).",
    unreadable: "No pudimos reducir la imagen; prueba con una captura de pantalla.",
};
export class ProofError extends Error {
    code: ProofErrorCode;
    constructor(code: ProofErrorCode) { super(PROOF_ERROR_TEXT[code]); this.code = code; }
}

/** The size a picture is drawn at: the longest side at most `side`, never enlarged, at least 1 px. */
export const fitSize = (w: number, h: number, side: number): { width: number; height: number } => {
    const W = Math.max(1, Math.round(Number(w) || 1)), H = Math.max(1, Math.round(Number(h) || 1));
    const k = Math.min(1, side / Math.max(W, H));
    return { width: Math.max(1, Math.round(W * k)), height: Math.max(1, Math.round(H * k)) };
};

/** The decoded bytes of a base64 data URL (for «312 KB»). */
export const dataUrlBytes = (dataUrl: string | null | undefined): number => {
    const s = String(dataUrl || "");
    const i = s.indexOf(",");
    if (i < 0) return 0;
    const b64 = s.slice(i + 1);
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
};

/** «312 KB» / «1,2 MB». */
export const sizeLabel = (bytes: number): string => {
    const b = Math.max(0, Number(bytes) || 0);
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    return `${(b / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
};

export type DecodedImage = { width: number; height: number; release?: () => void };
export type ProofEnv<I extends DecodedImage = DecodedImage> = {
    decode(file: Blob): Promise<I>;
    encode(img: I, width: number, height: number, quality: number): Promise<string>;
    readRaw(file: Blob): Promise<string>;
};

export type PreparedProof = { dataUrl: string; bytes: number; compressed: boolean };

/**
 * A picked file → a data URL within `target` characters, or a ProofError. `env` = the browser's decode /
 * canvas export / FileReader (browserProofEnv), or fakes in the tests.
 */
export async function prepareProof<I extends DecodedImage>(file: { size: number; type: string } & Blob, env: ProofEnv<I>, target = PROOF_TARGET_CHARS): Promise<PreparedProof> {
    if (!file || !(Number(file.size) > 0)) throw new ProofError("unreadable");
    if (file.size > PROOF_MAX_INPUT_BYTES) throw new ProofError("too_big");
    const type = String(file.type || "");
    if (type && !type.startsWith("image/")) throw new ProofError("not_image");
    let img: I | null = null;
    try {
        img = await env.decode(file);
    } catch {
        img = null;
    }
    if (img) {
        try {
            for (const step of PROOF_STEPS) {
                const { width, height } = fitSize(img.width, img.height, step.side);
                const url = await env.encode(img, width, height, step.quality);
                if (typeof url === "string" && url.startsWith("data:image/") && url.length <= target) {
                    return { dataUrl: url, bytes: dataUrlBytes(url), compressed: true };
                }
            }
        } catch {
            /* fall back to the original file below */
        } finally {
            try { img.release?.(); } catch { /* already released */ }
        }
    }
    // Could not decode or shrink it: the original, when the server takes its type and it already fits.
    if (RAW_TYPES.test(type)) {
        try {
            const raw = await env.readRaw(file);
            if (typeof raw === "string" && RAW_TYPES.test(raw.slice(5, raw.indexOf(";"))) && raw.length <= target) {
                return { dataUrl: raw, bytes: dataUrlBytes(raw), compressed: false };
            }
        } catch { /* unreadable */ }
    }
    throw new ProofError(img ? "unreadable" : type.startsWith("image/") ? "unreadable" : "not_image");
}

type Bitmapish = DecodedImage & { source: CanvasImageSource };

/** The real browser: createImageBitmap (EXIF orientation applied), else an <img>; a canvas exports JPEG. */
export const browserProofEnv: ProofEnv<Bitmapish> = {
    async decode(file) {
        if (typeof createImageBitmap === "function") {
            try {
                const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
                return { width: bmp.width, height: bmp.height, source: bmp, release: () => bmp.close() };
            } catch { /* older Safari: try an <img> */ }
        }
        const url = URL.createObjectURL(file);
        try {
            const el = await new Promise<HTMLImageElement>((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error("decode"));
                i.src = url;
            });
            return { width: el.naturalWidth, height: el.naturalHeight, source: el, release: () => URL.revokeObjectURL(url) };
        } catch (e) {
            URL.revokeObjectURL(url);
            throw e;
        }
    },
    async encode(img, width, height, quality) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas");
        // A transparent PNG would turn black as JPEG: paint white first.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img.source, 0, 0, width, height);
        const url = canvas.toDataURL("image/jpeg", quality);
        canvas.width = 0;
        canvas.height = 0;
        return url;
    },
    readRaw(file) {
        return new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
            r.onerror = () => reject(new Error("read"));
            r.readAsDataURL(file);
        });
    },
};

/**
 * One receipt being prepared at a time, the LATEST pick winning: `next()` when a photo is picked, then
 * `isLatest(token)` before applying its result. A photo picked while another is still shrinking (an older
 * phone takes seconds; someone taps again) supersedes it — the older one, finishing later, must neither
 * replace the receipt nor end the «Preparando foto…» state the newer one is in.
 */
export function pickSequence() {
    let n = 0;
    return { next: (): number => ++n, isLatest: (token: number): boolean => token === n };
}
