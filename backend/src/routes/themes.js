/**
 * WordJS - Themes Routes
 * /api/v1/themes/*
 */

const express = require('express');
const router = express.Router();
const AdmZip = require('adm-zip');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const {
    getAllThemes,
    switchTheme,
    createDefaultTheme,
    deleteTheme,
    createThemeZip,
    THEMES_DIR
} = require('../core/themes');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

/**
 * @swagger
 * tags:
 *   name: Themes
 *   description: Theme management (Install, Switch, Delete)
 */

// Configure multer for zip uploads
const upload = multer({
    dest: 'os-tmp/',
    limits: {
        fileSize: 20 * 1024 * 1024, // 20MB limit
        // SECURITY: Prevent CVE-2025-47935/47944 DoS
        files: 1,           // Only 1 theme zip per request
        fields: 10,         // Minimal fields needed
        parts: 15           // Limited total parts
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only .zip files are allowed'));
        }
    }
});

/**
 * SECURITY: Validate theme slug to prevent path traversal
 */
function validateSlug(slug) {
    // Only allow alphanumeric, dashes, and underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return false;
    }
    // Ensure the resolved path is still within THEMES_DIR
    const safePath = path.resolve(THEMES_DIR, slug);
    return safePath.startsWith(path.resolve(THEMES_DIR));
}

/**
 * @swagger
 * /themes/upload:
 *   post:
 *     summary: Upload and install a theme (ZIP)
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               theme:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Theme installed
 *       400:
 *         description: Invalid file or zip slip
 */
router.post('/upload', authenticate, isAdmin, upload.single('theme'), asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const zipPath = req.file.path;

    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // Security: Check for Zip Slip (Directory Traversal)
        zipEntries.forEach(entry => {
            if (entry.entryName.indexOf('..') !== -1) {
                throw new Error('Malicious zip file detected (Zip Slip)');
            }
        });

        // Get theme folder name from zip
        const zipName = path.parse(req.file.originalname).name;
        const targetDir = path.join(THEMES_DIR, zipName);

        // Check if theme already exists
        if (fs.existsSync(targetDir)) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({ error: `Theme "${zipName}" already exists` });
        }

        // Extract zip
        zip.extractAllTo(THEMES_DIR, true);

        // Clean up temp file
        fs.unlinkSync(zipPath);

        res.json({
            success: true,
            message: `Theme "${zipName}" installed successfully`,
            slug: zipName
        });
    } catch (error) {
        // Clean up on error
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        throw error;
    }
}));

/**
 * @swagger
 * /themes:
 *   get:
 *     summary: List all installed themes
 *     tags: [Themes]
 *     responses:
 *       200:
 *         description: List of themes
 */
router.get('/', asyncHandler(async (req, res) => {
    const themes = await getAllThemes();
    res.json(themes);
}));

/**
 * @swagger
 * /themes/{slug}/activate:
 *   post:
 *     summary: Switch active theme
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Theme activated
 */
router.post('/:slug/activate', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const result = await switchTheme(req.params.slug);
    res.json(result);
}));

/**
 * @swagger
 * /themes/default:
 *   post:
 *     summary: Restore default theme
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Default theme restored
 */
router.post('/default', authenticate, isAdmin, asyncHandler(async (req, res) => {
    createDefaultTheme();
    res.json({ success: true, message: 'Default theme created in /themes/default' });
}));

/**
 * @swagger
 * /themes/{slug}:
 *   delete:
 *     summary: Delete a theme
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Theme deleted
 */
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const result = await deleteTheme(req.params.slug);
    res.json(result);
}));

/**
 * @swagger
 * /themes/{slug}/download:
 *   get:
 *     summary: Download theme as ZIP
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Theme ZIP file
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/:slug/download', authenticate, isAdmin, asyncHandler(async (req, res) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const zipPath = await createThemeZip(req.params.slug);

    res.download(zipPath, `${req.params.slug}.zip`, (err) => {
        // Clean up temp file after download
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
    });
}));

module.exports = router;
