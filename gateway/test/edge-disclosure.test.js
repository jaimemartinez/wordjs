/**
 * WordJS Gateway — what the edge writes down and what it tells a client.
 *
 *  1. ACCESS LOG. Reset, verification and invitation links carry their token in the query string, and
 *     the page such a link opens sends that URL as Referer on every asset. morgan's `combined` format
 *     logged both. src/access-log.js keeps the line shape but redacts every query VALUE and drops the
 *     Referer. Driven through real morgan + express, and src/index.js is checked to mount that format.
 *  2. 502 BODIES. A proxy failure answered with the upstream address and the raw error text. The log
 *     keeps them; the body is generic.
 *  3. WEBSOCKET UPGRADES skip the Express chain, so the public limiter never saw them. They have their
 *     own per-client cap (createUpgradeLimiter) and src/index.js consults it before proxying.
 *  4. gateway-config.json (gatewaySecret, revalidateSecret) is written owner-only everywhere.
 *
 * MUTATION PROOF: switch index.js back to morgan('combined'), put `target` / `err.message` back into a
 * 502 body, drop the upgradeLimiter.allow() check, or write gateway-config.json with a bare
 * writeFileSync — the matching test below fails. Make redactUrl return its input and the morgan test
 * fails on the token.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const morgan = require('morgan');

const { accessLogFormat, redactUrl } = require('../src/access-log');
const { createUpgradeLimiter } = require('../src/rate-limit');

const INDEX_SRC = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

test('redactUrl keeps the path and parameter names, never a value', () => {
    assert.strictEqual(redactUrl('/reset-password?token=abc123&email=a%40b.c'), '/reset-password?token=[redacted]&email=[redacted]');
    assert.strictEqual(redactUrl('/plain/path'), '/plain/path');
    assert.strictEqual(redactUrl('/x?'), '/x');
    assert.strictEqual(redactUrl('/x?flag'), '/x?flag=[redacted]');
    assert.strictEqual(redactUrl('/x?a=1&&b=2'), '/x?a=[redacted]&&b=[redacted]');
});

test('the access line carries no query value and no Referer', async (t) => {
    const lines = [];
    const app = express();
    app.use(morgan(accessLogFormat, { stream: { write: (m) => lines.push(m.trim()) } }));
    app.get('*', (req, res) => res.send('ok'));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const { port } = server.address();

    await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'GET',
            path: '/verify-email?token=SECRET-TOKEN-1&uid=7',
            headers: { Referer: 'https://site.example/reset?token=SECRET-TOKEN-2', 'User-Agent': 'edge-test/1' },
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end();
    });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(lines.length, 1, 'one access line per request');
    const line = lines[0];
    assert.ok(!line.includes('SECRET-TOKEN'), `no token may reach the log: ${line}`);
    assert.ok(line.includes('"GET /verify-email?token=[redacted]&uid=[redacted] HTTP/1.1" 200'), line);
    assert.ok(line.includes('"-" "edge-test/1"'), 'Referer logged as "-", user agent kept');
});

test('src/index.js mounts the redacting format, not combined', () => {
    assert.ok(/morgan\(accessLogFormat\b/.test(INDEX_SRC), 'morgan must use accessLogFormat');
    assert.ok(!/morgan\(\s*['"](combined|common)['"]/.test(INDEX_SRC), 'no stock format that logs full URLs');
});

test('502 bodies do not carry the upstream address or the raw error text', () => {
    const bodies = INDEX_SRC.split(/\r?\n/).filter((l) => /(status\(502\)|writeHead\(502)/.test(l) || /JSON\.stringify\(\{\s*error:\s*'Proxy Error'/.test(l));
    assert.ok(bodies.length >= 3, 'the 502 sites are still where this test looks');
    for (const l of bodies) {
        assert.ok(!/\btarget\b\s*[,}]/.test(l), `502 body must not name the target: ${l.trim()}`);
        assert.ok(!/message:\s*err\.message/.test(l), `502 body must not relay err.message: ${l.trim()}`);
    }
});

test('upgrade limiter: caps one client per window, others unaffected, window resets', () => {
    const lim = createUpgradeLimiter({ rateLimit: { upgradeMax: 3, upgradeWindowMs: 50 } });
    assert.deepStrictEqual([1, 2, 3, 4].map(() => lim.allow('10.0.0.1')), [true, true, true, false]);
    assert.strictEqual(lim.allow('10.0.0.2'), true, 'a different client has its own budget');
    const until = Date.now() + 60;
    while (Date.now() < until) { /* wait out the window */ }
    assert.strictEqual(lim.allow('10.0.0.1'), true, 'a new window resets the count');
});

