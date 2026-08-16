/**
 * WordJS - Main Application Entry Point (Reloaded)
 * A WordPress-like CMS built with Node.js
 */

import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config();

// Import configuration
const config = require('./config/app');

// When embedded in the single-process monolith (../monolith.js sets WORDJS_EMBEDDED=1), this module
// is required to obtain the configured Express app and mounted in-process — it must NOT self-listen on
// config.port nor self-register with the gateway. Split mode (run via backend/server.js → dist/index.js)
// leaves WORDJS_EMBEDDED unset, so all behavior below is byte-for-byte unchanged.
const EMBEDDED = process.env.WORDJS_EMBEDDED === '1';

// SECURITY: Initialize IO Guard before anything else
require('./core/io-guard');

// SECURITY: Install runtime module interception for fs/child_process
const { installSecureRequire } = require('./core/secure-require');
installSecureRequire();

// SECURITY: Install CrashGuard runtime blame handlers for async error tracking
const CrashGuard = require('./core/crash-guard');
CrashGuard.installRuntimeBlameHandlers();

const { initSqlJsDb, initializeDatabase, db, saveDatabase } = require('./config/database');

// Import middleware
const { notFound, errorHandler } = require('./middleware/errorHandler');

// Import routes
const routes = require('./routes');

// Import core modules
const { initDefaultOptions } = require('./core/options');
const { doAction } = require('./core/hooks');
const { setApp } = require('./core/appRegistry');

// Create Express app
const app = express();

// Register app for plugins to access
setApp(app);

const rateLimit = require('express-rate-limit');
const { clientIp, resolveTrustProxy } = require('./core/client-ip');

// TRUST PROXY — from the single source of truth, NOT a hard-coded `1`. In the monolith there is no
// fronting proxy, so trusting one X-Forwarded-For hop trusted a header the CLIENT wrote: an attacker
// rotated it to mint a fresh rate-limit / lockout bucket per request. resolveTrustProxy() returns
// `false` (trust nothing → key on the TCP peer) in embedded mode, `1` behind the gateway, or the
// operator's explicit WORDJS_TRUST_PROXY / config value. See core/client-ip.ts.
app.set('trust proxy', resolveTrustProxy());

// The honest per-request key for EVERY IP-based limiter below. Keying through clientIp() rather than
// leaving express-rate-limit's default req.ip means the bucket can never diverge from the trust
// decision, even if later middleware rewrites req.ip.
const ipKey = (req: any) => clientIp(req);

// Security Headers
const helmet = require('helmet');
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images to be loaded by frontend
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // unsafe-inline/eval required for some CMS themes/plugins
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:", "blob:", "https:", "*"], // Allow images from everywhere (CMS content)
            connectSrc: ["'self'", "*"], // Allow API calls
            objectSrc: ["'none'"], // Protect against Flash/Applet injections
            upgradeInsecureRequests: [], // Auto-upgrade http to https
        },
    },
}));
app.disable('x-powered-by');

// CORS — zero-config by design. A request's credentialed cross-origin access is granted only when it
// is one of:
//   1) an explicitly CONFIGURED public origin (siteUrl / frontendUrl / gatewayUrl, set post-setup);
//   2) SAME-ORIGIN — the monolith serves the frontend AND the API from ONE origin (incl. behind a
//      reverse proxy), so the install wizard and app calls are same-origin. We detect this by matching
//      the request's Origin hostname to the `Host` header the request arrived on. `Host` is set by the
//      browser to the REAL target and is a forbidden header for fetch/XHR, so cross-origin JS cannot
//      forge it: a cross-site attacker's request carries Origin=attacker but Host=victim and never
//      matches. (Behind a proxy this needs `proxy_set_header Host $host`, which the migration guard
//      also requires — so no per-deployment CORS config is needed for `npx create-wordjs` + nginx.)
//   3) localhost, in development only.
// Reflecting an ARBITRARY origin with credentials:true would be an account-takeover hole, so anything
// else gets no CORS headers (the browser blocks it). We omit the header instead of throwing, so a
// blocked cross-origin probe doesn't spam the logs.
const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const CORS_HEADERS = ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Install-Token'];
const hostnameOnly = (v: string): string => { try { return new URL('http://' + v).hostname.toLowerCase(); } catch { return ''; } };
app.use(cors((req: any, done: any) => {
    const base = { credentials: true, methods: CORS_METHODS, allowedHeaders: CORS_HEADERS };
    const allow = () => done(null, { ...base, origin: true });   // reflect this origin + allow credentials
    const deny = () => done(null, { ...base, origin: false });   // no ACAO → browser blocks (no throw)

    const origin: string | undefined = req.headers.origin;
    if (!origin) return allow(); // no Origin: curl / server-to-server / same-origin navigation — nothing to gate

    // (1) configured public origins
    if ([config.site.url, config.frontendUrl, config.gatewayUrl].filter(Boolean).indexOf(origin) !== -1) return allow();

    let originHost: string;
    try { originHost = new URL(origin).hostname.toLowerCase(); } catch { return deny(); }

    // (2) same-origin (Origin host === the host the request was actually sent to). Behind the gateway
    // (changeOrigin:true) req.headers.host is the internal upstream (127.0.0.1:PORT), so matching on the raw
    // Host would treat ANY `http://127.0.0.1[:port]` page as same-origin and hand it credentialed CORS. Use
    // the gateway-PINNED X-Forwarded-Host first (it strips any client-supplied value), then fall back to Host
    // for the direct monolith — the exact same trusted-host derivation csrfProtection uses, so the two agree.
    const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const effectiveHost = hostnameOnly(fwdHost || req.headers.host || '');
    if (effectiveHost && originHost === effectiveHost) return allow();

    // (3) dev localhost
    if (config.nodeEnv === 'development' && (originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1')) return allow();

    return deny();
}));

// Cookie Parser (for HttpOnly auth cookies)
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// Rate Limiters
// Multi-node: when Redis is configured, back the limiters with a SHARED Redis store so the cap is
// enforced across ALL nodes (otherwise the effective global limit is N× the configured value, e.g.
// brute-force protection weakens with each replica). Falls back to the in-process MemoryStore when
// Redis isn't configured (single node).
function limiterStore(prefix: string): any {
    try {
        const cache = require('./core/cache');
        const client = cache.getClient();
        if (!client) return undefined;
        const { RedisStore } = require('rate-limit-redis');
        return new RedisStore({ sendCommand: (...args: any[]) => client.call(...args), prefix });
    } catch (e: any) {
        console.warn('[rate-limit] Redis store unavailable, using in-memory:', e && e.message);
        return undefined;
    }
}

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per 15 mins
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    store: limiterStore('rl:api:'),
    passOnStoreError: true, // if the Redis store errors (outage), ALLOW the request rather than 500 the whole API
    message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Limit each IP to 10 attempts per hour on the abuse-prone unauthenticated endpoints
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    store: limiterStore('rl:auth:'),
    passOnStoreError: true,
    message: { error: 'Too many attempts, please try again later.' }
});

// Login/MFA per-IP backstop. Unlike authLimiter this counts ONLY FAILED attempts
// (skipSuccessfulRequests) and at a much higher cap, so several users behind one public IP who log in
// fine are NEVER throttled — fixing the "shared IP locks everyone out" complaint — while a single IP
// spraying passwords across many accounts is still bounded. The fine-grained escalating lockout is
// per-(IP+account) inside routes/auth.ts; this is only the coarse anti-spray net.
const loginIpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: config.auth.loginIpFailPerHour,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    store: limiterStore('rl:loginip:'),
    passOnStoreError: true,
    skipSuccessfulRequests: true, // only failed logins count toward the cap
    message: { error: 'Too many failed login attempts from your network, please try again later.' }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // Limit each IP to 50 uploads per hour
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    store: limiterStore('rl:upload:'),
    passOnStoreError: true,
    message: { error: 'Too many file uploads, please try again later.' }
});

