/**
 * WordJS — CLASS: an ABSENT Host header must never become the literal string 'undefined' inside a
 * same-origin allow-list.
 *
 * THE DEFECT. Express types `req.get('Host')` as `string | undefined`. Every same-origin gate in this
 * codebase derives a trusted host as `X-Forwarded-Host || Host` and then interpolates it into two
 * template literals — `http://${host}` and `https://${host}` — which it pushes onto the allow-list the
 * request's Origin is compared against. When the Host header is absent that interpolation does not
 * produce "no entry": it produces the LITERAL origins 'http://undefined' and 'https://undefined'. A page
 * served from the host label `undefined` — a perfectly legal DNS label, reachable via an intranet name,
 * a DNS search suffix or a hosts entry — is then SAME-ORIGIN to this site, and drives cookie-
 * authenticated requests through a gate that exists to stop exactly that.
 *
 * REACHABILITY IS NOT THEORETICAL, and supertest cannot show it because http.request always writes a
 * Host. Node rejects an HTTP/1.1 request with no Host at the parser (400), but HTTP/1.0 imposes no Host
 * requirement and Node hands such a request to Express with `req.headers.host === undefined`. So the
 * tests below drive the REAL routers over a raw socket, and a CONTROL proves the host-less request
 * genuinely arrives — without it an exploit test would "pass" on a parser-level 400 and assert nothing.
 *
 * WHY A CLASS TEST AND NOT A MEMBER TEST. The first pass fixed `middleware/auth.ts#csrfProtection` and
 * left its byte-identical twin `routes/collab.ts#sameOrigin` open — same question, same code, written
 * twice, fixed once. So this suite exercises BOTH gates against the same host-less request, and the
 * ratchet at the bottom pins the inventory of every origin-from-Host construction in routes/ and
 * middleware/ so a THIRD copy cannot be added without triage.
 *
 * THE DERIVED INVENTORY (every construction of the shape in backend/src/routes + backend/src/middleware,
 * plus the two in index.ts, which is the same question asked at the app root):
 *
 *   middleware/auth.ts  csrfProtection allow-list ....... REAL — fixed in the previous round; regression-
 *                                                        guarded here, because a twin that drifts is how
 *                                                        this class survived.
 *   routes/collab.ts    sameOrigin allow-list ........... REAL — the open twin. Gates GET /collab/:id/
 *                                                        stream, which the global CSRF middleware never
 *                                                        sees (it only runs on state-changing methods),
 *                                                        so it is the ONLY gate on a live draft feed.
 *   routes/setup.ts     POST /setup/migrate newSiteUrl .. REAL — second order: it PERSISTS the derived
 *                                                        origin as config.siteUrl / the `siteurl` option,
 *                                                        and config.site.url is itself an entry of both
 *                                                        allow-lists above. An absent Host wrote
 *                                                        'http://undefined' onto that allow-list
 *                                                        permanently. Its own sibling POST /setup/install
 *                                                        already validates the same value and rejects it.
 *   routes/setup.ts     GET /setup/status detectedUrl ... NOT a defect. Builds a string it only REPORTS;
 *                                                        it writes nothing and authorises nothing, and
 *                                                        the one decision it derives already fails closed
 *                                                        (storedUrl !== 'undefined' ⇒ mismatch: true).
 *   routes/setup.ts     POST /setup/install siteUrl ..... NOT a defect. pickInstallHost() coerces the
 *                                                        absent header to '' and HOST_PATTERN rejects it
 *                                                        with a 400 before any URL is built.
 *   routes/seo.ts ×3    sitemap/robots/feed siteUrl ..... NOT this class. No allow-list and no
 *                                                        authorisation — it is the DEFAULT for the
 *                                                        `siteurl` option, used only on a site that has
 *                                                        none, and every Host value poisons those
 *                                                        generated URLs equally. A Host-in-generated-URLs
 *                                                        problem, not an allow-list one.
 *   index.ts:154        CORS same-origin ................ NOT a defect. Already fails closed:
 *                                                        `hostnameOnly(fwd || req.headers.host || '')`
 *                                                        then `if (effectiveHost && …)`.
 *   index.ts:799        migration-mismatch guard ........ NOT a defect. `|| ''` then a guard that
 *                                                        requires a truthy detectedHost; builds no origin.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('node:net');
const http = require('http');
const jwt = require('jsonwebtoken');

const config = require('../config/app');
const TMP_DB = path.join(os.tmpdir(), `wjs-absent-host-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';

const database = require('../config/database');
const roles = require('../core/roles');
const Post = require('../models/Post');

const express = require('express');
const cookieParser = require('cookie-parser');
const { csrfProtection, sanitizeCookies } = require('../middleware/auth');

const PREFIX = config.api.prefix;
const SECRET = config.jwt.secret;

// The production stack, in the production ORDER (see index.ts): cookies, the cookie-value boundary, the
// global CSRF gate at the api prefix, then the routers. Mounting csrfProtection anywhere else would
// change which req.path it sees, which is its own historical bug.
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sanitizeCookies);
app.use(PREFIX, csrfProtection);
app.use(PREFIX, require('../routes'));

let server: any;
let adminId = 0;

// A post id that certainly does not exist. The collab stream route runs, in order: parse id →
// sameOrigin() → gate(). Pointing it at a missing post makes the SAME-ORIGIN answer observable as a
// terminating status code (403 when the gate refuses, 404 when it lets the request through to the gate)
// instead of an open SSE stream that never closes.
const MISSING_POST_ID = 999_999;

const CRLF = '\r\n';

/**
 * One HTTP/1.0 request written by hand, so that "no Host header" means exactly that. Node's own client
 * always writes a Host, so nothing in supertest/http.request can express this request.
 */
