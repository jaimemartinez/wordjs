/**
 * WordJS — the fs guard, stated as CLASSES rather than as the paths/methods someone remembered.
 *
 * Round 2 of the adversarial review found three defects in the previous wave's io-guard work, and all
 * three are the same shape: a rule written about ONE MEMBER of a set instead of about the set.
 *
 *   · SERVED SURFACE — "a plugin may not write under a served root" was enforced over the BACKEND's
 *     mounts only, and the monolith-mode carve-out was written as an EXTENSION ('*.log' anywhere under
 *     frontend/.next) instead of as the SUBTREE its own comment justifies (.next/dev/logs). Next serves
 *     .next/static at /_next/static, so a zero-permission plugin could write /_next/static/leak.log and
 *     have the server hand it to an anonymous GET.
 *   · ONE ACCOUNTING PER WRITE — after fs.promises was patched in io-guard, secure-require's plugin proxy
 *     kept metering too, so every plugin fs.promises write was charged TWICE against the disk quota (a
 *     plugin hit EDQUOT at half its real budget).
 *   · ONE RESOLUTION PER OPERATION — the wrappers resolved the effective plugin twice per call, and with
 *     an empty ALS context (i.e. ALL host code, including Next.js in monolith mode) each resolution is a
 *     stack walk with a realpath per candidate frame.
 *
 * So every test below ITERATES a table — every served root × every extension, every metered method, every
 * fs API surface — instead of pinning the one example from the report. A new mount, a new metered method
 * or a new patched API is covered by adding a row, or it fails here.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const io = require('../core/io-guard');            // installs the fs patches (context-gated)
const { installSecureRequire, secureFs } = require('../core/secure-require');
const { runWithContext } = require('../core/plugin-context');

installSecureRequire();

const ROOT_DIR = path.resolve(__dirname, '../../');          // backend/
const REPO_DIR = path.resolve(ROOT_DIR, '..');               // repo root
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const SLUG = `fsclass-test-${process.pid}`;
const dir = path.join(PLUGINS_DIR, SLUG);
const NEXT_DIR = path.resolve(ROOT_DIR, '../frontend/.next');

// A plugin writing inside its OWN dir needs no grant — that is exactly the situation the audit is
// about (io-guard leaves it writable, and only the disk quota bounds it), so each case gets a real
// plugin directory with an empty manifest.
const madeDirs: string[] = [];
function pluginDirFor(slug: string): string {
    const d = path.join(PLUGINS_DIR, slug);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: slug, permissions: [] }));
    madeDirs.push(d);
    return d;
}
before(() => { pluginDirFor(SLUG); });
after(() => {
    for (const d of madeDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

// ── 1. THE SERVED SURFACE, over the whole SET of roots and the whole SET of file kinds ─────────────
//
// The bug was not "*.log was allowed": it was that a WRITE ZONE was carved out by file EXTENSION while
// the DENIAL was stated over a set of roots that did not include the frontend's. Both halves are
// asserted as products of tables, so neither can be closed for one member and left open for its twin.
test('no plugin write is allowed under ANY served root, whatever the file extension', () => {
    const EXTENSIONS = ['.log', '.txt', '.css', '.json', '.map', '.bin', '', '.LOG'];
    runWithContext(SLUG, () => {
        for (const root of io.SERVED_ROOTS) {
            for (const ext of EXTENSIONS) {
                const target = path.join(root, '__leak__', `stolen${ext}`);
                assert.strictEqual(io.isPathSafe(target, true), false,
                    `a plugin must not write ${target} — ${root} is a published root`);
            }
        }
    });
});

// ── 1b. IS EVERY PUBLISHED ROOT ACTUALLY *DECLARED*? — DERIVED, NOT LISTED ─────────────────────────
//
// ROUND-3 FINDING (verify3 #28): the product above genuinely iterates (it walks io.SERVED_ROOTS live,
// so a new root is covered without writing an assertion), and the BACKEND half of "is everything
// declared?" is genuinely derived in backend/src/tests/install-root-paths.test.ts, which parses
// index.ts's syntax tree and fails on any mount it cannot resolve. But the FRONTEND half was six paths
// written out by hand, and the file's own comment admitted it. Nothing read frontend/next.config.ts, so
// moving the build output — `distDir`, or a standalone build — reopens the /_next/static hole exactly
// as before, with the suite green. That is the same defect the .next carve-out was, one level up.
//
// So the frontend side is derived from the frontend's OWN configuration below. What Next serves off the
// filesystem verbatim is exactly two trees, and both are computed here:
//   · `<distDir>/static`  → /_next/static
//   · `public/`           → the site root
// A custom server could add a third; frontend/server.js is scanned for one rather than assumed absent.
const FRONTEND_DIR = path.resolve(ROOT_DIR, '../frontend');
const NEXT_CONFIG = path.join(FRONTEND_DIR, 'next.config.ts');
const FRONTEND_SERVER = path.join(FRONTEND_DIR, 'server.js');

/** The filesystem trees Next publishes, read out of the frontend's own config. Pure, so it is testable. */
function nextPublishedRoots(nextConfigSrc: string, frontendDir: string): string[] {
    const code = String(nextConfigSrc)
        .replace(/\/\*[\s\S]*?\*\//g, '\n')
        .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
    let distDir = '.next';                                    // Next's default
    if (/\bdistDir\s*:/.test(code)) {
        const m = code.match(/\bdistDir\s*:\s*['"`]([^'"`]*)['"`]/);
        assert.ok(m, 'frontend/next.config.ts sets distDir in a form this gate cannot read — teach it, do not delete it');
        assert.ok(!m![1].includes('${'),
            `distDir is computed (${m![1]}): this gate cannot know which tree ships, so SERVED_ROOTS cannot be checked`);
        distDir = m![1];
    }
    const roots = [path.resolve(frontendDir, distDir, 'static')];
    if (fs.existsSync(path.join(frontendDir, 'public'))) roots.push(path.resolve(frontendDir, 'public'));
    return roots;
}

/** Every root that must appear in SERVED_ROOTS, or the write gate leaves a published tree writable. */
function assertDeclared(roots: string[]): void {
    const declared = io.SERVED_ROOTS.map((p: string) => path.resolve(p));
    for (const expected of roots) {
        assert.ok(declared.includes(expected),
            `${expected} is published on the site origin but is not declared in core/io-guard SERVED_ROOTS — ` +
            'a zero-permission plugin may write there and the server will hand the file to an anonymous GET');
    }
}

test('SERVED_ROOTS declares every tree the FRONTEND publishes (derived from next.config.ts)', () => {
    assertDeclared(nextPublishedRoots(fs.readFileSync(NEXT_CONFIG, 'utf8'), FRONTEND_DIR));

    // The third way a tree gets published: a custom server mounting its own static handler. There is
    // none today; if one appears, this fails and whoever added it must declare the root.
    const serverSrc = fs.readFileSync(FRONTEND_SERVER, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '\n')
        .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n');
    for (const shape of [/express\.static\s*\(/, /\bsendFile\s*\(/, /serve-static/]) {
        assert.ok(!shape.test(serverSrc),
            `frontend/server.js publishes a tree of its own (${shape}) — derive its root and declare it in SERVED_ROOTS`);
    }
});

test('SERVED_ROOTS declares every tree the BACKEND publishes', () => {
    // The DERIVATION for this half lives in backend/src/tests/install-root-paths.test.ts: it walks the
    // syntax tree of index.ts, resolves every express.static argument and every res.sendFile root, and
    // fails on one core/io-guard does not recognise. These four are restated here as the floor, so this
    // file still fails if the declaration is emptied.
    assertDeclared([
        path.join(ROOT_DIR, 'uploads'), path.join(ROOT_DIR, 'themes'),
        path.join(ROOT_DIR, 'plugins'), path.join(ROOT_DIR, 'public'),
    ]);
});

test('THE GATE IS FALSIFIABLE: moving the build output turns the frontend check red', () => {
    // A GATE IS ONLY REAL IF ADDING A MEMBER TURNS IT RED. The member here is a published tree that is
    // not declared — which is precisely how /_next/static became writable in the first place. The
    // control (the REAL config) must pass, or the assertions below would be failing for another reason.
    assert.doesNotThrow(() => assertDeclared(nextPublishedRoots(fs.readFileSync(NEXT_CONFIG, 'utf8'), FRONTEND_DIR)));

    for (const [label, cfg] of [
        ['a renamed build directory', "const nextConfig = { distDir: '.build' };"],
        ['a standalone output tree', "const nextConfig = { distDir: 'out/.next' };"],
        ['a double-quoted spelling', 'const nextConfig = { distDir: ".dist" };'],
    ] as Array<[string, string]>) {
        assert.throws(
            () => assertDeclared(nextPublishedRoots(cfg, FRONTEND_DIR)),
            (e: any) => e instanceof assert.AssertionError,
            `MUTATION SURVIVED — ${label} moved /_next/static and SERVED_ROOTS was not asked about it`);
    }
    // …and a distDir this gate cannot evaluate must fail LOUDLY rather than fall back to the default,
    // which would silently re-create the hand-written list under a different name.
    assert.throws(() => nextPublishedRoots('const c = { distDir: `${base}/out` };', FRONTEND_DIR),
        (e: any) => e instanceof assert.AssertionError);
    assert.throws(() => nextPublishedRoots('const c = { distDir: resolveDir() };', FRONTEND_DIR),
        (e: any) => e instanceof assert.AssertionError);
});

test('the Next dev-log carve-out is the SUBTREE it justifies, not an extension over the build tree', () => {
    runWithContext(SLUG, () => {
        // The journey the carve-out exists for keeps working: Next's dev log flusher can inherit a
        // plugin's ALS context, and denying its write only floods the console with EACCES.
        assert.strictEqual(io.isPathSafe(path.join(NEXT_DIR, 'dev', 'logs', 'next.log'), true), true,
            "Next's own dev log must stay writable — this carve-out is the reason it exists");
        // …and nothing else under the build tree is writable, by extension or otherwise.
        for (const rel of [
            ['static', 'leak.log'],
            ['static', 'chunks', 'x.log'],
            ['static', 'media', 'a.log'],
            ['server', 'app', 'x.log'],
            ['cache', 'x.log'],
            ['dev', 'logs', 'nested', 'deep', 'x.log'].slice(0, 3).concat(['..', '..', 'static', 'y.log']),
        ]) {
            const target = path.join(NEXT_DIR, ...rel);
            assert.strictEqual(io.isPathSafe(target, true), false, `${target} must be write-denied`);
        }
    });
});

// ── 2. THE ROOTS ARE ONE VALUE, NOT TWO SPELLINGS OF A DIRECTORY NAME ──────────────────────────────
//
// io-guard anchors on the INSTALLATION (__dirname) while index.ts mounts its static handlers on
// CWD-relative paths. They coincide only because the npm scripts happen to start in backend/. Under any
// other cwd the served tree index.ts publishes would not be recognised here — fail-OPEN for writing. The
// guard therefore treats both anchors as published; the check runs in a CHILD process because the cwd is
// process-global state.
test('a different working directory cannot produce a served tree the write gate does not know', () => {
    const script = `
        process.chdir(${JSON.stringify(REPO_DIR)});
        const path = require('path');
        const io = require(${JSON.stringify(path.join(ROOT_DIR, 'src/core/io-guard.ts').replace(/\\/g, '/'))});
        const out = {};
        for (const name of ['uploads', 'themes', 'plugins', 'public']) {
            out[name] = io.servedRootOf(path.join(process.cwd(), name)) !== null;
        }
        console.log('RESULT' + JSON.stringify(out));
    `;
    const stdout = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script],
        { cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env, WORDJS_SKIP_BOOT: '1' } });
    const line = String(stdout).split('\n').find((l: string) => l.startsWith('RESULT'));
    assert.ok(line, `child produced no RESULT line: ${stdout}`);
    const got = JSON.parse(String(line).slice('RESULT'.length));
    for (const [name, recognised] of Object.entries(got)) {
        assert.strictEqual(recognised, true,
            `under a different cwd, ./${name} is mounted by index.ts but servedRootOf() does not see it`);
    }
});

// ── 3. ONE ACCOUNTING PER WRITE, over the TABLE of metered methods ─────────────────────────────────
//
// Measured, not asserted by inspection: charge the rest of the window in ≤SINGLE_WRITE_MAX chunks and
// check the budget lands EXACTLY on the cap. If a write were metered twice (or not at all) the fill
// below either throws early or leaves room — both fail. Every method that produces bytes or inodes gets
// a row; a new metered method must be added here or its accounting is untested.
const QUOTA = 512 * 1024 * 1024;
const CHUNK = 64 * 1024 * 1024;

/** Charge `amount` in legal chunks; returns false as soon as the quota refuses. */
function fill(slug: string, amount: number): boolean {
    try {
        let left = amount;
        while (left > 0) { const n = Math.min(left, CHUNK); io.enforceGrowQuota(slug, n); left -= n; }
        return true;
    } catch { return false; }
}

const METERED: Array<{ name: string; expect: number; setup?: (base: string) => void; run: (fsp: any, base: string) => Promise<any> }> = [
    { name: 'writeFile (floored at one FS block)', expect: 4096, run: (fsp, base) => fsp.writeFile(path.join(base, 'a.txt'), 'x'.repeat(100)) },
    { name: 'writeFile (payload above the floor)', expect: 10000, run: (fsp, base) => fsp.writeFile(path.join(base, 'b.txt'), 'x'.repeat(10000)) },
    { name: 'appendFile', expect: 5000, run: (fsp, base) => fsp.appendFile(path.join(base, 'c.txt'), 'y'.repeat(5000)) },
    {
        name: 'truncate (allocates len)', expect: 7000,
        setup: (base) => fs.writeFileSync(path.join(base, 'd.txt'), ''),      // host-side, OUTSIDE the context
        run: (fsp, base) => fsp.truncate(path.join(base, 'd.txt'), 7000),
    },
    { name: 'mkdir (one dir-entry block)', expect: 4096, run: (fsp, base) => fsp.mkdir(path.join(base, 'sub')) },
    { name: 'mkdir recursive (per new component)', expect: 3 * 4096, run: (fsp, base) => fsp.mkdir(path.join(base, 'r1', 'r2', 'r3'), { recursive: true }) },
    {
        name: 'copyFile (source size)', expect: 2048,
        setup: (base) => fs.writeFileSync(path.join(base, 'src.bin'), Buffer.alloc(2048)),
        run: (fsp, base) => fsp.copyFile(path.join(base, 'src.bin'), path.join(base, 'dst.bin')),
    },
];

for (const m of METERED) {
    test(`fs.promises ${m.name} is charged to the disk quota EXACTLY once`, async () => {
        const slug = `${SLUG}-q-${METERED.indexOf(m)}`;
        const zone = path.join(pluginDirFor(slug), 'zone');
        fs.mkdirSync(zone, { recursive: true });
        // Fixtures are created by the HOST (no plugin context => unmetered), so the only thing charged to
        // this slug's window is the one call under test.
        if (m.setup) m.setup(zone);
        await runWithContext(slug, async () => {
            // The plugin-facing surface: secureFs.promises is what plugin code receives for
            // require('fs').promises / require('fs/promises').
            const fsp = (secureFs as any).promises;
            await m.run(fsp, zone);
        });
        // Exactly `expect` bytes must have been charged: the remainder fits, one more byte does not.
        assert.strictEqual(fill(slug, QUOTA - m.expect), true,
            `${m.name}: more than ${m.expect} bytes were charged — the write is metered twice`);
        assert.strictEqual(fill(slug, 1), false,
            `${m.name}: fewer than ${m.expect} bytes were charged — the write is not metered`);
    });
}

test('the plugin journey still works: it writes, appends and reads inside its own dir with no grant', async () => {
    const slug = `${SLUG}-journey`;
    const zone = path.join(pluginDirFor(slug), 'journey');
    fs.mkdirSync(zone, { recursive: true });
    await runWithContext(slug, async () => {
        const fsp = (secureFs as any).promises;
        await fsp.writeFile(path.join(zone, 'notes.txt'), 'hello');
        await fsp.appendFile(path.join(zone, 'notes.txt'), ' world');
        assert.strictEqual(String(await fsp.readFile(path.join(zone, 'notes.txt'), 'utf8')), 'hello world');
        await fsp.mkdir(path.join(zone, 'cache'), { recursive: true });
        assert.ok(fs.existsSync(path.join(zone, 'cache')));
    });
});

test('an unmeasurable (stream/iterable) fs.promises write is still refused — the meter cannot see it', async () => {
    const slug = `${SLUG}-stream`;
    const sdir = pluginDirFor(slug);
    await runWithContext(slug, async () => {
        const fsp = (secureFs as any).promises;
        await assert.rejects(() => fsp.writeFile(path.join(sdir, 'stream.txt'), (function* () { yield 'a'; })()),
            /streaming\/iterable/i);
    });
});

// ── 4. ONE PLUGIN RESOLUTION PER OPERATION, over every patched fs surface ──────────────────────────
//
// getEffectivePlugin() falls back to a STACK WALK when the ALS context is empty — which is the case for
// 100% of host code, including Next.js sharing the process in monolith mode. Counting the walks is the
// only honest gate: a comment saying "resolved once" is not one. Error.captureStackTrace is called
// exactly once per walk (plugin-context.getPluginFromStack), so wrapping it counts them.
const HOST_OPS: Array<{ name: string; run: (tmp: string) => any }> = [
    { name: 'fs.readFileSync', run: (tmp) => fs.readFileSync(path.join(tmp, 'f.txt'), 'utf8') },
    { name: 'fs.writeFileSync', run: (tmp) => fs.writeFileSync(path.join(tmp, 'w.txt'), 'x') },
    { name: 'fs.appendFileSync', run: (tmp) => fs.appendFileSync(path.join(tmp, 'w.txt'), 'x') },
    { name: 'fs.mkdirSync', run: (tmp) => fs.mkdirSync(path.join(tmp, 'd' + Math.random().toString(36).slice(2))) },
    { name: 'fs.readdirSync', run: (tmp) => fs.readdirSync(tmp) },
    { name: 'fs.copyFileSync', run: (tmp) => fs.copyFileSync(path.join(tmp, 'f.txt'), path.join(tmp, 'f2.txt')) },
    { name: 'fs.openSync', run: (tmp) => { const fd = fs.openSync(path.join(tmp, 'f.txt'), 'r'); fs.closeSync(fd); } },
    { name: 'fs.truncateSync', run: (tmp) => fs.truncateSync(path.join(tmp, 'w.txt'), 1) },
    { name: 'fs.promises.readFile', run: (tmp) => fs.promises.readFile(path.join(tmp, 'f.txt'), 'utf8') },
    { name: 'fs.promises.writeFile', run: (tmp) => fs.promises.writeFile(path.join(tmp, 'p.txt'), 'x') },
    { name: 'fs.promises.appendFile', run: (tmp) => fs.promises.appendFile(path.join(tmp, 'p.txt'), 'x') },
    { name: 'fs.promises.mkdir', run: (tmp) => fs.promises.mkdir(path.join(tmp, 'pd' + Math.random().toString(36).slice(2))) },
    { name: 'fs.promises.readdir', run: (tmp) => fs.promises.readdir(tmp) },
    { name: 'fs.promises.copyFile', run: (tmp) => fs.promises.copyFile(path.join(tmp, 'f.txt'), path.join(tmp, 'f3.txt')) },
];

// The invariant is per GUARD ENTRY, not per user-visible call: Node's own fs.appendFileSync delegates to
// the (also patched) fs.writeFileSync, so one appendFileSync legitimately enters the guard twice. Counting
// BOTH sides states the property without hard-coding which methods Node happens to nest today:
// resolutions <= entries, i.e. at most one plugin resolution per patched wrapper invocation. Before the
// fix every write method and EVERY fs.promises method resolved twice, so a revert fails this loudly.
const PATCHED_SYNC = ['readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'readdirSync',
    'copyFileSync', 'openSync', 'truncateSync', 'renameSync', 'unlinkSync', 'rmSync', 'cpSync'];
const PATCHED_PROMISE = ['readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'copyFile', 'open',
    'truncate', 'rename', 'unlink', 'rm', 'cp'];

test('HOST code pays at most ONE plugin resolution per guarded fs entry (every patched surface)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-hostcost-'));
    fs.writeFileSync(path.join(tmp, 'f.txt'), 'seed');
    const originalCapture = Error.captureStackTrace;
    let entries = 0;
    const restore: Array<() => void> = [];
    const countEntries = (holder: any, name: string) => {
        const fn = holder[name];
        if (typeof fn !== 'function') return;
        holder[name] = function (this: any, ...a: any[]) { entries++; return fn.apply(this, a); };
        restore.push(() => { holder[name] = fn; });
    };
    for (const n of PATCHED_SYNC) countEntries(fs, n);
    for (const n of PATCHED_PROMISE) countEntries(fs.promises, n);
    const results: Array<[string, number, number]> = [];
    try {
        for (const op of HOST_OPS) {
            entries = 0;
            let walks = 0;
            (Error as any).captureStackTrace = function (...a: any[]) { walks++; return (originalCapture as any).apply(Error, a); };
            try { await op.run(tmp); } finally { (Error as any).captureStackTrace = originalCapture; }
            results.push([op.name, entries, walks]);
        }
    } finally {
        (Error as any).captureStackTrace = originalCapture;
        for (const r of restore) r();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
    for (const [name, ent, walks] of results) {
        assert.ok(ent >= 1, name + ': the guard was not entered at all — the patch is missing');
        assert.ok(walks <= ent,
            name + ': ' + walks + ' plugin resolutions for ' + ent + ' guarded entries — the host pays a stack walk it does not need');
    }
});

test('…and the host fast path did not disable the guard: a plugin is still confined', () => {
    runWithContext(SLUG, () => {
        assert.strictEqual(io.isPathSafe(path.join(ROOT_DIR, 'wordjs-config.json'), false), false);
        assert.strictEqual(io.isPathSafe(path.join(ROOT_DIR, 'public', 'leak.txt'), true), false);
        assert.strictEqual(io.isPathSafe(path.join(dir, 'data', 'ok.json'), true), true);
    });
    // Host code (no context) is untouched, which is the whole point of the early return.
    assert.strictEqual(io.isPathSafe(path.join(ROOT_DIR, 'wordjs-config.json'), false), true);
});
