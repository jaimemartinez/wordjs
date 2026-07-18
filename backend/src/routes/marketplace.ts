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

const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const { getOption, updateOption } = require('../core/options');
const { getAllPlugins } = require('../core/plugins');
const { installPluginFromZip } = require('./plugins');

const INDEX_FILE = 'marketplace-index.json';
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

/** Read the admin-configured marketplace source list (option `marketplace_sources`, a JSON array). */
async function readConfiguredSources(): Promise<string[]> {
    const raw = await getOption('marketplace_sources', null);
    let list: any[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim()) { try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* ignore */ } }
    return list.map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * Resolve the ORDERED list of catalog sources to browse/install from. Precedence:
 *   1. The admin-configured list (option `marketplace_sources`, managed from the Marketplace UI — no
 *      hard-coded URL; the admin points WordJS at any number of catalogs, official or private).
 *   2. The legacy single option `marketplace_source` (back-compat).
 *   3. The repo-local dist (dev / full checkout).
 *   4. The built-in default (GitHub release assets) — a starting point, fully overridable.
 * A source is https (fetched) or a local dir (read); the UI only ever writes https URLs.
 */
async function resolveSources(): Promise<{ url: string; isLocal: boolean }[]> {
    const configured = await readConfiguredSources();
    if (configured.length) {
        return configured.slice(0, MAX_SOURCES).map((url) => ({ url, isLocal: !/^https?:\/\//i.test(url) }));
    }
    const single = String((await getOption('marketplace_source', '')) || '').trim().replace(/\/+$/, '');
    if (single) return [{ url: single, isLocal: !/^https?:\/\//i.test(single) }];
    if (fs.existsSync(path.join(LOCAL_DIST, INDEX_FILE))) return [{ url: LOCAL_DIST, isLocal: true }];
    return [{ url: DEFAULT_REMOTE, isLocal: false }];
}

/** Only https (or localhost http for dev) — the fetch runs from the HOST, so keep it boring. */
function assertSaneRemote(url: string) {
    let u: any;
    try { u = new URL(url); } catch { throw new Error('URL de marketplace inválida.'); }
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) {
        throw new Error('La fuente del marketplace debe ser https:// (o http://localhost en desarrollo).');
    }
}

async function fetchRemote(url: string, maxBytes: number): Promise<Buffer> {
    assertSaneRemote(url);
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'WordJS-Marketplace' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${new URL(url).pathname}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('El archivo descargado excede el tamaño máximo permitido.');
    return buf;
}

async function loadCatalog(source: string, isLocal: boolean): Promise<any[]> {
    let raw: string;
    if (isLocal) {
        const idxPath = path.join(path.resolve(source), INDEX_FILE);
        if (!fs.existsSync(idxPath)) throw new Error(`No se encontró ${INDEX_FILE} en ${source}. Ejecuta "npm run build:marketplace".`);
        raw = fs.readFileSync(idxPath, 'utf8');
    } else {
        raw = (await fetchRemote(`${source}/${INDEX_FILE}`, 2 * 1024 * 1024)).toString('utf8');
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed.plugins;
    if (!Array.isArray(list)) throw new Error('El índice del marketplace tiene un formato inválido.');
    return list;
}

// In-memory catalog cache (keyed by the ordered source set) so browsing doesn't re-hammer the network.
let catalogCache: { key: string; at: number; merged: any[]; sources: any[] } | null = null;

async function getCatalog(refresh = false): Promise<{ merged: any[]; sources: any[] }> {
    const srcs = await resolveSources();
    const key = srcs.map((s) => s.url).join('|');
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
            let added = 0;
            for (const e of list) {
                const id = String(e.id || '');
                if (!id || seen.has(id)) continue;
                seen.add(id);
                merged.push({ ...e, source: s.url }); // each entry remembers its source (used at install)
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
 *     tags: [Plugins]
 */
router.get('/catalog', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    try {
        const refresh = String((req.query as any).refresh || '') === '1';
        const { merged, sources } = await getCatalog(refresh);
        const installed = await getAllPlugins();
        const bySlug = new Map<string, any>(installed.map((p: any) => [String(p.slug || p.id), p]));
        const annotated = merged.map((e: any) => {
            const local = bySlug.get(String(e.id));
            return {
                ...e,
                installed: !!local,
                active: !!(local && local.active),
                installedVersion: local ? local.version || null : null,
                updateAvailable: !!(local && local.version && e.version && String(local.version) !== String(e.version)),
            };
        });
        // `source`/`isLocal` are kept for back-compat (the primary source); `sources` carries per-source status.
        const first = sources[0] || {};
        res.json({ source: first.url || '', isLocal: !!first.isLocal, sources, count: annotated.length, plugins: annotated });
    } catch (e: any) {
        res.status(502).json({ error: e.message });
    }
}));

/**
 * @swagger
 * /marketplace/install:
 *   post:
 *     summary: Download a catalog plugin and install it through the standard upload pipeline
 *     tags: [Plugins]
 */
router.post('/install', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const id = String((req.body || {}).id || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta el id del plugin.' });

    let entry: any;
    try {
        const { merged } = await getCatalog(false);
        entry = merged.find((e: any) => String(e.id) === id);
    } catch (e: any) {
        return res.status(502).json({ error: e.message });
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
        return res.status(502).json({ error: `No se pudo descargar el plugin: ${e.message}` });
    }

    if (entry.sha256) {
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        if (digest !== String(entry.sha256).toLowerCase()) {
            return res.status(400).json({ error: 'La verificación de integridad (sha256) del paquete falló — instalación abortada.' });
        }
    }

    // Hand off to the shared upload pipeline via a temp file (it owns cleanup of that file).
    const tmpPath = path.join(os.tmpdir(), `wjs-mkt-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
    fs.writeFileSync(tmpPath, buf);
    const result = await installPluginFromZip(tmpPath, file);
    res.status(result.status).json(result.body);
}));

/**
 * @swagger
 * /marketplace/sources:
 *   get:
 *     summary: Get the admin-configured marketplace source URLs (+ the built-in default)
 *     tags: [Plugins]
 *   put:
 *     summary: Replace the marketplace source URLs (admin). Each must be https (or http://localhost).
 *     tags: [Plugins]
 */
router.get('/sources', authenticate, isAdmin, asyncHandler(async (_req: Request, res: Response) => {
    const configured = await readConfiguredSources();
    res.json({ configured, default: DEFAULT_REMOTE, usingDefault: configured.length === 0 });
}));

router.put('/sources', authenticate, isAdmin, asyncHandler(async (req: Request, res: Response) => {
    const arr = (req.body || {}).sources;
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
    res.json({ configured: clean, default: DEFAULT_REMOTE, usingDefault: clean.length === 0 });
}));

module.exports = router;
