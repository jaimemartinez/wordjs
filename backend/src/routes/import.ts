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
/**
 * @swagger
 * /import/wordpress/analyze:
 *   post:
 *     summary: Dry-run a WordPress WXR file and report what it contains
 *     description: Parses the upload and returns entity counts without writing anything. The accepted upload is a single file of at most 100 MB whose MIME is an XML family or whose name ends in .xml or .wxr; the temporary file is removed as soon as it has been read.
 *     tags: [Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: The entity counts the file would import
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 analysis:
 *                   type: object
 *       400:
 *         description: No file (no_file), the upload could not be read (read_failed), or it is not a valid WXR document (invalid_wxr)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
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
 * The media modes core/wxr-media accepts, as an HTTP-facing allowlist.
 *
 * The route used to expose only the coarse `importAttachments` boolean, which meant the admin UI could
 * ask for a DOWNLOAD (up to `maxTotalBytes` of third-party fetches) but never for `link` or `skip`, and
 * could never opt a migration out of https. Both knobs are admin-only and both are guarded downstream:
 * `allowHttp` still cannot reach a private address (core/egress-guard resolves and pins every hop) and
 * its loopback exception additionally requires a non-production nodeEnv.
 */
const MEDIA_MODES: ReadonlySet<string> = new Set(['download', 'link', 'skip']);

/**
 * POST /api/v1/import/wordpress
 * Run the import. Body fields (multipart): defaultAuthorId, importComments ("1"/"0"),
 * media ("download"/"link"/"skip"), allowHttp ("1"/"0"), importAttachments ("1"/"0", legacy).
 */
/**
 * @swagger
 * /import/wordpress:
 *   post:
 *     summary: Import a WordPress WXR file
 *     description: Idempotent - re-importing the same file does not duplicate content. Run the analyze endpoint first to see what will be written. The default author is the importing administrator unless a usable defaultAuthorId is supplied. In the default `download` media mode the server FETCHES every attachment named in the export from its original host, so the run performs outbound requests to third-party URLs under the SSRF guard and the size caps described per field.
 *     tags: [Import]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               defaultAuthorId:
 *                 type: integer
 *                 description: Author for content whose original author cannot be resolved. Defaults to the calling administrator.
 *               importComments:
 *                 type: string
 *                 enum: ["0", "1"]
 *                 default: "1"
 *                 description: Comments are imported unless this is exactly 0.
 *               media:
 *                 type: string
 *                 enum: [download, link, skip]
 *                 description: >
 *                   What to do with attachment items. `download` fetches every file named in the export and stores it
 *                   in the media library (bounded by a 50 MB per-file and a 1 GB per-run cap, https only unless
 *                   allowHttp is set); `link` creates the record and keeps the remote URL, downloading nothing;
 *                   `skip` ignores attachments entirely. Omitted, the legacy importAttachments switch decides.
 *               allowHttp:
 *                 type: string
 *                 enum: ["0", "1"]
 *                 default: "0"
 *                 description: >
 *                   Allow `http://` attachment sources. Off by default because a migration source that is not https
 *                   is a downgrade. It does not weaken the SSRF guard - a private or loopback address is still
 *                   refused, whatever the scheme.
 *               importAttachments:
 *                 type: string
 *                 enum: ["0", "1"]
 *                 default: "0"
 *                 description: Legacy coarse switch, used only when `media` is absent. 1 means `media=download`, anything else `media=skip`.
 *     responses:
 *       200:
 *         description: The import summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 summary:
 *                   type: object
 *       400:
 *         description: No file (no_file), the upload could not be read (read_failed), or it is not a valid WXR document (invalid_wxr)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
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

    // `media` wins when it is a mode we know; otherwise the legacy boolean decides, unchanged, so a
    // caller that only ever sent `importAttachments` keeps the behaviour it had.
    const requestedMode = String(req.body?.media ?? '');
    const media = MEDIA_MODES.has(requestedMode)
        ? (requestedMode as 'download' | 'link' | 'skip')
        : (req.body?.importAttachments === '1' ? 'download' : 'skip');

    try {
        const summary = await importWxr(xml, {
            defaultAuthorId,
            importComments: req.body?.importComments !== '0',
            media,
            allowHttp: req.body?.allowHttp === '1',
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
