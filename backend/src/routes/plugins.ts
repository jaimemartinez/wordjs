/**
 * WordJS - Plugins Routes
 * /api/v1/plugins/*
 */

import type { Request, Response } from 'express';
// Type-only, and load-bearing: tsconfig pins `types` to ["node"], so @types/multer only enters the
// program when something imports it. That package is what declares `Express.Multer.File` and augments
// Express's Request with `file` — the two names the upload route below needs. `import type` is erased
// at emit, so multer itself stays the plain runtime require() a line down.
import type { FileFilterCallback } from 'multer';

const express = require('express');
const router = express.Router();
const AdmZip = require('adm-zip');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAllPlugins, activatePlugin, deactivatePlugin, createSamplePlugin, isPluginActive, validatePluginPermissions, validateManifestPermissions, uninstallPluginData, PLUGINS_DIR } = require('../core/plugins');
const { assertZipWithinBudget } = require('../core/zip-guard');
const { authenticate, authenticateAllowQuery } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler, publicErrorText } = require('../middleware/errorHandler');
const { recordAudit } = require('../core/audit');
const { execFile } = require('child_process');
const { resolveWithin } = require('../core/safe-path');

/**
 * @swagger
 * tags:
 *   name: Plugins
 *   description: Plugin management (Install, Activate, Delete)
 */

/**
 * The ONE directory an install zip may ever live in, absolute and resolved once at load.
 *
 * It used to be the string 'os-tmp/' here and `path.resolve(PLUGINS_DIR, '..', 'os-tmp')` further down —
 * the same directory only as long as process.cwd() happened to be the backend root. Resolving it once,
 * from PLUGINS_DIR, makes that an invariant instead of a coincidence, and gives the containment guard
 * inside installPluginFromZip() a fixed base to prove against. (io-guard already treats ROOT_DIR/os-tmp
 * as scratch.)
 */
const OS_TMP_DIR = path.resolve(PLUGINS_DIR, '..', 'os-tmp');

// Configure multer for zip uploads
const upload = multer({
    // Absoluto a proposito: es la base de contencion que installPluginFromZip() comprueba inline.
    // Sigue siendo almacenamiento EN DISCO — memoryStorage cargaria en RAM plugins enteros.
    dest: OS_TMP_DIR,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        // SECURITY: Prevent CVE-2025-47935/47944 DoS
        files: 1,           // Only 1 plugin zip per request
        fields: 10,         // Minimal fields needed
        parts: 15           // Limited total parts
    },
    fileFilter: (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
        if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only .zip files are allowed'));
        }
    }
});

/**
 * Regenerate the frontend and admin plugin registries
 * Called when plugins are activated/deactivated
 */
function regenerateRegistry() {
    // In production the frontend ships as a pre-built .next bundle, so the registries are baked in at
    // build time — regenerating the source .ts at runtime can't help (and frontend/scripts may not
    // ship). Only useful in dev, where rewriting the registry sources triggers Next HMR so a newly
    // activated plugin's admin page / editor blocks appear WITHOUT the old manual "regenerate + restart".
    // (The path was '../../../admin-next/scripts' — a directory that does not exist — so this silently
    // no-op'd on every activate/deactivate. The real generators live in frontend/scripts/.)
    if (process.env.NODE_ENV === 'production') return;
    const scriptsDir = path.resolve(__dirname, '../../../frontend/scripts');
    const scripts = [
        'generate-plugin-registry.js',         // Frontend components
        'generate-admin-plugin-registry.js',   // Admin pages
        'generate-verso-plugin-registry.js'    // Verso block components
    ];

    // Resolve the authoritative active list IN-PROCESS and hand it to the generators via env.
    // Their own fallback (GET /plugins/active over plain http) fails against an https dev server —
    // they then include EVERY plugin found on disk, active or not — and can race uninstall's
    // directory deletion, leaving the registries importing a deleted plugin (Module not found).
    getAllPlugins().then((plugins: any) => {
        const activeSlugs = (plugins || []).filter((p: any) => p.active).map((p: any) => p.slug);
        const env = { ...process.env, WORDJS_ACTIVE_PLUGINS: JSON.stringify(activeSlugs) };

        for (const script of scripts) {
            const scriptPath = path.join(scriptsDir, script);

            if (!fs.existsSync(scriptPath)) {
                console.log('⚠️  Script not found: %s', script);
                continue;
            }

            // SECURITY: Use execFile instead of exec to prevent command injection
            execFile('node', [scriptPath], { env }, (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    console.error('❌ Failed to run %s:', script, error.message);
                    return;
                }
                if (process.env.NODE_ENV !== 'production') {
                    console.log('🔄 %s:', script);
                    console.log(stdout);
                }
            });
        }
    }).catch((e: any) => console.error('regenerateRegistry: could not resolve active plugins:', e && e.message));
}

/**
 * Remove a plugin directory but PRESERVE its top-level data/ subdir (runtime state: encryption keys,
 * attachments…). Without this, uninstalling mail-server destroys data/.mailenc — the AES root key —
 * and every stored mail secret becomes permanently undecryptable even though its wjp_ tables survive.
 * If no data/ exists the directory is removed entirely. The residual data-only dir is understood by
 * installPluginFromZip, which ADOPTS it on reinstall instead of refusing with a 409.
 */
function removePluginDirPreservingData(dir: string) {
    const dataDir = path.join(dir, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
    }
    for (const entry of fs.readdirSync(dir)) {
        if (entry === 'data') continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
}

// Strict plugin-slug charset. A slug is a SINGLE path segment (starts alnum, then alnum/dash/underscore,
// max 64) — so it can never be '.', '..', a separator, or resolve to a parent/other directory.
// IDENTICAL to core/plugin-permissions' PLUGIN_SLUG (asserted in backend/src/tests/plugin-path-guards.test.ts).
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function isValidSlug(slug: any): boolean {
    return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * Resolve a REQUEST-supplied slug to the validated slug string, or null.
 *
 * This replaces the old `validateSlug()`, which was the exact anti-pattern this codebase keeps
 * re-shipping: it validated a COPY and returned a BOOLEAN, so every one of its ten call sites went on to
 * re-read the RAW `req.params.slug` and concatenate that. Worse, its containment test was a BARE prefix
 * (`resolved.startsWith(path.resolve(PLUGINS_DIR))`, no `path.sep`) — the very check safe-path exists to
 * stop us writing, because `plugins-evil` "starts with" `plugins`.
 *
 * Here the FORM gate (SLUG_RE) and the CONTAINMENT proof (safe-path.resolveWithin → absolute, normalized,
 * `base + path.sep`) both run, and what comes back is the value the caller must use. Null = fail closed;
 * callers turn it into 400 and never touch the raw parameter again.
 */
function safeSlugParam(raw: unknown): string | null {
    if (!isValidSlug(raw)) return null;
    const slug = raw as string;
    // Proves the slug names a proper CHILD of PLUGINS_DIR (never PLUGINS_DIR itself, never an ancestor).
    return resolveWithin(PLUGINS_DIR, slug) ? slug : null;
}

/**
 * `<PLUGINS_DIR>/<slug>/<...rest>` with the same three-part defense, or null. The single helper every
 * read of a plugin-owned file goes through, so no route re-invents path.join(PLUGINS_DIR, slug, …) —
 * including the ones fed by a readdir listing (an entry name is still a segment we did not write).
 */
function pluginFile(slug: unknown, ...rest: string[]): string | null {
    if (!isValidSlug(slug)) return null;
    return resolveWithin(PLUGINS_DIR, slug as string, ...rest);
}

/**
 * La respuesta a un paquete de instalacion que no esta dentro de nuestro directorio de trabajo.
 *
 * Es una FUNCION, no una constante compartida: cada rechazo devuelve su propio objeto, para que un
 * llamante que decore `body` no contamine el siguiente rechazo. La prueba de contencion en si NO vive
 * aqui — vive escrita dentro de installPluginFromZip, junto al sumidero (ver el comentario alli).
 */
function refuseUncontainedZip(): { ok: boolean; status: number; body: any } {
    return { ok: false, status: 400, body: { error: 'Install package is not inside the plugin scratch directory' } };
}

/**
 * Allocate a PRIVATE scratch directory for a downloaded install package.
 *
 * A predictable path in a shared temp dir is a file to be pre-created, not a file to be written: whoever
 * owns the inode first owns the bytes, and `writeFileSync` follows a symlink that is already there — the
 * `{ mode: 0o600 }` argument is ignored entirely for an existing file. mkdtemp is the fix rather than a
 * longer random name: the kernel creates the directory exclusively, at 0700, so there is no window in
 * which a name can be squatted and no other user can look inside it.
 *
 * The file itself is then written with `flag: 'wx'` (exclusive create — refuses to follow anything) into
 * that fresh dir. Callers MUST call dispose() in a finally: the install pipeline deletes the ZIP, never
 * the directory around it.
 */
function createInstallTmp(): { dir: string; zipPath: string; dispose: () => void } {
    fs.mkdirSync(OS_TMP_DIR, { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(OS_TMP_DIR, 'install-'));
    return {
        dir,
        zipPath: path.join(dir, 'package.zip'),
        dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } },
    };
}

/**
 * Strip line breaks from a request-derived value before it goes into a log line, so a crafted slug or
 * driver error cannot forge or split entries in the operator's log.
 *
 * TWO single-constant replacements, each replacing with the empty string, is deliberate: the
 * log-injection analysis recognises a sanitizer SYNTACTICALLY, and an alternation (`/\n|\r/g`) has no
 * constant value, so it is not matched. Match the documented remediation shape, not an equivalent.
 */
function logSafe(v: any): string {
    return String(v == null ? '' : v).replace(/\n/g, '').replace(/\r/g, '');
}

// How long DELETE waits for the slug's child process to actually be gone before it refuses to remove
// the directory. Generous enough for a SIGKILL to be reaped, short enough to answer the request.
const DELETE_STOP_TIMEOUT_MS = 3000;

// The SINGLE choke point every slug-derived fs op must go through (download / delete / extract-install).
// Resolves an untrusted slug to its plugin dir or THROWS (400), guaranteeing the result is a proper CHILD
// of PLUGINS_DIR — never PLUGINS_DIR itself (which would let a failure-path rmSync wipe every plugin) or
// an ancestor (which a crafted '..' filename / './'-prefixed zip entry could otherwise reach).
// The containment proof itself is core/safe-path's resolveWithin — ONE implementation for themes and
// plugins alike, so the two can never drift into different dialects of "inside".
function resolveSafePluginDir(slug: any): string {
    if (!isValidSlug(slug)) {
        const e: any = new Error(`Invalid plugin slug: ${JSON.stringify(slug)}`);
        e.status = 400;
        throw e;
    }
    const dir = resolveWithin(PLUGINS_DIR, slug as string);
    if (!dir) {
        const e: any = new Error('Invalid plugin slug: resolves outside the plugins directory');
        e.status = 400;
        throw e;
    }
    return dir;
}
/**
 * @swagger
 * /plugins/upload:
 *   post:
 *     summary: Upload and install a plugin (ZIP)
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               plugin:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Plugin installed
 *       400:
 *         description: Invalid file or zip slip detected
 */
router.post('/upload', authenticate, isAdmin, upload.single('plugin'), asyncHandler(async (req: Request, res: Response) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const result = await installPluginFromZip(req.file.path, req.file.originalname);
    res.status(result.status).json(result.body);
}));

