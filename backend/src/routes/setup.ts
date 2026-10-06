import type { Request, Response } from 'express';
import type { SiteHost, SiteUrl } from '../core/host-policy';
const express = require('express');
const router = express.Router();
const { getConfig, saveConfig, isInstalled } = require('../core/configManager');
const config = require('../config/app');
const path = require('path');
const { verifyInstallToken } = require('../core/install-token');
const hostPolicy: typeof import('../core/host-policy') = require('../core/host-policy');
const { siteHostPolicy, signInRefusal, sessionCookieOptions } = require('../middleware/auth');
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
 * WHICH ADDRESS IS THIS SITE BEING INSTALLED AT?
 *
 * An explicit `siteUrl` in the body always wins (the wizard sends the address the operator confirmed).
 * Without one, the address is the request's own: core/host-policy `requestAuthority` for the host and
 * `trustedScheme` for the scheme — the same derivation the host gate, CORS and CSRF use. That matters in
 * two directions:
 *
 *   · behind the gateway (`changeOrigin: true`) `Host` is the UPSTREAM's address and the operator's real
 *     one is X-Forwarded-Host. Reading `Host` alone once made the backend record ITSELF as the site, and
 *     in separate mode every later API call was refused. The gateway is a trusted hop (mTLS CN, or a
 *     loopback peer that addressed a loopback authority), so its X-Forwarded-Host is honoured;
 *   · nobody else's X-Forwarded-Host / X-Forwarded-Proto is. Both used to be read from any client, so a
 *     direct caller holding the install token could name the canonical address — or downgrade it to http
 *     with `X-Forwarded-Proto: http` — through headers instead of the body.
 *
 * Both paths end in `parseSiteUrl`, the one validator for an operator-supplied address: http(s) only,
 * no userinfo, path, query or fragment, IPv6 accepted in brackets. An absent or malformed host is a 400
 * — it can never become the literal 'http://undefined' a template string would build.
 *
 * Returns the parsed address, or a reason to answer 400.
 */
function installSiteAddress(req: Request): { site: SiteUrl } | { error: string } {
    const explicit = req.body && req.body.siteUrl !== undefined && req.body.siteUrl !== null && req.body.siteUrl !== ''
        ? String(req.body.siteUrl)
        : '';
    if (explicit) {
        const site = hostPolicy.parseSiteUrl(explicit);
        return site ? { site } : { error: 'siteUrl must be an http(s) address with no path, query or credentials (e.g. https://example.com).' };
    }
    const policy = siteHostPolicy.get();
    const authority = hostPolicy.requestAuthority(req, policy);
    if (!authority.parsed) return { error: 'Could not determine a valid install host. Pass an explicit siteUrl in the installer.' };
    const site = hostPolicy.parseSiteUrl(`${hostPolicy.trustedScheme(req, policy)}://${hostPolicy.serialize(authority.parsed)}`);
    return site ? { site } : { error: 'Could not determine a valid install host. Pass an explicit siteUrl in the installer.' };
}

/** A tunnel name is handed to the next customer when the tunnel restarts, so it is accepted for a week. */
const TUNNEL_ALIAS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The OPTIONAL install-time alias: "also accept the address I am installing from".
 *
 * The wizard prefills the site address from the browser's location, but the operator may correct it —
 * installing through `http://blog.lan:3000` while declaring `https://blog.example.com`. Without an alias
 * the gate would answer 421 to the very tab that just finished the install. So, only when the body asks
 * for it (`acceptCurrentAddress: true`, under the install token), the request's own address becomes an
 * alias — and only a NAMED one: loopback and IP literals are accepted by rule already, and a request
 * address equal to the chosen one needs nothing. A tunnel name gets the same 7-day expiry the
 * site-address API applies; a .local name (anyone on the LAN can answer for it) needs `confirmLocal:
 * true`, exactly as it does there.
 *
 * Returns the alias entry to store, a reason it was not added, or null when nothing was asked or needed.
 */
