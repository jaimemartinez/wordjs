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
const { getAllThemes, switchTheme, createDefaultTheme, THEMES_DIR } = require('../core/themes');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

// Configure multer for zip uploads
const upload = multer({
    dest: 'os-tmp/',
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only .zip files are allowed'));
        }
    }
});

/**
 * POST /themes/upload
 * Upload and install a theme
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
 * GET /themes
 * List all themes
 */
router.get('/', asyncHandler(async (req, res) => {
    const themes = getAllThemes();
    res.json(themes);
}));

/**
 * POST /themes/:slug/activate
 * Switch to a theme
 */
router.post('/:slug/activate', authenticate, isAdmin, asyncHandler(async (req, res) => {
    const result = await switchTheme(req.params.slug);
    res.json(result);
}));

/**
 * POST /themes/default
 * Create default theme
 */
router.post('/default', authenticate, isAdmin, asyncHandler(async (req, res) => {
    createDefaultTheme();
    res.json({ success: true, message: 'Default theme created in /themes/default' });
}));

module.exports = router;
