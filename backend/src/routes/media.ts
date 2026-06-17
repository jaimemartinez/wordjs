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
const config = require('../config/app');

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
    destination: (req, file, cb) => {
        // Create year/month subdirectory
        const date = new Date();
        const subDir = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
        const uploadPath = path.join(config.uploads.dir, subDir);

        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }

        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
        const uniqueName = `${safeName}-${uuidv4().substring(0, 8)}${ext}`;
        cb(null, uniqueName);
    }
});

// File filter
const fileFilter = (req, file, cb) => {
    // SECURITY: Block SVG uploads for non-admins (SVGs can contain JavaScript)
    if (file.mimetype === 'image/svg+xml') {
        if (!req.user || req.user.getRole() !== 'administrator') {
            return cb(new Error('SVG uploads are restricted to administrators only.'), false);
        }
    }

    if (Media.isAllowedMimeType(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`File type ${file.mimetype} is not allowed.`), false);
    }
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
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
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

    const orderByMap = {
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

    const total = await Media.count({ search });
    const totalPages = Math.ceil(total / limit);

    res.set('X-WP-Total', total);
    res.set('X-WP-TotalPages', totalPages);

    res.json(media);
}));

/**
 * GET /media/:id
 * Get single media
 */
router.get('/:id', optionalAuth, asyncHandler(async (req, res) => {
    const media = await Media.findById(parseInt(req.params.id, 10));

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
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
router.post('/', authenticate, can('upload_files'), upload.single('file'), asyncHandler(async (req, res) => {
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

    try {
        const result = await fileType.fromFile(req.file.path);

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
    let sizes = {};

    if (req.file.mimetype.startsWith('image/') && req.file.mimetype !== 'image/svg+xml') {
        try {
            const image = sharp(req.file.path);
            const metadata = await image.metadata();
            width = metadata.width;
            height = metadata.height;

            // Get target sizes from DB
            const thumbW = await getOption('thumbnail_size_w', 150);
            const thumbH = await getOption('thumbnail_size_h', 150);
            const mediumW = await getOption('medium_size_w', 300);
            const mediumH = await getOption('medium_size_h', 300);
            const largeW = await getOption('large_size_w', 1024);
            const largeH = await getOption('large_size_h', 1024);

            const sizeDefinitions = [
                { name: 'thumbnail', w: thumbW, h: thumbH, crop: true },
                { name: 'medium', w: mediumW, h: mediumH, crop: false },
                { name: 'large', w: largeW, h: largeH, crop: false }
            ];

            const dir = path.dirname(req.file.path);
            const ext = path.extname(req.file.path);
            const baseName = path.basename(req.file.path, ext);

            for (const s of sizeDefinitions) {
                // Skip if original is smaller than target
                if (width <= s.w && height <= s.h && s.name !== 'thumbnail') continue;

                const sizeFilename = `${baseName}-${s.w}x${s.h}${ext}`;
                const sizePath = path.join(dir, sizeFilename);

                let resizeOp = sharp(req.file.path);
                if (s.crop) {
                    resizeOp = resizeOp.resize(s.w, s.h, { fit: 'cover' });
                } else {
                    resizeOp = resizeOp.resize(s.w, s.h, { fit: 'inside', withoutEnlargement: true });
                }

                const info = await resizeOp.toFile(sizePath);

                sizes[s.name] = {
                    file: sizeFilename,
                    width: info.width,
                    height: info.height,
                    mimeType: req.file.mimetype,
                    filesize: info.size
                };
            }
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
router.put('/:id', authenticate, can('upload_files'), asyncHandler(async (req, res) => {
    const mediaId = parseInt(req.params.id, 10);
    const media = await Media.findById(mediaId);

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
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
router.delete('/:id', authenticate, can('upload_files'), asyncHandler(async (req, res) => {
    const mediaId = parseInt(req.params.id, 10);
    const media = await Media.findById(mediaId);

    if (!media) {
        return res.status(404).json({
            code: 'rest_post_invalid_id',
            message: 'Invalid media ID.',
            data: { status: 404 }
        });
    }

    // Always delete the file when deleting media
    // The force parameter was causing files to be orphaned since the frontend doesn't send it
    await Media.delete(mediaId, true);

    res.json({ deleted: true, previous: media });
}));

module.exports = router;
