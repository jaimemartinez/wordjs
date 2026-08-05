/**
 * WordJS - Themes Routes
 * /api/v1/themes/*
 */

import type { Request, Response } from 'express';

const express = require('express');
const router = express.Router();
const AdmZip = require('adm-zip');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertZipWithinBudget } = require('../core/zip-guard');
const {
    getAllThemes,
    switchTheme,
    createDefaultTheme,
    deleteTheme,
    createThemeZip,
    installThemeFromDir,
    THEMES_DIR
} = require('../core/themes');
const { compileTheme, writeCompiled } = require('../core/theme-compile');
const { analyzeTheme } = require('../core/theme-doctor');
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
    fileFilter: (req: any, file: any, cb: any) => {
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
function validateSlug(slug: any) {
    // Only allow alphanumeric, dashes, and underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
        return false;
    }
    // Ensure the resolved path is still within THEMES_DIR
    const safePath = path.resolve(THEMES_DIR, slug);
    return safePath.startsWith(path.resolve(THEMES_DIR));
}

// ---------------------------------------------------------------------------
// Declarative theme writer (theme.json v1: seeds / archetype / tokens / styles)
// ---------------------------------------------------------------------------

const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
// Same on-disk cap theme-compile enforces; checked here BEFORE anything is written.
const MAX_THEME_JSON = 256 * 1024;
const DECLARATIVE_KEYS = ['seeds', 'archetype', 'tokens', 'styles'];
// Written ONCE at creation. The API never writes functions.js again (PUT rebuilds only
// theme.json + the marked style.css block) — theme logic stays hand-owned.
const FUNCTIONS_STUB = `/**
 * Theme logic and hooks
 */
module.exports = function () {};
`;

function bumpPatch(version: any): string {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
    return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.1';
}

// Light shape gate for the declarative sections (deep validation is compileTheme's job).
// null is accepted on PUT to mean "drop this section".
function declarativeShapeError(body: any): string | null {
    for (const k of ['seeds', 'tokens', 'styles']) {
        if (body[k] !== undefined && body[k] !== null && !isPlainObject(body[k])) {
            return `"${k}" must be an object`;
        }
    }
    if (body.archetype !== undefined && body.archetype !== null && typeof body.archetype !== 'string') {
        return '"archetype" must be a string';
    }
    return null;
}

const hasCompileErrors = (diagnostics: any[]): boolean => diagnostics.some((d: any) => d.level === 'error');

// Same tmp+rename discipline as theme-compile.writeCompiled, so a mid-flight failure can
// never leave a torn theme.json behind.
function writeJsonAtomic(target: string, text: string): void {
    const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
        fs.renameSync(tmp, target);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
    }
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
router.post('/upload', authenticate, isAdmin, upload.single('theme'), asyncHandler(async (req: any, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const zipPath = req.file.path;

    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // SECURITY: reject a decompression bomb before extracting (compressed size was capped by multer).
        try {
            assertZipWithinBudget(zipEntries, { kind: 'theme' });
        } catch (e: any) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({ error: e.message });
        }

        // Get theme folder name from zip
        const zipName = path.parse(req.file.originalname).name;
        const targetDir = path.join(THEMES_DIR, zipName);

        // Check if theme already exists
        if (fs.existsSync(targetDir)) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({ error: `Theme "${zipName}" already exists` });
        }

        // SECURITY: Verify EVERY entry resolves inside THEMES_DIR before extracting
        // (Zip Slip: absolute paths, '..', symlink-style escapes). Extraction target is THEMES_DIR.
        const resolvedTarget = path.resolve(THEMES_DIR);
        for (const entry of zipEntries) {
            const dest = path.resolve(THEMES_DIR, entry.entryName);
            const isContained = dest === resolvedTarget || dest.startsWith(resolvedTarget + path.sep);
            if (!isContained || entry.entryName.indexOf('..') !== -1) {
                fs.unlinkSync(zipPath);
                return res.status(400).json({ error: 'Malicious zip file detected (Zip Slip / path traversal)' });
            }
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
router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const themes = await getAllThemes();
    res.json(themes);
}));

