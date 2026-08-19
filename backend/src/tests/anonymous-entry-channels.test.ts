/**
 * ANONYMOUS ENTRY CHANNELS — GATES WHOSE POPULATION IS DERIVED, NOT LISTED
 *
 * Round 3's verdict on this area was not "you missed a bug", it was "your class was drawn around the
 * SYNTACTIC FORM the report brought, and then the test iterated that same form". The three classes below
 * are therefore stated over a population that is COMPUTED, and each gate says out loud where the
 * computation stops.
 *
 *  CHANNEL 1 — COOKIES ARE AN UNTRUSTED CHANNEL WITH A TYPE.
 *      cookie-parser applies JSONCookies unconditionally, so `Cookie: wordjs_token=j:[1]` reaches a route
 *      as an ARRAY. `token.startsWith(...)` in the auth middlewares then threw inside an async middleware
 *      that Express 4 never awaits: no next(), no response, the socket hangs. Anonymous, free, remote, on
 *      every route carrying optionalAuth/authenticate.
 *      POPULATION: every route mounted on the APP, walked from the LIVE Express stack — the routes index
 *      AND the routers backend/src/index.ts mounts directly (see APP_MOUNTS). The first version promised
 *      "any routes/*.ts file is covered" while walking only the index, which left routes/internal.ts,
 *      routes/analytics.ts and routes/backups.ts outside all three gates; a separate test now reads
 *      index.ts's own source so a fifth direct mount cannot appear without this file failing.
 *      ASSERTION: differential AND absolute. The differential is what makes it falsifiable in both
 *      directions; the absolute half exists because a differential alone reports green when the baseline
 *      is as broken as the probe — a route that answers nobody would otherwise read as "no change".
 *
 *  CHANNEL 2 — SO IS THE QUERY STRING: `?order[]=asc` is an Array, and `order.toLowerCase()` is a 500.
 *      Same walked population, one adversarial query string. A 400 is a legitimate answer (routes/posts.ts
 *      rejects non-string list fields on purpose); 5xx and "no answer" are not.
 *
 *  CHANNEL 3 — A PREFIX INSIDE A STRING IS NOT A NAMESPACE, AND A NAMESPACE IS NOT A CONTRACT.
 *      One bucket in the login throttle store takes its subject from the request body, so every OTHER
 *      bucket in that store was writable by an anonymous POST /auth/login. The gate derives the purpose
 *      set from routes/auth.ts's own LOCK_PURPOSES export and the CALL SITES from the SYNTAX TREE of every
 *      non-test file under backend/src, so a new door with a hand-built key turns it red.
 *      ROUND 4 ADDED THE SECOND HALF, and it is the one that mattered: separating the key spaces fixed WHO
 *      CAN NAME a bucket and said nothing about WHO CAN ARM ONE. Three MFA doors lost their lock CHECK and
 *      kept their ARMING, on the bucket the interactive login's second factor still reads — so a hijacked
 *      session could lock the owner out of their own account, permanently. `every locking purpose is armed
 *      only by the doors it refuses` enumerates BOTH sides of that pair from the same walk and makes them
 *      agree; the two behavioural gates at the end of this file drive the attack and the victim for real.
 *
 * Everything drives the REAL router index through supertest against a throwaway temp DB, the same harness
 * shape as sudo-gate-classes.test.ts / auth-headless-session.test.ts.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

/**
 * THE INSTALLATION THIS FILE RUNS AGAINST IS STAGED, NOT INHERITED.
 *
 * `/setup/migrate` — the rescue door the last gate in this file is about — starts with
 * `if (!isInstalled()) return 400`, and `isInstalled()` reads `wordjs-config.json` resolved from the
 * CWD AT LOAD TIME (core/configManager). So the gate only ever reached the code it exists to test
 * because the developer's own machine happens to have an installed site at `backend/`. From a clean
 * checkout — which is all CI ever has, and all a release tarball ever has — the file is absent, the
 * route answers `400 Not installed`, and the hostage property is never exercised at all. State git
 * does not carry was standing in for a fixture.
 *
 * Worse in the other direction: with the real config file in reach, anything in this run that calls
 * `saveConfig` (frontend-purge's `ensureSecret`, for one) writes into the DEVELOPER'S LIVE
 * INSTALLATION. A test suite must not be able to touch that.
 *
 * So this file does what menu-purge.test.ts does: it chdirs into a throwaway directory holding a
 * config it wrote itself, BEFORE any application module is required (config/app.ts and configManager
 * both capture the path at load time). Everything else in this file is anchored to `__dirname`, so
 * the source scanners are unaffected. The result is identical behaviour on a developer's tree and on
 * a bare extraction, and it is the REAL `isInstalled()` predicate that runs — nothing is stubbed.
 */
const ORIGINAL_CWD = process.cwd();
const TMP_INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), `wjs-entry-channels-${process.pid}-`));
fs.writeFileSync(path.join(TMP_INSTALL, 'wordjs-config.json'), JSON.stringify({
    installedAt: new Date().toISOString(),
    dbDriver: 'sqlite-native',
    siteUrl: 'http://localhost:3000',
}));
process.chdir(TMP_INSTALL);

const config = require('../config/app');
// The staged installation must really be the one the process reads — if a future refactor anchors the
// config elsewhere, this file must say so instead of quietly going back to answering 400 on the door
// it is supposed to be defending.
assert.strictEqual(
    require('../core/configManager').CONFIG_FILE,
    path.join(TMP_INSTALL, 'wordjs-config.json'),
    'the staged config is not the file configManager reads — /setup/migrate would answer 400 Not installed ' +
    'and the rescue-door gate below would prove nothing');
assert.strictEqual(require('../core/configManager').isInstalled(), true,
    'precondition: the staged installation must read as installed');

const TMP_DB = path.join(os.tmpdir(), `wjs-entry-channels-${process.pid}-${Date.now()}.db`);
config.dbPath = TMP_DB;
config.dbDriver = 'sqlite-native';
const database = require('../config/database');
const roles = require('../core/roles');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { sanitizeCookies } = require('../middleware/auth');

const B = config.api.prefix;
const PASSWORD = 'Correct-Horse-9!';

/**
 * EVERY ROUTER backend/src/index.ts MOUNTS ON THE APP, not just the one index of routers.
 *
 * The first version of this file walked `require('../routes')` and its header promised that "a route
 * added tomorrow in any routes/*.ts file is covered without editing this test". That was false: index.ts
 * mounts four more routers DIRECTLY on the app — three of them literally `routes/*.ts` — and they were
 * outside the population of all three gates. The table below is checked against index.ts's own source by
 * `the mount table is the APP's, and index.ts cannot grow one without this test noticing`, so a fifth
 * direct mount turns this file red instead of silently sitting outside every gate.
 */
const APP_MOUNTS: Array<{ base: string; module: string }> = [
    { base: B, module: '../routes' },
    { base: '/api/internal', module: '../routes/internal' },
    { base: '/api/v1/analytics', module: '../routes/analytics' },
    // Mounted late, inside initialize(), rather than at module scope — which is exactly why it was
    // invisible to a walk of the routes index.
    { base: `${B}/backups`, module: '../routes/backups' },
];

// The middleware chain exactly as backend/src/index.ts mounts it: cookieParser, then the type boundary,
// then the routers. If the boundary were mounted after a router — or not at all — the walk below hangs.
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sanitizeCookies);
for (const m of APP_MOUNTS) app.use(m.base, require(m.module));

let dbAsync: any;
let OWNER_ID = 0;
const OWNER = 'channel-owner';