// Public form submissions (POST /forms/submit is unauthenticated and bot-attractive): a per-IP cap far
// tighter than the global apiLimiter, but generous for a human filling a contact form.
const formsSubmitLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // Limit each IP to 10 form submissions per minute
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    store: limiterStore('rl:forms:'),
    passOnStoreError: true,
    message: { error: 'Too many form submissions, please try again later.' }
});

const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 20, // tight cap on the PUBLIC install / test-db endpoints (pre-config, unauthenticated)
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKey,
    store: limiterStore('rl:setup:'),
    passOnStoreError: true,
    message: { error: 'Too many setup attempts, please try again later.' }
});

// Apply global API limiter
app.use(config.api.prefix, apiLimiter);

// Login + MFA verify use the FAILED-only per-IP backstop (loginIpLimiter) so shared-IP users who
// authenticate successfully never consume the budget; the escalating per-(IP+account) lockout in
// routes/auth.ts is the primary brute-force control.
app.use(`${config.api.prefix}/auth/login`, loginIpLimiter);
// Scope the brute-force limiter to EXACTLY the second-factor verify (POST /auth/mfa), which is part of the
// unauthenticated login and must be throttled per-IP like /auth/login. Using app.use() here was a PREFIX
// mount that also swallowed the authenticated self-service management routes (/auth/mfa/status polled on
// every account-page load, plus /setup, /enable, /disable, /backup-codes, /policy). A logged-in user
// enabling then disabling their own 2FA burned the shared 10/hr/IP budget and locked THEMSELVES out of
// login. app.post matches the full path exactly, so the sub-routes no longer count. Code-guess brute force
// on those routes is still covered by the per-account 'mfa:' lockout inside routes/auth.ts.
app.post(`${config.api.prefix}/auth/mfa`, loginIpLimiter);
app.use(`${config.api.prefix}/auth/register`, authLimiter);
app.use(`${config.api.prefix}/auth/forgot-password`, authLimiter); // public, unauthenticated — throttle abuse
app.use(`${config.api.prefix}/auth/reset-password`, authLimiter);
app.use(`${config.api.prefix}/auth/verify-email`, authLimiter); // public token-consume — throttle abuse
app.use(`${config.api.prefix}/media`, uploadLimiter);
app.use(`${config.api.prefix}/themes/upload`, uploadLimiter);
app.use(`${config.api.prefix}/plugins/upload`, uploadLimiter);
app.use(`${config.api.prefix}/backups`, uploadLimiter); // Apply limiter to backups too
// #26: /setup/migrate authenticates attacker-supplied admin credentials and — necessarily, per #25 — cannot
// record login failures to trip the account lockout, so it was an unthrottled password oracle. Cap it under the
// strict authLimiter (10/hr/IP) — much tighter than the setupLimiter (20/15min) below. This more-specific mount
// is registered FIRST so authLimiter is the binding constraint; the /setup setupLimiter still also applies
// (defense in depth). Pair with the uniform-response fix in routes/setup.ts.
app.use(`${config.api.prefix}/setup/migrate`, authLimiter);
app.use(`${config.api.prefix}/setup`, setupLimiter); // tight cap on the public install/test-db endpoints
// Exact-path mount (like /auth/mfa above) so the admin's authenticated /forms/submissions viewer never
// consumes the public submit budget.
app.post(`${config.api.prefix}/forms/submit`, formsSubmitLimiter);

// SECURITY: CSRF Protection for all API routes
const { csrfProtection } = require('./middleware/auth');
app.use(config.api.prefix, csrfProtection);

// Parse JSON bodies
app.use(express.json({ limit: '10mb' }));

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
// Serve static files (Deny dotfiles like .git, .env)
// SECURITY: uploaded files are user-controlled, so an attacker could upload an .html/.svg and have it
// execute as a same-origin document (stored XSS) when viewed. Set X-Content-Type-Options: nosniff on
// everything, and force NON-image files to download as an opaque attachment (application/octet-stream
// + Content-Disposition: attachment) so they can never run as a document in this origin. Images keep
// their inline Content-Type so the admin/media UI can still display them.
// SECURITY (defense-in-depth on top of upload-time mime validation): the ONLY real risk when serving
// user uploads from this origin is a file that executes AS A DOCUMENT (.html/.js/.xml → stored XSS).
// Use a DENYLIST of those executable types (forced to download as an opaque attachment) and serve
// EVERYTHING ELSE inline with its correct Content-Type — images, FONTS (.ttf/.woff…), pdf, audio/video,
// json, etc. are not executable as a same-origin document, and forcing them to octet-stream/attachment
// broke legitimate rendering (logos, theme fonts). SVG is special: served as image/svg+xml so it renders
// as a logo/icon, with a sandbox CSP so a direct navigation can't run any embedded script either.
const EXECUTABLE_DOC_EXTS = new Set(['.html', '.htm', '.xhtml', '.xht', '.shtml', '.shtm', '.js', '.mjs', '.cjs', '.xml', '.svgz']);
// AVIF/WebP negotiation runs BEFORE the static handler: for browsers that accept a modern format it serves
// a cached, transcoded derivative (same URL, ~50% fewer bytes); on any error / unsupported / non-raster it
// falls through to express.static below, which serves the original exactly as before.
const { imageNegotiation } = require('./middleware/image-negotiation');
app.use('/uploads', imageNegotiation(config.uploads.dir));
app.use('/uploads', express.static(path.resolve(config.uploads.dir), {
    dotfiles: 'deny',
    // Media filenames are UUID-unique (never overwritten at the same URL), so they are safe to cache
    // aggressively + immutable — a re-upload gets a new URL. Huge repeat-visit / Core-Web-Vitals win.
    maxAge: '365d',
    immutable: true,
    setHeaders: (res: Response, filePath: string) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const ext = path.extname(filePath).toLowerCase();
        // A raster image's URL may serve AVIF/WebP to capable browsers (imageNegotiation above), so a shared
        // cache must key the ORIGINAL response on Accept too — otherwise it could hand an AVIF to a browser
        // that didn't ask for it (or vice-versa).
        if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') res.setHeader('Vary', 'Accept');
        if (ext === '.svg') {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
            return;
        }
        if (EXECUTABLE_DOC_EXTS.has(ext)) {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment');
        }
    }
}));
// app.use('/admin', express.static(path.resolve('./admin'))); // Removed legacy admin
// Theme/plugin assets CAN change in place on update, so cache 1h (not immutable) — the browser reuses
// them for an hour, then ETag-revalidates (cheap 304). Big win without risking stale code after an update.
app.use('/themes', express.static(path.resolve('./themes'), { dotfiles: 'deny', maxAge: '1h' }));

