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

// Trust proxy (for getting real IP behind reverse proxy)
const rateLimit = require('express-rate-limit');

// ... (existing helper setup, ensure this block replaces lines correctly)
// Trust proxy (for getting real IP behind reverse proxy)
app.set('trust proxy', 1);

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

    let originHost = '';
    try { originHost = new URL(origin).hostname.toLowerCase(); } catch { return deny(); }

    // (2) same-origin (Origin host === the Host the request was actually sent to)
    const hostHeader = hostnameOnly(req.headers.host || '');
    if (hostHeader && originHost === hostHeader) return allow();

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
    store: limiterStore('rl:api:'),
    passOnStoreError: true, // if the Redis store errors (outage), ALLOW the request rather than 500 the whole API
    message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Limit each IP to 10 login attempts per hour
    standardHeaders: true,
    legacyHeaders: false,
    store: limiterStore('rl:auth:'),
    passOnStoreError: true,
    message: { error: 'Too many login attempts, please try again later.' }
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // Limit each IP to 50 uploads per hour
    standardHeaders: true,
    legacyHeaders: false,
    store: limiterStore('rl:upload:'),
    passOnStoreError: true,
    message: { error: 'Too many file uploads, please try again later.' }
});

const setupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 20, // tight cap on the PUBLIC install / test-db endpoints (pre-config, unauthenticated)
    standardHeaders: true,
    legacyHeaders: false,
    store: limiterStore('rl:setup:'),
    passOnStoreError: true,
    message: { error: 'Too many setup attempts, please try again later.' }
});

// Apply global API limiter
app.use(config.api.prefix, apiLimiter);

// Parse JSON bodies (apply authLimiter specifically to login routes if not applied globally below, but strict route matching is preferred)
app.use(`${config.api.prefix}/auth/login`, authLimiter);
app.use(`${config.api.prefix}/auth/register`, authLimiter);
app.use(`${config.api.prefix}/auth/forgot-password`, authLimiter); // public, unauthenticated — throttle abuse
app.use(`${config.api.prefix}/auth/reset-password`, authLimiter);
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
app.use('/plugins', express.static(path.resolve('./plugins'), { dotfiles: 'deny', maxAge: '1h' }));
// Serve .well-known (ACME support) - Allow dotfiles. NEVER cache challenge tokens (short-lived, per-order).
app.use('/.well-known', express.static(path.resolve('./public/.well-known'), { dotfiles: 'allow' }));

// Framework assets (wordjs-ui.css etc.) change only on a WordJS update → 1d + ETag revalidation.
app.use('/public', express.static(path.resolve('./public'), { dotfiles: 'deny', maxAge: '1d' }));

// Request logging in development
if (config.nodeEnv === 'development') {
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

// Liveness — the process is up and the event loop is responsive. Deliberately does NOT touch the DB.
app.get('/healthz', (req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime(), pid: process.pid, timestamp: new Date().toISOString() });
});

// Prometheus metrics (default Node/process metrics + app gauges). DISABLED unless a scrape token is
// configured (config.metrics.token), so metrics are never exposed publicly by default. Scrape with
// `Authorization: Bearer <token>` (or ?token=). Root-level so it's CSRF-free and not rate-limited.
app.get('/metrics', async (req: Request, res: Response) => {
    const token = config.metrics && config.metrics.token;
    if (!token) return res.status(404).end();
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || (req.query.token as string) || '';
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
            const hostnameOf = (v: string): string =>
                String(v || '')
                    .replace(/^https?:\/\//, '')
                    .replace(/\/.*$/, '')
                    .split(':')[0]
                    .toLowerCase()
                    .trim();
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

    // Check Installation Status
    const { isInstalled } = require('./core/configManager');

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

        // Load the per-plugin permission grants (Android-style, default-deny). Then a one-time,
        // non-breaking backfill: grandfather the manifest-declared permissions of plugins that are
        // ALREADY ACTIVE (and have no grant record yet) so flipping to default-deny doesn't break a
        // running site — new activations stay default-deny. Best-effort; never blocks boot.
        try {
            await require('./core/plugin-permissions').loadGrants();
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

        const { initPostTypes } = require('./core/post-types');
        await initPostTypes();

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
            console.log('👤 Creating default admin user...');
            await User.create({
                username: 'admin',
                email: 'admin@example.com',
                password: 'admin123',
                displayName: 'Administrator',
                role: 'administrator'
            });
            console.log('   Default admin created: admin / admin123');
            console.log('   ⚠️  Please change the default password!');
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

        // Create default theme if none exist
        const { createDefaultTheme } = require('./core/themes');
        createDefaultTheme();

        // Seeding done — release the boot guard (stops the heartbeat + frees the lease) so waiting
        // nodes proceed; the rest of init (plugins, cron) is per-node. On a throw before here the
        // process exits, its heartbeat timer dies with it, and the lease expires within ~ttl.
        await bootLock.release();

        // Load active plugins
        console.log('🔌 Loading plugins...');
        const { loadActivePlugins } = require('./core/plugins');
        await loadActivePlugins();

        // DEV hot-reload: watch each active isolated plugin's dir and re-spawn its child process
        // on change (re-runs the AST scan). Hard no-op outside development; guarded so a watcher
        // failure can never break boot.
        try {
            const { startPluginDevWatch } = require('./core/plugin-dev-watch');
            await startPluginDevWatch();
        } catch (e: any) {
            console.warn('[plugin-dev-watch] not started:', e && e.message);
        }

        // Start cron system
        const { startCron, initDefaultCronEvents, scheduleEvent, scheduleSingleEvent, unscheduleEvent, nextScheduled } = require('./core/cron');
        await initDefaultCronEvents();
        startCron();

        // Multi-node coherence: refresh in-process caches (roles) on cross-node option changes, and
        // join the cluster notification bus so SSE pushes reach clients on any node. No-op w/o Redis.
        require('./core/coherence').initCoherence();
        require('./core/notifications').initClusterBus();

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

    // Register 404 and error handlers AFTER plugins (so plugin routes work)
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
    } else {
        const http = require('http');
        server = http.createServer(app);
    }

    server.listen(config.port, config.host, () => {
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

            // Certs for calling Gateway (Client mTLS)
            let clientOpts = {};

            if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(caPath)) {
                console.log('   🛂 mTLS: Using client certificates for Gateway registration...');
                clientOpts = {
                    key: fs.readFileSync(keyPath),
                    cert: fs.readFileSync(certPath),
                    ca: fs.readFileSync(caPath),
                    rejectUnauthorized: true
                };
            }

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
                    setTimeout(registerAll, 5000); // Retry in 5s
                } else {
                    console.log('🏁 All services successfully registered with Gateway.');
                    await syncFromGateway();
                }
            };

            // Initial registration attempt
            setTimeout(registerAll, 1500);
        };

        registerWithGateway();

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
        console.log(`🎨 Admin Panel: ${config.site.frontendUrl}/admin`);
        console.log(`🏠 Public Site: ${config.site.frontendUrl}`);
        console.log('');
    });
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

