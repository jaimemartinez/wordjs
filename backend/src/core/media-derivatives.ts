/**
 * WordJS — the image derivatives of a stored file: the size ladder and its WebP/AVIF versions.
 *
 * Extracted from the upload route so the WordPress importer (core/wxr-media) stores an imported image
 * exactly as an uploaded one: the same thumbnail/medium/large trio and width ladder, the same modern
 * formats under the same process-wide encode budget, recorded in the same `sizes` / `sources` shape
 * models/Media.create() writes into `_wp_attachment_metadata`. Every rationale below is the one the upload
 * route carried; nothing about the output changed by moving it.
 */

const path = require('path');
const fs = require('fs');
const log = require('./module-logger').moduleLogger('core/media-derivatives');

// SECURITY (DoS): cap decoded pixels for EVERY sharp() pipeline (here and in routes/media.ts) so a maliciously
// oversized image (a "pixel bomb") can't exhaust memory and OOM/CPU-kill the single-process
// backend during upload processing. ~40 megapixels is far above any legitimate web image.
const MAX_SHARP_INPUT_PIXELS = 40_000_000;

/**
 * MODERN IMAGE FORMATS (WebP/AVIF) — produced at upload time BESIDE every size, never instead of it.
 *
 * Until now every derivative kept the SOURCE format, so a JPEG upload produced a ladder of JPEGs and
 * the public markup could only ever offer JPEG bytes. `middleware/image-negotiation.ts` already
 * covers the delivery side (same URL, `Accept`-driven, cached under `<uploads>/.derivatives`), but it
 * pays a full transcode on the FIRST request for every file and every ladder width, and it can only
 * answer a request that already arrived. Encoding once, here, makes those bytes static assets that
 * `express.static` serves cold, and lets the renderer name them explicitly in `<picture>`.
 *
 * There is no `media` block in config/app.ts, so these are constants; if one is ever added they are
 * the natural contents of `config.media.formats`.
 */
const MODERN_FORMATS = Object.freeze([
    Object.freeze({ key: 'webp', mimeType: 'image/webp', ext: '.webp' }),
    Object.freeze({ key: 'avif', mimeType: 'image/avif', ext: '.avif' }),
]);
const WEBP_QUALITY = 82;
const AVIF_QUALITY = 55;
const AVIF_EFFORT = 4; // libaom effort; same setting the negotiation middleware uses
/**
 * Source types we derive modern formats from. Animated GIFs are excluded at runtime (see `pages`
 * below) because a single-frame re-encode would silently drop the animation, and SVG is a vector —
 * there is nothing to transcode. A source that is ALREADY webp/avif is not in the set either: it
 * would only be re-encoded into itself.
 */
const MODERN_SOURCE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif']);
/**
 * The ladder entries are bounded by construction (<=1920 wide), but the FULL-SIZE original is not,
 * and an AVIF encode costs far more than the decoded buffer it works on — measured on this repo's
 * sharp/libvips, a 24MP source cost ~1.1GB peak RSS and 18s for ONE encode. Bound the decoded size
 * before committing to a full-size encode. Same number and rationale as image-negotiation's
 * MAX_DECODED_BYTES.
 *
 * OVER BUDGET THE WHOLE FORMAT IS GIVEN UP, NOT ONLY ITS FULL-SIZE ENTRY. This comment used to claim
 * the opposite — "the modern `<source>` tops out at the widest ladder entry" — and that is not a
 * behaviour `<picture>` can express: a browser picks the FIRST `<source>` whose type it supports and
 * then chooses a candidate from THAT srcset only, so a WebP/AVIF ladder that stops at 1920 while the
 * original-format srcset runs to 4032 does not mean "wide screens get the original", it means every
 * modern browser is capped at 1920. The renderer therefore refuses such a format outright
 * (frontend/src/lib/imageSrcset.ts buildSrcSet: `if (Math.max(...map.keys()) < fullWidth) continue`,
 * repeated on the persisted props in frontend/src/components/content/blocks.tsx) — which made every
 * per-size derivative produced WITHOUT its full-size sibling a file that is encoded, written, recorded
 * in `_wp_attachment_metadata` and then never selected by anything: CPU, upload latency and disk spent
 * on nothing, plus slots of MODERN_ENCODE_CONCURRENCY taken from a concurrent upload whose derivatives
 * WOULD have been rendered.
 *
 * So the full-size derivative is now the GATE for its own format: it is encoded first and alone, and
 * the ladder runs only for the formats it actually produced (see the upload handler). Above this
 * budget no full-size task is created at all, so the upload simply gets no modern derivatives and no
 * `sources` map, with the original-format `<img>` still covering every width exactly as before.
 *
 * The alternative — encoding the "full-size" modern from the widest LADDER entry so the format does
 * reach the top — was rejected: buildSrcSet keys the full-size modern candidate by `meta.width`, so a
 * 1920px file offered under a 4032w descriptor would hand wide screens an upscaled image. Fewer bytes
 * on narrow viewports is not worth lying about pixels the reader can see.
 */
