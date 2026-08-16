/**
 * Path injection — the theme compiler, the theme installer/packer, and the certificate manager.
 *
 * WHAT THESE TESTS ARE FOR. Ten CodeQL js/path-injection findings pointed at four files. They are
 * not ten bugs; they are one shape, the one this project's own incident notes name: "the code
 * sanitizes VALUES and does not validate what chooses STRUCTURE — and never infer safety from the
 * ABSENCE of a token". Concretely, the shapes that were actually reachable:
 *
 *   1. cert-manager.finishDNSChallenge(step1Data) — `step1Data` IS the body of
 *      POST /api/v1/certs/dns-finish, round-tripped through the browser, and `step1Data.domain`
 *      chose a directory that is mkdir'd recursively and then written with the ACCOUNT'S PRIVATE
 *      KEY. Nothing validated it, anywhere, on any of the three cert flows.
 *   2. theme-compile.compileTheme(dirOrSlug, { slug }) — the guard tested `opts.slug || …` while
 *      the path was built from `dirOrSlug`. Two different strings: whenever a caller passed an
 *      explicit slug (routes/themes.ts does, on every POST and PUT), the check validated a value
 *      that had nothing to do with the directory being read and written.
 *   3. routes POST /themes/upload — the multipart FILENAME picked the directory the "already
 *      exists" probe ran against, while extraction is driven by the zip's entries. The guard was
 *      not looking at the write it was supposed to protect, so a zip whose filename and root folder
 *      disagreed sailed past it and overwrote an installed theme (extractAllTo overwrite=true).
 *   4. themes.createThemeZip(slug) — the route validated the slug with a BOOLEAN guard and then
 *      passed the RAW param on; the callee re-joined it into `os-tmp/<slug>.zip` having checked
 *      nothing. Not reachable today (scanThemes must already know the slug), but it is the same
 *      "my caller validated this" hole the theme routes were fixed for once already.
 *
 * Every test below drives the REAL producer and asserts on the FILESYSTEM (or on the resolved value
 * that is returned), not on a message. Each was run against the pre-fix code: the escape sections
 * go red there and green here, and the "must still work" sections are green in both.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// backend/ — __dirname is src/tests, so ../.. is the backend root from src AND from dist.
const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const LIVE_DIR = path.join(BACKEND_ROOT, 'ssl', 'live');

const {
    isCertHostname,
    resolveCertDir,
    isPlainSegment,
} = require('../core/safe-path');

/**
 * Escape SHAPES, not "strings with dots in them". Each one is a different way for a name to stop
 * naming a child of the directory it was joined to: parent traversal, an absolute path on either
 * platform, a Win32 drive-relative prefix, a UNC root, an embedded separator, a NUL that truncates
 * the string a C API sees, and the two names that mean "somewhere else".
 */
const ESCAPE_SHAPES: Array<[string, string]> = [
    ['parent traversal', '..'],
    ['nested traversal', '../..'],
    ['traversal with a child', '../evil'],
    ['backslash traversal', '..\\evil'],
    ['posix absolute', '/etc/wordjs'],
    ['win32 absolute', 'C:\\Windows\\Temp'],
    ['win32 drive-relative', 'C:evil'],
    ['UNC root', '\\\\server\\share'],
    ['embedded separator', 'a/b'],
    ['embedded backslash', 'a\\b'],
    ['NUL truncation', 'evil\u0000.example.com'],
    ['single dot', '.'],
    ['NTFS alternate data stream', 'evil:stream'],
    ['empty', ''],
];

// ───────────────────────────────────────────────────────── A. the certificate hostname facade