/**
 * Shared plugin-zip install pipeline — the SINGLE implementation of every security check
 * (zip bomb, Zip Slip, slug validation, squat/clobber refusal, manifest + AST validation),
 * used by BOTH the direct upload above and the marketplace installer (routes/marketplace.ts).
 * Always deletes zipPath before returning. Expected failures come back as { ok:false, status, body }
 * rather than throwing, so callers map them straight onto the HTTP response.
 */
/**
 * @param expectedSlug When the caller already owns a plugin directory (the UPDATE path), the slug it
 *   is replacing. The install target is derived from the zip's own root folder, so without this the
 *   update path could extract somewhere else entirely: a release zip rooted at 'mail-server-2.3.0/'
 *   installs to plugins/mail-server-2.3.0/ while runPluginUpdate has already stashed the real
 *   plugins/mail-server/ code — and because that install SUCCEEDS, no rollback fires and the success
 *   path then deletes the stash. The plugin is destroyed and a stray directory is left behind.
 *   Mismatch is refused rather than retargeted: silently extracting a zip into a directory it did not
 *   name would let a zip for one plugin overwrite another.
 */
async function installPluginFromZip(zipPathIn: string, originalName: string, expectedSlug?: string): Promise<{ ok: boolean; status: number; body: any }> {
    // CONTENCION PRIMERO — INLINE, Y AQUI SE QUEDA.
    //
    // POR QUE AQUI Y NO EN UN HELPER (no lo refactorices a una utilidad). Esta funcion borra su zip
    // con fs.unlinkSync en trece caminos de fallo y ademas lo abre como archivo, y la ruta se la elige
    // el LLAMANTE: el fichero temporal de multer en POST /plugins/upload, la descarga del marketplace,
    // el zip de la actualizacion. Antes esto delegaba en un `assertZipInOsTmp(zipPathIn)` que hacia
    // exactamente las mismas tres comprobaciones — y no servia, porque el analisis de rutas
    // contaminadas razona DENTRO de una funcion: un barrier escrito en otra funcion no apaga el
    // sumidero de esta, aunque devuelva el valor ya probado. De ahi que la alerta js/path-injection
    // siguiera senalando el unlink de discardZip(). Sacar esto a un helper la vuelve a encender.
    //
    // Las tres partes de la defensa, sobre el valor QUE SE USA despues (nunca sobre el argumento):
    //   1. FORMA: cadena no vacia y sin NUL (un NUL trunca la ruta que ve la capa C);
    //   2. RESOLUCION CANONICA: path.resolve() da la ruta absoluta y normalizada que recibira el
    //      syscall, no el texto que paso el llamante;
    //   3. CONTENCION PROBADA contra `base + path.sep` — nunca un prefijo pelado, que aceptaria un
    //      hermano llamado `os-tmp-evil`, y exigiendo un HIJO, nunca el propio directorio base.
    // Falla cerrado: una ruta que no podemos situar dentro de nuestro scratch no se ofrece como
    // objetivo de borrado; se devuelve 400 y no se toca el disco.
    if (typeof zipPathIn !== 'string' || zipPathIn.length === 0 || zipPathIn.includes('\0')) {
        return refuseUncontainedZip();
    }
    const zipPath = path.resolve(zipPathIn);
    if (!zipPath.startsWith(OS_TMP_DIR + path.sep)) {
        return refuseUncontainedZip();
    }
    // ONE deletion helper, so no failure path can grow a raw unlink again.
    const discardZip = () => { try { fs.unlinkSync(zipPath); } catch { /* already gone */ } };
    try {
        const zip = new AdmZip(zipPath);
        const zipEntries = zip.getEntries();

        // SECURITY: reject a decompression bomb BEFORE extracting (multer only capped the compressed
        // upload — a ~10MB DEFLATE stream can expand to many GB and fill the disk).
        try {
            assertZipWithinBudget(zipEntries, { kind: 'plugin' });
        } catch (e: any) {
            discardZip();
            return { ok: false, status: 400, body: { error: e.message } };
        }

        // Basic validation: ensure it extracts into a folder
        // We expect the zip to contain a root folder, e.g. "my-plugin/"
        // If it contains directly files, we might want to create a folder based on filename, 
        // but standard WP plugins usually come in a folder. 
        // Let's assume standard structure or create folder from filename.

        // Check if root entry is a folder
        const mainEntry = zipEntries[0];
        let targetFolder = PLUGINS_DIR;
        let pluginSlug = '';

        // Simple extraction: extract all to PLUGINS_DIR
        // If the zip creates a folder, great. If not, messy.
        // Let's create a folder based on the zip filename (minus extension) to be safe.
        // Derive the intended install slug and VALIDATE it before building any path. The slug comes from
        // the zip's single root dir, or (files-at-root) from the filename. It MUST be a clean single
        // segment: a crafted filename ('...zip' → path.parse().name === '..') or a './'-prefixed entry
        // (first segment '.') would otherwise redirect extractAllTo into the host code tree (backend/) or
        // collapse the target to PLUGINS_DIR itself (a later failure-path rmSync then wipes every plugin).
        const zipName = path.parse(originalName).name;

        // OS archivers add sibling junk at the zip root (__MACOSX/, .DS_Store, Thumbs.db, desktop.ini) —
        // ignore it for root detection and skip extracting it, so a valid single-folder plugin isn't
        // misread as multi-root (which would double-nest it under the filename and fail the manifest check).
        const isJunkEntry = (raw: string): boolean => {
            const norm = String(raw).replace(/\\/g, '/');
            const first = norm.split('/')[0];
            return first === '__MACOSX' || first === '.git'
                || /(^|\/)(\.DS_Store|Thumbs\.db|\.AppleDouble|\.Spotlight-V100|desktop\.ini)$/i.test(norm);
        };
        const contentEntries = zipEntries.filter((e: any) => !isJunkEntry(e.entryName));
        if (contentEntries.length === 0) {
            discardZip();
            return { ok: false, status: 400, body: { error: 'Zip contains no plugin files.' } };
        }

        // First path segment of every CONTENT entry (normalize backslashes). Reject '.'/'..' tokens
        // outright — adm-zip preserves a leading './', and split('/')[0] would otherwise yield '.'.
        const rootDirs = new Set<string>();
        for (const e of contentEntries) {
            const first = String(e.entryName).replace(/\\/g, '/').split('/')[0];
            if (!first) continue;
            if (first === '.' || first === '..') {
                discardZip();
                return { ok: false, status: 400, body: { error: 'Malicious zip: entry names contain "." / ".." path segments.' } };
            }
            rootDirs.add(first);
        }

        const singleRoot = rootDirs.size === 1;
        const intendedSlug = (singleRoot ? Array.from(rootDirs)[0] : zipName) as string;
        if (!isValidSlug(intendedSlug)) {
            discardZip();
            return { ok: false, status: 400, body: { error: `Refused: '${intendedSlug}' is not a valid plugin folder name (expected a single [A-Za-z0-9_-] segment, no dots or separators).` } };
        }
        // Replacing a specific plugin: the zip must name that same plugin. See expectedSlug above —
        // installing to a different directory here is silently destructive, so fail loudly instead
        // and let the caller roll back.
        if (expectedSlug && intendedSlug !== expectedSlug) {
            discardZip();
            return {
                ok: false,
                status: 400,
                body: {
                    error: `Refused: this archive installs '${intendedSlug}', but the plugin being updated is '${expectedSlug}'. `
                        + `The zip's root folder must be named '${expectedSlug}' (a version-suffixed folder such as `
                        + `'${expectedSlug}-1.2.3' is not accepted, because the update must replace the existing directory).`,
                    intendedSlug,
                    expectedSlug,
                },
            };
        }
        // Guaranteed a proper CHILD of PLUGINS_DIR (throws otherwise). In BOTH shapes the plugin's files
        // must land under installedDir: single-root entries carry the '<slug>/' prefix and extract to
        // PLUGINS_DIR; files-at-root extract into installedDir. Confinement is checked against installedDir
        // either way — so cross-plugin overwrite (my-plugin/../victim/evil.js) is blocked by CONTAINMENT,
        // not merely by a '..' substring heuristic.
        const installedDir = resolveSafePluginDir(intendedSlug);
        const targetDir = singleRoot ? PLUGINS_DIR : installedDir;
        const confineDir = path.resolve(installedDir);

        // SECURITY: Zip Slip — every content entry must resolve INSIDE the plugin's own dir. Segment-level
        // '..' check (a filename that merely embeds '..' like 'a..b.min.js' is legitimate and allowed).
        for (const entry of contentEntries) {
            const rel = String(entry.entryName).replace(/\\/g, '/');
            const dest = path.resolve(targetDir, rel);
            const isContained = dest === confineDir || dest.startsWith(confineDir + path.sep);
            const hasDotDotSegment = rel.split('/').includes('..');
            if (!isContained || hasDotDotSegment) {
                discardZip();
                return { ok: false, status: 400, body: { error: 'Malicious zip file detected (Zip Slip / path traversal)' } };
            }
        }

        // SECURITY: an uploaded plugin must NOT claim a reserved system-plugin slug (empty list by default)
        // nor clobber an existing plugin by case/Unicode variant. Canonicalize for comparison.
        const canonSlug = String(intendedSlug).normalize('NFC').toLowerCase();
        const RESERVED_SLUGS: string[] = [];
        if (RESERVED_SLUGS.some(s => String(s).normalize('NFC').toLowerCase() === canonSlug)) {
            discardZip();
            return { ok: false, status: 409, body: { error: `Refused: '${intendedSlug}' is a reserved system plugin slug and cannot be uploaded or overwritten.` } };
        }
        try {
            const clash = fs.readdirSync(PLUGINS_DIR).find((d: string) => d !== intendedSlug && d.normalize('NFC').toLowerCase() === canonSlug);
            if (clash) {
                discardZip();
                return { ok: false, status: 409, body: { error: `Refused: name collides with existing plugin '${clash}' (case/Unicode squat).` } };
            }
        } catch { /* PLUGINS_DIR missing — nothing to clobber */ }

        // INTEGRITY: refuse to overwrite a RUNNING plugin's code in place — a botched extract would
        // corrupt a working plugin and the next reload would swap live code with no warning.
        if (await isPluginActive(intendedSlug)) {
            discardZip();
            return { ok: false, status: 409, body: { error: `Plugin '${intendedSlug}' is currently active. Deactivate it before re-uploading (this prevents corrupting a running plugin).` } };
        }

        // INTEGRITY: refuse to install over an EXISTING (even inactive) plugin directory. The extract
        // overwrites in place and, if post-extract validation fails, the catch below rmSync's the whole
        // dir — which would destroy a legitimate same-named plugin's files that were there first (audit
        // LOW). To update a plugin, remove the old one first (uninstall), then install.
        //
        // EXCEPTION — residual runtime data: uninstall preserves plugins/<slug>/data/ (encryption keys,
        // attachments — see removePluginDirPreservingData). A dir containing NOTHING but data/ is not a
        // plugin (no manifest, no code); adopt it and extract around it so reinstall reconnects with the
        // preserved state instead of 409ing.
        let hadResidualData = false;
        if (fs.existsSync(installedDir)) {
            let residualOnly = false;
            try {
                residualOnly = fs.readdirSync(installedDir).every((e: string) => e === 'data');
            } catch { /* unreadable → treat as a real plugin and refuse */ }
            if (!residualOnly) {
                discardZip();
                return { ok: false, status: 409, body: { error: `A plugin directory '${intendedSlug}' already exists. Uninstall it before installing this one (this prevents overwriting or deleting an existing plugin).` } };
            }
            hadResidualData = fs.existsSync(path.join(installedDir, 'data'));
        }

        // Write ONLY the already-validated FILE content entries OURSELVES — never zip.extractEntryTo (audit
        // #29 — adm-zip directory-entry Zip-Slip). extractEntryTo on a DIRECTORY entry re-enumerates that
        // dir's children by RAW startsWith-prefix, which re-introduces junk-filtered '..' entries that never
        // passed the containment scan above (e.g. 'my-plugin/../victim/desktop.ini' → sibling write past
        // installedDir). By skipping directory entries and mkdir'ing each file's parent, every write is
        // confined to the plugin's own dir. Re-assert containment on the FINAL dest (defense-in-depth —
        // identical rule to the pre-scan; unreachable for the entries validated at the loop above).
        for (const entry of contentEntries) {
            if (entry.isDirectory) continue; // dirs are re-created from file paths below; never extract-enumerate them
            const rel = String(entry.entryName).replace(/\\/g, '/');
            const dest = path.resolve(targetDir, rel);
            const isContained = dest === confineDir || dest.startsWith(confineDir + path.sep);
            const hasDotDotSegment = rel.split('/').includes('..');
            if (!isContained || hasDotDotSegment) {
                discardZip();
                return { ok: false, status: 400, body: { error: 'Malicious zip file detected (Zip Slip / path traversal)' } };
            }
            // When adopting residual runtime data, the zip's own data/ payload is ignored ENTIRELY:
            // preserved keys/attachments always win, and a zip that fails validation later can never
            // have mixed its files into the preserved data dir.
            if (hadResidualData) {
                const residualDataDir = path.join(installedDir, 'data');
                if (dest === residualDataDir || dest.startsWith(residualDataDir + path.sep)) continue;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, entry.getData());
        }
        pluginSlug = intendedSlug;

        // VALIDATE what we just extracted BEFORE reporting success: a plugin must have a well-formed
        // manifest, be isolated, use only known permissions, and pass the AST scan. On any failure,
        // remove the extracted dir (installedDir is guaranteed a proper child of PLUGINS_DIR) and 400.
        try {
            const manifestPath = path.join(installedDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) throw new Error('Missing manifest.json — this is not a valid WordJS plugin.');
            const rawManifest = fs.readFileSync(manifestPath, 'utf8');
            if (rawManifest.length > 64 * 1024) throw new Error('manifest.json is implausibly large (>64KB).');
            let manifest: any;
            try { manifest = JSON.parse(rawManifest); } catch { throw new Error('manifest.json is not valid JSON.'); }
            if (!manifest.name) throw new Error('manifest.json is missing a "name".');
            if (manifest.isolated !== true) throw new Error('Plugin must declare "isolated": true (all WordJS plugins run sandboxed).');
            const permProblems = validateManifestPermissions(manifest.permissions);
            if (permProblems.length) throw new Error(`Invalid permissions:\n- ${permProblems.join('\n- ')}`);
            // Static AST scan in DECLARATION mode (the default) — deliberately NOT grant mode. Nothing is
            // granted at install time; this pass is what produces the requested-permission list the admin
            // approves from. The grant-aware pass runs at ACTIVATION (core/plugins.ts), which is where a
            // capability the admin denied must actually block the code.
            validatePluginPermissions(pluginSlug, installedDir, manifest);
        } catch (valErr: any) {
            // Failed validation → undo the extract. If we ADOPTED residual data, restore the residual
            // state (data/ survives, extracted files go); otherwise remove the whole dir as before —
            // a rejected zip must never leave lingering files behind.
            try {
                if (hadResidualData) removePluginDirPreservingData(installedDir);
                else fs.rmSync(installedDir, { recursive: true, force: true });
            } catch { /* best-effort */ }
            discardZip();
            return { ok: false, status: 400, body: { error: valErr.message, details: { missingPermissions: valErr.missingPermissions, dangerousCalls: valErr.dangerousCalls } } };
        }

        // Cleanup temp file
        discardZip();

        return { ok: true, status: 200, body: { success: true, message: 'Plugin installed successfully', slug: pluginSlug } };
    } catch (error: any) {
        // Cleanup temp file on error
        discardZip();
        console.error('[plugins] install failed:', error);
        return { ok: false, status: 500, body: { error: publicErrorText(error, 'Failed to install plugin.') } };
    }
}

