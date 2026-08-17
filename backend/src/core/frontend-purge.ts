/**
 * On-demand frontend cache purge (Fase 1 of the performance program).
 *
 * The public frontend serves HTML from Next's Full-Route Cache and JSON from its Data Cache, both
 * tagged (see frontend/src/lib/server-api.ts: 'settings', 'posts', 'post:<slug>', 'menus', …) and
 * bounded by a 60s revalidate. This module makes changes INSTANT instead of eventually-consistent:
 * content hooks enqueue the affected tags/paths, and a debounced flush POSTs them to the
 * frontend's /api/revalidate route, authenticated with a shared secret.
 *
 * Delivery has two shapes, picked by purgeTransport():
 *  - DIRECT (monolith, and a split whose frontend sits on this same host): POST straight at the
 *    frontend's own origin. Shortest path, unchanged.
 *  - VIA THE GATEWAY (separate mode): a cluster-enrolled backend has no idea where the frontend nodes
 *    live — its `frontendUrl` is the gateway's PUBLIC origin, whose /api prefix routes right back here,
 *    and there may be N frontend replicas. So it asks the gateway over the internal mTLS channel it
 *    already uses for /register (POST /purge), and the gateway fans the purge out to every frontend in
 *    its registry. The backend guesses nothing and no new secret or discovery mechanism is introduced.
 *
 * Security model:
 *  - The secret lives in wordjs-config.json (`revalidateSecret`) — the file is already the trust anchor
 *    for jwtSecret and is never readable by plugins (io-guard) or served. On a single host this module
 *    generates it on first use; in a cluster the GATEWAY owns it and enrollment writes the same value
 *    into every node's config (so the frontend can verify a purge from its own disk).
 *  - The purge endpoint can only INVALIDATE caches (forcing a re-render) — it can never inject
 *    content — so the blast radius of a leaked secret is extra renders, not integrity loss.
 *  - HTTPS frontends (split/separate) are verified against the cluster CA with the same
 *    CN allowlist model the gateway uses. No rejectUnauthorized:false anywhere. The gateway leg uses
 *    this node's CN=backend client certificate — the gateway authorizes the purge by that identity.
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

type PurgeTransport =
    | { mode: 'direct'; origin: string }
    | { mode: 'gateway'; host: string; port: number };

/**
 * Where does a purge from THIS node go?
 *
 * Exported for tests — the caller supplies the config, the environment and the certificate-existence
 * check, so the decision can be exercised without a cluster on disk.
 */
function purgeTransport(
    cfg: any,
    env: any = process.env,
    certExists: (p: string) => boolean = fs.existsSync
): PurgeTransport {
    // Monolith serves Next itself on its public port (monolith.js exports it as PORT) — the
    // config's frontendUrl is the SPLIT-mode frontend (3001) and would be a dead target here.
    if (env.WORDJS_MODE === 'mono' && env.PORT) {
        return { mode: 'direct', origin: `http://127.0.0.1:${env.PORT}` };
    }
    const c = cfg || {};
    // Cluster-enrolled node (scripts/node-join.js) — same predicate the installer uses to decide that
    // enrollment, not single-host defaults, is authoritative (routes/setup.ts isEnrolledConfig). Here it
    // means: the frontend is on ANOTHER machine, so this node must not try to guess its address. The
    // gateway holds the registry; ask it.
    if (c.advertiseHost && c.mtls && c.mtls.cert && c.gatewayHost && certExists(path.resolve(c.mtls.cert))) {
        return { mode: 'gateway', host: String(c.gatewayHost), port: Number(c.gatewayInternalPort) || 3100 };
    }
    return { mode: 'direct', origin: String(c.frontendUrl || 'http://localhost:3000').replace(/\/+$/, '') };
}

/** Log a delivery failure at most once an hour — a purge that cannot be delivered is a TTL fallback,
 *  not an error, but it must never fail SILENTLY. */
