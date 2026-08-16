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
    invalidateThemeScanCache,
    getActiveTheme,
    THEMES_DIR
} = require('../core/themes');
const { purgeFrontend } = require('../core/frontend-purge');
const { getOption, updateOption } = require('../core/options');
const { validateThemeMods, parseStoredMods } = require('../core/theme-mods');
const { compileTheme, writeCompiled } = require('../core/theme-compile');
const { analyzeTheme } = require('../core/theme-doctor');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { recordAudit } = require('../core/audit');
const { resolveThemeDir, resolveWithin } = require('../core/safe-path');

/**
 * @swagger
 * tags:
 *   name: Themes
 *   description: Theme management (Install, Switch, Delete)
 */

/**
 * El UNICO directorio donde puede vivir el zip de una subida, absoluto y resuelto UNA vez al cargar.
 *
 * Antes era la cadena 'os-tmp/' dentro del `dest` de multer: relativa al cwd y reinterpretada en cada
 * peticion, asi que "nuestro directorio de trabajo" coincidia con el que cuelga de THEMES_DIR solo
 * mientras nadie llamase a process.chdir(). Resolverlo desde THEMES_DIR lo convierte en un invariante
 * en lugar de una coincidencia, y le da al guard de contencion del handler de /upload una base fija
 * contra la que probar. (io-guard ya trata ROOT_DIR/os-tmp como scratch.) Misma constante y mismo
 * razonamiento que en routes/plugins.ts.
 */
const OS_TMP_DIR = path.resolve(THEMES_DIR, '..', 'os-tmp');