// ── One-click in-place UPDATE ────────────────────────────────────────────────────────────────────────
// installPluginFromZip deliberately 409s on an existing/active plugin so a botched extract can never
// corrupt a working install. Updating therefore means running the full cycle AROUND the installer, while
// PRESERVING the plugin's data/ dir and its wjp_<slug>_* tables and REPLAYING the admin's grants — with a
// fail-safe rollback if anything fails, and an origin gate so only the source it was installed from may
// update it. This is the feature previously proposed as PR #258 (held), re-implemented on top of the
// isolate-teardown invariants that landed in #260.

// The stash of the old code lives in OS_TMP_DIR (a project dir backups exclude), not the OS temp — so a
// crash mid-update leaves it where `recoverInterruptedPluginUpdates()` can find it at the next boot.
// Stash dir name: `plugin-update-<slug>-<16 hex>`; slug is a validated single segment, the hex is random.
const STASH_RE = /^plugin-update-([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})-[0-9a-f]{16}$/;

// Single-node mutual exclusion: install / update / uninstall of ONE slug are mutually exclusive within a
// process. (Cross-node exclusion is the dist-lock lease below; it is a no-op on single-host SQLite, so the
// in-process guard is what actually serializes the common single-node case.)
const pluginOpInProgress = new Set<string>();

/** A CodeQL-clean stash path: fixed base (os-tmp) + validated slug + random hex, containment-checked. */
function makeStashDir(slug: string): string {
    fs.mkdirSync(OS_TMP_DIR, { recursive: true });
    const base = path.resolve(OS_TMP_DIR);
    const dir = path.resolve(base, `plugin-update-${slug}-${crypto.randomBytes(8).toString('hex')}`);
    if (dir !== base && !dir.startsWith(base + path.sep)) {
        throw new Error('stash path escaped os-tmp');
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * A manifest declares permissions as {scope, access} objects; grants are "scope:access" tokens (or the
 * literal "network"). Convert one to the other so the update's permission diff compares like with like —
 * the SAME shape used at activation (see the manifest→token maps elsewhere in this file).
 */
function manifestPermTokens(manifest: any): string[] {
    const list = Array.isArray(manifest && manifest.permissions) ? manifest.permissions : [];
    return list
        .map((p: any) => {
            if (p && p.scope) return p.scope === 'network' ? 'network' : `${p.scope}:${p.access || 'read'}`;
            return typeof p === 'string' ? p : null;
        })
        .filter(Boolean) as string[];
}

/** Move every top-level entry of `from` into `to`, replacing any collision. Used to swap code dirs. */
function moveEntriesInto(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
        const dest = path.join(to, entry);
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* nothing there */ }
        fs.renameSync(path.join(from, entry), dest);
    }
}

/**
 * In-place update of an installed plugin from a new zip. `origin` is the catalog provenance that gates
 * the update (must match what the plugin was installed from). Returns the same {ok,status,body} contract
 * as installPluginFromZip. Always consumes `newZipPath`.
 */
