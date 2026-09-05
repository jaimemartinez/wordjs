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
 * WHO WRITES THE PROPS. The Image block persists a `src` string, and a custom field's onChange can
 * only set its own prop, so the responsive props are written by the two places that CHANGE an
 * Image's src, inside the same edit that changes it:
 *   1. The Image block's media field (lib/verso/coreBlocks.tsx). MediaPicker onSelect registers the
 *      full MediaItem here (rememberPickedMedia); the field then commits `src` together with the
 *      props `imageMediaPropsFor()` derives from that registry entry, as ONE setProps command.
 *   2. "Recursos" in the editor toolbar (components/verso/editor/VersoEditor.tsx), which builds a
 *      ready-made Image block: it derives the same props straight from the MediaItem it was handed.
 * One command, not two, and that is not tidiness: two commands are two history entries, and undoing
 * only the second would leave the PREVIOUS image's srcset attached to the new src — precisely the
 * state the invalidation below exists to prevent.
 *
 * Both paths are ordinary editor commands, so the props ride the normal publish path into
 * `_puck_data` and the public SSR render reads them like any other prop. Zero network, zero guessed
 * URLs.
 *
 * A src that did not come from the picker — an external URL, an address typed by hand — has no
 * metadata to build from, so `imageMediaPropsFor` CLEARS all four props: a srcset must never outlive
 * the image it describes. Pages saved before this feature only carry `src`; every helper degrades to
 * "no srcset" and the render is byte-identical to the old output. There is no server-side backfill
 * for them (the API has no lookup from an upload URL back to its attachment), so a pre-existing
 * Image gains its variants the next time an author re-picks it from the library.
 *
 * The retired registry in components/versoConfig.tsx carries a `resolveData` copy of this
 * derivation. That module is mounted by nothing but the anti-drift gate, so it produces nothing.
 *
 * The cropped `thumbnail` variant is excluded unless its aspect ratio matches
 * the original (a cropped candidate in srcset would let the browser swap in a
 * differently-framed image).
 */

import type { MediaItem } from "./api";

/**
 * A modern-format derivative the backend produced beside a size (or beside the original), keyed by
 * MIME type in a `sources` map. Same naming rules as a size entry: a BARE filename living in the
 * same directory as the original.
 */
export interface MediaSource {
    file: string;
    width?: number;
    height?: number;
    mimeType?: string;
    filesize?: number;
}

/** Shape of `MediaItem.mediaDetails` (all-optional for robustness). */
export interface MediaSizes {
    width?: number;
    height?: number;
    file?: string;
    filesize?: number;
    /** WebP/AVIF derivatives of the FULL-SIZE original. Absent on anything uploaded before 2026-09. */
    sources?: Record<string, MediaSource>;
    sizes?: Record<string, {
        file: string;
        width: number;
        height: number;
        mimeType?: string;
        filesize?: number;
        /** WebP/AVIF derivatives of THIS size. */
        sources?: Record<string, MediaSource>;
    }>;
}

/**
 * The modern formats a `<picture>` may offer, MOST EFFICIENT FIRST — `<source>` order is the
 * selection order, so AVIF must precede WebP or a browser that supports both takes the bigger file.
 */
export const MODERN_SOURCE_TYPES = ["image/avif", "image/webp"] as const;
export type ModernSourceType = (typeof MODERN_SOURCE_TYPES)[number];

/** Per-format srcsets, keyed by MIME type; a format the upload did not produce is simply absent. */
export type ModernSrcSets = Partial<Record<ModernSourceType, string>>;

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

/** width -> url map rendered as an ascending `url 640w, url 960w, …` srcset. */
function toSrcSet(byWidth: Map<number, string>): string {
    return [...byWidth.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([w, url]) => `${url} ${w}w`)
        .join(", ");
}

/**
 * The largest `w` descriptor in a srcset string, or 0 when there is none to read.
 *
 * WHY A RENDERER NEEDS THIS. `<picture>` selection is: the FIRST `<source>` whose `type` the browser
 * supports wins, and the candidate is then chosen from THAT source's srcset alone — the `<img>`'s own
 * srcset is never consulted afterwards. So a modern-format srcset that stops short of the widest
 * original-format candidate does not "fall back to the original for big screens"; it CAPS every
 * browser that supports the format at its own widest entry. Comparing the two ceilings is the whole
 * check, and it has to be readable from the persisted props, not only from the metadata that built
 * them — pages saved before this rule existed carry the capped map already.
 */
export function srcSetMaxWidth(srcSet?: string): number {
    if (!srcSet) return 0;
    let max = 0;
    for (const candidate of srcSet.split(",")) {
        const descriptor = candidate.trim().split(/\s+/)[1];
        const m = /^(\d+)w$/.exec(descriptor || "");
        if (m) max = Math.max(max, Number(m[1]));
    }
    return max;
}

