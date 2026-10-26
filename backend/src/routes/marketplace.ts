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

/** Is `candidate` a strictly newer semver than `current`? (String inequality offered downgrades as updates.) */
const isNewerVersion = (candidate: unknown, current: unknown): boolean =>
    require('../core/updater').compareVersions(String(candidate), String(current)) > 0;
const express = require('express');
const log = require('../core/module-logger').moduleLogger('routes/marketplace');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const config = require('../config/app');
const egress = require('../core/egress-guard');
// refusePluginGrantByToken: the consent of an adopt/reinstall is an administrator's, never an API token's.
const { authenticate, refusePluginGrantByToken } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
// publicErrorText: un fallo que nadie ha reconocido (DNS, TLS, socket, driver) se registra entero
// y al cliente le llega la operación que falló, no el texto del componente que la rompió.
const { asyncHandler, publicErrorText } = require('../middleware/errorHandler');
const { getOption, updateOption, deleteOption } = require('../core/options');
const { getAllPlugins } = require('../core/plugins');
const { installPluginFromZip, runPluginUpdate, createInstallTmp } = require('./plugins');
const pluginOrigins = require('../core/plugin-origins');
// `requires.wordjs`: which WordJS a catalog entry needs (catalog annotation + the 409 before download).
const coreRequirement = require('../core/core-requirement');
const { recordAudit } = require('../core/audit');
// Detached Ed25519 signatures over the catalog documents (see core/marketplace-signature).
const catalogSig = require('../core/marketplace-signature');
const semver = require('semver');

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
 * CATALOG SIGNING - the trust anchor of the official catalog.
 *
 * Each package is sha256-checked against its catalog entry, and that hash travels in the same index
 * document, so the index is what actually has to be trusted. The official catalog is therefore signed
 * (a detached `<index>.sig` next to each index file, Ed25519 over the exact bytes) and verified against
 * the public key below, which ships with the code - not with the download.
 *
 * The value is the base64 SPKI public key printed by backend/scripts/generate-marketplace-signing-key.js.
 * It is EMPTY until the project owner generates the key pair and configures the MARKETPLACE_SIGNING_KEY
 * repository secret; while it is empty the official catalog is not verified and is reported `unsigned`
 * (never refused), so installs keep working. Once a key is set, an official remote catalog whose
 * signature is missing or does not verify is refused.
 */
const OFFICIAL_CATALOG_PUBLIC_KEY = '';
// Test seam only (see __setOfficialCatalogKeyForTests): null = use the embedded constant.
let officialCatalogKeyOverride: string | null = null;
function officialCatalogKey(): string {
    return officialCatalogKeyOverride !== null ? officialCatalogKeyOverride : OFFICIAL_CATALOG_PUBLIC_KEY;
}

/**
 * Per-source public keys for admin-added catalogs: `{ "<source url>": "<base64 Ed25519 public key>" }`.
 * The option NAME contains "signing" on purpose: PROTECTED_OPTION_RE in core/plugin-api.ts matches it,
 * so no plugin can read or rewrite the keys through the options bridge (a plugin that could would be
 * able to pin its own key for a source it also controls).
 */
const SOURCE_KEYS_OPTION = 'marketplace_source_signing_keys';

/**
 * Validate and merge the `keys` field of a PUT /sources body into the stored per-source key map.
 * Only URLs in the list being saved may be keyed; an empty string or null removes a key. Returns the
 * refusal text, or null after storing.
 */
async function saveSourceKeys(bodyKeys: any, cleanList: string[]): Promise<string | null> {
    if (bodyKeys === undefined) return null;
    if (!bodyKeys || typeof bodyKeys !== 'object' || Array.isArray(bodyKeys)) return 'keys debe ser un objeto { url: clave pública }.';
    const allowed = new Set(cleanList.map((u) => pluginOrigins.normSource(u)));
    const next = await readSourceKeys();
    for (const [url, key] of Object.entries(bodyKeys)) {
        const norm = pluginOrigins.normSource(String(url).trim().replace(/\/+$/, ''));
        if (!allowed.has(norm)) return `La clave de "${url}" no corresponde a ninguna fuente de la lista.`;
        if (key === null || key === '') { delete next[norm]; continue; }
        if (!catalogSig.isValidPublicKey(key)) return `La clave pública de "${url}" no es una clave Ed25519 válida.`;
        next[norm] = String(key).trim();
    }
    await updateOption(SOURCE_KEYS_OPTION, next);
    return null;
}

