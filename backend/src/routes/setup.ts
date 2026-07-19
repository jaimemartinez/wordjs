import type { Request, Response, NextFunction } from 'express';
const express = require('express');
const router = express.Router();
const { getConfig, saveConfig, isInstalled } = require('../core/configManager');
const config = require('../config/app');
const path = require('path');
const { verifyInstallToken } = require('../core/install-token');

// Gate for the PRE-INSTALL endpoints (/install, /test-db). These run before the instance is
// configured, so they are unauthenticated and exempt from CSRF — require the one-time install token
// (printed to the server console at boot) to stop a pre-install takeover. Constant-time compared in
// verifyInstallToken(). Accepts the token via the `x-install-token` header or an `installToken` body
// field so the installer UX stays simple (operator copies it from the logs).
function requireInstallToken(req: any, res: any): boolean {
    const provided = req.get('x-install-token') || (req.body && req.body.installToken);
    if (!verifyInstallToken(provided)) {
        res.status(403).json({ error: 'Invalid or missing install token. Check the server console for the install token.' });
        return false;
    }
    return true;
}

// Check installation status
router.get('/status', (req: any, res: Response) => {
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
router.post('/test-db', async (req: any, res: Response) => {
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

// Install endpoint
router.post('/install', async (req: any, res: Response) => {
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
    const HOST_PATTERN = /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?$/;

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
        const rawHost = req.get('host') || '';
        if (!HOST_PATTERN.test(rawHost)) {
            return fail('Could not determine a valid install host. Pass an explicit siteUrl in the installer.');
        }
        host = rawHost;
    }
    const siteUrl = `${protocol}://${host}`;

    // Frontend URL could be inferred or passed. 
    // Ideally frontend sends its own URL.
    // For now we assume typical port + 1 or passed in body?
    // Let's assume passed or same host different port.
    // For zero-config on same domain, it might be same protocol/host/port if serving static?
    // But we are running separate servers.
    // Let's rely on the user/frontend telling us, or default logic.
    const frontendUrl = req.body.frontendUrl || siteUrl.replace(':3000', ':3001');

    // Save config
    const crypto = require('crypto');
    const fs = require('fs');
    const path = require('path');

    // SECURITY: Auto-generate cryptographically secure secrets
    const jwtSecret = crypto.randomBytes(64).toString('hex');
    const gatewaySecret = crypto.randomBytes(32).toString('hex');

    // newConfig is mutated below (mtls paths, host identities), so type it loosely.
    const newConfig: Record<string, any> = {
        siteUrl,
        frontendUrl,
        port: 4000,
        frontendPort: 3001,
        gatewayPort: 3000,
        gatewayInternalPort: 3100,
        // Host for the backend server listen binding (usually localhost or 0.0.0.0)
        host: 'localhost',
        // Public Gateway URL (FQDN/IP) captured from the request (Forwarded or Host)
        gatewayUrl: `${protocol}://${host}`, // Store full URL just in case
        gatewayHost: host.split(':')[0], // Store hostname for reference
        gatewaySecret: gatewaySecret,
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
            await updateOption('blogname', siteName);
            await updateOption('blogdescription', siteDescription);
            await updateOption('siteurl', siteUrl);
            await updateOption('home', frontendUrl);

            // SECURITY: Generate mTLS Certificates
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
                res.status(500).json({ error: 'Setup failed during mTLS generation: ' + e.message });
                return; // Exit if mTLS generation fails
            }

            // SECURITY: Delegate cluster orchestration to the autonomous Setup service.
            // The monolith is a SINGLE process — there is no separate gateway/frontend to distribute
            // certs/config to — so this cluster step is a no-op there. Skip it (this also avoids
            // needing the root setup/ package, which the compiled monolith release doesn't ship deps for).
            if (process.env.WORDJS_EMBEDDED === '1') {
                console.log('ℹ️ Monolith (embedded) — skipping cluster artifact distribution (single process, not needed).');
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

            const Term = require('../models/Term');
            await Term.create({ name: 'Uncategorized', taxonomy: 'category', slug: 'uncategorized', description: 'Default category' });

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
                    const { generateToken } = require('../middleware/auth');
                    const token = generateToken(createdAdmin);
                    res.cookie('wordjs_token', token, {
                        httpOnly: true,
                        secure: siteUrl.startsWith('https://'),
                        sameSite: 'lax',
                        maxAge: 7 * 24 * 60 * 60 * 1000,
                        path: '/'
                    });
                    autoLoggedIn = true;
                }
            } catch (e: any) {
                console.warn('Auto-login after install failed (user can log in manually):', e && e.message);
            }

            // Install complete — remove the on-disk install-token mirror so the bootstrap secret does
            // not linger (the token is irrelevant now; the setup endpoints early-return once installed).
            try { require('../core/install-token').clearInstallTokenFile(); } catch { /* best-effort */ }

            res.json({
                success: true,
                autoLoggedIn,
                redirectTo: autoLoggedIn ? '/admin' : '/login?installed=true',
                tests: { total: testResults.tests, passed: testResults.passed, failed: testResults.failed }
            });

        } catch (e) {
            console.error('❌ Setup failed:', e);
            res.status(500).json({ error: 'Setup failed during operation: ' + e.message });
        }
    } else {
        res.status(500).json({ error: 'Failed to save configuration' });
    }
});

// Migration endpoint
router.post('/migrate', async (req: any, res: Response) => {
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
        // admin CANNOT obtain a session to bootstrap out of the mismatch. /setup/migrate is the CSRF-exempt,
        // guard-bypassed path that repairs siteUrl, so requiring an authenticated admin session here would break
        // the very flow it exists for. It therefore authenticates raw credentials, which made it a password
        // ORACLE (#26): wrong password → 401, correct NON-admin password → 403, correct admin password → 200 were
        // all DISTINGUISHABLE, giving an unthrottled brute-force oracle (per #25 we deliberately never call
        // recordLoginFail here, so account lockout never trips it).
        //
        // #26 fix WITHOUT reintroducing #25's DoS:
        //   (a) still respect an existing per-account lock set by the real /auth/login (isLoginLocked below) but
        //       NEVER recordLoginFail from this unauthenticated path (that shared-lock write was #25's DoS lever);
        //   (b) collapse the wrong-password AND correct-non-admin branches into ONE uniform 401 (identical status
        //       + body), so the ONLY distinguishable outcome is a correct ADMINISTRATOR credential — which is the
        //       legitimate migration path, not information an attacker profits from;
        //   (c) this route is additionally throttled by the strict authLimiter (10/hr/IP, mounted in index.ts on
        //       /setup/migrate), far tighter than the setupLimiter (20/15min) guarding the pre-install endpoints.
        // clearLoginFails on a SUCCESSFUL admin auth stays (it requires the correct password, so it's not an
        // unauthenticated lever).
        const auth = require('./auth');
        const lockId = await auth.resolveLockIdentifier(username);
        if (await auth.isLoginLocked(lockId)) {
            return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
        }
        const User = require('../models/User');
        let user: any = null;
        try { user = await User.authenticate(username, password); } catch { user = null; }

        // UNIFORM response for BOTH wrong password (user === null) and correct-password-non-admin (#26): same
        // status + body so neither is distinguishable from the other — only a correct administrator credential
        // proceeds past this point. NO recordLoginFail here (#25: an unauthenticated caller must not drive the
        // shared per-account lockout).
        if (!user || user.getRole() !== 'administrator') {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        await auth.clearLoginFails(lockId);

        // Fix: Trust upstream Gateway protocol
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        // Host from proxy
        const host = req.get('x-forwarded-host') || req.get('host');
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
