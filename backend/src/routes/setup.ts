import type { Request, Response, NextFunction } from 'express';
const express = require('express');
const router = express.Router();
const { getConfig, saveConfig, isInstalled } = require('../core/configManager');
const config = require('../config/app');
const path = require('path');
const { verifyInstallToken } = require('../core/install-token');
// The installer runs before any account exists, so its 500s are the most exposed in the product:
// whatever broke (a filesystem path, a database DSN, a TLS library) is logged, never answered.
const { publicErrorText } = require('../middleware/errorHandler');

// Gate for the PRE-INSTALL endpoints (/install, /test-db). These run before the instance is
// configured, so they are unauthenticated and exempt from CSRF — require the one-time install token
// (written to backend/data/install-token at boot, printed only when stdout is a TTY) to stop a pre-install takeover. Constant-time compared in
// verifyInstallToken(). Accepts the token via the `x-install-token` header or an `installToken` body
// field so the installer UX stays simple (operator copies it from the terminal or the 0600 file).
function requireInstallToken(req: Request, res: Response): boolean {
    const provided = req.get('x-install-token') || (req.body && req.body.installToken);
    if (!verifyInstallToken(provided)) {
        res.status(403).json({ error: 'Invalid or missing install token. Read it from the server terminal or from backend/data/install-token.' });
        return false;
    }
    return true;
}

/**
 * Which host did the operator actually install on?
 *
 * The gateway proxies with `changeOrigin: true`, so an install that arrives through it carries the
 * UPSTREAM's address in `Host` (e.g. backend:4000) and the operator's real address only in
 * `X-Forwarded-Host`. Reading `Host` alone made the backend record ITSELF as the site origin. On one
 * host that lands on loopback, which the migration guard exempts — so the bug stayed invisible until
 * separate mode, where it wrote the backend node's LAN IP and every later API call 409'd
 * `migration_required`. Same precedence as the migration guard in index.ts.
 *
 * Exported for tests — pure; the caller supplies the header values and validates the result.
 */
function pickInstallHost(forwardedHost: unknown, host: unknown): string {
    return String(forwardedHost || host || '').split(',')[0].trim();
}

/**
 * The shape a request-derived host must have before this file will build a site origin out of it.
 *
 * Hoisted to module scope, and consumed by BOTH endpoints that write one. It used to be declared inside
 * the POST /setup/install handler only, so POST /setup/migrate — the one endpoint of this router that
 * outlives the install, and the only other one that PERSISTS a site origin — derived its host as a bare
 * `req.get('x-forwarded-host') || req.get('host')`. `req.get()` is `string | undefined`, so an absent Host
 * (HTTP/1.0 imposes none, and Node delivers such a request with `req.headers.host === undefined`) made
 * `` `${protocol}://${host}` `` the literal string 'http://undefined', which /migrate then saved as
 * config.siteUrl and as the `siteurl` option — and config.site.url is an entry of the same-origin
 * allow-lists in middleware/auth.ts and routes/collab.ts. One host-less migrate installed
 * 'http://undefined' as a same-origin PERMANENTLY, and re-minted the mTLS SANs around it. Two endpoints,
 * one question about the same header, and only one of them was answering it.
 *
 * NOTE that the pattern ACCEPTS the label 'undefined' — it is a syntactically valid host. That is exactly
 * why the absent header must arrive here as the empty string (pickInstallHost above) and not as the word:
 * the guard cannot tell the two apart, so the derivation must never produce the word in the first place.
 */
const INSTALL_HOST_PATTERN = /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$/;

/**
 * Was this node provisioned by cluster enrollment (scripts/node-join.js) rather than being a fresh
 * single-host box? Enrollment writes the gateway wiring plus an mTLS identity signed by the cluster
 * CA that lives on the GATEWAY. The installer must treat all of that as authoritative instead of
 * overwriting it with its own single-host defaults.
 *
 * Exported for tests — pure; `certExists` is the caller's filesystem check.
 */
function isEnrolledConfig(cfg: any, certExists: boolean): boolean {
    return !!(cfg && cfg.advertiseHost && cfg.mtls && cfg.mtls.cert && certExists);
}

/**
 * @swagger
 * tags:
 *   name: Setup
 *   description: >-
 *     The installation wizard and the post-move repair endpoint. These predate any account, so they are
 *     gated by the one-time install token minted at boot (0600 file; printed only on a TTY) rather than by a session.
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     PlainError:
 *       type: object
 *       description: >-
 *         The bare error envelope used by the installer and the certificate endpoints. It is NOT the
 *         rest_* envelope the rest of the API returns.
 *       properties:
 *         error:
 *           type: string
 */
// Check installation status
/**
 * @swagger
 * /setup/status:
 *   get:
 *     summary: Is this instance installed, and does its stored URL still match the request host?
 *     description: >-
 *       Public and unauthenticated — the wizard and the migration screen both poll it before anything
 *       exists to authenticate against. `mismatch` is what the migration guard keys on: while it is
 *       true, every route outside /setup answers 409 migration_required.
 *     tags: [Setup]
 *     security: []
 *     responses:
 *       200:
 *         description: Install state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 installed:
 *                   type: boolean
 *                 mismatch:
 *                   type: boolean
 *                   description: The configured site URL does not match the host this request arrived on.
 *                 configUrl:
 *                   type: string
 *                   nullable: true
 *                 detectedUrl:
 *                   type: string
 *                   description: Derived from X-Forwarded-Proto / X-Forwarded-Host, falling back to the request's own.
 */