before(async () => {
    await database.init({ driver: 'sqlite-native' });
    await database.initializeDatabase();
    dbAsync = database.getDbAsync();
    await require('../core/post-types').initPostTypes();
    await roles.loadRoles();
    const r = await dbAsync.run(
        `INSERT INTO users (user_login, user_pass, user_email, display_name) VALUES (?, ?, ?, ?)`,
        [OWNER, bcrypt.hashSync(PASSWORD, 10), `${OWNER}@example.com`, OWNER]);
    OWNER_ID = r.lastID;
    await dbAsync.run(`INSERT INTO user_meta (user_id, meta_key, meta_value) VALUES (?, 'role', ?)`, [OWNER_ID, 'author']);
});

after(async () => {
    try { const db = database.getDbAsync(); if (db && db.close) await db.close(); } catch { /* */ }
    for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
        try { fs.rmSync(f, { force: true }); } catch { /* */ }
    }
    // Leave the process where it found it, then drop the staged installation.
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_INSTALL, { recursive: true, force: true }); } catch { /* */ }
});

// ─── Deriving the population: walk the LIVE Express stack ─────────────────────────────────────────

/**
 * Express does not keep the mount path of a sub-router, only the regexp it compiled from it. For a plain
 * string mount that regexp has exactly one shape, so it decodes losslessly. Anything else — a regexp
 * mount, a parameterised mount, an array of paths — is NOT decoded and NOT silently skipped: it fails the
 * walk. A population that quietly drops what it cannot parse is the fake-iteration this file exists to
 * avoid; better to force whoever adds such a mount to teach the walker about it.
 */