async function runPluginUpdate(
    slug: string,
    newZipPath: string,
    origin: { source: string; catalogId: string; version?: any } | null
): Promise<{ ok: boolean; status: number; body: any }> {
    const perms = require('../core/plugin-permissions');
    const core = require('../core/plugins');
    const origins = require('../core/plugin-origins');
    const distLock = require('../core/dist-lock');

    let zipConsumed = false;
    const cleanupZip = () => { if (!zipConsumed) { try { fs.unlinkSync(newZipPath); } catch { /* */ } zipConsumed = true; } };

    // Resolve + validate the slug BEFORE anything (CodeQL-clean; guarantees a proper child of PLUGINS_DIR).
    let installedDir: string;
    try { installedDir = resolveSafePluginDir(slug); }
    catch (e: any) { cleanupZip(); return { ok: false, status: e.status || 400, body: { error: e.message } }; }

    if (!fs.existsSync(path.join(installedDir, 'manifest.json'))) {
        cleanupZip();
        return { ok: false, status: 404, body: { error: `Plugin '${slug}' is not installed.` } };
    }

    // Mutual exclusion (in-process, then cross-node lease).
    if (pluginOpInProgress.has(slug)) {
        cleanupZip();
        return { ok: false, status: 409, body: { error: `Another operation on plugin '${slug}' is already in progress.` } };
    }
    pluginOpInProgress.add(slug);
    const lease = await distLock.acquireBlocking(`wordjs:plugin-op:${slug}`, { ttlMs: 120000, renewMs: 40000, timeoutMs: 3000 });
    if (!lease.held) {
        pluginOpInProgress.delete(slug);
        cleanupZip();
        return { ok: false, status: 409, body: { error: `Plugin '${slug}' is busy on another node — try again shortly.` } };
    }

    const readManifest = (dir: string): any => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
    };
    const oldManifest = readManifest(installedDir);
    const fromVersion = oldManifest && oldManifest.version != null ? String(oldManifest.version) : null;
    const oldPermissions: string[] = manifestPermTokens(oldManifest);

    let stashDir: string | null = null;
    let wasActive = false;
    let grantsSnap: string[] = [];
    let egressSnap: string[] = [];

    const restoreGrants = async () => {
        try { await perms.setGrants(slug, grantsSnap); } catch { /* */ }
        try { await perms.setEgressAllowlist(slug, egressSnap); } catch { /* */ }
    };
    // Put the previous version back exactly: partial new code out (data/ kept), stashed code in, grants
    // restored, reactivated if it had been running. Best-effort — a rollback must never itself throw.
    const rollback = async () => {
        try { removePluginDirPreservingData(installedDir); } catch { /* */ }
        if (stashDir) { try { moveEntriesInto(stashDir, installedDir); fs.rmSync(stashDir, { recursive: true, force: true }); } catch { /* */ } stashDir = null; }
        await restoreGrants();
        if (wasActive) { try { await core.activatePlugin(slug); } catch (e: any) { console.warn('[plugin-update %s] rollback reactivate failed: %s', logSafe(slug), logSafe(e && e.message)); } }
    };

    try {
        // ORIGIN GATE — before any destructive action (no rollback needed if this throws).
        await origins.assertUpdatableFrom(slug, origin);

        // SNAPSHOT the state we must preserve/replay.
        wasActive = await core.isPluginActive(slug);
        grantsSnap = perms.getGrants(slug);
        egressSnap = perms.getEgressAllowlist(slug);

        // 1. Nothing runs while the files move (don't prune deps — the new version reinstalls them).
        if (wasActive) await core.deactivatePlugin(slug, { prune: false });

        // 2. Stash the old CODE aside, keeping plugins/<slug>/data/ (mail keys, DKIM, attachments) so the
        //    installer sees a residual-data-only dir and ADOPTS it.
        stashDir = makeStashDir(slug);
        for (const entry of fs.readdirSync(installedDir)) {
            if (entry === 'data') continue;
            fs.renameSync(path.join(installedDir, entry), path.join(stashDir, entry));
        }

        // 3. Clear the old version's grants/strikes/enqueued assets — KEEP the wjp_<slug>_* tables.
        await core.uninstallPluginData(slug, { dropTables: false });

        // 4. Install the new version (adopts the preserved data/). installPluginFromZip consumes the zip.
        zipConsumed = true;
        // Pin the destination to THIS plugin: the target is otherwise taken from the zip's own root
        // folder, and a mismatch here lands the new code in a different directory while the real one
        // sits stashed and about to be deleted.
        const installRes = await installPluginFromZip(newZipPath, `${slug}.zip`, slug);
        if (!installRes.ok) {
            await rollback();
            return { ok: false, status: installRes.status, body: { ...installRes.body, rolledBack: true, restoredVersion: fromVersion } };
        }

        // 5. Restore grants + egress BEFORE reactivating — they are baked into the isolate at spawn time.
        await restoreGrants();

        // 6. Re-record the origin under the lease (so it can't land on a slug a concurrent op just removed).
        if (origin) { try { await origins.setPluginOrigin(slug, origin); } catch { /* */ } }

        // 7. Reactivate if it was running. activatePlugin can throw AFTER loadIsolatedPlugin registered the
        //    child — that orphan must be torn down BEFORE rolling back, or its hooks/routes/providers stay
        //    wired to a process nobody supervises.
        if (wasActive) {
            try {
                await core.activatePlugin(slug);
            } catch (actErr: any) {
                try { require('../core/plugin-isolate').unloadIsolatedPlugin(slug); } catch { /* */ }
                await rollback();
                return { ok: false, status: 500, body: { error: `Update installed but reactivation failed and was rolled back: ${actErr && actErr.message}`, rolledBack: true, restoredVersion: fromVersion } };
            }
        }

        // Success — the old code is no longer needed.
        if (stashDir) { try { fs.rmSync(stashDir, { recursive: true, force: true }); } catch { /* */ } stashDir = null; }

        const newManifest = readManifest(installedDir);
        const toVersion = newManifest && newManifest.version != null ? String(newManifest.version) : null;
        const newDeclared: string[] = manifestPermTokens(newManifest);
        const oldSet = new Set(oldPermissions);
        const grantedSet = new Set(perms.getGrants(slug));
        // newPermissions = declared by THIS version and NOT by the previous manifest (a real diff, so a
        // permission the admin deliberately refused is not re-reported as "new" on every update).
        const newPermissions = newDeclared.filter((p) => !oldSet.has(p));
        // ungrantedPermissions = declared by this version and still not granted (usable only once approved).
        const ungrantedPermissions = newDeclared.filter((p) => !grantedSet.has(p));

        return {
            ok: true, status: 200,
            body: { success: true, updated: true, slug, fromVersion, toVersion, reactivated: wasActive, newPermissions, ungrantedPermissions },
        };
    } catch (e: any) {
        if (stashDir) { try { await rollback(); } catch { /* */ } }
        cleanupZip();
        console.error("[plugins] update of '%s' failed:", logSafe(slug), e);
        return { ok: false, status: e.status || 500, body: e.body || { error: publicErrorText(e, `Failed to update plugin '${slug}'.`) } };
    } finally {
        try { await lease.release(); } catch { /* */ }
        pluginOpInProgress.delete(slug);
    }
}

/**
 * At boot, reconcile any stash left by an update that was killed mid-flight (between "stash old code" and
 * "install new"). If plugins/<slug>/ has a manifest, the update finished (or the new code is already in
 * place) → discard the stash. If it has NO manifest (only data/), the plugin's only copy of its code is in
 * the stash → restore it. Runs BEFORE loadActivePlugins so a plugin is never loaded from a half-updated dir.
 * Per-slug lease so a replica booting mid-update on a shared plugins dir skips a stash another node owns.
 */
async function recoverInterruptedPluginUpdates(): Promise<void> {
    let names: string[];
    try { names = fs.readdirSync(OS_TMP_DIR); } catch { return; }
    const distLock = require('../core/dist-lock');
    const base = path.resolve(OS_TMP_DIR);
    for (const name of names) {
        const m = STASH_RE.exec(name);
        if (!m) continue;
        const slug = m[1];
        const stashDir = path.resolve(base, name);
        if (stashDir !== base && !stashDir.startsWith(base + path.sep)) continue; // containment
        let installedDir: string;
        try { installedDir = resolveSafePluginDir(slug); } catch { continue; }
        const lease = await distLock.acquireBlocking(`wordjs:plugin-op:${slug}`, { ttlMs: 60000, renewMs: 20000, timeoutMs: 1500 });
        if (!lease.held) { console.warn("[plugin-update] '%s' stash owned by another node — skipping recovery here.", logSafe(slug)); continue; }
        try {
            if (fs.existsSync(path.join(installedDir, 'manifest.json'))) {
                fs.rmSync(stashDir, { recursive: true, force: true });
                console.log("[plugin-update] discarded a completed update's stash for '%s'.", logSafe(slug));
            } else {
                moveEntriesInto(stashDir, installedDir);
                fs.rmSync(stashDir, { recursive: true, force: true });
                console.log("[plugin-update] recovered an interrupted update for '%s' — restored the previous version.", logSafe(slug));
            }
        } catch (e: any) {
            console.warn("[plugin-update] recovery failed for '%s': %s", logSafe(slug), logSafe(e && e.message));
        } finally {
            try { await lease.release(); } catch { /* */ }
        }
    }
}

/**
 * @swagger
 * /plugins/registry:
 *   get:
 *     summary: Get public plugin registry (for frontend)
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: List of active plugins with manifest data
 */
/**
 * @swagger
 * /plugins/assets:
 *   get:
 *     summary: Enqueued frontend assets (scripts/styles) for ACTIVE plugins — public, for the site layout
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: >-
 *           Scripts and styles enqueued by the currently ACTIVE plugins. Every stored entry is re-checked
 *           against the published plugin surface on the way out, so an entry pointing at a path that is no
 *           longer served is omitted rather than emitted as a broken tag. Sent with
 *           Cache-Control public, max-age=60.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [scripts, styles]
 *               properties:
 *                 scripts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       handle:
 *                         type: string
 *                         description: Namespaced as "<slug>:<handle>".
 *                       src:
 *                         type: string
 *                       inFooter:
 *                         type: boolean
 *                       strategy:
 *                         type: string
 *                 styles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       handle:
 *                         type: string
 *                         description: Namespaced as "<slug>:<handle>".
 *                       src:
 *                         type: string
 *                       media:
 *                         type: string
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/assets', asyncHandler(async (req: Request, res: Response) => {
    const { getActiveAssets } = require('../core/plugin-assets');
    res.set('Cache-Control', 'public, max-age=60');
    res.json(await getActiveAssets());
}));

router.get('/registry', asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    const activePlugins = plugins.filter((p: any) => p.active);

    const registry: any[] = [];

    for (const plugin of activePlugins) {
        // A directory name read back from disk is still a segment we did not write — resolve it through
        // the same allowlist + containment proof, and treat "cannot resolve" as "no manifest" (fail closed).
        const manifestPath = pluginFile(plugin.slug, 'manifest.json');

        if (manifestPath && fs.existsSync(manifestPath)) {
            try {
                const manifestContent = fs.readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(manifestContent);
                registry.push({
                    ...manifest,
                    active: true,
                    path: `/plugins/${plugin.slug}`
                });
            } catch (err) {
                console.warn('Failed to read manifest for %s:', logSafe(plugin.slug), err.message);
                // Still include basic info even without manifest
                registry.push({
                    id: plugin.slug,
                    name: plugin.name || plugin.slug,
                    version: plugin.version || '1.0.0',
                    active: true,
                    path: `/plugins/${plugin.slug}`,
                    frontend: null
                });
            }
        } else {
            // Plugin exists but no manifest - include basic info
            registry.push({
                id: plugin.slug,
                name: plugin.name || plugin.slug,
                version: plugin.version || '1.0.0',
                active: true,
                path: `/plugins/${plugin.slug}`,
                frontend: null
            });
        }
    }

    res.json({ plugins: registry });
}));

/**
 * @swagger
 * /plugins/active:
 *   get:
 *     summary: Get list of active plugin slugs
 *     tags: [Plugins]
 *     responses:
 *       200:
 *         description: Array of active plugin slugs
 */
