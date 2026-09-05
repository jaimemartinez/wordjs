/**
 * WordJS - Media Routes
 * /api/v1/media/*
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Media = require('../models/Media');
const Post = require('../models/Post');
const config = require('../config/app');

// SECURITY (DoS): cap decoded pixels for EVERY sharp() pipeline in this file so a maliciously
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
                console.warn(`Media upload: ${format.key} derivative failed for ${file} — keeping the original format only:`, err?.message || err);
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
        console.warn(`Media upload: skipped ${skipped} modern derivative encode(s) — the host was already at its encode budget (${MODERN_ENCODE_CONCURRENCY} concurrent). The upload keeps its original-format sizes.`);
    }
}

/**
 * multer is pulled in with require() and tsconfig pins `types` to ["node"], so @types/multer's
 * ambient augmentation of Express.Request is not part of this program: neither the storage/filter
 * callback signatures nor `req.file` are visible to the compiler. These describe exactly the multer
 * surface this file touches, so the handlers below get real checking instead of the parameter being
 * annotated `any` (or cast back to it, which is the same thing wearing a type).
 */

/** What multer hands the diskStorage/fileFilter callbacks, BEFORE the upload reaches disk. */
interface IncomingFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
}

/** What multer attaches to `req.file` once the upload has been stored. */
interface StoredFile extends IncomingFile {
    size: number;
    destination: string;
    filename: string;
    path: string;
}

type UploadRequest = Request & { file?: StoredFile };

/**
 * @swagger
 * components:
 *   schemas:
 *     Media:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         title:
 *           type: string
 *         mimeType:
 *           type: string
 *         sourceUrl:
 *           type: string
 *         date:
 *           type: string
 *           format: date-time
 */
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery, requireRouteId } = require('../core/query-params');

// THE ROUTE-ID CONTRACT — see core/query-params. `:id` is an attachment's post id, parsed with a bare
// `parseInt` at all three sites and handed to `Media.findById` → `Post.findById`, the same sink
// routes/posts.ts uses. So this router carried the same two defects: `/media/9999999999` is
// `22003 value out of range for type integer` (a 500) on Postgres, and `/media/12abc` SERVED
// attachment 12, because parseInt stops at the first character it cannot use. GET is optionalAuth, so
// the 500 needed no credentials. The body below is the one all three routes already send for an
// attachment that does not exist, so a malformed id is now indistinguishable from an absent one.
router.param('id', requireRouteId({ code: 'rest_post_invalid_id', message: 'Invalid media ID.' }));

/**
 * The six parameters GET /media reads. The library list is the twin of the categories/tags/users
 * lists, which have refused a repeated scalar since the first round; this one was left behind, and
 * `String()` hid it: `['asc','desc'].includes(String(order).toLowerCase())` cannot throw, it just
 * compares 'asc,desc' against the whitelist, misses, and sorts DESC — the caller is told nothing.
 * `orderByMap[String(orderby)]` misses the same way and silently falls back to post_date.
 */
const MEDIA_LIST_QUERY_FIELDS: readonly string[] = Object.freeze([
    'page', 'per_page', 'search', 'mime_type', 'orderby', 'order',
]);

// Ensure uploads directory exists
if (!fs.existsSync(config.uploads.dir)) {
    fs.mkdirSync(config.uploads.dir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: (req: Request, file: IncomingFile, cb: (error: Error | null, destination: string) => void) => {
        // Create year/month subdirectory
        const date = new Date();
        const subDir = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        const uploadPath = path.join(config.uploads.dir, subDir);

        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }

        cb(null, uploadPath);
    },
    filename: (req: Request, file: IncomingFile, cb: (error: Error | null, filename: string) => void) => {
        // SECURITY: Derive the STORED extension from the validated MIME->extension allowlist
        // (Media.getExtensionForMime), NOT from the client-supplied originalname. This prevents
        // a malicious filename (e.g. "x.php"/"x.html") from being persisted/served verbatim.
        // fileFilter already rejected MIME types without a safe mapped extension, so resolvedExt
        // is expected to be present here; fall back defensively just in case.
        const resolvedExt = Media.getExtensionForMime(file.mimetype);
        const ext = resolvedExt ? `.${resolvedExt}` : '';
        const name = path.basename(file.originalname, path.extname(file.originalname));
        const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
        const uniqueName = `${safeName}-${uuidv4().substring(0, 8)}${ext}`;
        cb(null, uniqueName);
    }
});