// Plugins declare an admin-page URL slug (manifest.frontend.adminPage.slug) that frequently DIFFERS
// from the on-disk folder (e.g. slug "youtube" → folder "youtube-videos"). The admin shell requests a
// plugin's assets under the SLUG (/plugins/<slug>/client/admin/admin.css, /plugins/<slug>/manifest.json).
// For plugins BAKED into the frontend build the slug→folder map is compiled in, but a plugin installed
// at RUNTIME isn't in that map, so its stylesheet 404s and its admin page renders UNSTYLED. Rewrite the
// leading path segment slug→folder before the static handler so any asset resolves regardless of how the
// plugin was installed (cached; no-op when the segment is already a real folder).
const PLUGINS_ROOT = path.resolve('./plugins');
const adminSlugFolderCache = new Map<string, string>();
// Resolve <folder>/manifest.json under PLUGINS_ROOT, confirming it stays inside the root (path-injection
// barrier). Returns the absolute manifest path, or null if the segment escapes.
function pluginManifestPath(folder: string): string | null {
    const root = path.resolve(PLUGINS_ROOT);
    const p = path.resolve(root, folder, 'manifest.json');
    return p.startsWith(root + path.sep) ? p : null;
}
// NEGATIVE cache: a segment that resolved to nothing costs a readdir + a manifest parse of EVERY
// plugin — and unknown segments are exactly what bot crawls generate. Short TTL so a just-installed
// plugin's slug still resolves within seconds; size-capped so random-segment spam can't grow it.
const adminSlugMissCache = new Map<string, number>();
const SLUG_MISS_TTL_MS = 10_000;
function resolveAdminSlugFolder(seg: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(seg)) return null;                        // reject traversal / odd names
    const missUntil = adminSlugMissCache.get(seg);
    if (missUntil !== undefined) {
        if (missUntil > Date.now()) return null;
        adminSlugMissCache.delete(seg);
    }
    const direct = pluginManifestPath(seg);
    if (direct && fs.existsSync(direct)) return seg;                       // already a folder
    const cached = adminSlugFolderCache.get(seg);
    const cachedPath = cached ? pluginManifestPath(cached) : null;
    if (cachedPath && fs.existsSync(cachedPath)) return cached!;
    let dirs: string[];
    try {
        dirs = fs.readdirSync(PLUGINS_ROOT, { withFileTypes: true })
            .filter((d: any) => d.isDirectory()).map((d: any) => d.name);
    } catch { return null; }
    for (const folder of dirs) {
        if (!/^[a-zA-Z0-9_-]+$/.test(folder)) continue;
        const mp = pluginManifestPath(folder);
        if (!mp) continue;
        try {
            const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
            if (m?.frontend?.adminPage?.slug === seg) { adminSlugFolderCache.set(seg, folder); return folder; }
        } catch { /* unreadable/invalid manifest → skip */ }
    }
    if (adminSlugMissCache.size > 500) adminSlugMissCache.clear();
    adminSlugMissCache.set(seg, Date.now() + SLUG_MISS_TTL_MS);
    return null;
}
app.use('/plugins', (req: any, _res: any, next: any) => {
    const parts = req.url.split('/');           // req.url is post-mount: "/<seg>/rest..." → ['', seg, ...]
    const seg = parts[1] ? decodeURIComponent(parts[1].split('?')[0]) : '';
    if (seg) {
        const folder = resolveAdminSlugFolder(seg);
        if (folder && folder !== seg) { parts[1] = folder; req.url = parts.join('/'); }
    }
    next();
});
app.use('/plugins', express.static(path.resolve('./plugins'), { dotfiles: 'deny', maxAge: '1h' }));
// Serve .well-known (ACME support) - Allow dotfiles. NEVER cache challenge tokens (short-lived, per-order).
app.use('/.well-known', express.static(path.resolve('./public/.well-known'), { dotfiles: 'allow' }));

// Framework assets (wordjs-ui.css etc.) change only on a WordJS update → 1d + ETag revalidation.
// DEV: force revalidation (ETag makes it a cheap 304) — wordjs-ui.css and friends change during
// development but keep the same ?v= until a release bumps ASSET_VERSION, so a 1-day freshness
// window serves day-old block styles to both the canvas iframe and the public preview.
app.use('/public', express.static(path.resolve('./public'), {
    dotfiles: 'deny',
    maxAge: config.nodeEnv === 'development' ? 0 : '1d',
    setHeaders: config.nodeEnv === 'development'
        ? (res: Response) => res.setHeader('Cache-Control', 'no-cache')
        : undefined,
}));

// WORDJS_QUERY_STATS=1: append the DB-query count each request consumed (perf harness — the
// driver increments a global counter). Opt-in by env in ANY mode: the meaningful numbers come
// from PRODUCTION builds (dev caches lie). Approximate under concurrency; exact when benching
// one request at a time, which is how the per-endpoint budget is measured.
if (process.env.WORDJS_QUERY_STATS === '1') {
    app.use((req: Request, res: Response, next: NextFunction) => {
        const start = (globalThis as any).__wjsQueryCount || 0;
        res.on('finish', () => {
            const n = ((globalThis as any).__wjsQueryCount || 0) - start;
            console.log(`${new Date().toISOString()} ${req.method} ${req.path} → ${n} queries`);
        });
        next();
    });
}

// Request logging in development
if (config.nodeEnv === 'development' && process.env.WORDJS_QUERY_STATS !== '1') {
    app.use((req: Request, res: Response, next: NextFunction) => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
        next();
    });
}

// Health check endpoint
app.get('/health', async (req: Request, res: Response) => {
    const SystemHealth = require('./core/system-health');
    const status = await SystemHealth.checkDatabase();
    res.json({
        status: status.status === 'OK' ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        details: config.nodeEnv === 'development' ? status : undefined
    });
});

// Orchestrator-grade liveness/readiness probes. Registered at ROOT (above the install guard, the
// API rate limiter and CSRF, which are all scoped to config.api.prefix) so they are unauthenticated,
// CSRF-free and never 503'd by the setup guard. Set true at the end of initialize().
let appReady = false;
// Plugin isolates are forked one at a time (CrashGuard must be able to attribute a boot crash to
// ONE plugin), so with several plugins that phase dominates boot. The listener now opens BEFORE it
// in non-embedded modes, which means core routes serve while plugins are still coming up — and a
// request for a plugin route in that window must say "not yet", not "does not exist".
let pluginsReady = false;

// Liveness — the process is up and the event loop is responsive. Deliberately does NOT touch the DB.
app.get('/healthz', (req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime(), pid: process.pid, timestamp: new Date().toISOString() });
});

// Prometheus metrics (default Node/process metrics + app gauges). DISABLED unless a scrape token is
// configured (config.metrics.token), so metrics are never exposed publicly by default. Scrape with
// `Authorization: Bearer <token>` — HEADER ONLY. Root-level so it's CSRF-free and not rate-limited.
app.get('/metrics', async (req: Request, res: Response) => {
    const token = config.metrics && config.metrics.token;
    if (!token) return res.status(404).end();
    // Header-only: a `?token=` query string leaks the long-lived secret into access logs / Referer /
    // browser history — matches the gateway's header-only management-secret policy. Prometheus supports
    // header-based auth natively (authorization / bearer_token_file), so no scrape config needs the query.
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(String(provided)); const b = Buffer.from(String(token));
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return res.status(401).end();
    try {
        const { metricsText, contentType } = require('./core/metrics');
        res.set('Content-Type', contentType);
        res.end(await metricsText());
    } catch (e: any) {
        res.status(500).end();
    }
});

// Readiness — installed, fully booted, and the database answers. Returns 503 (not 200) when not
// ready, so an orchestrator/load-balancer holds traffic until the instance can actually serve it.
app.get('/readyz', async (req: Request, res: Response) => {
    const checks: any = { installed: false, booted: appReady, db: 'unknown' };
    try {
        const { isInstalled } = require('./core/configManager');
        checks.installed = isInstalled();
        if (!checks.installed) return res.status(503).json({ status: 'setup_required', checks });
        if (!appReady) return res.status(503).json({ status: 'starting', checks });
        const SystemHealth = require('./core/system-health');
        const db = await SystemHealth.checkDatabase();
        checks.db = db.status === 'OK' ? 'ok' : 'error';
        if (checks.db !== 'ok') return res.status(503).json({ status: 'not_ready', checks });
        return res.json({ status: 'ready', checks });
    } catch (e: any) {
        checks.db = 'error';
        return res.status(503).json({ status: 'not_ready', checks, error: e && e.message });
    }
});