describe('safe-path.resolveCertDir (certificate storage directories)', () => {
    it('accepts the DNS names an ACME order can legitimately identify', () => {
        for (const host of ['example.com', 'www.example.com', 'a.b.c.example.co.uk', 'xn--80ak6aa92e.com', 'my-site1.example', 'localhost', '*.example.com']) {
            assert.ok(isCertHostname(host), `${host} must be accepted — refusing it would break issuance`);
            const dir = resolveCertDir(LIVE_DIR, host);
            assert.ok(dir !== null, `${host} must resolve`);
            assert.ok(dir.startsWith(LIVE_DIR + path.sep), `${host} must resolve INSIDE ssl/live (got ${dir})`);
        }
    });

    it('fails closed on every escape shape', () => {
        for (const [label, value] of ESCAPE_SHAPES) {
            assert.strictEqual(isCertHostname(value), false, `${label} (${JSON.stringify(value)}) must not pass the hostname form`);
            assert.strictEqual(resolveCertDir(LIVE_DIR, value), null, `${label} (${JSON.stringify(value)}) must not resolve to a directory`);
        }
    });

    it('fails closed on non-strings, over-long names and malformed labels', () => {
        for (const value of [null, undefined, 42, {}, [], ['example.com'], { toString: () => 'example.com' }]) {
            assert.strictEqual(resolveCertDir(LIVE_DIR, value), null, `${JSON.stringify(value)} is not a hostname`);
        }
        assert.strictEqual(isCertHostname('a'.repeat(254)), false, 'over the 253-char presentation limit');
        for (const bad of ['-leading.example.com', 'trailing-.example.com', 'double..dot.com', '.leading.dot', 'trailing.dot.', 'a'.repeat(64) + '.com', '*example.com', '*.*.example.com', 'exa mple.com']) {
            assert.strictEqual(isCertHostname(bad), false, `${bad} is not a DNS name`);
        }
    });

    it('the label check is linear on a pathological input (no catastrophic backtracking)', () => {
        // 40k of the character class that could backtrack, with a trailing char that cannot match.
        const evil = `${'a-'.repeat(20000)}!`;
        const t0 = Date.now();
        assert.strictEqual(isCertHostname(evil), false);
        assert.ok(Date.now() - t0 < 1000, 'hostname validation must not blow up on a hostile string');
    });
});

// ───────────────────────────────────────────────────── B. cert-manager: the write that follows