// File filter
const fileFilter = (req: Request, file: IncomingFile, cb: (error: Error | null, acceptFile: boolean) => void) => {
    // SECURITY: Block SVG uploads for non-admins (SVGs can contain JavaScript)
    if (file.mimetype === 'image/svg+xml') {
        if (!req.user || req.user.getRole() !== 'administrator') {
            return cb(new Error('SVG uploads are restricted to administrators only.'), false);
        }
    }

    // SECURITY: Explicitly reject dangerous extensions in the declared filename regardless of
    // the declared MIME (defense in depth — a benign MIME could carry an active-content name).
    const declaredExt = path.extname(file.originalname);
    if (Media.isDangerousExtension(declaredExt)) {
        return cb(new Error(`File extension ${declaredExt} is not allowed.`), false);
    }

    if (!Media.isAllowedMimeType(file.mimetype)) {
        return cb(new Error(`File type ${file.mimetype} is not allowed.`), false);
    }

    // SECURITY: The declared MIME must map to a safe stored extension; otherwise we cannot
    // persist it safely and must reject (getExtensionForMime also returns null for dangerous
    // extensions like .xml that are otherwise in the allowlist).
    if (!Media.getExtensionForMime(file.mimetype)) {
        return cb(new Error(`File type ${file.mimetype} cannot be stored safely.`), false);
    }

    cb(null, true);
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: config.uploads.maxFileSize,
        // SECURITY: Prevent CVE-2025-47935 (memory leak) and CVE-2025-47944 (malformed multipart)
        files: 10,          // Max 10 files per request
        fields: 50,         // Max 50 non-file fields
        parts: 100,         // Max total parts (fields + files)
        headerPairs: 2000   // Limit header pairs to prevent header bomb
    }
});

/**
 * @swagger
 * /media:
 *   get:
 *     summary: Retrieve media library
 *     tags: [Media]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: mime_type
 *         description: Filter by MIME type. A full type filters exactly (`image/png`); a bare family filters the whole family (`image` or `image/`).
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of media files
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Media'
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // Refuse a repeated scalar before anything reads it, so every comparison below is a string
    // comparison and the library the caller sees is the one they asked for.
    requireScalarQuery(req.query, MEDIA_LIST_QUERY_FIELDS);

    const {
        page = 1,
        per_page = 20,
        search,
        mime_type,
        orderby = 'date',
        order = 'desc'
    } = req.query;

    // String() before parseInt() only spells out the coercion parseInt has always performed on these
    // values: a query parameter is `string | string[] | ParsedQs | ...`, and parseInt's first step is
    // ToString on whatever it is given. `?per_page[]=5` still parses as 5, `?per_page=a&per_page=b`
    // still stringifies to 'a,b' and falls back to the default — identical to the untyped path.
    const limit = Math.min(parseInt(String(per_page), 10) || 20, 100);
    const offset = (Math.max(parseInt(String(page), 10) || 1, 1) - 1) * limit;

    // Same pair of request-value defects as routes/comments.ts (see the note there):
    //  · Object.create(null) so `?orderby=constructor` finds no inherited key and `|| 'post_date'` fires.
    //  · String() before .toLowerCase(), so `?order[]=asc` is a normal query and not a 500 for an
    //    anonymous caller — the shape routes/categories.ts and routes/tags.ts already use.
    const orderByMap: Record<string, string> = Object.assign(Object.create(null), {
        date: 'post_date',
        modified: 'post_modified',
        title: 'post_title',
        id: 'id'
    });

    // `mime_type` se desestructuraba desde SIEMPRE y no se pasaba a ninguna consulta: el filtro estaba
    // INERTE (la biblioteca devolvía todo, pidieras lo que pidieras). Va a las DOS consultas — filtrar
    // sólo las filas dejaría el total contando la biblioteca entera y el paginador ofreciendo páginas
    // vacías. Post.buildWhere valida la forma y decide exacto vs. familia.
    const media = await Media.findAll({
        search,
        mimeType: mime_type,
        limit,
        offset,
        orderBy: orderByMap[String(orderby)] || 'post_date',
        // SECURITY: Whitelist order direction
        order: ['asc', 'desc'].includes(String(order).toLowerCase()) ? String(order).toUpperCase() : 'DESC'
    });

    // SECURITY (Finding #9, BOLA / metadata leak): the media LIST must apply the SAME
    // parent-visibility rule as GET /media/:id. Attachments carry post_status='inherit', so
    // an attachment parented to a non-published (draft/pending/private) post inherits that
    // hidden visibility and must NOT leak its metadata (guid/file URL, author, title) to a
    // caller who neither owns the parent nor holds edit_others_posts. Unattached uploads
    // (parent=0) and dangling parents (deleted post → null) stay visible, exactly as the
    // single-item route treats them. A caller with edit_others_posts sees everything, so we
    // only pay the parent lookups when the caller lacks that cross-user capability.
    let visibleMedia = media;
    if (!req.user || !req.user.can('edit_others_posts')) {
        const parentIds = [...new Set(media.filter((m: any) => m.parent).map((m: any) => m.parent))];
        const parents = await Promise.all(parentIds.map((pid: any) => Post.findById(pid)));
        const parentById = new Map<any, any>();
        parentIds.forEach((pid: any, i: number) => parentById.set(pid, parents[i]));

        visibleMedia = media.filter((m: any) => {
            if (!m.parent) return true; // unattached upload → public
            const parent = parentById.get(m.parent);
            if (!parent || parent.postStatus === 'publish') return true; // dangling/published → public
            // Non-published parent: visible only to its owner (edit_others_posts already handled above).
            return !!req.user && parent.authorId === req.user.id;
        });
    }

    // Discount the attachments hidden on THIS page so the pager total does not advertise the
    // existence of items the caller was just denied (mirrors GET /:id returning 404, not 403).
    const hiddenOnPage = media.length - visibleMedia.length;
    const total = Math.max(0, (await Media.count({ search, mimeType: mime_type })) - hiddenOnPage);
    const totalPages = Math.ceil(total / limit);

    // String() is what res.set() already did to these numbers internally; spelling it out satisfies
    // the typed signature (string | string[]) and emits byte-identical headers.
    res.set('X-WP-Total', String(total));
    res.set('X-WP-TotalPages', String(totalPages));

    res.json(visibleMedia);
}));

/**
 * GET /media/:id
 * Get single media
 */