async function readSourceKeys(): Promise<Record<string, string>> {
    const raw = await getOption(SOURCE_KEYS_OPTION, null);
    let obj: any = raw;
    if (typeof raw === 'string' && raw.trim()) { try { obj = JSON.parse(raw); } catch { obj = null; } }
    const out: Record<string, string> = {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string' && v.trim()) out[pluginOrigins.normSource(k)] = v.trim();
        }
    }
    return out;
}

/**
 * Which key verifies a source's catalog, and whether a MISSING signature refuses it.
 *   - the official remote catalog with the embedded key configured -> required;
 *   - the official LOCAL dist (this checkout's own build) -> verified when a .sig is present, otherwise
 *     reported unsigned (a developer's local build is not signed);
 *   - any source the administrator pinned a key for -> required (pinning a key is asking for signatures);
 *   - anything else -> no key, reported unsigned.
 */
function catalogSignaturePolicy(url: string, isLocal: boolean, sourceKeys: Record<string, string>): { key: string; required: boolean } {
    const official = isOfficialSource(url, isLocal);
    const embedded = officialCatalogKey();
    if (official && embedded) return { key: embedded, required: !isLocal };
    const pinned = sourceKeys[pluginOrigins.normSource(url)];
    if (pinned) return { key: pinned, required: true };
    return { key: '', required: false };
}

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
// FETCH_TIMEOUT_MS is an IDLE timer (no byte for that long). This bounds the whole download, redirects
// included, so a server that trickles bytes cannot hold an install or a catalog read open indefinitely.
const FETCH_DEADLINE_MS = 2 * 60 * 1000;
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
async function fetchRemote(url: string, maxBytes: number, _hops = 0, deadline = Date.now() + FETCH_DEADLINE_MS): Promise<Buffer> {
    if (Date.now() >= deadline) throw new Error('La descarga superó el tiempo máximo permitido.');
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
                resolve(fetchRemote(next, maxBytes, _hops + 1, deadline));
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
        const overall = setTimeout(() => {
            const err = new Error('La descarga superó el tiempo máximo permitido.');
            reject(err);
            req.destroy(err);
        }, Math.max(0, deadline - Date.now()));
        overall.unref?.();
        req.on('error', () => clearTimeout(overall));
        req.on('response', (res: IncomingMessage) => res.on('close', () => clearTimeout(overall)));
        req.end();
    });
}

/**
 * Read one source's index and apply the signing policy to it. The signature is checked over the exact
 * bytes read, BEFORE they are parsed, so nothing from a catalog that fails verification is ever used.
 * The detached `.sig` is only looked for when a key applies (an unsigned third-party catalog costs no
 * extra request).
 */