function rawRequest(port: number, requestLine: string, headers: string[]): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(requestLine + CRLF + headers.concat(['Content-Length: 0', '', '']).join(CRLF));
        });
        let raw = '';
        socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('raw socket timeout')); });
        socket.on('data', (d: Buffer) => { raw += d.toString(); });
        socket.on('error', reject);
        socket.on('close', () => resolve({
            status: Number((raw.split(CRLF)[0] || '').split(' ')[1]),
            body: raw.split(CRLF + CRLF).slice(1).join(CRLF + CRLF),
        }));
    });
}

const port = () => server.address().port;

/**
 * The DOUBLE-SUBMIT CSRF pair a real browser carries alongside the session (middleware/auth.ts): the
 * `wjs_csrf` cookie, echoed back in X-CSRF-Token. Both halves are a fixed literal here because this
 * suite speaks raw HTTP/1.0 and never signs in — the gate compares the cookie to the header, it does
 * not verify the value against anything else. Carrying it makes the CONTROL below an HONEST browser
 * request under the CURRENT contract; the exploit cases keep it too, and still fail on the ORIGIN
 * check (rest_csrf_invalid), which is what those tests assert and must keep asserting.
 */
const CSRF_TOKEN = 'raw-socket-suite-double-submit-token';
const cookie = () => `Cookie: wordjs_token=${jwt.sign({ userId: adminId, username: 'jefa' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' })}; wjs_csrf=${CSRF_TOKEN}`;

/** GET the collab stream — the gate that the global CSRF middleware never runs on. */
const collabStream = (headers: string[]) =>
    rawRequest(port(), `GET ${PREFIX}/collab/${MISSING_POST_ID}/stream?siteId=s_aaaa HTTP/1.0`, [cookie(), ...headers]);

/** POST a state change — the gate the global CSRF middleware DOES run on. */
const csrfPost = (headers: string[]) =>
    rawRequest(port(), `POST ${PREFIX}/posts HTTP/1.0`, [cookie(), `X-CSRF-Token: ${CSRF_TOKEN}`, ...headers]);

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    const dbAsync = database.getDbAsync();
    await roles.loadRoles();
    await require('../core/post-types').initPostTypes();

    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES ('jefa', 'x', 'jefa@example.com', 'Jefa')`);
    adminId = r.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', 'administrator')`, [adminId]);
    await Post.create({ authorId: adminId, title: 'Un borrador', type: 'post', status: 'draft' });

    server = http.createServer(app);
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
});

after(async () => {
    try { require('../core/collab-rooms')._resetForTests(); } catch { /* nothing joined */ }
    try { await new Promise<void>((res) => server.close(() => res())); } catch { /* already closed */ }
    try { await database.closeDatabase(); } catch { /* already closed */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.unlinkSync(f); } catch { /* never created */ }
    }
});

/* ------------------------------------------------------------------------------------------- */