/**
 * Build a srcset (+ default sizes) for `src` from backend-reported variant
 * metadata. Returns {} when there is nothing useful (no meta, no image sizes,
 * or fewer than two distinct width candidates).
 *
 * MODERN FORMATS. Since 2026-09 the upload pipeline also writes a WebP (and, where sharp can encode
 * it, an AVIF) beside every size and beside the original, recorded in a `sources` map keyed by MIME
 * type. Those become `modern`: one srcset PER FORMAT, built from the very same authoritative
 * metadata and the very same crop-exclusion rule, so the renderer can offer them as `<source>`
 * elements. They are never derived by rewriting an extension — the naming is the backend's business
 * and a guessed URL is a 404 (see this file's header). A format the upload did not produce is simply
 * absent from `modern`, and an attachment from before the feature produces an empty `modern`, so the
 * markup falls back to exactly the `<img>` it rendered before.
 *
 * `modern` is populated INDEPENDENTLY of the two-candidate threshold that governs `srcSet`: a single
 * WebP is still a real byte win even when there is only one width to offer it at, whereas a
 * single-candidate original-format srcset only adds markup. It is NOT independent of how WIDE the
 * original format reaches — a format whose widest derivative falls short of the widest original-format
 * candidate is dropped entirely rather than offered as a cap. See the rule at the end of the function.
 */