/**
 * @swagger
 * /media/{id}:
 *   get:
 *     summary: Read one media item
 *     description: An attachment inherits its visibility from its parent post. When that parent is not published, the item is hidden from anyone who is neither its author nor holder of edit_others_posts - and the answer is 404 rather than 403, so a hidden attachment does not reveal that it exists. An unattached attachment has no parent to inherit from and stays public.
 *     tags: [Media]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: The media item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Media'
 *       404:
 *         description: No such media item, or it is hidden from this caller (rest_post_invalid_id)
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
    // Express 5 types a route param as `string | string[]` (repeatable patterns like `/:id+`); this
    // route declares a single `/:id`, so the value is always a string at runtime. String() spells out
    // the ToString parseInt already applied, so the parse is unchanged for every possible input.
    const media = await Media.findById(parseInt(String(req.params.id), 10));

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }

    // SECURITY (metadata leak): an attachment carries post_status='inherit', i.e. it inherits its
    // visibility from its PARENT post. If that parent is non-published (draft/pending/private),
    // the attachment's metadata (guid/file path, author, title) must be hidden from non-owners
    // lacking edit_others_posts — exactly the rule GET /posts/:id applies to the post itself.
    // Unattached attachments (post_parent = 0) have no parent to inherit from and stay public
    // (WordPress treats inherit + no parent as published; the media library is addressable by URL
    // anyway). A dangling parent (deleted post) resolves to null and is likewise treated as public.
    if (media.parent) {
        const parent = await Post.findById(media.parent);
        if (parent && parent.postStatus !== 'publish') {
            if (!req.user || (parent.authorId !== req.user.id && !req.user.can('edit_others_posts'))) {
                // Mirror GET /posts/:id: 404 (not 403) so a hidden attachment's existence is not revealed.
                return res.status(404).json({
                    code: 'rest_post_invalid_id',
                    message: 'Invalid media ID.',
                    data: { status: 404 }
                });
            }
        }
    }

    res.json(media);
}));

/**
 * @swagger
 * /media:
 *   post:
 *     summary: Upload a new media file
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               title:
 *                 type: string
 *               caption:
 *                 type: string
 *     responses:
 *       201:
 *         description: Media uploaded
 *       400:
 *         description: Invalid file
 */