describe('CONTROLS — the host-less request must really arrive, and the gates must really run', () => {
    test('CONTROL: a host-less HTTP/1.0 request is DELIVERED to the app, not 400ed by the parser', async () => {
        const res = await rawRequest(port(), `GET ${PREFIX}/posts HTTP/1.0`, []);
        assert.strictEqual(res.status, 200, 'host-less HTTP/1.0 must reach the routers; without this the exploit tests assert nothing');
    });

    test('CONTROL: with a real Host, a genuine same-origin request REACHES the collab gate (404, not 403)', async () => {
        const res = await collabStream(['Host: example.com', 'Origin: http://example.com']);
        assert.strictEqual(res.status, 404, 'a real same-origin request must pass sameOrigin() and reach the post gate');
        assert.match(res.body, /rest_post_invalid/);
    });

    test('CONTROL: with a real Host, a cross-origin request is refused by the collab gate', async () => {
        const res = await collabStream(['Host: example.com', 'Origin: http://evil.com']);
        assert.strictEqual(res.status, 403);
        assert.match(res.body, /rest_csrf_invalid/);
    });

    test('CONTROL: with a real Host, a genuine same-origin POST passes the global CSRF gate', async () => {
        const res = await csrfPost(['Host: example.com', 'Origin: http://example.com']);
        assert.notStrictEqual(res.status, 403,
            'the fix must not cost an honest same-origin caller anything — one that now also echoes its wjs_csrf cookie in X-CSRF-Token, which is what "honest" means since the double-submit token was added');
    });
});

describe("CLASS — an absent Host puts NO entry on the allow-list, at EVERY gate that builds one", () => {
    // MEMBER: routes/collab.ts#sameOrigin. This is the only origin check on GET /collab/:postId/stream,
    // because the global csrfProtection only runs on POST/PUT/PATCH/DELETE. Letting 'http://undefined'
    // through hands a hostile page a live, credentialed feed of the victim's unpublished draft.
    for (const scheme of ['http', 'https']) {
        test(`routes/collab.ts sameOrigin(): ABSENT Host must not make ${scheme}://undefined same-origin`, async () => {
            const res = await collabStream([`Origin: ${scheme}://undefined`]);
            assert.strictEqual(res.status, 403,
                `literal origin ${scheme}://undefined must never be same-origin (404 here means the gate let it through to the post gate)`);
            assert.match(res.body, /rest_csrf_invalid/);
        });
    }

    // MEMBER: middleware/auth.ts#csrfProtection — fixed in the previous round. Asserted here in the SAME
    // suite as its twin so the two can never again be answered differently without a red test.
    for (const scheme of ['http', 'https']) {
        test(`middleware/auth.ts csrfProtection: ABSENT Host must not make ${scheme}://undefined same-origin`, async () => {
            const res = await csrfPost([`Origin: ${scheme}://undefined`]);
            assert.strictEqual(res.status, 403, `literal origin ${scheme}://undefined must never be same-origin`);
            assert.match(res.body, /rest_csrf_invalid/);
        });
    }

    // MEMBER: routes/setup.ts POST /setup/migrate. Second order, and the reason it belongs to THIS class
    // rather than to a Host-validation one: what it derives is written to config.siteUrl and to the
    // `siteurl` option, and config.site.url is an entry of BOTH allow-lists above — so an absent Host
    // there installs 'http://undefined' as a same-origin PERMANENTLY, surviving every restart.
    //
    // The endpoint itself cannot be reached in a unit suite (it 400s on `!isInstalled()` and then demands
    // real administrator credentials), so what is pinned is the derivation it must consume — the very one
    // its sibling POST /setup/install has always used — plus the absence of the raw, unvalidated read.
    test('routes/setup.ts /migrate: the site host derivation refuses an absent Host', () => {
        const setup = require('../routes/setup');
        assert.strictEqual(typeof setup.pickInstallHost, 'function');
        assert.strictEqual(setup.pickInstallHost(undefined, undefined), '',
            'an absent X-Forwarded-Host and an absent Host must collapse to the empty string, never to "undefined"');
        assert.ok(setup.INSTALL_HOST_PATTERN instanceof RegExp,
            'the host allow-pattern must be shared with /migrate, not redeclared inside the /install handler');
        assert.strictEqual(setup.INSTALL_HOST_PATTERN.test(''), false, 'an absent host must not validate');
        assert.strictEqual(setup.INSTALL_HOST_PATTERN.test('undefined'), true,
            'the pattern accepts the LABEL "undefined" — which is exactly why the empty string, and not a "undefined" string, must be what an absent Host produces');
    });
});

