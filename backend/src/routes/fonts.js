/**
 * WordJS - Font Management Routes
 * /api/v1/fonts
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config/app');
const { dbAsync } = require('../config/database');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { can } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');

// Fonts directory
const fontsDir = path.join(config.uploads.dir, 'fonts');

// Ensure fonts directory exists
if (!fs.existsSync(fontsDir)) {
    fs.mkdirSync(fontsDir, { recursive: true });
}

// Configure multer storage for fonts
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, fontsDir);
    },
    filename: (req, file, cb) => {
        // Keep original name but sanitize it slightly to prevent path traversal
        const name = path.basename(file.originalname).replace(/[^a-zA-Z0-9.\-_ ]/g, '');
        cb(null, name);
    }
});

// File filter for fonts
const fileFilter = (req, file, cb) => {
    const allowedMimeTypes = [
        'font/ttf',
        'font/otf',
        'font/woff',
        'font/woff2',
        'application/x-font-ttf',
        'application/x-font-otf',
        'application/x-font-woff',
        'application/font-woff',
        'application/font-woff2',
        'application/vnd.ms-fontobject'
    ];

    // Also check extensions because MIME types can be unreliable for fonts
    const allowedExtensions = ['.ttf', '.otf', '.woff', '.woff2', '.eot'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid font file type. Allowed: ttf, otf, woff, woff2, eot'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

/**
 * GET /fonts
 * List all installed fonts
 */
router.get('/', optionalAuth, asyncHandler(async (req, res) => {
    // Read the directory
    fs.readdir(fontsDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to read fonts directory' });
        }

        const fonts = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.ttf', '.otf', '.woff', '.woff2', '.eot'].includes(ext);
            })
            .map(file => {
                const stats = fs.statSync(path.join(fontsDir, file));

                // Intelligent Parsing
                const ext = path.extname(file);
                const nameWithoutExt = path.basename(file, ext);

                // Common tokens for variants
                const variantTokens = [
                    'thin', 'extralight', 'light', 'regular', 'medium', 'semibold', 'bold', 'extrabold', 'black',
                    'italic', 'oblique'
                ];

                // Split by common delimiters
                const parts = nameWithoutExt.split(/[-_ ]+/);

                let familyParts = [];
                let variantParts = [];

                parts.forEach(part => {
                    if (variantTokens.includes(part.toLowerCase())) {
                        variantParts.push(part);
                    } else {
                        familyParts.push(part);
                    }
                });

                const familyName = familyParts.join(' ') || nameWithoutExt;
                let variant = variantParts.join(' ');

                // Normalize variant
                if (!variant) variant = 'Regular';

                const protectedFonts = [
                    'oswald', 'roboto', 'lato', 'opensans', 'montserrat',
                    'poppins', 'lora', 'playfairdisplay', 'nunito',
                    'raleway', 'kanit'
                ];

                const isProtected = protectedFonts.some(p => file.toLowerCase().includes(p));

                // Fix: Ensure family consistency for protected fonts
                let finalFamily = familyName;
                if (isProtected) {
                    // Map filename parts to clean family names for specific system fonts if needed
                    const pName = protectedFonts.find(p => file.toLowerCase().includes(p));
                    if (pName) {
                        // Capitalize first letter
                        finalFamily = pName.charAt(0).toUpperCase() + pName.slice(1);
                        // Handle special casing
                        if (pName === 'opensans') finalFamily = 'Open Sans';
                        if (pName === 'playfairdisplay') finalFamily = 'Playfair Display';
                        // Default capitalization works for Lora, Kanit, Roboto, Lato, Poppins, Nunito, Raleway, Montserrat
                    }
                }

                return {
                    filename: file,
                    family: finalFamily,
                    variant: variant,
                    url: `${config.site.url}/uploads/fonts/${file}`,
                    size: stats.size,
                    modified: stats.mtime,
                    protected: isProtected
                };
            });

        // Sort: Protected first, then Alphabetical Family, then Variant
        fonts.sort((a, b) => {
            if (a.protected && !b.protected) return -1;
            if (!a.protected && b.protected) return 1;

            const familyCompare = a.family.localeCompare(b.family);
            if (familyCompare !== 0) return familyCompare;

            return a.variant.localeCompare(b.variant);
        });

        res.json(fonts);
    });
}));

/**
 * POST /fonts
 * Upload a new font
 */
router.post('/', authenticate, can('manage_options'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    res.status(201).json({
        message: 'Font uploaded successfully',
        file: req.file.filename,
        url: `${config.site.url}/uploads/fonts/${req.file.filename}`
    });
}));

/**
 * DELETE /fonts/:filename
 * Delete a font
 */
router.delete('/:filename', authenticate, can('manage_options'), asyncHandler(async (req, res) => {
    const filename = path.basename(req.params.filename); // Prevent path traversal
    const filePath = path.join(fontsDir, filename);

    if (fs.existsSync(filePath)) {
        // Check if font is protected
        const protectedFonts = [
            'oswald', 'roboto', 'lato', 'opensans', 'montserrat',
            'poppins', 'merriweather', 'playfairdisplay', 'nunito',
            'raleway', 'ptserif'
        ];

        if (protectedFonts.some(p => filename.toLowerCase().includes(p))) {
            return res.status(403).json({ error: 'System fonts cannot be deleted' });
        }

        // Check for usage in database
        try {
            const familyName = path.basename(filename, path.extname(filename))
                .replace(/[-_]/g, ' ')
                .replace(/\b\w/g, l => l.toUpperCase());

            const searchTerm = `%${familyName}%`;

            // Check options (settings)
            const optionUsage = await dbAsync.get(
                'SELECT option_name FROM options WHERE option_value LIKE ? LIMIT 1',
                [searchTerm]
            );

            if (optionUsage) {
                return res.status(400).json({
                    error: `Cannot delete font '${familyName}' because it is being used in settings (${optionUsage.option_name}).`
                });
            }

            // Check posts content
            const postUsage = await dbAsync.get(
                'SELECT post_title FROM posts WHERE post_content LIKE ? LIMIT 1',
                [searchTerm]
            );

            if (postUsage) {
                return res.status(400).json({
                    error: `Cannot delete font '${familyName}' because it is being used in post '${postUsage.post_title}'.`
                });
            }

            // Check post meta (e.g. Puck editor data)
            const metaUsage = await dbAsync.get(
                'SELECT meta_id FROM post_meta WHERE meta_value LIKE ? LIMIT 1',
                [searchTerm]
            );

            if (metaUsage) {
                return res.status(400).json({
                    error: `Cannot delete font '${familyName}' because it is being used in page layouts.`
                });
            }

        } catch (dbError) {
            console.error('Error checking font usage:', dbError);
            // Fail safe: If we can't check usage, warn but maybe allow? 
            // Better to block if unsure to preserve integrity.
            return res.status(500).json({ error: 'Database error while checking font usage.' });
        }

        fs.unlinkSync(filePath);
        res.json({ message: 'Font deleted successfully' });
    } else {
        res.status(404).json({ error: 'Font not found' });
    }
}));

module.exports = router;
