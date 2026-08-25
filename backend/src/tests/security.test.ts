/**
 * WordJS - Security Tests
 * Unit tests for security features
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ============================================================================
// AUTH MIDDLEWARE TESTS
// ============================================================================
describe('Auth Middleware', () => {
    const jwt = require('jsonwebtoken');

    // Mock config
    const mockConfig = { jwt: { secret: 'test-secret-key-12345' } };

    // Helper to create mock request
    const createMockReq = (options: any = {}) => ({
        headers: options.headers || {},
        cookies: options.cookies || {},
    });

    it('should extract token from Authorization header', () => {
        const token = jwt.sign({ userId: 1 }, mockConfig.jwt.secret);
        const req = createMockReq({
            headers: { authorization: `Bearer ${token}` }
        });

        let extractedToken = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            extractedToken = authHeader.substring(7);
        }

        assert.strictEqual(extractedToken, token);
    });

    it('should extract token from HttpOnly cookie', () => {
        const token = jwt.sign({ userId: 1 }, mockConfig.jwt.secret);
        const req = createMockReq({
            cookies: { wordjs_token: token }
        });

        let extractedToken = null;
        if (req.cookies && req.cookies.wordjs_token) {
            extractedToken = req.cookies.wordjs_token;
        }

        assert.strictEqual(extractedToken, token);
    });

    it('should prefer header over cookie when both present', () => {
        const headerToken = jwt.sign({ userId: 1, source: 'header' }, mockConfig.jwt.secret);
        const cookieToken = jwt.sign({ userId: 2, source: 'cookie' }, mockConfig.jwt.secret);

        const req = createMockReq({
            headers: { authorization: `Bearer ${headerToken}` },
            cookies: { wordjs_token: cookieToken }
        });

        let extractedToken = null;
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            extractedToken = authHeader.substring(7);
        }
        if (!extractedToken && req.cookies && req.cookies.wordjs_token) {
            extractedToken = req.cookies.wordjs_token;
        }

        const decoded = jwt.verify(extractedToken, mockConfig.jwt.secret);
        assert.strictEqual(decoded.source, 'header');
    });

    it('should reject invalid JWT tokens', () => {
        const invalidToken = 'not.a.valid.jwt.token';

        assert.throws(() => {
            jwt.verify(invalidToken, mockConfig.jwt.secret);
        }, /jwt malformed/);
    });

    it('should reject expired JWT tokens', () => {
        const expiredToken = jwt.sign(
            { userId: 1 },
            mockConfig.jwt.secret,
            { expiresIn: '-1s' }
        );

        assert.throws(() => {
            jwt.verify(expiredToken, mockConfig.jwt.secret);
        }, /jwt expired/);
    });
});

// ============================================================================
// SVG SANITIZATION TESTS
// ============================================================================
describe('SVG Sanitization', () => {
    // Custom regex-based sanitizer (simpler, no dependencies)
    const sanitizeSvg = (rawSvg: string) => {
        return rawSvg
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, 'data-blocked=');
    };

    it('should remove <script> tags from SVG', () => {
        const maliciousSvg = `<svg><script>alert('XSS')</script><circle cx="50" cy="50" r="40"/></svg>`;
        const cleaned = sanitizeSvg(maliciousSvg);

        assert.ok(!cleaned.includes('<script>'), 'Script tag should be removed');
        assert.ok(cleaned.includes('<circle'), 'Valid SVG elements should remain');
    });

    it('should remove javascript: URLs', () => {
        const maliciousSvg = `<svg><a xlink:href="javascript:alert('XSS')"><text>Click</text></a></svg>`;
        const cleaned = sanitizeSvg(maliciousSvg);

        assert.ok(!cleaned.includes('javascript:'), 'javascript: URLs should be removed');
    });

    it('should block event handlers like onclick', () => {
        const maliciousSvg = `<svg><rect onclick="alert('XSS')" width="100" height="100"/></svg>`;
        const cleaned = sanitizeSvg(maliciousSvg);

        assert.ok(!cleaned.includes('onclick='), 'onclick should be blocked');
        assert.ok(cleaned.includes('data-blocked='), 'Should replace with safe attribute');
    });

    it('should preserve valid SVG content', () => {
        const validSvg = `<svg viewBox="0 0 100 100"><rect fill="blue"/><circle fill="red"/></svg>`;
        const cleaned = sanitizeSvg(validSvg);

        assert.ok(cleaned.includes('<rect'), 'rect should be preserved');
        assert.ok(cleaned.includes('<circle'), 'circle should be preserved');
    });

    // Regression for H5: the real upload sanitizer (sanitize-html) must use an ALLOWLIST so that
    // event-handler ATTRIBUTES (onerror/onload) are dropped — the old allowedAttributes:false +
    // tag-name filter let them survive. This exercises the same allowlist approach media.ts uses.
    it('real sanitize-html allowlist strips on* attributes AND <script> (H5)', () => {
        const sh = require('sanitize-html');
        const out = sh(
            `<svg onload="alert(1)"><rect onerror="x()" width="10" height="10"/><script>alert(2)</script><circle cx="5" cy="5" r="4"/></svg>`,
            {
                allowedTags: ['svg', 'g', 'path', 'rect', 'circle', 'image'],
                allowedAttributes: { '*': ['id', 'class', 'fill', 'width', 'height', 'viewBox', 'd', 'cx', 'cy', 'r', 'xlink:href', 'href'] },
                allowedSchemes: ['http', 'https', 'mailto'],
                allowedSchemesByTag: { image: ['http', 'https', 'data'] },
                parser: { lowerCaseAttributeNames: false }
            }
        );
        assert.ok(!/onload/i.test(out), 'onload attribute must be stripped');
        assert.ok(!/onerror/i.test(out), 'onerror attribute must be stripped');
        assert.ok(!/<script/i.test(out), '<script> must be stripped');
        assert.ok(/<circle/i.test(out), 'valid <circle> must be preserved');
    });
});

// ============================================================================
// IO GUARD TESTS
// ============================================================================
describe('IO Guard - Path Safety', () => {
    const BLOCKED_FILES = [
        '.env', '.env.local', '.env.production', '.env.development',
        'wordjs-config.json', 'wordjs-config.backup.json',
        'id_rsa', 'id_ed25519', '.htpasswd', 'shadow', 'passwd'
    ];

    const BLOCKED_EXTENSIONS = ['.pem', '.key', '.crt', '.p12', '.pfx'];

    const isPathSafe = (targetPath: string) => {
        const resolved = path.resolve(targetPath);
        const filename = path.basename(resolved).toLowerCase();
        const ext = path.extname(filename).toLowerCase();

        if (BLOCKED_FILES.includes(filename)) return false;
        if (BLOCKED_EXTENSIONS.includes(ext)) return false;
        return true;
    };

    it('should block access to .env files', () => {
        assert.strictEqual(isPathSafe('/app/.env'), false);
        assert.strictEqual(isPathSafe('/app/.env.local'), false);
        assert.strictEqual(isPathSafe('/app/.env.production'), false);
    });

    it('should block access to config files', () => {
        assert.strictEqual(isPathSafe('/app/wordjs-config.json'), false);
    });

    it('should block access to private keys', () => {
        assert.strictEqual(isPathSafe('/home/user/.ssh/id_rsa'), false);
        assert.strictEqual(isPathSafe('/app/certs/server.key'), false);
        assert.strictEqual(isPathSafe('/app/certs/private.pem'), false);
    });

    it('should block access to system password files', () => {
        assert.strictEqual(isPathSafe('/etc/shadow'), false);
        assert.strictEqual(isPathSafe('/etc/passwd'), false);
    });

    it('should allow access to normal files', () => {
        assert.strictEqual(isPathSafe('/app/uploads/image.jpg'), true);
        assert.strictEqual(isPathSafe('/app/data/posts.json'), true);
        assert.strictEqual(isPathSafe('/app/themes/default/style.css'), true);
    });
});

// ============================================================================
// CSRF PROTECTION TESTS
// ============================================================================
// FIXTURE-VS-PRODUCER. This suite used to hand-build `{ method, path, get }` with path='/api/v1/posts'
// and call csrfProtection directly. Express NEVER delivers that shape here: index.ts mounts the
// middleware WITH the api prefix (`app.use(config.api.prefix, csrfProtection)`) and Express strips the
// mount path from req.url before the handler runs, so the real req.path inside is '/posts'. The
// fabricated shape is exactly what hid the dead `req.path.startsWith('/api/v1/setup')` exemption for as
// long as it existed: under the fixture it looked reachable, in production it could never be true.
//
// So: mount the REAL middleware at the REAL prefix and drive it with supertest. The first test pins the
// producer's shape itself, so a future refactor that reintroduces a full-path comparison fails loudly.
describe('CSRF Protection (real middleware, mounted at the api prefix)', () => {
    const express = require('express');
    const request = require('supertest');
    const { csrfProtection } = require('../middleware/auth');
    const config = require('../config/app');
    const PREFIX = config.api.prefix;

    const app = express();
    app.use(PREFIX, csrfProtection);
    // Terminal handler: reached only when csrfProtection called next(). Echoes what Express actually
    // handed the middleware layer, so the assertions below can be about the real request shape.
    app.use(PREFIX, (req: any, res: any) => res.json({ nexted: true, path: req.path, originalUrl: req.originalUrl }));

    const post = (url: string, headers: Record<string, string> = {}) => {
        let r = request(app).post(url);
        for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
        return r;
    };
    const SAME_ORIGIN = { Origin: 'https://example.com', 'X-Forwarded-Host': 'example.com' };

    it('Express hands the mounted middleware a TRIMMED path (the producer shape the old fixture faked)', async () => {
        const res = await post(`${PREFIX}/posts`, SAME_ORIGIN);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.path, '/posts', 'req.path is trimmed of the mount prefix');
        assert.strictEqual(res.body.originalUrl, `${PREFIX}/posts`, 'only originalUrl carries the prefix');
    });

    it('allows a genuine same-origin request (Origin host === X-Forwarded-Host)', async () => {
        const res = await post(`${PREFIX}/posts`, SAME_ORIGIN);
        assert.strictEqual(res.body.nexted, true);
    });

    it('blocks a cross-origin state-changing request', async () => {
        const res = await post(`${PREFIX}/posts`, { Origin: 'https://evil.com', 'X-Forwarded-Host': 'example.com' });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.code, 'rest_csrf_invalid');
    });

    it('blocks origin-PREFIX confusion (example.com.evil.com must NOT match example.com)', async () => {
        // Regression for the startsWith() allowlist bug: `https://example.com.evil.com`.startsWith
        // (`https://example.com`) was true → bypass. Exact-origin comparison must reject it.
        const res = await post(`${PREFIX}/posts`, { Origin: 'https://example.com.evil.com', 'X-Forwarded-Host': 'example.com' });
        assert.strictEqual(res.status, 403);
    });

    it('does not CSRF-check safe methods', async () => {
        const res = await request(app).get(`${PREFIX}/posts`)
            .set('Origin', 'https://evil.com').set('X-Forwarded-Host', 'example.com');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.nexted, true);
    });

    it('blocks a header-less cookie request (no Origin, no Referer, no Bearer)', async () => {
        const res = await post(`${PREFIX}/posts`);
        assert.strictEqual(res.status, 403);
    });

    // The exemption the fixture hid: an installer POSTing to the wizard's endpoints on a site with no
    // users yet has no configured origin to send, and the docs promise those are CSRF-exempt.
    it('EXEMPTS the PRE-INSTALL setup endpoints from CSRF (was dead code under the mounted prefix)', async () => {
        for (const url of [`${PREFIX}/setup/install`, `${PREFIX}/setup/test-db`]) {
            const res = await post(url);
            assert.strictEqual(res.status, 200, `${url} must be CSRF-exempt, got ${res.status}`);
            assert.strictEqual(res.body.nexted, true);
        }
    });

    it('does NOT exempt the rest of the /setup subtree — /migrate outlives the install', async () => {
        // POST /setup/migrate is the one route of that subtree still alive AFTER installation, and it
        // authenticates raw admin credentials from the body. A subtree exemption made its password oracle
        // drivable from any visitor's browser — i.e. from the victim's IP, around the attacker's own
        // per-IP limiter. The exemption is ENUMERATED, so only what actually predates the site gets it.
        for (const url of [`${PREFIX}/setup/migrate`, `${PREFIX}/setup`]) {
            const res = await post(url);
            assert.strictEqual(res.status, 403, `${url} must NOT be CSRF-exempt, got ${res.status}`);
            assert.strictEqual(res.body.code, 'rest_csrf_invalid');
        }
    });

    it('the setup exemption matches the SEGMENT, not a string prefix', async () => {
        // '/setupsomething' must not inherit the exemption just because it starts with the same letters.
        const res = await post(`${PREFIX}/setupsomething`);
        assert.strictEqual(res.status, 403);
    });

    // ---------------------------------------------------------------------------------------------
    // ABSENT Host header. `req.get('Host')` is `string | undefined`; while the boundary was `any` that
    // undefined flowed unchecked into the allow-list as `http://${host}` — i.e. the LITERAL origins
    // 'http://undefined' and 'https://undefined' became same-origin to this site. Anyone able to serve
    // a page from the (perfectly legal) host label `undefined` — an intranet name, a DNS search suffix,
    // a hosts entry — could then drive cookie-authenticated state changes.
    //
    // Reachability is NOT theoretical, and supertest cannot show it because http.request always writes a
    // Host. Measured on this Node (v25): HTTP/1.1 without Host is rejected by the parser with 400, but
    // HTTP/1.0 imposes no Host requirement and Node hands the request to Express with
    // `req.headers.host === undefined`. So these two tests drive the real mounted middleware over a raw
    // socket: the control proves the host-less request genuinely REACHES the middleware (otherwise the
    // exploit test would "pass" on a parser-level 400 and assert nothing), the exploit test pins that an
    // absent Host produces no allow-list entry at all — fail closed.
    const net = require('node:net');
    const CRLF = '\r\n';

    const rawRequest = (port: number, requestLine: string, headers: string[]) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write(requestLine + CRLF + headers.concat(['Content-Length: 0', '', '']).join(CRLF));
            });
            let raw = '';
            socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('raw socket timeout')); });
            socket.on('data', (d: Buffer) => { raw += d.toString(); });
            socket.on('error', reject);
            socket.on('close', () => resolve({
                status: Number((raw.split(CRLF)[0] || '').split(' ')[1]),
                body: raw.split(CRLF + CRLF).slice(1).join(CRLF + CRLF)
            }));
        });

    // HTTP/1.0 keeps no connection alive, so the socket closes on its own after each response.
    const withServer = async (fn: (port: number) => Promise<void>) => {
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        try { await fn(server.address().port); }
        finally { await new Promise((r) => server.close(r)); }
    };

    it('CONTROL: a host-less HTTP/1.0 request really does reach the mounted middleware', async () => {
        await withServer(async (port) => {
            // Safe method: csrfProtection nexts immediately, so a 200 here means Node delivered a request
            // with NO Host header rather than rejecting it at the parser (as it does for HTTP/1.1).
            const res = await rawRequest(port, `GET ${PREFIX}/posts HTTP/1.0`, []);
            assert.strictEqual(res.status, 200, 'host-less HTTP/1.0 must be delivered, not 400ed');
            assert.match(res.body, /"nexted":true/);
        });
    });

    it('an ABSENT Host must not make http(s)://undefined a same-origin allow-list entry', async () => {
        await withServer(async (port) => {
            const res = await rawRequest(port, `POST ${PREFIX}/posts HTTP/1.0`, ['Origin: http://undefined']);
            assert.strictEqual(res.status, 403, 'literal origin http://undefined must never be same-origin');
            assert.match(res.body, /rest_csrf_invalid/);
        });
    });

    it('an ABSENT Host must not allow https://undefined either', async () => {
        await withServer(async (port) => {
            const res = await rawRequest(port, `POST ${PREFIX}/posts HTTP/1.0`, ['Origin: https://undefined']);
            assert.strictEqual(res.status, 403, 'literal origin https://undefined must never be same-origin');
        });
    });
});

describe('JWT revocation (token_valid_after)', () => {
    const { after } = require('node:test');
    const jwt = require('jsonwebtoken');
    const config = require('../config/app');
    const User = require('../models/User');
    const { authenticate } = require('../middleware/auth');
    const origFindById = User.findById;
    after(() => { User.findById = origFindById; });

    // Drive the real `authenticate` with a mocked User.findById (no DB needed).
    const callAuth = (token: string, user: any) => new Promise<any>((resolve) => {
        User.findById = async () => user;
        const req: any = { headers: { authorization: 'Bearer ' + token }, cookies: {} };
        const res: any = { status(c: number) { (this as any)._c = c; return this; }, json(b: any) { resolve({ code: (this as any)._c, body: b }); return this; } };
        authenticate(req, res, () => resolve({ code: 200, nexted: true }));
    });

    it('rejects a token issued before token_valid_after', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = jwt.sign({ userId: 1, iat: now - 100 }, config.jwt.secret, { algorithm: 'HS256' });
        const r = await callAuth(token, { id: 1, meta: { token_valid_after: String(now) } });
        assert.strictEqual(r.code, 401);
        assert.strictEqual(r.body.code, 'rest_token_revoked');
    });

    it('accepts a token issued after token_valid_after', async () => {
        const now = Math.floor(Date.now() / 1000);
        const token = jwt.sign({ userId: 1, iat: now }, config.jwt.secret, { algorithm: 'HS256' });
        const r = await callAuth(token, { id: 1, meta: { token_valid_after: String(now - 100) } });
        assert.strictEqual(r.nexted, true);
    });

    it('accepts a token when the user has no revocation epoch set', async () => {
        const token = jwt.sign({ userId: 1 }, config.jwt.secret, { algorithm: 'HS256' });
        const r = await callAuth(token, { id: 1, meta: {} });
        assert.strictEqual(r.nexted, true);
    });
});

console.log('Running WordJS Security Tests...');
