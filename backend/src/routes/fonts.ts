/**
 * WordJS - Font Management Routes
 * /api/v1/fonts
 */

import type { Request, Response, NextFunction } from 'express';
// `req.file` is multer's, and its declaration lives in @types/multer's `declare global` block. tsconfig
// pins `"types": ["node"]`, so no @types package is auto-included: the augmentation only reaches the
// program when something IMPORTS the module, and every use of multer here goes through `require`. This
// is a type-only import — it is erased, emits nothing, and adds no second require of multer.
import type {} from 'multer';

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
/**
 * @swagger
 * tags:
 *   name: Fonts
 *   description: The font files installed under uploads/fonts and served from /uploads/fonts. Listing is public because a theme stylesheet needs the family names; installing and deleting require the manage_options capability. The accept rule for an upload is the file EXTENSION alone (ttf, otf, woff, woff2, eot) - font MIME types are inconsistent across browsers, so a declared font MIME never waves a file through on its own.
 */
const fontsDir = path.join(config.uploads.dir, 'fonts');

// System fonts that are shown as "protected" in the listing and blocked from
// deletion. Single source of truth so the GET classifier and DELETE guard
// cannot diverge.
const PROTECTED_FONTS = [
    'oswald', 'roboto', 'lato', 'opensans', 'montserrat',
    'poppins', 'lora', 'merriweather', 'playfairdisplay', 'nunito',
    'raleway', 'kanit', 'ptserif'
];

// The font-extension allowlist is the SOLE accept signal: font MIME types are inconsistent across
// browsers/OSes, so a declared font MIME must NOT on its own wave a file through — otherwise a `.html`/
// `.svg` sent with a `font/ttf` MIME slipped past the old OR-logic and was written under /uploads/fonts.
const FONT_EXTS = ['.ttf', '.otf', '.woff', '.woff2', '.eot'];

// Ensure fonts directory exists
if (!fs.existsSync(fontsDir)) {
    fs.mkdirSync(fontsDir, { recursive: true });
}

// Configure multer storage for fonts
const storage = multer.diskStorage({
    destination: (req: Request, file: any, cb: any) => {
        cb(null, fontsDir);
    },
    filename: (req: Request, file: any, cb: any) => {
        // Derive a SAFE stored name: sanitized base + random suffix + a font-only extension. The random
        // suffix stops an upload from OVERWRITING an existing/system font (a deterministic name let a
        // malicious admin clobber Roboto etc.), and forcing a font extension (fileFilter already rejects
        // non-font extensions) means a `.html`/`.svg` can never be written under /uploads/fonts.
        const rawExt = path.extname(file.originalname).toLowerCase();
        const ext = FONT_EXTS.includes(rawExt) ? rawExt : '.ttf';
        const base = path.basename(file.originalname, path.extname(file.originalname))
            .replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().slice(0, 60) || 'font';
        const suffix = require('crypto').randomBytes(6).toString('hex');
        cb(null, `${base}-${suffix}${ext}`);
    }
});

// File filter for fonts — extension-only gate (see FONT_EXTS note). AND-ing an unreliable MIME would
// reject legit fonts that browsers label application/octet-stream; gating on the extension alone still
// blocks the non-font types (html/svg/png) that made the OR-logic a stored-content risk.
const fileFilter = (req: Request, file: any, cb: any) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (FONT_EXTS.includes(ext)) {
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

// Wrap multer so a rejected upload (non-font extension via fileFilter, or the size limit) returns a
// clean 400 instead of bubbling to the generic error handler as a 500.
function uploadFontSingle(req: Request, res: Response, next: NextFunction) {
    upload.single('file')(req, res, (err: any) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Invalid font upload.' });
        }
        next();
    });
}

/**
 * GET /fonts
 * List all installed fonts
 */
/**
 * @swagger
 * /fonts:
 *   get:
 *     summary: List the installed fonts
 *     description: Family and variant are parsed out of the stored filename. Protected system fonts sort first, then family, then variant. The url is origin-relative on purpose - an absolute one would embed the upload-era host and break the font face rule on every other origin.
 *     tags: [Fonts]
 *     security: []
 *     responses:
 *       200:
 *         description: The installed fonts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   filename:
 *                     type: string
 *                   family:
 *                     type: string
 *                   variant:
 *                     type: string
 *                   url:
 *                     type: string
 *                     description: Origin-relative, under /uploads/fonts.
 *                   size:
 *                     type: integer
 *                   modified:
 *                     type: string
 *                     format: date-time
 *                   protected:
 *                     type: boolean
 *                     description: A bundled system font. It is listed but cannot be deleted.
 *       500:
 *         description: The fonts directory could not be read
 */