// Installation and Migration Guard Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    // Bypass for static files, health check, and setup endpoints
    if (
        req.path.startsWith('/uploads') ||
        req.path.startsWith('/themes') ||
        req.path.startsWith('/plugins') ||
        req.path === '/health' ||
        req.path === '/favicon.ico' ||
        req.path.startsWith(`${config.api.prefix}/setup`)
    ) {
        return next();
    }

    const { isInstalled, getConfig } = require('./core/configManager');

    // 1. Check if installed
    if (!isInstalled()) {
        return res.status(503).json({
            error: 'setup_required',
            message: 'WordJS is not installed.',
            redirect: '/install'
        });
    }

    // 2. Check for URL Mismatch (Migration needed)
    const currentConfig = getConfig();
    if (currentConfig && currentConfig.siteUrl) {
        // Prioritize X-Forwarded-Host (set by the monolith/Next proxy or a standard reverse
        // proxy), fall back to the raw Host header.
        const rawHostHeader = req.get('x-forwarded-host') || req.get('host') || '';

        try {
            // Compare HOSTNAMES ONLY — strip protocol, any :port, path and trailing slash from
            // both sides. Behind a TLS-terminating reverse proxy the public host carries no :port
            // (e.g. example.com on 443) while siteUrl/upstream Host may still carry :3000;
            // comparing host:port there falsely fired "migration_required" and locked admins out
            // of the ENTIRE API on every request (login succeeded, the next call 409'd → the UI
            // bounced to /migration). Hostnames still catch a genuine domain change, which is the
            // only situation migration should trigger.
            // Parse the hostname with the WHATWG URL parser (the same one every base-URL builder uses)
            // rather than a naive .split(':')[0]. SEC: a value like `localhost:1@evil.example` makes the
            // naive split return 'localhost' (it reads the userinfo as host:port) while new URL() returns
            // 'evil.example' — a parser differential that let a crafted Host header slip past this guard
            // AND poison the SSR canonical/og:url base. Parsing consistently closes the gap (the crafted
            // host now resolves to its true hostname and correctly trips the mismatch).
            const hostnameOf = (v: string): string => {
                let s = String(v || '').trim();
                if (!s) return '';
                if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
                try { return new URL(s).hostname.toLowerCase(); } catch { return ''; }
            };
            const configuredHost = hostnameOf(currentConfig.siteUrl);
            const detectedHost = hostnameOf(rawHostHeader);

            // Loopback is always allowed: direct backend access, the SSR loopback server, health
            // probes and CLI tooling must never be bounced to /migration.
            const isLoopback =
                detectedHost === 'localhost' || detectedHost === '127.0.0.1' || detectedHost === '::1';

            if (configuredHost && detectedHost && configuredHost !== detectedHost && !isLoopback) {
                return res.status(409).json({
                    error: 'migration_required',
                    message: 'Site URL mismatch detected.',
                    redirect: '/migration',
                    details: {
                        configured: configuredHost,
                        detected: detectedHost
                    }
                });
            }
        } catch (e) {
            console.error('Migration check error:', e);
        }
    }

    next();
});

// Admin-enforced MFA-by-role gate: blocks a past-grace, un-enrolled cookie session (of a policy-required
// role) from everything but the enrollment/session allowlist. Mounted AFTER csrf + the setup gate and
// BEFORE the routers; a no-op (one cached option read) when no role requires MFA.
// A plugin route requested while the isolates are still forking gets an honest 503 + Retry-After
// instead of a 404 that reads as "this endpoint does not exist" (and would be cached as such by a
// CDN). Scoped to /plugin/* only: every core route is fully functional at this point.
app.use(`${config.api.prefix}/plugin`, (req: Request, res: Response, next: NextFunction) => {
    if (pluginsReady) return next();
    res.setHeader('Retry-After', '5');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
        code: 'plugins_starting',
        message: 'Plugins are still starting. Retry in a moment.',
        data: { status: 503 },
    });
});

const { mfaComplianceGate } = require('./middleware/auth');
app.use(config.api.prefix, mfaComplianceGate);

// Anonymous public JSON gets an edge-cacheable Cache-Control (a CDN/nginx finally has something
// to hold; s-maxage is shared-cache-only so browsers are untouched). Applied at SEND time, and
// only when everything is provably public: read method, allowlisted content prefix, no resolved
// user, no credentials on the request, no Set-Cookie on the response, 2xx, and no header already
// chosen by the route. Anything authenticated or personalized never gets it.
const PUBLIC_CACHEABLE_RE = /^\/(settings|posts|menus|fonts|categories|tags|comments|plugins\/assets|seo)(\/|$)/;
app.use(config.api.prefix, (req: Request, res: Response, next: NextFunction) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_CACHEABLE_RE.test(req.path)) {
        const origJson = res.json.bind(res);
        (res as any).json = (data: any) => {
            const credentialed = (req as any).user
                || req.headers.authorization
                || (req.headers.cookie || '').includes('wordjs_token');
            if (!credentialed
                && !res.getHeader('Set-Cookie')
                && !res.getHeader('Cache-Control')
                && res.statusCode >= 200 && res.statusCode < 300) {
                res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
            }
            return origJson(data);
        };
    }
    next();
});

// API routes
app.use(config.api.prefix, routes);

// API info at /api endpoint  
app.get('/api', (req: Request, res: Response) => {
    res.json({
        name: 'WordJS',
        description: 'A WordPress-like CMS built with Node.js',
        version: config.api.version,
        api: `${config.site.url}${config.api.prefix}`
    });
});

// Internal Routes (Gateway Hooks)
app.use('/api/internal', require('./routes/internal'));

// NOTE: the legacy Handlebars public renderer (./routes/frontend → theme-engine) is intentionally
// NOT mounted. The public site is rendered by the Next.js frontend in BOTH split and monolith mode
// (the gateway/monolith only route /api,/uploads,/themes,/plugins,/.well-known,/healthz,/readyz,
// /metrics to the backend; everything else → Next.js). That catch-all was unreachable in both modes;
// leaving it mounted was a latent footgun (it would shadow backend paths if the prefix list changed).
// routes/frontend.ts + theme-engine.ts are kept on disk only as a legacy/monolith-render fallback.

// Add analytics route
app.use('/api/v1/analytics', require('./routes/analytics'));

// DB administration (schema migrations) — core infrastructure, formerly the db-migration plugin.
// Mounted here in the host (it runs around the DB lifecycle at boot; can't be isolated in a worker).
require('./core/db-admin').register(app);

// Note: 404 and error handlers are registered in initialize() after plugins load

/**
 * Initialize the application
 */
