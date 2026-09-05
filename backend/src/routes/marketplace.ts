/**
 * WordJS - Plugin Marketplace Routes
 * /api/v1/marketplace/*
 *
 * Browse a plugin CATALOG and install entries with one click. Plugins are distributed OUTSIDE
 * the core build: the catalog is a `marketplace-index.json` (+ one zip per plugin) produced by
 * `backend/scripts/build-marketplace.js` from the repo's marketplace/plugins/ sources and
 * published as GitHub Release assets.
 *
 * Catalog source resolution (option `marketplace_source`, admin-configurable):
 *   - http(s) URL  → fetched server-side (no CORS problems, sha256-verified downloads)
 *   - local dir    → read from disk (dev / air-gapped installs)
 *   - unset        → repo-local marketplace/dist when present (dev), else the GitHub release URL.
 *
 * Installs download the zip to a temp file and hand it to installPluginFromZip() from
 * routes/plugins.ts — the SAME pipeline as manual uploads (zip-bomb budget, Zip Slip, slug
 * validation, squat refusal, manifest + AST scan), so the marketplace adds no new install surface
 * beyond the catalog fetch itself. Downloaded bytes are sha256-checked against the catalog entry.
 */

import type { Request, Response } from 'express';
// The catalog/zip downloader below drives the native http(s) client directly, so ITS callback
// receives an http.IncomingMessage - not the express Response imported above.
import type { IncomingMessage } from 'http';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const config = require('../config/app');
const egress = require('../core/egress-guard');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
// publicErrorText: un fallo que nadie ha reconocido (DNS, TLS, socket, driver) se registra entero
// y al cliente le llega la operación que falló, no el texto del componente que la rompió.
const { asyncHandler, publicErrorText } = require('../middleware/errorHandler');
const { getOption, updateOption, deleteOption } = require('../core/options');
const { getAllPlugins } = require('../core/plugins');
const { installPluginFromZip, runPluginUpdate, createInstallTmp } = require('./plugins');
const pluginOrigins = require('../core/plugin-origins');
const { recordAudit } = require('../core/audit');

// THE SCALAR QUERY RULE — see core/query-params.
const { requireScalarQuery } = require('../core/query-params');

/**
 * The one parameter the two catalog routes read. `String(req.query.refresh || '') === '1'` looks
 * defended and is not: String() only stops the TypeError. `?refresh=1&refresh=1` is ['1','1'], which
 * String() joins into '1,1', which is not '1' — so the admin who asked to bypass the cache was
 * served the CACHED index, with a 200 and no indication. That is a stale plugin/theme catalog for
 * anyone who can get an extra `refresh=` appended to the URL, which is the shape this rule exists to
 * refuse rather than resolve.
 */
const CATALOG_QUERY_FIELDS: readonly string[] = Object.freeze(['refresh']);

const INDEX_FILE = 'marketplace-index.json';
// The THEME catalog rides the SAME sources (an origin hosts both index files side by side).
const THEMES_INDEX_FILE = 'marketplace-themes-index.json';
// The catalog is published as GitHub RELEASE ASSETS (marketplace-index.json + one zip per plugin,
// attached by .github/workflows/release.yml — build:marketplace runs there). `releases/latest/download/`
// always resolves to the newest release, so a site tracks the latest published catalog by default.
// Pin a specific catalog by setting the marketplace_source option to a fixed release, e.g.
// https://github.com/jaimemartinez/wordjs/releases/download/v1.6.1  (or any https catalog / local dir).
// NOTE: this must match where release.yml actually uploads the assets — a raw.githubusercontent.com
// /main/marketplace/dist URL 404s because marketplace/dist is a build output and is NOT committed.
const DEFAULT_REMOTE = 'https://github.com/jaimemartinez/wordjs/releases/latest/download';
// Repo-local dist (present in dev checkouts / self-hosted full clones).
const LOCAL_DIST = path.resolve(__dirname, '../../../marketplace/dist');
const MAX_ZIP_BYTES = 10 * 1024 * 1024; // mirror the upload route's multer cap
const CACHE_TTL_MS = 5 * 60 * 1000;

// Catalog entry filenames are produced by our own build script; enforce that shape strictly so a
// hostile/compromised catalog cannot point installs at arbitrary paths (local mode) or smuggle
// separators. The slug segment mirrors routes/plugins.ts isValidSlug.
const SAFE_FILE_RE = /^[A-Za-z0-9_-]+-[A-Za-z0-9][A-Za-z0-9.-]*\.zip$/;

const MAX_SOURCES = 12;

/**
 * Read the admin-configured marketplace source list (option `marketplace_sources`, a JSON array).
 * Returns null when the option was never configured (→ the fallback chain applies). An array —
 * INCLUDING the explicit empty list — is an admin decision and is honored verbatim: [] means
 * "no sources at all" (remote marketplace disabled).
 */
async function readConfiguredSources(): Promise<string[] | null> {
    const raw = await getOption('marketplace_sources', null);
    let list: any[] | null = null;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim()) { try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* ignore */ } }
    if (list === null) return null;
    return list.map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * Resolve the ORDERED list of catalog sources to browse/install from. Precedence:
 *   1. The admin-configured list (option `marketplace_sources`, managed from the Marketplace UI — no
 *      hard-coded URL; the admin points WordJS at any number of catalogs, official or private,
 *      or NONE: an explicitly saved empty list disables the remote marketplace entirely).
 *   2. The legacy single option `marketplace_source` (back-compat).
 *   3. The repo-local dist (dev / full checkout).
 *   4. The built-in default (GitHub release assets) — a starting point, fully overridable.
 * A source is https (fetched) or a local dir (read); the UI only ever writes https URLs.
 */
