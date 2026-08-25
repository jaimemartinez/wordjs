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