function warnOnce(message: string) {
    if (Date.now() - lastFailureLog > 3600_000) {
        lastFailureLog = Date.now();
        console.warn(`[Purge] ${message} (content stays TTL-fresh)`);
    }
}

/**
 * Fire one purge request. Never throws, never rejects: the write path must not depend on it.
 * The (small) response body is collected — the gateway answers with a per-node delivery report and
 * silently discarding it would hide a cluster that accepted the purge but could not deliver it.
 */
function send(options: any, body: string, onDone: (res: any, text: string) => void) {
    try {
        const mod = options.protocol === 'http:' ? require('http') : require('https');
        const req = mod.request(options, (res: any) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => { if (text.length < 4096) text += c; });
            res.on('end', () => onDone(res, text));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', (e: any) => warnOnce(`delivery failed: ${e && e.message}`));
        req.write(body);
        req.end();
    } catch { /* never let a purge failure touch the write path */ }
}

/** DIRECT delivery to a co-located frontend (monolith / single-host split). Unchanged behaviour. */
function deliverDirect(origin: string, body: string, secret: string) {
    let url: URL;
    try { url = new URL(origin + '/api/revalidate'); } catch { return; }

    const isHttps = url.protocol === 'https:';
    const options: any = {
        protocol: url.protocol,
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
    send(options, body, (res: any, _text: string) => {
        if (res.statusCode !== 200) warnOnce(`frontend /api/revalidate answered ${res.statusCode}`);
    });
}

/**
 * The mTLS request options for asking the gateway to fan a purge out (separate mode).
 *
 * Same channel, same client identity and the same verification the /register call uses (index.ts): the
 * cluster CA plus this node's CN=backend certificate. Returns null when the material is unreadable, so
 * the caller can degrade to TTL instead of throwing. Exported for tests.
 */
function gatewayPurgeOptions(cfg: any, target: { host: string; port: number }, byteLength: number): any {
    try {
        return {
            protocol: 'https:',
            method: 'POST',
            hostname: target.host,
            port: target.port,
            path: '/purge',
            timeout: PURGE_TIMEOUT_MS,
            ca: fs.readFileSync(path.resolve(cfg.mtls.ca)),
            key: fs.readFileSync(path.resolve(cfg.mtls.key)),
            cert: fs.readFileSync(path.resolve(cfg.mtls.cert)),
            rejectUnauthorized: true,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': byteLength,
            },
        };
    } catch {
        return null;
    }
}

/** VIA THE GATEWAY: it owns the registry of frontend nodes and the shared secret, so it delivers. */
function deliverViaGateway(cfg: any, target: { host: string; port: number }, body: string) {
    const options = gatewayPurgeOptions(cfg, target, Buffer.byteLength(body));
    if (!options) {
        warnOnce('cluster mTLS material unreadable — cannot ask the gateway to purge');
        return;
    }
    send(options, body, (res: any, text: string) => {
        if (res.statusCode !== 200) {
            warnOnce(`gateway /purge answered ${res.statusCode}`);
            return;
        }
        // A 200 only means the gateway ACCEPTED the purge. Its report says how many frontend nodes it
        // actually reached — a cluster with no registered frontend, or one whose node refused the shared
        // secret, is still a TTL fallback and must not pass as success.
        try {
            const report = JSON.parse(text);
            if (!report.targets) warnOnce('gateway has no frontend node registered');
            else if (report.failed) warnOnce(`gateway reached ${report.delivered}/${report.targets} frontend node(s)`);
        } catch { /* unparseable report — the gateway logs the detail on its side */ }
    });
}

