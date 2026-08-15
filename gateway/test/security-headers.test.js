const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');

const { helmetOptions } = require('../src/security-headers');

// The gateway CSP was DISABLED (`helmet({ contentSecurityPolicy: false })`). These lock in that a CSP is
// now emitted and that it mirrors the backend's policy shape (unsafe-inline/eval for Next/Puck, etc.).
// Mutation-provable: flip any directive in src/security-headers.js and the matching assertion fails; drop
// contentSecurityPolicy back to `false` and the "header present" assertion fails.

function getHeaders(app) {
    return new Promise((resolve, reject) => {
        const srv = http.createServer(app);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
                res.resume();
                res.on('end', () => srv.close(() => resolve(res.headers)));
            });
            req.on('error', (e) => srv.close(() => reject(e)));
            req.end();
        });
    });
}

test('gateway emits a Content-Security-Policy header (was disabled)', async () => {
    const app = express();
    app.use(helmet(helmetOptions));
    app.get('/', (req, res) => res.send('ok'));

    const headers = await getHeaders(app);
    const csp = headers['content-security-policy'];
    assert.ok(csp && csp.length > 0, 'a CSP header must be present');
});

test('gateway CSP mirrors the backend policy shape (Next/Puck-tolerant)', async () => {
    const app = express();
    app.use(helmet(helmetOptions));
    app.get('/', (req, res) => res.send('ok'));

    const headers = await getHeaders(app);
    const csp = headers['content-security-policy'];

    // The exact directives the backend sets (backend/src/index.ts). If these drift the admin/Puck breaks.
    assert.match(csp, /default-src 'self'/, 'default-src self');
    assert.match(csp, /script-src 'self' 'unsafe-inline' 'unsafe-eval'/, 'script-src allows unsafe-inline/eval for Next/Puck');
    assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/, 'style-src');
    assert.match(csp, /font-src 'self' https:\/\/fonts\.gstatic\.com data:/, 'font-src');
    assert.match(csp, /object-src 'none'/, 'object-src none');
    assert.match(csp, /upgrade-insecure-requests/, 'upgrade-insecure-requests');

    // Cross-origin resource policy so the frontend can load backend images (backend mirrors this).
    assert.strictEqual(headers['cross-origin-resource-policy'], 'cross-origin', 'CORP must be cross-origin');
});