router.get('/active', asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    const activeSlugs = plugins
        .filter((p: any) => p.active)
        .map((p: any) => p.slug);
    res.json(activeSlugs);
}));

/**
 * @swagger
 * /plugins:
 *   get:
 *     summary: List all installed plugins (Admin)
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all plugins
 */
router.get('/', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Await getAllPlugins()
    const plugins = await getAllPlugins();
    // Annotate each with its requested/granted permissions so the admin UI can render the per-permission
    // switches. `requestedPermissions` = what the manifest asks for ("scope:access"), the set of switches
    // to show; `grantedPermissions` = what the admin has granted (+ "network"). No trust tier exists.
    const { getGrants } = require('../core/plugin-permissions');
    // Live runtime health per isolate (running/crashed/crash-looping/restarting + rss/restarts) so the
    // admin sees the TRUE state, not just the persisted 'active' flag which can lie after a crash.
    const { getIsolateStatus } = require('../core/plugin-isolate');
    const { THEMES_DIR } = require('../core/themes');
    res.json(plugins.map((p: any) => {
        const requested = Array.from(new Set((p.permissions || [])
            .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
            .filter(Boolean)));
        // Companion theme (option B): does this plugin bundle a theme/, and is it installed already?
        // lstat (not stat) so a symlinked theme/ reads as "no theme" — install-theme refuses it anyway.
        let hasTheme = false;
        const themeProbe = pluginFile(p.slug, 'theme');
        try { hasTheme = !!themeProbe && fs.lstatSync(themeProbe).isDirectory(); } catch { /* none */ }
        return {
            ...p,
            requestedPermissions: requested,
            grantedPermissions: getGrants(p.slug),
            runtime: p.active ? (getIsolateStatus(p.slug) || null) : null,
            hasTheme,
            themeInstalled: hasTheme && fs.existsSync(path.join(THEMES_DIR, `${p.slug}-theme`)),
        };
    }));
}));

/**
 * @swagger
 * /plugins/{slug}/status:
 *   get:
 *     summary: Live runtime health of an isolated plugin
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: >-
 *           The isolate's live health — the TRUE runtime state, which can disagree with the persisted
 *           "active" flag after a crash. A managed isolate with no health record yet reports only its state.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [state]
 *               properties:
 *                 state:
 *                   type: string
 *                   description: running, crashed, crash-looping or restarting.
 *                 pid:
 *                   type: integer
 *                 startedAt:
 *                   type: integer
 *                   description: Epoch milliseconds.
 *                 uptimeMs:
 *                   type: integer
 *                 restarts:
 *                   type: integer
 *                 lastExitCode:
 *                   type: integer
 *                   nullable: true
 *                 lastError:
 *                   type: string
 *                   nullable: true
 *                 rssBytes:
 *                   type: integer
 *       400:
 *         description: The slug is not a well-formed plugin slug (rejected before any path is built).
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not
 *           reach this resource (rest_token_scope_insufficient).
 *       404:
 *         description: The plugin is not a loaded isolate (never loaded, or not run in isolation).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/status', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid slug' });
    const { getIsolateStatus } = require('../core/plugin-isolate');
    const status = getIsolateStatus(slug);
    if (!status) return res.status(404).json({ error: 'Plugin is not a loaded isolate.' });
    res.json(status);
}));

/**
 * @swagger
 * /plugins/{slug}/activate:
 *   post:
 *     summary: Activate a plugin
 *     tags: [Plugins]
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
 *         description: Plugin activated
 */
router.post('/:slug/activate', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug to prevent path traversal
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Default-deny grants: when an admin activates a plugin (having seen its requested permissions in the
    // activation dialog), grant exactly what its manifest DECLARES — but ONLY if it has no grant record
    // yet, so a later REVOKE via the per-permission switches survives a re-activation. The admin can
    // refine grants anytime in /admin/plugins.
    //
    // Resolve the declared set BEFORE activation (so we can spawn with the grants), but only PERSIST it
    // AFTER activation SUCCEEDS — a plugin that fails its AST scan / test gate must not leave behind a
    // persisted grant record. To make init see the grants, seed them in-memory first, then either
    // persist-on-success or roll back the in-memory seed on failure.
    const { getGrants, setGrants, _setGrantsInMemory } = require('../core/plugin-permissions');
    let seededDeclared: string[] | null = null;
    const hadNoGrants = getGrants(slug).length === 0;
    if (hadNoGrants) {
        try {
            const all = await getAllPlugins();
            const p = all.find((x: any) => x.slug === slug);
            const declared = Array.from(new Set(((p && p.permissions) || [])
                .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
                .filter(Boolean))) as string[];
            if (declared.length) { _setGrantsInMemory(slug, declared); seededDeclared = declared; }
        } catch (e: any) { console.warn("[Permissions] grant-on-activate (seed) for '%s' failed:", logSafe(slug), e && e.message); }
    }

    let result;
    try {
        result = await activatePlugin(slug);
    } catch (e: any) {
        // Activation failed (scan/test/init) — undo the in-memory grant seed so nothing is persisted and
        // a failed-activation plugin holds no grants.
        if (seededDeclared) { try { _setGrantsInMemory(slug, []); } catch { /* */ } }
        // A STRUCTURED validation failure (AST scan) carries a fixable-vs-blocked split. Surface it as a
        // 400 with `details` so the admin UI can show a rejection panel instead of one mangled string.
        if (e && e.code === 'PLUGIN_VALIDATION_FAILED') {
            return res.status(400).json({
                message: e.message,
                details: {
                    missingPermissions: e.missingPermissions || [],
                    dangerousCalls: e.dangerousCalls || [],
                },
            });
        }
        throw e;
    }

    // Activation succeeded — NOW persist the grants we seeded (idempotent; only when it had none before).
    if (seededDeclared && hadNoGrants && getGrants(slug).length > 0) {
        try { await setGrants(slug, seededDeclared); } catch (e: any) { console.warn("[Permissions] grant-on-activate (persist) for '%s' failed:", logSafe(slug), e && e.message); }
    }

    // Trigger frontend registry regeneration
    regenerateRegistry();

    // AUDIT: an admin activated a plugin. Slug only — no secret material.
    await recordAudit(req.user && req.user.id, 'plugin.activate', 'plugin', slug, {});

    res.json(result);
}));