router.post('/', authenticate, can('upload_files'), upload.single('file'), asyncHandler(async (req: UploadRequest, res: Response) => {
    // Bound once into a const so the "an upload actually arrived" guard below still holds inside the
    // per-size callbacks further down; narrowing a property access does not survive a closure.
    const uploaded = req.file;
    if (!uploaded) {
        return res.status(400).json({
            code: 'rest_upload_no_file',
            message: 'No file was uploaded.',
            data: { status: 400 }
        });
    }

    // --- SECURITY CHECK: Magic Numbers & SVG Sanitization ---
    const fileType = require('file-type');
    const sanitizeHtml = require('sanitize-html');

    // SECURITY: Types whose binary signature MUST be confirmable. For these, a missing/unknown
    // magic-byte result is treated as a forgery attempt (fail-closed) rather than waved through.
    // SVG is text-based XML (no fixed signature) and is handled by the sanitization path below,
    // so it is intentionally excluded from this requirement.
    const declaredMime = uploaded.mimetype || '';
    const requiresSignature =
        (declaredMime.startsWith('image/') && declaredMime !== 'image/svg+xml') ||
        declaredMime === 'application/pdf';

    try {
        // SECURITY (GHSA-5v7r-6r5c-r473): file-type <=21.x has an ASF parser that can spin in an
        // infinite loop on a malformed ASF object (zero-size sub-header), hanging the single-process
        // event loop (DoS). We bound the magic-byte detection three ways:
        //   1. Read only the first MAGIC_BYTES of the file — all signatures we care about live in the
        //      header, and a bounded buffer caps how much the parser can iterate.
        //   2. Skip the ASF code path outright: an ASF file is identified by its leading GUID; no ASF
        //      MIME is on the upload allowlist (isAllowedMimeType), so detecting it could only ever
        //      lead to rejection. We treat an ASF magic prefix as "undetected" (fail-closed for types
        //      that require a signature; a disguised ASF is a forgery anyway).
        //   3. Race detection against a timeout so any other pathological parse cannot hang the loop.
        const MAGIC_BYTES = 4100; // sufficient for every signature file-type recognises
        // ASF/WMV/WMA header GUID (little-endian): 30 26 B2 75 8E 66 CF 11 A6 D9 00 AA 00 62 CE 6C
        const ASF_GUID = Buffer.from([
            0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
            0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C
        ]);

        const fd = fs.openSync(uploaded.path, 'r');
        let head: Buffer;
        try {
            const buf = Buffer.alloc(MAGIC_BYTES);
            const bytesRead = fs.readSync(fd, buf, 0, MAGIC_BYTES, 0);
            head = buf.subarray(0, bytesRead);
        } finally {
            fs.closeSync(fd);
        }

        let result;
        if (head.length >= ASF_GUID.length && head.subarray(0, ASF_GUID.length).equals(ASF_GUID)) {
            // ASF container — skip the vulnerable parser and treat as undetected.
            result = undefined;
        } else {
            const DETECT_TIMEOUT_MS = 3000;
            let timer: NodeJS.Timeout;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('file-type detection timed out')), DETECT_TIMEOUT_MS);
            });
            try {
                result = await Promise.race([fileType.fromBuffer(head), timeout]);
            } finally {
                clearTimeout(timer!);
            }
        }

        // If file-type detected something, verify it matches the extension/mimetype
        if (result) {
            const allowed = Media.isAllowedMimeType(result.mime);
            if (!allowed) {
                fs.unlinkSync(uploaded.path);
                return res.status(400).json({
                    code: 'rest_upload_invalid_file_type',
                    message: `File content (${result.mime}) does not match allowed types.`,
                    data: { status: 400 }
                });
            }
            // For binary types that must carry a signature, the confirmed signature must also
            // agree with the declared MIME (e.g. declared image/png whose bytes are application/pdf
            // would be a mismatch). This blocks polyglot/extension-confusion uploads.
            if (requiresSignature && result.mime !== declaredMime) {
                fs.unlinkSync(uploaded.path);
                return res.status(400).json({
                    code: 'rest_upload_invalid_file_type',
                    message: `File content (${result.mime}) does not match the declared type (${declaredMime}).`,
                    data: { status: 400 }
                });
            }
        } else if (requiresSignature) {
            // FAIL-CLOSED: a type that must have a signature but file-type could not confirm one
            // (e.g. an HTML/text payload renamed to .png/.pdf) is rejected.
            fs.unlinkSync(uploaded.path);
            return res.status(400).json({
                code: 'rest_upload_invalid_file_type',
                message: `File content could not be verified for declared type ${declaredMime}.`,
                data: { status: 400 }
            });
        }

        // SVG Sanitization (Defense in Depth)
        if (uploaded.mimetype === 'image/svg+xml') {
            const rawSvg = fs.readFileSync(uploaded.path, 'utf8');
            // Sanitize via an explicit ALLOWLIST. The previous config used allowedAttributes:false
            // (allow ALL attributes) and only stripped <script> + tags whose NAME starts with 'on' —
            // but event handlers like onload/onerror are ATTRIBUTES, never tag names, so they survived
            // (stored XSS). An allowlist drops every unlisted attribute (all on* handlers) and tag.
            const cleanSvg = sanitizeHtml(rawSvg, {
                allowedTags: [
                    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
                    'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath',
                    'mask', 'pattern', 'use', 'symbol', 'title', 'desc', 'marker', 'filter',
                    'feGaussianBlur', 'feOffset', 'feBlend', 'feMerge', 'feMergeNode', 'feColorMatrix', 'image'
                ],
                allowedAttributes: {
                    '*': [
                        'id', 'class', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
                        'stroke-dasharray', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
                        'r', 'rx', 'ry', 'width', 'height', 'viewBox', 'xmlns', 'xmlns:xlink', 'version',
                        'transform', 'opacity', 'fill-opacity', 'stroke-opacity', 'offset', 'stop-color',
                        'stop-opacity', 'gradientUnits', 'gradientTransform', 'patternUnits', 'clip-path',
                        'mask', 'filter', 'font-size', 'font-family', 'text-anchor', 'preserveAspectRatio',
                        'xlink:href', 'href', 'style'
                    ]
                },
                // Block javascript:/data:text in href; allow only safe schemes (fragment refs like #id
                // carry no scheme and are permitted). on* attributes are absent from the allowlist → dropped.
                allowedSchemes: ['http', 'https', 'mailto'],
                allowedSchemesByTag: { image: ['http', 'https', 'data'] },
                parser: { lowerCaseAttributeNames: false }
            });
            fs.writeFileSync(uploaded.path, cleanSvg);
        }

    } catch (err) {
        console.error("Security check failed:", err);
        // FAIL-CLOSED: if the magic-byte/sanitization step threw for a type that MUST carry a
        // verifiable signature, do not let the unverified file through.
        if (requiresSignature) {
            try { if (fs.existsSync(uploaded.path)) fs.unlinkSync(uploaded.path); } catch (_) { /* best effort */ }
            return res.status(400).json({
                code: 'rest_upload_invalid_file_type',
                message: `File content could not be verified for declared type ${declaredMime}.`,
                data: { status: 400 }
            });
        }
    }
    // -------------------------------------
    const { getOption } = require('../core/options');
    const sharp = require('sharp');

    const { title, description, caption, alt } = req.body;

    // Get relative path from uploads dir
    const relativePath = path.relative(config.uploads.dir, uploaded.path).replace(/\\/g, '/');

    // Image processing
    let width = 0;
    let height = 0;
    let sizes: Record<string, any> = {};
    // Modern-format derivatives of the FULL-SIZE original, keyed by MIME type. The per-size ones live
    // under `sizes[<name>].sources`; this is the same map for the image the ladder is derived from.
    let sources: Record<string, any> = {};

    if (uploaded.mimetype.startsWith('image/') && uploaded.mimetype !== 'image/svg+xml') {
        try {
            const image = sharp(uploaded.path, { limitInputPixels: MAX_SHARP_INPUT_PIXELS });
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

            const dir = path.dirname(uploaded.path);
            const ext = path.extname(uploaded.path);
            const baseName = path.basename(uploaded.path, ext);

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
                const sizeFilename = s.h === null
                    ? `${baseName}-${s.w}w${ext}`
                    : `${baseName}-${s.w}x${s.h}${ext}`;
                const sizePath = path.join(dir, sizeFilename);

                const resizeOp = s.crop
                    ? oriented.clone().resize(s.w, s.h as number, { fit: 'cover' })
                    : oriented.clone().resize(s.w, s.h ?? undefined, { fit: 'inside', withoutEnlargement: true });

                const info = await resizeOp.toFile(sizePath);

                sizes[s.name] = {
                    file: sizeFilename,
                    width: info.width,
                    height: info.height,
                    mimeType: uploaded.mimetype,
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
            if (MODERN_SOURCE_MIMES.has(uploaded.mimetype) && !isAnimated && withinModernBudget) {
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
            console.error("Image processing failed:", err);
        }
    }

    const media = await Media.create({
        authorId: req.user.id,
        title: title || uploaded.originalname,
        filename: relativePath,
        mimeType: uploaded.mimetype,
        filePath: relativePath,
        fileSize: uploaded.size,
        width,
        height,
        sizes,
        sources,
        description,
        caption,
        alt
    });

    res.status(201).json(media);
}));