const MODERN_MAX_DECODED_BYTES = 24 * 1024 * 1024; // ~8MP RGB
/**
 * The size ladder encodes in parallel because those are cheap resizes of one decoded image. AVIF is
 * not cheap: three concurrent 1920px encodes are ~1GB of working set. Cap how many modern encodes
 * run at once so an upload cannot OOM a small host.
 *
 * MODULE-SCOPED, exactly like `activeTranscodes` in middleware/image-negotiation.ts, and for the same
 * reason that file states in its own comment: a budget that lives inside one call bounds nothing.
 * `encodeModernDerivatives` runs once per REQUEST, so a cap applied only to that call's worker count
 * let N simultaneous uploads run 2N concurrent AVIF encodes — and `upload_files` is a
 * contributor-level capability, so N is chosen by whoever may upload, not by the host (multer's
 * `files` limit multiplies it again within a single request). The budget therefore lives here, shared
 * across every request and every file inside one.
 */
const MODERN_ENCODE_CONCURRENCY = 2;
let activeModernEncodes = 0;

/**
 * Which modern formats this install can actually WRITE. WebP is compiled into every prebuilt sharp;
 * AVIF is not, and the capability is reported inconsistently across builds: sharp 0.35 exposes it as
 * `format.heif` (with `alias: ['avif']`) and leaves `format.avif` undefined, while other builds
 * expose `format.avif` directly. Ask for both, and treat a build that reports neither as WebP-only.
 */
function supportedModernFormats(sharpLib: any): { key: string; mimeType: string; ext: string }[] {
    const formats = sharpLib?.format || {};
    return MODERN_FORMATS.filter((f) => {
        if (f.key !== 'avif') return true;
        return Boolean(formats.avif?.output?.file || formats.heif?.output?.file);
    }) as { key: string; mimeType: string; ext: string }[];
}

/** One (size x format) encode still to run. `build()` returns a FRESH pipeline off the shared decode. */
interface ModernEncodeTask {
    stem: string;                    // derivative filename without extension
    build: () => any;                // sharp pipeline, already resized for this size
    out: Record<string, any>;        // filled with mimeType -> derivative record
}

/**
 * Encode every (task x format) pair with a bounded number in flight — bounded PROCESS-WIDE, not per
 * call (see MODERN_ENCODE_CONCURRENCY).
 *
 * NEVER throws: a modern format is an optimization, so a failed encode (an unsupported colourspace,
 * a libheif that refuses the input, a full disk) is logged, its half-written file removed, and the
 * upload continues with the original format — which is exactly what a pre-2026 install served. An
 * encode that does not fit the budget takes the SAME degraded path, for the same reason.
 */