function decodeMountPath(layer: any): string {
    const src = String(layer.regexp && layer.regexp.source);
    if (src === '^\\/?(?=\\/|$)') return '';
    const m = /^\^((?:\\\/[A-Za-z0-9_.~-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(src);
    assert.ok(m, `Un-decodable router mount ${JSON.stringify(src)}. The route walk is the POPULATION of `
        + `three gates in this file; a mount it cannot read is a hole in all three. Teach decodeMountPath `
        + `about this mount form rather than excluding it.`);
    return (m as RegExpExecArray)[1].replace(/\\\//g, '/');
}

type Endpoint = { method: string; routePath: string; url: string };

function walkRouter(router: any, prefix: string, out: Endpoint[]): void {
    for (const layer of router.stack || []) {
        if (layer.route) {
            const full = prefix + layer.route.path;
            for (const method of Object.keys(layer.route.methods)) {
                if (method !== 'get') continue; // see the note at collectEndpoints
                out.push({ method, routePath: full, url: materialize(full) });
            }
            continue;
        }
        if (layer.handle && Array.isArray(layer.handle.stack)) {
            walkRouter(layer.handle, prefix + decodeMountPath(layer), out);
        }
    }
}

/** A concrete URL for a route pattern: every parameter and wildcard becomes a harmless literal. */
function materialize(routePath: string): string {
    return routePath
        .replace(/:[A-Za-z0-9_]+\??/g, '1')
        .replace(/\*/g, 'x')
        .replace(/\/{2,}/g, '/') || '/';
}

/**
 * GET only, and deliberately so. The defect lives in middleware that runs identically for every method,
 * so GET is a faithful probe of it; firing every registered POST/PUT/DELETE anonymously at a live router
 * would be a mutation sweep wearing a test's clothes. STATED, not implied: this gate does not cover a
 * write-only route whose handler reads a cookie itself — the chokepoint in index.ts does, and no such
 * reader exists in backend/src today (`grep -n 'req\.cookies' backend/src` → middleware/auth.ts,
 * routes/auth.ts and core/plugin-isolate.ts, all of which go through the string readers).
 */
function collectEndpoints(): Endpoint[] {
    const out: Endpoint[] = [];
    for (const m of APP_MOUNTS) walkRouter(require(m.module), m.base, out);
    return out;
}

/**
 * The direct mounts, read out of index.ts's SOURCE. The point is not to re-derive the table above — it is
 * to make index.ts unable to grow a mount this file does not know about: a router mounted on the app is
 * reachable by an anonymous request whether or not this test walked it, and "the population is whatever
 * routes/index.ts happens to re-export" is precisely the assumption that hid four routers.
 */
function directMountsInIndexSource(): string[] {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    const found: string[] = [];
    for (const m of src.matchAll(/app\.use\(\s*(?:'([^']*)'|`([^`]*)`)\s*,\s*require\('\.\/(routes\/[\w-]+)'\)\s*\)/g)) {
        found.push(m[3]);
    }
    return [...new Set(found)];
}

const RESPONSE_TIMEOUT_MS = 8000;

/** The status code, or the sentinel `NO_RESPONSE` — which is what the cookie DoS actually produces. */
async function statusOf(url: string, apply: (r: any) => any): Promise<number | string> {
    let timer: any;
    const answered = apply(request(app).get(url)).then((r: any) => r.status);
    const timeout = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('NO_RESPONSE'), RESPONSE_TIMEOUT_MS); });
    try {
        return await Promise.race([answered, timeout]);
    } catch (e: any) {
        // A transport-level abort is indistinguishable from a hang for this class's purposes.
        return `ERR:${e && e.code ? e.code : 'unknown'}`;
    } finally {
        clearTimeout(timer);
    }
}

test('the route walk finds a real population (and would notice if it stopped doing so)', () => {
    const eps = collectEndpoints();
    // A floor, not an equality: the point is that the walk is LIVE. If it ever returns a handful because
    // a mount form changed shape, the two channel gates below would go quietly green on nothing.
    assert.ok(eps.length >= 50, `expected the live router stack to yield a real population, got ${eps.length}`);
    const paths = new Set(eps.map((e) => e.routePath));
    for (const known of [`${B}/comments/`, `${B}/media/`, `${B}/posts/`, `${B}/categories/`]) {
        assert.ok(paths.has(known), `the walk lost ${known}; it is no longer enumerating the router index`);
    }
});

test('the mount table is the APP\'s, and index.ts cannot grow one without this test noticing', () => {
    const known = new Set(APP_MOUNTS.map((m) => m.module.replace(/^\.\.\//, '')));
    const missing = directMountsInIndexSource().filter((m) => !known.has(m)).sort();
    assert.deepStrictEqual(missing, [],
        'backend/src/index.ts mounts a router DIRECTLY on the app that APP_MOUNTS does not list, so it sits '
        + 'outside the population of all three gates in this file. Add it to APP_MOUNTS (and fix whatever '
        + 'the gates then say about it) rather than leaving it unwalked.');

    // The two mounts that are NOT plain `app.use('<path>', require('./routes/x'))` and so cannot be read
    // by the scan above. Listed with the reason, and each row is self-invalidating: if the source stops
    // matching, the row is a claim of knowledge that is no longer true.
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    assert.ok(/app\.use\(`\$\{config\.api\.prefix\}\/backups`, require\('\.\/routes\/backups'\)\)/.test(src),
        'routes/backups is expected to be mounted lazily inside initialize(); it moved — re-derive APP_MOUNTS');
    assert.ok(/require\('\.\/core\/db-admin'\)\.register\(app\)/.test(src),
        'core/db-admin registers its own routes on the app; that call moved — re-derive APP_MOUNTS');
    // db-admin is the one mount deliberately NOT walked: it registers on the app from a .js module under
    // core/, is gated behind an install token, and this file's owner does not own it. Stated, not implied.
});

// ─── CHANNEL 1 · a JSON cookie may not change what any route answers ──────────────────────────────

test('CHANNEL 1 — a JSON-encoded cookie changes NOTHING on any route the router index registers', async () => {
    const eps = collectEndpoints();
    const failures: string[] = [];

    // `j:` is cookie-parser's JSONCookie marker. Three shapes, because the readers differ in HOW they
    // misuse the value: an Array has no .startsWith, an Object has no .startsWith, and a NUMBER passes a
    // truthiness check and then has no .startsWith either. A plain string stays a string and is the
    // control that proves the poison is what changed the answer, not the presence of a cookie.
    const poisons = ['j:[1]', 'j:{"a":1}', 'j:1'];
    // TWO cookie names, and the second one matters more than the first. `wordjs_token` is the one the
    // report named and the one middleware/auth.ts hardens at the read. `wjs_probe` is a name NOTHING in
    // this codebase reads — it is here because the class is "a cookie is not necessarily a string", not
    // "the session cookie is not necessarily a string". A route that starts reading a cookie of its own
    // choosing tomorrow is only safe because of the chokepoint, and this column is what would notice if
    // the chokepoint stopped covering it.
    const names = ['wordjs_token', 'wjs_probe'];

    for (const ep of eps) {
        const plain = await statusOf(ep.url, (r: any) => r);
        // ABSOLUTE, alongside the differential. A differential assertion reports GREEN when the baseline is
        // as broken as the probe: if a route stops answering for everyone, `plain` is NO_RESPONSE, the six
        // poisoned requests are NO_RESPONSE too, and "no change" reads as "no defect" over precisely the
        // outcome this channel exists to forbid. A route that does not answer even WITHOUT a cookie is a
        // failure in its own right.
        if (typeof plain !== 'number') {
            failures.push(`GET ${ep.routePath} — the baseline itself did not answer: ${plain}`);
            continue;
        }
        for (const name of names) {
            for (const poison of poisons) {
                const got = await statusOf(ep.url, (r: any) => r.set('Cookie', `${name}=${encodeURIComponent(poison)}`));
                if (got !== plain) failures.push(`GET ${ep.routePath} — no cookie → ${plain}, ${name}=${poison} → ${got}`);
            }
        }
    }

    assert.deepStrictEqual(failures, [],
        `A cookie value is a STRING (RFC 6265). Any route whose answer depends on cookie-parser having `
        + `JSON-decoded it is reading a type it never validated:\n  ${failures.join('\n  ')}`);
});

// ─── CHANNEL 2 · array-valued query parameters may not produce a server error ─────────────────────

test('CHANNEL 2 — array-valued query parameters never produce a 5xx or a hang', async () => {
    const eps = collectEndpoints();
    const failures: string[] = [];

    // The names are the ones Express will turn into an Array for `?name[]=v`. They are NOT the population
    // — the population is the route set above; these are the probe. `orderby=constructor` rides along
    // because the same handlers index a lookup map with it, and a `{}` literal answers with a Function.
    const probe = 'order[]=asc&orderby[]=date&page[]=1&per_page[]=5&search[]=x&status[]=1&orderby=constructor';

    // WHERE THIS GATE STOPS, stated rather than implied: it drives every route ANONYMOUSLY, so a handler
    // behind `router.use(authenticate, …)` is answered 401 before its query parsing runs and is therefore
    // NOT covered. One live member sits in that shadow today — routes/users.ts:149 still does
    // `['asc','desc'].includes(order.toLowerCase())` and needs list_users to reach — and it belongs to
    // another owner in this wave. Covering it means giving this walk a session per capability, which is a
    // bigger change than the one it would gate; the honest statement is that the anonymous surface is
    // closed and the authenticated one is not.

    for (const ep of eps) {
        const url = `${ep.url}${ep.url.includes('?') ? '&' : '?'}${probe}`;
        const got = await statusOf(url, (r: any) => r);
        // 400 is a legitimate answer: routes/posts.ts rejects non-string list fields deliberately.
        // 5xx and "no answer" are the two outcomes an anonymous caller must never be able to buy.
        if (typeof got !== 'number' || got >= 500) failures.push(`GET ${ep.routePath}?${probe} → ${got}`);
    }

    assert.deepStrictEqual(failures, [],
        `An anonymous caller must not be able to turn a query parameter into a server error:\n  ${failures.join('\n  ')}`);
});

// ─── CHANNEL 3 · no throttle purpose is reachable from another purpose's subject ───────────────────

/**
 * WHY THIS SCANNER IS AN AST WALK AND NOT A REGEX OVER LINES.
 *
 * The previous version built `new RegExp('\\b' + name + '\\(\\s*([^)]*)\\)')` and applied it LINE BY LINE
 * against six hand-written helper names. Four perfectly ordinary spellings walked straight through it, and
 * none of them is clever — they are what an editor or a second author produces by default:
 *   · the same call wrapped at 120 columns, so the `)` is on another line — invisible, not even counted;
 *   · `const { recordLoginFail: hit } = require('./auth')` and then `hit(key)` — an alias;
 *   · `auth['recordLoginFail'](key)` — a computed member name;
 *   · a forwarder declared in ANOTHER file (the fixed point only looked inside one file, and only at
 *     `function name(`).
 * A gate whose population is defeated by line wrapping is a gate over a SPELLING, which is exactly the
 * finding this file exists to answer. So: parse, walk CallExpressions, resolve the callee through member
 * access, computed member access and local aliases, and resolve the argument back to the lockBucket() call
 * that produced it. `the scanner sees the spellings a line-regex misses` below runs the scanner over each
 * of those four forms and fails if any of them goes unseen.
 *
 * The HELPER NAMES are derived too, from routes/auth.ts's own source: a throttle helper is a function
 * whose first parameter reaches `_loginKey()` (directly or through another such function) and that
 * routes/auth.ts exports. A new helper added and exported tomorrow joins the population by itself; the
 * six-name literal list could not.
 */
const ts = require('typescript');
const SRC_ROOT = path.join(__dirname, '..');
const AUTH_TS = path.join(SRC_ROOT, 'routes', 'auth.ts');

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'tests' && entry.name !== 'tests-integration') sourceFiles(p, out); }
        else if (entry.name.endsWith('.ts')) out.push(p);
    }
    return out;
}

const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** The callee's simple name, through `x.name(…)` and `x['name'](…)` alike. */
function calleeName(expr: any, sf: any): string | null {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isElementAccessExpression(expr) && expr.argumentExpression && ts.isStringLiteral(expr.argumentExpression)) {
        return expr.argumentExpression.text;
    }
    if (ts.isParenthesizedExpression(expr)) return calleeName(expr.expression, sf);
    return null;
}

function eachNode(node: any, fn: (n: any) => void): void {
    fn(node);
    ts.forEachChild(node, (c: any) => eachNode(c, fn));
}

/**
 * The throttle helpers, read out of routes/auth.ts. Seeded on `_loginKey` — the one function that turns an
 * argument into a key in the shared store — and closed under "my first parameter is that function's first
 * argument", then intersected with what the module exports.
 */