export function buildSrcSet(
    src: string,
    meta?: MediaSizes
): { srcSet?: string; sizes?: string; modern?: ModernSrcSets } {
    if (!src || !meta || !meta.sizes) return {};

    const lastSlash = src.lastIndexOf("/");
    const dir = lastSlash >= 0 ? src.slice(0, lastSlash) : "";

    const originalRatio = meta.width && meta.height ? meta.width / meta.height : 0;

    const byWidth = new Map<number, string>();
    // One width->url map per modern format, filled in lockstep with `byWidth` so a candidate is
    // offered in a modern format only when it was already a legitimate original-format candidate.
    const modernByWidth = new Map<ModernSourceType, Map<number, string>>(
        MODERN_SOURCE_TYPES.map((type) => [type, new Map<number, string>()])
    );

    const addModern = (width: number, sources?: Record<string, MediaSource>): void => {
        if (!sources) return;
        for (const type of MODERN_SOURCE_TYPES) {
            const file = sources[type]?.file;
            if (file) modernByWidth.get(type)!.set(width, `${dir}/${file}`);
        }
    };

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
        addModern(entry.width, entry.sources);
    }

    // The original is always the largest candidate.
    if (meta.width && meta.width > 0) {
        byWidth.set(meta.width, src);
        // Above its decoded-size budget (MODERN_MAX_DECODED_BYTES, ~8 MP — i.e. most phone and camera
        // uploads) the backend produces no modern derivative AT ALL: the full-size encode gates its
        // own ladder, so this entry now goes missing only together with the rest of its format. A map
        // that carries ladder entries and no full-size one can still arrive out of metadata written
        // before that rule, and it does NOT degrade gracefully: see the rule below.
        addModern(meta.width, meta.sources);
    }

    // A FORMAT IS OFFERED ONLY IF IT REACHES AS WIDE AS THE ORIGINAL FORMAT DOES.
    //
    // `<picture>` picks the first `<source>` whose type the browser supports and then chooses a
    // candidate from THAT srcset only; the `<img>`'s candidates are never reconsidered. A WebP/AVIF
    // ladder that stops at 1920 while the original-format srcset runs to 3000 therefore does not mean
    // "big screens get the original" — it means EVERY modern browser is capped at 1920, a silent
    // resolution downgrade shipped as an optimization. Dropping such a format costs bytes on narrow
    // viewports; keeping it costs pixels on wide ones, and pixels are the thing the reader can see.
    const fullWidth = Math.max(0, ...byWidth.keys());
    const modern: ModernSrcSets = {};
    for (const type of MODERN_SOURCE_TYPES) {
        const map = modernByWidth.get(type)!;
        if (map.size === 0) continue;
        if (Math.max(...map.keys()) < fullWidth) continue;
        modern[type] = toSrcSet(map);
    }
    const hasModern = Object.keys(modern).length > 0;

    if (byWidth.size < 2) {
        // A single original-format candidate adds bytes, not value — but a modern format at that one
        // width is still worth offering.
        return hasModern ? { modern, sizes: DEFAULT_SIZES } : {};
    }

    return { srcSet: toSrcSet(byWidth), sizes: DEFAULT_SIZES, ...(hasModern ? { modern } : {}) };
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
 * True when every srcset candidate belongs to `src`: the original itself, a
 * `<src-minus-ext>-...` sibling (the backend's SIZE naming), or a
 * `<src-minus-ext>.<ext>` sibling (its MODERN-FORMAT naming: the full-size WebP of
 * `photo-ab12cd34.jpg` is `photo-ab12cd34.webp`, which shares the stem but not the dash).
 * Used to detect a hand-edited src whose stored srcSets would point at the OLD image.
 *
 * Both prefixes are anchored on the WHOLE extension-less src, which for an upload ends in a uuid8
 * suffix, so a different image cannot satisfy either one.
 */
export function srcSetBelongsTo(src: string, srcSet: string): boolean {
    if (!src || !srcSet) return false;
    const base = withoutExt(src);
    return srcSet.split(",").every((candidate) => {
        const url = candidate.trim().split(/\s+/)[0];
        return url === src || url.startsWith(`${base}-`) || url.startsWith(`${base}.`);
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

/**
 * The four responsive-image props an Image block persists next to its `src`.
 *
 * Every one of them is optional, and `undefined` is also how each is CLEARED: a `setProps` patch
 * whose value is `undefined` removes the key outright (lib/verso/commands.ts), so the block goes back
 * to the exact prop set a page saved before this feature carries.
 */
export interface ImageMediaProps {
    srcSet?: string;
    srcSetModern?: ModernSrcSets;
    imgWidth?: number;
    imgHeight?: number;
}

/**
 * The responsive-image props an Image block must carry once its `src` becomes `nextSrc`.
 *
 * THREE OUTCOMES, and the middle one is the only reason this needs the previous src:
 *  - `nextSrc` was picked from the media library in this session -> build from the backend-reported
 *    variants, the authoritative map (see this file's header).
 *  - `nextSrc` is what the block already had -> nothing about the image changed, so whatever it
 *    carries still describes the right file and is handed back untouched. Without this branch an
 *    edit that merely re-commits the same src would strip the srcset off every page loaded from
 *    storage, whose picker registry is empty by construction: the registry is per session, the saved
 *    page is not.
 *  - anything else — an address typed by hand, an external URL, an item picked in some other session
 *    — is a DIFFERENT image about which nothing is known, so all four props are cleared. Keeping them
 *    would offer the previous image's variant URLs (a 404 at best, the wrong picture at worst) and
 *    its intrinsic width/height, which is a wrong aspect-ratio box on a file the browser has not
 *    measured yet.
 */
export function imageMediaPropsFor(
    nextSrc: string,
    previous: ImageMediaProps,
    previousSrc?: string
): ImageMediaProps {
    const picked = getPickedMedia(nextSrc);
    if (picked) {
        const built = buildSrcSet(nextSrc, picked);
        return {
            srcSet: built.srcSet,
            srcSetModern: built.modern,
            imgWidth: picked.width || undefined,
            imgHeight: picked.height || undefined,
        };
    }
    if (nextSrc && nextSrc === previousSrc) {
        return {
            srcSet: previous.srcSet,
            srcSetModern: previous.srcSetModern,
            imgWidth: previous.imgWidth,
            imgHeight: previous.imgHeight,
        };
    }
    return { srcSet: undefined, srcSetModern: undefined, imgWidth: undefined, imgHeight: undefined };
}

/**
 * The same props for a MediaItem the caller ALREADY holds, with the keys it cannot fill OMITTED
 * rather than set to `undefined`.
 *
 * The toolbar's "insert an Image from the library" builds the whole block itself and never asks the
 * picker registry anything, so it needs the derivation without the registry lookup in front of it —
 * and it is building a NEW block, where there is nothing to clear. Absent keys are exactly the prop
 * set an Image without variants carries, so an upload from before the derivatives existed produces
 * the same block it always did instead of one decorated with four empty slots.
 *
 * `mediaDetails` is declared without `sources` in lib/api.ts while the backend does send them
 * (models/Media.ts) — `MediaSizes` above is the type that models the wire shape, hence the widening.
 */
export function imageMediaPropsForItem(item: MediaItem): ImageMediaProps {
    const src = item.sourceUrl || item.guid;
    const meta = item.mediaDetails as MediaSizes | undefined;
    const built = buildSrcSet(src, meta);
    const props: ImageMediaProps = {};
    if (built.srcSet) props.srcSet = built.srcSet;
    if (built.modern && Object.keys(built.modern).length > 0) props.srcSetModern = built.modern;
    if (meta?.width) props.imgWidth = meta.width;
    if (meta?.height) props.imgHeight = meta.height;
    return props;
}