async function loadCatalog(
    source: string,
    isLocal: boolean,
    indexFile: string = INDEX_FILE,
    policy: { key: string; required: boolean } = { key: '', required: false },
): Promise<{ list: any[]; signature: 'verified' | 'unsigned' }> {
    let bytes: Buffer;
    let sigText: string | null = null;
    if (isLocal) {
        const idxPath = path.join(path.resolve(source), indexFile);
        if (!fs.existsSync(idxPath)) throw new Error(`No se encontró ${indexFile} en ${source}. Ejecuta "npm run build:marketplace".`);
        bytes = fs.readFileSync(idxPath);
        if (policy.key) {
            const sigPath = idxPath + catalogSig.SIGNATURE_SUFFIX;
            try {
                if (fs.existsSync(sigPath) && fs.statSync(sigPath).size <= catalogSig.MAX_SIGNATURE_BYTES) sigText = fs.readFileSync(sigPath, 'utf8');
            } catch { sigText = null; }
        }
    } else {
        bytes = await fetchRemote(`${source}/${indexFile}`, 2 * 1024 * 1024);
        if (policy.key) {
            // A missing .sig (404) and an unreachable one are the same thing here: no signature. Whether
            // that is acceptable is the policy's decision, not the transport's.
            try { sigText = (await fetchRemote(`${source}/${indexFile}${catalogSig.SIGNATURE_SUFFIX}`, catalogSig.MAX_SIGNATURE_BYTES)).toString('utf8'); }
            catch { sigText = null; }
        }
    }
    const signature = catalogSig.checkCatalogSignature(bytes, sigText, policy.key, policy.required);
    const parsed = JSON.parse(bytes.toString('utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.plugins || parsed.themes);
    if (!Array.isArray(list)) throw new Error('El índice del marketplace tiene un formato inválido.');
    return { list, signature };
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
    const sourceKeys = await readSourceKeys();
    for (const s of srcs) {
        try {
            const { list, signature } = await loadCatalog(s.url, s.isLocal, INDEX_FILE, catalogSignaturePolicy(s.url, s.isLocal, sourceKeys));
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
                    // Whether the index this entry came from carried a verified signature.
                    catalogSignature: signature,
                });
                added++;
            }
            sources.push({ url: s.url, isLocal: s.isLocal, ok: true, count: list.length, added, signature });
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
 *                       signature:
 *                         type: string
 *                         enum: [verified, unsigned]
 *                         description: verified when the index carried a detached Ed25519 signature that verified against the key for this source (the embedded official key, or the key the administrator pinned for it). unsigned when no key applies, or the official key is not configured yet. A source whose signature is required but missing, or present but invalid, is reported with ok false instead.
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
 *                         description: True only when an update exists AND the catalog entry's source matches the recorded install origin.
 *                       applyMode:
 *                         type: string
 *                         nullable: true
 *                         enum: [update, adopt, reinstall]
 *                         description: For an installed plugin with a newer version, how it can take it - update (same source, POST /marketplace/update), adopt (no recorded origin and the official catalog, POST /marketplace/adopt with mode adopt) or reinstall (a different source, POST /marketplace/adopt with mode reinstall). Null otherwise.
 *                       compatible:
 *                         type: boolean
 *                         description: Whether this install's WordJS satisfies the entry's requires.wordjs range (true when the entry declares none). An incompatible entry is refused by install, update and adopt with 409 core_version_too_old.
 *                       requiresWordjs:
 *                         type: string
 *                         nullable: true
 *                         description: The semver range the entry declares in requires.wordjs, or null.
 *                       minWordjs:
 *                         type: string
 *                         nullable: true
 *                         description: The lowest WordJS version that range admits, or null.
 *                       currentWordjs:
 *                         type: string
 *                         description: This install's WordJS version.
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
            // NEWER only: a plugin updated by upload past the catalog's version is not offered a "downgrade update".
            const updateAvailable = !!(local && local.version && e.version && isNewerVersion(e.version, local.version));
            // `updatable` = an update can actually be applied in one click: installed, a newer version, AND
            // this catalog entry's source MATCHES the source it was installed from. A plugin installed by
            // upload or from another source shows the update but not the button (the UI explains why).
            const updatable = !!(updateAvailable && recorded && recorded.source &&
                pluginOrigins.normSource(recorded.source) === pluginOrigins.normSource(e.source));
            // How a newer version reaches an installed plugin that is NOT updatable: 'adopt' (no origin,
            // official catalog: in place, permissions asked again) or 'reinstall' (another source: explicit,
            // fresh consent, keeping the data is a choice). null when nothing applies.
            const applyMode = local && updateAvailable
                ? pluginOrigins.catalogApplyMode(recorded, String(e.source || ''), DEFAULT_REMOTE)
                : null;
            // The WordJS this version needs (`requires.wordjs`, copied from its manifest by the catalog
            // build) against this install's: an incompatible entry is listed, but not installable or
            // updatable here until WordJS itself is updated.
            const core = coreRequirement.coreCompatibility(e);
            return {
                ...e,
                installed: !!local,
                active: !!(local && local.active),
                installedVersion: local ? local.version || null : null,
                updateAvailable,
                updatable,
                applyMode,
                installedFrom: recorded ? recorded.source : null,
                compatible: core.compatible,
                requiresWordjs: core.requires,
                minWordjs: core.minimum,
                currentWordjs: core.current,
            };
        });
        // `source`/`isLocal` are kept for back-compat (the primary source); `sources` carries per-source status.
        const first = sources[0] || {};
        res.json({ source: first.url || '', isLocal: !!first.isLocal, sources, count: annotated.length, plugins: annotated });
    } catch (e: any) {
        log.error({ err: e }, '[marketplace] plugin catalog read failed');
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
 *               allowDowngrade:
 *                 type: boolean
 *                 description: Only for an installed plugin. Replacing it with an older version (by the catalog's version or the package manifest's) is refused with 409 downgradeRefused unless this is true.
 *               existingData:
 *                 type: string
 *                 enum: [adopt, discard]
 *                 description: Only for a fresh install over data a previous uninstall kept (its data directory or tables). adopt keeps and reconnects them; discard removes them once the new package installs. Without it such an install is refused with 409 existing_plugin_data, listing what was found.
 *     responses:
 *       200:
 *         description: The pipeline result. The status is the one the install or update pipeline returns, so a refusal inside the pipeline surfaces with its own status and body.
 *       400:
 *         description: Missing id, an existingData other than adopt or discard, a catalog entry naming an unsafe file or a path outside the local marketplace directory, a package over the size ceiling, a remote entry with no sha256, a sha256 mismatch - the package is never installed unverified - or catalogSlugMismatch, an archive that would install under a different slug than the catalog entry's id
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: No such id in the catalog, or the local package file is missing
 *       409:
 *         description: core_version_too_old - the entry or the package's manifest requires a newer WordJS (requires.wordjs) than this install runs; nothing is downloaded or replaced. The body names requires, minimum and current. An update can also be refused for its origin (see /marketplace/update), with downgradeRefused when the package is older than the installed version and allowDowngrade was not sent, or with existing_plugin_data when a fresh install finds data a previous uninstall kept and existingData was not sent.
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

/**
 * The catalog entry for `id`, or the HTTP refusal to send (400 no id, 404 not listed, 502 unreadable, 409
 * core_version_too_old when the entry needs a newer WordJS — refused before anything is downloaded; the
 * installer checks the package's own manifest again, so a catalog that omits the field is still caught).
 */
async function findCatalogEntry(idIn: any): Promise<{ entry?: any; status?: number; body?: any }> {
    const id = typeof idIn === 'string' ? idIn.trim() : '';
    if (!id) return { status: 400, body: { error: 'Falta el id del plugin.' } };
    try {
        const { merged } = await getCatalog(false);
        const entry = merged.find((e: any) => String(e.id) === id);
        if (!entry) return { status: 404, body: { error: `El plugin "${id}" no está en el catálogo.` } };
        try { coreRequirement.assertCoreCompatible(entry, id); }
        catch (e: any) { return { status: e.status || 409, body: e.body || { error: e.message } }; }
        return { entry };
    } catch (e: any) {
        log.error({ err: e }, '[marketplace] plugin catalog read failed');
        return { status: 502, body: { error: publicErrorText(e, 'No se pudo leer el catálogo de plugins.') } };
    }
}

/**
 * The verified bytes of a catalog entry, or the HTTP refusal to send. Every path that puts catalog code on
 * this server goes through here: the bytes come from the source the entry was listed under (a local dir
 * proven to contain the file, or https), and a remote entry must carry a sha256 that the bytes match.
 */
async function fetchVerifiedPackage(entry: any): Promise<{ buf?: Buffer; status?: number; body?: any }> {
    // Install from the SAME source the entry was listed under (each merged entry carries its source).
    const source = String(entry.source || '');
    const isLocal = !/^https?:\/\//i.test(source);

    const file = String(entry.file || '');
    if (!SAFE_FILE_RE.test(file)) {
        return { status: 400, body: { error: 'El catálogo contiene un nombre de archivo inválido.' } };
    }

    // Fetch the zip bytes (remote) or read them from the dist dir (local), then sha256-verify.
    let buf: Buffer;
    try {
        if (isLocal) {
            const base = path.resolve(source);
            const zipAbs = path.resolve(base, file);
            if (!(zipAbs === base || zipAbs.startsWith(base + path.sep))) {
                return { status: 400, body: { error: 'Ruta de archivo fuera del directorio del marketplace.' } };
            }
            if (!fs.existsSync(zipAbs)) return { status: 404, body: { error: `No existe ${file} en el marketplace local.` } };
            const size = fs.statSync(zipAbs).size;
            if (size > MAX_ZIP_BYTES) return { status: 400, body: { error: 'El paquete excede el tamaño máximo permitido.' } };
            buf = fs.readFileSync(zipAbs);
        } else {
            buf = await fetchRemote(`${source}/${file}`, MAX_ZIP_BYTES);
        }
    } catch (e: any) {
        log.error({ err: e }, '[marketplace] plugin download failed');
        return { status: 502, body: { error: publicErrorText(e, 'No se pudo descargar el plugin del catálogo.') } };
    }

    // Integrity is MANDATORY for a REMOTE source: a plugin installs+runs arbitrary server-side code, so a
    // third-party/compromised catalog that simply OMITS `sha256` must NOT yield an unverified install. Every
    // official catalog entry ships a sha256 (verified in the generated index), so this is fail-closed with no
    // regression. Local-dir sources are exempt: the bytes are read from an admin-controlled path already
    // confined to the marketplace dir above.
    if (!isLocal && !entry.sha256) {
        return { status: 400, body: { error: 'El paquete remoto no incluye un hash de integridad (sha256) — instalación abortada.' } };
    }
    if (entry.sha256) {
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        if (digest !== String(entry.sha256).toLowerCase()) {
            return { status: 400, body: { error: 'La verificación de integridad (sha256) del paquete falló — instalación abortada.' } };
        }
    }
    return { buf };
}

/**
 * Is `candidate` a LOWER version than `current`? Proper semver precedence (the `semver` package, the
 * same one core/core-requirement uses) when both parse; otherwise the updater's tolerant comparator,
 * which reads an unparseable version as 0.0.0 — so a version string that is not semver can never pass
 * for a newer one.
 */
function isLowerVersion(candidate: unknown, current: unknown): boolean {
    const a = String(candidate == null ? '' : candidate).trim();
    const b = String(current == null ? '' : current).trim();
    if (!b) return false; // nothing installed to compare against
    const va = semver.valid(a, { loose: true });
    const vb = semver.valid(b, { loose: true });
    if (va && vb) return semver.lt(va, vb);
    return require('../core/updater').compareVersions(a || '0.0.0', b) < 0;
}

/**
 * The version the package's OWN manifest declares (`<slug>/manifest.json`), or null when it cannot be
 * read. This, not the catalog's label, is what would actually be installed. Only the one small entry is
 * inflated (a manifest larger than 1 MiB is treated as unreadable), so this adds no decompression surface.
 */
function packageManifestVersion(buf: Buffer, slug: string): string | null {
    try {
        const AdmZip = require('adm-zip');
        const entry = new AdmZip(buf).getEntry(`${slug}/manifest.json`);
        if (!entry || entry.isDirectory || !(entry.header && entry.header.size <= 1024 * 1024)) return null;
        const m = JSON.parse(entry.getData().toString('utf8'));
        return m && m.version != null ? String(m.version) : null;
    } catch {
        return null;
    }
}

/**
 * Refuse replacing an installed plugin with an OLDER version unless the administrator asked for exactly
 * that (`allowDowngrade: true`). Rolling a plugin back reinstates whatever its earlier releases fixed, so
 * it must be a deliberate act and never the side effect of a catalog that lists an older build. Both the
 * catalog's version and the package manifest's are checked; either one being lower is a downgrade.
 * Returns the HTTP refusal, or null to proceed.
 */
function downgradeRefusal(entry: any, buf: Buffer, slug: string, installedVersion: unknown, allowDowngrade: boolean): { status: number; body: any } | null {
    if (allowDowngrade) return null;
    const packageVersion = packageManifestVersion(buf, slug);
    const lower = [entry && entry.version, packageVersion].find((v) => v != null && String(v).trim() && isLowerVersion(v, installedVersion));
    if (lower === undefined) return null;
    return {
        status: 409,
        body: {
            error: `Refused: '${slug}' ${String(installedVersion)} is installed and this package is version ${String(lower)}, which is older. `
                + 'Installing an older version is only done on explicit request (allowDowngrade: true).',
            code: 'downgradeRefused',
            installedVersion: String(installedVersion),
            packageVersion: String(lower),
        },
    };
}

/** `allowDowngrade` is a strict boolean: anything else present in the body is a malformed request. */
function readAllowDowngrade(body: any): { ok: true; value: boolean } | { ok: false } {
    const v = body ? body.allowDowngrade : undefined;
    if (v === undefined) return { ok: true, value: false };
    if (typeof v !== 'boolean') return { ok: false };
    return { ok: true, value: v };
}

const handleMarketplaceApply = asyncHandler(async (req: Request, res: Response) => {
    const allow = readAllowDowngrade(req.body);
    if (!allow.ok) return res.status(400).json({ error: 'allowDowngrade must be true or false.' });
    const found = await findCatalogEntry((req.body || {}).id);
    if (!found.entry) return res.status(found.status as number).json(found.body);
    const entry = found.entry;
    const file = String(entry.file || '');
    const pkg = await fetchVerifiedPackage(entry);
    if (!pkg.buf) return res.status(pkg.status as number).json(pkg.body);
    const buf = pkg.buf;

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
    const installedPlugin = (await getAllPlugins()).find((p: any) => String(p.slug || p.id) === slug);
    const installedNow = !!installedPlugin;
    if (installedPlugin) {
        const refusal = downgradeRefusal(entry, buf, slug, installedPlugin.version, allow.value);
        if (refusal) {
            await recordAudit(req.user && req.user.id, 'marketplace.update', 'plugin', slug, applyAuditDetail(entry, { ok: false, status: refusal.status }));
            return res.status(refusal.status).json(refusal.body);
        }
    }
    // Data a previous uninstall kept (data/ and tables) is adopted or discarded only on the admin's
    // explicit answer; without one the install answers 409 existing_plugin_data, as an upload does.
    const existingData = req.body && (req.body.existingData === 'adopt' || req.body.existingData === 'discard') ? req.body.existingData : undefined;
    if (req.body && req.body.existingData !== undefined && !existingData) {
        return res.status(400).json({ error: 'existingData must be "adopt" or "discard".' });
    }
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
        //
        // The installed slug is PINNED to the catalog entry's id, exactly as the update path pins it: the
        // admin chose an entry, the origin is recorded under that entry's id, and the package must install
        // as that same plugin. Without the pin the archive's own root folder would decide which plugin
        // directory it lands in, so the provenance recorded below could describe a different plugin from
        // the one actually installed.
        const result = await installPluginFromZip(tmp.zipPath, file, slug, req.user && req.user.id, { existingData });
        if (!result.ok && result.body && result.body.expectedSlug === slug && result.body.intendedSlug) {
            // The pipeline words this refusal for the update path; say what it means for an install.
            result.body = {
                ...result.body,
                error: `Refused: the catalog lists this package as '${slug}', but the archive installs '${result.body.intendedSlug}'. `
                    + `A catalog package must install as the entry it is listed under (its zip's root folder must be '${slug}').`,
                code: 'catalogSlugMismatch',
            };
        }
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
 *               allowDowngrade:
 *                 type: boolean
 *                 description: Only for an installed plugin. Replacing it with an older version (by the catalog's version or the package manifest's) is refused with 409 downgradeRefused unless this is true.
 *     responses:
 *       200:
 *         description: The pipeline result. The status is the one the install or update pipeline returns, so a refusal inside the pipeline surfaces with its own status and body.
 *       400:
 *         description: Missing id, a catalog entry naming an unsafe file, a package over the size ceiling, a remote entry with no sha256, a sha256 mismatch - the package is never installed unverified - or catalogSlugMismatch, an archive that would install under a different slug than the catalog entry's id
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: No such id in the catalog, or the local package file is missing
 *       409:
 *         description: core_version_too_old - the entry or the package's manifest requires a newer WordJS (requires.wordjs) than this install runs; nothing is downloaded or replaced. The body names requires, minimum and current. An update can also be refused for its origin (see /marketplace/update), or with downgradeRefused when the package is older than the installed version and allowDowngrade was not sent.
 *       502:
 *         description: The catalog could not be read, or the package could not be downloaded
 */
router.post('/update', authenticate, isAdmin, handleMarketplaceApply);

/**
 * @swagger
 * /marketplace/adopt:
 *   post:
 *     summary: Bring an installed plugin from another provenance onto this catalog entry, with fresh consent
 *     description: For an installed plugin that the normal update refuses because its recorded source is not the entry's. Mode adopt (no recorded origin and the official catalog) installs the verified code in place keeping the data directory and tables. Mode reinstall (any other source change) requires confirmSourceChange true and an explicit keepData choice; with keepData false the plugin's data directory, tables, owned options and private storage are removed. In both modes the stored permissions are not replayed - they are replaced by the grants sent here, limited to what the new manifest declares - and the new source is recorded so later updates are normal ones. The mode must match the plugin's current origin, read on the server. Integrity rules are those of /marketplace/install. Every attempt is audited with the previous and new source and grants.
 *     tags: [Plugins]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, mode, grants]
 *             properties:
 *               id:
 *                 type: string
 *               mode:
 *                 type: string
 *                 enum: [adopt, reinstall]
 *               grants:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: The permissions the administrator approved now, as scope:access tokens (or network).
 *               keepData:
 *                 type: boolean
 *                 description: Required for reinstall. Ignored for adopt, which always keeps the data.
 *               confirmSourceChange:
 *                 type: boolean
 *                 description: Required true for reinstall.
 *               allowDowngrade:
 *                 type: boolean
 *                 description: Taking an older version than the installed one is refused with 409 downgradeRefused unless this is true.
 *     responses:
 *       200:
 *         description: Applied. The body is the update result plus mode, keptData, previousSource, newSource, previousGrants and grants.
 *       400:
 *         description: A malformed field, an unconfirmed source change, a reinstall without a keepData choice, or a package that fails verification
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       404:
 *         description: No such id in the catalog, the plugin is not installed, or the local package file is missing
 *       409:
 *         description: The mode does not match the plugin's origin (useUpdate when it was installed from this same source), another operation on the plugin is in progress, or core_version_too_old - the entry needs a newer WordJS than this install runs
 *       502:
 *         description: The catalog could not be read, or the package could not be downloaded
 */
router.post('/adopt', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    const mode = b.mode;
    if (mode !== 'adopt' && mode !== 'reinstall') return res.status(400).json({ error: 'mode must be "adopt" or "reinstall".' });
    if (!Array.isArray(b.grants) || b.grants.some((g: any) => typeof g !== 'string')) {
        return res.status(400).json({ error: 'grants must be a list of permission tokens.' });
    }
    if (b.keepData !== undefined && typeof b.keepData !== 'boolean') return res.status(400).json({ error: 'keepData must be true or false.' });
    if (b.confirmSourceChange !== undefined && typeof b.confirmSourceChange !== 'boolean') return res.status(400).json({ error: 'confirmSourceChange must be true or false.' });
    // Keeping the data is never assumed when the source changes: the administrator says which.
    if (mode === 'reinstall' && typeof b.keepData !== 'boolean') return res.status(400).json({ error: 'A reinstall from another source must say whether to keep the plugin data (keepData).', code: 'keepDataRequired' });
    const allow = readAllowDowngrade(b);
    if (!allow.ok) return res.status(400).json({ error: 'allowDowngrade must be true or false.' });

    // What is granted here is what an administrator approved in the consent dialog: a token read no dialog.
    if (b.grants.length && refusePluginGrantByToken(req, res, b.grants)) return;

    const found = await findCatalogEntry(b.id);
    if (!found.entry) return res.status(found.status as number).json(found.body);
    const entry = found.entry;
    const slug = String(entry.id);
    const installedPlugin = (await getAllPlugins()).find((p: any) => String(p.slug || p.id) === slug);
    if (!installedPlugin) {
        return res.status(404).json({ error: `Plugin '${slug}' is not installed: install it instead.` });
    }
    const pkg = await fetchVerifiedPackage(entry);
    if (!pkg.buf) return res.status(pkg.status as number).json(pkg.body);
    // Same downgrade rule as /marketplace/update: adopting a catalog entry never silently rolls back.
    const refusal = downgradeRefusal(entry, pkg.buf, slug, installedPlugin.version, allow.value);
    if (refusal) {
        await recordAudit(req.user && req.user.id, 'marketplace.adopt', 'plugin', slug, { ...applyAuditDetail(entry, { ok: false, status: refusal.status }), mode });
        return res.status(refusal.status).json(refusal.body);
    }

    const origin = { source: String(entry.source || ''), catalogId: slug, version: entry.version != null ? String(entry.version) : null };
    const keepData = mode === 'adopt' ? true : b.keepData === true;
    const tmp = createInstallTmp();
    try {
        fs.writeFileSync(tmp.zipPath, pkg.buf, { mode: 0o600, flag: 'wx' });
        const result = await runPluginUpdate(slug, tmp.zipPath, origin, {
            via: mode, officialSource: DEFAULT_REMOTE, grants: b.grants, keepData, confirmedSourceChange: b.confirmSourceChange === true,
        });
        // Old and new provenance and permissions, on success AND refusal (see applyAuditDetail).
        const r = result.body || {};
        await recordAudit(req.user && req.user.id, 'marketplace.adopt', 'plugin', slug, {
            ...applyAuditDetail(entry, result),
            mode, keepData,
            previousSource: r.previousSource !== undefined ? r.previousSource : (r.recordedOrigin !== undefined ? r.recordedOrigin : null),
            newSource: origin.source.slice(0, 200),
            previousGrants: Array.isArray(r.previousGrants) ? r.previousGrants : null,
            grants: Array.isArray(r.grants) ? r.grants : null,
        });
        return res.status(result.status).json(result.body);
    } finally {
        tmp.dispose();
    }
}));

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
 *                 keys:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                   description: The Ed25519 public key pinned per source URL. A source with a pinned key must serve a valid detached signature or its catalog is refused.
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
 *               keys:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *                 description: Optional. Pins (or, with an empty string, unpins) the Ed25519 public key of a source in this list, as base64 (raw 32 bytes or SPKI DER) or PEM. Shared between the plugin and theme lists, keyed by URL.
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
 *                 keys:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                   description: The Ed25519 public key pinned per source URL. A source with a pinned key must serve a valid detached signature or its catalog is refused.
 *       400:
 *         description: sources is not an array, or one of the URLs is not an acceptable remote
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 */
router.get('/sources', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const configured = await readConfiguredSources();
    res.json({ configured: configured || [], default: DEFAULT_REMOTE, usingDefault: configured === null, keys: await readSourceKeys() });
}));