// Configure multer for zip uploads
const upload = multer({
    // Absoluto a proposito: es la base de contencion que comprueba el handler de /upload.
    // Sigue siendo almacenamiento EN DISCO — memoryStorage cargaria en RAM temas enteros.
    dest: OS_TMP_DIR,
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
 * SECURITY: resolve `<THEMES_DIR>/<slug>` or fail closed.
 *
 * This USED to be a boolean guard that resolved a path into a local, checked it, threw it away and
 * let every handler re-join the RAW slug afterwards. That is the shape of the bug, not the fix: the
 * value that was proved safe was never the value that reached the syscall (and the prefix test had
 * no separator, so `themes/` would have matched a sibling `themes-evil/`). core/safe-path does the
 * three things that actually constitute a defense — allowlist the FORM, resolve canonically, prove
 * containment — and RETURNS the resolved directory, so handlers use what was checked.
 *
 * The form is now THE canonical THEME_SLUG (leading alphanumeric, 64 max), identical to what
 * installThemeFromDir / createDefaultTheme enforce when a theme is written. A slug outside it cannot
 * name an installed theme, so narrowing here rejects nothing that could ever have resolved.
 */
function resolveThemeDirOr400(slug: any): string | null {
    return resolveThemeDir(THEMES_DIR, slug);
}

/** Boolean form for the handlers that only pass the slug on to a core function. */
function validateSlug(slug: any): boolean {
    return resolveThemeDirOr400(slug) !== null;
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

    // CONTENCION DEL FICHERO TEMPORAL — INLINE, Y AQUI SE QUEDA.
    //
    // POR QUE AQUI Y NO EN UN HELPER (no lo refactorices a una utilidad). `req.file.path` lo escribe
    // multer, o sea que es un valor derivado de la peticion; mas abajo se abre como archivo y se
    // BORRA con fs.unlinkSync en siete salidas distintas mas la del catch. El analisis de rutas
    // contaminadas razona DENTRO de una funcion: un barrier que vive en otro modulo — o en otra
    // funcion de este — no apaga el sumidero en el llamante, por buena que sea la prueba. Esa es
    // exactamente la razon de que las ocho alertas js/path-injection colgadas de `zipPath` en este
    // fichero siguieran encendidas teniendo core/safe-path delante. Mover esto a un helper las reabre
    // las ocho de golpe.
    //
    // Las tres partes de la defensa, aplicadas sobre el valor QUE SE USA despues:
    //   1. FORMA: cadena no vacia y sin NUL (un NUL trunca la ruta que acaba viendo la capa C, y asi
    //      es como una comprobacion y un syscall dejan de hablar de la misma ruta);
    //   2. RESOLUCION CANONICA: path.resolve() da la ruta absoluta y normalizada que recibira el
    //      syscall, no el texto que llego;
    //   3. CONTENCION PROBADA contra `base + path.sep`, nunca un prefijo pelado — `os-tmp-evil`
    //      "empieza por" os-tmp.
    // Falla cerrado: lo que no esta contenido no se borra, se responde 400 y se sale.
    const uploadedPath = req.file.path;
    if (typeof uploadedPath !== 'string' || uploadedPath.length === 0 || uploadedPath.includes('\0')) {
        return res.status(400).json({ error: 'Upload rejected: the temporary file has no usable path' });
    }
    const zipPath = path.resolve(uploadedPath);
    if (!zipPath.startsWith(OS_TMP_DIR + path.sep)) {
        return res.status(400).json({ error: 'Upload rejected: the temporary file is not inside the theme scratch directory' });
    }

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

        // WHICH THEME IS THIS? The zip's ROOT FOLDER, not the upload's filename.
        //
        // It used to be `path.parse(req.file.originalname).name` — the multipart filename, chosen by
        // whoever posted the request — joined onto THEMES_DIR to pick the directory the "already
        // exists" probe ran against. Two things were wrong with that, and only one of them is the
        // CodeQL finding:
        //   · a request field chose a path (`...zip` parses to the name `..`; path.parse dropping the
        //     directory part is a property of the parser, not a containment proof); and
        //   · IT NAMED THE WRONG DIRECTORY. Extraction is driven by the ENTRIES, so a zip called
        //     `astra-4.1.2.zip` containing `astra/` was checked against `themes/astra-4.1.2` (absent
        //     → "not installed") and then extracted with overwrite=true straight over an existing
        //     `themes/astra`. The guard could not have protected the write: it was not looking at it.
        // The root folder is what actually becomes a theme, so that is what is checked — its FORM
        // against THEME_SLUG (the shape every other theme path in the project agrees on) and its
        // containment through safe-path, on the value used below.
        const rootSegments = new Set<string>();
        for (const entry of zipEntries) {
            const first = String(entry.entryName).replace(/\\/g, '/').split('/')[0];
            if (first) rootSegments.add(first);
        }
        if (rootSegments.size !== 1) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({
                error: rootSegments.size === 0
                    ? 'The zip is empty.'
                    : `A theme zip must contain exactly one top-level folder (found ${rootSegments.size}: ${[...rootSegments].slice(0, 5).map((s) => JSON.stringify(s)).join(', ')}).`
            });
        }
        const zipName = [...rootSegments][0];
        const targetDir = resolveThemeDir(THEMES_DIR, zipName);
        if (targetDir === null) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({
                error: `Invalid theme folder ${JSON.stringify(zipName)} inside the zip — a theme directory is letters, digits, "-" and "_", starting with a letter or digit.`
            });
        }

        // Check if theme already exists — now against the directory extraction will actually create.
        if (fs.existsSync(targetDir)) {
            fs.unlinkSync(zipPath);
            return res.status(400).json({ error: `Theme "${zipName}" already exists` });
        }

        // SECURITY: Verify EVERY entry resolves inside the theme's OWN directory before extracting
        // (Zip Slip: absolute paths, '..', symlink-style escapes). Extraction target is THEMES_DIR,
        // but a theme's entries may only ever land under `<THEMES_DIR>/<zipName>/` — checking against
        // THEMES_DIR alone let one upload write into a SIBLING theme's directory.
        for (const entry of zipEntries) {
            const name = String(entry.entryName).replace(/\\/g, '/');
            const segments = name.split('/').filter((s) => s !== '');
            const dest = segments.length ? resolveWithin(THEMES_DIR, ...segments) : null;
            if (dest === null || !(dest === targetDir || dest.startsWith(targetDir + path.sep))) {
                fs.unlinkSync(zipPath);
                return res.status(400).json({ error: 'Malicious zip file detected (Zip Slip / path traversal)' });
            }
        }

        // Extract zip
        zip.extractAllTo(THEMES_DIR, true);
        // This route writes into THEMES_DIR without going through core/themes — drop the scan memo
        // itself, or the theme just uploaded stays missing from GET /themes until the TTL expires.
        invalidateThemeScanCache();

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
    // SECURITY: the slug picks the directory this handler WRITES theme.json and style.css into, so it
    // uses the resolved-and-contained path the gate returns rather than re-joining the raw param.
    const themeDir = resolveThemeDirOr400(req.params.slug);
    if (themeDir === null) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const slug = req.params.slug;
    if (!fs.existsSync(themeDir)) {
        return res.status(404).json({ error: `Theme ${slug} not found` });
    }
    const themeJsonPath = resolveWithin(themeDir, 'theme.json');
    if (themeJsonPath === null) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
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
    // This rebuild edits a theme IN PLACE, behind core/themes' back: drop the scan memo (it still
    // holds the pre-bump version) before anything can read the old one back.
    invalidateThemeScanCache();

    // The patch bump is what busts the cached stylesheet URL on the public pages, but the version is
    // DERIVED from theme.json (no option row), so no updated_option hook fires here — purge
    // explicitly, exactly like DELETE /api/v1/chrome/:part does. Only the ACTIVE theme is on a public
    // page, so editing an inactive one must not evict the whole public cache. Resolved through
    // getActiveTheme (not the raw `template` option) so this matches, case for case, the theme the
    // settings payload derives active_theme_version from — including its fallback.
    const active = await getActiveTheme();
    if (active && active.slug === slug) purgeFrontend(['settings'], ['/']);

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
    // AUDIT: an admin activated a theme. Slug only — no secret material.
    await recordAudit((req as any).user && (req as any).user.id, 'theme.activate', 'theme', req.params.slug, {});
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
    // Admin explicitly asked to restore the default theme → force overwrite. This is the ONLY path
    // that clobbers files inside themes/: boot no longer scaffolds anything (it verifies and warns —
    // see index.ts), and the install wizard provisions once, without force. A plain
    // createDefaultTheme() would leave every existing file exactly as the user edited it, which is
    // the opposite of what "restore" was asked for.
    createDefaultTheme(true);
    // Restoring rewrites files inside THEMES_DIR without going through switchTheme, so nothing else
    // would notice: the memoized scan would keep the pre-restore metadata (including the version the
    // stylesheet URL is keyed by) and the public HTML would keep its cached copy. createDefaultTheme
    // bumps the version; these two make the site actually serve the restored theme.
    invalidateThemeScanCache();
    const activeAfterRestore = await getActiveTheme();
    if (activeAfterRestore && activeAfterRestore.slug === 'default') purgeFrontend(['settings'], ['/']);
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
    // SECURITY: the slug picks BOTH the folder that gets packed and the temp file the zip is written
    // to — and the file this handler then serves and DELETES. The boolean gate that used to stand
    // here is not enough on its own: it proves a property of a path it throws away, while the raw
    // param travels on to createThemeZip. It stays (fail fast, 400 instead of 500), but the real
    // barrier now lives in core/themes.createThemeZip, which resolves the destination under os-tmp/
    // and RETURNS the proved value — so `zipPath` below is contained by construction.
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

// A template file name the route hierarchy can resolve — the SAME shape server-api.ts's getThemeTemplate
// and templateData.ts's TEMPLATE_NAME enforce before a name lands in a /themes/<slug>/templates/<name>.json
// URL. Anything else is dropped from the listing rather than sanitized: a file that cannot be a candidate
// must never be offered as one.
const TEMPLATE_FILE_NAME = /^[a-z0-9-]{1,40}$/;

/**
 * @swagger
 * /themes/{slug}/templates:
 *   get:
 *     summary: List the page templates a theme ships (templates/*.json), for the per-page template picker
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
 *         description: "{ slug, templates: string[] } — template names without the .json extension"
 *       400:
 *         description: Invalid theme slug
 */
router.get('/:slug/templates', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: same slug gate as the sibling routes — the slug becomes a path segment under
    // THEMES_DIR, so the handler reads the RESOLVED directory the gate returned, never a re-join of
    // req.params.slug. `templates` then descends from a proven-contained base.
    const themeDir = resolveThemeDirOr400(req.params.slug);
    if (themeDir === null) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    const dir = resolveWithin(themeDir, 'templates');
    if (dir === null) {
        return res.status(400).json({ error: 'Invalid theme slug' });
    }
    let names: string[];
    try {
        // withFileTypes so a `templates` that is somehow a directory-of-directories (or a symlink target)
        // cannot slip a non-file name into the list. Only regular *.json files are candidates.
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        names = entries
            .filter((e: any) => e.isFile() && e.name.endsWith('.json'))
            .map((e: any) => e.name.slice(0, -'.json'.length))
            // The shape gate: a file whose name the hierarchy could never request is not a real template.
            .filter((name: string) => TEMPLATE_FILE_NAME.test(name))
            .sort();
    } catch {
        // No templates/ directory (the common case — most themes ship none) → an empty list, not an error.
        names = [];
    }
    res.json({ slug: req.params.slug, templates: names });
}));

