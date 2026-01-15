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
        fileSize: config.uploads.maxFileSize
    }
});

/**
 * GET /media
 * List media
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
        order: order.toUpperCase()
    });

    const total = await Media.count();
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
 * POST /media
 * Upload media
 */
router.post('/', authenticate, can('upload_files'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            code: 'rest_upload_no_file',
            message: 'No file was uploaded.',
            data: { status: 400 }
        });
    }

    // --- SECURITY CHECK: Magic Numbers ---
    const fileType = require('file-type');
    try {
        const result = await fileType.fromFile(req.file.path);

        // If file-type detected something, verify it matches the extension/mimetype
        // Note: Some text files (css, js, svg) might return undefined, so we primarily check binaries
        if (result) {
            const allowed = Media.isAllowedMimeType(result.mime);
            if (!allowed) {
                // Delete the malicious/invalid file immediately
                fs.unlinkSync(req.file.path);
                return res.status(400).json({
                    code: 'rest_upload_invalid_file_type',
                    message: `File content (${result.mime}) does not match allowed types.`,
                    data: { status: 400 }
                });
            }
        }
    } catch (err) {
        console.error("Magic number check failed:", err);
        // Fail open or closed? Here failing closed is safer for binaries, but risky for text.
        // For now, we log and proceed unless strict mode is requested.
    }
    // -------------------------------------

    const { title, description, caption, alt } = req.body;

    // Get relative path from uploads dir
    const relativePath = path.relative(config.uploads.dir, req.file.path).replace(/\\/g, '/');

    // Get image dimensions if it's an image
    let width = 0;
    let height = 0;

    if (req.file.mimetype.startsWith('image/')) {
        try {
            // Simple dimension detection could be added here with sharp or similar
        } catch {
            // Ignore dimension detection errors
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