async function resolveSources(): Promise<{ url: string; isLocal: boolean }[]> {
    const configured = await readConfiguredSources();
    if (configured !== null) {
        return configured.slice(0, MAX_SOURCES).map((url) => ({ url, isLocal: !/^https?:\/\//i.test(url) }));
    }
    const single = String((await getOption('marketplace_source', '')) || '').trim().replace(/\/+$/, '');
    if (single) return [{ url: single, isLocal: !/^https?:\/\//i.test(single) }];
    if (fs.existsSync(path.join(LOCAL_DIST, INDEX_FILE))) return [{ url: LOCAL_DIST, isLocal: true }];
    return [{ url: DEFAULT_REMOTE, isLocal: false }];
}

// The official catalog's own release path, derived from DEFAULT_REMOTE so the two cannot drift: any
// release of THIS repository counts, because pinning a fixed release
// (https://github.com/<owner>/wordjs/releases/download/v1.6.1) is a documented, supported configuration
// and must not cost the entry its badge.
const OFFICIAL_RELEASES_PREFIX = (() => {
    try {
        const u = new URL(DEFAULT_REMOTE);
        // /<owner>/<repo>/releases/...  →  /<owner>/<repo>/releases/
        const parts = u.pathname.split('/').filter(Boolean);
        return `${u.protocol}//${u.host.toLowerCase()}/${parts.slice(0, 3).join('/')}/`;
    } catch {
        return '';
    }
})();

/**
 * Is this source the one the review badge is actually a statement about?
 *
 * WHY THIS EXISTS. `review` arrives INSIDE a catalog index, and every configured source is merged and
 * passed to the admin UI verbatim. `marketplace/reviews.json`, `verify-marketplace.js` and the whole of
 * REVIEW.md only ever cover THIS project's catalog — nothing anywhere validates a review claim made by
 * a private, third-party or compromised index. So an arbitrary URL could hand the admin an entry
 * carrying `review: {status:"reviewed", reviewer:"…", date:"…"}`, rendered as the affirmative badge on
 * the highest-privilege screen in the product, directly above an Install button, backed by no ledger
 * anywhere on earth. `first-party` is the same problem wearing the project's own name.
 *
 * An admin pointing WordJS at another catalog is a supported, deliberate feature (resolveSources) and
 * that does not change: the entries are still listed and still installable. What they cannot do is
 * borrow OUR claim about them. Everything from a non-official source is republished as `unreviewed`,
 * which is the truth — nobody the badge speaks for has looked at it.
 *
 * A LOCAL directory counts as official only when it is this checkout's own marketplace/dist, which is
 * built from the tracked sources and the tracked ledger by build-marketplace.js and gated by
 * verify-marketplace.js in CI. Any other directory on disk is somebody else's index.
 */
function isOfficialSource(url: string, isLocal: boolean): boolean {
    const raw = String(url || '').trim();
    if (!raw) return false;
    if (isLocal) {
        try {
            return path.resolve(raw) === path.resolve(LOCAL_DIST);
        } catch {
            return false;
        }
    }
    try {
        const u = new URL(raw);
        if (u.protocol !== 'https:') return false;
        const normalized = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
        return !!OFFICIAL_RELEASES_PREFIX && `${normalized}/`.startsWith(OFFICIAL_RELEASES_PREFIX);
    } catch {
        return false;
    }
}

const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

/**
 * Validate a marketplace source URL. The fetch runs from the HOST process (NOT a sandboxed plugin), and
 * Node's global fetch() bypasses the egress-guard's module hooks — so this sink must guard SSRF itself
 * (SEC: an admin-set source pointing at an internal/loopback/metadata target was a host-side SSRF, incl.
 * a blind port-scan oracle via the catalog error body). Only https is accepted in production; http on
 * localhost is a DEV-ONLY convenience — in production an internal/loopback target is exactly the SSRF we
 * refuse. Returns whether the URL is the explicit dev-loopback exception (which then skips the
 * internal-target guard, mirroring core/webhooks.ts' allowPrivateTargets test seam).
 */
function assertSaneRemote(url: string): { devLoopback: boolean } {
    let u: any;
    try { u = new URL(url); } catch { throw new Error('URL de marketplace inválida.'); }
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    const devLoopback = u.protocol === 'http:' && isLoopback && config.nodeEnv !== 'production';
    if (u.protocol !== 'https:' && !devLoopback) {
        throw new Error('La fuente del marketplace debe ser https:// (o http://localhost en desarrollo).');
    }
    return { devLoopback };
}

/**
 * SSRF-safe host-side download. Mirrors core/webhooks.ts: assertUrlAllowed rejects internal/private/
 * metadata targets (IP-literal AND hostnames that resolve to one, fail-closed), and validatingLookup
 * pins the resolved IP so a hostname cannot rebind to an internal address between the check and the
 * connect. Redirects are followed MANUALLY, re-running the FULL guard on every hop, so a public https
 * source cannot 302 to 169.254.169.254 / a loopback host — while the default GitHub release URL, which
 * legitimately redirects to the asset host, still works. Uses the native http/https client (not global
 * fetch, whose undici socket layer is invisible to the egress guard).
 */
async function fetchRemote(url: string, maxBytes: number, _hops = 0): Promise<Buffer> {
    const { devLoopback } = assertSaneRemote(url);
    const u = new URL(url);
    if (!devLoopback) await egress.assertUrlAllowed(u.href); // throws on an internal/blocked target
    const lib = u.protocol === 'https:' ? https : http;
    return await new Promise<Buffer>((resolve, reject) => {
        const opts: any = {
            method: 'GET',
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: (u.pathname || '/') + (u.search || ''),
            timeout: FETCH_TIMEOUT_MS,
            headers: { 'user-agent': 'WordJS-Marketplace' },
        };
        if (!devLoopback) opts.lookup = egress.validatingLookup; // pin the validated IP (no DNS rebinding)
        const req = lib.request(opts, (res: IncomingMessage) => {
            const status = res.statusCode || 0;
            // Follow redirects MANUALLY so the next hop is re-validated BEFORE we connect to it.
            if (status >= 300 && status < 400 && res.headers.location) {
                res.destroy();
                if (_hops >= MAX_REDIRECTS) return reject(new Error('Demasiadas redirecciones.'));
                let next: string;
                try { next = new URL(res.headers.location, u).href; } catch { return reject(new Error('Redirección inválida.')); }
                resolve(fetchRemote(next, maxBytes, _hops + 1));
                return;
            }
            if (status < 200 || status >= 300) { res.destroy(); return reject(new Error(`HTTP ${status} al descargar ${u.pathname}`)); }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (c: Buffer) => {
                total += c.length;
                if (total > maxBytes) { res.destroy(); reject(new Error('El archivo descargado excede el tamaño máximo permitido.')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Tiempo de espera de descarga agotado.')));
        req.end();
    });
}

async function loadCatalog(source: string, isLocal: boolean, indexFile: string = INDEX_FILE): Promise<any[]> {
    let raw: string;
    if (isLocal) {
        const idxPath = path.join(path.resolve(source), indexFile);
        if (!fs.existsSync(idxPath)) throw new Error(`No se encontró ${indexFile} en ${source}. Ejecuta "npm run build:marketplace".`);
        raw = fs.readFileSync(idxPath, 'utf8');
    } else {
        raw = (await fetchRemote(`${source}/${indexFile}`, 2 * 1024 * 1024)).toString('utf8');
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.plugins || parsed.themes);
    if (!Array.isArray(list)) throw new Error('El índice del marketplace tiene un formato inválido.');
    return list;
}

/**
 * Cache identity for an ordered source set.
 *
 * A REMOTE source is identified by its URL alone — the TTL below is what protects the network, which
 * is the whole point of this cache. A LOCAL source is a directory on THIS disk: re-reading its index
 * costs a single file read, and serving a five-minute-old copy of it is actively harmful. After
 * `npm run build:marketplace` the zips are rewritten with the theme's current version, so a stale
 * catalog advertises a filename that no longer exists. The failure that produces is genuinely hard to
 * read, because it surfaces three steps away from its cause:
 *
 *     install → 404 "No existe theme-<slug>-<OLD version>.zip en el marketplace local."
 *     …so the theme never lands in themes/…
 *     activate → 500 "Theme <slug> not found"
 *
 * and the last message is the one the admin sees, pointing at activation rather than at a stale
 * index. So stamp local sources with their index file's mtime+size: any rebuild changes the key and
 * the next browse reads fresh, while remote sources keep exactly the behaviour they had.
 */
function sourcesCacheKey(srcs: { url: string; isLocal: boolean }[], indexFile: string): string {
    return srcs.map((s) => {
        if (!s.isLocal) return s.url;
        try {
            const st = fs.statSync(path.join(path.resolve(s.url), indexFile));
            return `${s.url}#${st.mtimeMs}:${st.size}`;
        } catch {
            return `${s.url}#missing`;
        }
    }).join('|');
}

// In-memory catalog cache (keyed by the ordered source set) so browsing doesn't re-hammer the network.
let catalogCache: { key: string; at: number; merged: any[]; sources: any[] } | null = null;

async function getCatalog(refresh = false): Promise<{ merged: any[]; sources: any[] }> {
    const srcs = await resolveSources();
    const key = sourcesCacheKey(srcs, INDEX_FILE);
    if (!refresh && catalogCache && catalogCache.key === key && Date.now() - catalogCache.at < CACHE_TTL_MS) {
        return { merged: catalogCache.merged, sources: catalogCache.sources };
    }
    // Fetch EVERY source and merge. Dedup by id — earlier sources win (list order = priority). A source
    // that fails is reported (ok:false) but never fails the whole catalog, so one bad URL can't hide the rest.
    const seen = new Set<string>();
    const merged: any[] = [];
    const sources: any[] = [];
    for (const s of srcs) {
        try {
            const list = await loadCatalog(s.url, s.isLocal);
            const official = isOfficialSource(s.url, s.isLocal);
            let added = 0;
            for (const e of list) {
                const id = String(e.id || '');
                if (!id || seen.has(id)) continue;
                seen.add(id);
                // Each entry remembers its source (used at install) and whether that source is the one
                // the review programme actually speaks for. A `review` from anywhere else is REPLACED,
                // not passed through: the badge is a claim by this project about this project's catalog,
                // and no other index gets to make it on our behalf. See isOfficialSource.
                merged.push({
                    ...e,
                    source: s.url,
                    official,
                    review: official ? e.review : { status: 'unreviewed' },
                });
                added++;
            }
            sources.push({ url: s.url, isLocal: s.isLocal, ok: true, count: list.length, added });
        } catch (e: any) {
            sources.push({ url: s.url, isLocal: s.isLocal, ok: false, error: e && e.message });
        }
    }
    catalogCache = { key, at: Date.now(), merged, sources };
    return { merged, sources };
}

/**
 * @swagger
 * /marketplace/catalog:
 *   get:
 *     summary: Browse the plugin marketplace catalog (annotated with installed/active state)
 *     description: Every configured source is read and merged, deduplicated by entry id with earlier sources winning. A source that cannot be read is reported inside sources with ok false rather than failing the whole browse, so one bad URL cannot hide the rest. Each entry is annotated against this install - present, active, the installed version, whether a newer version is listed, and whether that update can be applied in one click, which additionally requires the catalog entry's source to match the source the plugin was installed from. The merge is cached for five minutes; refresh=1 bypasses the cache.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: refresh
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['1']
 *         description: Send 1 to re-read every source instead of serving the cached merge. It is a scalar - repeating it is refused with 400, never resolved to one of the values.
 *     responses:
 *       200:
 *         description: The merged catalog, annotated with this install's state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 source:
 *                   type: string
 *                   description: The first source's URL, kept for backwards compatibility with clients written before the list existed.
 *                 isLocal:
 *                   type: boolean
 *                 sources:
 *                   type: array
 *                   description: Per-source status. A source that failed carries ok false and its error instead of a count.
 *                   items:
 *                     type: object
 *                     properties:
 *                       url:
 *                         type: string
 *                       isLocal:
 *                         type: boolean
 *                       ok:
 *                         type: boolean
 *                       count:
 *                         type: integer
 *                       added:
 *                         type: integer
 *                       error:
 *                         type: string
 *                 count:
 *                   type: integer
 *                 plugins:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       version:
 *                         type: string
 *                       source:
 *                         type: string
 *                       official:
 *                         type: boolean
 *                         description: True when the entry came from this project's own release catalog, or from this checkout's marketplace/dist. The review programme covers only that catalog, so an entry from any other source is republished with review.status unreviewed whatever its own index claimed.
 *                       installed:
 *                         type: boolean
 *                       active:
 *                         type: boolean
 *                       installedVersion:
 *                         type: string
 *                         nullable: true
 *                       updateAvailable:
 *                         type: boolean
 *                       updatable:
 *                         type: boolean
 *                         description: True only when an update exists AND the catalog entry's source matches the recorded install origin. An update listed but not updatable is shown without the button.
 *                       installedFrom:
 *                         type: string
 *                         nullable: true
 *       400:
 *         description: A scalar query parameter arrived more than once or as a non-string (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       502:
 *         description: The catalog could not be read at all, so there is nothing to annotate
 */
router.get('/catalog', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // OUTSIDE the try on purpose: the catch below turns anything thrown in here into a 502 about the
    // catalog being unreadable, which is not what happened and not what the caller should fix.
    requireScalarQuery(req.query, CATALOG_QUERY_FIELDS);

    try {
        const refresh = String(req.query.refresh || '') === '1';
        const { merged, sources } = await getCatalog(refresh);
        const installed = await getAllPlugins();
        const bySlug = new Map<string, any>(installed.map((p: any) => [String(p.slug || p.id), p]));
        const origins = await pluginOrigins.getAllOrigins();
        const annotated = merged.map((e: any) => {
            const local = bySlug.get(String(e.id));
            const recorded = origins[String(e.id)] || null;
            const updateAvailable = !!(local && local.version && e.version && String(local.version) !== String(e.version));
            // `updatable` = an update can actually be applied in one click: installed, a newer version, AND
            // this catalog entry's source MATCHES the source it was installed from. A plugin installed by
            // upload or from another source shows the update but not the button (the UI explains why).
            const updatable = !!(updateAvailable && recorded && recorded.source &&
                pluginOrigins.normSource(recorded.source) === pluginOrigins.normSource(e.source));
            return {
                ...e,
                installed: !!local,
                active: !!(local && local.active),
                installedVersion: local ? local.version || null : null,
                updateAvailable,
                updatable,
                installedFrom: recorded ? recorded.source : null,
            };
        });
        // `source`/`isLocal` are kept for back-compat (the primary source); `sources` carries per-source status.
        const first = sources[0] || {};
        res.json({ source: first.url || '', isLocal: !!first.isLocal, sources, count: annotated.length, plugins: annotated });
    } catch (e: any) {
        console.error('[marketplace] plugin catalog read failed:', e);
        res.status(502).json({ error: publicErrorText(e, 'No se pudo leer el catálogo de plugins.') });
    }
}));

/**
 * @swagger
 * /marketplace/install:
 *   post:
 *     summary: Download a catalog plugin and install it through the standard upload pipeline
 *     description: The bytes are fetched from the source the entry was listed under, or read from a local dist directory after the resolved path is proven to stay inside it, and then sha256-verified against the catalog entry. A remote entry that carries no sha256 is refused outright rather than installed unverified. The verified zip is handed to the same pipeline manual uploads use, so the zip-bomb budget, the Zip Slip refusal, slug validation and the manifest plus AST scan all apply unchanged. When the plugin is already installed the request takes the in-place update path instead, exactly as /marketplace/update. Every attempt is written to the audit log, successes and failures alike.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id:
 *                 type: string
 *                 description: The catalog entry id.
 *     responses:
 *       200:
 *         description: The pipeline result. The status is the one the install or update pipeline returns, so a refusal inside the pipeline surfaces with its own status and body.
 *       400:
 *         description: Missing id, a catalog entry naming an unsafe file or a path outside the local marketplace directory, a package over the size ceiling, a remote entry with no sha256, or a sha256 mismatch - the package is never installed unverified
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: No such id in the catalog, or the local package file is missing
 *       502:
 *         description: The catalog could not be read, or the package could not be downloaded
 */
// Install a catalog entry — or, when the plugin is already installed, UPDATE it in place (preserving its
// data/, tables and grants; see routes/plugins.ts runPluginUpdate). Mounted on BOTH /install and /update
// so any client works; the origin gate inside runPluginUpdate makes an update refuse a foreign source.
/**
 * The audit `detail` for one marketplace apply.
 *
 * INSTALLING A PLUGIN IS EXECUTING SOMEBODY ELSE'S CODE ON THIS SERVER, so what the log needs is not
 * merely "a plugin arrived" but WHERE FROM: the source the catalogue entry was listed under, its
 * version, and whether the bytes carried an integrity hash at all (a remote entry without one is
 * refused above — recording the flag is what makes that refusal auditable rather than assumed). The
 * hash itself is not stored: `sha256` matches the audit sanitizer's secret-key filter and would be
 * dropped anyway, and source + version already identify the artifact.
 *
 * FAILURES ARE RECORDED TOO, via `ok:false`. A rejected install is the interesting half of an intrusion
 * attempt, and a log that only holds successes cannot tell "nobody tried" from "everybody failed".
 *
 * Only the DETAIL is built here, never the action name: the two recordAudit calls keep their action as
 * a literal so the catalogue gate in src/tests/audit-trail.test.ts can still read it out of the source.
 */
function applyAuditDetail(entry: any, result: any): Record<string, any> {
    return {
        source: String((entry && entry.source) || '').slice(0, 200),
        version: entry && entry.version != null ? String(entry.version).slice(0, 64) : null,
        integrityVerified: !!(entry && entry.sha256),
        ok: !!(result && result.ok),
        status: result && result.status != null ? Number(result.status) : null
    };
}

const handleMarketplaceApply = asyncHandler(async (req: Request, res: Response) => {
    const id = String((req.body || {}).id || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta el id del plugin.' });

    let entry: any;
    try {
        const { merged } = await getCatalog(false);
        entry = merged.find((e: any) => String(e.id) === id);
    } catch (e: any) {
        console.error('[marketplace] plugin catalog read failed:', e);
        return res.status(502).json({ error: publicErrorText(e, 'No se pudo leer el catálogo de plugins.') });
    }
    if (!entry) return res.status(404).json({ error: `El plugin "${id}" no está en el catálogo.` });

    // Install from the SAME source the entry was listed under (each merged entry carries its source).
    const source = String(entry.source || '');
    const isLocal = !/^https?:\/\//i.test(source);

    const file = String(entry.file || '');
    if (!SAFE_FILE_RE.test(file)) {
        return res.status(400).json({ error: 'El catálogo contiene un nombre de archivo inválido.' });
    }

    // Fetch the zip bytes (remote) or read them from the dist dir (local), then sha256-verify.
    let buf: Buffer;
    try {
        if (isLocal) {
            const base = path.resolve(source);
            const zipAbs = path.resolve(base, file);
            if (!(zipAbs === base || zipAbs.startsWith(base + path.sep))) {
                return res.status(400).json({ error: 'Ruta de archivo fuera del directorio del marketplace.' });
            }
            if (!fs.existsSync(zipAbs)) return res.status(404).json({ error: `No existe ${file} en el marketplace local.` });
            const size = fs.statSync(zipAbs).size;
            if (size > MAX_ZIP_BYTES) return res.status(400).json({ error: 'El paquete excede el tamaño máximo permitido.' });
            buf = fs.readFileSync(zipAbs);
        } else {
            buf = await fetchRemote(`${source}/${file}`, MAX_ZIP_BYTES);
        }
    } catch (e: any) {
        console.error('[marketplace] plugin download failed:', e);
        return res.status(502).json({ error: publicErrorText(e, 'No se pudo descargar el plugin del catálogo.') });
    }

    // Integrity is MANDATORY for a REMOTE source: a plugin installs+runs arbitrary server-side code, so a
    // third-party/compromised catalog that simply OMITS `sha256` must NOT yield an unverified install. Every
    // official catalog entry ships a sha256 (verified in the generated index), so this is fail-closed with no
    // regression. Local-dir sources are exempt: the bytes are read from an admin-controlled path already
    // confined to the marketplace dir above.
    if (!isLocal && !entry.sha256) {
        return res.status(400).json({ error: 'El paquete remoto no incluye un hash de integridad (sha256) — instalación abortada.' });
    }
    if (entry.sha256) {
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        if (digest !== String(entry.sha256).toLowerCase()) {
            return res.status(400).json({ error: 'La verificación de integridad (sha256) del paquete falló — instalación abortada.' });
        }
    }

    // Hand off to the shared upload pipeline via a temp file (the pipeline owns cleanup of the FILE; we
    // own the directory around it).
    //
    // This used to be `path.join(os.tmpdir(), 'wjs-mkt-<random>.zip')` + a plain writeFileSync. A random
    // NAME is not the property that matters here: os.tmpdir() is world-writable and shared, writeFileSync
    // follows a symlink that is already at the path, and the file lands with the process umask — so the
    // bytes of a plugin that is about to be executed server-side were both readable by any local user and
    // redirectable by one who won the name. createInstallTmp() takes a kernel-exclusive 0700 directory
    // (mkdtemp) inside the app's own os-tmp instead, and the write below is an EXCLUSIVE create at 0600.
    // Landing it in os-tmp is also what lets installPluginFromZip PROVE containment on what it deletes.
    const slug = String(entry.id);
    const installedNow = (await getAllPlugins()).some((p: any) => String(p.slug || p.id) === slug);
    const origin = { source: String(entry.source || ''), catalogId: slug, version: entry.version != null ? String(entry.version) : null };
    const tmp = createInstallTmp();
    try {
        // wx = create-exclusive: fails outright rather than writing through anything that already exists.
        fs.writeFileSync(tmp.zipPath, buf, { mode: 0o600, flag: 'wx' });

        if (installedNow) {
            // In-place update (preserves data/tables/grants, gated to the install origin, fail-safe rollback).
            const result = await runPluginUpdate(slug, tmp.zipPath, origin);
            await recordAudit(req.user && req.user.id, 'marketplace.update', 'plugin', slug, applyAuditDetail(entry, result));
            return res.status(result.status).json(result.body);
        }
        // Fresh install — then record where it came from so future updates are bound to this source.
        const result = await installPluginFromZip(tmp.zipPath, file);
        if (result.ok) { try { await pluginOrigins.setPluginOrigin(slug, origin); } catch { /* non-fatal */ } }
        await recordAudit(req.user && req.user.id, 'marketplace.install', 'plugin', slug, applyAuditDetail(entry, result));
        return res.status(result.status).json(result.body);
    } finally {
        // ALWAYS — including the throw paths inside the pipeline. The zip is already gone by then; this
        // removes the scratch directory so os-tmp cannot accumulate one empty dir per install attempt.
        tmp.dispose();
    }
});
router.post('/install', authenticate, isAdmin, handleMarketplaceApply);
/**
 * @swagger
 * /marketplace/update:
 *   post:
 *     summary: Update an installed catalog plugin in place
 *     description: The same handler as /marketplace/install. When the plugin is already installed the bytes go through the in-place update path, which preserves its data directory, tables and grants and refuses an update whose catalog source differs from the source the plugin was installed from. Integrity is mandatory for a remote source - an entry without a sha256, or one whose bytes do not match it, is refused. Every attempt is written to the audit log, successes and failures alike.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id:
 *                 type: string
 *                 description: The catalog entry id.
 *     responses:
 *       200:
 *         description: The pipeline result. The status is the one the install or update pipeline returns, so a refusal inside the pipeline surfaces with its own status and body.
 *       400:
 *         description: Missing id, a catalog entry naming an unsafe file, a package over the size ceiling, a remote entry with no sha256, or a sha256 mismatch - the package is never installed unverified
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: No such id in the catalog, or the local package file is missing
 *       502:
 *         description: The catalog could not be read, or the package could not be downloaded
 */
router.post('/update', authenticate, isAdmin, handleMarketplaceApply);

/**
 * @swagger
 * /marketplace/sources:
 *   get:
 *     summary: Get the admin-configured plugin marketplace source URLs (+ the built-in default)
 *     description: Independent from the theme source list. usingDefault is true only when nothing has ever been configured, in which case the resolver falls back to the legacy single-source option, then to the repo-local dist when it carries a plugin index, and finally to the built-in default. An explicitly saved empty list is a configuration, not a default.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The configured sources, the built-in default and whether the default is in use
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured:
 *                   type: array
 *                   items:
 *                     type: string
 *                 default:
 *                   type: string
 *                 usingDefault:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *   put:
 *     summary: Replace the plugin marketplace source URLs (admin)
 *     description: Each entry must be https, or http on localhost outside production. A local directory is deliberately not settable here - that would point the server's catalog reader at an arbitrary path. Blank entries and duplicates are dropped and the list is truncated to the source ceiling. An explicitly saved empty list means no sources at all; send reset true instead to forget the list and go back to the fallback chain. Either way the merged catalog cache is dropped so the next browse re-reads.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sources:
 *                 type: array
 *                 items:
 *                   type: string
 *               reset:
 *                 type: boolean
 *                 description: When true the configured list is deleted and the fallback chain applies again.
 *     responses:
 *       200:
 *         description: The configured sources, the built-in default and whether the default is in use
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured:
 *                   type: array
 *                   items:
 *                     type: string
 *                 default:
 *                   type: string
 *                 usingDefault:
 *                   type: boolean
 *       400:
 *         description: sources is not an array, or one of the URLs is not an acceptable remote
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.get('/sources', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const configured = await readConfiguredSources();
    res.json({ configured: configured || [], default: DEFAULT_REMOTE, usingDefault: configured === null });
}));

router.put('/sources', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (body.reset === true) {
        // Forget the configured list entirely → back to the fallback chain (official default catalog).
        // This is distinct from saving an EMPTY list, which is honored as "no sources at all".
        await deleteOption('marketplace_sources');
        catalogCache = null;
        return res.json({ configured: [], default: DEFAULT_REMOTE, usingDefault: true });
    }
    const arr = body.sources;
    if (!Array.isArray(arr)) return res.status(400).json({ error: 'sources debe ser un arreglo de URLs.' });
    const clean: string[] = [];
    for (const raw of arr) {
        const s = String(raw || '').trim().replace(/\/+$/, '');
        if (!s) continue;
        // UI-managed sources must be https (or http://localhost for dev). Arbitrary local-dir sources are
        // NOT settable from the UI — that would let an admin point the server's catalog reader at any path.
        try { assertSaneRemote(s); } catch (e: any) {
            return res.status(400).json({ error: `Fuente inválida "${s}": ${e && e.message}` });
        }
        if (!clean.includes(s)) clean.push(s);
        if (clean.length >= MAX_SOURCES) break;
    }
    await updateOption('marketplace_sources', clean);
    catalogCache = null; // force a fresh merge on the next browse
    // An explicitly saved list — even an empty one — is never "the default": [] = no sources.
    res.json({ configured: clean, default: DEFAULT_REMOTE, usingDefault: false });
}));

// ============================== THEME MARKETPLACE ==============================
// Same system as plugins — but with its OWN admin-configurable source list (option
// `marketplace_theme_sources`), so themes can point at a different origin than plugins.
// Same v2 semantics: null = never configured (fallback chain → official default),
// [] = explicitly emptied (theme marketplace disabled), reset = back to default.

/** Read the admin-configured THEME source list. null = never configured; [] = explicitly none. */
async function readConfiguredThemeSources(): Promise<string[] | null> {
    const raw = await getOption('marketplace_theme_sources', null);
    let list: any[] | null = null;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim()) { try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* ignore */ } }
    if (list === null) return null;
    return list.map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * Resolve the ORDERED theme-catalog sources. Precedence:
 *   1. The admin-configured THEME list (own option — independent from the plugin list; an
 *      explicitly saved empty list disables the remote theme marketplace).
 *   2. The repo-local dist when it carries a themes index (dev / full checkout).
 *   3. The built-in default (GitHub release assets — both indices live side by side there).
 */
async function resolveThemeSources(): Promise<{ url: string; isLocal: boolean }[]> {
    const configured = await readConfiguredThemeSources();
    if (configured !== null) {
        return configured.slice(0, MAX_SOURCES).map((url) => ({ url, isLocal: !/^https?:\/\//i.test(url) }));
    }
    if (fs.existsSync(path.join(LOCAL_DIST, THEMES_INDEX_FILE))) return [{ url: LOCAL_DIST, isLocal: true }];
    return [{ url: DEFAULT_REMOTE, isLocal: false }];
}

/**
 * @swagger
 * /marketplace/themes/sources:
 *   get:
 *     summary: Get the admin-configured theme marketplace source URLs (+ the built-in default)
 *     description: Independent from the plugin source list. When nothing is configured the resolver falls back to the repo-local dist if it carries a theme index, and then to the built-in default.
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The configured sources, the built-in default and whether the default is in use
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured:
 *                   type: array
 *                   items:
 *                     type: string
 *                 default:
 *                   type: string
 *                 usingDefault:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *   put:
 *     summary: Replace the theme marketplace source URLs (admin)
 *     description: Each entry must be https, or http on localhost. Duplicates are dropped and the list is truncated to the source ceiling. An explicitly saved empty list disables the remote theme marketplace; send reset true instead to forget the list and go back to the fallback chain.
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sources:
 *                 type: array
 *                 items:
 *                   type: string
 *               reset:
 *                 type: boolean
 *                 description: When true the configured list is deleted and the fallback chain applies again.
 *     responses:
 *       200:
 *         description: The configured sources, the built-in default and whether the default is in use
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 configured:
 *                   type: array
 *                   items:
 *                     type: string
 *                 default:
 *                   type: string
 *                 usingDefault:
 *                   type: boolean
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       400:
 *         description: sources is not an array, or one of the URLs is not an acceptable remote
 */
router.get('/themes/sources', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const configured = await readConfiguredThemeSources();
    res.json({ configured: configured || [], default: DEFAULT_REMOTE, usingDefault: configured === null });
}));

router.put('/themes/sources', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (body.reset === true) {
        await deleteOption('marketplace_theme_sources');
        themesCatalogCache = null;
        return res.json({ configured: [], default: DEFAULT_REMOTE, usingDefault: true });
    }
    const arr = body.sources;
    if (!Array.isArray(arr)) return res.status(400).json({ error: 'sources debe ser un arreglo de URLs.' });
    const clean: string[] = [];
    for (const raw of arr) {
        const s = String(raw || '').trim().replace(/\/+$/, '');
        if (!s) continue;
        try { assertSaneRemote(s); } catch (e: any) {
            return res.status(400).json({ error: `Fuente inválida "${s}": ${e && e.message}` });
        }
        if (!clean.includes(s)) clean.push(s);
        if (clean.length >= MAX_SOURCES) break;
    }
    await updateOption('marketplace_theme_sources', clean);
    themesCatalogCache = null;
    res.json({ configured: clean, default: DEFAULT_REMOTE, usingDefault: false });
}));

let themesCatalogCache: { key: string; at: number; merged: any[]; sources: any[] } | null = null;

async function getThemesCatalog(refresh = false): Promise<{ merged: any[]; sources: any[] }> {
    const srcs = await resolveThemeSources();
    const key = sourcesCacheKey(srcs, THEMES_INDEX_FILE); // see sourcesCacheKey: a local rebuild must invalidate
    if (!refresh && themesCatalogCache && themesCatalogCache.key === key && Date.now() - themesCatalogCache.at < CACHE_TTL_MS) {
        return { merged: themesCatalogCache.merged, sources: themesCatalogCache.sources };
    }
    const seen = new Set<string>();
    const merged: any[] = [];
    const sources: any[] = [];
    for (const s of srcs) {
        try {
            const list = await loadCatalog(s.url, s.isLocal, THEMES_INDEX_FILE);
            let added = 0;
            for (const e of list) {
                const id = String(e.id || '');
                if (!id || seen.has(id)) continue;
                seen.add(id);
                merged.push({ ...e, source: s.url });
                added++;
            }
            sources.push({ url: s.url, isLocal: s.isLocal, ok: true, count: list.length, added });
        } catch (e: any) {
            sources.push({ url: s.url, isLocal: s.isLocal, ok: false, error: e && e.message });
        }
    }
    themesCatalogCache = { key, at: Date.now(), merged, sources };
    return { merged, sources };
}

/**
 * @swagger
 * /marketplace/themes/catalog:
 *   get:
 *     summary: Browse the theme marketplace catalog (annotated with installed/active state)
 *     description: The theme index rides its own source list, so it can point at a different origin than the plugin catalog. Sources are merged and deduplicated by entry id with earlier sources winning, and a source that cannot be read is reported inside sources with ok false rather than failing the browse. Installed state is read from the themes directory on disk, and active state from the current theme, both best-effort - an unreadable theme.json leaves installedVersion null rather than failing the request. The merge is cached for five minutes, keyed so that rebuilding a local dist invalidates it; refresh=1 bypasses the cache.
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: refresh
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['1']
 *         description: Send 1 to re-read every source instead of serving the cached merge. It is a scalar - repeating it is refused with 400, never resolved to one of the values.
 *     responses:
 *       200:
 *         description: The merged theme catalog, annotated with this install's state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 source:
 *                   type: string
 *                   description: The first source's URL, kept for backwards compatibility with clients written before the list existed.
 *                 isLocal:
 *                   type: boolean
 *                 sources:
 *                   type: array
 *                   description: Per-source status. A source that failed carries ok false and its error instead of a count.
 *                   items:
 *                     type: object
 *                     properties:
 *                       url:
 *                         type: string
 *                       isLocal:
 *                         type: boolean
 *                       ok:
 *                         type: boolean
 *                       count:
 *                         type: integer
 *                       added:
 *                         type: integer
 *                       error:
 *                         type: string
 *                 count:
 *                   type: integer
 *                 themes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       version:
 *                         type: string
 *                       source:
 *                         type: string
 *                       installed:
 *                         type: boolean
 *                       active:
 *                         type: boolean
 *                       installedVersion:
 *                         type: string
 *                         nullable: true
 *                       updateAvailable:
 *                         type: boolean
 *       400:
 *         description: A scalar query parameter arrived more than once or as a non-string (rest_invalid_param)
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       502:
 *         description: The theme catalog could not be read at all, so there is nothing to annotate
 */
router.get('/themes/catalog', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    // Same placement as the plugin catalog above, for the same reason.
    requireScalarQuery(req.query, CATALOG_QUERY_FIELDS);

    try {
        const refresh = String(req.query.refresh || '') === '1';
        const { merged, sources } = await getThemesCatalog(refresh);
        const { getCurrentTheme, THEMES_DIR } = require('../core/themes');
        let activeSlug = '';
        try { const cur = await getCurrentTheme(); activeSlug = String((cur && (cur.slug || cur)) || ''); } catch { /* annotate best-effort */ }
        const annotated = merged.map((e: any) => {
            const dir = path.join(THEMES_DIR, String(e.id));
            const installed = /^[a-zA-Z0-9_-]+$/.test(String(e.id)) && fs.existsSync(path.join(dir, 'theme.json'));
            let installedVersion: string | null = null;
            if (installed) {
                try { installedVersion = String(JSON.parse(fs.readFileSync(path.join(dir, 'theme.json'), 'utf8')).version || ''); } catch { /* unreadable */ }
            }
            return {
                ...e,
                installed,
                active: installed && String(e.id) === activeSlug,
                installedVersion,
                updateAvailable: !!(installed && installedVersion && e.version && String(installedVersion) !== String(e.version)),
            };
        });
        const first = sources[0] || {};
        res.json({ source: first.url || '', isLocal: !!first.isLocal, sources, count: annotated.length, themes: annotated });
    } catch (e: any) {
        console.error('[marketplace] theme catalog read failed:', e);
        res.status(502).json({ error: publicErrorText(e, 'No se pudo leer el catálogo de temas.') });
    }
}));

/**
 * @swagger
 * /marketplace/themes/install:
 *   post:
 *     summary: Download a catalog theme and install it through the hardened theme pipeline
 *     description: Same contract as the plugin installer, for the same reason - a theme's functions.js runs in-process. The bytes are fetched from the source the entry was listed under, or read from a local dist directory after the resolved path is proven to stay inside it, and then sha256-verified against the catalog entry. A remote entry with no sha256 is refused rather than installed unverified. The verified zip goes to the theme install pipeline, which refuses an invalid slug, a zip whose entries escape the slug directory, a path traversal or Zip Slip attempt, and an archive with no theme.json. Installing over an existing theme is refused - delete it first.
 *     tags: [Themes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id:
 *                 type: string
 *                 description: The catalog entry id, which is also the slug the theme is installed under.
 *     responses:
 *       200:
 *         description: The theme was installed. The status is the one the theme pipeline returns, so a refusal inside the pipeline surfaces with its own status and body.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 slug:
 *                   type: string
 *       400:
 *         description: Missing id, a catalog entry naming an unsafe file or a path outside the local marketplace directory, a package over the size ceiling, a remote entry with no sha256, a sha256 mismatch, or a package the theme pipeline rejects - an invalid slug, entries outside the slug directory, a traversal or Zip Slip attempt, or no theme.json
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: No such id in the theme catalog, or the local package file is missing
 *       409:
 *         description: A theme with that slug is already installed - delete it before reinstalling
 *       500:
 *         description: Unpacking the verified archive failed
 *       502:
 *         description: The theme catalog could not be read, or the package could not be downloaded
 */
router.post('/themes/install', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const id = String((req.body || {}).id || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta el id del tema.' });

    let entry: any;
    try {
        const { merged } = await getThemesCatalog(false);
        entry = merged.find((e: any) => String(e.id) === id);
    } catch (e: any) {
        console.error('[marketplace] theme catalog read failed:', e);
        return res.status(502).json({ error: publicErrorText(e, 'No se pudo leer el catálogo de temas.') });
    }
    if (!entry) return res.status(404).json({ error: `El tema "${id}" no está en el catálogo.` });

    const source = String(entry.source || '');
    const isLocal = !/^https?:\/\//i.test(source);
    const file = String(entry.file || '');
    if (!SAFE_FILE_RE.test(file)) {
        return res.status(400).json({ error: 'El catálogo contiene un nombre de archivo inválido.' });
    }

    let buf: Buffer;
    try {
        if (isLocal) {
            const base = path.resolve(source);
            const zipAbs = path.resolve(base, file);
            if (!(zipAbs === base || zipAbs.startsWith(base + path.sep))) {
                return res.status(400).json({ error: 'Ruta de archivo fuera del directorio del marketplace.' });
            }
            if (!fs.existsSync(zipAbs)) return res.status(404).json({ error: `No existe ${file} en el marketplace local.` });
            const size = fs.statSync(zipAbs).size;
            if (size > MAX_ZIP_BYTES) return res.status(400).json({ error: 'El paquete excede el tamaño máximo permitido.' });
            buf = fs.readFileSync(zipAbs);
        } else {
            buf = await fetchRemote(`${source}/${file}`, MAX_ZIP_BYTES);
        }
    } catch (e: any) {
        console.error('[marketplace] theme download failed:', e);
        return res.status(502).json({ error: publicErrorText(e, 'No se pudo descargar el tema del catálogo.') });
    }

    // Integrity is MANDATORY for a REMOTE theme source (same reasoning as the plugin installer: a theme's
    // functions.js runs in-process). Official theme entries all ship a sha256, so this is fail-closed with
    // no regression; local-dir sources (admin-controlled, confined above) are exempt.
    if (!isLocal && !entry.sha256) {
        return res.status(400).json({ error: 'El paquete remoto no incluye un hash de integridad (sha256) — instalación abortada.' });
    }
    if (entry.sha256) {
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        if (digest !== String(entry.sha256).toLowerCase()) {
            return res.status(400).json({ error: 'La verificación de integridad (sha256) del paquete falló — instalación abortada.' });
        }
    }

    const tmpDir = path.resolve('os-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `theme-install-${crypto.randomBytes(8).toString('hex')}.zip`);
    fs.writeFileSync(tmpPath, buf);

    const { installThemeFromZip } = require('../core/themes');
    const result = await installThemeFromZip(tmpPath, id);
    res.status(result.status).json(result.body);
}));

module.exports = router;
// Exported for the catalog gate's tests (same pattern as routes/plugins.ts): which sources the review
// badge is a statement about is a security decision, and it deserves its own negative controls without
// booting a database to reach it.
module.exports.isOfficialSource = isOfficialSource;