function installTimeAlias(req: Request, site: SiteUrl): { alias: Record<string, unknown> } | { skipped: string } | null {
    if (!req.body || req.body.acceptCurrentAddress !== true) return null;
    const policy = siteHostPolicy.get();
    const authority = hostPolicy.requestAuthority(req, policy);
    const current = authority.parsed;
    if (!current || current.kind !== 'dns' || hostPolicy.isLoopbackAuthority(current) || current.hostname === site.hostname) return null;
    if (hostPolicy.isLanName(current.hostname) && req.body.confirmLocal !== true) return { skipped: 'local-name-needs-confirmation' };
    const entry = hostPolicy.parseSiteUrl(`${hostPolicy.trustedScheme(req, policy)}://${hostPolicy.serialize(current)}`);
    if (!entry) return { skipped: 'invalid-address' };
    const now = Date.now();
    return {
        alias: {
            url: entry.origin,
            mode: 'serve',
            source: 'install',
            addedAt: new Date(now).toISOString(),
            ...(hostPolicy.isTunnelHost(entry.hostname) ? { expiresAt: new Date(now + TUNNEL_ALIAS_LIFETIME_MS).toISOString() } : {}),
        },
    };
}

/**
 * Classify the install request the way the host gate would have, had the site been installed when it
 * arrived (it was not, so the gate let it through unclassified). 'unknown' means the gate will refuse
 * this address from the next request on; null means there is nothing to classify (no Host, no valid
 * canonical), which every reader treats as today's behaviour.
 */
function classifyInstallRequest(req: Request): SiteHost | 'unknown' | null {
    const policy = siteHostPolicy.get();
    if (!policy.canonical) return null;
    const authority = hostPolicy.requestAuthority(req, policy);
    if (!authority.parsed) return null;
    const verdict = hostPolicy.classify(authority.parsed, policy, { proxied: authority.proxied });
    if (verdict.cls === 'unknown') return 'unknown';
    return {
        hostname: authority.parsed.hostname,
        port: authority.parsed.port,
        kind: authority.parsed.kind,
        host: hostPolicy.serialize(authority.parsed),
        cls: verdict.cls,
        reason: verdict.reason,
        entry: verdict.entry,
        hop: authority.hop,
        viaTrustedHop: authority.viaTrustedHop,
        scheme: hostPolicy.trustedScheme(req, policy),
    };
}

/**
 * The pre-install suggestion for the wizard's site-address field: WORDJS_SITE_URL, when it is a valid
 * site address that is NOT loopback (REDTEAM R6). Compose exports `http://localhost:3000` by default;
 * offering that would pin a public install's links to the recipient's own machine. The wizard prefills
 * from the browser's location and shows this only as an alternative.
 */
function suggestedSiteUrl(): string | null {
    const site = hostPolicy.parseSiteUrl(process.env.WORDJS_SITE_URL);
    return site && !hostPolicy.isLoopbackAuthority(site) ? site.origin : null;
}

/**
 * Mint the cluster CA and the three service identities of a single-host install, and point the backend's
 * gateway control-plane target at this machine. Mutates `newConfig` (gatewayHost, mtls).
 *
 * INTERNAL IDENTITIES ARE NOT PUBLIC NAMES. These certificates authenticate the three services of ONE
 * machine to each other (peers are pinned by CN: gateway-internal, backend, frontend) and every leg dials
 * loopback. They used to also carry `gateway.<host>` / `backend.<host>`, derived from the address the
 * install request arrived on — a name chosen by whoever sent that request, minted into the cluster's
 * trust, unresolvable on most machines (the gateway's control plane binds loopback), and wrong after
 * every change of the site's address. generateServiceCert always includes localhost and 127.0.0.1, which
 * is exactly what the single-host legs verify against. Nothing here reads the request.
 */
