/**
 * Health/metrics endpoint tests against the REAL backend app (supertest), in an isolated process.
 *
 * No external service needed — runs in the integration suite simply to keep the full-app boot out of
 * the SQLite unit suite's shared process. Verifies the orchestrator contract: /healthz is always 200
 * (liveness, no DB), /readyz returns 503 until the app is installed+booted, and /metrics is 404 unless
 * a scrape token is configured.
 *
 * It also covers the OBSERVABILITY layer, and it has to be here for the same reason: request
 * correlation and the HTTP metric series are properties of the FIRST middleware on the real app and of
 * the mount order around it. A suite that builds its own express() would assert on a chain nobody
 * serves. See documentation/observability.md.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.WORDJS_EMBEDDED = '1'; // build the app without self-listening / gateway registration
// This test boots the full app but exercises NO Redis. In a Redis-enabled run the app-boot would
// create the rate-limit/cache Redis clients (enableOfflineQueue:false) whose async (re)connect races
// the test lifecycle and rejects ("Stream isn't writeable"). Force Redis off for THIS process before
// the config loads (node --test isolates each file in its own process).
delete process.env.REDIS_ENABLED;

const config = require('../config/app');
config.redis.enabled = false; // belt-and-suspenders if the config singleton was already loaded
config.dbPath = path.join(os.tmpdir(), `wordjs-health-${process.pid}.db`); // never touch the real DB
config.metrics = { token: '' }; // ensure /metrics is in its default (disabled) state for this test

describe('health & metrics endpoints', () => {
    let request: any;
    let app: any;
    before(() => {
        request = require('supertest');
        app = require('../index'); // module.exports = the configured Express app (does not listen in EMBEDDED)
    });

    it('/healthz returns 200 ok and never touches the DB', async () => {
        const res = await request(app).get('/healthz');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.ok(typeof res.body.uptime === 'number');
    });

    it('/readyz returns 503 before initialize() (not booted / not installed)', async () => {
        const res = await request(app).get('/readyz');
        assert.strictEqual(res.status, 503);
        assert.ok(['starting', 'setup_required', 'not_ready'].includes(res.body.status), `unexpected status ${res.body.status}`);
    });

    it('/metrics returns 404 when no scrape token is configured', async () => {
        const res = await request(app).get('/metrics');
        assert.strictEqual(res.status, 404);
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// OBSERVABILITY — the request id, the access line and the HTTP metric series.
//
// THE PROPERTY THESE GUARD, stated once: an operator must be able to take one line out of an
// aggregator and find every other line, and the matching latency/error sample, for that same request.
// Three things can quietly break it and none of them show up as a failing request:
//   · the correlation middleware stops being FIRST (lines emitted before it carry no id);
//   · the `route` label starts coming from the URL instead of the route pattern (cardinality explodes
//     and the scrape eventually takes the process with it);
//   · a redaction path stops matching (a header value ends up in the log store, forever).
// Each has a test below, and each drives the REAL app rather than a hand-built logger.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const SCRAPE_TOKEN = 'integration-scrape-token';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The label values of one Prometheus series line, e.g. `route="/healthz"` → { route: '/healthz' }. */
function labelsOf(line: string): Record<string, string> {
    const open = line.indexOf('{');
    const close = line.lastIndexOf('}');
    if (open === -1 || close === -1) return {};
    const out: Record<string, string> = {};
    for (const m of line.slice(open + 1, close).matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        out[m[1]] = m[2];
    }
    return out;
}