/**
 * @swagger
 * /themes/mods/export:
 *   get:
 *     summary: Export the active theme's customizer mods as a downloadable JSON file (Admin)
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ theme, mods } — the sanitized active_theme_mods, safe to re-import"
 */
router.get('/mods/export', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const active = await getActiveTheme();
    const themeSlug = active && active.slug ? active.slug : '';
    // Sanitize on the way OUT too: a stored row could predate the contract (or have been hand-edited), and
    // an export must only ever contain mods the customizer would accept, so the file round-trips cleanly.
    const mods = parseStoredMods(await getOption('active_theme_mods', ''));
    const payload = { theme: themeSlug, exportedAt: new Date().toISOString(), mods };
    // A real download: the admin UI hits this and the browser saves a file rather than rendering JSON.
    const fileSlug = themeSlug && /^[a-zA-Z0-9_-]+$/.test(themeSlug) ? themeSlug : 'theme';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSlug}-customizer-mods.json"`);
    res.send(JSON.stringify(payload, null, 2));
}));

/**
 * @swagger
 * /themes/mods/import:
 *   post:
 *     summary: Import customizer mods, validating every key/value before applying them (Admin)
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Either a bare { "--wjs-*": "value" } map or the export wrapper { theme, mods }
 *     responses:
 *       200:
 *         description: "{ applied: true, count } — mods validated and written to active_theme_mods"
 *       400:
 *         description: "Invalid payload — { error, errors: [{ key, code, message }] }, nothing written"
 */