/**
 * PUT /media/:id
 * Update media
 */
/**
 * @swagger
 * /media/{id}:
 *   put:
 *     summary: Update the metadata of a media item
 *     description: upload_files alone is not enough. Editing your own item needs edit_posts; editing someone else item needs the cross-user edit_others_posts. Only the four descriptive fields can be changed here - the stored file is never replaced.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               caption:
 *                 type: string
 *               alt:
 *                 type: string
 *     responses:
 *       200:
 *         description: The updated media item
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Media'
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: You cannot edit this media (rest_forbidden)
 *       404:
 *         description: No such media item (rest_post_invalid_id)
 */
router.put('/:id', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = parseInt(String(req.params.id), 10);
    const media = await Media.findById(mediaId);

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }

    // SECURITY: Ownership check (prevents IDOR). The upload_files gate alone let any
    // author/editor modify ANY user's media. Owners need edit_posts; editing another
    // user's media requires the cross-user edit_others_posts capability. Admins ('*') pass.
    const canEdit = media.author === req.user.id
        ? req.user.can('edit_posts')
        : req.user.can('edit_others_posts');

    if (!canEdit) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot edit this media.',
            data: { status: 403 }
        });
    }

    const { title, description, caption, alt } = req.body;

    const updated = await Media.update(mediaId, {
        title,
        description,
        caption,
        alt
    });

    res.json(updated);
}));