/** Every sample line of one metric family. */
function samplesOf(text: string, metric: string): string[] {
    return String(text).split('\n').filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `));
}

const { trustProxyConfigured } = require('../core/client-ip');

/**
 * Run `fn` with the instance in the "a reverse proxy is in front of us" posture, then restore.
 *
 * This process sets WORDJS_EMBEDDED=1, so its default posture is DIRECT — trust nothing — which is
 * also the default of a plain monolith install. `middleware/request-context` reads
 * `trustProxyConfigured()` per request (not once at module load) precisely so the two postures can
 * both be driven against the real app here.
 */
async function withTrustedProxy<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = config.trustProxy;
    config.trustProxy = true;
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete config.trustProxy; else config.trustProxy = previous;
    }
}

describe('observability: request correlation, access log and HTTP metrics', () => {
    let request: any;
    let app: any;
    let addLogSink: any;
    let previousToken = '';

    before(() => {
        request = require('supertest');
        app = require('../index');
        addLogSink = require('../core/logger').addLogSink;
        previousToken = config.metrics.token;
        config.metrics.token = SCRAPE_TOKEN; // the route reads config per request, so this takes effect now
    });

    after(() => {
        config.metrics.token = previousToken;
    });

    it('stamps X-Request-Id on every response', async () => {
        const res = await request(app).get('/healthz');
        assert.match(String(res.headers['x-request-id'] || ''), UUID_RE);
    });

    it('echoes an incoming X-Request-Id that matches the accepted grammar — BEHIND A TRUSTED PROXY', async () => {
        const incoming = 'edge-proxy-0123456789abcdef';
        const res = await withTrustedProxy(() => request(app).get('/healthz').set('X-Request-Id', incoming));
        assert.strictEqual(res.headers['x-request-id'], incoming);
    });

    it('REFUSES a well-formed incoming X-Request-Id when no proxy is trusted', async () => {
        // THE DEFECT THIS PINS: validating the BYTES of the header answered nothing about its
        // PROVENANCE. On a directly exposed instance (`trust proxy` unset — what WORDJS_EMBEDDED gives
        // this process) an attacker could stamp every request of a campaign with one id so it collapses
        // into a single "trace", splice lines into an incident an operator was following, or adopt an id
        // a real session was emitting so the attack was attributed to that user. The echo in the
        // response header let them confirm the graft landed. Same header, same grammar, different
        // answer — because a header is only as trustworthy as the hop that set it.
        assert.strictEqual(trustProxyConfigured(), false, 'this process must be in the direct/no-proxy posture');
        const incoming = 'forged-by-the-client-0000001';
        const res = await request(app).get('/healthz').set('X-Request-Id', incoming);
        assert.notStrictEqual(res.headers['x-request-id'], incoming, 'a client-chosen id was echoed back');
        assert.match(String(res.headers['x-request-id'] || ''), UUID_RE);
    });

    it('replaces an incoming X-Request-Id that does not (too short, illegal bytes, or too long)', async () => {
        // A literal CR/LF cannot even be handed to Node's HTTP client, so the injection shapes that CAN
        // reach a server are the ones probed here: separators, markup, and an unbounded length. Driven
        // WITH a trusted proxy so the grammar is what rejects them, not the provenance rule above.
        await withTrustedProxy(async () => {
            for (const bad of ['short', 'has spaces and semicolons; here', '<script>alert(1)</script>', 'a'.repeat(200)]) {
                const res = await request(app).get('/healthz').set('X-Request-Id', bad);
                const got = String(res.headers['x-request-id'] || '');
                assert.notStrictEqual(got, bad, `an unacceptable id was echoed back: ${JSON.stringify(bad)}`);
                assert.match(got, UUID_RE);
            }
        });
    });

    it('emits one access line per request carrying requestId, status and duration', async () => {
        const incoming = 'access-line-probe-00000001';
        const lines: string[] = [];
        const stop = addLogSink((line: string) => lines.push(line));
        try {
            await withTrustedProxy(() => request(app).get('/healthz').set('X-Request-Id', incoming));
        } finally {
            stop();
        }
        const records = lines.map((l) => JSON.parse(l)).filter((r: any) => r.msg === 'request' && r.requestId === incoming);
        assert.strictEqual(records.length, 1, `expected exactly one access line for ${incoming}, got ${records.length}`);
        const record = records[0];
        assert.strictEqual(record.status, 200);
        assert.strictEqual(record.method, 'GET');
        assert.strictEqual(record.path, '/healthz');
        assert.strictEqual(record.level, 'info');
        assert.ok(typeof record.durationMs === 'number' && record.durationMs >= 0, 'durationMs must be a number');
    });

    it('logs a 4xx access line at warn (not info), so an error budget can be read off the level', async () => {
        const incoming = 'access-line-probe-00000002';
        const lines: string[] = [];
        const stop = addLogSink((line: string) => lines.push(line));
        let res: any;
        try {
            res = await withTrustedProxy(() => request(app).get('/definitely-not-a-route-xyz').set('X-Request-Id', incoming));
        } finally {
            stop();
        }
        const status = res.status;
        assert.ok(status >= 400, `the probe path must not be served; got ${status}`);
        const record = lines.map((l) => JSON.parse(l)).find((r: any) => r.msg === 'request' && r.requestId === incoming);
        assert.ok(record, 'no access line was emitted for the failing request');
        assert.strictEqual(record.level, status >= 500 ? 'error' : 'warn');
        assert.strictEqual(record.path, '/definitely-not-a-route-xyz');
    });

    it('redacts credential-bearing fields out of the emitted line, not out of the caller', async () => {
        const { logger } = require('../core/logger');
        const lines: string[] = [];
        const stop = addLogSink((line: string) => lines.push(line));
        try {
            logger.info({
                req: { headers: { authorization: 'Bearer SUPER-SECRET-VALUE', cookie: 'wordjs_token=SUPER-SECRET-VALUE' } },
                account: { password: 'SUPER-SECRET-VALUE', secret: 'SUPER-SECRET-VALUE' },
            }, 'redaction probe');
        } finally {
            stop();
        }
        const line = lines.find((l) => l.includes('redaction probe')) || '';
        assert.ok(line, 'the probe line was not emitted');
        assert.ok(!line.includes('SUPER-SECRET-VALUE'), `a redacted value reached the log stream: ${line}`);
        const record = JSON.parse(line);
        assert.strictEqual(record.req.headers.authorization, '[redacted]');
        assert.strictEqual(record.req.headers.cookie, '[redacted]');
        assert.strictEqual(record.account.password, '[redacted]');
        assert.strictEqual(record.account.secret, '[redacted]');
    });

    it('redacts the COMPOUND credential names this codebase actually uses, at the root and two levels down', async () => {
        // THE DEFECT THIS PINS: pino redact paths are exact PROPERTY NAMES, not substrings, and the list
        // named only `password`/`token`/`secret`. `jwtSecret` and `dbPassword` sit at the ROOT of the
        // object `config/app.ts` exports, so `logger.info({ config })` printed the JWT signing key and
        // the database password in the clear while the list looked complete. The previous test passed
        // against the old list precisely because it only probed names already on it.
        const { logger } = require('../core/logger');
        const lines: string[] = [];
        const stop = addLogSink((line: string) => lines.push(line));
        try {
            logger.info({
                // The shape `logger.info({ config })` produces.
                config: { jwtSecret: 'SUPER-SECRET-VALUE', dbPassword: 'SUPER-SECRET-VALUE', siteUrl: 'https://example.com' },
                // The BARE `headers` shape — asymmetric before this: `authorization` was covered here
                // but `x-install-token` was listed only under `req.headers.*`, so a caller logging
                // `{ headers: req.headers }` redacted the Authorization header and printed the install
                // token sitting next to it.
                headers: { authorization: 'Bearer SUPER-SECRET-VALUE', 'x-csrf-token': 'SUPER-SECRET-VALUE', 'x-install-token': 'SUPER-SECRET-VALUE' },
                // Two levels down, which the `*.x` tier alone never reached.
                user: { credentials: { password: 'SUPER-SECRET-VALUE' } },
                row: { password_hash: 'SUPER-SECRET-VALUE', secret_enc: 'SUPER-SECRET-VALUE', totpSecret: 'SUPER-SECRET-VALUE' },
                accessToken: 'SUPER-SECRET-VALUE',
                refreshToken: 'SUPER-SECRET-VALUE',
                apiKey: 'SUPER-SECRET-VALUE',
                privateKey: 'SUPER-SECRET-VALUE',
            }, 'compound redaction probe');
        } finally {
            stop();
        }
        const line = lines.find((l) => l.includes('compound redaction probe')) || '';
        assert.ok(line, 'the probe line was not emitted');
        assert.ok(!line.includes('SUPER-SECRET-VALUE'), `a credential reached the log stream: ${line}`);
        const record = JSON.parse(line);
        assert.strictEqual(record.config.jwtSecret, '[redacted]');
        assert.strictEqual(record.config.dbPassword, '[redacted]');
        assert.strictEqual(record.config.siteUrl, 'https://example.com', 'redaction must not eat non-credential fields');
        assert.strictEqual(record.headers['x-install-token'], '[redacted]');
        assert.strictEqual(record.headers['x-csrf-token'], '[redacted]');
        assert.strictEqual(record.user.credentials.password, '[redacted]');
        assert.strictEqual(record.row.secret_enc, '[redacted]');
    });

    it('scrubs credentials out of a bridged console.* MESSAGE, which `redact` structurally cannot reach', async () => {
        // THE DEFECT THIS PINS: the console bridge collapses its arguments into pino's `msg` with
        // util.format, and pino's `redact` rewrites FIELDS — it never touches `msg`. So for the ~800
        // legacy `console.*` lines (which is ~100% of what this backend logs today) structural
        // redaction was not weak, it was INAPPLICABLE — and the bridge's whole purpose is to turn those
        // lines into durable, indexed records in a log store.
        const { consoleBridge, scrubSecrets } = require('../core/logger');
        const lines: string[] = [];
        const uninstall = consoleBridge();
        const stop = addLogSink((line: string) => lines.push(line));
        try {
            console.log('probe-scrub install token=SUPER-SECRET-VALUE');
        } finally {
            stop();
            uninstall();
        }
        const line = lines.find((l) => l.includes('probe-scrub')) || '';
        assert.ok(line, 'the bridged line was not emitted');
        assert.ok(!line.includes('SUPER-SECRET-VALUE'), `a credential reached the log stream through msg: ${line}`);
        const record = JSON.parse(line);
        assert.strictEqual(record.legacy, true, 'a bridged line must still carry legacy:true');
        assert.match(record.msg, /token=\[redacted\]/);

        // Each shape the scrubber claims, exercised directly — one regex, so a change to any alternative
        // can silently break the others.
        assert.strictEqual(scrubSecrets('token=abc123DEF'), 'token=[redacted]');
        assert.strictEqual(scrubSecrets('open https://x/install#token=abcdef123456'), 'open https://x/install#token=[redacted]');
        // The JWT-shaped fixtures are assembled at run time: the pre-commit secret scanner (rightly) refuses
        // a tracked file that carries the literal `Bearer eyJ…` shape, and a fixture must not be the one
        // thing that teaches it to look away.
        const jwtish = ['eyJ', 'hbGciOiJIUzI1NiJ9'].join('');
        assert.strictEqual(scrubSecrets(`Authorization: Bearer ${jwtish.slice(0, 10)}.${jwtish.slice(10)}`), 'Authorization: Bearer [redacted]');
        assert.strictEqual(scrubSecrets(`Bearer ${jwtish}`), 'Bearer [redacted]');
        assert.strictEqual(scrubSecrets('x-install-token: 0123456789abcdef'), 'x-install-token: [redacted]');
        assert.strictEqual(scrubSecrets('Cookie: wjs_csrf=abc12345; wordjs_token=eyJhbGc'), 'Cookie: wjs_csrf=[redacted]; wordjs_token=[redacted]');
        assert.strictEqual(scrubSecrets('password=hunter22 and SECRET=topsecret'), 'password=[redacted] and SECRET=[redacted]');
        assert.strictEqual(scrubSecrets('plugin key wjt_AbCdEf123456 was used'), 'plugin key [redacted] was used');

        // ANY auth scheme, not only Bearer. The failure this pins was worse than a miss: `Bearer ` was
        // the only scheme consumed as part of the key, so `Basic`, `Token`, `Digest`, `Negotiate` and
        // `AWS4-HMAC-SHA256` had their NAME replaced by `[redacted]` and their credential printed in
        // the clear next to that marker — a line an operator, a reviewer or a log scanner reads as
        // handled. The base64 is built at run time; a credential-shaped literal never enters the file.
        const basic = Buffer.from('user:hunter2').toString('base64');
        assert.strictEqual(scrubSecrets(`Authorization: Basic ${basic}`), 'Authorization: Basic [redacted]');
        assert.strictEqual(scrubSecrets('authorization: Token 7f3a9b0c1d2e3f4a5b6c'), 'authorization: Token [redacted]');
        assert.strictEqual(scrubSecrets('Proxy-Authorization: Negotiate YIIFhwYGKwYBBQUC'), 'Proxy-Authorization: Negotiate [redacted]');
        assert.strictEqual(
            scrubSecrets('Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260101/eu-west-1/s3/aws4_request'),
            'Authorization: AWS4-HMAC-SHA256 [redacted]',
        );
        // A word in the scheme position that is NOT a scheme is treated as credential material…
        assert.strictEqual(scrubSecrets('authorization: Frobnicate 7f3a9b0c1d2e'), 'authorization: [redacted]');
        // …and a scheme-less credential is masked whole, which is what the old pattern could not do.
        assert.strictEqual(scrubSecrets('authorization=7f3a9b0c1d2e3f4a5b6c'), 'authorization=[redacted]');

        // …and prose is left alone: a scrubber that rewrites ordinary messages is a scrubber operators
        // turn off.
        assert.strictEqual(scrubSecrets('GET /api/v1/posts 200 in 12ms'), 'GET /api/v1/posts 200 in 12ms');
        assert.strictEqual(scrubSecrets('just a token of appreciation'), 'just a token of appreciation');
        const prose = 'the password was rejected, so the user asked for a reset link';
        assert.strictEqual(scrubSecrets(prose), prose, 'a credential WORD with no value after it is not a credential');
    });

    it('scrubs a QUOTED value — what util.inspect and JSON.stringify produce, i.e. what the bridge itself makes', async () => {
        // THE DEFECT THIS PINS: the value class excluded both quote characters, so the pattern could
        // only ever fire on a hand-written `password=x`. But every OBJECT the bridge is handed —
        // `console.log('body', req.body)`, `console.error('cfg', config)`, a stringified payload —
        // reaches `msg` through util.inspect or JSON.stringify, and both of those quote every string
        // value. The dominant shape on this path was the one shape the scrub could not see, and the
        // suite passed green because every probe in it was a hand-written unquoted string.
        const { scrubSecrets } = require('../core/logger');
        const util = require('util');
        const secret = 'S3cret-Value-9f3a';
        const probe = { password: secret, nested: { jwtSecret: secret } };

        const inspected = scrubSecrets(util.format('login body', probe));
        assert.ok(!inspected.includes(secret), `a credential survived util.inspect scrubbing: ${inspected}`);
        assert.match(inspected, /password: '\[redacted\]'/);
        assert.match(inspected, /jwtSecret: '\[redacted\]'/);

        const stringified = scrubSecrets(util.format('payload %s', JSON.stringify(probe)));
        assert.ok(!stringified.includes(secret), `a credential survived JSON scrubbing: ${stringified}`);
        assert.strictEqual(stringified, 'payload {"password":"[redacted]","nested":{"jwtSecret":"[redacted]"}}');

        // A headers object — how this shape actually reaches a log line. The cookie jar goes WHOLE
        // once it is quoted: a session cookie's name is not required to look like a credential.
        const headers = scrubSecrets(util.format('%s', {
            authorization: `Basic ${Buffer.from('user:hunter2').toString('base64')}`,
            cookie: 'sid=8f0c1d2e3f4a; wjs_csrf=abc12345',
            'x-install-token': '0123456789abcdef0123456789abcdef',
        }));
        assert.match(headers, /authorization: 'Basic \[redacted\]'/);
        assert.match(headers, /cookie: '\[redacted\]'/);
        assert.match(headers, /'x-install-token': '\[redacted\]'/);
        assert.ok(!headers.includes('8f0c1d2e3f4a'), `a session cookie survived: ${headers}`);
        assert.ok(!headers.includes('0123456789abcdef'), `an install token survived: ${headers}`);

        // The quotes stay on both sides, so the line is still parseable and the KEY still says what
        // was there. `privateKey` is here because this list is generated from the SAME CREDENTIAL_KEYS
        // the field redaction uses — it was on that list and missing from the textual one.
        assert.strictEqual(scrubSecrets('{"token":"abc123"}'), '{"token":"[redacted]"}');
        assert.strictEqual(scrubSecrets('privateKey: "-----BEGIN"'), 'privateKey: "[redacted]"');

        // Prose with a credential WORD and no value is still not rewritten.
        const sentence = 'the password field was empty, so the request was rejected';
        assert.strictEqual(scrubSecrets(sentence), sentence);

        // This pattern runs on lines an unauthenticated client can cause, so the cost of a hostile one
        // is part of the contract: an opening quote that never closes, a key word repeated to the end
        // of the line, a jar of a thousand cookies. 40 KB of each measures 1-4 ms on this machine; the
        // bound is loose on purpose — it is here to catch a quadratic blow-up, not to time a CI runner.
        const hostile = [
            `password:"${'A'.repeat(40 * 1024)}`,
            `authorization: ${'A'.repeat(40 * 1024)}`,
            'password:"A'.repeat(3724),
            `Cookie: ${'wjs_csrf=abcdef12; '.repeat(2156)}`,
        ];
        for (const line of hostile) {
            const startedAt = process.hrtime.bigint();
            scrubSecrets(line);
            const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
            assert.ok(ms < 500, `scrubSecrets took ${ms.toFixed(1)}ms on a ${line.length}-char line`);
        }
    });

    it('caps the logged path, so an unthrottled 404 cannot bill an operator 16KB of indexed log per request', async () => {
        // The query string was bounded; the PATH was not. `req.originalUrl` minus its query is still
        // attacker-controlled and can be ~16KB, and the root 404 surface sits ABOVE the API limiter.
        const longPath = `/${'p'.repeat(4000)}`;
        const lines: string[] = [];
        const stop = addLogSink((line: string) => lines.push(line));
        try {
            await request(app).get(longPath);
        } finally {
            stop();
        }
        const record = lines.map((l) => JSON.parse(l)).find((r: any) => r.msg === 'request' && String(r.path || '').startsWith('/ppp'));
        assert.ok(record, 'no access line was emitted for the long-path request');
        assert.strictEqual(record.path.length, 200, `path was not capped: ${record.path.length} chars`);
        assert.strictEqual(record.pathTruncated, true, 'a truncated path must say so, not pass a prefix off as the whole path');
    });

    it('logs and counts an ABORTED request, which never fires `finish`', async () => {
        // THE DEFECT THIS PINS, measured: `finish` does not fire for a request whose socket dies before
        // the handler responds, so hooking it alone meant a hung endpoint, a client timeout, an upstream
        // read-timeout and every aborted upload produced ZERO access lines and ZERO metric samples —
        // the signal inverting exactly when it matters. An endpoint timing out ALL of its callers showed
        // a FALLING request rate and a healthy p95, because only the fast survivors were sampled.
        const http = require('http');
        const express = require('express');
        const { requestContext } = require('../middleware/request-context');
        const { httpMetrics, register } = require('../core/metrics');

        const probe = express();
        probe.use(requestContext, httpMetrics);
        probe.get('/hangs-forever', () => { /* deliberately never responds */ });

        const server = http.createServer(probe);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as any).port;

        const lines: string[] = [];
        const stop = addLogSink((line: string) => lines.push(line));
        try {
            await new Promise<void>((resolve) => {
                const req = http.request({ host: '127.0.0.1', port, path: '/hangs-forever', method: 'GET' }, () => { /* never */ });
                req.on('error', () => { /* the destroy below is the point */ });
                // Destroy once the request is on the wire, so the server has entered the handler.
                req.end(() => setTimeout(() => { req.destroy(); setTimeout(resolve, 120); }, 60));
            });
        } finally {
            stop();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        const record = lines.map((l) => JSON.parse(l)).find((r: any) => r.msg === 'request' && r.path === '/hangs-forever');
        assert.ok(record, 'an aborted request produced no access line at all');
        assert.strictEqual(record.aborted, true, 'the line must say the client went away, not report a status nobody sent');
        assert.strictEqual(record.level, 'warn', 'an abort is not an `info` outcome — nothing was delivered');

        const aborts = samplesOf(await register.metrics(), 'wordjs_http_requests_total')
            .map(labelsOf)
            .filter((l) => l.route === '/hangs-forever');
        assert.ok(aborts.length > 0, 'an aborted request produced no metric sample');
        assert.ok(aborts.some((l) => l.status === '499'), `an abort must not land in the 2xx bucket; got ${aborts.map((l) => l.status).join(', ')}`);
    });

    it('keeps the /metrics token gate exactly as it was: 401 without, 401 on a query string, 200 with the header', async () => {
        assert.strictEqual((await request(app).get('/metrics')).status, 401);
        assert.strictEqual((await request(app).get('/metrics').set('Authorization', 'Bearer wrong')).status, 401);
        // Header-ONLY: a `?token=` would leak the long-lived secret into access logs and Referer.
        assert.strictEqual((await request(app).get(`/metrics?token=${SCRAPE_TOKEN}`)).status, 401);
        const ok = await request(app).get('/metrics').set('Authorization', `Bearer ${SCRAPE_TOKEN}`);
        assert.strictEqual(ok.status, 200);
        assert.match(String(ok.headers['content-type'] || ''), /text\/plain/);
    });

    it('exports the HTTP series after real traffic, and keeps the original two gauges', async () => {
        await request(app).get('/healthz');
        await request(app).get('/healthz');
        const missed = await request(app).get('/no/such/path/at/all');

        const res = await request(app).get('/metrics').set('Authorization', `Bearer ${SCRAPE_TOKEN}`);
        assert.strictEqual(res.status, 200);
        const text = res.text;

        // The two gauges this endpoint shipped with must survive the extension.
        assert.ok(samplesOf(text, 'wordjs_ready').length > 0, 'wordjs_ready disappeared');
        assert.ok(samplesOf(text, 'wordjs_sse_clients').length > 0, 'wordjs_sse_clients disappeared');
        // …and the default process family the endpoint has always exported.
        assert.ok(text.includes('wordjs_process_'), 'the wordjs_process_* default metrics disappeared');

        const requests = samplesOf(text, 'wordjs_http_requests_total');
        assert.ok(requests.length > 0, 'wordjs_http_requests_total was not exported');
        const healthz = requests.map(labelsOf).find((l) => l.route === '/healthz' && l.method === 'GET' && l.status === '200');
        assert.ok(healthz, `no /healthz series in:\n${requests.join('\n')}`);

        assert.ok(samplesOf(text, 'wordjs_http_request_duration_seconds_bucket').length > 0, 'the duration histogram was not exported');
        const errors = samplesOf(text, 'wordjs_http_errors_total').map(labelsOf);
        assert.ok(errors.some((l) => l.status === String(missed.status)), `no error series for status ${missed.status}`);
    });

    it('labels a route inside a MOUNTED router with its full pattern, not just the tail', async () => {
        // THE DEFECT THIS PINS, observed before it was fixed: reading `req.baseUrl` when the response
        // finishes gives '' — Express restores it as the mounted router unwinds — so
        // `/api/v1/posts/:id` was labelled `/:id`, and so were categories, media and users. Four
        // unrelated endpoints, one time series, one latency histogram, no error anywhere.
        //
        // Driven through a tiny app rather than the real API because every /api route sits BELOW the
        // install guard, which answers 503 on an uninstalled instance and never reaches a router — so
        // the assertion would pass or fail depending on whether wordjs-config.json exists. The
        // middleware and the registry under test are the real ones.
        const express = require('express');
        const { httpMetrics, register } = require('../core/metrics');
        const probe = express();
        probe.use(httpMetrics);
        const inner = express.Router();
        inner.get('/:id', (_req: any, res: any) => res.json({ ok: true }));
        probe.use('/mounted/probe', inner);

        const res = await request(probe).get('/mounted/probe/12345');
        assert.strictEqual(res.status, 200);

        const routes = samplesOf(await register.metrics(), 'wordjs_http_requests_total').map((l) => labelsOf(l).route);
        assert.ok(routes.includes('/mounted/probe/:id'), `expected the full mounted pattern, got: ${[...new Set(routes)].join(', ')}`);
        assert.ok(!routes.includes('/:id'), 'the mount prefix was lost — the label is the route tail only');
    });

    it('bounds the route label: an unmatched path collapses to `unmatched` instead of minting a series', async () => {
        const unique = `/probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await request(app).get(unique);
        const res = await request(app).get('/metrics').set('Authorization', `Bearer ${SCRAPE_TOKEN}`);
        const routes = samplesOf(res.text, 'wordjs_http_requests_total').map((l) => labelsOf(l).route);

        assert.ok(routes.includes('unmatched'), `expected an \`unmatched\` series, got: ${[...new Set(routes)].join(', ')}`);
        assert.ok(!res.text.includes(unique), 'the request PATH reached a metric label — cardinality is unbounded');
        // Every label is either a declared route pattern or one of the two sentinels. A value carrying a
        // digit that is not part of a pattern is the shape a leaked id would have.
        for (const route of new Set(routes)) {
            assert.ok(
                route === 'unmatched' || route === 'other' || route.startsWith('/'),
                `route label ${JSON.stringify(route)} is neither a sentinel nor a route pattern`,
            );
        }
    });
});