async function encodeModernDerivatives(
    tasks: ModernEncodeTask[],
    formats: { key: string; mimeType: string; ext: string }[],
    dir: string
): Promise<void> {
    const queue: { task: ModernEncodeTask; format: { key: string; mimeType: string; ext: string } }[] = [];
    for (const task of tasks) for (const format of formats) queue.push({ task, format });

    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < queue.length) {
            // The budget is claimed HERE — around the encode itself — rather than around the whole
            // call, so a worker holds a slot only while it is actually encoding and a single upload
            // still gets its full MODERN_ENCODE_CONCURRENCY of parallelism when nothing else runs.
            //
            // Over budget this worker STEPS ASIDE rather than draining the queue: `next` is shared,
            // so a worker that consumed the remaining tasks to mark them skipped would cancel the
            // derivatives its own sibling is still perfectly able to produce one at a time. Returning
            // degrades the PARALLELISM first and the output only when no slot is free at all.
            //
            // And it never queues. Waiting would hold this request, its multer temp file and its
            // socket open for however long someone else's full-size AVIF takes (measured at 18s for
            // one 24MP encode), turning a memory bound into a request-slot bound. Degrading is the
            // same never-throw contract a failed encode already takes: the upload commits with its
            // original-format ladder, which is exactly what a pre-2026 install served.
            if (activeModernEncodes >= MODERN_ENCODE_CONCURRENCY) return;
            activeModernEncodes++;
            const { task, format } = queue[next++];
            // `task.stem` is a basename by construction (path.basename(...) at both call sites), but the
            // sink below deletes a file, so the containment is proven HERE, next to the sink, in the shape
            // a taint analysis recognises: basename() strips any directory component, and the resolved
            // target must stay under `dir`. A stem that fails either test is skipped, never written.
            const file = path.basename(`${task.stem}${format.ext}`);
            const target = path.resolve(dir, file);
            if (!target.startsWith(path.resolve(dir) + path.sep)) { activeModernEncodes--; continue; }
            try {
                const pipeline = task.build();
                const info = format.key === 'avif'
                    ? await pipeline.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT }).toFile(target)
                    : await pipeline.webp({ quality: WEBP_QUALITY }).toFile(target);
                task.out[format.mimeType] = {
                    file,
                    width: info.width,
                    height: info.height,
                    mimeType: format.mimeType,
                    filesize: info.size,
                };
            } catch (err: any) {
                log.warn({ err }, `Media upload: ${format.key} derivative failed for ${file} — keeping the original format only`);
                try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch { /* best effort */ }
            } finally {
                activeModernEncodes--;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(MODERN_ENCODE_CONCURRENCY, queue.length) }, worker));
    // ONE line per upload, not one per skipped task: a saturated host is a single operational fact,
    // and a line per (size x format) pair would bury it under its own repetition.
    const skipped = queue.length - next;
    if (skipped > 0) {
        log.warn({ skipped }, `Media upload: skipped ${skipped} modern derivative encode(s) — the host was already at its encode budget (${MODERN_ENCODE_CONCURRENCY} concurrent). The upload keeps its original-format sizes.`);
    }
}

/**
 * Write the size ladder and the modern-format derivatives of the image at `filePath` beside it, and
 * return what models/Media.create() records: intrinsic (EXIF-oriented) dimensions, `sizes` and `sources`.
 * A non-image, an SVG or an image sharp cannot decode yields zero dimensions and empty maps. Never throws.
 */