async function initialize() {
    console.log('🚀 Starting WordJS...');
    console.log(`   Environment: ${config.nodeEnv}`);

    // On-demand frontend cache purge. Registered UNCONDITIONALLY and FIRST: a fresh boot goes
    // through the uninstalled branch and then installs IN-PROCESS, so the installer's option/post
    // writes fire their hooks immediately — registering this inside the installed branch meant the
    // very first install purged nothing and the public shell served DEFAULT settings until the ISR
    // TTL (the CI split-leg red). Registration is passive; pre-install purge attempts no-op
    // (no config → no secret → nothing sent).
    require('./core/frontend-purge').initFrontendPurge();

    // Scheduled ("future") publishing: register the publish_future_post flip handler so a post whose
    // scheduled time arrives is transitioned to 'publish' by the cron event Post.create/update armed.
    // Registered unconditionally alongside the purge hook (it only reacts to cron events).
    require('./core/scheduled-publish').initScheduledPublish();

    // Check Installation Status
    const { isInstalled } = require('./core/configManager');

    // 404 + error handlers, then the LISTENER — both BEFORE plugins now, so core routes serve while
    // the isolates are still forking (they fork one at a time; CrashGuard must be able to blame ONE
    // plugin for a boot crash, so that phase cannot be parallelised). Plugin routes register later
    // and would land BEHIND these two handlers, so loadActivePlugins is followed by
    // fixMiddlewareOrder(), the same stack-reordering this codebase already uses for runtime
    // activation. Requests for a plugin route in the window hit the /plugin/* 503 guard above.
    // EMBEDDED (monolith) is unaffected: it owns the single listener and boots its own way.
    app.use(notFound);
    app.use(errorHandler);

    // Start server (skipped when embedded — the monolith owns the single listener)
    if (!EMBEDDED) {
    const caPath = path.resolve(config.mtls.ca);
    const keyPath = path.resolve(config.mtls.key);
    const certPath = path.resolve(config.mtls.cert);

    const serverProtocol = (fs.existsSync(certPath) && fs.existsSync(keyPath) && fs.existsSync(caPath)) ? 'https' : 'http';
    let server;

    if (serverProtocol === 'https') {
        const https = require('https');
        const httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath),
            ca: fs.readFileSync(caPath),
            requestCert: true,
            rejectUnauthorized: true // ENFORCE mTLS: Only allow certs signed by our CA
        };
        server = https.createServer(httpsOptions, app);
        // SECURITY: mTLS proves the peer holds a CLUSTER-CA-signed cert, but rejectUnauthorized alone does
        // NOT prove it is the GATEWAY. The backend API is only ever meant to be reached THROUGH the gateway
        // (which connects with its gateway-internal client cert). Without a CN gate, a lower-trust cluster
        // member — e.g. a compromised frontend node holding CN=frontend, or a self-enrolled attacker — could
        // open a DIRECT connection to backend:PORT and bypass the entire gateway edge, forging
        // X-Forwarded-For / X-Forwarded-Host to defeat the per-IP login throttle, CSRF same-origin and the
        // migration guard (all of which trust the gateway to pin those headers). Pin the peer identity to the
        // gateway, mirroring the gateway's own CN allow-lists (proxy-config createUpstreamAgent /
        // requireIdentity). Enforced at the TLS layer so a rogue peer is dropped before any HTTP is parsed.
        const ALLOWED_PEER_CNS = new Set(['gateway-internal', 'gateway']);
        server.on('secureConnection', (tlsSocket: any) => {
            let cn: any;
            try {
                const cert = tlsSocket.getPeerCertificate && tlsSocket.getPeerCertificate();
                cn = cert && cert.subject ? cert.subject.CN : undefined;
            } catch { cn = undefined; }
            if (!ALLOWED_PEER_CNS.has(String(cn))) {
                console.warn(`🛡️  mTLS: rejected direct peer CN='${cn}' — only the gateway may address the backend.`);
                try { tlsSocket.destroy(); } catch { /* already gone */ }
            }
        });
    } else {
        const http = require('http');
        server = http.createServer(app);
    }

    // Bind IPv4 loopback when host is a loopback NAME: Node resolves 'localhost' to ::1 (IPv6) on a
    // dual-stack box, but in split mode the backend advertises 127.0.0.1 (IPv4) to the gateway (below), so
    // binding ::1 leaves the gateway's IPv4 proxy unable to connect — every proxied route then 404s (the
    // local-split gateway bug). Explicit IPs (0.0.0.0 in separate mode, a LAN IP) pass through unchanged.
    const bindHost = (config.host === 'localhost' || config.host === '::1') ? '127.0.0.1' : config.host;
    // Outlive any fronting proxy's idle timeout (nginx default 60s; gateway keep-alive agents): with
    // Node's 5s default the server races the proxy's socket reuse and drops requests mid-flight.
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.listen(config.port, bindHost, () => {
        console.log('');
        console.log(`✅ WordJS Backend is running via ${serverProtocol.toUpperCase()}!`);
        if (serverProtocol === 'https') {
            console.log('   🛡️  Security: mTLS (Identity Enforcement) is ACTIVE');
            console.log(`   🪪  Identity: backend`);
        }
        console.log(`   🌐 URL: ${serverProtocol}://${config.host}:${config.port}`);
        console.log(`   📡 API: ${serverProtocol}://${config.host}:${config.port}${config.api.prefix}`);

        // Register with Gateway
        // Register with Gateway with Auto-Discovery (Zero Config)
        const registerWithGateway = async () => {
            const http = require('http');
            const https = require('https');

            // Use Internal Management Port for mTLS registration
            const gatewayInternalPort = config.gatewayInternalPort || 3100;
            const gatewayPort = config.gatewayPort || 3000;

            // Certs for calling Gateway (Client mTLS).
            //
            // Re-read on EVERY attempt, not once at boot. On a fresh split install all three services
            // start before the wizard has issued any certificate; reading once left clientOpts empty for
            // the life of the process, so the retry loop kept POSTing /register in the clear to the
            // PUBLIC port (which has no such route → 404) and the backend never registered even after
            // setup wrote its identity to disk.
            let clientOpts: Record<string, any> = {};
            let announcedMtls = false;
            const refreshClientOpts = () => {
                if (!(fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(caPath))) {
                    clientOpts = {};
                    return;
                }
                if (!announcedMtls) {
                    console.log('   🛂 mTLS: Using client certificates for Gateway registration...');
                    announcedMtls = true;
                }
                clientOpts = {
                    key: fs.readFileSync(keyPath),
                    cert: fs.readFileSync(certPath),
                    ca: fs.readFileSync(caPath),
                    rejectUnauthorized: true
                };
            };
            refreshClientOpts();

            const services = [
                {
                    name: 'backend',
                    // Advertise a routable address so a gateway on another host can reach this node.
                    // Defaults to 127.0.0.1 (single host); set advertiseHost per-node for multi-node.
                    url: `${serverProtocol}://${config.advertiseHost || '127.0.0.1'}:${config.port}`,
                    routes: ['/api', '/uploads', '/themes', '/plugins', '/.well-known', '/healthz', '/readyz', '/metrics']
                }
            ];

            const tryRegister = (protocolName: any, serviceData: any) => {
                return new Promise((resolve, reject) => {
                    const protocol = protocolName === 'https' ? https : http;
                    const data = JSON.stringify(serviceData);
                    const targetHost = config.gatewayHost || 'localhost';

                    // Port logic: If we have mTLS certs, we use the INTERNAL management port.
                    // Otherwise we fallback to the public gateway port.
                    const useMtls = Object.keys(clientOpts).length > 0;
                    const targetPort = useMtls ? gatewayInternalPort : gatewayPort;
                    const targetProtocol = useMtls ? https : protocol;

                    const req = targetProtocol.request({
                        hostname: targetHost,
                        port: targetPort,
                        path: '/register',
                        method: 'POST',
                        rejectUnauthorized: false, // For local dev/self-signed, but mTLS uses clientOpts.ca
                        ...clientOpts, // Inject client certs for mTLS
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': data.length,
                            'x-gateway-secret': process.env.GATEWAY_SECRET || (config.gatewaySecret) || 'secure-your-gateway-secret'
                        },
                        timeout: 2000
                    }, (res: any) => {
                        if (res.statusCode === 200) {
                            const actualProto = useMtls ? 'HTTPS (mTLS)' : protocolName.toUpperCase();
                            console.log(`✅ ${serviceData.name} Registered with Gateway via ${actualProto}`);
                            resolve(protocolName);
                        } else {
                            reject(new Error(`Status ${res.statusCode}`));
                        }
                    });

                    req.on('error', (e: any) => reject(e));
                    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
                    req.write(data);
                    req.end();
                });
            };

            // NEW: Self-Sync logic - Fetch official URL from Gateway and update DB
            const syncFromGateway = async () => {
                const useMtls = Object.keys(clientOpts).length > 0;
                const protocol = useMtls ? https : http;
                const targetPort = useMtls ? gatewayInternalPort : gatewayPort;

                return new Promise<void>((resolve) => {
                    const req = protocol.request({
                        hostname: config.gatewayHost || 'localhost',
                        port: targetPort,
                        path: '/info',
                        method: 'GET',
                        rejectUnauthorized: false,
                        ...clientOpts,
                        headers: {
                            'x-gateway-secret': process.env.GATEWAY_SECRET || (config.gatewaySecret) || 'secure-your-gateway-secret'
                        },
                        timeout: 5000
                    }, (res: any) => {
                        let body = '';
                        res.on('data', (chunk: any) => body += chunk);
                        res.on('end', async () => {
                            if (res.statusCode === 200) {
                                try {
                                    const info = JSON.parse(body);
                                    if (info.siteUrl) {
                                        const { getOption, updateOption } = require('./core/options');
                                        const currentDbUrl = await getOption('siteurl');

                                        if (currentDbUrl !== info.siteUrl) {
                                            console.log(`[Sync] 🔄 Site URL Mismatch! Updating DB: ${currentDbUrl} -> ${info.siteUrl}`);
                                            await updateOption('siteurl', info.siteUrl);
                                            await updateOption('home', info.siteUrl);
                                            console.log('[Sync] ✅ DB Options synchronized with Gateway.');
                                        }
                                    }
                                } catch (e) {
                                    console.warn('[Sync] Failed to parse Gateway info:', e.message);
                                }
                            }
                            resolve();
                        });
                    });
                    req.on('error', (e: any) => {
                        console.warn('[Sync] Could not reach Gateway for URL sync:', e.message);
                        resolve();
                    });
                    req.end();
                });
            };

            // Attempt registration with retry logic
            const registerAll = async () => {
                refreshClientOpts(); // certs may have been issued since the last attempt (see above)
                let preferredProto = (config.gatewaySsl && config.gatewaySsl.enabled) ? 'https' : 'http';
                let fallbackProto = preferredProto === 'https' ? 'http' : 'https';
                let allSuccess = true;

                for (const service of services) {
                    try {
                        await tryRegister(preferredProto, service);
                    } catch (e) {
                        try {
                            await tryRegister(fallbackProto, service);
                            preferredProto = fallbackProto;
                        } catch (e2) {
                            console.warn(`⏳ Waiting for Gateway to register ${service.name}...`);
                            allSuccess = false;
                        }
                    }
                }

                if (!allSuccess) {
                    // exponential backoff: quick retries while the gateway is coming up, 5s steady-state
                    _regAttempt++;
                    setTimeout(registerAll, Math.min(5000, [250, 1000, 2000][_regAttempt - 1] ?? 5000));
                } else {
                    console.log('🏁 All services successfully registered with Gateway.');
                    await syncFromGateway();
                }
            };

            // First attempt immediately — the fixed 1.5s pause meant "backend up, site 404" on
            // every split boot even when the gateway was already listening.
            let _regAttempt = 0;
            registerAll();
        };

        // Monolith serves everything from one process/port — there is no gateway to register with.
        // Without this guard the no-cert fallback targets gatewayPort's default (3000 = our own
        // public port), and the retry loop POSTs /register at ourselves every 5s forever.
        if (process.env.WORDJS_MODE !== 'mono') registerWithGateway();

        console.log('');
        console.log('📖 API Endpoints:');
        console.log(`   POST   ${config.api.prefix}/auth/register`);
        console.log(`   POST   ${config.api.prefix}/auth/login`);
        console.log(`   GET    ${config.api.prefix}/posts`);
        console.log(`   GET    ${config.api.prefix}/users`);
        console.log(`   GET    ${config.api.prefix}/categories`);
        console.log(`   GET    ${config.api.prefix}/tags`);
        console.log(`   GET    ${config.api.prefix}/comments`);
        console.log(`   GET    ${config.api.prefix}/media`);
        console.log(`   GET    ${config.api.prefix}/settings`);
        console.log(`   GET    ${config.api.prefix}/plugins`);
        console.log(`   GET    ${config.api.prefix}/themes`);
        console.log('');
        // `config.site` is {url,name,description} — it has no frontendUrl, so this printed a literal
        // "undefined/admin" on every split/separate boot. The public origin lives at the top level.
        const publicUrl = config.frontendUrl || config.siteUrl || config.site?.url;
        if (publicUrl) {
            console.log(`🎨 Admin Panel: ${publicUrl}/admin`);
            console.log(`🏠 Public Site: ${publicUrl}`);
        }
        console.log('');
    });
    }

    if (isInstalled()) {
        // Initialize Database
        console.log('📦 Initializing database...');
        // The driver manager automatically loads the correct driver from config
        const { init, initializeDatabase } = require('./config/database');
        await init();

        // --- Multi-node boot guard ---------------------------------------------------------------
        // Serialize the schema-migration + default-seeding section across replicas so concurrent
        // boots can't double-apply migrations or create duplicate admin/category/option rows. The
        // lease is heartbeat-renewed so a slow migration is never preempted mid-seed; if we can't get
        // the lock (another node is initializing the shared DB) we FAIL CLOSED so the supervisor
        // retries rather than seeding concurrently. No-op (always held) on SQLite (single host).
        const distLock = require('./core/dist-lock');
        await distLock.ensureLockTable();
        const bootLock = await distLock.acquireBlocking('wordjs:boot', { ttlMs: 60000, renewMs: 20000, timeoutMs: 300000 });
        if (!bootLock.held) {
            throw new Error('Boot lock not acquired (another node is initializing the shared database); restarting to retry.');
        }

        await initializeDatabase();

        // Initialize default options
        console.log('⚙️  Setting up default options...');
        await initDefaultOptions(config);

        // Initialize cache setting now that the DB and options are ready
        // (moved out of options.ts import-time to avoid a startup race).
        await require('./core/options').initCacheSetting();

        // Prime the L1 option cache with every autoload row in one query — /settings and the other
        // hot option readers then serve from memory instead of one SELECT per option per request.
        const preloaded = await require('./core/options').preloadAutoloadedOptions();
        if (preloaded) console.log(`⚡ Option cache primed: ${preloaded} autoloaded options`);

        // Load the per-plugin permission grants (Android-style, default-deny). Then a one-time,
        // non-breaking backfill: grandfather the manifest-declared permissions of plugins that are
        // ALREADY ACTIVE (and have no grant record yet) so flipping to default-deny doesn't break a
        // running site — new activations stay default-deny. Best-effort; never blocks boot.
        try {
            await require('./core/plugin-permissions').loadGrants();
            await require('./core/plugin-permissions').loadEgressHosts();
            const { getActivePlugins, getAllPlugins } = require('./core/plugins');
            const active: string[] = await getActivePlugins();
            const all: any[] = await getAllPlugins();
            const entries = all
                .filter((p: any) => active.includes(p.slug))
                .map((p: any) => ({
                    slug: p.slug,
                    requested: Array.from(new Set((p.permissions || [])
                        .map((perm: any) => (perm && perm.scope) ? (perm.scope === 'network' ? 'network' : `${perm.scope}:${perm.access || 'read'}`) : null)
                        .filter(Boolean))) as string[],
                }));
            await require('./core/plugin-permissions').backfillActive(entries);
        } catch (e: any) {
            console.warn('[PluginPermissions] load/backfill skipped:', e && e.message);
        }

        // Initialize Analytics Table
        await require('./models/Analytics').init();



        // Register routes that were not in the initial index.js routes list if needed
        // But better to add it to src/routes/index.js if possible, OR just here dynamically.
        // Let's add it to src/routes/index.js instead for cleanliness?
        // Actually, looking at src/routes/index.js (I haven't seen it yet), but usually it's better.
        // However, I can inject it here.
        app.use(`${config.api.prefix}/backups`, require('./routes/backups'));

        const { initPostTypes, initTaxonomies } = require('./core/post-types');
        await initPostTypes();
        // Seed built-in taxonomies (category, post_tag) + any persisted custom ones.
        await initTaxonomies();

        // Sync roles to ensure capabilities are up to date
        const { loadRoles, syncRoles } = require('./core/roles');
        await loadRoles();
        await syncRoles(config.roles);

        // Initialize Core Admin Menus
        const { initCoreMenus } = require('./core/adminMenu');
        initCoreMenus();

        // Create default admin user if no users exist
        const User = require('./models/User');
        const userCount = await User.count();

        if (userCount === 0) {
            // A site that reaches this point is already reachable (in split/separate it is published
            // through the gateway), so the bootstrap administrator must NOT have a guessable password.
            // This used to hardcode admin/admin123 and print it as a suggestion — on an enrolled cluster
            // node, which skipped the wizard, that shipped a live site with known credentials.
            // The password is random, written 0600 next to the install token, and printed once.
            const nodeCrypto = require('crypto');
            const nodeFs = require('fs');
            const nodePath = require('path');
            // base64url of 24 bytes: no shell-hostile characters, ~192 bits.
            const password = nodeCrypto.randomBytes(24).toString('base64url');

            console.log('👤 No users found — creating the bootstrap administrator...');
            await User.create({
                username: 'admin',
                email: 'admin@example.com',
                password,
                displayName: 'Administrator',
                role: 'administrator'
            });

            const dataDir = nodePath.resolve(__dirname, '../data');
            const pwFile = nodePath.join(dataDir, 'initial-admin-password');
            let stored: string;
            try {
                if (!nodeFs.existsSync(dataDir)) nodeFs.mkdirSync(dataDir, { recursive: true });
                nodeFs.writeFileSync(pwFile, `${password}\n`, { mode: 0o600 });
                stored = `\n   (also written to ${pwFile}, mode 0600 — delete it once you have signed in)`;
            } catch (e: any) {
                // Never block boot on this: the password is printed above either way.
                stored = `\n   (could not write ${pwFile}: ${e && e.message} — copy the password from this log)`;
            }
            console.log('');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🔑 Bootstrap administrator created — this is shown ONCE:');
            console.log('');
            console.log(`      user:     admin`);
            console.log(`      password: ${password}`);
            console.log(`${stored}`);
            console.log('');
            console.log('   ⚠️  Sign in and change it. Anyone who can read this log can use it.');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('');
        }

        // Create default category if none exist
        const Term = require('./models/Term');
        const categoryCount = await Term.count({ taxonomy: 'category' });

        if (categoryCount === 0) {
            console.log('📁 Creating default category...');
            // Await so the insert completes INSIDE the boot-lock critical section (matching the awaited
            // User.create above). On Postgres multi-node the boot lock serializes default seeding; if the
            // lease were released (line below) before this insert committed, a second node could pass its
            // own categoryCount check and create a duplicate 'Uncategorized' (no UNIQUE backstop). (DATA-03)
            await Term.create({
                name: 'Uncategorized',
                taxonomy: 'category',
                slug: 'uncategorized',
                description: 'Default category'
            });
        }

        // THEME HEALTH — VERIFY AND WARN. Boot must not write inside themes/.
        //
        // This used to be an unconditional createDefaultTheme(): the comment said "if none exist" and
        // the code checked nothing, so every restart rewrote files in a directory the user owns. Five
        // of them (partials/{header,footer}.html, templates/{index,single,archive}.html) were written
        // with a bare fs.writeFileSync, so hand edits to them did not survive a restart. Of twelve CMSs
        // surveyed, none re-creates theme files at runtime; they ship a fallback, refuse to delete it,
        // and degrade. Provisioning now happens only where a user asked for it — the install wizard and
        // POST /api/v1/themes/default. Both problems below are non-fatal by design: the site still
        // renders (the framework's own :root tokens in public/css/wordjs-ui.css are the floor), so the
        // job here is to make the degradation LOUD instead of silent.
        //
        // WARN ONLY WHERE THERE IS SOMETHING TO DO. A site may legitimately not have themes/default at
        // all — deleteTheme() permits removing it when it is neither active nor the last theme — so
        // "the default theme does not exist" is not a fault and must not be reported on every restart:
        // a warning that fires forever on a legal configuration teaches the admin to ignore the
        // console, and then the real one below goes unread too. defaultThemeNeedsAttention() keeps the
        // case no supported operation can produce (the directory is there but incomplete → corruption);
        // absent-and-active is reported by the active-theme warning instead, which names the slug.
        const { verifyDefaultTheme, defaultThemeNeedsAttention, isActiveThemeMissing, getCurrentTheme } = require('./core/themes');
        const defaultTheme = verifyDefaultTheme();
        if (defaultThemeNeedsAttention(defaultTheme)) {
            console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.warn(`⚠️  The bundled default theme is missing ${defaultTheme.missing.join(', ')}: ${defaultTheme.dir}`);
            console.warn('   An incomplete theme directory is not something WordJS creates — restore it with:');
            console.warn('     POST /api/v1/themes/default   (admin — "Restore default theme")');
            console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
        if (await isActiveThemeMissing()) {
            const slug = await getCurrentTheme();
            console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.warn(`⚠️  The active theme "${slug}" is NOT installed — no theme.json was found for it.`);
            console.warn('   The public site is rendering with the framework default tokens only.');
            console.warn('   Activate an installed theme (POST /api/v1/themes/:slug/activate) or restore');
            console.warn('   the bundled default (POST /api/v1/themes/default).');
            console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        // Seeding done — release the boot guard (stops the heartbeat + frees the lease) so waiting
        // nodes proceed; the rest of init (plugins, cron) is per-node. On a throw before here the
        // process exits, its heartbeat timer dies with it, and the lease expires within ~ttl.
        await bootLock.release();

        // Reconcile any plugin update that was killed mid-flight (old code stashed, new code not yet
        // installed) BEFORE loading plugins — so a plugin is never loaded from a half-updated directory.
        try {
            const { recoverInterruptedPluginUpdates } = require('./routes/plugins');
            await recoverInterruptedPluginUpdates();
        } catch (e: any) {
            console.warn('[boot] plugin-update recovery skipped:', e && e.message);
        }


        // Load active plugins
        console.log('🔌 Loading plugins...');
        const { loadActivePlugins } = require('./core/plugins');
        await loadActivePlugins();
        // Plugin routes registered above sit BEHIND the 404/error handlers (which are now installed
        // before this point so the server could start listening early) — push those two back to the
        // end of the stack, exactly as runtime activation already does.
        try { require('./core/plugins').fixMiddlewareOrder(); } catch (e: any) {
            console.warn('[boot] middleware reorder skipped:', e && e.message);
        }
        pluginsReady = true;

        // Email-provider posture: the core cannot send mail itself; a plugin must register a host-wide
        // sender (email:provider capability). Checked HERE — after plugins load — because that is when a
        // provider would have registered. When none did, password recovery fails closed and silently, so
        // we say so once at boot (boot-time twin of the admin `email_provider_available` settings flag and
        // the active-theme / sandbox-hardening warnings). Guarded so it can never break boot.
        try {
            const { isEmailProviderAvailable } = require('./core/mail-provider');
            if (!isEmailProviderAvailable()) {
                console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.warn('⚠️  No email provider is registered — WordJS core cannot send email on its own.');
                console.warn('   Self-service PASSWORD RECOVERY is therefore unavailable: /auth/forgot-password');
                console.warn('   fails closed and users cannot reset their own passwords.');
                console.warn('   Install and activate a mail plugin (e.g. mail-server) and grant it the');
                console.warn('   email:provider permission. Visible to admins on GET /api/v1/settings/all');
                console.warn('   (email_provider_available).');
                console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            }
        } catch (e: any) {
            console.warn('[boot] email-provider check skipped:', e && e.message);
        }

        // DEV hot-reload: watch each active isolated plugin's dir and re-spawn its child process
        // on change (re-runs the AST scan). Hard no-op outside development; guarded so a watcher
        // failure can never break boot.
        try {
            const { startPluginDevWatch } = require('./core/plugin-dev-watch');
            await startPluginDevWatch();
        } catch (e: any) {
            console.warn('[plugin-dev-watch] not started:', e && e.message);
        }

        // Plugin-sandbox hardening: run the kernel-hardening probe at boot (fire-and-forget) and LOG the
        // resulting state, so the OS-backstop posture is visible even when no isolated plugin has loaded
        // yet — the probe is otherwise lazy (first isolate load). Boot-time twin of the active-theme
        // warning and of the admin-visible `sandbox_hardening_*` settings flags. 'degraded' (hardening
        // ENABLED on Linux but bwrap/userns unavailable) is the "looks secure but isn't" state and is
        // logged as a WARNING; 'unsupported' (Windows/macOS — no bwrap) and 'disabled' (opt-out) are
        // logged calmly as expected postures, never as a fault, never a crash.
        try {
            const iso = require('./core/plugin-isolate');
            iso.probeKernelHardening().then(() => {
                const state = iso.getSandboxHardeningState();
                if (state === 'degraded') {
                    console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    console.warn('⚠️  Plugin sandbox DEGRADED: kernel hardening is ENABLED but the bwrap probe FAILED');
                    console.warn('   on this host — isolated plugins run WITHOUT the OS backstop (JS guards only).');
                    console.warn('   Install bubblewrap + enable unprivileged user namespaces to restore it, or set');
                    console.warn('   sandbox.requireHardening=true to fail closed. Visible to admins on GET /api/v1/settings/all');
                    console.warn('   (sandbox_hardening_degraded) and GET /health/details.');
                    console.warn('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                } else if (state === 'active') {
                    console.log('🛡️  Plugin sandbox: kernel hardening ACTIVE (bwrap + seccomp OS backstop).');
                } else if (state === 'unsupported') {
                    console.log('🛡️  Plugin sandbox: kernel hardening UNAVAILABLE on this platform (non-Linux) — isolated plugins use process separation + JS guards + Node permission model.');
                } else if (state === 'disabled') {
                    console.log('🛡️  Plugin sandbox: kernel hardening DISABLED via config (sandbox.useKernelHardening=false).');
                }
            }).catch(() => { /* the probe never throws; guard anyway so boot is unaffected */ });
        } catch (e: any) {
            console.warn('[boot] sandbox hardening probe skipped:', e && e.message);
        }

        // Start cron system
        const { startCron, initDefaultCronEvents, scheduleEvent, scheduleSingleEvent, unscheduleEvent, nextScheduled } = require('./core/cron');
        await initDefaultCronEvents();
        startCron();

        // Multi-node coherence: refresh in-process caches (roles) on cross-node option changes, and
        // join the cluster notification bus so SSE pushes reach clients on any node. No-op w/o Redis.
        require('./core/coherence').initCoherence();
        require('./core/notifications').initClusterBus();
        // Salas de edición colaborativa (Verso F8): el gateway hace round-robin en cada petición, así
        // que dos editores de la misma página caen en nodos distintos por construcción. El bus reparte
        // sus ops entre nodos; sin Redis (mononodo) es un no-op y el fan-out se queda en memoria.
        require('./core/collab-rooms').initClusterBus();

        // Outgoing webhooks: subscribe the dispatcher to content hooks and start the delivery poller.
        require('./core/webhooks').initWebhooks();

        // Expose Cron API to Plugins via global.wordjs
        global.wordjs = global.wordjs || {};
        global.wordjs.scheduleEvent = scheduleEvent;
        global.wordjs.scheduleSingleEvent = scheduleSingleEvent;
        global.wordjs.unscheduleEvent = unscheduleEvent;
        global.wordjs.nextScheduled = nextScheduled;

        // Initialize Robust Theme Engine
        console.log('🎨 Initializing Theme Engine...');
        const themeEngine = require('./core/theme-engine');
        await themeEngine.init();

        // Republish the ACTIVE theme's manifest `layout` into active_theme_layout. switchTheme already
        // writes it when an admin activates a theme, but the option goes stale on every path that
        // changes the layout WITHOUT a switch — a theme update, an edit to theme.json, a restore. This
        // is the reconciliation for those.
        //
        // Safe to run on every boot because it is IDEMPOTENT: active_theme_layout is on the
        // frontend-purge allowlist, so a needless write would evict the public cache on each restart.
        // syncActiveThemeLayout compares in the serialized form and writes only on a real change.
        // Best-effort — a themes-dir hiccup must never stop the server from finishing its boot.
        try {
            await require('./core/themes').syncActiveThemeLayout();
        } catch (e: any) {
            console.warn(`⚠️  Could not reconcile the active theme layout: ${e && e.message}`);
        }

        // Fire init action
        await doAction('init');
    } else {
        console.log('⚠️  WordJS is NOT installed. Starting in SETUP MODE.');
        console.log('   Waiting for interactive installation via Frontend...');

        // SECURITY: mint + print the one-time install token. The pre-install setup endpoints
        // (/setup/install, /setup/test-db) require it, so a not-yet-installed instance can't be
        // taken over by whoever reaches it first. Held in memory only; a fresh token is minted on
        // each boot while the instance remains uninstalled.
        require('./core/install-token').generateInstallToken();
    }


    // Boot complete (DB + plugins + theme engine ready, or setup-mode). /readyz flips to ready.
    appReady = true;

    // Return the configured app so the monolith entrypoint can mount it in-process.
    return app;
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    saveDatabase();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received. Shutting down gracefully...');
    saveDatabase();
    process.exit(0);
});

// Start the application — only when run directly (split mode via backend/server.js). When required by
// the monolith (WORDJS_EMBEDDED=1), the entrypoint calls initialize() itself after mounting.
if (require.main === module && !EMBEDDED) initialize().catch((error) => {
    console.error('❌ Failed to initialize:', error);

    // Auto-Fallback Logic
    const fs = require('fs');
    const path = require('path');
    const backupFile = path.resolve('wordjs-config.backup.json');
    const configFile = path.resolve('wordjs-config.json');

    if (fs.existsSync(backupFile)) {
        console.warn('⚠️  Startup Failed! Attempting automatic fallback to previous configuration...');
        try {
            // Restore config
            fs.copyFileSync(backupFile, configFile);
            console.log('✅ Configuration restored from backup.');

            // Force Restart by touching this file
            const time = new Date();
            fs.utimesSync(__filename, time, time);
            console.log('🔄 Triggering server restart...');
        } catch (e) {
            console.error('❌ Fallback failed:', e);
        }
    }

    process.exit(1);
});

module.exports = app;
// Expose the async initializer so the monolith entrypoint can boot DB + plugins + theme engine
// without the self-listen/self-register block (which is guarded by EMBEDDED above).
module.exports.initialize = initialize;