function deriveHelperNames(): Set<string> {
    const sf = parse('auth.ts', fs.readFileSync(AUTH_TS, 'utf8'));
    const fns = new Map<string, { param: string; node: any }>();
    eachNode(sf, (n: any) => {
        if (ts.isFunctionDeclaration(n) && n.name && n.parameters.length) {
            fns.set(n.name.text, { param: n.parameters[0].name.getText(sf), node: n });
        }
    });
    const consumers = new Set<string>(['_loginKey']);
    for (let pass = 0; pass < 8; pass++) {
        let grew = false;
        for (const [name, { param, node }] of fns) {
            if (consumers.has(name)) continue;
            let forwards = false;
            eachNode(node, (n: any) => {
                if (!ts.isCallExpression(n)) return;
                const c = calleeName(n.expression, sf);
                if (c && consumers.has(c) && n.arguments.length && n.arguments[0].getText(sf) === param) forwards = true;
            });
            if (forwards) { consumers.add(name); grew = true; }
        }
        if (!grew) break;
    }
    consumers.delete('_loginKey');
    // …and only the ones a door in another file can actually reach.
    const exported = new Set<string>();
    eachNode(sf, (n: any) => {
        if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
        if (!ts.isPropertyAccessExpression(n.left)) return;
        if (n.left.expression.getText(sf) !== 'module.exports') return;
        if (ts.isIdentifier(n.right) && consumers.has(n.right.text)) exported.add(n.left.name.text);
    });
    const names = new Set<string>([...consumers, ...exported]);
    assert.ok(names.has('isLoginLocked') && names.has('recordLoginFail') && names.has('beginLoginAttempt'),
        `the helper derivation stopped seeing routes/auth.ts's own store functions: ${JSON.stringify([...names])}`);
    return names;
}

const HELPERS = deriveHelperNames();
/** The two halves of the lock pair, by name, so the reader/writer gate below can talk about them. */
const LOCK_READER = 'isLoginLocked';
const LOCK_ARMER = 'recordLoginFail';

interface Site { file: string; line: number; helper: string; purpose: string | null; arg: string; door: string }

/**
 * Every throttle call site in one source, with the PURPOSE its key was built under and the DOOR it sits in.
 * `offenders` are call sites whose key did not come out of lockBucket() at all — the original class.
 */
function scanSource(fileLabel: string, text: string): { sites: Site[]; offenders: string[] } {
    const sf = parse(path.basename(fileLabel), text);
    const sites: Site[] = [];
    const offenders: string[] = [];

    // Local spellings of a helper: `const { recordLoginFail } = require(…)`, `const { x: y } = require(…)`,
    // `const hit = auth.recordLoginFail`. The value's ORIGIN does not matter — the distinctive name does.
    const aliasOf = new Map<string, string>();
    // Functions in this file that RETURN a lockBucket() key (`inflightBucket` is one), with their purpose
    // when it is a literal. Derived, so a new wrapper does not need a row anywhere.
    const producers = new Map<string, string | null>([['lockBucket', null]]);
    // Local forwarders (function name → the purpose its first parameter carries, null if it varies).
    const forwarders = new Map<string, string | null>();

    const literalPurpose = (call: any): string | null => {
        const a = call.arguments && call.arguments[0];
        return a && ts.isStringLiteral(a) ? a.text : null;
    };

    eachNode(sf, (n: any) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
            const init = n.initializer;
            if (ts.isObjectBindingPattern(n.name)) {
                for (const el of n.name.elements) {
                    const from = (el.propertyName || el.name).getText(sf);
                    if (HELPERS.has(from) || producers.has(from)) aliasOf.set(el.name.getText(sf), from);
                }
            } else if (ts.isIdentifier(n.name)) {
                const c = ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)
                    ? calleeName(init, sf) : (ts.isIdentifier(init) ? init.text : null);
                if (c && (HELPERS.has(c) || producers.has(c))) aliasOf.set(n.name.text, c);
            }
        }
    });
    const canonical = (name: string | null) => (name && aliasOf.has(name) ? (aliasOf.get(name) as string) : name);

    // Producers: a function whose return expression is a call to a producer. Fixed point, so a wrapper of a
    // wrapper still counts.
    for (let pass = 0; pass < 8; pass++) {
        let grew = false;
        eachNode(sf, (n: any) => {
            if (!ts.isFunctionDeclaration(n) || !n.name || producers.has(n.name.text)) return;
            let purpose: string | null | undefined;
            eachNode(n, (r: any) => {
                if (!ts.isReturnStatement(r) || !r.expression || !ts.isCallExpression(r.expression)) return;
                const c = canonical(calleeName(r.expression.expression, sf));
                if (c && producers.has(c)) purpose = literalPurpose(r.expression);
            });
            if (purpose !== undefined) { producers.set(n.name.text, purpose); grew = true; }
        });
        if (!grew) break;
    }

    /**
     * The declaration of `name` visible from `node`, resolved through the enclosing SCOPES, nearest first.
     *
     * Not a file-wide name→purpose map, and the difference is not academic: routes/auth.ts declares
     * `const lk = lockBucket(…)` three times, once per MFA door, and a flat map keeps only the last. With
     * one, the gate below reported that /auth/mfa/disable armed 'mfa_manage' when its source said 'mfa' —
     * i.e. it answered GREEN over the exact regression it exists to catch. Same-named locals in sibling
     * handlers are the normal way to write Express routes, so resolving them per scope is the minimum
     * this walk has to do to be talking about the right bucket.
     */
    const declOf = (node: any, name: string): any => {
        for (let p = node.parent; p; p = p.parent) {
            const statements = (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p)) ? p.statements : null;
            if (!statements) continue;
            let found: any = null;
            for (const st of statements) {
                if (!ts.isVariableStatement(st)) continue;
                for (const d of st.declarationList.declarations) {
                    if (ts.isIdentifier(d.name) && d.name.text === name) found = d;
                }
            }
            if (found) return found;
        }
        return null;
    };

    /** The function declaration a node sits directly inside, if any. */
    const enclosingFn = (node: any): any => {
        for (let p = node.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name) return p;
        return null;
    };

    /**
     * The first parameter of the throttle helper a node sits inside, if any. Those functions ARE the store:
     * `payFailureDelay(bucket)` handing `bucket` to `loginFailCount` is the implementation forwarding its own
     * key, not a door inventing one. Narrowed to that exact shape — the enclosing helper's own parameter —
     * rather than exempting the file or the function, so nothing else in routes/auth.ts is let through.
     */
    const enclosingHelperParam = (node: any): string | null => {
        for (let p = node.parent; p; p = p.parent) {
            if (ts.isFunctionDeclaration(p) && p.name) {
                return HELPERS.has(p.name.text) && p.parameters.length ? p.parameters[0].name.getText(sf) : null;
            }
        }
        return null;
    };

    /** {ok, purpose} for an argument node, or ok:false when the key did not come from lockBucket(). */
    const classify = (arg: any): { ok: boolean; purpose: string | null } => {
        if (!arg) return { ok: false, purpose: null };
        if (ts.isIdentifier(arg) && enclosingHelperParam(arg) === arg.text) return { ok: true, purpose: null };
        if (ts.isCallExpression(arg)) {
            const c = canonical(calleeName(arg.expression, sf));
            if (c && producers.has(c)) {
                return { ok: true, purpose: c === 'lockBucket' ? literalPurpose(arg) : (producers.get(c) as string | null) };
            }
            return { ok: false, purpose: null };
        }
        if (ts.isAwaitExpression(arg) || ts.isParenthesizedExpression(arg)) return classify(arg.expression);
        if (ts.isIdentifier(arg)) {
            const d = declOf(arg, arg.text);
            if (d && d.initializer && ts.isCallExpression(d.initializer)) {
                const c = canonical(calleeName(d.initializer.expression, sf));
                if (c && producers.has(c)) {
                    return { ok: true, purpose: c === 'lockBucket' ? literalPurpose(d.initializer) : (producers.get(c) as string | null) };
                }
            }
            // The first parameter of an enclosing forwarder — a key handed in from its own call sites.
            const fn = enclosingFn(arg);
            if (fn && fn.parameters.length && fn.parameters[0].name.getText(sf) === arg.text && forwarders.has(fn.name.text)) {
                return { ok: true, purpose: forwarders.get(fn.name.text) as string | null };
            }
        }
        return { ok: false, purpose: null };
    };

    // Local forwarders, to a fixed point: a function whose first parameter is handed to a helper, and whose
    // OWN call sites all pass lockBucket keys, is itself part of the population and its parameter is a key.
    const helperNames = new Set<string>(HELPERS);
    for (let pass = 0; pass < 8; pass++) {
        let grew = false;
        eachNode(sf, (n: any) => {
            if (!ts.isFunctionDeclaration(n) || !n.name || !n.parameters.length) return;
            const fnName = n.name.text;
            const param = n.parameters[0].name.getText(sf);
            if (helperNames.has(fnName) || forwarders.has(fnName)) return;
            let forwards = false;
            eachNode(n, (c: any) => {
                if (!ts.isCallExpression(c)) return;
                const name = canonical(calleeName(c.expression, sf));
                if (name && helperNames.has(name) && c.arguments.length && c.arguments[0].getText(sf) === param) forwards = true;
            });
            if (!forwards) return;
            const callSites: any[] = [];
            eachNode(sf, (c: any) => {
                if (ts.isCallExpression(c) && canonical(calleeName(c.expression, sf)) === fnName) callSites.push(c);
            });
            if (!callSites.length || !callSites.every((c) => classify(c.arguments[0]).ok)) return;
            const purposes = new Set(callSites.map((c) => classify(c.arguments[0]).purpose));
            forwarders.set(fnName, purposes.size === 1 ? ([...purposes][0] as string | null) : null);
            helperNames.add(fnName);
            grew = true;
        });
        if (!grew) break;
    }

    /** The route registration a node sits in, else the function that encloses it. */
    const doorOf = (node: any): string => {
        for (let p = node.parent; p; p = p.parent) {
            if (ts.isCallExpression(p)) {
                const verb = ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : null;
                if (verb && /^(get|post|put|patch|delete|all|use)$/.test(verb)
                    && p.arguments.length && ts.isStringLiteral(p.arguments[0])) {
                    return `${fileLabel} ${verb.toUpperCase()} ${p.arguments[0].text}`;
                }
            }
            if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return `${fileLabel} fn ${p.name.getText(sf)}`;
        }
        return `${fileLabel} <module>`;
    };

    eachNode(sf, (n: any) => {
        if (!ts.isCallExpression(n)) return;
        const name = canonical(calleeName(n.expression, sf));
        if (!name || !helperNames.has(name)) return;
        // A call with no argument cannot be classified and is not one of these helpers being used as a key
        // consumer; the helpers all take the key first.
        if (!n.arguments.length) return;
        const { ok, purpose } = classify(n.arguments[0]);
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const arg = n.arguments[0].getText(sf).replace(/\s+/g, ' ');
        if (!ok) { offenders.push(`${fileLabel}:${line} — ${name}(${arg})`); return; }
        sites.push({ file: fileLabel, line, helper: name, purpose, arg, door: doorOf(n) });
    });

    return { sites, offenders };
}

