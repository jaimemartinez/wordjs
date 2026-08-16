/**
 * Plugin install/permission guards — the six CodeQL HIGH findings in the plugin + temp-file surface,
 * each pinned by a test that FAILS on the code as it stood.
 *
 * The findings, and what was actually wrong underneath each one:
 *
 *   1. js/path-injection — routes/plugins.ts. Two separate defects wearing one name.
 *      (a) `validateSlug()` was the anti-pattern this project keeps re-shipping: it resolved a path
 *          into a LOCAL, prefix-tested it WITHOUT a separator, and returned a BOOLEAN — so all ten
 *          handlers went on to re-read and re-concatenate the RAW `req.params.slug`. Its charset
 *          (`^[a-zA-Z0-9_-]+$`) also ACCEPTED `__proto__`, `_x` and `-rf`, which the project's real
 *          slug shape never allowed. Replaced by safeSlugParam(), which returns the value it proved.
 *      (b) `installPluginFromZip` unlinked its `zipPath` argument on thirteen failure paths without
 *          ever establishing what that path was. Now assertZipInOsTmp() proves containment in the
 *          app's own scratch dir first, and every deletion goes through one helper.
 *
 *   2. js/tainted-format-string — a request-derived slug was interpolated into the FIRST argument of
 *      console.warn, which util.format reads as a FORMAT. A slug containing `%s` then ate the error
 *      object that followed it. Fixed by separating format from data, and locked below so no new
 *      call site can reintroduce a template literal as arg 0.
 *
 *   3. js/remote-property-injection — core/plugin-permissions wrote `stored[slug] = clean`. The slug
 *      comes from the URL, so a remote value chose a PROPERTY NAME. `__proto__` is a setter on the
 *      `{}` that getOption returns for an unset option: the assignment silently vanishes and the API
 *      still answers 200 — an egress allowlist that reports success and does not exist is fail-OPEN.
 *      `constructor` / `prototype` are legal slugs and shadow inherited names.
 *
 *   4-6. js/insecure-temporary-file — routes/marketplace (the downloaded plugin zip),
 *      core/plugin-isolate (the seccomp BPF filter — the bytes that ARE the sandbox) and
 *      scripts/verso-drills/drill3. All three wrote a PREDICTABLE name into a world-writable shared
 *      temp dir with a plain writeFileSync, which follows a symlink already sitting at the path and
 *      ignores `mode` for an existing file. All three now take a kernel-exclusive 0700 mkdtemp
 *      directory and create the file with `flag: 'wx'`, with cleanup in a finally.
 *
 * CWD-sandbox ordering copied from safe-path.test.ts: PLUGINS_DIR is `path.resolve('./plugins')`,
 * read at module load, so the chdir has to happen before anything under core/ or routes/ is required.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. Sandbox the process CWD FIRST — routes/plugins.ts resolves PLUGINS_DIR and OS_TMP_DIR at load.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wordjs-plugin-guards-'));
fs.mkdirSync(path.join(TMP_ROOT, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(TMP_ROOT, 'os-tmp'), { recursive: true });
const ORIGINAL_CWD = process.cwd();
process.chdir(TMP_ROOT);

// 2. Repoint the DB at a temp file BEFORE the DB layer loads (nothing here talks to it, but requiring
//    the router pulls the config in and we must not touch the developer's real database).
const config = require('../config/app');
config.dbPath = path.join(TMP_ROOT, 'test.db');
config.dbDriver = 'sqlite-native';

// 3. Stub core/options BEFORE core/plugin-permissions is required, so the grant/egress writes below
//    exercise the real code against an in-memory option store instead of the DB. plugin-permissions
//    require()s options lazily inside each function, so seeding the module cache is enough.
const OPTIONS_PATH = require.resolve('../core/options');
const optionStore = new Map<string, any>();
require.cache[OPTIONS_PATH] = {
    id: OPTIONS_PATH,
    filename: OPTIONS_PATH,
    loaded: true,
    exports: {
        getOption: async (k: string, d: any) => (optionStore.has(k) ? optionStore.get(k) : d),
        // Round-trips through JSON exactly like the real option store, which is what made the
        // __proto__ write disappear without a trace in the first place.
        updateOption: async (k: string, v: any) => { optionStore.set(k, JSON.parse(JSON.stringify(v))); },
        deleteOption: async (k: string) => { optionStore.delete(k); },
    },
} as any;

const perms = require('../core/plugin-permissions');
const pluginRoutes = require('../routes/plugins');
const { safeSlugParam, pluginFile, assertZipInOsTmp, createInstallTmp, isValidSlug, OS_TMP_DIR } = pluginRoutes;

const SRC_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

/**
 * Source with whole-line comments removed. The "must NOT appear" assertions below describe what the CODE
 * does, and every one of these fixes carries a comment that QUOTES the pattern it removed — so a naive
 * scan of the raw text would fail on the very prose explaining the fix.
 */