router.get('/', optionalAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    // Read the directory
    fs.readdir(fontsDir, (err: any, files: any) => {
        // EVERYTHING below runs in a node-style CALLBACK, not in the async handler. asyncHandler only
        // does `Promise.resolve(fn(...)).catch(next)`, and that promise resolves the instant fs.readdir is
        // CALLED — so a throw in here lands on an empty stack as an uncaughtException, never a 500. The
        // request was then never answered at all, and index.ts's uncaughtException handler kills the
        // process. It is reachable: statSync below stats names readdir returned, and a font removed in
        // that window (DELETE /fonts/:filename) makes it throw ENOENT — and this GET is optionalAuth, so
        // an anonymous request could take the server down. Hand the error to the same next() asyncHandler
        // would have used.
        try {
            if (err) {
                return res.status(500).json({ error: 'Failed to read fonts directory' });
            }

            const fonts = files
                .filter((file: any) => {
                    const ext = path.extname(file).toLowerCase();
                    return ['.ttf', '.otf', '.woff', '.woff2', '.eot'].includes(ext);
                })
                .map((file: any) => {
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

                    let familyParts: string[] = [];
                    let variantParts: string[] = [];

                    parts.forEach((part: string) => {
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

                    const isProtected = PROTECTED_FONTS.some(p => file.toLowerCase().includes(p));

                    // Fix: Ensure family consistency for protected fonts
                    let finalFamily = familyName;
                    if (isProtected) {
                        // Map filename parts to clean family names for specific system fonts if needed
                        const pName = PROTECTED_FONTS.find(p => file.toLowerCase().includes(p));
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
                        // Origin-relative (same policy as media sourceUrl): siteUrl embeds the
                        // upload-era host/IP, so absolute URLs break @font-face on any other origin
                        // (fonts silently failed to load and text fell back to system serif).
                        url: `/uploads/fonts/${file}`,
                        size: stats.size,
                        modified: stats.mtime,
                        protected: isProtected
                    };
                });

            // Sort: Protected first, then Alphabetical Family, then Variant
            fonts.sort((a: any, b: any) => {
                if (a.protected && !b.protected) return -1;
                if (!a.protected && b.protected) return 1;

                const familyCompare = a.family.localeCompare(b.family);
                if (familyCompare !== 0) return familyCompare;

                return a.variant.localeCompare(b.variant);
            });

            res.json(fonts);
        } catch (e) {
            next(e);
        }
    });
}));

/**
 * POST /fonts
 * Upload a new font
 */
/**
 * @swagger
 * /fonts:
 *   post:
 *     summary: Upload a font file
 *     description: Multipart upload of a single file field, at most 10 MB. The stored name is derived, never taken from the client - a sanitised base plus a random suffix plus a font extension - so an upload can neither overwrite an existing font nor write a non-font file under the fonts directory.
 *     tags: [Fonts]
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
 *       201:
 *         description: Font stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 file:
 *                   type: string
 *                   description: The derived stored filename.
 *                 url:
 *                   type: string
 *       400:
 *         description: No file, a non-font extension, or the 10 MB limit exceeded
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: The manage_options capability is required
 */
router.post('/', authenticate, can('manage_options'), uploadFontSingle, asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    res.status(201).json({
        message: 'Font uploaded successfully',
        file: req.file.filename,
        url: `/uploads/fonts/${req.file.filename}`
    });
}));

/**
 * DELETE /fonts/:filename
 * Delete a font
 */
/**
 * @swagger
 * /fonts/{filename}:
 *   delete:
 *     summary: Delete an installed font
 *     description: Refused for a bundled system font, and refused when the family name still appears in a setting, in post content or in page layout meta - the check is a usage search, so deleting a font cannot silently break a page that renders with it.
 *     tags: [Fonts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         description: The stored filename. Only its basename is used, so a path cannot escape the fonts directory.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Font deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         description: The font is still referenced by a setting, a post or a page layout
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: The manage_options capability is required, or the font is a protected system font
 *       404:
 *         description: No such font
 *       500:
 *         description: The usage check could not be run, so the deletion was refused
 */
router.delete('/:filename', authenticate, can('manage_options'), asyncHandler(async (req: Request, res: Response) => {
    const filename = path.basename(req.params.filename); // Prevent path traversal
    const filePath = path.join(fontsDir, filename);

    if (fs.existsSync(filePath)) {
        // Check if font is protected
        if (PROTECTED_FONTS.some(p => filename.toLowerCase().includes(p))) {
            return res.status(403).json({ error: 'System fonts cannot be deleted' });
        }

        // Check for usage in database
        try {
            const familyName = path.basename(filename, path.extname(filename))
                .replace(/[-_]/g, ' ')
                .replace(/\b\w/g, (l: string) => l.toUpperCase());

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