function scanBackendSrc(): { sites: Site[]; offenders: string[] } {
    const sites: Site[] = [];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
        const label = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
        const r = scanSource(label, fs.readFileSync(file, 'utf8'));
        sites.push(...r.sites);
        offenders.push(...r.offenders);
    }
    return { sites, offenders };
}

test('CHANNEL 3 — every throttle call site in backend/src builds its key with lockBucket()', () => {
    const { sites, offenders } = scanBackendSrc();
    // A floor on the DERIVED population, not on a spelling: if the walk stops resolving call sites the two
    // gates that stand on it would go quietly green over nothing.
    assert.ok(sites.length >= 15, `the scan resolved only ${sites.length} throttle call sites; it has stopped matching the source`);
    assert.deepStrictEqual(offenders.sort(), [],
        `A throttle key that was not built by lockBucket() puts an attacker-chosen subject in the same flat `
        + `key space as every other purpose:\n  ${offenders.join('\n  ')}`);
    // NO EXEMPTIONS. The previous version carried two, and both had rotted: routes/plugins.ts's marker
    // survived only inside a COMMENT narrating the fix, so the whole 1737-line admin router was exempt for
    // ever, and routes/setup.ts's hand-built `'migrate:' + …` is now a real purpose. An exemption keyed by
    // FILE is a hole the size of the file; if one is ever needed again it must name a line.
});

test('CHANNEL 3 — the scanner sees the spellings a line-regex misses', () => {
    // Each of these was demonstrated to slip past the previous scanner. They are the acceptance proof for
    // the walk itself: a population that only recognises one spelling is a population over that spelling.
    const cases: Array<{ name: string; src: string }> = [
        {
            name: 'the call wrapped across lines',
            src: `const auth = require('./auth');\nasync function d(req: any) {\n  await auth.recordLoginFail(\n    'mfa:' + req.body.username,\n  );\n}\n`,
        },
        {
            name: 'a destructured alias',
            src: `const { recordLoginFail: hit } = require('./auth');\nasync function d(u: any) { await hit('mfa:' + u); }\n`,
        },
        {
            name: 'a computed member name',
            src: `const auth = require('./auth');\nasync function d(u: any) { await auth['recordLoginFail']('mfa:' + u); }\n`,
        },
        {
            name: 'a property alias held in a const',
            src: `const auth = require('./auth');\nconst rf = auth.recordLoginFail;\nasync function d(u: any) { await rf('mfa:' + u); }\n`,
        },
    ];
    for (const c of cases) {
        const { offenders } = scanSource('synthetic.ts', c.src);
        assert.strictEqual(offenders.length, 1, `${c.name}: the scanner did not see it — ${JSON.stringify(offenders)}`);
    }
    // …and the honest control: the same door spelled correctly is NOT an offender, so the four above fail
    // for the reason claimed (a hand-built key) and not because the scanner rejects everything.
    const clean = scanSource('synthetic.ts',
        `const auth = require('./auth');\nasync function d(req: any) {\n  await auth.recordLoginFail(\n    auth.lockBucket('mfa', req.user.id),\n  );\n}\n`);
    assert.deepStrictEqual(clean.offenders, [], 'the control spelling must pass');
    assert.deepStrictEqual(clean.sites.map((s) => s.purpose), ['mfa'], 'the control must be attributed to its purpose');
});

/**
 * THE FINDING THAT DEFINES THIS GATE. The redesign moved the lock CHECK off three MFA doors and left the
 * ARMING behind, on the very bucket the fourth door — the second factor of the interactive login — still
 * reads. Twelve wrong codes at POST /auth/mfa/disable, a door needing nothing but the session cookie, then
 * answered the owner's CORRECT code with 429, renewably and with no recovery path.
 *
 * So the gate is not "the doors under review answer on the merits" (they did, and the suite was green). It
 * is the READ/WRITE PAIR itself, over the whole source: for every purpose, WHO reads its lock and WHO can
 * arm it, enumerated from the same walk, and made to agree.
 */