router.put('/sources', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (body.reset === true) {
        // Forget the configured list entirely → back to the fallback chain (official default catalog).
        // This is distinct from saving an EMPTY list, which is honored as "no sources at all".
        await deleteOption('marketplace_sources');
        catalogCache = null;
        return res.json({ configured: [], default: DEFAULT_REMOTE, usingDefault: true, keys: await readSourceKeys() });
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
    const keyError = await saveSourceKeys(body.keys, clean);
    if (keyError) return res.status(400).json({ error: keyError });
    await updateOption('marketplace_sources', clean);
    catalogCache = null; // force a fresh merge on the next browse
    themesCatalogCache = null; // the key map is shared with the theme list
    // An explicitly saved list — even an empty one — is never "the default": [] = no sources.
    res.json({ configured: clean, default: DEFAULT_REMOTE, usingDefault: false, keys: await readSourceKeys() });
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
 *                 keys:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                   description: The Ed25519 public key pinned per source URL. A source with a pinned key must serve a valid detached signature or its catalog is refused.
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
 *               keys:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *                 description: Optional. Pins (or, with an empty string, unpins) the Ed25519 public key of a source in this list, as base64 (raw 32 bytes or SPKI DER) or PEM. Shared between the plugin and theme lists, keyed by URL.
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
 *                 keys:
 *                   type: object
 *                   additionalProperties:
 *                     type: string
 *                   description: The Ed25519 public key pinned per source URL. A source with a pinned key must serve a valid detached signature or its catalog is refused.
 *       401:
 *         description: Not logged in (rest_not_logged_in)
 *       403:
 *         description: Not an administrator
 *       400:
 *         description: sources is not an array, or one of the URLs is not an acceptable remote
 */
router.get('/themes/sources', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const configured = await readConfiguredThemeSources();
    res.json({ configured: configured || [], default: DEFAULT_REMOTE, usingDefault: configured === null, keys: await readSourceKeys() });
}));