function issueLocalClusterIdentity(newConfig: Record<string, any>): void {
    const { generateClusterCA, generateServiceCert } = require('../core/certManager');
    const ca = generateClusterCA();
    newConfig.gatewayHost = 'localhost';
    newConfig.mtls = {
        ca: './certs/cluster-ca.crt',
        key: './certs/backend.key',
        cert: './certs/backend.crt'
    };
    generateServiceCert('gateway-internal', ca.key, ca.cert);
    generateServiceCert('backend', ca.key, ca.cert);
    generateServiceCert('frontend', ca.key, ca.cert);
}

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
 *     The installation wizard. Its doors predate any account, so they are gated by the one-time install
 *     token minted at boot (0600 file; printed only on a TTY) rather than by a session. After install the
 *     whole subtree is behind the host gate like every other API route.
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
 *     summary: Is this instance installed?
 *     description: >-
 *       Public and unauthenticated — the wizard polls it before anything exists to authenticate against.
 *       It reads nothing from the request: the address a site answers is decided by the host gate, and
 *       the site's own address is never derived from request headers here. After install it is behind
 *       the host gate, so an address the site does not answer gets 421 rest_host_not_allowed.
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
 *                 suggestedSiteUrl:
 *                   type: string
 *                   description: >-
 *                     Before install only, and only when WORDJS_SITE_URL is a valid, non-loopback site
 *                     address: an alternative the wizard may offer next to the browser's own location.
 *       421:
 *         description: rest_host_not_allowed — installed, and this address is not one the site answers.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 */