test('CHANNEL 3 — every locking purpose is armed only by the doors it refuses', () => {
    const auth = require('../routes/auth');
    const declared: string[] = [...auth.LOCKING_PURPOSES].sort();
    const { sites } = scanBackendSrc();

    const by = (helper: string) => {
        const m = new Map<string, Set<string>>();
        for (const s of sites) {
            if (s.helper !== helper) continue;
            assert.ok(s.purpose, `${s.file}:${s.line} — ${helper}() on a key whose purpose is not a literal `
                + `(${s.arg}). Both halves of the lock pair must be attributable, or this gate cannot pair them.`);
            if (!m.has(s.purpose as string)) m.set(s.purpose as string, new Set());
            (m.get(s.purpose as string) as Set<string>).add(s.door);
        }
        return m;
    };
    const readers = by(LOCK_READER);
    const armers = by(LOCK_ARMER);

    // 1 · A purpose is LOCKING exactly when some door reads its lock. This is the half a redesign silently
    //     deletes: remove the reader and the declaration is a lie in one direction; remove the declaration
    //     and the reader refuses on a lock nothing arms, in the other.
    assert.deepStrictEqual([...readers.keys()].sort(), declared,
        `routes/auth.ts declares LOCKING_PURPOSES=${JSON.stringify(declared)} but the source READS the lock of `
        + `${JSON.stringify([...readers.keys()].sort())}. A declaration and its readers must be the same set.`);

    // 2 · THE PAIR. Every door that can ARM a lock must be a door that lock REFUSES. An armer that is not a
    //     reader is a door that jams somebody else's — which is precisely /auth/mfa/disable arming 'mfa'.
    for (const [purpose, doors] of armers) {
        const readingDoors = readers.get(purpose) || new Set<string>();
        const foreign = [...doors].filter((d) => !readingDoors.has(d)).sort();
        if (!readingDoors.size) continue; // count-only purpose: nothing to jam, checked by 3 below
        assert.deepStrictEqual(foreign, [],
            `the '${purpose}' lock is READ by ${JSON.stringify([...readingDoors].sort())} but ARMED by `
            + `${JSON.stringify(foreign)}. A door that arms a lock it is not itself refused by can lock its `
            + `neighbour's owner out — the hostage this class exists to remove. Give it a count-only purpose.`);
    }

    // 3 · …and the converse, so the two directions are both stated: a count-only purpose has no reader.
    for (const [purpose] of armers) {
        if (declared.includes(purpose)) continue;
        assert.strictEqual(readers.has(purpose), false, `'${purpose}' is count-only yet something reads its lock`);
    }

    // 4 · Every purpose seen at a call site is one routes/auth.ts declares. lockBucket() is typed, but this
    //     walk reads text, so state it here rather than trusting the compiler to have been run.
    const all = new Set<string>([...readers.keys(), ...armers.keys()]);
    const unknown = [...all].filter((p) => ![...auth.LOCK_PURPOSES].includes(p)).sort();
    assert.deepStrictEqual(unknown, [], `a call site uses a purpose LOCK_PURPOSES does not contain: ${unknown}`);

    // The pair is only meaningful if both sides were actually found.
    assert.ok(readers.size >= 2 && armers.size >= 3,
        `the walk found ${readers.size} read purposes and ${armers.size} armed purposes — too few to be reading the routers`);
});

test('CHANNEL 3 — no purpose can be addressed from another purpose\'s subject', () => {
    const auth = require('../routes/auth');
    const purposes: string[] = [...auth.LOCK_PURPOSES];
    assert.ok(purposes.length >= 2, 'a purpose set of one is not a namespace');

    // Derived cross-product: for every ORDERED pair of purposes, try to spell purpose B's key using
    // purpose A's subject — which is what /auth/login lets an anonymous caller do. Adding a purpose adds
    // a row on both axes without touching this test.
    for (const attacker of purposes) {
        for (const victim of purposes) {
            if (attacker === victim) continue;
            for (const subject of [`${victim}:${OWNER}`, `${victim}:${OWNER_ID}`, `${victim}:`, victim]) {
                const forged = auth.lockBucket(attacker, subject);
                for (const s of [OWNER, String(OWNER_ID), '', '1']) {
                    assert.notStrictEqual(forged, auth.lockBucket(victim, s),
                        `lockBucket(${attacker}, ${JSON.stringify(subject)}) collides with the ${victim} bucket`);
                }
            }
        }
    }
});

test('CHANNEL 3 — an anonymous POST /auth/login cannot arm the MFA doors of a known account', async () => {
    const auth = require('../routes/auth');
    const purposes: string[] = [...auth.LOCK_PURPOSES];

    // PRODUCER PROOF first, so this is not a fixture arguing with itself: drive the real route once and
    // show that the key it writes really is lockBucket('login', <submitted username>). Everything after
    // this line arms buckets through that proven key rather than guessing at the route's internals.
    const probe = `mfa:${OWNER}`;
    const before = await auth.loginFailCount(auth.lockBucket('login', probe));
    const res = await request(app).post(`${B}/auth/login`).send({ username: probe, password: 'wrong' });
    assert.ok(res.status !== 200, `the anonymous probe must not authenticate, got ${res.status}`);
    assert.strictEqual(await auth.loginFailCount(auth.lockBucket('login', probe)), before + 1,
        'the login route must be shown to write the bucket this test then arms — otherwise the rest proves nothing');

    // Now arm EVERY key an anonymous caller can address, derived from the purpose set × the identity
    // forms of a known victim. Twelve is past LOGIN_MAX_FAILS (10), so each of these really is locked.
    const spellings: string[] = [];
    for (const p of purposes) {
        for (const subject of [OWNER, String(OWNER_ID), `${OWNER}@example.com`, `${OWNER.toUpperCase()}`]) {
            spellings.push(`${p}:${subject}`, ` ${p}:${subject} `);
        }
    }
    for (const s of spellings) {
        const key = auth.lockBucket('login', s);
        for (let i = 0; i < 12; i++) await auth.recordLoginFail(key);
        assert.strictEqual(await auth.isLoginLocked(key), true, `precondition: ${key} must really be armed`);
    }

    // …and NOT ONE of the victim's own purpose buckets moved.
    for (const p of purposes) {
        for (const subject of [OWNER_ID, OWNER]) {
            assert.strictEqual(await auth.isLoginLocked(auth.lockBucket(p as any, subject)), false,
                `the ${p} bucket for ${subject} was armed from an anonymous /auth/login — the purpose is squattable`);
        }
    }

    for (const s of spellings) await auth.clearLoginFails(auth.lockBucket('login', s));
});

/**
 * THE DOORS THEMSELVES, with the population read off the same walk as the gate above.
 *
 * The previous version of this test armed `lockBucket('mfa', OWNER_ID)` by hand and then drove three doors
 * that it ALSO assumed used that bucket. When the doors moved to their own purpose the assumption became
 * false and the test kept passing over a bucket none of them touches — green, and testing nothing. So the
 * bucket each door is held to is now DERIVED from that door's own recordLoginFail call site, and the row
 * set is checked against the derived door set.
 */
