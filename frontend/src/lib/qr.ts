/**
 * QR codes drawn in the browser (qrcode-generator, already used by the MFA enrolment screen).
 *
 * Exposed to plugin bundles as the host module 'lib/qr' (pluginBundleLoader.ts + HOST_MODULES in
 * backend/scripts/build-plugin.js), so a plugin shows a scannable link (a sign-up or join link on a
 * printed sheet or a projector) without bundling an encoder of its own. Pure functions: text in, image
 * out, no network.
 */
import qrcode from "qrcode-generator";

export type QrEcc = "L" | "M" | "Q" | "H";

export interface QrOptions {
    /** Pixels per module (default 6). */
    cell?: number;
    /** Quiet zone in modules (default 2; the QR spec recommends 4 on busy backgrounds). */
    margin?: number;
    /** Error-correction level (default 'M'). */
    ecc?: QrEcc;
}

/** Longest text accepted (a QR at level L holds at most 2953 bytes; links stay far below). */
export const QR_MAX_LENGTH = 2000;

function build(text: string, ecc: QrEcc) {
    const value = String(text ?? "");
    if (!value) throw new Error("qr: empty text");
    if (value.length > QR_MAX_LENGTH) throw new Error("qr: text too long");
    const qr = qrcode(0, ecc);
    // Byte mode carrying the UTF-8 bytes, so accented text encodes the same way on every scanner. The
    // library's default byte conversion keeps the low 8 bits of each char, so hand it one char per UTF-8
    // byte — without swapping its global `stringToBytes` (other screens share the module).
    const utf8 = Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join("");
    qr.addData(utf8, "Byte");
    qr.make();
    return qr;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** A `data:image/gif;base64,…` URL of the QR code, ready for an <img src>. */
export function qrDataUrl(text: string, opts: QrOptions = {}): string {
    const qr = build(text, opts.ecc || "M");
    return qr.createDataURL(clampInt(opts.cell, 1, 40, 6), clampInt(opts.margin, 0, 16, 2));
}

/** The QR code as an <svg> string (scales without blur; black modules on white). */
export function qrSvg(text: string, opts: QrOptions = {}): string {
    const qr = build(text, opts.ecc || "M");
    return qr.createSvgTag({ cellSize: clampInt(opts.cell, 1, 40, 6), margin: clampInt(opts.margin, 0, 16, 2), scalable: true });
}

/** Number of modules per side (useful to pick a cell size for a target pixel width). */
export function qrModuleCount(text: string, ecc: QrEcc = "M"): number {
    return build(text, ecc).getModuleCount();
}
