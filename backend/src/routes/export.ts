/**
 * WordJS - Import/Export Routes
 * /api/v1/export, /api/v1/import
 */

import type { Request, Response } from 'express';
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exportSite, importSite, exportToWXR } = require('../core/import-export');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery } = require('../core/query-params');

/**
 * The six flags GET /export reads. Each is compared to a string literal, so each one is switchable by
 * repeating it: `?users=true&users=true` is ['true','true'], which `=== 'true'` answers false for, so
 * the users the operator asked to include were left out of the archive — and the five `!== 'false'`
 * flags fail the other way, staying ON however many times you send `=false`. An export is the file
 * someone restores from; a flag that reads as its own opposite is not something to discover then.
 */
const EXPORT_FLAG_FIELDS: readonly string[] = Object.freeze([
    'media', 'posts', 'pages', 'users', 'settings', 'menus',
]);

// Configure multer for import file upload
/**
 * @swagger
 * tags:
 *   name: Export
 *   description: Whole-site export and import. Administrator only. The JSON archive is the format this API also restores from; the WXR export is the WordPress interchange format, for moving content to another platform.
 */
const upload = multer({
    dest: path.resolve('./data/imports'),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

/**
 * multer is pulled in with require() and tsconfig pins `types` to ["node"], so @types/multer's
 * ambient augmentation of Express.Request is not part of this program and `req.file` is invisible
 * to the compiler. Describe the one field the import handler reads instead of widening the whole
 * request back to `any` — the annotation would move, the checking would not.
 */
type ImportRequest = Request & { file?: { path: string } };

/**
 * GET /export
 * Export site as JSON
 */
/**
 * @swagger
 * /export:
 *   get:
 *     summary: Export the whole site as a JSON archive
 *     description: Each section flag is a scalar and repeating one is refused rather than resolved - an export is what someone restores from, so a flag that reads as its own opposite is not something to discover later. Media, posts, pages, settings and menus are included unless the flag is exactly false; users are excluded unless the flag is exactly true. The response carries a Content-Disposition attachment header.
 *     tags: [Export]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: media
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "true"
 *       - in: query
 *         name: posts
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "true"
 *       - in: query
 *         name: pages
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "true"
 *       - in: query
 *         name: users
 *         description: Excluded unless this is exactly true.
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "false"
 *       - in: query
 *         name: settings
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "true"
 *       - in: query
 *         name: menus
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "true"
 *     responses:
 *       200:
 *         description: The site archive
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       400:
 *         description: A section flag was sent more than once (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.get('/export', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Refuse a repeated flag before any of them is read, so the six comparisons below are all string
    // comparisons and the archive contains what was asked for.
    requireScalarQuery(req.query, EXPORT_FLAG_FIELDS);

    const options = {
        includeMedia: req.query.media !== 'false',
        includePosts: req.query.posts !== 'false',
        includePages: req.query.pages !== 'false',
        includeUsers: req.query.users === 'true',
        includeSettings: req.query.settings !== 'false',
        includeMenus: req.query.menus !== 'false'
    };

    const data = await exportSite(options);

    res.setHeader('Content-Disposition', 'attachment; filename=wordjs-export.json');
    res.json(data);
}));

/**
 * GET /export/wxr
 * Export site as WordPress WXR format
 */
/**
 * @swagger
 * /export/wxr:
 *   get:
 *     summary: Export the site in the WordPress WXR format
 *     description: An XML document, served as an attachment. It takes no options - the WXR export is always the whole content set.
 *     tags: [Export]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The WXR document
 *         content:
 *           application/xml:
 *             schema:
 *               type: string
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.get('/export/wxr', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const wxr = await exportToWXR();

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename=wordjs-export.xml');
    res.send(wxr);
}));

/**
 * POST /import
 * Import site from JSON
 */
/**
 * @swagger
 * /import:
 *   post:
 *     summary: Restore a JSON site archive
 *     description: The archive arrives either as an uploaded file (multipart field file, at most 50 MB) or as a data field in the body. The uploaded temporary file is always removed, including when the archive fails to parse. This is the counterpart of GET /export; the WordPress WXR importer lives under /import/wordpress.
 *     tags: [Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               updateExisting:
 *                 type: string
 *                 enum: ["true", "false"]
 *               importUsers:
 *                 type: string
 *                 enum: ["true", "false"]
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               data:
 *                 description: The archive itself, as an object or as a JSON string.
 *                 oneOf:
 *                   - type: object
 *                   - type: string
 *               updateExisting:
 *                 type: boolean
 *               importUsers:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: The import results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 results:
 *                   type: object
 *       400:
 *         description: No import data was provided
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.post('/import', authenticate, isAdmin, upload.single('file'), asyncHandler(async (req: ImportRequest, res: Response) => {
    let data;

    if (req.file) {
        // Import from uploaded file.
        //
        // The unlink MUST be in a `finally`: it used to sit after `JSON.parse`, so a malformed upload
        // threw past it and left the multer temp file under ./data/imports for ever. Every bad import
        // leaked up to the 50MB upload limit — an unbounded disk fill for anyone who may import.
        const tempPath = req.file.path;
        try {
            const content = fs.readFileSync(tempPath, 'utf8');
            data = JSON.parse(content);
        } finally {
            // Cleaning up must never itself mask the parse/read error that is on its way to the client.
            try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
        }
    } else if (req.body.data) {
        // Import from JSON body
        data = typeof req.body.data === 'string' ? JSON.parse(req.body.data) : req.body.data;
    } else {
        return res.status(400).json({ error: 'No import data provided' });
    }

    const options = {
        updateExisting: req.body.updateExisting === 'true' || req.body.updateExisting === true,
        importUsers: req.body.importUsers === 'true' || req.body.importUsers === true
    };

    const results = await importSite(data, options);

    res.json({
        success: true,
        results
    });
}));

module.exports = router;
