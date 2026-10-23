/**
 * The arithmetic of the media library's image editor (QA S1-15), kept apart from the component so it can
 * be tested. The server applies the same order — rotate → flip → crop → scale (backend core/media-edit) —
 * and takes the crop as FRACTIONS of the rotated/flipped image, which is what the editor draws on.
 */
export type Rotation = 0 | 90 | 180 | 270;
export interface CropBox { x: number; y: number; width: number; height: number }
export interface ImageEditState { rotate: Rotation; flipH: boolean; flipV: boolean; crop: CropBox; width: number | null }

export const FULL_CROP: CropBox = { x: 0, y: 0, width: 1, height: 1 };
/** Smallest crop side, as a fraction: a box you can still see and grab. */
export const MIN_CROP = 0.05;

/** Types the server can edit (an animated GIF would lose its frames; an SVG is not raster). */
export function canEditImage(mimeType: string | undefined, storage?: string): boolean {
    return /^image\/(jpeg|png|webp)$/i.test(String(mimeType || "")) && storage !== "s3";
}

export function turn(rotate: Rotation, by: 90 | -90): Rotation {
    return ((((rotate + by) % 360) + 360) % 360) as Rotation;
}

/** Size of the image after the turn (a quarter turn swaps the sides). */
export function rotatedSize(width: number, height: number, rotate: Rotation): { width: number; height: number } {
    return rotate === 90 || rotate === 270 ? { width: height, height: width } : { width, height };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Keeps a box inside the image and at least MIN_CROP on each side. */
export function clampCrop(c: CropBox): CropBox {
    const width = clamp(c.width, MIN_CROP, 1);
    const height = clamp(c.height, MIN_CROP, 1);
    return { x: clamp(c.x, 0, 1 - width), y: clamp(c.y, 0, 1 - height), width, height };
}

/**
 * The largest centred box of `aspect` (width ÷ height, in pixels) inside an image of `imgW × imgH`; the whole
 * image when `aspect` is null (free).
 */
export function cropForAspect(aspect: number | null, imgW: number, imgH: number): CropBox {
    if (!aspect || !imgW || !imgH) return FULL_CROP;
    const imgAspect = imgW / imgH;
    if (aspect >= imgAspect) {
        const height = imgAspect / aspect;
        return { x: 0, y: (1 - height) / 2, width: 1, height };
    }
    const width = aspect / imgAspect;
    return { x: (1 - width) / 2, y: 0, width, height: 1 };
}

/** Pixel size of the result: the crop of the turned image, then scaled down to `width` if smaller. */
export function resultSize(srcW: number, srcH: number, s: ImageEditState): { width: number; height: number } {
    const r = rotatedSize(srcW, srcH, s.rotate);
    const cw = Math.max(1, Math.round(s.crop.width * r.width));
    const ch = Math.max(1, Math.round(s.crop.height * r.height));
    if (s.width && s.width < cw) return { width: s.width, height: Math.max(1, Math.round((ch * s.width) / cw)) };
    return { width: cw, height: ch };
}

const isFull = (c: CropBox) => c.x <= 0 && c.y <= 0 && c.width >= 0.9999 && c.height >= 0.9999;

/** What POST /media/:id/edit takes; null when nothing would change. */
export function editRequest(srcW: number, srcH: number, s: ImageEditState): { rotate?: Rotation; flipH?: boolean; flipV?: boolean; crop?: CropBox; width?: number } | null {
    const body: { rotate?: Rotation; flipH?: boolean; flipV?: boolean; crop?: CropBox; width?: number } = {};
    if (s.rotate) body.rotate = s.rotate;
    if (s.flipH) body.flipH = true;
    if (s.flipV) body.flipV = true;
    if (!isFull(s.crop)) body.crop = clampCrop(s.crop);
    const r = rotatedSize(srcW, srcH, s.rotate);
    const croppedW = Math.round(s.crop.width * r.width);
    if (s.width && s.width < croppedW) body.width = Math.round(s.width);
    return Object.keys(body).length ? body : null;
}

/** Moves (`mode: "move"`) or resizes from a corner a box by a pointer delta given in fractions. */
export function dragCrop(start: CropBox, mode: "move" | "nw" | "ne" | "sw" | "se", dx: number, dy: number, aspect: number | null, imgW: number, imgH: number): CropBox {
    if (mode === "move") {
        return { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
    }
    const left = mode === "nw" || mode === "sw";
    const top = mode === "nw" || mode === "ne";
    const right = start.x + start.width, bottom = start.y + start.height;
    let x1 = left ? clamp(start.x + dx, 0, right - MIN_CROP) : start.x;
    let x2 = left ? right : clamp(right + dx, start.x + MIN_CROP, 1);
    let y1 = top ? clamp(start.y + dy, 0, bottom - MIN_CROP) : start.y;
    let y2 = top ? bottom : clamp(bottom + dy, start.y + MIN_CROP, 1);
    if (aspect && imgW && imgH) {
        // Keep the ratio in pixels: the height follows the width, anchored at the opposite corner.
        const fracAspect = aspect * (imgH / imgW); // width-fraction ÷ height-fraction
        let w = x2 - x1;
        let h = w / fracAspect;
        const maxH = top ? y2 : 1 - y1;
        if (h > maxH) { h = maxH; w = h * fracAspect; }
        if (left) x1 = x2 - w; else x2 = x1 + w;
        if (top) y1 = y2 - h; else y2 = y1 + h;
    }
    return clampCrop({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
}
