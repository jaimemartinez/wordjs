/**
 * QR reader for camera frames (2.22.0) — the built-in path for phones without a `BarcodeDetector` that reads
 * QR (iPhone Safari, Firefox). The badges carry the registration code as a QR since 2.22.0; the Code 128 ones
 * printed before are still read by ./barcodeScan.
 *
 * The decoding itself is jsQR 1.4.0 (./vendor/jsQR.js, Apache-2.0, vendored unchanged). This module only
 * chooses the part of the frame to decode — a SQUARE around the aiming frame, downscaled so its side is at most
 * `maxSide` px (a QR's modules are large: a version-1 code held at reading distance spans hundreds of pixels,
 * and jsQR's cost grows with the area) — and hands jsQR the RGBA pixels. No DOM at module level.
 */

import jsQR from './vendor/jsQR';
import type { CanvasLike, Rect, VideoLike } from './barcodeScan';

/** A QR read: its text and BarcodeDetector's name for the symbology. */
export type QrRead = { text: string; format: 'qr_code' };

/** Decode RGBA pixels (canvas ImageData). Dark-on-light only: the badges and the phone screens are. */
export function decodeQrPixels(data: Uint8ClampedArray, width: number, height: number): QrRead | null {
    if (!(width > 0 && height > 0) || data.length < width * height * 4) return null;
    const r = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    return r && typeof r.data === 'string' && r.data ? { text: r.data, format: 'qr_code' } : null;
}

/**
 * The square of the video to look for a QR in: centred on the aiming band (`band`, video pixels; the whole
 * frame's centre when null), as wide as the band and at least as tall, clamped to the video.
 */
export function qrSquare(videoW: number, videoH: number, band: Rect | null): Rect | null {
    if (!(videoW > 0 && videoH > 0)) return null;
    const b = band ?? { x: 0, y: 0, width: videoW, height: videoH };
    const side = Math.min(videoW, videoH, Math.max(b.width, b.height));
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const x = Math.round(Math.min(Math.max(0, cx - side / 2), videoW - side));
    const y = Math.round(Math.min(Math.max(0, cy - side / 2), videoH - side));
    return { x, y, width: Math.round(side), height: Math.round(side) };
}

/**
 * Browser only: draw `region` of the current video frame onto `canvas`, scaled so its longer side is at most
 * `maxSide` px (default 720), and decode a QR in it. Null when there is no frame yet or no QR is read.
 */
export function decodeQrVideoRegion(video: VideoLike, canvas: CanvasLike, region: Rect | null, maxSide = 720): QrRead | null {
    const vw = video?.videoWidth, vh = video?.videoHeight;
    if (!vw || !vh || !canvas) return null;
    const src = region ?? { x: 0, y: 0, width: vw, height: vh };
    const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, src.x, src.y, src.width, src.height, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    return decodeQrPixels(frame.data as Uint8ClampedArray, w, h);
}