function flush() {
    flushTimer = null;
    const tags = [...pendingTags];
    const paths = [...pendingPaths];
    pendingTags = new Set();
    pendingPaths = new Set();
    if (!tags.length && !paths.length) return;

    const cfg = getConfig();
    if (!cfg) return; // not installed yet — nothing to purge

    const body = JSON.stringify({ tags, paths });
    const target = purgeTransport(cfg);
    if (target.mode === 'gateway') {
        // The gateway holds the shared secret and presents it to each frontend it fans out to; this
        // node's certificate is the authorization, so no secret travels on this leg.
        deliverViaGateway(cfg, target, body);
        return;
    }
    const secret = ensureSecret();
    if (!secret) return;
    deliverDirect(target.origin, body, secret);
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

/**
 * The public URL path(s) one post is actually served at, read off the frontend's REAL route map
 * (frontend/src/app/(public)):
 *
 *   (public)/[slug]        → `/<slug>`         — posts and every custom post type
 *   (public)/pages/[slug]  → `/pages/<slug>`   — pages; the URL the admin's menu builder emits
 *
 * A PAGE is live at both: `/pages/<slug>` is what the site links to, and the catch-all `/<slug>`
 * resolves it too (the backend's /posts/slug/:slug is not type-filtered) — which is also the
 * canonical the page's own <head> declares. Both are real, so both are purged.
 *
 * This used to be one hardcoded `/<postName>` for EVERY type. Right for a post, wrong for a page:
 * `/about` was purged and `/pages/about` — the URL the menu points at — was not. Nothing looked
 * broken because the `post:<slug>` TAG covers every route that rendered the post (Next invalidates
 * by tag across routes), so the path was pure decoration: a claim in the purge logs that matched no
 * route. Derive it from the route map instead of assuming, and it stays true when routes move.
 *
 * Exported for tests.
 */
function publicPathsForPost(post: { postName?: string; postType?: string } | null | undefined): string[] {
    const slug = post && post.postName ? String(post.postName) : '';
    if (!slug) return [];
    if (String(post && post.postType) === 'page') return [`/pages/${slug}`, `/${slug}`];
    return [`/${slug}`];
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
                paths.push(...publicPathsForPost(post));
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
    'site_chrome_header', 'site_chrome_footer', 'site_chrome_announcement',
    // These two land on <html> itself, so a change repaints every cached page — and being absent here
    // is worse than it sounds: switching a site to Arabic would have left every already-rendered page
    // announcing lang="en" and laying out LTR until the ISR window happened to expire.
    'WPLANG', 'site_text_direction',
    // Interaction presets (F9): a block stores only the preset's ID, so editing one changes NOTHING
    // in `_puck_data` — the whole point of the design. The propagation therefore rides entirely on
    // this purge: every page that references the preset recompiles its interaction CSS (with a new
    // content hash, so the browser cannot serve the old sheet) on its next navigation. Without this
    // entry the edit would be invisible until each page's ISR window happened to expire.
    'wjs_ix_presets',
    // Transiciones entre páginas (C1): su CSS lo emite el LAYOUT público en el servidor, así que un
    // cambio solo se ve cuando la página se vuelve a renderizar. Y la variante entre documentos
    // necesita la regla en los DOS documentos: sin esta purga, encenderla dejaría medio sitio con
    // la regla y medio sin ella — es decir, sin transición y sin explicación.
    'wjs_view_transitions',
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
        // nav_menu_locations is deliberately NOT in SETTINGS_OPTIONS: it is not part of the public
        // settings payload, so purging 'settings' would be the wrong tag. Re-wiring which menu a
        // location serves must invalidate the MENU caches instead — the broad 'menus' tag covers
        // every menu:<ref> entry because both frontend fetches declare it (server-api.ts). The
        // /menus routes also purge directly; this hook covers non-route writers (Menu.setLocation
        // from the importer, plugins) so the option can never change silently under a cached nav.
        if (String(name) === 'nav_menu_locations') purgeFrontend(['menus']);
    });
}

module.exports = { initFrontendPurge, purgeFrontend, purgeForPost, publicPathsForPost, purgeTransport, gatewayPurgeOptions };