async function generateImageDerivatives(filePath: string, mimeType: string): Promise<{ width: number; height: number; sizes: Record<string, any>; sources: Record<string, any> }> {
    const { getOption } = require('./options');
    const sharp = require('sharp');
    let width = 0;
    let height = 0;
    const sizes: Record<string, any> = {};
    // Modern-format derivatives of the FULL-SIZE original, keyed by MIME type. The per-size ones live
    // under `sizes[<name>].sources`; this is the same map for the image the ladder is derived from.
    let sources: Record<string, any> = {};

    if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
        try {
            const image = sharp(filePath, { limitInputPixels: MAX_SHARP_INPUT_PIXELS });
            const metadata = await image.metadata();
            // EXIF-oriented intrinsic dimensions: orientations 5–8 are 90°-rotated, so the pixels
            // display transposed. Storing the raw values put a phone photo's width/height backwards.
            const exifTransposed = (metadata.orientation || 1) >= 5;
            width = exifTransposed ? metadata.height : metadata.width;
            height = exifTransposed ? metadata.width : metadata.height;

            // Get target sizes from DB
            const thumbW = await getOption('thumbnail_size_w', 150);
            const thumbH = await getOption('thumbnail_size_h', 150);
            const mediumW = await getOption('medium_size_w', 300);
            const mediumH = await getOption('medium_size_h', 300);
            const largeW = await getOption('large_size_w', 1024);
            const largeH = await getOption('large_size_h', 1024);

            // The classic WordPress trio, PLUS a modern width ladder. The trio alone (150/300/1024)
            // gives srcset almost nothing to choose from above 1024px, so a hero on a 1440px screen
            // downloaded the ORIGINAL — often several megabytes. The ladder gives the browser real
            // candidates at the widths screens actually use; buildSrcSet picks them up automatically
            // (it takes any uncropped variant with a file + width) and skips anything wider than the
            // source, so a small upload still produces only what it can.
            const LADDER = [640, 960, 1280, 1920];
            const sizeDefinitions: { name: string; w: number; h: number | null; crop: boolean }[] = [
                { name: 'thumbnail', w: thumbW, h: thumbH, crop: true },
                { name: 'medium', w: mediumW, h: mediumH, crop: false },
                { name: 'large', w: largeW, h: largeH, crop: false },
                ...LADDER.map((w) => ({ name: `w${w}`, w, h: null, crop: false })),
            ];

            const dir = path.dirname(filePath);
            const ext = path.extname(filePath);
            const baseName = path.basename(filePath, ext);

            // ONE decode for every derivative (clone() shares the decoded pipeline; the old loop
            // re-decoded the file per size), auto-oriented with .rotate() — without it EXIF-rotated
            // phone photos produced sideways thumbnails. Encodes run in parallel.
            const oriented = image.rotate();
            // Collected while the ladder runs, encoded afterwards (see encodeModernDerivatives): one
            // entry per size that actually produced a file, so we never encode a WebP for a size the
            // ladder skipped as an upscale. Collecting is not committing — whether these run at all,
            // and in which formats, is decided below by the full-size derivative.
            const modernTasks: ModernEncodeTask[] = [];
            const modernAttachers: (() => void)[] = [];
            await Promise.all(sizeDefinitions.map(async (s) => {
                // Skip if the original is already smaller than the target — never upscale. A ladder
                // entry constrains WIDTH only (h === null), so it is judged on width alone.
                if (s.h === null) {
                    if (width <= s.w) return;
                } else if (width <= s.w && height <= s.h && s.name !== 'thumbnail') {
                    return;
                }

                // Ladder files are named by width alone: with fit:'inside' the height is derived
                // from the source ratio, so a `<w>x<h>` name built from the TARGET would claim a
                // height the file does not have.
                // The same holds for a fitted (not cropped) w×h size: «medium» 300×300 of a 3:2 photo IS
                // 300×200, and its name said 300x300 (QA S1-23). Name it by the dimensions fit:'inside'
                // produces; a cropped size really is w×h.
                const fitted = (() => {
                    if (s.h === null || s.crop) return { w: s.w, h: s.h };
                    const scale = Math.min(s.w / width, (s.h as number) / height, 1);
                    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
                })();
                const sizeFilename = s.h === null
                    ? `${baseName}-${s.w}w${ext}`
                    : `${baseName}-${fitted.w}x${fitted.h}${ext}`;
                const sizePath = path.join(dir, sizeFilename);

                const resizeOp = s.crop
                    ? oriented.clone().resize(s.w, s.h as number, { fit: 'cover' })
                    : oriented.clone().resize(s.w, s.h ?? undefined, { fit: 'inside', withoutEnlargement: true });

                const info = await resizeOp.toFile(sizePath);

                sizes[s.name] = {
                    file: sizeFilename,
                    width: info.width,
                    height: info.height,
                    mimeType: mimeType,
                    filesize: info.size
                };

                const out: Record<string, any> = {};
                modernTasks.push({
                    stem: path.basename(sizeFilename, ext),
                    // A pipeline is consumed by toFile(), so the task rebuilds its own clone off the
                    // shared decode rather than reusing `resizeOp`.
                    build: () => (s.crop
                        ? oriented.clone().resize(s.w, s.h as number, { fit: 'cover' })
                        : oriented.clone().resize(s.w, s.h ?? undefined, { fit: 'inside', withoutEnlargement: true })),
                    out,
                });
                // Only attached when at least one encode succeeded, so metadata never grows an empty
                // `sources: {}` on a host without a modern encoder.
                modernAttachers.push(() => { if (Object.keys(out).length) sizes[s.name].sources = out; });
            }));

            // ---- Modern formats (WebP/AVIF), beside every size and the original ----
            // A source type we cannot meaningfully re-encode (SVG is already excluded above, an
            // animated GIF would lose its animation, a WebP/AVIF source would be encoded into itself)
            // simply produces no derivatives: `sizes`/`sources` keep exactly the shape they had. So
            // does a source too large to encode a full-size derivative from — see
            // MODERN_MAX_DECODED_BYTES for why a ladder without its full-size sibling is unrenderable.
            const isAnimated = (metadata.pages || 1) > 1;
            const decodedBytes = (metadata.width || 0) * (metadata.height || 0)
                * (metadata.channels || 3) * (metadata.depth === 'ushort' ? 2 : 1);
            const withinModernBudget = decodedBytes > 0 && decodedBytes <= MODERN_MAX_DECODED_BYTES;
            if (MODERN_SOURCE_MIMES.has(mimeType) && !isAnimated && withinModernBudget) {
                // THE FULL-SIZE DERIVATIVE IS THE GATE FOR ITS OWN FORMAT. A per-size WebP/AVIF is
                // only ever rendered if that format also reaches the widest candidate, which is the
                // full-size one; without it buildSrcSet drops the format entirely and every ladder
                // file becomes write-only. Encoding it FIRST and alone, then running the ladder for
                // the formats it actually produced, closes all three ways it can be missing with one
                // rule: over the decoded-byte budget (no task exists at all — the condition above), an
                // encoder that throws for this input, and a host already at MODERN_ENCODE_CONCURRENCY,
                // where the ladder is now given up instead of being encoded into files nothing can
                // select. It also inverts the old ordering, which pushed the full-size task LAST and
                // so made the one encode that makes the set renderable the FIRST casualty of a busy
                // host.
                const available = supportedModernFormats(sharp);
                const fullOut: Record<string, any> = {};
                await encodeModernDerivatives(
                    [{ stem: baseName, build: () => oriented.clone(), out: fullOut }],
                    available,
                    dir
                );
                const renderable = available.filter((f) => Boolean(fullOut[f.mimeType]));
                if (renderable.length) {
                    // Non-empty by construction, so metadata still never grows an empty `sources: {}`.
                    sources = fullOut;
                    await encodeModernDerivatives(modernTasks, renderable, dir);
                    for (const attach of modernAttachers) attach();
                }
            }
        } catch (err) {
            log.error({ err }, 'Image processing failed');
        }
    }

    return { width, height, sizes, sources };
}

module.exports = { MAX_SHARP_INPUT_PIXELS, generateImageDerivatives, supportedModernFormats, encodeModernDerivatives };
