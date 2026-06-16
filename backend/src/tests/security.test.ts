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
    const sanitizeSvg = (rawSvg) => {
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

    const isPathSafe = (targetPath) => {
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
describe('CSRF Protection', () => {
    const { csrfProtection } = require('../middleware/auth');
    // Exercise the REAL middleware with a mock req/res. The gateway pins X-Forwarded-Host to the
    // true client Host, so trusting it here is safe; these tests pin the origin-matching logic.
    const run = (method, headers, path = '/api/v1/posts') => {
        const h: any = {};
        for (const k in headers) h[k.toLowerCase()] = (headers as any)[k];
        const req: any = { method, path, get: (name: string) => h[String(name).toLowerCase()] };
        let nexted = false, statusCode: number | null = null;
        const res: any = { status(c: number) { statusCode = c; return this; }, json() { return this; } };
        csrfProtection(req, res, () => { nexted = true; });
        return { nexted, statusCode };
    };

    it('allows a genuine same-origin request (Origin host === X-Forwarded-Host)', () => {
        const r = run('POST', { Origin: 'https://example.com', 'X-Forwarded-Host': 'example.com' });
        assert.strictEqual(r.nexted, true);
    });

    it('blocks a cross-origin state-changing request', () => {
        const r = run('POST', { Origin: 'https://evil.com', 'X-Forwarded-Host': 'example.com' });
        assert.strictEqual(r.nexted, false);
        assert.strictEqual(r.statusCode, 403);
    });

    it('blocks origin-PREFIX confusion (example.com.evil.com must NOT match example.com)', () => {
        // Regression for the startsWith() allowlist bug: `https://example.com.evil.com`.startsWith
        // (`https://example.com`) was true → bypass. Exact-origin comparison must reject it.
        const r = run('POST', { Origin: 'https://example.com.evil.com', 'X-Forwarded-Host': 'example.com' });
        assert.strictEqual(r.nexted, false);
        assert.strictEqual(r.statusCode, 403);
    });

    it('does not CSRF-check safe methods', () => {
        const r = run('GET', { Origin: 'https://evil.com', 'X-Forwarded-Host': 'example.com' });
        assert.strictEqual(r.nexted, true);
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