/**
 * @swagger
 * /plugins/{slug}/permissions:
 *   post:
 *     summary: Set the per-permission grants for a plugin (admin) — Android-style, default-deny
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
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
 *               granted:
 *                 type: array
 *                 description: The full granted set, as "scope:access" tokens. Absent or non-array means "grant nothing".
 *                 items:
 *                   type: string
 *               network:
 *                 type: boolean
 *                 description: Truthy adds the "network" grant to the set above.
 *     responses:
 *       200:
 *         description: >-
 *           Grants persisted. A revoke is re-validated against the code on disk immediately: if the plugin
 *           still needs a capability that was just denied it is deactivated (deactivated/deactivationReason);
 *           otherwise a running isolate is re-spawned so the change takes effect now (reloaded). Both the
 *           deactivation and the reload are best-effort — the grant itself is already stored either way.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slug, granted, network, reloaded, deactivated, message]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 slug:
 *                   type: string
 *                 granted:
 *                   type: array
 *                   items:
 *                     type: string
 *                 network:
 *                   type: boolean
 *                 reloaded:
 *                   type: boolean
 *                 deactivated:
 *                   type: boolean
 *                 deactivationReason:
 *                   type: string
 *                   nullable: true
 *                 message:
 *                   type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden); an API token whose scope does not grant
 *           write access here (rest_token_scope_insufficient); or a cookie-authenticated request that failed
 *           the same-origin / double-submit CSRF gate (rest_csrf_invalid, rest_csrf_token).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.post('/:slug/permissions', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const { setGrants, getGrants } = require('../core/plugin-permissions');

    // Body: { granted: ["scope:access", ...], network: boolean }. The admin's granted set is the source
    // of truth (default-deny). We don't constrain to the manifest here — hasPermission already requires
    // BOTH the manifest declaration AND the grant, so granting an undeclared scope simply has no effect.
    const body = req.body || {};
    const tokens: string[] = Array.isArray(body.granted) ? body.granted.map((t: any) => String(t)) : [];
    if (body.network) tokens.push('network');
    await setGrants(slug, tokens);

    // A REVOKE has to take effect NOW, not at the next boot. Some capabilities the AST scan gates have no
    // per-call runtime gate to fall back on — filesystem writes inside the plugin's own directory are the
    // motivating case (audit #3) — so a running isolate whose code needs a capability the admin just
    // denied would keep exercising it until someone restarted the site. Re-run the grant-aware scan
    // against the code on disk; if it no longer passes, deactivate instead of reloading. Fail closed and
    // SAY SO in the response, so the admin sees the consequence of the switch they flipped.
    let deactivated = false;
    let deactivationReason: string | null = null;
    if (await isPluginActive(slug)) {
        try {
            const manifestPath = pluginFile(slug, 'manifest.json');
            if (!manifestPath) throw new Error('unresolvable plugin path');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            validatePluginPermissions(slug, path.dirname(manifestPath), manifest, { mode: 'grant' });
        } catch (valErr: any) {
            if (valErr && valErr.code === 'PLUGIN_VALIDATION_FAILED') {
                deactivationReason = (valErr.missingPermissions || []).join('; ') || valErr.message;
                try { await deactivatePlugin(slug); deactivated = true; }
                catch (e: any) { console.warn("[Permissions] deactivation of '%s' after revoke failed:", logSafe(slug), e && e.message); }
            } else {
                // A read/parse problem is not evidence of a violation — leave the plugin running and log.
                console.warn("[Permissions] post-grant re-validation of '%s' could not run:", logSafe(slug), valErr && valErr.message);
            }
        }
    }

    // Re-spawn the isolate so the NETWORK grant (passed in cfg → __WORDJS_PLUGIN_NETWORK__) takes effect.
    // Bridge-scope grants are read live per call on the host, but reloading keeps everything consistent.
    // Best-effort: the grant is already persisted, so a reload hiccup must not fail the change.
    // Gate on the REASON, not on `deactivated`: if the scan condemned the plugin but the deactivation
    // itself failed, restarting the isolate would put the condemned code straight back to work.
    let reloaded = false;
    if (!deactivationReason) {
        try {
            const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
            if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
        } catch (e: any) {
            console.warn("[Permissions] reload of '%s' after grant change failed:", logSafe(slug), e && e.message);
        }
    }

    const granted = getGrants(slug);
    const tail = deactivationReason
        ? (deactivated
            ? ` Plugin DEACTIVATED — its code requires a capability you denied: ${deactivationReason}`
            : ` Its code requires a capability you denied (${deactivationReason}) and the automatic deactivation FAILED — deactivate it manually.`)
        : (reloaded ? ' Isolate reloaded — changes are in effect.' : ' Reactivate the plugin to fully apply.');
    res.json({
        success: true,
        slug,
        granted,
        network: granted.includes('network'),
        reloaded,
        deactivated,
        deactivationReason,
        message: `Permissions updated for '${slug}' (${granted.length} granted).${tail}`,
    });
}));

/**
 * @swagger
 * /plugins/{slug}/egress-hosts:
 *   parameters:
 *     - in: path
 *       name: slug
 *       required: true
 *       schema:
 *         type: string
 *   get:
 *     summary: Get a plugin's egress allowlist (admin). Only meaningful for a network-granted plugin.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: The stored allowlist, plus whether the plugin actually holds the network grant.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slug, hosts, network]
 *               properties:
 *                 slug:
 *                   type: string
 *                 hosts:
 *                   type: array
 *                   description: Empty means "no allowlist" — every public host is reachable.
 *                   items:
 *                     type: string
 *                 network:
 *                   type: boolean
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not
 *           reach this resource (rest_token_scope_insufficient).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 *   post:
 *     summary: Set a plugin's egress allowlist (admin). Empty = allow all public hosts; non-empty = default-deny except listed hosts + their subdomains.
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hosts:
 *                 type: array
 *                 description: >-
 *                   Hostnames, optionally wildcarded. Entries carrying a scheme, path or port are dropped
 *                   silently. An empty array clears the list (back to allow-all-public). Absent or non-array
 *                   is treated as an empty array.
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: >-
 *           Allowlist stored (hosts echoes back what SURVIVED validation, not what was sent). A running
 *           isolate is re-spawned best-effort so the child re-installs the list; reloaded says whether that
 *           happened.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, slug, hosts, reloaded, message]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 slug:
 *                   type: string
 *                 hosts:
 *                   type: array
 *                   items:
 *                     type: string
 *                 reloaded:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden); an API token whose scope does not grant
 *           write access here (rest_token_scope_insufficient); or a cookie-authenticated request that failed
 *           the same-origin / double-submit CSRF gate (rest_csrf_invalid, rest_csrf_token).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/egress-hosts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const { getEgressAllowlist, getGrants } = require('../core/plugin-permissions');
    res.json({ slug, hosts: getEgressAllowlist(slug), network: getGrants(slug).includes('network') });
}));

router.post('/:slug/egress-hosts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const { setEgressAllowlist, getEgressAllowlist } = require('../core/plugin-permissions');
    // Body: { hosts: ["api.stripe.com", "*.example.com", ...] }. Invalid entries (schemes/paths/ports) are
    // dropped by setEgressAllowlist. An empty array clears the list (back to allow-all-public).
    const body = req.body || {};
    const hosts: string[] = Array.isArray(body.hosts) ? body.hosts.map((h: any) => String(h)) : [];
    await setEgressAllowlist(slug, hosts);

    // Re-spawn the isolate so the child re-installs the new allowlist (pushed in cfg → egress-guard.setAllowedHosts).
    let reloaded = false;
    try {
        const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
        if (isIsolated(slug)) { await reloadIsolatedPlugin(slug); reloaded = true; }
    } catch (e: any) {
        console.warn("[EgressHosts] reload of '%s' after egress change failed:", logSafe(slug), e && e.message);
    }

    const saved = getEgressAllowlist(slug);
    res.json({
        success: true,
        slug,
        hosts: saved,
        reloaded,
        message: saved.length
            ? `Egress allowlist set for '${slug}' (${saved.length} host(s); all other public hosts now denied).${reloaded ? ' Isolate reloaded — in effect.' : ' Reactivate the plugin to apply.'}`
            : `Egress allowlist cleared for '${slug}' (all public hosts allowed again).${reloaded ? ' Isolate reloaded — in effect.' : ''}`,
    });
}));

/**
 * @swagger
 * /plugins/{slug}/reload:
 *   post:
 *     summary: Hot-reload an isolated plugin's child process (e.g. after editing its files)
 *     tags: [Plugins]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Isolate re-spawned (the reload re-runs the full load pipeline, AST scan included)
 *       404:
 *         description: Plugin is not a loaded isolated plugin
 */
router.post('/:slug/reload', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug to prevent path traversal
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    // Reuse the exact same reload the grants route and the dev watcher use: tear the child process
    // down and load it again from its original entry file — the full pipeline (AST scan included)
    // re-runs, so this cannot be used to sidestep the security model.
    const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
    if (!isIsolated(slug)) {
        return res.status(404).json({ error: `Plugin '${slug}' is not a loaded isolated plugin (is it active?)` });
    }
    await reloadIsolatedPlugin(slug);
    res.json({ success: true, slug, message: `Isolate for '${slug}' reloaded.` });
}));

/**
 * @swagger
 * /plugins/{slug}/install-theme:
 *   post:
 *     summary: Install the companion theme a plugin bundles (its top-level theme/ folder)
 *     description: >
 *       Copies plugins/<slug>/theme/ to themes/<slug>-theme, validated like an uploaded theme
 *       (footprint budget, no symlinks, never overwrites). Optionally switches the site to it.
 *       HOST-side and admin-only by design (plugin-completeness program, option B) — the plugin
 *       process gains no new capability and is not involved at all.
 *     tags: [Plugins]
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
 *               activate:
 *                 type: boolean
 *                 description: Switch the active theme to the installed one
 *     responses:
 *       200:
 *         description: Theme installed (and optionally activated)
 *       400:
 *         description: Invalid slug / theme folder failed validation
 *       404:
 *         description: Plugin not found or bundles no theme
 *       409:
 *         description: The companion theme is already installed
 */
router.post('/:slug/install-theme', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Validate ONCE and use what came back — reading req.params.slug again below would be the same
    // "guard a copy, then re-concatenate the raw value" shape this file just finished removing.
    const slug = safeSlugParam(req.params.slug);
    if (!slug) return res.status(400).json({ error: 'Invalid plugin slug' });
    const pluginDir = resolveSafePluginDir(slug);
    if (!fs.existsSync(pluginDir)) {
        return res.status(404).json({ error: `Plugin '${slug}' is not installed` });
    }

    // The bundled theme must be a REAL directory — lstat so a symlinked theme/ (pointing anywhere
    // on the host) is refused, not followed.
    const themeSrc = path.join(pluginDir, 'theme');
    let srcStat: any = null;
    try { srcStat = fs.lstatSync(themeSrc); } catch { /* absent */ }
    if (!srcStat || !srcStat.isDirectory()) {
        return res.status(404).json({ error: `Plugin '${slug}' does not bundle a theme` });
    }

    const { installThemeFromDir, switchTheme } = require('../core/themes');
    const targetSlug = `${slug}-theme`;
    try {
        installThemeFromDir(themeSrc, targetSlug);
    } catch (e: any) {
        if (e && e.code === 'THEME_EXISTS') {
            return res.status(409).json({ error: `Theme "${targetSlug}" is already installed. Delete it in Appearance → Themes to reinstall.` });
        }
        if (e && e.code === 'THEME_INVALID') {
            return res.status(400).json({ error: e.message });
        }
        throw e;
    }

    // Optional one-click switch. Runs AFTER a successful copy; switchTheme re-runs the theme
    // engine init (AST scan + isolated functions.js), same as activating any theme.
    let activated = false;
    if (req.body && req.body.activate === true) {
        await switchTheme(targetSlug);
        activated = true;
    }

    res.json({
        success: true,
        slug: targetSlug,
        activated,
        message: activated
            ? `Theme "${targetSlug}" installed and activated`
            : `Theme "${targetSlug}" installed`
    });
}));

// Ports a plugin declares it needs to bind (manifest `claimPorts: [25]`). Only these are eligible
// for the consensual port-liberation flow below — the endpoints can never act on arbitrary ports.
function getClaimedPorts(slug: string): number[] {
    try {
        const manifestPath = pluginFile(slug, 'manifest.json');
        if (!manifestPath || !fs.existsSync(manifestPath)) return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(manifest.claimPorts)) return [];
        return manifest.claimPorts.filter((p: any) => Number.isInteger(p) && p > 0 && p < 65536);
    } catch {
        return [];
    }
}

/**
 * @swagger
 * /plugins/{slug}/port-conflicts:
 *   get:
 *     summary: Who is squatting the ports this plugin's manifest claims, and can WordJS free them?
 *     tags: [Plugins]
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
 *         description: >-
 *           One verdict per port the manifest claims. Inspection only works on Linux with ss available;
 *           anywhere else the verdict is uninspectable, which callers must NOT read as "free".
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [slug, conflicts]
 *               properties:
 *                 slug:
 *                   type: string
 *                 conflicts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [port, inUse, canFree]
 *                     properties:
 *                       port:
 *                         type: integer
 *                       inUse:
 *                         type: boolean
 *                       canFree:
 *                         type: boolean
 *                         description: Whether POST /plugins/{slug}/free-port could act on this occupant.
 *                       uninspectable:
 *                         type: boolean
 *                         description: The sockets could not be looked at — distinct from a genuinely free port.
 *                       reason:
 *                         type: string
 *                       occupant:
 *                         type: object
 *                         properties:
 *                           process:
 *                             type: string
 *                           pids:
 *                             type: array
 *                             items:
 *                               type: integer
 *                           loopbackOnly:
 *                             type: boolean
 *                           service:
 *                             type: string
 *                           label:
 *                             type: string
 *       400:
 *         description: The slug is not a well-formed plugin slug.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden), or an API token whose scope does not
 *           reach this resource (rest_token_scope_insufficient).
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 */
router.get('/:slug/port-conflicts', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const claimPorts = getClaimedPorts(slug);
    const { detectPortConflict } = require('../core/port-conflicts');
    const conflicts = [];
    for (const port of claimPorts) {
        conflicts.push(await detectPortConflict(port));
    }
    res.json({ slug, conflicts });
}));

