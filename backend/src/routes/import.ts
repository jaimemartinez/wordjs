/**
 * WordJS - Import Routes
 * /api/v1/import/*
 *
 * WordPress (WXR) importer endpoints. Admin-only. Uploads the .xml export, then either previews the
 * entity counts (analyze) or runs the idempotent import.
 */

import type { Request, Response } from 'express';
// multer is loaded with require() below, so nothing in this file pulls its types into the program.
// This type-only import does, which is also what gives `req.file` its Express.Multer.File type.
import type { FileFilterCallback } from 'multer';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { analyzeWxr, importWxr } = require('../core/wxr-import');

/**
 * @swagger
 * tags:
 *   name: Import
 *   description: Import content from other platforms (WordPress WXR)
 */

// Configure multer for WXR (.xml) uploads.
const upload = multer({
    dest: 'os-tmp/',
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB — WXR exports of large sites can be sizeable
        files: 1,
        fields: 10,
        parts: 15,
    },
    fileFilter: (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
        const name = (file.originalname || '').toLowerCase();
        const okType = ['text/xml', 'application/xml', 'application/rss+xml', 'application/octet-stream'].includes(file.mimetype);
        if (okType || name.endsWith('.xml') || name.endsWith('.wxr')) {
            cb(null, true);
        } else {
            cb(new Error('Only WordPress WXR .xml files are allowed'));
        }
    },
});

function readAndCleanup(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } finally {
        fs.unlink(filePath, () => { /* best-effort temp cleanup */ });
    }
}

/**
 * POST /api/v1/import/wordpress/analyze
 * Dry-run: parse the WXR and return entity counts without writing anything.
 */
router.post('/wordpress/analyze', authenticate, isAdmin, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ code: 'no_file', message: 'No WXR file uploaded (field "file").' });
    }
    let xml: string;
    try {
        xml = readAndCleanup(req.file.path);
    } catch (e: any) {
        return res.status(400).json({ code: 'read_failed', message: e.message });
    }
    try {
        const analysis = analyzeWxr(xml);
        return res.json({ success: true, analysis });
    } catch (e: any) {
        return res.status(400).json({ code: 'invalid_wxr', message: e.message });
    }
}));

/**
 * POST /api/v1/import/wordpress
 * Run the import. Body fields (multipart): defaultAuthorId, importComments ("1"/"0"),
 * importAttachments ("1"/"0").
 */
router.post('/wordpress', authenticate, isAdmin, upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ code: 'no_file', message: 'No WXR file uploaded (field "file").' });
    }
    let xml: string;
    try {
        xml = readAndCleanup(req.file.path);
    } catch (e: any) {
        return res.status(400).json({ code: 'read_failed', message: e.message });
    }

    // Default author = the importing admin unless a valid id is supplied.
    const requested = parseInt(req.body?.defaultAuthorId, 10);
    const defaultAuthorId = Number.isInteger(requested) && requested > 0 ? requested : req.user.id;

    try {
        const summary = await importWxr(xml, {
            defaultAuthorId,
            importComments: req.body?.importComments !== '0',
            importAttachments: req.body?.importAttachments === '1',
        });
        return res.json({ success: true, summary });
    } catch (e: any) {
        // Parse errors are the client's fault (bad file); anything else is a 500 via asyncHandler.
        if (/valid WordPress WXR/i.test(e.message || '')) {
            return res.status(400).json({ code: 'invalid_wxr', message: e.message });
        }
        throw e;
    }
}));

module.exports = router;
