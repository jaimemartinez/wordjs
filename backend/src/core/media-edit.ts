/**
 * Image editing for the media library (QA S1-15): rotate, flip, crop and scale down a stored raster image.
 *
 * An edit never overwrites a file. Media URLs are served `immutable` for a year, and image blocks store the
 * URL (and srcset) they were inserted with, so the edited image is written under a NEW name beside the
 * current one and gets its own size ladder; the earlier files stay, so pages that already show them keep
 * working (WordPress does the same). The row then points at the new file — see Media.replaceImage.
 *
 * The operations run in a fixed order: rotate → flip → crop → scale. The crop is given as FRACTIONS of the
 * rotated/flipped image, so the editor can draw it on a preview of any size and send what it drew.
 */
const fs = require('fs');
const path = require('path');

/** The types an edit can re-encode without loss of a feature (an animated GIF would lose its frames; an SVG is not raster). */
const EDITABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface ImageEditOps {
    rotate: 0 | 90 | 180 | 270;
    flipH: boolean;
    flipV: boolean;
    crop: { x: number; y: number; width: number; height: number } | null;
    width: number | null;
}

function fraction(v: unknown): number | null {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** The request body as edit operations, or the reason it is not one. */
export function parseImageEdit(body: any): { ops: ImageEditOps } | { error: string } {
    const b = body && typeof body === 'object' ? body : {};
    const rotate = b.rotate === undefined || b.rotate === null || b.rotate === '' ? 0 : Number(b.rotate);
    const turn = ((rotate % 360) + 360) % 360;
    if (!Number.isInteger(rotate) || turn % 90 !== 0) return { error: 'rotate must be a multiple of 90 degrees.' };

    const bool = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

    let crop: ImageEditOps['crop'] = null;
    if (b.crop !== undefined && b.crop !== null) {
        const c = b.crop;
        const x = fraction(c && c.x), y = fraction(c && c.y), w = fraction(c && c.width), h = fraction(c && c.height);
        if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001) {
            return { error: 'crop must be {x, y, width, height}, fractions of the image between 0 and 1 that stay inside it.' };
        }
        // A crop of the whole image is no crop.
        if (!(x === 0 && y === 0 && w >= 0.999999 && h >= 0.999999)) crop = { x, y, width: w, height: h };
    }

    let width: number | null = null;
    if (b.width !== undefined && b.width !== null && b.width !== '') {
        const n = Number(b.width);
        if (!Number.isInteger(n) || n < 1 || n > 20000) return { error: 'width must be a whole number of pixels.' };
        width = n;
    }

    const ops: ImageEditOps = { rotate: turn as ImageEditOps['rotate'], flipH: bool(b.flipH), flipV: bool(b.flipV), crop, width };
    if (!ops.rotate && !ops.flipH && !ops.flipV && !ops.crop && !ops.width) return { error: 'Nothing to change: choose a rotation, a flip, a crop or a smaller width.' };
    return { ops };
}

/**
 * Where the edited file goes: beside the current one, named `<stem>-e<timestamp>.<ext>`. A re-edit replaces the
 * previous `-e…` suffix rather than stacking another, and a name already on disk is never reused.
 */
export function editedFilePath(currentAbs: string, now = Date.now()): string {
    const dir = path.dirname(currentAbs);
    const ext = path.extname(currentAbs);
    const stem = path.basename(currentAbs, ext).replace(/-e\d{10,}$/, '');
    let stamp = now;
    let candidate = path.join(dir, `${stem}-e${stamp}${ext}`);
    while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-e${++stamp}${ext}`);
    return candidate;
}

/** Writes the edited image to `destAbs`; returns its size. Throws on an unreadable source. */
export async function writeEditedImage(srcAbs: string, mimeType: string, ops: ImageEditOps, destAbs: string): Promise<{ width: number; height: number; filesize: number }> {
    const sharp = require('sharp');
    const { MAX_SHARP_INPUT_PIXELS } = require('./media-derivatives');
    const input = { limitInputPixels: MAX_SHARP_INPUT_PIXELS };

    // 1. Orientation: the EXIF orientation is applied first (what the author SAW), then the turn and flips.
    let step = sharp(srcAbs, input).rotate();
    if (ops.rotate) step = step.rotate(ops.rotate);
    if (ops.flipH) step = step.flop();
    if (ops.flipV) step = step.flip();
    const { data, info } = await step.toBuffer({ resolveWithObject: true });

    // 2. Crop (fractions of what step 1 produced) and scale down.
    let out = sharp(data, input);
    let w = info.width, h = info.height;
    if (ops.crop) {
        const left = Math.min(w - 1, Math.round(ops.crop.x * w));
        const top = Math.min(h - 1, Math.round(ops.crop.y * h));
        const cw = Math.max(1, Math.min(w - left, Math.round(ops.crop.width * w)));
        const ch = Math.max(1, Math.min(h - top, Math.round(ops.crop.height * h)));
        out = out.extract({ left, top, width: cw, height: ch });
        w = cw; h = ch;
    }
    if (ops.width && ops.width < w) out = out.resize({ width: ops.width, withoutEnlargement: true });

    if (mimeType === 'image/png') out = out.png();
    else if (mimeType === 'image/webp') out = out.webp({ quality: 88 });
    else out = out.jpeg({ quality: 88, mozjpeg: true });

    const written = await out.toFile(destAbs);
    return { width: written.width, height: written.height, filesize: written.size };
}

module.exports = { EDITABLE_IMAGE_TYPES, parseImageEdit, editedFilePath, writeEditedImage };