describe('cert-manager stores certificates only under ssl/live', () => {
    const certManager = require('../core/cert-manager');
    const CANARY = path.join(BACKEND_ROOT, 'wordjs-path-injection-canary');

    /** A client stub that issues instantly — the I/O boundary, nothing else. */
    const stubClient = () => ({
        verifyChallenge: async () => { /* advisory */ },
        completeChallenge: async () => { /* ok */ },
        waitForValidStatus: async () => { /* ok */ },
        getOrder: async ({ url }: any) => ({ url, finalize: `${url}/finalize` }),
        finalizeOrder: async () => ({ url: 'https://ca.example/order/1' }),
        getCertificate: async () => '-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n',
        createOrder: async () => ({ url: 'https://ca.example/order/1' }),
        getAuthorizations: async () => ([{ url: 'https://ca.example/authz/1', challenges: [{ type: 'dns-01', url: 'https://ca.example/chal/1', token: 't' }] }]),
        getChallengeKeyAuthorization: async () => 'txt-value',
    });

    let origInit: any, origClient: any, origUpdate: any, origPush: any;
    before(() => {
        origInit = certManager.initClient;
        origClient = certManager.client;
        origUpdate = certManager.updateSSLConfig;
        origPush = certManager.pushCertToGateway;
        certManager.initClient = async () => { /* no network */ };
        certManager.updateSSLConfig = async () => { /* no config writes */ };
        certManager.pushCertToGateway = async () => { /* no gateway */ };
        certManager.client = stubClient();
    });
    after(() => {
        certManager.initClient = origInit;
        certManager.client = origClient;
        certManager.updateSSLConfig = origUpdate;
        certManager.pushCertToGateway = origPush;
        fs.rmSync(CANARY, { recursive: true, force: true });
        fs.rmSync(path.join(BACKEND_ROOT, 'ssl', 'live', 'unit-test-contained.invalid'), { recursive: true, force: true });
    });

    /**
     * The payload of this class of bug: `domain` chooses the DIRECTORY, and privkey.pem lands in it.
     * `wordjs-path-injection-canary` sits OUTSIDE ssl/live, one level up from it — reachable with a
     * plain `../../wordjs-path-injection-canary`, which is exactly what the browser could post.
     */
    const HOSTILE_DOMAINS = [
        '../../wordjs-path-injection-canary',
        '..\\..\\wordjs-path-injection-canary',
        '../wordjs-path-injection-canary',
        '..',
        '/tmp/wordjs-path-injection-canary',
        'C:\\wordjs-path-injection-canary',
        'evil\u0000.example.com',
        '',
    ];

    it('finishDNSChallenge refuses a domain that is not a DNS name — the request body cannot choose the directory', async () => {
        for (const domain of HOSTILE_DOMAINS) {
            await assert.rejects(
                () => certManager.finishDNSChallenge({
                    domain,
                    authzUrl: 'https://ca.example/authz/1',
                    orderUrl: 'https://ca.example/order/1',
                    challenge: { type: 'dns-01', url: 'https://ca.example/chal/1', token: 't' },
                }, 'a@b.c'),
                /Invalid domain|DNS verification failed/,
                `finishDNSChallenge must refuse ${JSON.stringify(domain)}`
            );
        }
        // The assertion that matters is not the throw, it is the absence of the write.
        assert.strictEqual(fs.existsSync(CANARY), false, 'nothing may be written outside ssl/live');
        assert.strictEqual(fs.existsSync(path.join(BACKEND_ROOT, 'ssl', 'privkey.pem')), false, 'no key one level above ssl/live');
        assert.strictEqual(fs.existsSync(path.join(BACKEND_ROOT, 'ssl', 'fullchain.pem')), false, 'no chain one level above ssl/live');
    });

    it('provisionAutoHTTP and startDNSChallenge refuse the same names, before any CA work', async () => {
        for (const domain of HOSTILE_DOMAINS) {
            await assert.rejects(() => certManager.provisionAutoHTTP(domain, 'a@b.c'), /Invalid domain|Provisioning failed/);
            await assert.rejects(() => certManager.startDNSChallenge(domain, 'a@b.c'), /Invalid domain|DNS challenge start failed/);
        }
        assert.strictEqual(fs.existsSync(CANARY), false, 'nothing may be written outside ssl/live');
    });

    it('an http-01 challenge token from the CA cannot name a file outside the challenge directory', async () => {
        // The token is REMOTE DATA and the ACME endpoint is steerable (the staging flag, and
        // step1Data.directoryUrl straight out of a request body), so a hostile directory could
        // answer with a token that is a path.
        const wwwRoot = path.join(BACKEND_ROOT, 'public');
        for (const token of ['../../wordjs-token-escape', '..\\..\\wordjs-token-escape', '/tmp/wordjs-token-escape', '..', 'a/b', 'tok en', '']) {
            await assert.rejects(() => certManager.writeChallengeFile(token, 'key-auth'), /unusable challenge token/, `token ${JSON.stringify(token)}`);
        }
        assert.strictEqual(fs.existsSync(path.join(BACKEND_ROOT, 'wordjs-token-escape')), false);
        assert.strictEqual(fs.existsSync(path.join(wwwRoot, 'wordjs-token-escape')), false);
        // A real base64url token still writes, in the one place it may.
        const real = 'Xy1_ab2CdEf3gh-IJKlmnop4QRS5tuv6WXYZ789';
        await certManager.writeChallengeFile(real, 'key-auth');
        const written = path.join(wwwRoot, '.well-known', 'acme-challenge', real);
        assert.ok(fs.existsSync(written), 'a legitimate token must still be served');
        fs.rmSync(written, { force: true });
    });

    it('a real domain still issues, and the files land inside ssl/live (the legitimate case)', async () => {
        const domain = 'unit-test-contained.invalid';
        const res = await certManager.finishDNSChallenge({
            domain,
            authzUrl: 'https://ca.example/authz/1',
            orderUrl: 'https://ca.example/order/1',
            challenge: { type: 'dns-01', url: 'https://ca.example/chal/1', token: 't' },
        }, 'a@b.c');
        assert.strictEqual(res.success, true);
        const dir = path.join(LIVE_DIR, domain);
        assert.strictEqual(res.path, dir, 'the reported path is the resolved one');
        assert.ok(fs.existsSync(path.join(dir, 'privkey.pem')), 'privkey.pem written');
        assert.ok(fs.existsSync(path.join(dir, 'fullchain.pem')), 'fullchain.pem written');
        // And the reader agrees with the writer about where that is.
        assert.strictEqual(certManager.readLocalCertValidTo('../../wordjs-path-injection-canary'), null,
            'the reader must fail closed on a name the writer would have refused');
    });
});

// ─────────────────────────────────────────────────────────────── C. the theme compiler