/**
 * @swagger
 * /plugins/{slug}/free-port:
 *   post:
 *     summary: Permanently disable the known system MTA holding a manifest-claimed port (admin-confirmed), then reload the plugin so it can bind it
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [port]
 *             properties:
 *               port:
 *                 type: integer
 *                 description: Must be one of the ports this plugin's manifest declares in claimPorts.
 *               allowDisable:
 *                 type: boolean
 *                 description: >-
 *                   The admin's explicit confirmation, travelling WITH the request. Strictly true or the
 *                   core refuses to disable anything (409 CONSENT_REQUIRED), so a stale client snapshot can
 *                   never turn into an unconsented service disable.
 *     responses:
 *       200:
 *         description: >-
 *           The port was freed, or was already free. A running isolate is reloaded afterwards so the
 *           plugin's own bind logic can take the port right away.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, port, reloaded]
 *               properties:
 *                 success:
 *                   type: boolean
 *                 port:
 *                   type: integer
 *                 freed:
 *                   type: boolean
 *                 alreadyFree:
 *                   type: boolean
 *                 service:
 *                   type: string
 *                 label:
 *                   type: string
 *                 reloaded:
 *                   type: boolean
 *       400:
 *         description: >-
 *           The slug is not a well-formed plugin slug, or the port is not an integer this plugin's manifest
 *           declares in claimPorts. This endpoint is a targeted fix for a declared need, never a generic
 *           service-stopping API.
 *       401:
 *         description: >-
 *           Not authenticated: no session cookie and no Bearer credential, an expired/revoked token, or a
 *           token whose owner no longer exists (rest_not_logged_in, rest_token_expired, rest_token_revoked,
 *           rest_token_invalid, rest_user_invalid).
 *       403:
 *         description: >-
 *           Authenticated but not an administrator (rest_forbidden); an API token whose scope does not grant
 *           write access here (rest_token_scope_insufficient); or a cookie-authenticated request that failed
 *           the same-origin / double-submit CSRF gate (rest_csrf_invalid, rest_csrf_token).
 *       409:
 *         description: >-
 *           The port cannot be freed as asked. code is CONSENT_REQUIRED (allowDisable was not sent, and
 *           details.conflict carries a fresh look at the occupant so the client can re-prompt) or
 *           PORT_NOT_FREEABLE (the occupant is not a known, disableable system MTA).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 code:
 *                   type: string
 *                 details:
 *                   type: object
 *       429:
 *         description: Global per-IP API rate limit exceeded.
 *       502:
 *         description: >-
 *           The disable ran but the port did not come free (PORT_STILL_IN_USE), or the disable command
 *           itself failed (DISABLE_FAILED).
 */
router.post('/:slug/free-port', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }
    const port = req.body?.port;
    // The port MUST be one the plugin's manifest claims — this endpoint is a targeted fix for a
    // declared need, not a generic service-stopping API (core/port-conflicts additionally only ever
    // touches its known-MTA allowlist).
    if (!Number.isInteger(port) || !getClaimedPorts(slug).includes(port)) {
        return res.status(400).json({ error: 'Port is not declared in this plugin\'s manifest claimPorts.' });
    }
    const { freeClaimedPort } = require('../core/port-conflicts');
    const { reloadIsolatedPlugin, isIsolated } = require('../core/plugin-isolate');
    try {
        // allowDisable = the admin's explicit modal confirmation travels WITH the request. Without it
        // the core refuses to disable anything (CONSENT_REQUIRED below) — so a stale client snapshot
        // can never turn into an unconsented systemctl disable (TOCTOU).
        const result = await freeClaimedPort(port, { allowDisable: req.body?.allowDisable === true });
        // Reload the (running) plugin so its own bind logic can take the freed port right away.
        let reloaded = false;
        if (isIsolated(slug)) {
            await reloadIsolatedPlugin(slug);
            reloaded = true;
        }
        res.json({ success: true, ...result, reloaded });
    } catch (e: any) {
        // `details` is the one structured field the frontend api() helper preserves on thrown errors —
        // carry the machine-readable code + fresh conflict there so the client can re-prompt consent.
        if (e && e.code === 'CONSENT_REQUIRED') return res.status(409).json({ error: publicErrorText(e, 'Confirmation required before freeing the port.'), code: e.code, details: { code: e.code, conflict: e.conflict } });
        if (e && e.code === 'PORT_NOT_FREEABLE') return res.status(409).json({ error: publicErrorText(e, 'The port could not be freed.'), code: e.code });
        if (e && (e.code === 'PORT_STILL_IN_USE' || e.code === 'DISABLE_FAILED')) return res.status(502).json({ error: publicErrorText(e, 'The port is still in use.'), code: e.code });
        throw e;
    }
}));

/**
 * @swagger
 * /plugins/{slug}/deactivate:
 *   post:
 *     summary: Deactivate a plugin
 *     tags: [Plugins]
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
 *         description: Plugin deactivated
 */
router.post('/:slug/deactivate', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // SECURITY: Validate slug — and use the VALIDATED value below, never req.params.slug again.
    const slug = safeSlugParam(req.params.slug);
    if (!slug) {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    const result = await deactivatePlugin(slug);

    // Trigger frontend registry regeneration
    regenerateRegistry();

    // AUDIT: an admin deactivated a plugin. Slug only — no secret material.
    await recordAudit(req.user && req.user.id, 'plugin.deactivate', 'plugin', slug, {});

    res.json(result);
}));

/**
 * @swagger
 * /plugins/{slug}:
 *   delete:
 *     summary: Delete a plugin
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
 *                 description: Admin password for confirmation
 *     responses:
 *       200:
 *         description: Plugin deleted
 *       403:
 *         description: Invalid password (rest_bad_current_password — the shared sudo re-auth)
 *       429:
 *         description: Too many simultaneous verifications for this account from this address
 */
router.delete('/:slug', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug;
    // Reject a traversal slug (%2f-decoded '../…') BEFORE any fs op — path.join(PLUGINS_DIR, '../../data')
    // would otherwise let an admin confused-deputy rmSync an arbitrary host directory.
    if (!isValidSlug(slug)) {
        return res.status(400).json({ message: 'Invalid plugin slug' });
    }
    const { password, dropData } = req.body;
    const { isPluginActive, deactivatePlugin, PLUGINS_DIR, uninstallPluginData } = require('../core/plugins');

    if (!password) {
        return res.status(400).json({ message: 'Password is required' });
    }

    // 0. Verify the password — through THE shared sudo door (routes/users.ts requireSudoPassword), never
    // through the login lockout.
    //
    // THE INVARIANT THIS BROKE: no mutation that a mere cookie can drive may leave the account in a state
    // its owner cannot undo. This door used to verify against `auth.resolveLockIdentifier(req.user.userLogin)`
    // — the RAW /auth/login bucket, with no purpose prefix — and call `auth.recordLoginFail(lockId)` on
    // every miss. So a hijacked admin session, from a single address and without ever knowing the password,
    // could fire a dozen DELETE /plugins/<any slug> (the password check precedes the existence check, so the
    // slug need not even exist) and arm the OWNER'S login lockout: the owner then gets 429
    // rest_account_locked from /auth/login with the CORRECT password, renewable every 15 minutes, with no
    // recovery action available to them. It was strictly worse than the hostage wave 4 removed, because the
    // door it jammed was the front door.
    //
    // Two separate rules, both restated here so the next reader does not have to rediscover them:
    //   · KEY SPACE — an authenticated purpose gets its OWN bucket, keyed by the numeric session identity.
    //     `requireSudoPassword` keys by `Number(req.user.id)` over module-private maps and the `wjsudo:*`
    //     Redis space, disjoint from `wjlock:*`. Nothing derived from a body, a query or a header enters
    //     the key. NEVER call recordLoginFail/resolveLockIdentifier on `req.user.*` outside routes/auth.ts.
    //   · SHAPE — the refusal is a BOUNDED, escalating delay paid before the check, not a lockout: the
    //     correct password always gets in and clears the counter. A re-authentication gate that refuses the
    //     right credential is the hostage, whoever is holding it.
    const { requireSudoPassword } = require('./users');
    if (await requireSudoPassword(req, res, password)) return;

    // 1. Check if active (Async)
    if (await isPluginActive(slug)) {
        return res.status(400).json({ message: 'Cannot delete an active plugin. Deactivate it first.' });
    }

    // 1b. …then UNCONDITIONALLY stop whatever this slug still owns in the isolate layer.
    //
    // Two distinct leftovers have to go, and the check above sees NEITHER of them:
    //
    //   - a REGISTERED child. `active_plugins` is a stored intention; the isolate registry is the
    //     running truth, and they can disagree — a load that failed after registering its child, or a
    //     cross-node/dev-watcher load of a plugin this node never had listed. In that state the check
    //     above passes and this handler would rmSync the directory of a LIVE process still holding this
    //     plugin's hooks, routes and any claimed provider, leaving them wired to code that no longer
    //     exists on disk. "Deactivate it first" is not an option the admin has either: deactivatePlugin
    //     early-returns 'Plugin not active' for precisely this state, so it can only be cleared here.
    //
    //   - a PENDING SUPERVISED RESTART. When a child crashes, its 'exit' handler removes it from the
    //     isolate registry and schedules a backoff restart (superviseRestart, up to 60s). Throughout
    //     that window nothing is registered while a live timer still holds the slug — and that timer is
    //     cancelled ONLY inside unloadIsolatedPlugin. Skipping the call therefore deleted the directory
    //     and left the timer armed: it fires on a deleted entry file, retries up to 5 times and ends in
    //     a "keeps crashing and was stopped" admin notice for a plugin that no longer exists. Worse, if
    //     the slug is REINSTALLED inside that window the stale timer registers an isolate for the NEW
    //     code that no activation asked for.
    //
    // unloadIsolatedPlugin does both (cancel the timer, tear the child down) and is idempotent, so it
    // is called unconditionally.
    //
    // Then VERIFY, and verify the thing that is actually at stake. Deleting the directory is
    // irreversible, so the precondition has to be "no process of ours is running for this slug" — and
    // the registry cannot answer that: unloadIsolatedPlugin removes the entry SYNCHRONOUSLY while
    // `kill(SIGKILL)` is asynchronous, so an `isIsolated()` re-check goes false the instant we ask it to
    // stop, whether or not the signal has landed. awaitIsolateStopped waits (bounded) for BOTH
    // conditions — nothing registered AND every pid we spawned for this slug observed to exit — so the
    // 409 below means a process really is still alive, not that a Map entry lingered.
    const isolate = require('../core/plugin-isolate');
    if (isolate.isIsolated(slug)) {
        console.warn('[plugin %s] delete: a child process is still registered although the plugin is not listed active (orphaned isolate) — stopping it before removing the directory.', logSafe(slug));
    }
    try { isolate.unloadIsolatedPlugin(slug); }
    catch (e: any) { console.error('[plugin %s] delete: could not stop the isolate / cancel its pending restart: %s', logSafe(slug), logSafe(e && e.message)); }
    //
    // THE WAIT IS BOUNDED, AND THE REFUSAL CAN BE PERMANENT — an accepted trade, new here (main deleted
    // unconditionally). A pid enters the live set at spawn and leaves it in the child's OWN 'exit'
    // handler, so a pid whose exit event never arrives — a host paused/suspended across the child's
    // death, a handler lost to a host-side crash — is never cleared. `livePids` is in-process state, so
    // for that slug awaitIsolateStopped can then never succeed and DELETE answers 409 until the server
    // is restarted. That is why the message below is explicit and names the restart.
    //
    // We take it because the two failure directions are not comparable. Refusing costs a restart and
    // nothing else: the files are still there, and the plugin can be deleted right after. Deleting on a
    // wrong "it's gone" is irreversible and lands on a RUNNING child that still holds this plugin's
    // hooks, routes and any claimed provider — now wired to code that no longer exists on disk. So the
    // check fails SAFE (refuse) rather than open (delete anyway).
    //
    // Bounded, not unbounded, for the same reason: an unbounded wait would hang the admin's request
    // forever in exactly the case that has no resolution, and would still need this 409 to say anything
    // at all — it would only turn a clear refusal into a hang. The escalation is carried by the response
    // instead: it states that nothing was deleted, names the pids we still believe are alive (the same
    // pid an admin can already read from GET /plugins/:slug/status) so they can be checked or killed
    // directly, and gives the restart as the guaranteed way out.
    if (!(await isolate.awaitIsolateStopped(slug, DELETE_STOP_TIMEOUT_MS))) {
        const stuckPids: number[] = (typeof isolate.getLivePids === 'function' && isolate.getLivePids(slug)) || [];
        console.error('[plugin %s] delete REFUSED: a child process was still alive %sms after it was told to stop (pid %s) — the plugin directory was left untouched.', logSafe(slug), logSafe(DELETE_STOP_TIMEOUT_MS), logSafe(stuckPids.join(', ') || 'unknown'));
        return res.status(409).json({
            message: `'${slug}' still has a running process${stuckPids.length ? ` (pid ${stuckPids.join(', ')})` : ''} that did not stop within ${DELETE_STOP_TIMEOUT_MS}ms. Nothing was deleted. End that process, or restart the server, then delete the plugin again.`,
            stillRunning: true,
            pids: stuckPids,
        });
    }

    // 2. Locate directory (resolveSafePluginDir guarantees a proper child of PLUGINS_DIR)
    const pluginPath = resolveSafePluginDir(slug);
    if (!fs.existsSync(pluginPath)) {
        return res.status(404).json({ message: 'Plugin not found' });
    }

    // 3. Delete directory recursively — but PRESERVE the plugin's runtime data/ subdir by default,
    // the same WordPress-parity rule the tables follow below: e.g. mail-server's data/.mailenc AES
    // root key must survive an uninstall→reinstall cycle or every stored mail secret becomes
    // permanently undecryptable. `dropData: true` (the admin explicitly asked) removes it too, and
    // installPluginFromZip ADOPTS the residual data/ dir on reinstall.
    try {
        if (dropData) {
            fs.rmSync(pluginPath, { recursive: true, force: true });
        } else {
            removePluginDirPreservingData(pluginPath);
        }

        // Purge the plugin's persisted footprint. ALWAYS clear grants (else a re-uploaded slug inherits
        // old, possibly-revoked grants) + crash strikes; only DROP the plugin's data tables when the
        // admin explicitly asked (dropData) — WordPress-parity: keep data by default on delete.
        const cleanup = await uninstallPluginData(slug, { dropTables: !!dropData });

        // Drop the origin binding too. Leaving it behind is not cosmetic: the record says "this slug may
        // only be updated from source X", so a slug re-installed later from somewhere else inherits a
        // stale binding and its updates are refused by assertUpdatableFrom — with no UI to clear it.
        // Best-effort: a delete that already removed the files must not fail on bookkeeping.
        try {
            await require('../core/plugin-origins').removePluginOrigin(slug);
        } catch (e: any) {
            console.warn('[plugin-delete %s] could not clear origin binding: %s', logSafe(slug), logSafe(e && e.message));
        }

        // Regenerate registry to remove traces
        regenerateRegistry();

        res.json({ success: true, message: `Plugin ${slug} deleted successfully`, cleanup });
    } catch (err) {
        throw new Error(`Failed to delete plugin: ${err.message}`, { cause: err });
    }
}));

