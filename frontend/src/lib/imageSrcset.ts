/**
 * WordJS - Automatic responsive images (srcset/sizes) for the Image block.
 *
 * DESIGN DECISION (based on backend evidence, backend/src/routes/media.ts L438-490):
 *
 * On upload, sharp generates up to three variants next to the original
 * (uploads/YYYY/MM/<basename>-<uuid8><ext>):
 *   - thumbnail  (default 150x150, fit:'cover'  -> CROPPED, aspect may differ)
 *   - medium     (default 300x300, fit:'inside', skipped if original is smaller)
 *   - large      (default 1024x1024, fit:'inside', skipped if original is smaller)
 * Target dimensions come from options (thumbnail_size_w/h, medium_size_w/h,
 * large_size_w/h), so they are DB-configurable per install. The variant filename
 * uses the TARGET box, not the actual output size: `<basename>-<targetW>x<targetH><ext>`
 * (e.g. photo-ab12cd34-300x300.jpg even when the real output is 300x200).
 *
 * Because target sizes are per-install options and variants are conditionally
 * skipped, deriving variant URLs blindly from the original URL would guess both
 * the box AND existence -> 404 candidates in srcset. We therefore NEVER derive
 * URLs by convention. The authoritative map lives in attachment metadata
 * (post_meta `_wp_attachment_metadata`.sizes) and is exposed verbatim by the
 * media API as `MediaItem.mediaDetails.sizes` (exact variant filename + REAL
 * output width/height per size). Variants live in the same directory as the
 * original, so: variantUrl = dirname(sourceUrl) + '/' + sizes[name].file.
 *
 * The Image block only persists a `src` string, and a custom field's onChange
 * can only set its own prop (contract inherited from the previous editor, whose
 * createOnChange was verified to behave this way; Verso keeps it).
 * However, that same dispatch runs the component's `resolveData` (trigger
 * "replace") immediately after. So the flow is:
 *   1. MediaPicker onSelect registers the full MediaItem here (rememberPickedMedia)
 *      and calls onChange(sourceUrl) as before.
 *   2. The Image block's resolveData looks the src up in this in-memory registry
 *      and persists `srcSet` / `imgWidth` / `imgHeight` props built from the
 *      real backend-reported variants. Zero network, zero guessed URLs; the
 *      props are saved with the page data so the public SSR render gets them.
 *   3. If the user later hand-edits src to another URL, srcSetBelongsTo()
 *      detects the mismatch and resolveData clears the stale props.
 * Pages saved before this feature only carry `src`; every helper degrades to
 * "no srcset" and the render is byte-identical to the old output.
 *
 * The cropped `thumbnail` variant is excluded unless its aspect ratio matches
 * the original (a cropped candidate in srcset would let the browser swap in a
 * differently-framed image).
 */

import type { MediaItem } from "./api";

/** Shape of `MediaItem.mediaDetails` (all-optional for robustness). */
export interface MediaSizes {
    width?: number;
    height?: number;
    file?: string;
    filesize?: number;
    sizes?: Record<string, {
        file: string;
        width: number;
        height: number;
        mimeType?: string;
        filesize?: number;
    }>;
}

/** Default sizes attribute: full-viewport up to 1280px, then capped. */
export const DEFAULT_SIZES = "(max-width: 768px) 100vw, (max-width: 1280px) 100vw, 1280px";

/** Relative aspect-ratio tolerance when deciding whether a variant is a crop. */
const ASPECT_TOLERANCE = 0.02;

/** Strip the extension from a URL/path (keeps directory part). */
function withoutExt(url: string): string {
    const dot = url.lastIndexOf(".");
    const slash = url.lastIndexOf("/");
    return dot > slash ? url.slice(0, dot) : url;
}

/**
 * Build a srcset (+ default sizes) for `src` from backend-reported variant
 * metadata. Returns {} when there is nothing useful (no meta, no image sizes,
 * or fewer than two distinct width candidates).
 */
export function buildSrcSet(src: string, meta?: MediaSizes): { srcSet?: string; sizes?: string } {
    if (!src || !meta || !meta.sizes) return {};

    const lastSlash = src.lastIndexOf("/");
    const dir = lastSlash >= 0 ? src.slice(0, lastSlash) : "";

    const originalRatio = meta.width && meta.height ? meta.width / meta.height : 0;

    const byWidth = new Map<number, string>();

    for (const [name, entry] of Object.entries(meta.sizes)) {
        if (!entry || !entry.file || !entry.width) continue;
        // Exclude cropped variants (thumbnail uses fit:'cover'): a candidate with a
        // different aspect ratio would render differently framed at some viewports.
        if (originalRatio && entry.height) {
            const ratio = entry.width / entry.height;
            if (Math.abs(ratio - originalRatio) / originalRatio > ASPECT_TOLERANCE) continue;
        } else if (name === "thumbnail") {
            continue; // no dims to verify against -> assume crop
        }
        byWidth.set(entry.width, `${dir}/${entry.file}`);
    }

    // The original is always the largest candidate.
    if (meta.width && meta.width > 0) byWidth.set(meta.width, src);

    if (byWidth.size < 2) return {}; // a single candidate adds bytes, not value

    const srcSet = [...byWidth.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([w, url]) => `${url} ${w}w`)
        .join(", ");

    return { srcSet, sizes: DEFAULT_SIZES };
}

/**
 * sizes attribute derived from the block's width prop when it is an absolute
 * pixel value ("480" or "480px"); anything else (empty, %, em) falls back to
 * the viewport-based default.
 */
export function sizesForWidth(blockWidth?: string): string {
    const m = typeof blockWidth === "string" ? blockWidth.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/) : null;
    if (m) {
        const px = Math.round(parseFloat(m[1]));
        if (px > 0) return `(max-width: ${px}px) 100vw, ${px}px`;
    }
    return DEFAULT_SIZES;
}

/**
 * True when every srcset candidate belongs to `src`: either the original itself
 * or a `<src-minus-ext>-...` sibling (the backend's variant naming). Used to
 * detect a hand-edited src whose stored srcSet would point at the OLD image.
 */
export function srcSetBelongsTo(src: string, srcSet: string): boolean {
    if (!src || !srcSet) return false;
    const stem = `${withoutExt(src)}-`;
    return srcSet.split(",").every((candidate) => {
        const url = candidate.trim().split(/\s+/)[0];
        return url === src || url.startsWith(stem);
    });
}

// ---------------------------------------------------------------------------
// Picker registry: bridges MediaPicker onSelect -> Image block resolveData.
// Session-scoped and size-capped; a miss simply means "keep props as-is".
// ---------------------------------------------------------------------------

const MAX_REMEMBERED = 100;
const pickedMedia = new Map<string, MediaSizes>();

/** Register a freshly picked MediaItem, keyed by the URL the block will store. */
export function rememberPickedMedia(item: MediaItem): void {
    const key = item.sourceUrl || item.guid;
    if (!key || !item.mediaDetails) return;
    if (pickedMedia.size >= MAX_REMEMBERED && !pickedMedia.has(key)) {
        const oldest = pickedMedia.keys().next().value;
        if (oldest !== undefined) pickedMedia.delete(oldest);
    }
    pickedMedia.set(key, item.mediaDetails);
}

/** Metadata for a src previously registered by the picker (undefined = miss). */
export function getPickedMedia(src?: string): MediaSizes | undefined {
    return src ? pickedMedia.get(src) : undefined;
}