/**
 * @swagger
 * /themes:
 *   post:
 *     summary: Create a theme from the declarative theme.json v1 contract (seeds / archetype / tokens / styles)
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, metadata]
 *             properties:
 *               slug:
 *                 type: string
 *               metadata:
 *                 type: object
 *               seeds:
 *                 type: object
 *               archetype:
 *                 type: string
 *               tokens:
 *                 type: object
 *               styles:
 *                 type: object
 *     responses:
 *       201:
 *         description: Theme created ({ slug, diagnostics })
 *       400:
 *         description: Invalid payload or compilation errors (diagnostics included)
 *       409:
 *         description: Theme already exists
 */
router.post('/', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    const body = isPlainObject(req.body) ? req.body : {};
    // SECURITY: Validate slug (same gate as the sibling routes; typeof first — the regex
    // would stringify a missing slug into the literal "undefined", which passes the charset)
    if (typeof body.slug !== 'string' || !validateSlug(body.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const slug = body.slug;
    const metadata = body.metadata;
    if (!isPlainObject(metadata) || typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
        return res.status(400).json({ error: 'metadata.name is required' });
    }
    for (const k of ['description', 'author', 'version']) {
        if (metadata[k] !== undefined && typeof metadata[k] !== 'string') {
            return res.status(400).json({ error: `metadata.${k} must be a string` });
        }
    }
    if (body.seeds === undefined && body.tokens === undefined && body.styles === undefined) {
        return res.status(400).json({ error: 'At least one of seeds, tokens or styles is required' });
    }
    const shapeErr = declarativeShapeError(body);
    if (shapeErr) {
        return res.status(400).json({ error: shapeErr });
    }

    const themeJson: any = {
        name: metadata.name,
        version: metadata.version || '1.0.0',
        description: metadata.description || '',
        author: metadata.author || '',
        // The writer's mark: only generator:"wordjs" themes accept PUT rebuilds.
        generator: 'wordjs'
    };
    for (const k of DECLARATIVE_KEYS) {
        if (body[k] !== undefined && body[k] !== null) themeJson[k] = body[k];
    }
    const serialized = JSON.stringify(themeJson, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_THEME_JSON) {
        return res.status(400).json({ error: `theme.json exceeds the ${MAX_THEME_JSON}-byte cap` });
    }

    // Build in a system temp dir; installThemeFromDir is the ONLY materialization path into
    // THEMES_DIR (budgets, symlink refusal, THEME_EXISTS, rollback). A rejected payload must
    // leave no trace on disk.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-build-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'theme.json'), serialized);
        fs.writeFileSync(path.join(tmpDir, 'functions.js'), FUNCTIONS_STUB);
        const { css, diagnostics } = compileTheme(tmpDir, { slug, dryRun: true });
        if (hasCompileErrors(diagnostics)) {
            return res.status(400).json({ error: 'Theme compilation failed', diagnostics });
        }
        writeCompiled(tmpDir, css);
        try {
            installThemeFromDir(tmpDir, slug);
        } catch (e: any) {
            if (e.code === 'THEME_EXISTS') return res.status(409).json({ error: e.message });
            if (e.code === 'THEME_INVALID') return res.status(400).json({ error: e.message });
            throw e;
        }
        res.status(201).json({ slug, diagnostics });
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}));

/**
 * @swagger
 * /themes/{slug}:
 *   put:
 *     summary: Rebuild a writer-generated theme (generator "wordjs") from updated declarative sections
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               seeds:
 *                 type: object
 *                 nullable: true
 *               archetype:
 *                 type: string
 *                 nullable: true
 *               tokens:
 *                 type: object
 *                 nullable: true
 *               styles:
 *                 type: object
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Theme rebuilt ({ slug, version, diagnostics })
 *       400:
 *         description: Invalid payload or compilation errors (diagnostics included)
 *       404:
 *         description: Theme not found
 *       409:
 *         description: Theme was not created by the WordJS writer
 */