/**
 * @swagger
 * /plugins/{slug}/download:
 *   get:
 *     summary: Download plugin as ZIP
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: token
 *         schema:
 *           type: string
 *         description: Bearer token for download authentication
 *     responses:
 *       200:
 *         description: Plugin ZIP file
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/:slug/download', authenticateAllowQuery, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug;
    // Reject a traversal slug BEFORE building a path — without this, '..%2f..%2f..%2fdata/download'
    // decodes to slug='../../../data' and addLocalFolder zips + streams the DB, JWT secret and .env.
    let pluginPath: string;
    try {
        pluginPath = resolveSafePluginDir(slug);
    } catch {
        return res.status(400).json({ error: 'Invalid plugin slug' });
    }

    if (!fs.existsSync(pluginPath)) {
        return res.status(404).json({ error: 'Plugin not found' });
    }

    // Initialize zip
    const zip = new AdmZip();

    // Add local folder to zip
    // 2nd param defines path in zip - we want it in a folder named {slug}
    zip.addLocalFolder(pluginPath, slug);

    // Create a buffer
    const zipBuffer = zip.toBuffer();

    // Set headers for download
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename=${slug}.zip`);
    res.set('Content-Length', zipBuffer.length);

    res.send(zipBuffer);
}));

/**
 * @swagger
 * /plugins/sample:
 *   post:
 *     summary: Generate a sample plugin
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sample plugin created
 */
router.post('/sample', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    createSamplePlugin();
    res.json({ success: true, message: 'Sample plugin created in /plugins/hello-world' });
}));

/**
 * @swagger
 * /plugins/menus:
 *   get:
 *     summary: Get admin menu items from active plugins
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of menu items
 */
// isAdmin: the admin menu (labels + /admin/* route paths of every active plugin) is control-plane
// metadata — gate it like the rest of this file, not authenticate-only, so a logged-in non-admin
// (e.g. a self-registered subscriber) can't enumerate it or trigger plugin menu filters as itself.
// NOTE: authenticate (NOT isAdmin). This route feeds the sidebar's plugin menu items. Gating it to
// administrators hid EVERY plugin menu item from non-admin admin-panel users (editors, authors,
// subscribers) — so a plugin's per-user UI (e.g. the mail plugin's webmail, whose data routes are
// already scoped per user via findAllByUser / canUserAccess) was unreachable for them. Visibility is
// now per-CAPABILITY: each item is returned only if the caller holds its capability, exactly like the
// frontend's can(item.cap) filter. Items that declare NO capability keep the old admin-only default
// (manage_options), so nothing previously hidden becomes visible unless it opted into a broader cap.
router.get('/menus', authenticate, asyncHandler(async (req: Request, res: Response) => {
    const { getAdminMenuItems } = require('../core/adminMenu');
    const { getActivePlugins } = require('../core/plugins');
    const { applyFiltersSync } = require('../core/hooks');

    const allMenus = getAdminMenuItems();
    // Await async getActivePlugins
    const activePlugins = await getActivePlugins();

    // 1. Filter menus to only include those from active plugins or core
    let activeMenus = allMenus.filter((menu: any) => menu.plugin === 'core' || activePlugins.includes(menu.plugin));

    // 2. Apply filters to allow plugins to hide/modify items per user
    activeMenus = applyFiltersSync('admin_menu_items', activeMenus, { user: req.user });

    // 3. Per-capability visibility. req.user is the host User model (has .can()); unspecified caps
    //    default to manage_options (admin-only) to preserve the prior admin-only behavior.
    const visibleMenus = activeMenus.filter((menu: any) => {
        const requiredCap = menu.cap || menu.capability || 'manage_options';
        return typeof req.user.can === 'function' && req.user.can(requiredCap);
    });

    // 4. Some plugin menu items are only meaningful to a user who owns a PROFESSIONAL mailbox on the
    //    site's mail domain — e.g. a per-user webmail inbox; a user without one has no inbox, so the
    //    page would be an empty shell. A plugin marks those items with `requiresProfessionalMailbox:
    //    true` when it registers them (adminMenu.add), and core hides them from everyone without a
    //    professional mailbox. Administrators ALWAYS keep them. This is slug/href-agnostic, so ANY mail
    //    (or other) plugin gets the behaviour — not just mail-server.
    //
    //    THE FACT IS ADMIN-OWNED, NOT DERIVED. This used to compare the user's own email domain to the
    //    site hostname — a field the user writes themselves via PUT /users/me, so menu visibility (and,
    //    through the identical rule in the mail plugin, the whole mail surface) was self-grantable. It
    //    now reads the SAME `user_meta.professional_mailbox` grant the mail plugin's route gate reads,
    //    via the one helper in core/mailbox.ts: menu visibility and route access cannot disagree, and a
    //    menu entry can no longer appear for a user whose page will only 403.
    const isAdmin = typeof req.user.getRole === 'function' && req.user.getRole() === 'administrator';
    const { hasProfessionalMailbox } = require('../core/mailbox');
    const finalMenus = (isAdmin || hasProfessionalMailbox(req.user))
        ? visibleMenus
        : visibleMenus.filter((m: any) => !m.requiresProfessionalMailbox);

    res.json(finalMenus);
}));

// Mount bundle routes for pre-compiled plugin frontends
const bundleRoutes = require('./plugin-bundles');
router.use('/', bundleRoutes);

module.exports = router;
// Exposed for unit tests of the path-traversal guards (the router remains the default export).
module.exports.isValidSlug = isValidSlug;
module.exports.resolveSafePluginDir = resolveSafePluginDir;
module.exports.safeSlugParam = safeSlugParam;
module.exports.pluginFile = pluginFile;
module.exports.createInstallTmp = createInstallTmp;
module.exports.OS_TMP_DIR = OS_TMP_DIR;
// The shared zip-install pipeline — consumed by routes/marketplace.ts so marketplace installs
// go through the exact same security gauntlet as manual uploads.
module.exports.installPluginFromZip = installPluginFromZip;
// One-click in-place update (marketplace route) + boot-time recovery of an interrupted update (index.ts).
module.exports.runPluginUpdate = runPluginUpdate;
module.exports.recoverInterruptedPluginUpdates = recoverInterruptedPluginUpdates;