router.get('/status', (req: Request, res: Response) => {
    const installed = isInstalled();
    const currentConfig = getConfig();

    // Check for URL mismatch if installed
    let mismatch = false;
    let detectedUrl = '';

    if (installed && currentConfig && currentConfig.siteUrl) {
        // Fix: Trust upstream Gateway protocol
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        // Fix: Use X-Forwarded-Host if available (from Next.js proxy)
        const host = req.get('x-forwarded-host') || req.get('host');
        detectedUrl = `${protocol}://${host}`;

        // Simple normalization for comparison (remove trailing slash)
        // Remove protocol for safer comparison if protocol proxying is tricky
        const storedUrl = currentConfig.siteUrl.replace(/\/$/, '').replace(/^https?:\/\//, '');
        const currentHost = detectedUrl.replace(/^https?:\/\//, '');

        if (storedUrl !== currentHost) {
            mismatch = true;
        }
    }

    res.json({
        installed,
        mismatch,
        configUrl: currentConfig ? currentConfig.siteUrl : null,
        detectedUrl
    });
});

// Test a database connection BEFORE committing the install, so the wizard can validate Postgres
// credentials. Isolated: uses a throwaway pg client and never switches the live driver. Always 200
// with { ok, message|error } so the wizard can render the result inline.
/**
 * @swagger
 * /setup/test-db:
 *   post:
 *     summary: Validate database credentials before committing the install
 *     description: >-
 *       Uses a throwaway client and never switches the live driver. A connection FAILURE is reported as
 *       200 with ok=false so the wizard can render it inline — the non-200 answers below are about the
 *       endpoint itself, not about the database. Exempt from the CSRF checks, because it runs before any
 *       origin or user exists; the install token is what guards it instead.
 *     tags: [Setup]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: x-install-token
 *         schema:
 *           type: string
 *         description: >-
 *           The one-time install token minted at boot (`backend/data/install-token`, printed only when stdout is a TTY). May also be sent as an
 *           `installToken` body field. Compared in constant time.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               installToken:
 *                 type: string
 *                 description: Alternative to the x-install-token header.
 *               dbDriver:
 *                 type: string
 *                 default: sqlite-native
 *                 enum: [sqlite-native, sqlite-legacy, postgres, mysql]
 *               db:
 *                 type: object
 *                 description: Connection details. Required for postgres and mysql; ignored for the SQLite drivers.
 *                 properties:
 *                   host:
 *                     type: string
 *                   port:
 *                     type: integer
 *                   user:
 *                     type: string
 *                   password:
 *                     type: string
 *                   database:
 *                     type: string
 *                   ssl:
 *                     type: boolean
 *     responses:
 *       200:
 *         description: The probe ran — read `ok` for the verdict
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   description: Present when ok is true.
 *                 error:
 *                   type: string
 *                   description: Present when ok is false — the driver's own message, or an unknown-driver refusal.
 *       400:
 *         description: The instance is already installed, so this endpoint is closed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 error:
 *                   type: string
 *       403:
 *         description: Invalid or missing install token.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       429:
 *         description: Rate limited by the setup limiter.
 */
router.post('/test-db', async (req: Request, res: Response) => {
    if (isInstalled()) return res.status(400).json({ ok: false, error: 'Already installed' });
    if (!requireInstallToken(req, res)) return;
    const { dbDriver = 'sqlite-native', db: dbConn } = req.body || {};
    try {
        if (dbDriver === 'postgres') {
            if (!dbConn || !dbConn.host || !dbConn.database || !dbConn.user) {
                return res.json({ ok: false, error: 'host, database and user are required.' });
            }
            const { Client } = require('pg');
            const client = new Client({
                host: dbConn.host,
                port: Number(dbConn.port) || 5432,
                user: dbConn.user,
                password: dbConn.password || '',
                database: dbConn.database,
                ssl: dbConn.ssl ? { rejectUnauthorized: false } : undefined,
                connectionTimeoutMillis: 4000
            });
            await client.connect();
            await client.query('SELECT 1');
            await client.end();
            return res.json({ ok: true, message: 'PostgreSQL connection successful.' });
        }
        if (dbDriver === 'mysql') {
            if (!dbConn || !dbConn.host || !dbConn.database || !dbConn.user) {
                return res.json({ ok: false, error: 'host, database and user are required.' });
            }
            const mysql = require('mysql2/promise');
            const conn = await mysql.createConnection({
                host: dbConn.host,
                port: Number(dbConn.port) || 3306,
                user: dbConn.user,
                password: dbConn.password || '',
                database: dbConn.database,
                ssl: dbConn.ssl ? { rejectUnauthorized: false } : undefined,
                connectTimeout: 4000
            });
            await conn.query('SELECT 1');
            await conn.end();
            return res.json({ ok: true, message: 'MySQL connection successful.' });
        }
        if (dbDriver === 'sqlite-native' || dbDriver === 'sqlite-legacy') {
            const fs = require('fs');
            const dataDir = path.resolve('./data');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.accessSync(dataDir, fs.constants.W_OK);
            return res.json({ ok: true, message: 'SQLite data directory is writable.' });
        }
        return res.json({ ok: false, error: 'Invalid database driver.' });
    } catch (e: any) {
        return res.json({ ok: false, error: e && e.message ? e.message : 'Connection failed.' });
    }
});

/**
 * @swagger
 * /setup/install:
 *   post:
 *     summary: Install the instance
 *     description: >-
 *       One-shot: closed forever once `isInstalled()` is true. Writes the config, creates the
 *       administrator, runs the migrations, optionally seeds starter content, and auto-logs the
 *       administrator in by issuing a session cookie. Exempt from the CSRF checks (no origin and no user
 *       exist yet) — the one-time install token is the gate. The site URL is taken from an explicit
 *       `siteUrl` when given; otherwise it is derived from X-Forwarded-Proto / X-Forwarded-Host and
 *       validated against a strict hostname-or-IP pattern, because those headers are caller-controlled
 *       and the value ends up in the same-origin allow-list. On a cluster-enrolled node the enrollment
 *       identity and gateway wiring are preserved rather than overwritten.
 *     tags: [Setup]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: x-install-token
 *         schema:
 *           type: string
 *         description: >-
 *           The one-time install token minted at boot (`backend/data/install-token`, printed only when stdout is a TTY). May also be sent as an
 *           `installToken` body field.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [siteName, adminUser, adminEmail, adminPassword]
 *             properties:
 *               installToken:
 *                 type: string
 *               siteName:
 *                 type: string
 *               siteDescription:
 *                 type: string
 *               adminUser:
 *                 type: string
 *                 description: At least 3 characters, from letters, digits and . _ - only.
 *               adminEmail:
 *                 type: string
 *               adminPassword:
 *                 type: string
 *                 minLength: 10
 *               dbDriver:
 *                 type: string
 *                 default: sqlite-native
 *                 enum: [sqlite-native, sqlite-legacy, postgres, mysql]
 *               db:
 *                 type: object
 *                 description: Required for postgres and mysql — host, database and user at minimum.
 *                 properties:
 *                   host:
 *                     type: string
 *                   port:
 *                     type: integer
 *                   user:
 *                     type: string
 *                   password:
 *                     type: string
 *                   database:
 *                     type: string
 *                   ssl:
 *                     type: boolean
 *               siteUrl:
 *                 type: string
 *                 description: >-
 *                   Explicit absolute http(s) origin. Takes precedence over the request headers; its host
 *                   must still be a valid hostname or IP.
 *               frontendUrl:
 *                 type: string
 *               demoContent:
 *                 type: boolean
 *                 default: true
 *                 description: Seed a starter home page, welcome post, About page and header menu.
 *     responses:
 *       200:
 *         description: Installed. A session cookie for the new administrator is set when auto-login succeeded.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 autoLoggedIn:
 *                   type: boolean
 *                 redirectTo:
 *                   type: string
 *                 emailProviderAvailable:
 *                   type: boolean
 *                   description: >-
 *                     False on a fresh install with no mail plugin — self-service password recovery will
 *                     not work until one is loaded.
 *                 tests:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     passed:
 *                       type: integer
 *                     failed:
 *                       type: integer
 *       400:
 *         description: >-
 *           Already installed, or a validation failure — missing site name, a bad admin username or
 *           email, an admin password under 10 characters, an unknown database driver, missing
 *           Postgres/MySQL connection details, or a site host that could not be derived or validated.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       403:
 *         description: Invalid or missing install token.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       429:
 *         description: Rate limited by the setup limiter.
 *       500:
 *         description: The configuration could not be written, or the install itself failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 */
// Install endpoint
router.post('/install', async (req: Request, res: Response) => {
    if (isInstalled()) {
        return res.status(400).json({ error: 'Already installed' });
    }
    if (!requireInstallToken(req, res)) return;

    const {
        siteName,
        siteDescription,
        adminUser,
        adminEmail,
        adminPassword,
        dbDriver = 'sqlite-native',
        db: dbConn, // Postgres connection {host,port,user,password,database,ssl} when dbDriver==='postgres'
        demoContent = true // seed starter content (welcome post, Puck home page, About, header menu)
    } = req.body;

    // --- Validation (this endpoint is public pre-config, so validate server-side too) ---
    const fail = (msg: string) => res.status(400).json({ error: msg });
    if (!siteName || !String(siteName).trim()) return fail('Site name is required.');
    if (!adminUser || !/^[a-zA-Z0-9_.-]{3,}$/.test(String(adminUser))) return fail('Admin username must be at least 3 characters (letters, numbers, . _ -).');
    if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(adminEmail))) return fail('A valid admin email is required.');
    if (!adminPassword || String(adminPassword).length < 10) return fail('Admin password must be at least 10 characters.');
    const ALLOWED_DRIVERS = ['sqlite-native', 'sqlite-legacy', 'postgres', 'mysql'];
    if (!ALLOWED_DRIVERS.includes(dbDriver)) return fail('Invalid database driver.');
    if ((dbDriver === 'postgres' || dbDriver === 'mysql') && (!dbConn || !dbConn.host || !dbConn.database || !dbConn.user)) {
        return fail(`${dbDriver === 'mysql' ? 'MySQL' : 'PostgreSQL'} requires host, database, and user.`);
    }

    // SECURITY: siteUrl and the mTLS cert SANs below are derived from the request host. The Host /
    // X-Forwarded-* headers are attacker-controllable, so an explicit operator-provided siteUrl takes
    // precedence; otherwise we accept the request host ONLY after validating it against a strict
    // hostname/IP[:port] allow-pattern (defeats header injection / CRLF / bogus SAN poisoning).
    // Install is already gated by the one-time install token; this is defense-in-depth on top of that.
    // The pattern lives at module scope (INSTALL_HOST_PATTERN) so /setup/migrate validates identically.
    const HOST_PATTERN = INSTALL_HOST_PATTERN;

    let protocol: string;
    let host: string;
    const explicitSiteUrl = req.body.siteUrl ? String(req.body.siteUrl).trim() : '';
    if (explicitSiteUrl) {
        // Operator passed an explicit site URL — trust it but parse + validate its shape.
        let parsed: URL;
        try {
            parsed = new URL(explicitSiteUrl);
        } catch {
            return fail('siteUrl must be a valid absolute URL (e.g. https://example.com).');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return fail('siteUrl must use http or https.');
        }
        if (!HOST_PATTERN.test(parsed.host)) {
            return fail('siteUrl host is not a valid hostname or IP address.');
        }
        protocol = parsed.protocol.replace(':', '');
        host = parsed.host;
    } else {
        // Derive from the (attacker-controllable) request headers — validate before any use.
        const rawProto = req.get('x-forwarded-proto') || req.protocol;
        protocol = String(rawProto).split(',')[0].trim().toLowerCase();
        if (protocol !== 'http' && protocol !== 'https') {
            return fail('Invalid request protocol; pass an explicit siteUrl in the installer.');
        }
        // Prefer X-Forwarded-Host over Host — see pickInstallHost() above for why.
        const rawHost = pickInstallHost(req.get('x-forwarded-host'), req.get('host'));
        if (!HOST_PATTERN.test(rawHost)) {
            return fail('Could not determine a valid install host. Pass an explicit siteUrl in the installer.');
        }
        host = rawHost;
    }
    const siteUrl = `${protocol}://${host}`;

    // Save config
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');

    // SECURITY: Auto-generate cryptographically secure secrets
    const jwtSecret = crypto.randomBytes(64).toString('hex');
    const gatewaySecret = crypto.randomBytes(32).toString('hex');

    // Was this node provisioned by CLUSTER ENROLLMENT (scripts/node-join.js, separate mode)? If so the
    // gateway is the cluster CA: it already issued this node a CN=backend identity, handed it the shared
    // gatewaySecret, and pinned the address the gateway dials (advertiseHost, with host bound 0.0.0.0).
    // The installer's own defaults below describe a SINGLE-HOST install and would silently undo all of
    // it — re-minting a *different* CA over the enrolled certs (and dropping the CA private key, which
    // must never leave the gateway, onto this node), rotating gatewaySecret away from the gateway's, and
    // re-binding the listener to localhost where a remote gateway cannot reach it. Enrollment values are
    // authoritative here; the wizard only supplies what enrollment does not know (site identity, DB).
    const enrolledConfig = getConfig() || {};
    // WHERE the certificate is, is NOT a question this call site may answer for itself.
    //
    // THE CLASS: "one declaration" of a path that is in fact two values computed differently. This line
    // used to resolve `config.mtls.cert` against the CURRENT WORKING DIRECTORY, while core/frontend-purge
    // `clusterCertPaths()` — the resolver the rest of the codebase was consolidated onto — anchors the
    // same key to BACKEND_ROOT. Started from the repo root (or from any supervisor whose cwd is not
    // backend/), this existsSync looked at <repo>/certs/backend.crt, which does not exist, so an ENROLLED
    // node was mistaken for a fresh single-host box: the wizard then re-minted a different cluster CA over
    // the certificates the gateway had issued, dropped the CA private key (which must never leave the
    // gateway) onto this node, rotated gatewaySecret away from the gateway's, and re-bound the listener to
    // localhost where the remote gateway cannot reach it. `purgeTransport` even documents that it uses
    // "the same predicate as the installer" — so the two sides the code declares must agree had diverged.
    // scripts/separate-mode-gate.mjs models exactly this as its 'install-identity' sabotage.
    //
    // One resolver, consumed — not a second copy of the arithmetic.
    const { clusterCertPaths } = require('../core/frontend-purge');
    const isEnrolledNode = isEnrolledConfig(
        enrolledConfig,
        !!enrolledConfig.mtls?.cert && fs.existsSync(clusterCertPaths(enrolledConfig).cert)
    );
    if (isEnrolledNode) {
        console.log(`🔗 Setup: cluster-enrolled node detected (advertiseHost=${enrolledConfig.advertiseHost}) — preserving enrollment identity and gateway wiring.`);
    }

    // Frontend URL — the origin visitors use, stored as the `home` option.
    // Single host: the frontend sits next to the gateway on :3001. Cluster: the frontend is on
    // ANOTHER machine and is only reachable through the gateway, so `siteUrl.replace(':3000',':3001')`
    // would name the gateway's host with the frontend's private port — an address nothing serves.
    // The public origin of an enrolled cluster IS the gateway.
    const frontendUrl = req.body.frontendUrl
        || (isEnrolledNode ? siteUrl : siteUrl.replace(':3000', ':3001'));

    // newConfig is mutated below (mtls paths, host identities), so type it loosely.
    const newConfig: Record<string, any> = {
        // Marks the site as SET UP, which is not the same as "a config file exists" — cluster enrollment
        // writes this same file onto a fresh node that still needs the wizard (see core/configManager
        // isInstalled).
        installedAt: new Date().toISOString(),
        siteUrl,
        frontendUrl,
        port: 4000,
        frontendPort: 3001,
        gatewayPort: 3000,
        gatewayInternalPort: enrolledConfig.gatewayInternalPort || 3100,
        // Host for the backend server listen binding (usually localhost or 0.0.0.0). An enrolled node
        // MUST keep the binding enrollment chose — the gateway lives on another machine.
        host: isEnrolledNode ? (enrolledConfig.host || '0.0.0.0') : 'localhost',
        // Public Gateway URL (FQDN/IP) captured from the request (Forwarded or Host)
        gatewayUrl: `${protocol}://${host}`, // Store full URL just in case
        // Which host this backend DIALS for the gateway control plane. On an enrolled node that is the
        // gateway machine (from the join), NOT the public site host the browser used.
        gatewayHost: isEnrolledNode ? enrolledConfig.gatewayHost : host.split(':')[0],
        // Rotating this on an enrolled node would desynchronise it from the gateway's shared secret.
        gatewaySecret: isEnrolledNode ? enrolledConfig.gatewaySecret : gatewaySecret,
        jwtSecret: jwtSecret, // Store in config for reference
        // Database selection (chosen in the installer). SQLite drivers use their own file; Postgres
        // stores a connection object. The driver layer reads these from the live config.
        dbDriver,
        ...((dbDriver === 'postgres' || dbDriver === 'mysql')
            ? {
                db: {
                    host: dbConn.host,
                    port: Number(dbConn.port) || (dbDriver === 'mysql' ? 3306 : 5432),
                    user: dbConn.user,
                    password: dbConn.password || '',
                    database: dbConn.database,
                    ssl: !!dbConn.ssl
                }
            }
            : { dbPath: dbDriver === 'sqlite-native' ? './data/wordjs-native.db' : './data/wordjs.db' })
    };

    // Note: We no longer write to .env as per "Never Use Env Vars" policy.
    // Secrets are persisted solely in wordjs-config.json via saveConfig().

    if (saveConfig(newConfig)) {
        try {
            // Initialize DB connection dynamically
            console.log(`📦 Setup: Initializing database (driver: ${dbDriver})...`);
            // Reflect the just-saved config into the live config object so the driver layer reads the
            // chosen dbDriver / dbPath / Postgres connection (require('../config/app') was loaded with
            // the pre-install defaults).
            Object.assign(config, newConfig);
            const { init, initializeDatabase } = require('../config/database');
            await init({ driver: dbDriver });
            await initializeDatabase();

            // Update options in DB
            const { updateOption } = require('../core/options');
            // Coerce to a string HERE: updateOption serialises with String(value), so an omitted field
            // (headless installs don't always send a tagline) would be stored as the literal text
            // "undefined" and then render in <title>/og:title as "My site — undefined".
            await updateOption('blogname', String(siteName ?? ''));
            await updateOption('blogdescription', String(siteDescription ?? ''));
            await updateOption('siteurl', String(siteUrl ?? ''));
            await updateOption('home', String(frontendUrl ?? ''));

            // SECURITY: Generate mTLS Certificates — but NEVER on a cluster-enrolled node. There the
            // cluster CA already exists on the GATEWAY (its private key deliberately never leaves that
            // machine) and this node holds a CN=backend leaf signed by it. Minting a second, unrelated
            // CA here overwrites that leaf with one the gateway does not trust — the backend keeps
            // serving only until its next restart, then every mTLS handshake with the gateway fails and
            // the whole cluster goes dark. Keep the enrolled identity; enrollment is the source of truth.
            if (isEnrolledNode) {
                console.log('🔐 Setup: cluster-enrolled node — keeping the gateway-issued mTLS identity (not re-minting a CA).');
                newConfig.mtls = enrolledConfig.mtls;
            } else {
                console.log('🔐 Setup: Generating mTLS certificates...');
                try {
                    const { generateClusterCA, generateServiceCert } = require('../core/certManager');
                    const ca = generateClusterCA();

                    // Derive Subdomains based on installation host
                    const baseHost = host.split(':')[0];
                    const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(baseHost);

                    // Logic: If host is "wordjs.com", we create "gateway.wordjs.com", "backend.wordjs.com", etc.
                    // If it's an IP, we just use the IP.
                    const getSubdomain = (prefix: string) => {
                        if (isIp || baseHost === 'localhost') return baseHost;
                        // Avoid double prefixing if user installed on a subdomain already
                        const parts = baseHost.split('.');
                        if (parts.length > 2) {
                            // Already a subdomain, just replace the first part or append
                            return `${prefix}.${parts.slice(1).join('.')}`;
                        }
                        return `${prefix}.${baseHost}`;
                    };

                    const gatewayHost = getSubdomain('gateway');
                    const backendHost = getSubdomain('backend');
                    const frontendHost = getSubdomain('frontend');

                    // Save identities to config for persistence
                    newConfig.gatewayHost = gatewayHost; // Align target with identity
                    newConfig.gatewayHostIdentity = gatewayHost;
                    newConfig.backendHostIdentity = backendHost;
                    newConfig.frontendHostIdentity = frontendHost;

                    // SAVE EXPLICIT mTLS PATHS
                    newConfig.mtls = {
                        ca: './certs/cluster-ca.crt',
                        key: './certs/backend.key',
                        cert: './certs/backend.crt'
                    };

                    // Generate Service Certs with specific SANs
                    generateServiceCert('gateway-internal', ca.key, ca.cert, [
                        isIp ? { type: 7, ip: gatewayHost } : { type: 2, value: gatewayHost }
                    ]);
                    generateServiceCert('backend', ca.key, ca.cert, [
                        isIp ? { type: 7, ip: backendHost } : { type: 2, value: backendHost }
                    ]);
                    generateServiceCert('frontend', ca.key, ca.cert, [
                        isIp ? { type: 7, ip: frontendHost } : { type: 2, value: frontendHost }
                    ]);

                    console.log(`✅ mTLS Certificates generated for: ${gatewayHost}, ${backendHost}, ${frontendHost}`);

                } catch (e) {
                    console.error('❌ Setup failed during mTLS generation:', e);
                    res.status(500).json({ error: publicErrorText(e, 'Setup failed during mTLS generation.') });
                    return; // Exit if mTLS generation fails
                }
            }

            // SECURITY: Delegate cluster orchestration to the autonomous Setup service.
            // The monolith is a SINGLE process — there is no separate gateway/frontend to distribute
            // certs/config to — so this cluster step is a no-op there. Skip it (this also avoids
            // needing the root setup/ package, which the compiled monolith release doesn't ship deps for).
            if (process.env.WORDJS_EMBEDDED === '1') {
                console.log('ℹ️ Monolith (embedded) — skipping cluster artifact distribution (single process, not needed).');
            } else if (isEnrolledNode) {
                // Separate mode: the gateway and frontend are on OTHER machines and were provisioned by
                // their own join. There is nothing local to distribute to, and the distributor rewrites
                // sibling gateway/frontend cert dirs that do not exist here.
                console.log('ℹ️ Cluster-enrolled node — skipping local artifact distribution (peers provisioned by their own join).');
            } else {
                console.log('🏗️ Setup: Orchestrating cluster via standalone service...');
                try {
                    // Three levels up from backend/{src,dist}/routes/ to reach the repo-root setup/ package
                    // (the previous two-level path resolved to backend/setup, which does not exist).
                    const WordJSSetup = require('../../../setup/index');
                    const orchestrator = new WordJSSetup(path.resolve(__dirname, '../../../'));
                    await orchestrator.distribute(newConfig);
                    console.log('✅ Cluster artifacts distributed via autonomous Setup service');
                } catch (err) {
                    console.error('❌ Failed to trigger autonomous setup:', err.message);
                    console.warn('⚠️ Manual distribution might be required: npm run setup');
                }
            }

            // Initialize Roles & CMS items
            const { loadRoles, syncRoles } = require('../core/roles');
            await loadRoles();
            await syncRoles({});

            // Post types + taxonomies for THIS process. index.ts registers them inside the
            // `if (isInstalled())` boot branch, so a process that booted in SETUP MODE and then
            // installed IN-PROCESS never had them: `getPostType('page')` returned null and the very
            // first "create page" after finishing the wizard was rejected with 400
            // rest_invalid_post_type — with the wizard's own demo content already in the database
            // (Post.create does not gate on the registry, the write ROUTES do). Same class as the
            // frontend-purge hook fixed earlier in initialize(): registration that a fresh install
            // silently skips. Registration is idempotent, so this is safe on every install path.
            const { initPostTypes, initTaxonomies } = require('../core/post-types');
            await initPostTypes();
            await initTaxonomies();

            const Term = require('../models/Term');
            await Term.create({ name: 'Uncategorized', taxonomy: 'category', slug: 'uncategorized', description: 'Default category' });

            // The ONE moment the product provisions a theme on its own: install. This is Ghost shipping
            // casper with the package — a site must not finish the wizard with an empty themes dir.
            // Boot deliberately does NOT do this any more (it verifies and warns); the only other caller
            // is POST /api/v1/themes/default, where an admin asked for a restore.
            const { createDefaultTheme } = require('../core/themes');
            createDefaultTheme();

            const User = require('../models/User');
            const adminEmailDisplay = adminEmail || `${adminUser}@no-email.local`;
            let admin = await User.findByEmail(adminEmailDisplay) || await User.findByLogin(adminUser);

            if (!admin) {
                await User.create({ username: adminUser, email: adminEmailDisplay, password: adminPassword, displayName: 'Administrator', role: 'administrator' });
            } else {
                await User.update(admin.id, { password: adminPassword, email: adminEmailDisplay, role: 'administrator' });
            }

            // Persist the admin's email as the site admin_email option (was left at the default before).
            await updateOption('admin_email', adminEmailDisplay);

            // Starter content (opt-in from the wizard, default on): a designed Puck home page set as
            // the front page, a welcome post, an About page and a header menu — so the first thing a
            // new user sees is the visual editor's output, not "No posts found". Best-effort: the
            // seeder never throws; a failure must not fail the install.
            if (demoContent !== false && demoContent !== 'false') {
                try {
                    const seededAdmin = await User.findByLogin(adminUser) || await User.findByEmail(adminEmailDisplay);
                    const { seedStarterContent } = require('../core/starter-content');
                    const seeded = await seedStarterContent(seededAdmin ? seededAdmin.id : 1, String(siteName));
                    console.log('🌱 Starter content:', JSON.stringify(seeded));
                } catch (e: any) {
                    console.warn('⚠️ Starter content seeding failed (install continues):', e && e.message);
                }
            }

            // The install just wrote settings, menus and starter content in bulk — purge the
            // frontend caches explicitly (read-your-writes for the wizard), independent of the
            // hook-driven purges that also fired along the way.
            try {
                require('../core/frontend-purge').purgeFrontend(
                    ['settings', 'posts', 'menus', 'plugin-assets', 'fonts'], ['/']
                );
            } catch { /* best-effort — ISR TTL covers it */ }

            const { runCoreTests } = require('../core/plugin-test-runner');
            const testResults = await runCoreTests();

            if (!testResults.success) {
                console.warn(`⚠️ CMS core tests had failures (${testResults.failed}/${testResults.tests})`);
                // We don't block installation, just warn
            }

            // Auto-login: issue the admin's session cookie so the wizard lands straight in /admin.
            let autoLoggedIn = false;
            try {
                const createdAdmin = await User.findByLogin(adminUser) || await User.findByEmail(adminEmailDisplay);
                if (createdAdmin) {
                    // THE ONE DOOR (middleware/auth.ts:issueSessionCookie) — not a hand-rolled res.cookie.
                    // The rule "a headless request may never cause a session cookie to be emitted" is only
                    // structural if every cookie-issuing site goes through the one function that enforces
                    // it; a second, hand-written copy of the sink turns the rule back into a convention.
                    // This particular call is a no-op today (the setup router carries no `authenticate`,
                    // so req.apiToken never exists here), which is precisely why it was easy to miss — the
                    // hygiene test in auth-headless-session.test.ts now fails if a third copy appears.
                    const { generateToken, issueSessionCookie } = require('../middleware/auth');
                    const token = generateToken(createdAdmin);
                    // Returns true when it REFUSED and already sent the response — the caller must return.
                    if (issueSessionCookie(req, res, token, {
                        httpOnly: true,
                        secure: siteUrl.startsWith('https://'),
                        sameSite: 'lax',
                        maxAge: 7 * 24 * 60 * 60 * 1000,
                        path: '/'
                    })) return;
                    autoLoggedIn = true;
                }
            } catch (e: any) {
                console.warn('Auto-login after install failed (user can log in manually):', e && e.message);
            }

            // Install complete — remove the on-disk install-token mirror so the bootstrap secret does
            // not linger (the token is irrelevant now; the setup endpoints early-return once installed).
            try { require('../core/install-token').clearInstallTokenFile(); } catch { /* best-effort */ }

            // A fresh install has no mail plugin loaded, so the core cannot send email — which means NO
            // self-service password recovery. Report it so the wizard's final screen can warn the admin
            // instead of leaving them to discover a dead "Forgot password?" flow later. Same derived
            // signal as the admin `email_provider_available` settings flag and the boot-time warning.
            let emailProviderAvailable = false;
            try { emailProviderAvailable = require('../core/mail-provider').isEmailProviderAvailable() === true; } catch { /* default false */ }

            res.json({
                success: true,
                autoLoggedIn,
                redirectTo: autoLoggedIn ? '/admin' : '/login?installed=true',
                emailProviderAvailable,
                tests: { total: testResults.tests, passed: testResults.passed, failed: testResults.failed }
            });

        } catch (e) {
            console.error('❌ Setup failed:', e);
            res.status(500).json({ error: publicErrorText(e, 'Setup failed during the install.') });
        }
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

/**
 * @swagger
 * /setup/migrate:
 *   post:
 *     summary: Repoint an installed instance at the host it now answers on
 *     description: >-
 *       The escape hatch from a domain move. While the stored site URL disagrees with the request host,
 *       the migration guard answers 409 on every route outside /setup — including /auth/login — so this
 *       endpoint authenticates raw ADMINISTRATOR credentials from the body instead of a session. It is
 *       NOT CSRF-exempt (unlike /setup/install and /setup/test-db): it needs no ambient cookie, so the
 *       same-origin check costs it nothing. Wrong password and correct-password-but-not-an-administrator
 *       are answered identically, so the only distinguishable outcome is a correct administrator
 *       credential; repeated failures buy an escalating bounded WAIT under a dedicated throttle bucket
 *       that can never lock the real administrator out of interactive login. The new host is derived
 *       from X-Forwarded-Host / Host and validated exactly as POST /setup/install validates it.
 *     tags: [Setup]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: >-
 *           Site URL repointed and the mTLS identities re-issued for the new domain. Only the safe
 *           fields are echoed — never the whole config, which carries the JWT and gateway secrets.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 siteUrl:
 *                   type: string
 *                 frontendUrl:
 *                   type: string
 *       400:
 *         description: >-
 *           The instance is not installed, or no valid site host could be derived from this request —
 *           send the migration through the host you are migrating TO.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       401:
 *         description: >-
 *           Credentials absent, or the uniform refusal for "wrong password" and "correct password but
 *           not an administrator" — deliberately indistinguishable.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       403:
 *         description: The same-origin CSRF check refused the request.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: >-
 *           Too many simultaneous attempts for this account from this address, or the strict per-IP auth
 *           limiter (10 per hour) that this route is mounted behind.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 *       500:
 *         description: The new configuration could not be written.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlainError'
 */
// Migration endpoint
router.post('/migrate', async (req: Request, res: Response) => {
    if (!isInstalled()) {
        return res.status(400).json({ error: 'Not installed' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(401).json({ error: 'Authentication required. Please provide admin credentials.' });
    }

    try {
        // Why this endpoint MUST stay reachable pre-auth: during a domain move the Installation/Migration Guard
        // (index.ts) 409s every non-/setup route — including /auth/login — while siteUrl != detected host, so an
        // admin CANNOT obtain a session to bootstrap out of the mismatch. /setup/migrate is the
        // guard-bypassed path that repairs siteUrl, so requiring an authenticated admin session here would break
        // the very flow it exists for. It is NOT CSRF-exempt, though — that exemption is enumerated in
        // middleware/auth.ts and covers only the two pre-install doors. This route needs no ambient cookie
        // (the credentials are in the body), so the same-origin check costs the migration page nothing while
        // keeping the password oracle below off any random visitor's browser. It authenticates raw
        // credentials, which made it a password
        // ORACLE (#26): wrong password → 401, correct NON-admin password → 403, correct admin password → 200 were
        // all DISTINGUISHABLE, giving an unthrottled brute-force oracle (per #25 we deliberately never call
        // recordLoginFail here, so account lockout never trips it).
        //
        // #26 fix WITHOUT reintroducing #25's DoS:
        //   (a) throttle this route under its OWN dedicated per-account bucket keyed with a SEPARATE
        //       'migrate:' prefix (Finding #14, LOW). Earlier we only READ the shared /auth/login bucket and
        //       never wrote to it (recordLoginFail on the SHARED lock was #25's DoS lever — an unauthenticated
        //       caller could lock the real admin out of interactive login). But because this route never
        //       incremented that bucket, its own password guesses were unthrottled per-account, leaving a
        //       distributed brute-force ORACLE that only the per-IP authLimiter (defeatable by a botnet)
        //       covered. A DISTINCT 'migrate:' bucket lets us recordLoginFail on failures here safely: it
        //       cannot touch the interactive-login lock, so a brute-forcer only rate-limits themselves out of
        //       /setup/migrate, never the admin's real login;
        //   (b) collapse the wrong-password AND correct-non-admin branches into ONE uniform 401 (identical status
        //       + body), so the ONLY distinguishable outcome is a correct ADMINISTRATOR credential — which is the
        //       legitimate migration path, not information an attacker profits from;
        //   (c) this route is additionally throttled by the strict authLimiter (10/hr/IP, mounted in index.ts on
        //       /setup/migrate), far tighter than the setupLimiter (20/15min) guarding the pre-install endpoints.
        // clearLoginFails on a SUCCESSFUL admin auth stays (it requires the correct password, so it's not an
        // unauthenticated lever), and clears only the dedicated 'migrate:' bucket.
        const auth = require('./auth');
        // ─── WHY THIS IS A WAIT AND NOT A LOCK ────────────────────────────────────────────────────
        // The dedicated bucket (Finding #14) was the right half of the answer and the check-then-refuse
        // was the wrong one. `username` comes from the body of an ANONYMOUS request, the lock was read
        // BEFORE User.authenticate, and clearLoginFails only ran after a successful ADMIN authentication —
        // which the lock itself prevented. So ten wrong passwords against {username:'admin'} answered the
        // real administrator, holding the CORRECT password, with the same 429 as the attacker. And this is
        // the worst possible door to jam: during a domain move the Installation/Migration Guard 409s every
        // non-/setup route including /auth/login, so /setup/migrate is the ONLY way to repair siteUrl —
        // the site is down and its escape hatch answers "too many attempts", renewably (authLimiter allows
        // one arming per hour per IP; four addresses give permanent denial), with no owner action to clear
        // it. That is exactly the Class 2 hostage routes/users.ts:511-527 declares erased.
        //
        // Same shape as the MFA doors now: the failures buy an escalating BOUNDED WAIT (auth.payFailureDelay
        // — literally the sudo ladder, so the three cannot drift), paid INSIDE the concurrency slot, and the
        // correct credential is never refused. recordLoginFail stays as the counter that feeds the ladder;
        // 'migrate' is a COUNT-ONLY purpose in routes/auth.ts, so it arms no lock anywhere. The uniform 401
        // below is what closes the oracle (#26); the wait is what makes guessing expensive.
        const identity = await auth.resolveLockIdentifier(username);
        // lockBucket, not a hand-built prefix: `'migrate:' + x` produced the same string, but only by
        // coincidence — the day 'migrate' became a real purpose the two spellings would have silently
        // merged into one counter with nothing comparing them. Now there is one spelling.
        const lockKey = auth.lockBucket('migrate', identity);
        // Concurrency backstop (audit AUTH-A3 class, mirrors /login and /auth/mfa): User.authenticate
        // (bcrypt) yields the event loop, so a parallel burst of guesses would otherwise all sleep through
        // the wait together and the ladder would bound latency instead of throughput. The slot is keyed by
        // (account, source address) — NOT by account alone — because the wait is now paid inside it, and an
        // account-wide slot held for seconds is a refusal an anonymous caller could inflict on the admin:
        // the hostage in a different costume. Released in finally.
        const slotKey = auth.lockBucket('migrate', `${identity}|${require('../core/client-ip').clientIp(req)}`);
        if (!(await auth.beginLoginAttempt(slotKey))) {
            return res.status(429).json({ error: 'Too many simultaneous attempts. Try again in a moment.' });
        }
        const User = require('../models/User');
        let user: any = null;
        try {
            await auth.payFailureDelay(lockKey);
            try { user = await User.authenticate(username, password); } catch { user = null; }

            // UNIFORM response for BOTH wrong password (user === null) and correct-password-non-admin (#26): same
            // status + body so neither is distinguishable from the other — only a correct administrator credential
            // proceeds past this point. recordLoginFail (Finding #14) increments the DEDICATED 'migrate:' bucket
            // only — never the interactive-login lock — so it throttles this oracle without the #25 DoS.
            if (!user || user.getRole() !== 'administrator') {
                await auth.recordLoginFail(lockKey);
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            await auth.clearLoginFails(lockKey);
        } finally {
            await auth.endLoginAttempt(slotKey);
        }

        // Fix: Trust upstream Gateway protocol
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        // The host the operator migrated TO — derived and validated EXACTLY as POST /setup/install does,
        // because what is derived here is persisted as config.siteUrl / the `siteurl` option, and that
        // value is itself an entry of the same-origin allow-lists (middleware/auth.ts, routes/collab.ts).
        // A bare `req.get('x-forwarded-host') || req.get('host')` yields `undefined` on a request with no
        // Host header, and `${protocol}://${undefined}` is the string 'http://undefined' — which this
        // endpoint then wrote onto those allow-lists permanently. Fail closed: no derivable host, no
        // migration. See INSTALL_HOST_PATTERN at the top of this file.
        const host = pickInstallHost(req.get('x-forwarded-host'), req.get('host'));
        if (!INSTALL_HOST_PATTERN.test(host)) {
            return res.status(400).json({ error: 'Could not determine a valid site host from this request. Send the migration through the host you are migrating to.' });
        }
        const newSiteUrl = `${protocol}://${host}`;

        // Update config
        const currentConfig = getConfig();

        // Infer new frontend URL
        // If current backend is localhost:3000 and frontend is localhost:3001
        // And new backend is ip:3000
        // We assume new frontend is ip:3001

        let newFrontendUrl = currentConfig.frontendUrl;
        try {
            const oldHostname = new URL(currentConfig.siteUrl).hostname;
            const newHostname = new URL(newSiteUrl).hostname;
            newFrontendUrl = currentConfig.frontendUrl.replace(oldHostname, newHostname);
        } catch (e) {
            console.warn('Could not infer new frontend URL, keeping old one');
        }

        const newConfig = {
            ...currentConfig,
            siteUrl: newSiteUrl,
            frontendUrl: newFrontendUrl
        };

        if (saveConfig(newConfig)) {
            // Update DB options
            const { updateOption } = require('../core/options');
            await updateOption('siteurl', newConfig.siteUrl);
            await updateOption('home', newConfig.frontendUrl);

            // SECURITY: Regenerate mTLS Certificates for new domain
            console.log('🔐 Migration: Regenerating mTLS certificates for new domain...');
            try {
                const { generateClusterCA, generateServiceCert } = require('../core/certManager');
                const fs = require('fs');
                const path = require('path');

                // Read CA (we keep the same CA for stability, just issue new identities)
                const caKey = fs.readFileSync(path.resolve(__dirname, '../../certs/cluster-ca.key'), 'utf8');
                const caCert = fs.readFileSync(path.resolve(__dirname, '../../certs/cluster-ca.crt'), 'utf8');

                // Derive New Subdomains
                const baseHost = new URL(newConfig.siteUrl).hostname;
                const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(baseHost);

                const getSubdomain = (prefix: string) => {
                    if (isIp || baseHost === 'localhost') return baseHost;
                    const parts = baseHost.split('.');
                    return parts.length > 2 ? `${prefix}.${parts.slice(1).join('.')}` : `${prefix}.${baseHost}`;
                };

                const identities = {
                    gateway: getSubdomain('gateway'),
                    backend: getSubdomain('backend'),
                    frontend: getSubdomain('frontend')
                };

                // Generate New Identities
                generateServiceCert('gateway-internal', caKey, caCert, [{ type: isIp ? 7 : 2, [isIp ? 'ip' : 'value']: identities.gateway }]);
                generateServiceCert('backend', caKey, caCert, [{ type: isIp ? 7 : 2, [isIp ? 'ip' : 'value']: identities.backend }]);
                generateServiceCert('frontend', caKey, caCert, [{ type: isIp ? 7 : 2, [isIp ? 'ip' : 'value']: identities.frontend }]);

                // Redistribute
                const rootDir = path.resolve(__dirname, '../../');
                const frontDir = path.resolve(__dirname, '../../admin-next');
                const backendCertsDir = path.join(rootDir, 'certs');

                if (fs.existsSync(backendCertsDir)) {
                    fs.cpSync(backendCertsDir, path.join(rootDir, 'certs'), { recursive: true });
                    if (fs.existsSync(frontDir)) {
                        fs.cpSync(backendCertsDir, path.join(frontDir, 'certs'), { recursive: true });
                    }
                }

                console.log('✅ Identity Migration Complete');
            } catch (e) {
                console.error('❌ Failed to regenerate certificates during migration:', e.message);
            }

            // Return ONLY the safe, caller-relevant fields — NOT the whole config, which carries
            // jwtSecret / gatewaySecret / dbPassword (audit MEDIUM: the full config was echoed back).
            res.json({ success: true, siteUrl: newConfig.siteUrl, frontendUrl: newConfig.frontendUrl });
        } else {
            res.status(500).json({ error: 'Failed to save new configuration' });
        }
    } catch (e) {
        console.error(e);
        return res.status(401).json({ error: e.message || 'Authentication failed' });
    }
});

module.exports = router;
// Pure decision helpers, exported for the install-state tests (the router itself stays the default).
module.exports.pickInstallHost = pickInstallHost;
// Exported for tests — the ONE host allow-pattern both /install and /migrate validate against.
module.exports.INSTALL_HOST_PATTERN = INSTALL_HOST_PATTERN;
module.exports.isEnrolledConfig = isEnrolledConfig;