describe('theme-compile: the slug chooses the directory, so the slug is what gets checked', () => {
    const { compileTheme, writeCompiled } = require('../core/theme-compile');

    const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-pathinj-compile-'));
    const THEMES_DIR = path.join(TMP_ROOT, 'themes');
    const MANIFEST_PATH = path.join(TMP_ROOT, 'theme-tokens.json');
    // A theme.json planted OUTSIDE themesDir, one level up. Its token value is the tell: if it ever
    // appears in compiled CSS, the compiler read a directory it was never given.
    const OUTSIDE_MARKER = '#0badc0';

    before(() => {
        fs.mkdirSync(THEMES_DIR, { recursive: true });
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify({
            version: 1,
            source: 'fixture',
            counts: {},
            tokens: { '--wjs-color-primary': { group: 'color', declaredDefault: '#3b82f6', fallbacks: [], consumers: [] } },
            elements: {},
        }));
        // TMP_ROOT/theme.json — the file `path.join(THEMES_DIR, '..')` lands on.
        fs.writeFileSync(path.join(TMP_ROOT, 'theme.json'), JSON.stringify({
            name: 'outside', version: '1.0.0', tokens: { '--wjs-color-primary': OUTSIDE_MARKER },
        }));
        // A legitimate theme, so the "must still work" half of every assertion has something to hit.
        fs.mkdirSync(path.join(THEMES_DIR, 'legit'), { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, 'legit', 'theme.json'), JSON.stringify({
            name: 'Legit', version: '1.0.0', tokens: { '--wjs-color-primary': '#123456' },
        }));
    });
    after(() => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('a slug that is not a slug cannot select a directory — even when opts.slug is valid', () => {
        // THE BUG, exactly: `dirOrSlug` builds the path, `opts.slug` is what the old guard tested.
        // Pre-fix this read TMP_ROOT/theme.json and compiled it; the marker below is how we know.
        //
        // An ABSOLUTE path is excluded from this list on purpose, and only there: it is the second,
        // documented shape of the argument — a directory the CALLER built (routes/themes.ts's
        // mkdtempSync scratch dir). No request value ever reaches it. Everything else — including a
        // relative path with a separator, which used to resolve against the process CWD — is neither
        // a slug nor a caller-owned directory, and is refused rather than interpreted.
        const compilerShapes = ESCAPE_SHAPES.filter(([, v]) => !path.isAbsolute(v));
        for (const [label, dirOrSlug] of compilerShapes) {
            const r = compileTheme(dirOrSlug, { slug: 'legit', themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, dryRun: true });
            assert.ok(
                r.diagnostics.some((d: any) => d.level === 'error' && d.code === 'THEME_SLUG_INVALID'),
                `${label} (${JSON.stringify(dirOrSlug)}) must be refused as a slug`
            );
            assert.strictEqual(r.css, '', `${label} must compile nothing`);
            assert.ok(!r.css.includes(OUTSIDE_MARKER), `${label} must not have read the theme.json outside themesDir`);
        }
    });

    it('the legitimate slug still compiles (the control)', () => {
        const r = compileTheme('legit', { themesDir: THEMES_DIR, manifestPath: MANIFEST_PATH, dryRun: true });
        assert.strictEqual(r.stats.errors, 0, JSON.stringify(r.diagnostics));
        assert.ok(r.css.includes('#123456'), 'the real theme compiled');
    });

    it('writeCompiled refuses a base directory that names nothing instead of writing into the CWD', () => {
        // path.resolve('') is the process CWD: an empty/missing dir used to retarget the write at the
        // project root and drop a style.css there.
        for (const bad of ['', '   ', null, undefined, 'x\u0000y']) {
            assert.throws(() => writeCompiled(bad, '/* x */'), /not a theme directory/, `writeCompiled(${JSON.stringify(bad)})`);
        }
    });

    it('writeCompiled writes style.css INSIDE the directory it was given, and nothing else', () => {
        const dir = path.join(TMP_ROOT, 'writable');
        fs.mkdirSync(dir, { recursive: true });
        writeCompiled(dir, '/* @wjs-generated:start */\n.x{color:red}\n/* @wjs-generated:end */');
        assert.deepStrictEqual(fs.readdirSync(dir), ['style.css'], 'exactly one file, and no leftover tmp');
        assert.ok(fs.readFileSync(path.join(dir, 'style.css'), 'utf8').includes('.x{color:red}'));
    });

    it('compiles a REAL theme from the shipped catalog against the REAL manifest (end to end)', () => {
        const catalog = path.join(BACKEND_ROOT, 'themes');
        const manifest = path.join(BACKEND_ROOT, 'public', 'theme-tokens.json');
        if (!fs.existsSync(manifest) || !fs.existsSync(path.join(catalog, 'default', 'theme.json'))) return; // not a checkout with the catalog
        const r = compileTheme('default', { themesDir: catalog, manifestPath: manifest, dryRun: true });
        assert.strictEqual(r.stats.errors, 0, `the shipped default theme must still compile clean: ${JSON.stringify(r.diagnostics)}`);
        assert.ok(r.css.length > 0, 'and it must produce CSS');
    });
});

