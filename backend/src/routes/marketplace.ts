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
const { getOption } = require('../core/options');
const { getAllPlugins } = require('../core/plugins');
const { installPluginFromZip } = require('./plugins');

const INDEX_FILE = 'marketplace-index.json';
// The catalog lives IN the repo (committed marketplace/dist/), so plugin releases are decoupled
// from core releases: merging a plugin update to main updates every site's catalog immediately.
// Tagged releases ALSO attach a snapshot of these assets, so a site can pin a fixed catalog by
// setting marketplace_source to https://github.com/jaimemartinez/wordjs/releases/download/vX.Y.Z.
const DEFAULT_REMOTE = 'https://raw.githubusercontent.com/jaimemartinez/wordjs/main/marketplace/dist';
// Repo-local dist (present in dev checkouts / self-hosted full clones).
const LOCAL_DIST = path.resolve(__dirname, '../../../marketplace/dist');
const MAX_ZIP_BYTES = 10 * 1024 * 1024; // mirror the upload route's multer cap
const CACHE_TTL_MS = 5 * 60 * 1000;

// Catalog entry filenames are produced by our own build script; enforce that shape strictly so a
// hostile/compromised catalog cannot point installs at arbitrary paths (local mode) or smuggle
// separators. The slug segment mirrors routes/plugins.ts isValidSlug.
const SAFE_FILE_RE = /^[A-Za-z0-9_-]+-[A-Za-z0-9][A-Za-z0-9.-]*\.zip$/;

async function resolveSource(): Promise<{ source: string; isLocal: boolean }> {
    const configured = String((await getOption('marketplace_source', '')) || '').trim();
    if (configured) {
        return { source: configured.replace(/\/+$/, ''), isLocal: !/^https?:\/\//i.test(configured) };
    }
    if (fs.existsSync(path.join(LOCAL_DIST, INDEX_FILE))) {
        return { source: LOCAL_DIST, isLocal: true };
    }
    return { source: DEFAULT_REMOTE, isLocal: false };
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

// In-memory catalog cache (keyed by source) so browsing the tab doesn't hammer GitHub.
let catalogCache: { key: string; at: number; list: any[] } | null = null;

async function getCatalog(refresh = false): Promise<{ list: any[]; source: string; isLocal: boolean }> {
    const { source, isLocal } = await resolveSource();
    if (!refresh && catalogCache && catalogCache.key === source && Date.now() - catalogCache.at < CACHE_TTL_MS) {
        return { list: catalogCache.list, source, isLocal };
    }
    const list = await loadCatalog(source, isLocal);
    catalogCache = { key: source, at: Date.now(), list };
    return { list, source, isLocal };
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
        const { list, source, isLocal } = await getCatalog(refresh);
        const installed = await getAllPlugins();
        const bySlug = new Map<string, any>(installed.map((p: any) => [String(p.slug || p.id), p]));
        const annotated = list.map((e: any) => {
            const local = bySlug.get(String(e.id));
            return {
                ...e,
                installed: !!local,
                active: !!(local && local.active),
                installedVersion: local ? local.version || null : null,
                updateAvailable: !!(local && local.version && e.version && String(local.version) !== String(e.version)),
            };
        });
        res.json({ source, isLocal, count: annotated.length, plugins: annotated });
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
    let source: string, isLocal: boolean;
    try {
        const cat = await getCatalog(false);
        source = cat.source; isLocal = cat.isLocal;
        entry = cat.list.find((e: any) => String(e.id) === id);
    } catch (e: any) {
        return res.status(502).json({ error: e.message });
    }
    if (!entry) return res.status(404).json({ error: `El plugin "${id}" no está en el catálogo.` });

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

module.exports = router;