router.put('/themes/sources', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const body = req.body || {};
    if (body.reset === true) {
        await deleteOption('marketplace_theme_sources');
        themesCatalogCache = null;
        return res.json({ configured: [], default: DEFAULT_REMOTE, usingDefault: true, keys: await readSourceKeys() });
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
    const keyError = await saveSourceKeys(body.keys, clean);
    if (keyError) return res.status(400).json({ error: keyError });
    await updateOption('marketplace_theme_sources', clean);
    themesCatalogCache = null;
    catalogCache = null; // the key map is shared with the plugin list
    res.json({ configured: clean, default: DEFAULT_REMOTE, usingDefault: false, keys: await readSourceKeys() });
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
    const sourceKeys = await readSourceKeys();
    for (const s of srcs) {
        try {
            const { list, signature } = await loadCatalog(s.url, s.isLocal, THEMES_INDEX_FILE, catalogSignaturePolicy(s.url, s.isLocal, sourceKeys));
            let added = 0;
            for (const e of list) {
                const id = String(e.id || '');
                if (!id || seen.has(id)) continue;
                seen.add(id);
                merged.push({ ...e, source: s.url, catalogSignature: signature });
                added++;
            }
            sources.push({ url: s.url, isLocal: s.isLocal, ok: true, count: list.length, added, signature });
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
 *                       signature:
 *                         type: string
 *                         enum: [verified, unsigned]
 *                         description: verified when the index carried a detached Ed25519 signature that verified against the key for this source (the embedded official key, or the key the administrator pinned for it). unsigned when no key applies, or the official key is not configured yet. A source whose signature is required but missing, or present but invalid, is reported with ok false instead.
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
                updateAvailable: !!(installed && installedVersion && e.version && isNewerVersion(e.version, installedVersion)),
            };
        });
        const first = sources[0] || {};
        res.json({ source: first.url || '', isLocal: !!first.isLocal, sources, count: annotated.length, themes: annotated });
    } catch (e: any) {
        log.error({ err: e }, '[marketplace] theme catalog read failed');
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
        log.error({ err: e }, '[marketplace] theme catalog read failed');
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
        log.error({ err: e }, '[marketplace] theme download failed');
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
module.exports.isNewerVersion = isNewerVersion;
module.exports.isLowerVersion = isLowerVersion;
module.exports.catalogSignaturePolicy = catalogSignaturePolicy;
module.exports.OFFICIAL_CATALOG_PUBLIC_KEY = OFFICIAL_CATALOG_PUBLIC_KEY;
/**
 * TEST SEAM ONLY: stand in for the embedded official public key (null restores the constant). Lets the
 * tests exercise the "official key configured" policy while the shipped constant is still empty. Drops
 * both catalog caches so the next read applies the new key.
 */
module.exports.__setOfficialCatalogKeyForTests = (key: string | null): void => {
    officialCatalogKeyOverride = key;
    catalogCache = null;
    themesCatalogCache = null;
};

module.exports._fetchRemote = fetchRemote; // tests: the download bounds, driven directly