test('CHANNEL 3 — the MFA doors answer on the merits even with their own bucket full (no hostage)', async () => {
    const auth = require('../routes/auth');
    const mfa = require('../core/mfa');
    const totp = require('../core/totp');
    const jwt = require('jsonwebtoken');
    const session = `Bearer ${jwt.sign({ userId: OWNER_ID, username: OWNER }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;

    // Which purpose does each door in routes/auth.ts arm? Straight off the syntax tree.
    const armedBy = new Map<string, string>();
    for (const s of scanBackendSrc().sites) {
        if (s.helper !== LOCK_ARMER || s.file !== 'routes/auth.ts' || !s.purpose) continue;
        armedBy.set(s.door, s.purpose);
    }

    const doors: Array<{ name: string; prepare: () => Promise<any>; body: (p: any) => any }> = [
        {
            name: '/auth/mfa/enable',
            prepare: async () => { await mfa.disable(OWNER_ID); return (await mfa.beginEnroll(OWNER_ID, `${OWNER}@example.com`)).secret; },
            body: (secret: string) => ({ code: totp.totp(secret), currentPassword: PASSWORD }),
        },
        {
            name: '/auth/mfa/backup-codes',
            prepare: async () => {
                await mfa.disable(OWNER_ID);
                const { secret } = await mfa.beginEnroll(OWNER_ID, `${OWNER}@example.com`);
                assert.ok((await mfa.completeEnroll(OWNER_ID, totp.totp(secret))).ok, 'enrolment must succeed');
                return secret;
            },
            body: (secret: string) => ({ code: totp.totp(secret) }),
        },
        {
            name: '/auth/mfa/disable',
            prepare: async () => {
                await mfa.disable(OWNER_ID);
                const { secret } = await mfa.beginEnroll(OWNER_ID, `${OWNER}@example.com`);
                assert.ok((await mfa.completeEnroll(OWNER_ID, totp.totp(secret))).ok, 'enrolment must succeed');
                return secret;
            },
            body: (secret: string) => ({ code: totp.totp(secret) }),
        },
    ];

    // BIJECTION with the derived set: every post-authentication MFA door in routes/auth.ts that records a
    // failure has a row here, and no row names a door that no longer does. POST /auth/mfa and POST
    // /auth/login are excluded by construction — they are the two PRE-authentication doors that keep a lock
    // on purpose, and they are covered by the end-to-end proof below instead.
    const derived = [...armedBy.keys()]
        .filter((d) => /POST \/mfa\//.test(d))
        .map((d) => `/auth${d.replace('routes/auth.ts POST ', '')}`).sort();
    assert.deepStrictEqual(doors.map((d) => d.name).sort(), derived,
        'the rows below and the doors that actually record an MFA failure are not the same set');

    for (const door of doors) {
        const purpose = armedBy.get(`routes/auth.ts POST ${door.name.replace('/auth', '')}`) as string;
        assert.ok(purpose, `${door.name}: no armed purpose derived — the walk stopped seeing this door`);
        const key = auth.lockBucket(purpose, OWNER_ID);
        const secret = await door.prepare();
        // Arm the door's OWN bucket past the old lockout threshold, immediately before it is tried. One
        // arming per door, because a door that succeeds calls clearLoginFails and a shared arming step
        // would silently disarm every door after the first.
        for (let i = 0; i < 12; i++) await auth.recordLoginFail(key);
        const r = await request(app).post(`${B}${door.name}`).set('Authorization', session).send(door.body(secret));
        assert.notStrictEqual(r.body && r.body.code, 'rest_account_locked',
            `${door.name} refused the owner because of a failure count — that is the hostage this class removes`);
        assert.strictEqual(r.status, 200,
            `${door.name} refused a CORRECT credential with a full bucket: ${r.status} ${JSON.stringify(r.body)}`);
        await auth.clearLoginFails(key);
    }

    // NEGATIVE CONTROL, so "answer 200 to everything" cannot pass the loop above: a WRONG code is still
    // refused on its merits — 400 rest_mfa_invalid, never 429 rest_account_locked.
    const secret = await doors[2].prepare();
    const disableKey = auth.lockBucket(armedBy.get('routes/auth.ts POST /mfa/disable') as string, OWNER_ID);
    for (let i = 0; i < 12; i++) await auth.recordLoginFail(disableKey);
    const bad = await request(app).post(`${B}/auth/mfa/disable`).set('Authorization', session).send({ code: '000000' });
    assert.strictEqual(bad.status, 400, `a wrong code must be answered on its merits, got ${bad.status}`);
    assert.strictEqual(bad.body.code, 'rest_mfa_invalid');

    await mfa.disable(OWNER_ID);
    await auth.clearLoginFails(disableKey);
    void secret;
});

/**
 * THE ROUND-4 CRITICAL, END TO END AND THROUGH THE REAL ROUTER.
 *
 * Nothing above would have caught it, because every gate asked whether the door UNDER REVIEW still answers
 * its own caller. The defect was in the other direction: /auth/mfa/disable — `authenticate` + `sessionOnly`,
 * no sudo password, so the cheapest door in the file to reach with a hijacked session — armed the bucket
 * that POST /auth/mfa reads. Twelve wrong codes there and the OWNER, with the right password and the right
 * TOTP, was answered 429 at the second factor of the interactive login: renewably (the counter re-arms on
 * every failure inside the window, at 40 requests/hour — under the per-IP cap), and with no way out (backup
 * codes are verified INSIDE verifyLoginCode, after the lock; reset-password clears no mfa_* key).
 *
 * So this drives the attack and then the victim, both through supertest.
 */
test('twelve wrong codes at /auth/mfa/disable do NOT lock the owner out of the interactive second factor', async () => {
    const auth = require('../routes/auth');
    const mfa = require('../core/mfa');
    const totp = require('../core/totp');
    const jwt = require('jsonwebtoken');
    const session = `Bearer ${jwt.sign({ userId: OWNER_ID, username: OWNER }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;

    await mfa.disable(OWNER_ID);
    const { secret } = await mfa.beginEnroll(OWNER_ID, `${OWNER}@example.com`);
    assert.ok((await mfa.completeEnroll(OWNER_ID, totp.totp(secret))).ok, 'enrolment must succeed');
    await auth.clearLoginFails(auth.lockBucket('mfa', OWNER_ID));
    await auth.clearLoginFails(auth.lockBucket('mfa_manage', OWNER_ID));
    await auth.clearLoginFails(auth.lockBucket('login', OWNER));

    // THE ATTACK, exactly as reproduced in round 4: a hijacked session, one address, no password.
    for (let i = 0; i < 12; i++) {
        const r = await request(app).post(`${B}/auth/mfa/disable`).set('Authorization', session).send({ code: '000000' });
        assert.strictEqual(r.status, 400, `the attacker's wrong code must be a 400 on the merits, got ${r.status}`);
    }
    assert.ok(await mfa.isEnabled(OWNER_ID), 'precondition: the attack must not have actually disabled MFA');

    // THE VICTIM. Correct password, correct TOTP, and the answer must be the session — not a lockout.
    const login = await request(app).post(`${B}/auth/login`).send({ username: OWNER, password: PASSWORD });
    assert.strictEqual(login.status, 200, `the owner's password must still be accepted: ${JSON.stringify(login.body)}`);
    assert.ok(login.body.mfaRequired && login.body.mfaToken, `expected an MFA challenge, got ${JSON.stringify(login.body)}`);

    const second = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: login.body.mfaToken, code: totp.totp(secret) });
    assert.notStrictEqual(second.body && second.body.code, 'rest_account_locked',
        'the owner was locked out of their own second factor by failures recorded at ANOTHER door — the hostage');
    assert.strictEqual(second.status, 200, `the owner's CORRECT second factor was refused: ${second.status} ${JSON.stringify(second.body)}`);

    // …and the control that proves the second factor is still a real lock for the door that DOES own it:
    // twelve wrong codes AT /auth/mfa itself must still stop the twelfth attacker.
    for (let i = 0; i < 12; i++) {
        const l = await request(app).post(`${B}/auth/login`).send({ username: OWNER, password: PASSWORD });
        await request(app).post(`${B}/auth/mfa`).send({ mfaToken: l.body.mfaToken, code: '000000' });
    }
    const l2 = await request(app).post(`${B}/auth/login`).send({ username: OWNER, password: PASSWORD });
    const locked = await request(app).post(`${B}/auth/mfa`).send({ mfaToken: l2.body.mfaToken, code: totp.totp(secret) });
    assert.strictEqual(locked.status, 429,
        'the mfa lock must still fire for the door that arms it, or this test proved only that the lock is gone');
    assert.strictEqual(locked.body.code, 'rest_account_locked');

    await mfa.disable(OWNER_ID);
    await auth.clearLoginFails(auth.lockBucket('mfa', OWNER_ID));
    await auth.clearLoginFails(auth.lockBucket('login', OWNER));
});

