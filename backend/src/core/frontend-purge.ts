/**
 * On-demand frontend cache purge (Fase 1 of the performance program).
 *
 * The public frontend serves HTML from Next's Full-Route Cache and JSON from its Data Cache, both
 * tagged (see frontend/src/lib/server-api.ts: 'settings', 'posts', 'post:<slug>', 'menus', …) and
 * bounded by a 60s revalidate. This module makes changes INSTANT instead of eventually-consistent:
 * content hooks enqueue the affected tags/paths, and a debounced flush POSTs them to the
 * frontend's /api/revalidate route, authenticated with a shared secret.
 *
 * Security model:
 *  - The secret lives in wordjs-config.json (`revalidateSecret`), generated here on first use and
 *    written through saveConfig() — the file is already the trust anchor for jwtSecret and is never
 *    readable by plugins (io-guard) or served.
 *  - The purge endpoint can only INVALIDATE caches (forcing a re-render) — it can never inject
 *    content — so the blast radius of a leaked secret is extra renders, not integrity loss.
 *  - HTTPS frontends (split/separate) are verified against the cluster CA with the same
 *    CN allowlist model the gateway uses. No rejectUnauthorized:false anywhere.
 *  - Purging is fire-and-forget and debounced (1.5s): a WXR import touching 500 posts produces one
 *    coalesced purge, not 500 — and a frontend that is down just means TTL freshness, never errors
 *    in the write path.
 */

import * as fs from 'fs';
import * as path from 'path';

const crypto = require('crypto');
const { getConfig, saveConfig } = require('./configManager');
const { addAction } = require('./hooks');

const FLUSH_DELAY_MS = 1500;
const PURGE_TIMEOUT_MS = 3000;

let pendingTags = new Set<string>();
let pendingPaths = new Set<string>();
let flushTimer: any = null;
let lastFailureLog = 0;

/** The shared secret, generating + persisting it on first use. Null until the site is installed. */
function ensureSecret(): string | null {
    const cfg = getConfig();
    if (!cfg) return null;
    if (cfg.revalidateSecret) return String(cfg.revalidateSecret);
    const secret = crypto.randomBytes(32).toString('hex');
    return saveConfig({ revalidateSecret: secret }) ? secret : null;
}

function frontendOrigin(): string {
    // Monolith serves Next itself on its public port (monolith.js exports it as PORT) — the
    // config's frontendUrl is the SPLIT-mode frontend (3001) and would be a dead target here.
    if (process.env.WORDJS_MODE === 'mono' && process.env.PORT) {
        return `http://127.0.0.1:${process.env.PORT}`;
    }
    const cfg = getConfig() || {};
    return String(cfg.frontendUrl || 'http://localhost:3000').replace(/\/+$/, '');
}

function flush() {
    flushTimer = null;
    const tags = [...pendingTags];
    const paths = [...pendingPaths];
    pendingTags = new Set();
    pendingPaths = new Set();
    if (!tags.length && !paths.length) return;

    const secret = ensureSecret();
    if (!secret) return; // not installed yet — nothing to purge

    const origin = frontendOrigin();
    let url: URL;
    try { url = new URL(origin + '/api/revalidate'); } catch { return; }

    const body = JSON.stringify({ tags, paths });
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? require('https') : require('http');
    const options: any = {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        timeout: PURGE_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-revalidate-secret': secret,
        },
    };
    if (isHttps) {
        // Split/separate frontends serve the cluster-CA cert with a service CN (not an IP SAN) —
        // verify the chain against that CA and allowlist the CN, exactly like the gateway does.
        try {
            const caPath = path.resolve('certs', 'cluster-ca.crt');
            if (fs.existsSync(caPath)) {
                options.ca = fs.readFileSync(caPath);
                options.checkServerIdentity = (_h: string, cert: any) => {
                    const cn = cert && cert.subject && cert.subject.CN;
                    return ['frontend', 'gateway'].includes(cn) ? undefined
                        : new Error(`purge: unexpected upstream CN '${cn}'`);
                };
            }
        } catch { /* CA unavailable — default verification applies */ }
    }

    try {
        const req = mod.request(options, (res: any) => {
            res.resume(); // drain
            if (res.statusCode !== 200 && Date.now() - lastFailureLog > 3600_000) {
                lastFailureLog = Date.now();
                console.warn(`[Purge] frontend /api/revalidate answered ${res.statusCode} (content stays TTL-fresh)`);
            }
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => {
            if (Date.now() - lastFailureLog > 3600_000) {
                lastFailureLog = Date.now();
                console.warn('[Purge] frontend unreachable for cache purge (content stays TTL-fresh)');
            }
        });
        req.write(body);
        req.end();
    } catch { /* never let a purge failure touch the write path */ }
}

/** Queue tags/paths for the next debounced flush. */
function purgeFrontend(tags: string[] = [], paths: string[] = []) {
    for (const t of tags) if (t) pendingTags.add(String(t));
    for (const p of paths) if (p && String(p).startsWith('/')) pendingPaths.add(String(p));
    if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
        if (flushTimer.unref) flushTimer.unref();
    }
}

/** Tags/paths affected by a change to one post. Falls back to the broad 'posts' tag on any gap. */
async function purgeForPost(postId: any) {
    const tags = ['posts'];
    const paths = ['/'];
    try {
        const Post = require('../models/Post');
        const post = await Post.findById(postId);
        if (post) {
            if (post.postName) {
                tags.push(`post:${post.postName}`);
                paths.push(`/${post.postName}`);
            }
            tags.push(`post:${post.id}`, `posts:${post.postType}`);
        }
    } catch { /* deleted or unreadable — the broad tags above still purge lists */ }
    purgeFrontend(tags, paths);
}

// Options whose change alters the public chrome/canvas — anything else (cron bookkeeping, plugin
// state) must NOT purge, or background jobs would evict the cache constantly.
// NOT here, deliberately: `active_theme_version` (public settings payload) is DERIVED from the
// active theme's theme.json, not an option row, so no updated_option hook can ever carry it. It
// moves on activation (covered by 'template'/'stylesheet') and on an in-place theme rebuild, where
// PUT /api/v1/themes/:slug purges 'settings' explicitly — the same pattern DELETE /chrome/:part uses.
const SETTINGS_OPTIONS = new Set([
    'blogname', 'blogdescription', 'siteurl', 'home', 'homepage_id', 'posts_per_page',
    'template', 'stylesheet', 'active_theme_layout', 'active_theme_mods', 'theme_mods',
    'site_logo', 'site_icon', 'permalink_structure', 'default_category',
    'site_chrome_header', 'site_chrome_footer',
    // These two land on <html> itself, so a change repaints every cached page — and being absent here
    // is worse than it sounds: switching a site to Arabic would have left every already-rendered page
    // announcing lang="en" and laying out LTR until the ISR window happened to expire.
    'WPLANG', 'site_text_direction',
]);

/** Wire the content hooks. Call ONCE from initialize() after the hook system is up. */
function initFrontendPurge() {
    addAction('wp_insert_post', async (postId: any) => { await purgeForPost(postId); });
    addAction('post_updated', async (postId: any) => { await purgeForPost(postId); });
    addAction('deleted_post', async (postId: any) => {
        // row is gone — slug unknown; the broad tags cover every list/detail that could show it
        purgeFrontend(['posts'], ['/']);
        void postId;
    });
    addAction('updated_option', async (name: any) => {
        if (SETTINGS_OPTIONS.has(String(name))) purgeFrontend(['settings'], ['/']);
    });
}

module.exports = { initFrontendPurge, purgeFrontend };