router.get('/status', (_req: Request, res: Response) => {
    const installed = isInstalled();
    const suggestion = installed ? null : suggestedSiteUrl();
    res.json(suggestion ? { installed, suggestedSiteUrl: suggestion } : { installed });
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
 *       `siteUrl` when given; otherwise it is the address the request was sent to — Host, or
 *       X-Forwarded-Host / X-Forwarded-Proto only from a trusted hop (the gateway, a loopback proxy, the
 *       operator's address-based trustProxy). Either way it must be a plain http(s) origin (IPv6 in
 *       brackets accepted). Auto-login happens only when the address the request used is one the site
 *       will answer and may sign in on; otherwise the response says so and the administrator signs in at
 *       `siteUrl`. On a cluster-enrolled node the enrollment identity and gateway wiring are preserved
 *       rather than overwritten.
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
 *                   Explicit http(s) origin — scheme, host and optional port, nothing else. Takes
 *                   precedence over the request's own address.
 *               acceptCurrentAddress:
 *                 type: boolean
 *                 default: false
 *                 description: >-
 *                   Also answer the NAMED address this request was sent to when it differs from siteUrl,
 *                   by storing it as an alias (a tunnel name expires after 7 days). Loopback and IP
 *                   literals are accepted by rule and never stored.
 *               confirmLocal:
 *                 type: boolean
 *                 description: Required for acceptCurrentAddress to store a .local name, which anyone on the LAN can claim.
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
 *                 autoLoginSkipped:
 *                   type: string
 *                   enum: [address-not-accepted, sign-in-refused]
 *                   description: >-
 *                     Present when no session was issued because this address will be refused from now
 *                     on, or may not mint a session (see POST /auth/login 403 rest_insecure_transport).
 *                 redirectTo:
 *                   type: string
 *                   description: A path, to be opened at siteUrl when the current address is not accepted.
 *                 siteUrl:
 *                   type: string
 *                   description: The main address the site was installed with.
 *                 acceptedAddress:
 *                   type: string
 *                   nullable: true
 *                   description: The alias stored for acceptCurrentAddress, or null.
 *                 acceptedAddressSkipped:
 *                   type: string
 *                   description: Why acceptCurrentAddress stored nothing (local-name-needs-confirmation, invalid-address).
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

    // SECURITY: siteUrl comes from this one address, and it lands in the same-origin allow-lists — see
    // installSiteAddress() for where it may come from. (The gateway wiring and the internal mTLS
    // certificates below deliberately do NOT derive from it.)
    const address = installSiteAddress(req);
    if ('error' in address) return fail(address.error);
    const site = address.site;
    const siteUrl = site.origin;
    const currentAddress = installTimeAlias(req, site);

    // Save config
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');

    // SECURITY: Auto-generate cryptographically secure secrets
    const gatewaySecret = crypto.randomBytes(32).toString('hex');
    // The JWT secret is NOT minted here: the one to persist is the one this process is ALREADY signing
    // with — the per-boot random secret of an unconfigured box, or whatever enrollment / boot-time
    // auto-generation put in the config before boot (config/app.ts). Minting a fresh one wrote secret B
    // to disk while the live process kept signing with A, so every session issued between the install and
    // the first restart — this handler's own auto-login included — was answered 401 rest_token_invalid
    // once the restart loaded B. Persisting A leaves no moment at which the two differ, and never
    // changes the live secret, so nothing derived from it at module load (collab-rooms' replica key)
    // goes stale either. Persisting it also makes it permanent, which is why config/app.ts replaces a
    // short, non-string or published pre-install value at boot, before anything signs with it.
    const jwtSecret = config.jwt.secret;

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
        // Public Gateway URL: the site's own origin at install time.
        gatewayUrl: siteUrl,
        // Which host this backend DIALS for the gateway control plane. On an enrolled node that is the
        // gateway machine (from the join); on a single-host install it is this machine — the gateway's
        // control plane binds loopback by default. Never the public site host the browser used: that
        // name may not resolve here at all, and it is not what the internal certificates are issued for.
        gatewayHost: isEnrolledNode ? enrolledConfig.gatewayHost : 'localhost',
        // The address the operator installed FROM, when they asked for it to keep working (see
        // installTimeAlias). Appended to any list enrollment already carried, never replacing it.
        ...(currentAddress && 'alias' in currentAddress
            ? { siteAliases: [...(Array.isArray(enrolledConfig.siteAliases) ? enrolledConfig.siteAliases : []), currentAddress.alias] }
            : {}),
        // Rotating this on an enrolled node would desynchronise it from the gateway's shared secret.
        gatewaySecret: isEnrolledNode ? enrolledConfig.gatewaySecret : gatewaySecret,
        // The live signing secret (see above) — what the next boot will sign and verify with.
        jwtSecret,
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
                    issueLocalClusterIdentity(newConfig);
                    console.log('✅ mTLS certificates generated for the local services (localhost, 127.0.0.1).');
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

            // Auto-login: issue the admin's session cookie so the wizard lands straight in /admin — but
            // only where that session could be used and may be minted. The site exists now, so the
            // request is classified exactly as the host gate will classify the next one: on an address
            // the gate is about to refuse, a cookie is useless (every API call answers 421); on one the
            // sign-in rule refuses (plain http to an https site, an IP not enabled for sign-in), the
            // Set-Cookie would carry the administrator's token in clear. Either way the response says so
            // and the administrator signs in at `siteUrl`.
            let autoLoggedIn = false;
            let autoLoginSkipped: string | null = null;
            const where = classifyInstallRequest(req);
            if (where === 'unknown') {
                autoLoginSkipped = 'address-not-accepted';
            } else {
                // What the gate would have attached had the site existed when this request arrived, so
                // the cookie's Secure attribute and the sign-in rule judge THIS address, not a default.
                if (where) Object.assign(req, { siteHost: where });
                if (signInRefusal(req)) autoLoginSkipped = 'sign-in-refused';
            }
            try {
                const createdAdmin = autoLoginSkipped
                    ? null
                    : (await User.findByLogin(adminUser) || await User.findByEmail(adminEmailDisplay));
                if (createdAdmin) {
                    // THE ONE DOOR (middleware/auth.ts:issueSessionCookie) — not a hand-rolled res.cookie.
                    // The rule "a headless request may never cause a session cookie to be emitted" is only
                    // structural if every cookie-issuing site goes through the one function that enforces
                    // it; a second, hand-written copy of the sink turns the rule back into a convention.
                    // This particular call is a no-op today (the setup router carries no `authenticate`,
                    // so req.apiToken never exists here), which is precisely why it was easy to miss — the
                    // hygiene test in auth-headless-session.test.ts now fails if a third copy appears.
                    const { generateToken, issueSessionCookie } = require('../middleware/auth');
                    // With the request, so a session minted on an alias is bound to it like any other.
                    const token = generateToken(createdAdmin, req);
                    // Returns true when it REFUSED and already sent the response — the caller must return.
                    // The options are the session cookie's own (sessionCookieOptions), so the install
                    // session follows the same Secure rule as every later sign-in at this address.
                    if (issueSessionCookie(req, res, token, sessionCookieOptions(req))) return;
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

            // The site exists now. A backend that booted uninstalled never ran the boot reconcile (it is
            // gated on isInstalled()), so run it in THIS process: it releases the gateway sync waiting on
            // whenReconciled(), arms the gateway's host edge (split / separate) and starts the CLI watcher.
            // Not awaited and never fatal — the install already succeeded.
            require('../core/site-address').ensureStarted().catch((e: any) => console.warn('[site-address] post-install start failed:', e && e.message));

            res.json({
                success: true,
                autoLoggedIn,
                ...(autoLoginSkipped ? { autoLoginSkipped } : {}),
                redirectTo: autoLoggedIn ? '/admin' : '/login?installed=true',
                siteUrl,
                acceptedAddress: currentAddress && 'alias' in currentAddress ? currentAddress.alias.url : null,
                ...(currentAddress && 'skipped' in currentAddress ? { acceptedAddressSkipped: currentAddress.skipped } : {}),
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
 *     summary: Removed — change the site address in Settings or with the CLI
 *     description: >-
 *       This used to repoint the site at whatever host the request arrived on, authenticated by raw
 *       administrator credentials in the body. It is gone: the site's address is never taken from a
 *       request again. Every method answers 410 rest_migrate_removed and nothing is read or written —
 *       no credential is evaluated, so it is no longer a password oracle either. Change the address in
 *       Settings → Site address, or on the server with `npm run site`. It is still NOT CSRF-exempt, and
 *       still behind the strict per-IP auth limiter, for one release.
 *     tags: [Setup]
 *     security: []
 *     responses:
 *       403:
 *         description: The same-origin CSRF check refused the request (it runs before the route).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       410:
 *         description: rest_migrate_removed — always; nothing was changed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       421:
 *         description: rest_host_not_allowed — this address is not one the site answers.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/RestError'
 *       429:
 *         description: The strict per-IP auth limiter (10 per hour) this path is still mounted behind.
 */
// Every method, so an old client (or an old /migration page still cached somewhere) gets the one
// honest answer instead of a 404 that reads as "try another URL".
router.all('/migrate', (_req: Request, res: Response) => {
    res.status(410).json({
        code: 'rest_migrate_removed',
        message: 'Change the site address in Settings → Site address or with `npm run site`.',
        data: { status: 410 },
    });
});

module.exports = router;
// Decision helpers, exported for the install-state tests (the router itself stays the default). A full
// install cannot run in a unit suite, so the address it records, the alias it may add, the suggestion it
// offers and how it classifies its own request are asserted through these — the very functions the
// handler calls, not re-implementations.
module.exports.isEnrolledConfig = isEnrolledConfig;
module.exports.installSiteAddress = installSiteAddress;
module.exports.installTimeAlias = installTimeAlias;
module.exports.classifyInstallRequest = classifyInstallRequest;
module.exports.suggestedSiteUrl = suggestedSiteUrl;
module.exports.issueLocalClusterIdentity = issueLocalClusterIdentity;