/**
 * DELETE /media/:id
 * Delete media
 */
/**
 * @swagger
 * /media/{id}:
 *   delete:
 *     summary: Delete a media item and its file
 *     description: upload_files alone is not enough. Deleting your own item needs delete_posts; deleting someone else item needs the cross-user delete_others_posts. The stored file is always removed with the row - there is no orphan-leaving mode.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Media deleted. The body carries the deleted item as previous.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted:
 *                   type: boolean
 *                 previous:
 *                   $ref: '#/components/schemas/Media'
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: You cannot delete this media (rest_forbidden)
 *       404:
 *         description: No such media item (rest_post_invalid_id)
 */
router.delete('/:id', authenticate, can('upload_files'), asyncHandler(async (req: Request, res: Response) => {
    const mediaId = parseInt(String(req.params.id), 10);
    const media = await Media.findById(mediaId);

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }

    // SECURITY: Ownership check (prevents IDOR). The upload_files gate alone let any
    // author/editor delete ANY user's media. Owners need delete_posts; deleting another
    // user's media requires the cross-user delete_others_posts capability. Admins ('*') pass.
    const canDelete = media.author === req.user.id
        ? req.user.can('delete_posts')
        : req.user.can('delete_others_posts');

    if (!canDelete) {
        return res.status(403).json({
            code: 'rest_forbidden',
            message: 'You cannot delete this media.',
            data: { status: 403 }
        });
    }

    // Always delete the file when deleting media
    // The force parameter was causing files to be orphaned since the frontend doesn't send it
    await Media.delete(mediaId, true);

    res.json({ deleted: true, previous: media });
}));

module.exports = router;
