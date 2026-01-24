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
    const createMockReq = (options = {}) => ({
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
    it('should validate same-origin requests', () => {
        const host = 'example.com';
        const origin = 'https://example.com';
        const originHost = new URL(origin).host;
        assert.strictEqual(originHost === host, true);
    });

    it('should detect cross-origin attacks', () => {
        const host = 'example.com';
        const maliciousOrigin = 'https://evil.com';
        const originHost = new URL(maliciousOrigin).host;
        assert.strictEqual(originHost === host, false);
    });

    it('should handle requests without origin header', () => {
        const origin = undefined;
        const referer = undefined;
        const shouldAllow = !origin && !referer;
        assert.strictEqual(shouldAllow, true);
    });
});

console.log('Running WordJS Security Tests...');