const codeOnly = (src: string) => src
    .split('\n')
    .map((l: string) => l.replace(/\r$/, ''))
    .filter((l: string) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');

after(() => {
    try { process.chdir(ORIGINAL_CWD); } catch { /* */ }
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* */ }
});

// ───────────────────────────────────────────────── A. the slug → directory guard (js/path-injection)

describe('routes/plugins — safeSlugParam returns the value it validated', () => {
    // Shapes the OLD guard let through. Each of these made validateSlug() return TRUE, after which the
    // handler used the raw parameter anyway. `__proto__` is the one that mattered: it reached
    // setEgressAllowlist and became a prototype write (section C).
    const OLD_GUARD_ACCEPTED: Array<[string, string]> = [
        ['__proto__ (underscores were allowed)', '__proto__'],
        ['leading underscore', '_secret'],
        ['leading dash (option-shaped)', '-rf'],
        ['bare underscore', '_'],
    ];
    for (const [label, slug] of OLD_GUARD_ACCEPTED) {
        it(`rejects ${label}: ${JSON.stringify(slug)}`, () => {
            assert.strictEqual(safeSlugParam(slug), null);
            assert.strictEqual(isValidSlug(slug), false);
        });
    }

    // Structural escapes: strings the filesystem reads as "somewhere else".
    const ESCAPES: Array<[string, unknown]> = [
        ['parent', '..'],
        ['relative traversal', '../evil'],
        ['deep traversal', '../../../etc/passwd'],
        ['traversal that comes back', 'a/../../b'],
        ['dot segment', '.'],
        ['posix absolute', '/etc/passwd'],
        ['windows absolute', 'C:\\Windows\\System32'],
        ['windows drive-relative', 'C:evil'],
        ['nested path', 'plugins/other'],
        ['backslash traversal', '..\\evil'],
        ['NTFS alternate data stream', 'mail-server:evil'],
        ['NUL truncation', 'mail-server\u0000.txt'],
        ['empty', ''],
        ['over 64 chars', 'a'.repeat(65)],
        ['not a string (number)', 7],
        ['not a string (object)', { toString: () => 'mail-server' }],
        ['not a string (array)', ['mail-server']],
        ['undefined', undefined],
        ['null', null],
    ];
    for (const [label, slug] of ESCAPES) {
        it(`fails closed on ${label}`, () => {
            assert.strictEqual(safeSlugParam(slug as any), null);
        });
    }

    it('accepts the slugs the installer can actually produce, and returns them unchanged', () => {
        for (const ok of ['mail-server', 'a', 'online_store', 'plugin1', 'A'.repeat(64)]) {
            assert.strictEqual(safeSlugParam(ok), ok);
        }
    });

    it('pluginFile resolves inside PLUGINS_DIR and fails closed otherwise', () => {
        const p = pluginFile('mail-server', 'manifest.json');
        assert.ok(p, 'a legitimate slug must resolve');
        const base = path.resolve(TMP_ROOT, 'plugins');
        // Containment proved on the RETURNED value, against base + sep — never a bare prefix.
        assert.ok(p.startsWith(base + path.sep));
        assert.strictEqual(path.basename(p), 'manifest.json');

        for (const bad of ['..', '../evil', '/etc/passwd', '', 'a/b', null, 42]) {
            assert.strictEqual(pluginFile(bad as any, 'manifest.json'), null, `must reject ${JSON.stringify(bad)}`);
        }
        // A segment the CODE supplies is checked too — a readdir entry is still a name we did not write.
        assert.strictEqual(pluginFile('mail-server', '../../etc/passwd'), null);
    });
});