/**
 * A DELAY THAT DOES NOT HOLD ITS SLOT IS NOT A THROTTLE.
 *
 * routes/users.ts:634 states the rule — "Pay the cost BEFORE the check and INSIDE the slot: outside it, a
 * burst would sleep in parallel and the delay would bound latency instead of throughput" — and the first
 * copy of it in routes/auth.ts inverted the order on all three doors: `await payFailureDelay(lk)` and only
 * THEN `beginLoginAttempt`. Round 4 measured 24 concurrent guesses resolving in 8.1 s against a ladder
 * that should have cost 64 s, with all 24 EVALUATED. The wait cost the attacker nothing.
 *
 * Wall-clock is the wrong thing to assert (it makes the gate a flake on a loaded machine). The property
 * that actually distinguishes the two orderings is HOW MANY GUESSES GET EVALUATED while the ladder is
 * being paid: with the slot taken first, at most MAX_LOGIN_INFLIGHT can be asleep inside it and everyone
 * else is refused a slot immediately; with the wait outside, the whole burst sleeps together and then all
 * of it is evaluated. Both numbers are derived from routes/auth.ts.
 */
test('the escalating wait bounds THROUGHPUT, not just latency: a burst cannot all be evaluated', async () => {
    const auth = require('../routes/auth');
    const mfa = require('../core/mfa');
    const totp = require('../core/totp');
    const jwt = require('jsonwebtoken');
    const session = `Bearer ${jwt.sign({ userId: OWNER_ID, username: OWNER }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' })}`;
    const cap = Number(auth.MAX_LOGIN_INFLIGHT);
    assert.ok(cap > 0, 'routes/auth.ts must export the in-flight cap this gate is stated over');

    await mfa.disable(OWNER_ID);
    const { secret } = await mfa.beginEnroll(OWNER_ID, `${OWNER}@example.com`);
    assert.ok((await mfa.completeEnroll(OWNER_ID, totp.totp(secret))).ok, 'enrolment must succeed');

    // Put the ladder somewhere small but non-zero: enough that a guess must WAIT, little enough that the
    // test is quick. The exact rung does not matter — only that a wait is owed.
    const key = auth.lockBucket('mfa_manage', OWNER_ID);
    await auth.clearLoginFails(key);
    for (let i = 0; i < 7; i++) await auth.recordLoginFail(key);
    const owed = require('../routes/users').sudoDelayMs(await auth.loginFailCount(key));
    assert.ok(owed > 0, `the ladder owes nothing at this rung (${owed}ms) — the gate would prove nothing`);

    const BURST = 12;
    assert.ok(BURST > cap, 'the burst must exceed the in-flight cap or there is nothing to bound');
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: BURST }, () =>
        request(app).post(`${B}/auth/mfa/disable`).set('Authorization', session).send({ code: '000000' })
            .then((r: any) => r.body && r.body.code)));
    const elapsed = Date.now() - started;

    const evaluated = results.filter((c) => c === 'rest_mfa_invalid').length;
    const refusedSlot = results.filter((c) => c === 'rest_login_throttled').length;
    assert.ok(evaluated <= cap,
        `${evaluated} of ${BURST} simultaneous guesses were EVALUATED against a ladder owing ${owed}ms each `
        + `(cap ${cap}, elapsed ${elapsed}ms). They slept in parallel, which means the wait is being paid `
        + 'OUTSIDE the in-flight slot and bounds latency instead of throughput — see payFailureDelay.');
    assert.strictEqual(evaluated + refusedSlot, BURST,
        `unexpected answers in the burst: ${JSON.stringify(results)}`);
    // …and the honest other half: the ones that DID get a slot really waited, so the ladder is not simply
    // being skipped (which would also satisfy the bound above).
    assert.ok(elapsed >= owed, `the burst finished in ${elapsed}ms without paying the ${owed}ms it owed`);

    await mfa.disable(OWNER_ID);
    await auth.clearLoginFails(key);
});

/**
 * THE SAME HOSTAGE SHAPE, ON THE ONE DOOR THAT MUST NEVER JAM.
 *
 * POST /setup/migrate authenticates raw credentials from an ANONYMOUS body, and it used to read
 * `isLoginLocked` BEFORE authenticating and 429 on it. Ten wrong passwords against {username:'admin'}
 * therefore answered the real administrator — holding the CORRECT password — with the attacker's own 429,
 * and `clearLoginFails` only runs after a successful admin authentication, which the lock itself prevents.
 * This is the WORST door in the codebase to jam: during a domain move the Installation/Migration Guard
 * 409s every non-/setup route, /auth/login included, so /setup/migrate is the only way to repair siteUrl.
 * The site is down and its escape hatch says "too many attempts".
 *
 * The bucket is armed through the ROUTE first (producer proof), so this is not a fixture arguing with a
 * constant it invented; after that the same proven key is armed directly, because paying the real ladder
 * twelve times over is time this gate does not need to spend to state its property.
 */
test('an anonymous flood at /setup/migrate cannot make the rescue door refuse a credential', async () => {
    const auth = require('../routes/auth');
    const key = auth.lockBucket('migrate', await auth.resolveLockIdentifier(OWNER));
    await auth.clearLoginFails(key);

    // PRODUCER PROOF: one real anonymous request, and the bucket it writes is the one armed below.
    const first = await request(app).post(`${B}/setup/migrate`).send({ username: OWNER, password: 'wrong' });
    assert.strictEqual(first.status, 401, `the uniform refusal must be 401, got ${first.status} ${JSON.stringify(first.body)}`);
    assert.strictEqual(await auth.loginFailCount(key), 1,
        'the route must be shown to write the bucket this test then arms — otherwise the rest proves nothing');

    // Arm well past the OLD lockout threshold (10).
    for (let i = 0; i < 12; i++) await auth.recordLoginFail(key);
    assert.ok(await auth.loginFailCount(key) >= 12, 'precondition: the bucket really is full');

    // CONTROL, so "nothing locks any more" cannot pass this test: the same twelve failures on a LOCKING
    // purpose do arm a lock. The migrate bucket is unlocked because its purpose is count-only, not because
    // the store stopped working.
    const control = auth.lockBucket('login', `${OWNER}-migrate-control`);
    for (let i = 0; i < 12; i++) await auth.recordLoginFail(control);
    assert.strictEqual(await auth.isLoginLocked(control), true, 'the control bucket must really be armed');
    assert.strictEqual(await auth.isLoginLocked(key), false,
        'the migrate bucket armed a LOCK. It is a count-only purpose: its failures must buy a wait, not a refusal');

    // …and the door itself answers on the merits, never with a lockout.
    const after = await request(app).post(`${B}/setup/migrate`).send({ username: OWNER, password: PASSWORD });
    assert.notStrictEqual(after.status, 429,
        `the rescue door refused a credential because of a failure count: ${after.status} ${JSON.stringify(after.body)}`);
    assert.strictEqual(after.status, 401,
        `expected the uniform 401 (this account is not an administrator), got ${after.status} ${JSON.stringify(after.body)}`);

    await auth.clearLoginFails(key);
    await auth.clearLoginFails(control);
});