router.post('/mods/import', authenticate, isAdmin, asyncHandler(async (req: any, res: Response) => {
    // NEVER trust the uploaded JSON. Accept a bare mods map OR the export wrapper, then validate STRICTLY:
    // one bad key/value fails the whole import (reject, never silently strip a subset).
    const { extractImportMods } = require('../core/theme-mods');
    const source = extractImportMods(req.body);
    if (source === null) {
        return res.status(400).json({
            error: 'Import must be a JSON object of --wjs-* mods, or an { mods: { … } } export.',
            errors: [],
        });
    }
    const result = validateThemeMods(source);
    if (!result.ok) {
        return res.status(400).json({ error: 'Invalid customizer mods', errors: result.errors });
    }
    // Store the sanitized object exactly as the customizer save path does (JSON string in the option).
    await updateOption('active_theme_mods', JSON.stringify(result.mods));
    // The overlay is on the public page, so importing new mods re-skins the live site — purge like the
    // customizer's own writes do. 'settings' carries active_theme_mods; '/' is the home route the overlay
    // renders into. Mirrors PUT /themes/:slug and DELETE /chrome/:part.
    purgeFrontend(['settings'], ['/']);
    // AUDIT: an admin replaced the customizer mods. Count only — the values are token overrides, but the
    // route's convention is to record what changed, not the payload.
    await recordAudit(req.user && req.user.id, 'theme.mods.import', 'theme', '', { count: Object.keys(result.mods).length });
    res.json({ applied: true, count: Object.keys(result.mods).length });
}));

module.exports = router;
// Expuesto SOLO para los tests: la base de contencion que el handler de /upload comprueba inline y a
// la que multer escribe. No lo uses como "utilidad de rutas" — la comprobacion tiene que seguir
// estando escrita dentro del handler (ver el comentario largo en POST /upload).
module.exports.OS_TMP_DIR = OS_TMP_DIR;
