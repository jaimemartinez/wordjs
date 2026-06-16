/**
 * WordJS - Import/Export Routes
 * /api/v1/export, /api/v1/import
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { exportSite, importSite, exportToWXR } = require('../core/import-export');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

// Configure multer for import file upload
const upload = multer({
    dest: path.resolve('./data/imports'),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

/**
 * GET /export
 * Export site as JSON
 */
router.get('/export', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const options = {
        includeMedia: req.query.media !== 'false',
        includePosts: req.query.posts !== 'false',
        includePages: req.query.pages !== 'false',
        includeUsers: req.query.users === 'true',
        includeSettings: req.query.settings !== 'false',
        includeMenus: req.query.menus !== 'false'
    };

    const data = exportSite(options);

    res.setHeader('Content-Disposition', 'attachment; filename=wordjs-export.json');
    res.json(data);
}));

/**
 * GET /export/wxr
 * Export site as WordPress WXR format
 */
router.get('/export/wxr', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const wxr = exportToWXR();

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', 'attachment; filename=wordjs-export.xml');
    res.send(wxr);
}));

/**
 * POST /import
 * Import site from JSON
 */
router.post('/import', authenticate, isAdmin, upload.single('file'), asyncHandler(async (req, res) => {
    let data;

    if (req.file) {
        // Import from uploaded file
        const content = fs.readFileSync(req.file.path, 'utf8');
        data = JSON.parse(content);

        // Clean up temp file
        fs.unlinkSync(req.file.path);
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
