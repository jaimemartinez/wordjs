/**
 * WordJS - Media Routes
 * /api/v1/media/*
 */

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

// Ensure uploads directory exists
if (!fs.existsSync(config.uploads.dir)) {
    fs.mkdirSync(config.uploads.dir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
    destination: (req: any, file: any, cb: any) => {
        // Create year/month subdirectory
        const date = new Date();
        const subDir = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        const uploadPath = path.join(config.uploads.dir, subDir);

        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }

        cb(null, uploadPath);
    },
    filename: (req: any, file: any, cb: any) => {
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
const fileFilter = (req: any, file: any, cb: any) => {
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
router.get('/', optionalAuth, asyncHandler(async (req: any, res: any) => {
    const {
        page = 1,
        per_page = 20,
        search,
        mime_type,
        orderby = 'date',
        order = 'desc'
    } = req.query;

    const limit = Math.min(parseInt(per_page, 10) || 20, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const orderByMap: Record<string, string> = {
        date: 'post_date',
        modified: 'post_modified',
        title: 'post_title',
        id: 'id'
    };

    const media = await Media.findAll({
        search,
        limit,
        offset,
        orderBy: orderByMap[orderby] || 'post_date',
        // SECURITY: Whitelist order direction
        order: ['asc', 'desc'].includes(order.toLowerCase()) ? order.toUpperCase() : 'DESC'
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
    const total = Math.max(0, (await Media.count({ search })) - hiddenOnPage);
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(visibleMedia);
}));

/**
 * GET /media/:id
 * Get single media
 */
router.get('/:id', optionalAuth, asyncHandler(async (req: any, res: any) => {
    const media = await Media.findById(parseInt(req.params.id, 10));

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
router.post('/', authenticate, can('upload_files'), upload.single('file'), asyncHandler(async (req: any, res: any) => {
    if (!req.file) {
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
    const declaredMime = req.file.mimetype || '';
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

        const fd = fs.openSync(req.file.path, 'r');
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
                fs.unlinkSync(req.file.path);
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
                fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    code: 'rest_upload_invalid_file_type',
                    message: `File content (${result.mime}) does not match the declared type (${declaredMime}).`,
                    data: { status: 400 }
                });
            }
        } else if (requiresSignature) {
            // FAIL-CLOSED: a type that must have a signature but file-type could not confirm one
            // (e.g. an HTML/text payload renamed to .png/.pdf) is rejected.
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                code: 'rest_upload_invalid_file_type',
                message: `File content could not be verified for declared type ${declaredMime}.`,
                data: { status: 400 }
            });
        }

        // SVG Sanitization (Defense in Depth)
        if (req.file.mimetype === 'image/svg+xml') {
            const rawSvg = fs.readFileSync(req.file.path, 'utf8');
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
            fs.writeFileSync(req.file.path, cleanSvg);
        }

    } catch (err) {
        console.error("Security check failed:", err);
        // FAIL-CLOSED: if the magic-byte/sanitization step threw for a type that MUST carry a
        // verifiable signature, do not let the unverified file through.
        if (requiresSignature) {
            try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) { /* best effort */ }
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
    const relativePath = path.relative(config.uploads.dir, req.file.path).replace(/\\/g, '/');

    // Image processing
    let width = 0;
    let height = 0;
    let sizes: Record<string, any> = {};

    if (req.file.mimetype.startsWith('image/') && req.file.mimetype !== 'image/svg+xml') {
        try {
            const image = sharp(req.file.path, { limitInputPixels: MAX_SHARP_INPUT_PIXELS });
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

            const dir = path.dirname(req.file.path);
            const ext = path.extname(req.file.path);
            const baseName = path.basename(req.file.path, ext);

            // ONE decode for every derivative (clone() shares the decoded pipeline; the old loop
            // re-decoded the file per size), auto-oriented with .rotate() — without it EXIF-rotated
            // phone photos produced sideways thumbnails. Encodes run in parallel.
            const oriented = image.rotate();
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
                    mimeType: req.file.mimetype,
                    filesize: info.size
                };
            }));
        } catch (err) {
            console.error("Image processing failed:", err);
        }
    }

    const media = await Media.create({
        authorId: req.user.id,
        title: title || req.file.originalname,
        filename: relativePath,
        mimeType: req.file.mimetype,
        filePath: relativePath,
        fileSize: req.file.size,
        width,
        height,
        sizes,
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
router.put('/:id', authenticate, can('upload_files'), asyncHandler(async (req: any, res: any) => {
    const mediaId = parseInt(req.params.id, 10);
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
router.delete('/:id', authenticate, can('upload_files'), asyncHandler(async (req: any, res: any) => {
    const mediaId = parseInt(req.params.id, 10);
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