test('upgrade limiter defaults are generous but finite', () => {
    const lim = createUpgradeLimiter({});
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (lim.allow('1.2.3.4')) allowed++;
    assert.strictEqual(allowed, 120);
});

test('src/index.js consults the upgrade limiter before proxying a WebSocket', () => {
    const start = INDEX_SRC.indexOf("server.on('upgrade'");
    assert.ok(start > 0);
    const handler = INDEX_SRC.slice(start, INDEX_SRC.indexOf('proxy.ws(', start));
    assert.ok(/upgradeLimiter\.allow\(/.test(handler), 'the upgrade handler must check the limiter before proxy.ws');
    assert.ok(/429 Too Many Requests/.test(handler));
});

test('every gateway-config.json write goes through the owner-only writer', () => {
    assert.ok(/function writeGatewayConfig[\s\S]{0,200}mode: 0o600[\s\S]{0,120}chmodSync\(configPath, 0o600\)/.test(INDEX_SRC));
    const bare = INDEX_SRC.split(/\r?\n/).filter((l) => /writeFileSync\(/.test(l) && /config(Path)?\b|gateway-config\.json/.test(l) && !/mode: 0o600/.test(l));
    assert.deepStrictEqual(bare.map((l) => l.trim()), [], 'no bare writeFileSync of the gateway config');
});

// /config-update persists siteUrl and port into gateway-config.json (read back at every boot), so
// only a well-formed origin and a real port may reach that file. The helpers live in src/index.js,
// which is not a module; they are evaluated from its source so the test runs the shipped code.
function loadConfigUpdateValidators() {
    const pick = (name) => {
        const m = INDEX_SRC.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}`));
        assert.ok(m, `${name} is defined in src/index.js`);
        return m[0];
    };
    // eslint-disable-next-line no-new-func
    return new Function(`${pick('siteOriginOrNull')}\n${pick('isValidSiteOrigin')}\n${pick('portOrNull')}\nreturn { siteOriginOrNull, isValidSiteOrigin, portOrNull };`)();
}

test('/config-update accepts only an http(s) origin and a real port', () => {
    const { siteOriginOrNull, isValidSiteOrigin, portOrNull } = loadConfigUpdateValidators();
    assert.strictEqual(siteOriginOrNull('https://example.com'), 'https://example.com');
    assert.strictEqual(siteOriginOrNull('https://example.com/'), 'https://example.com');
    assert.strictEqual(siteOriginOrNull('http://example.com:8080'), 'http://example.com:8080');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com', 'https://example.com/path',
        'https://example.com/?q=1', 'https://example.com/#x', 'not a url', 42, null, `https://${'a'.repeat(3000)}.com`]) {
        assert.strictEqual(siteOriginOrNull(bad), null, `refused: ${String(bad).slice(0, 40)}`);
    }
    assert.ok(isValidSiteOrigin('https://example.com'));
    assert.ok(!isValidSiteOrigin('https://example.com/'), 'only the canonical spelling is persisted');
    assert.strictEqual(portOrNull('443'), 443);
    assert.strictEqual(portOrNull(8080), 8080);
    for (const bad of ['0', '65536', '-1', '80abc', '1e3', 1.5, '']) assert.strictEqual(portOrNull(bad), null, `refused port ${bad}`);
});

test('/config-update validates before it persists', () => {
    const start = INDEX_SRC.indexOf("internalApp.post('/config-update'");
    const handler = INDEX_SRC.slice(start, INDEX_SRC.indexOf('writeGatewayConfig(', start));
    assert.ok(/siteOriginOrNull\(siteUrl\)/.test(handler) && /status\(400\)/.test(handler));
    assert.ok(!/config\.siteUrl = siteUrl/.test(handler), 'the raw request value is never stored');
    assert.ok(!/parseInt\(port/.test(handler), 'the raw port is never stored');
});