router.put('/:slug', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const slug = req.params.slug;
    const themeDir = path.join(THEMES_DIR, slug);
    if (!fs.existsSync(themeDir)) {
        return res.status(404).json({ error: `Theme ${slug} not found` });
    }
    const themeJsonPath = path.join(themeDir, 'theme.json');
    let current: any = null;
    try { current = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8')); } catch { /* missing or invalid */ }
    if (!isPlainObject(current) || current.generator !== 'wordjs') {
        return res.status(409).json({
            error: `Theme "${slug}" was not created by the WordJS theme writer (theme.json lacks generator: "wordjs") — edit its files directly instead`
        });
    }

    const body = isPlainObject(req.body) ? req.body : {};
    if (DECLARATIVE_KEYS.every((k: string) => body[k] === undefined)) {
        return res.status(400).json({ error: 'Nothing to update: provide at least one of seeds, archetype, tokens or styles' });
    }
    const shapeErr = declarativeShapeError(body);
    if (shapeErr) {
        return res.status(400).json({ error: shapeErr });
    }

    const next: any = { ...current, generator: 'wordjs', version: bumpPatch(current.version) };
    for (const k of DECLARATIVE_KEYS) {
        if (body[k] === null) delete next[k];
        else if (body[k] !== undefined) next[k] = body[k];
    }
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_THEME_JSON) {
        return res.status(400).json({ error: `theme.json exceeds the ${MAX_THEME_JSON}-byte cap` });
    }

    // Dry-compile the NEW theme.json in a temp dir first: a rejected payload must leave the
    // installed theme byte-identical.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-theme-build-'));
    let compiled: any;
    try {
        fs.writeFileSync(path.join(tmpDir, 'theme.json'), serialized);
        compiled = compileTheme(tmpDir, { slug, dryRun: true });
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (hasCompileErrors(compiled.diagnostics)) {
        return res.status(400).json({ error: 'Theme compilation failed', diagnostics: compiled.diagnostics });
    }

    // theme.json first (it is the source of truth the block can always be regenerated from),
    // then the marked block. Both writes are tmp+rename; functions.js is NEVER touched.
    writeJsonAtomic(themeJsonPath, serialized);
    writeCompiled(themeDir, compiled.css);
    res.json({ slug, version: next.version, diagnostics: compiled.diagnostics });
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
router.post('/:slug/activate', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    // CONCURRENCY: this handler is deliberately thin, and the serialization lives in core, not here — a
    // double-click (or two admins) must not overlap two theme switches, and neither must the OTHER callers
    // of switchTheme (POST /plugins/:slug/install-theme) or of theme-engine.init() (boot, render()'s lazy
    // re-init). core/themes.switchTheme joins a duplicate activation of the SAME slug, and
    // theme-engine.init() is serialized process-wide; guarding the route alone would leave both open.
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
router.post('/default', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Admin explicitly asked to restore the default theme → force overwrite (unlike the boot-time
    // scaffold in index.ts, which must NOT clobber the curated default/style.css).
    createDefaultTheme(true);
    res.json({ success: true, message: 'Default theme restored in /themes/default' });
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
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
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
router.get('/:slug/download', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const zipPath = await createThemeZip(req.params.slug);

    res.download(zipPath, `${req.params.slug}.zip`, (err: any) => {
        // Clean up temp file after download
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
    });
}));

/**
 * @swagger
 * /themes/{slug}/doctor:
 *   get:
 *     summary: Lint a theme against the wordjs-ui.css token contract (read-only)
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
 *         description: Doctor report ({ available:false } when the token manifest is absent — fail-open)
 */
router.get('/:slug/doctor', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug
    if (!validateSlug(req.params.slug)) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    res.json(analyzeTheme(req.params.slug));
}));

module.exports = router;