// ──────────────────────────────────────────────── D. the installer and the packer (core/themes)

describe('core/themes: installThemeFromDir + createThemeZip', () => {
    const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-pathinj-themes-'));
    const THEMES_DIR = path.join(TMP_ROOT, 'themes');
    let themes: any;
    let SRC: string;

    before(() => {
        fs.mkdirSync(THEMES_DIR, { recursive: true });
        SRC = path.join(TMP_ROOT, 'src-theme');
        fs.mkdirSync(path.join(SRC, 'templates'), { recursive: true });
        fs.writeFileSync(path.join(SRC, 'theme.json'), JSON.stringify({ name: 'Src', version: '1.0.0' }));
        fs.writeFileSync(path.join(SRC, 'style.css'), '/* src */\n');
        fs.writeFileSync(path.join(SRC, 'templates', 'page.json'), '{}');
        themes = require('../core/themes');
    });
    after(() => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

    it('installThemeFromDir refuses every escape shape as a target slug, and writes nothing', () => {
        const before = fs.readdirSync(TMP_ROOT).sort();
        for (const [label, slug] of ESCAPE_SHAPES) {
            assert.throws(
                () => themes.installThemeFromDir(SRC, slug, { themesDir: THEMES_DIR }),
                /Invalid theme slug/,
                `${label} (${JSON.stringify(slug)}) must be refused`
            );
        }
        assert.deepStrictEqual(fs.readdirSync(TMP_ROOT).sort(), before, 'nothing may appear outside themes/');
        assert.deepStrictEqual(fs.readdirSync(THEMES_DIR), [], 'and nothing inside it either');
    });

    it('installThemeFromDir still installs a real theme, subdirectories and all (the control)', () => {
        const out = themes.installThemeFromDir(SRC, 'installed-ok', { themesDir: THEMES_DIR });
        assert.strictEqual(out.slug, 'installed-ok');
        assert.strictEqual(out.files, 3);
        assert.ok(fs.existsSync(path.join(THEMES_DIR, 'installed-ok', 'templates', 'page.json')), 'nested files land nested');
        fs.rmSync(path.join(THEMES_DIR, 'installed-ok'), { recursive: true, force: true });
    });

    it('createThemeZip refuses a slug that is not a slug BEFORE touching the filesystem', async () => {
        // The route's guard returns a boolean and hands the RAW param on; this is the callee's own
        // barrier, so "my caller checked it" is no longer load-bearing.
        for (const [label, slug] of ESCAPE_SHAPES) {
            await assert.rejects(
                () => themes.createThemeZip(slug),
                /Invalid theme slug/,
                `${label} (${JSON.stringify(slug)}) must be refused by createThemeZip itself`
            );
        }
    });
});

// ────────────────────────────────────────────────────────────── E. safe-path segment invariants

describe('safe-path.isPlainSegment covers the shapes the callers depend on', () => {
    it('rejects every escape shape', () => {
        for (const [label, value] of ESCAPE_SHAPES) {
            assert.strictEqual(isPlainSegment(value), false, `${label} (${JSON.stringify(value)})`);
        }
    });
    it('accepts ordinary file and directory names', () => {
        for (const good of ['theme.json', 'style.css', 'templates', 'page-2.json', '_partial', 'a'.repeat(200)]) {
            assert.strictEqual(isPlainSegment(good), true, good);
        }
    });
});