// ───────────────────────────────────────── B. what installPluginFromZip is allowed to delete / read

describe('routes/plugins — assertZipInOsTmp proves containment before anything is unlinked', () => {
    it('accepts a path inside the app scratch dir', () => {
        const inside = path.join(OS_TMP_DIR, 'install-abc', 'package.zip');
        assert.strictEqual(assertZipInOsTmp(inside), path.resolve(inside));
    });

    // THE BARE-PREFIX TRAP, the exact bug the old validateSlug had: `os-tmp-evil` "starts with"
    // `os-tmp`. Only a `base + path.sep` comparison rejects it.
    it('rejects a SIBLING directory whose name merely starts with the base name', () => {
        const sibling = path.resolve(OS_TMP_DIR + '-evil', 'package.zip');
        assert.throws(() => assertZipInOsTmp(sibling), /not inside the plugin scratch directory/);
    });

    it('rejects the scratch directory itself (a child is required, never the base)', () => {
        assert.throws(() => assertZipInOsTmp(OS_TMP_DIR), /not inside/);
    });

    const OUTSIDE: Array<[string, unknown]> = [
        ['a traversal out of the base', path.join(OS_TMP_DIR, '..', 'plugins', 'victim', 'x.zip')],
        ['the shared OS temp dir', path.join(os.tmpdir(), 'wjs-mkt-deadbeef.zip')],
        ['an absolute system path', '/etc/passwd'],
        ['a NUL-truncated path', path.join(OS_TMP_DIR, 'a.zip\u0000.txt')],
        ['empty', ''],
        ['not a string', 7],
        ['null', null],
    ];
    for (const [label, p] of OUTSIDE) {
        it(`rejects ${label}`, () => {
            assert.throws(() => assertZipInOsTmp(p as any));
        });
    }

    it('every zip deletion in the install pipeline goes through the one guarded helper', () => {
        const src = codeOnly(readSrc('routes/plugins.ts'));
        // The only fs.unlinkSync of the zip left in the file is the body of discardZip().
        const raw = src.match(/fs\.unlinkSync\(zipPath\)/g) || [];
        assert.strictEqual(raw.length, 1, 'exactly one raw unlink — inside discardZip()');
        assert.match(src, /const discardZip = \(\) => \{ try \{ fs\.unlinkSync\(zipPath\);/);
        // And the caller's argument is never used for an fs op: it is renamed, then proved.
        assert.match(src, /zipPath = assertZipInOsTmp\(zipPathIn\)/);
        assert.doesNotMatch(src, /fs\.\w+\(zipPathIn/);
    });
});

// ─────────────────────────────────────────────────── C. slug as an OBJECT KEY (remote-property-injection)

describe('core/plugin-permissions — a remote slug may not choose a property name', () => {
    it('demonstrates the defect being fixed: __proto__ assignment silently loses the value', () => {
        // This is what `stored[slug] = clean` did on the {} getOption returns for an unset option.
        const stored: any = {};
        stored['__proto__'] = ['evil.example.com'];
        assert.strictEqual(Object.keys(stored).length, 0, 'the key never existed');
        assert.strictEqual(JSON.stringify(stored), '{}', 'and nothing was persisted');
    });

    it('isSafeSlugKey refuses the three magic names — including the two that are LEGAL slugs', () => {
        assert.strictEqual(perms.isSafeSlugKey('__proto__'), false);
        assert.strictEqual(perms.isSafeSlugKey('constructor'), false);
        assert.strictEqual(perms.isSafeSlugKey('prototype'), false);
        // The charset alone would have accepted these two — which is why they are listed explicitly.
        assert.ok(perms.PLUGIN_SLUG.test('constructor'));
        assert.ok(perms.PLUGIN_SLUG.test('prototype'));
        assert.strictEqual(perms.isSafeSlugKey('mail-server'), true);
    });

    it('writeSlugKey throws on an unsafe key and returns a null-prototype record otherwise', () => {
        for (const bad of ['__proto__', 'constructor', 'prototype', '../evil', '', 3, null, undefined]) {
            assert.throws(() => perms.writeSlugKey({}, bad as any, ['x']), /unsafe key/,
                `must refuse ${JSON.stringify(bad)}`);
        }
        const next = perms.writeSlugKey({ 'other-plugin': ['a.example.com'] }, 'mail-server', ['b.example.com']);
        assert.strictEqual(Object.getPrototypeOf(next), null, 'no inherited names left to hit');
        assert.deepStrictEqual(Object.keys(next).sort(), ['mail-server', 'other-plugin']);
        assert.deepStrictEqual(next['mail-server'], ['b.example.com']);
        // A record poisoned before the guard existed is cleaned up on the next write.
        const poisoned = JSON.parse('{"constructor":["x"],"good":["y"]}');
        const cleaned = perms.writeSlugKey(poisoned, 'mail-server', []);
        assert.deepStrictEqual(Object.keys(cleaned).sort(), ['good', 'mail-server']);
    });

    it('setEgressAllowlist REFUSES a __proto__ slug instead of answering success and storing nothing', async () => {
        optionStore.clear();
        await assert.rejects(
            () => perms.setEgressAllowlist('__proto__', ['evil.example.com']),
            /unsafe key/,
        );
        // Nothing was written, and — the part that matters — no in-memory mirror was updated either,
        // so the request cannot end up reporting a policy the store does not have.
        assert.strictEqual(optionStore.has('plugin_egress_hosts'), false);
        assert.deepStrictEqual(perms.getEgressAllowlist('__proto__'), []);
        assert.strictEqual(({} as any).evil, undefined, 'Object.prototype untouched');
    });

    it('setGrants REFUSES a constructor slug (a legal slug shape, an illegal key)', async () => {
        optionStore.clear();
        await assert.rejects(() => perms.setGrants('constructor', ['database:read']), /unsafe key/);
        assert.strictEqual(optionStore.has('plugin_grants'), false);
        assert.deepStrictEqual(perms.getGrants('constructor'), []);
    });

    it('a legitimate slug still round-trips through grants and egress, and uninstall clears both', async () => {
        optionStore.clear();
        await perms.setGrants('mail-server', ['database:write', 'email:provider']);
        await perms.setEgressAllowlist('mail-server', ['smtp.example.com']);
        assert.deepStrictEqual(perms.getGrants('mail-server').sort(), ['database:write', 'email:provider']);
        assert.deepStrictEqual(perms.getEgressAllowlist('mail-server'), ['smtp.example.com']);
        assert.deepStrictEqual(optionStore.get('plugin_grants')['mail-server'].sort(), ['database:write', 'email:provider']);

        // A second plugin must not disturb the first (the rebuild copies own keys).
        await perms.setGrants('online-store', ['database:read']);
        assert.deepStrictEqual(Object.keys(optionStore.get('plugin_grants')).sort(), ['mail-server', 'online-store']);

        await perms.removeGrants('mail-server');
        assert.deepStrictEqual(perms.getGrants('mail-server'), []);
        assert.deepStrictEqual(Object.keys(optionStore.get('plugin_grants')), ['online-store']);
        assert.strictEqual(optionStore.get('plugin_egress_hosts')['mail-server'], undefined);
    });

    it('a poisoned option cannot install a grant record under a magic name at load time', async () => {
        optionStore.clear();
        // Straight from JSON, so `__proto__` really is an OWN property of the parsed object.
        optionStore.set('plugin_grants', JSON.parse('{"__proto__":["database:write"],"constructor":["email:provider"],"mail-server":["database:read"]}'));
        await perms.loadGrants();
        assert.strictEqual(perms.isGranted('__proto__', 'database', 'write'), false);
        assert.strictEqual(perms.isGranted('constructor', 'email', 'provider'), false);
        assert.strictEqual(perms.isGranted('mail-server', 'database', 'read'), true, 'the real record still loads');
    });

    it("the slug shape is one dialect: routes/plugins' SLUG_RE and plugin-permissions' PLUGIN_SLUG are identical", () => {
        const routeSrc = readSrc('routes/plugins.ts');
        const m = routeSrc.match(/const SLUG_RE = (\/[^\n]*\/);/);
        assert.ok(m, 'SLUG_RE must still be declared in routes/plugins.ts');
        assert.strictEqual(m![1], String(perms.PLUGIN_SLUG));
    });
});

// ─────────────────────────────────────────────────────────── D. tainted format string

describe('routes/plugins — data never becomes the format string', () => {
    it('no console call takes a template literal with an interpolation as its first argument', () => {
        const src = codeOnly(readSrc('routes/plugins.ts'));
        const offenders: string[] = [];
        const re = /console\.(?:log|warn|error|info|debug)\(`[^`]*\$\{/g;
        let hit: RegExpExecArray | null;
        while ((hit = re.exec(src))) {
            offenders.push(src.slice(hit.index, hit.index + 90).split('\n')[0]);
        }
        assert.deepStrictEqual(offenders, [],
            'arg 0 of console.* is a FORMAT for util.format — a %s in a slug would eat the next argument');
    });

    it('the slug-bearing log lines pass the slug as DATA', () => {
        const src = readSrc('routes/plugins.ts');
        assert.match(src, /console\.warn\("\[EgressHosts\] reload of '%s' after egress change failed:", logSafe\(slug\), e && e\.message\)/);
        assert.match(src, /console\.warn\("\[Permissions\] reload of '%s' after grant change failed:", logSafe\(slug\), e && e\.message\)/);
    });

    it('proves the behaviour: a %s-bearing value is inert as an argument and hostile as a format', () => {
        const util = require('util');
        const slug = 'evil%s';
        const err = 'the real error';
        // Before: the slug was baked into arg 0 …
        assert.strictEqual(util.format(`[EgressHosts] reload of '${slug}' failed:`, err),
            "[EgressHosts] reload of 'evilthe real error' failed:",
            'the %s in the slug ATE the error object: the operator lost the reason it failed');
        // … after: arg 0 is a constant, the slug is data.
        assert.strictEqual(util.format("[EgressHosts] reload of '%s' failed:", slug, err),
            "[EgressHosts] reload of 'evil%s' failed: the real error");
    });
});

// ─────────────────────────────────────────────────────────── E. insecure temporary files

describe('temp files — kernel-exclusive directory, exclusive create, cleanup in finally', () => {
    it('createInstallTmp hands back a private child of the app scratch dir', () => {
        const tmp = createInstallTmp();
        try {
            assert.ok(tmp.dir.startsWith(path.resolve(OS_TMP_DIR) + path.sep), 'inside os-tmp');
            assert.notStrictEqual(tmp.dir, path.resolve(OS_TMP_DIR));
            assert.ok(fs.statSync(tmp.dir).isDirectory());
            // The zip path it proposes must be one the install pipeline is willing to touch.
            assert.strictEqual(assertZipInOsTmp(tmp.zipPath), path.resolve(tmp.zipPath));
            if (process.platform !== 'win32') {
                assert.strictEqual(fs.statSync(tmp.dir).mode & 0o777, 0o700, 'mkdtemp gives 0700');
            }
        } finally { tmp.dispose(); }
    });

    it('two calls never collide, and dispose removes the directory', () => {
        const a = createInstallTmp();
        const b = createInstallTmp();
        assert.notStrictEqual(a.dir, b.dir);
        fs.writeFileSync(a.zipPath, 'PK', { mode: 0o600, flag: 'wx' });
        // wx = exclusive create: a second write to the same name is an error, never a silent overwrite
        // and never a write THROUGH a symlink someone planted.
        assert.throws(() => fs.writeFileSync(a.zipPath, 'PK', { mode: 0o600, flag: 'wx' }), /EEXIST/);
        a.dispose(); b.dispose();
        assert.strictEqual(fs.existsSync(a.dir), false);
        assert.strictEqual(fs.existsSync(b.dir), false);
        a.dispose(); // idempotent — dispose runs in a finally that may run twice
    });

    it('marketplace no longer writes the downloaded plugin into the shared OS temp dir', () => {
        const src = codeOnly(readSrc('routes/marketplace.ts'));
        assert.doesNotMatch(src, /os\.tmpdir\(\)/, 'the shared OS temp dir is not used at all any more');
        assert.match(src, /const tmp = createInstallTmp\(\);/);
        assert.match(src, /fs\.writeFileSync\(tmp\.zipPath, buf, \{ mode: 0o600, flag: 'wx' \}\)/);
        assert.match(src, /\}\s*finally\s*\{[\s\S]{0,400}?tmp\.dispose\(\);/, 'the scratch dir is disposed in a finally');
    });

    it('the seccomp filter — the bytes that ARE the sandbox — is written exclusively into a mkdtemp dir', () => {
        const src = codeOnly(readSrc('core/plugin-isolate.ts'));
        assert.doesNotMatch(src, /wjs-seccomp-\$\{process\.pid\}/, 'a pid is not a secret');
        assert.match(src, /mkdtempSync\(pathmod\.join\(osmod\.tmpdir\(\), 'wjs-seccomp-'\)\)/);
        assert.match(src, /writeFileSync\(p, bpf, \{ mode: 0o600, flag: 'wx' \}\)/);
        // And the whole directory goes away with the process.
        assert.match(src, /const cleanup = \(\) => \{ try \{ fsmod\.rmSync\(dir, \{ recursive: true, force: true \}\)/);
    });

    it('the netns probe directory is removed in a finally, not only on the happy path', () => {
        const src = readSrc('core/plugin-isolate.ts');
        assert.match(src, /finally \{ if \(ndir\) \{ try \{ fsmod\.rmSync\(ndir, \{ recursive: true, force: true \}\)/);
    });

    it('drill3 builds its artifacts in a private run directory and cleans it up', () => {
        const drill = codeOnly(fs.readFileSync(
            path.join(REPO_ROOT, 'scripts', 'verso-drills', 'drill3-wxr-roundtrip.cjs'), 'utf8'));
        assert.match(drill, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'wordjs-drill3-'\)\)/);
        assert.match(drill, /fs\.writeFileSync\(file, data, \{ encoding: 'utf8', mode: 0o600, flag: 'wx' \}\)/);
        // The two flagged writes now go through writeArtifact …
        assert.match(drill, /writeArtifact\(synthXml, buildSyntheticWxr\(usable\)\)/);
        assert.match(drill, /writeArtifact\(expectFile, JSON\.stringify\(/);
        // … and nothing writes into the old fixed, shared directory any more.
        assert.doesNotMatch(drill, /\btmpDir\(\)/);
        // process.exit() would jump over the finally, so the exit code is deferred past the cleanup.
        assert.match(drill, /finally \{[\s\S]{0,400}?fs\.rmSync\(T, \{ recursive: true, force: true \}\)/);
        // process.exit() terminates immediately and would jump straight over the finally, so the exit
        // code has to be captured inside the try and applied AFTER the cleanup block — not at the end
        // of the happy path, where the old `process.exit(rep.finish())` sat.
        assert.doesNotMatch(drill, /process\.exit\(rep\.finish\(\)\)/);
        assert.match(drill, /code = rep\.finish\(\);/);
        assert.match(drill, /\}\s*\n\s*process\.exit\(code\);/);
    });
});