/* ------------------------------------------------------------------------------------------- */
/* THE RATCHET — the class stays closed only if a fourth copy cannot appear unnoticed.           */
/* ------------------------------------------------------------------------------------------- */

describe('RATCHET — the inventory of origin-from-Host constructions', () => {
    const SRC = path.resolve(__dirname, '..');

    // CODE ONLY. Every comment explaining this defect necessarily QUOTES it — `http://${host}`, the raw
    // header read, the word 'undefined' — so a scanner that reads prose reports the documentation as the
    // bug and cannot ever go green. Drop whole-line comments (every doc block here is one) before matching.
    const stripComments = (src: string) => src
        .split('\n')
        .filter((l: string) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
        .join('\n');

    const read = (rel: string) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n'));

    // A file belongs to this class when it BOTH reads a host header and builds an origin by
    // interpolation — `http://${…}` / `https://${…}` / `${protocol}://${…}`.
    const HOST_HEADER_READ = /req\.get\(['"](?:x-forwarded-host|host)['"]\)/i;
    const ORIGIN_TEMPLATE = /`(?:https?|\$\{[^}]+\}):\/\/\$\{/;

    const scan = (dir: string) =>
        fs.readdirSync(path.join(SRC, dir))
            .filter((f: string) => f.endsWith('.ts'))
            .map((f: string) => `${dir}/${f}`)
            .filter((rel: string) => { const s = read(rel); return HOST_HEADER_READ.test(s) && ORIGIN_TEMPLATE.test(s); })
            .sort();

    test('no UNREVIEWED file in routes/ or middleware/ builds an origin from a host header', () => {
        // Triaged above, in the header of this file. A file appearing here that is not in this list is a
        // NEW member of the class: decide what its undefined authorises before adding it.
        const REVIEWED = ['middleware/auth.ts', 'routes/seo.ts', 'routes/setup.ts'];
        assert.deepStrictEqual([...scan('routes'), ...scan('middleware')].sort(), REVIEWED,
            'a new origin-from-Host construction appeared in routes/ or middleware/ — triage it against the inventory at the top of this file');
    });

    test('there is exactly ONE implementation of the same-origin allow-list', () => {
        // The class survived its first pass because auth.ts and collab.ts each owned a copy. collab.ts must
        // now CONSUME the implementation rather than repeat it — one shape cannot drift from itself.
        const collab = read('routes/collab.ts');
        assert.ok(!ORIGIN_TEMPLATE.test(collab),
            'routes/collab.ts must not build origins from a host itself — it must consume the single allow-list builder');
        assert.match(collab, /sameOriginAllowList/,
            'routes/collab.ts#sameOrigin must consume middleware/auth.ts#sameOriginAllowList');

        const auth = read('middleware/auth.ts');
        const guarded = (auth.match(/\.\.\.\(host \? \[`http:\/\/\$\{host\}`, `https:\/\/\$\{host\}`\] : \[\]\)/g) || []).length;
        const built = (auth.match(/`https?:\/\/\$\{host\}`/g) || []).length;
        assert.strictEqual(guarded, 1, 'the allow-list must be built in exactly one place, behind the truthiness guard');
        assert.strictEqual(built, 2, 'both scheme entries must live inside that one guarded spread — an unguarded one is the defect');
    });

    test('routes/setup.ts keeps only the ONE raw host read that authorises nothing', () => {
        // GET /setup/status may keep it: it reports a string and derives one boolean that already fails
        // closed. POST /setup/migrate may not: it persists what it derives into the allow-list's source.
        const raw = (read('routes/setup.ts').match(/req\.get\('x-forwarded-host'\) \|\| req\.get\('host'\)/g) || []).length;
        assert.strictEqual(raw, 1,
            'only GET /setup/status (display-only) may read the host unvalidated; /migrate must use pickInstallHost + INSTALL_HOST_PATTERN like /install does');
    });

    test('index.ts asks the same question and already fails closed', () => {
        const index = read('index.ts');
        assert.match(index, /hostnameOnly\(fwdHost \|\| req\.headers\.host \|\| ''\)/, 'the CORS gate must keep coercing an absent Host');
        assert.match(index, /if \(effectiveHost && originHost === effectiveHost\)/, 'and must keep requiring a truthy host before matching');
    });
});
