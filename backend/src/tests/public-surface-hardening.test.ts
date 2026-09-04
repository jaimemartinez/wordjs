/**
 * PUBLIC-SURFACE HARDENING — #3 (/plugins static tree), #19 (collab vs the global API limiter) and the
 * index.ts half of #11 (the MFA limiter never reached the enrolment routes).
 *
 * WHY THIS BOOTS THE REAL app FROM ../index. Every one of these defects is a property of the MOUNT
 * ORDER and the MOUNT PATHS in index.ts, not of any router. A suite that builds its own express() —
 * which is what collab-routes.test.ts does — cannot see them: it has no global apiLimiter to share a
 * budget with, no /plugins mount, and no /auth/mfa limiter. So this file requires the real app object
 * index.ts exports and drives it over supertest, with config.dbPath repointed at a throwaway file
 * FIRST (the api.test.ts pattern) so the developer's real database is never touched. initialize() is
 * deliberately NOT called: none of these mounts need a database, and the responses below are asserted
 * on their LIMITER HEADERS and STATUS, both of which are produced before any route or guard runs.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Repoint the DB BEFORE anything transitively loads config/database (index.ts does, via the routers).
const config = require('../config/app');
config.dbPath = path.join(os.tmpdir(), `wjs-surface-${process.pid}-${Date.now()}.db`);
config.dbDriver = 'sqlite-native';

const request = require('supertest');
const express = require('express');
const app = require('../index');
const { runWithContext } = require('../core/plugin-context');
const { isPathSafe, SERVED_ROOTS, servedRootOf, isThemeServedRelPath } = require('../core/io-guard');

const API = config.api.prefix;
// PLUGINS_ROOT in index.ts is path.resolve('./plugins'); the suite runs from backend/.
const PLUGINS_ROOT = path.resolve('./plugins');
const THEMES_ROOT = path.resolve('./themes');
const UPLOADS_ROOT = path.resolve(config.uploads.dir);
// Use the same production slug grammar the isolation boundary accepts. Security fixtures must not rely
// on an internal-only name that an installed plugin can never have.
const PROBE = 'wjs-surface-probe';
const probeDir = path.join(PLUGINS_ROOT, PROBE);

const num = (v: any) => Number(v);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE WORLD THIS FILE ASSERTS OVER: AN INSTALLED SITE — DECLARED, NOT INHERITED.
//
// index.ts mounts an install/migration guard that answers 503 `setup_required` to EVERY request whose
// path is not one of the static mounts (/uploads, /themes, /plugins), /health, /favicon.ico or
// `${prefix}/setup`. It decides from wordjs-config.json — per-install state that the developer's
// machine has and a fresh checkout NEVER does (it is gitignored, correctly: it is written by the
// installer, not by git). Two assertions below silently depended on that file being there:
//   · `${API}/plugins/:slug/bundle*` lives UNDER the api prefix, so the /plugins bypass misses it;
//   · superagent NORMALISES '/themes/default/../../wordjs-config.json' to '/wordjs-config.json'
//     client-side, so what reaches the server no longer starts with /themes either.
// Both answered 503 on a clean tree and 200/404 on the dev box. That is not a product defect — 503
// is the correct answer from an uninstalled instance — it is a PRECONDITION this file never stated.
//
// So state it, in memory: stub the two readers the guard uses. index.ts re-`require`s the module and
// destructures it INSIDE the handler on every request, so replacing the functions on the module
// object is enough and takes effect for requests only. The config carries no `siteUrl`, which is what
// keeps the migration branch out of the way. Nothing is written to disk, so the developer's real
// wordjs-config.json is never read, moved or overwritten — and this behaves identically on a machine
// that has one and a machine that does not.
const configManager = require('../core/configManager');
const realIsInstalled = configManager.isInstalled;
const realGetConfig = configManager.getConfig;
configManager.isInstalled = () => true;
configManager.getConfig = () => ({ installedAt: '2020-01-01T00:00:00.000Z', dbDriver: config.dbDriver });
after(() => {
    configManager.isInstalled = realIsInstalled;
    configManager.getConfig = realGetConfig;
});

describe('the precondition, asserted before anything is asserted through it', () => {
    it('runs against an INSTALLED site — otherwise every request below is a vacuous 503', async () => {
        // If the stub above ever stops reaching the guard (it re-requires per request today; a future
        // top-of-module destructure in index.ts would break that), this goes RED here instead of
        // turning the bundle and traversal assertions into "503 !== whatever we expected" further
        // down — or, worse, into assertions that hold for the wrong reason.
        assert.strictEqual(require('../core/configManager').isInstalled(), true,
            'the install-guard stub is not on the module object the guard reads');
        const r = await request(app).get(`${API}/plugins/__not_installed__/bundle/manifest`);
        assert.notStrictEqual(r.status, 503,
            `the install guard is still shadowing ${API}/* (got 503 ${JSON.stringify(r.body)})`);
        assert.strictEqual(r.status, 404, 'and the API prefix must be reaching its routers');
    });
});

describe('#3 — /plugins publishes an allowlist, not the plugin tree', () => {
    before(() => {
        // A throwaway plugin that ships one file of every shape the question is about. Real files on
        // disk under the real PLUGINS_ROOT: the handler resolves and serves them exactly as it would
        // for an installed plugin.
        fs.mkdirSync(path.join(probeDir, 'public'), { recursive: true });
        fs.mkdirSync(path.join(probeDir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({ name: 'Probe', isolated: true }));
        fs.writeFileSync(path.join(probeDir, 'index.js'), '// plugin source\n');
        fs.writeFileSync(path.join(probeDir, 'public', 'probe.css'), '.probe{color:red}');
        fs.writeFileSync(path.join(probeDir, 'public', 'probe.html'), '<script>alert(1)</script>');
        fs.writeFileSync(path.join(probeDir, 'public', 'probe.css.map'), '{"version":3}');
        fs.writeFileSync(path.join(probeDir, 'data', 'secret.txt'), 'encryption key material');
        fs.writeFileSync(path.join(probeDir, 'leak.txt'), 'exfiltrated');
        // The exact SHAPE the audit named on mail-server (data/bayes.json + data/attachments/), built
        // here so the assertion does not depend on that plugin being installed. See the test below.
        fs.mkdirSync(path.join(probeDir, 'data', 'attachments'), { recursive: true });
        fs.writeFileSync(path.join(probeDir, 'data', 'bayes.json'), '{"spam":{}}');
        fs.writeFileSync(path.join(probeDir, 'data', 'attachments', 'msg.eml'), 'From: victim@example.com');
        // The bundle directory the UNAUTHENTICATED /api/v1/plugins/:slug/bundle* routes serve from.
        fs.mkdirSync(path.join(probeDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(probeDir, 'dist', 'admin.bundle.css'), '.a{}');
        fs.writeFileSync(path.join(probeDir, 'dist', 'manifest.build.json'), '{}');
        // A junction/symlink from the plugin's own dir back to itself: the lexical walk-around.
        try { fs.symlinkSync(probeDir, path.join(probeDir, 'self'), 'junction'); } catch { /* unprivileged FS */ }
    });
    after(() => { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } });

    it('serves plugins/<slug>/public/ with nosniff', async () => {
        const r = await request(app).get(`/plugins/${PROBE}/public/probe.css`);
        assert.strictEqual(r.status, 200);
        assert.match(String(r.headers['content-type']), /text\/css/);
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        assert.strictEqual(r.text, '.probe{color:red}');
    });

    it('serves the three fixed files the admin shell asks for by construction', async () => {
        const m = await request(app).get(`/plugins/${PROBE}/manifest.json`);
        assert.strictEqual(m.status, 200);
        assert.strictEqual(m.headers['x-content-type-options'], 'nosniff');
        // hello-world is a plugin shipped in-tree: proves the rule is not probe-specific.
        const h = await request(app).get('/plugins/hello-world/manifest.json');
        assert.strictEqual(h.status, 200);
    });

    it('404s the plugin source, its data/ dir and anything it wrote at runtime', async () => {
        for (const p of [
            `/plugins/${PROBE}/index.js`,           // code
            `/plugins/${PROBE}/data/secret.txt`,    // private runtime data
            `/plugins/${PROBE}/leak.txt`,           // the exfiltration channel of #3
            `/plugins/${PROBE}/public/probe.css.map`, // source map
            `/plugins/${PROBE}/public/probe.html`,  // document-in-this-origin (the XSS variant)
            `/plugins/${PROBE}/`,                   // directory listing
            `/plugins/${PROBE}`,                    // the plugin root itself
        ]) {
            const r = await request(app).get(p);
            assert.strictEqual(r.status, 404, `${p} must not be served (got ${r.status})`);
        }
    });

    it('closes the clean-install leak named in the audit (a plugin\'s data/ dir)', async () => {
        // WAS: `if (!fs.existsSync(PLUGINS_ROOT/mail-server/data)) return;` — a gate that reported
        // PASS on every checkout that does not happen to have mail-server installed, which is every
        // checkout git produces (5 files are tracked under backend/plugins; the rest are local
        // installs). The property is about the SHAPE of the path, not about that plugin, so the probe
        // ships the shape and the assertion is unconditional everywhere.
        for (const p of [`/plugins/${PROBE}/data/bayes.json`,
                         `/plugins/${PROBE}/data/attachments/msg.eml`,
                         `/plugins/${PROBE}/data/attachments`]) {
            const r = await request(app).get(p);
            assert.strictEqual(r.status, 404, `${p} must not be served (got ${r.status})`);
        }
        // …and when the plugin the audit named IS installed, the same statement is made about it too.
        // Extra coverage on top of the unconditional assertion above — never the only coverage.
        if (fs.existsSync(path.join(PLUGINS_ROOT, 'mail-server', 'data'))) {
            for (const p of ['/plugins/mail-server/data/bayes.json', '/plugins/mail-server/data/attachments']) {
                const r = await request(app).get(p);
                assert.strictEqual(r.status, 404, `${p} must not be served (got ${r.status})`);
            }
        }
    });

    it('404s traversal attempts, encoded or not', async () => {
        for (const p of [
            `/plugins/${PROBE}/public/%2e%2e/index.js`,
            `/plugins/${PROBE}/public/../index.js`,
            `/plugins/${PROBE}/..%2f..%2fwordjs-config.json`,
            `/plugins/${PROBE}/public/%2e%2e%2f%2e%2e%2f%2e%2e%2fwordjs-config.json`,
        ]) {
            const r = await request(app).get(p);
            assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
            assert.ok(!String(r.text || '').includes('siteUrl'), `${p} leaked config`);
        }
    });

    it('makes the published surface READ-ONLY to the plugin (io-guard)', () => {
        // The real guard, under the real plugin context — the same predicate the isolated child's
        // patched fs calls. Serving an allowlist while leaving it writable would reopen the channel.
        runWithContext(PROBE, () => {
            assert.strictEqual(isPathSafe(path.join(probeDir, 'public', 'probe.css'), true), false, 'public/ must be write-denied');
            assert.strictEqual(isPathSafe(path.join(probeDir, 'public', 'nested', 'x.bin'), true), false, 'the whole public/ subtree must be write-denied');
            assert.strictEqual(isPathSafe(path.join(probeDir, 'manifest.json'), true), false);
            assert.strictEqual(isPathSafe(path.join(probeDir, 'client', 'admin', 'admin.css'), true), false);
            assert.strictEqual(isPathSafe(path.join(probeDir, 'dist', 'component.bundle.css'), true), false);
            // …while the plugin's own private storage stays writable (no grant needed, unchanged).
            assert.strictEqual(isPathSafe(path.join(probeDir, 'data', 'cache.json'), true), true);
            // …and reading its own published files is still fine.
            assert.strictEqual(isPathSafe(path.join(probeDir, 'public', 'probe.css'), false), true);
        });
    });

    it('CLOSES THE CLASS: no publicly-served root is a plugin write zone (/uploads and /themes, not just /plugins)', () => {
        // THE FAILURE THIS PINS. The first remediation locked /plugins and left its twins: uploads/
        // and themes/ were blanket write zones for EVERY plugin with zero permissions, and index.ts
        // publishes both — the identical unauthenticated exfiltration channel, one URL along. The
        // assertion is stated over the whole SET of served roots so a future static mount is covered
        // by the same statement instead of needing a new one.
        runWithContext(PROBE, () => {
            for (const root of SERVED_ROOTS) {
                const inside = path.join(root, '__leak__', 'stolen.txt');
                assert.strictEqual(isPathSafe(inside, true), false,
                    `a plugin must not write under the served root ${root}`);
            }
            // Named explicitly too, because these two are the ones that were open.
            assert.strictEqual(isPathSafe(path.join(UPLOADS_ROOT, 'leak.txt'), true), false);
            assert.strictEqual(isPathSafe(path.join(THEMES_ROOT, 'default', 'leak.css'), true), false);
            // Shared theme source and app data are not plugin-private zones. Published theme assets are
            // available over the application API, not as blanket filesystem authority in the child.
            assert.strictEqual(isPathSafe(path.join(THEMES_ROOT, 'default', 'style.css'), false), false);
            assert.strictEqual(isPathSafe(path.join(path.resolve('./data'), 'plugin-cache.json'), true), false);
            assert.strictEqual(isPathSafe(path.join(probeDir, 'data', 'cache.json'), true), true);
        });
        // The property that makes it a class and not four patches: nothing io-guard hands a plugin as
        // a write zone may live under a served root.
        assert.strictEqual(servedRootOf(path.resolve('./data')), null);
        assert.ok(SERVED_ROOTS.length >= 4, 'every static mount in index.ts must be declared here');
    });

    it('denies writes to the bundle directory the unauthenticated /bundle routes serve', () => {
        // routes/plugin-bundles.ts answers GET /api/v1/plugins/:slug/bundle{,/css,/manifest} with NO
        // authenticate middleware. Declaring only dist/component.bundle.css unwritable left every
        // sibling of that file writable-and-published — the same channel through the next door.
        runWithContext(PROBE, () => {
            for (const rel of ['admin.bundle.css', 'hooks.bundle.css', 'component.bundle.css',
                               'admin.bundle.js', 'manifest.build.json', 'anything-else.txt']) {
                assert.strictEqual(isPathSafe(path.join(probeDir, 'dist', rel), true), false,
                    `dist/${rel} must be read-only to the plugin`);
            }
        });
    });

    it('serves the bundle routes from the same declaration, and 404s anything else', async () => {
        const css = await request(app).get(`${API}/plugins/${PROBE}/bundle/css?type=admin`);
        assert.strictEqual(css.status, 200, 'the real bundle must still be served');
        assert.strictEqual(css.text, '.a{}');
        // A type outside the declared set can never become a path segment.
        for (const type of ['../../wordjs-config', 'evil', '..%2f..']) {
            const bad = await request(app).get(`${API}/plugins/${PROBE}/bundle/css?type=${encodeURIComponent(type)}`);
            assert.strictEqual(bad.status, 400, `type=${type} must be refused`);
        }
        // An unknown slug resolves to no folder — never to a directory named after the raw slug.
        const missing = await request(app).get(`${API}/plugins/__not_installed__/bundle/manifest`);
        assert.strictEqual(missing.status, 404);
    });

    it('resolves the published path through a symlink the plugin could create inside its own dir', function (t: any) {
        // isPluginPublishedPath was purely lexical: '<own>/self/public/x.css' resolves OUTSIDE
        // '<own>/public/' while the syscall lands inside it. Junction on Windows (no privilege
        // needed), symlink elsewhere; if neither could be created, the case cannot be exercised —
        // and it says so as a SKIP, because a bare `return` here reports PASS for a case that never ran.
        if (!fs.existsSync(path.join(probeDir, 'self'))) {
            t.skip('no symlink/junction could be created in the probe dir — the walk-around is untested here');
            return;
        }
        runWithContext(PROBE, () => {
            assert.strictEqual(isPathSafe(path.join(probeDir, 'self', 'public', 'leak.css'), true), false,
                'a link inside the plugin dir must not walk around the published surface');
            assert.strictEqual(isPathSafe(path.join(probeDir, 'self', 'dist', 'admin.bundle.css'), true), false);
            // The same link must not break a legitimate write to an unpublished path.
            assert.strictEqual(isPathSafe(path.join(probeDir, 'self', 'data', 'cache.json'), true), true);
        });
    });

    it('denies the Win32 trailing-dot spelling of the published dir', function (t: any) {
        // Win32 strips trailing dots and spaces from every path component in the syscall, so
        // 'public./leak.css' IS 'public\leak.css' on disk — while path.resolve keeps the dot.
        if (process.platform !== 'win32') {
            t.skip('the trailing-dot equivalence is a Win32 filesystem property');
            return;
        }
        runWithContext(PROBE, () => {
            assert.strictEqual(isPathSafe(path.join(probeDir, 'public.', 'leak.css'), true), false);
            assert.strictEqual(isPathSafe(path.join(probeDir, 'public ', 'leak.css'), true), false);
            assert.strictEqual(isPathSafe(path.join(probeDir, 'dist.', 'admin.bundle.css'), true), false);
        });
    });

    it('applies the SAME policy to fs.promises (the API the wordjs.fs bridge actually uses)', async () => {
        // io-guard patched only the callback/sync API, so wordjs.fs.write — which ends in
        // fs.promises.writeFile — wrote straight into the published surface. require('fs/promises')
        // returns the same object, so both specifiers must be covered by the one patch.
        assert.strictEqual(require('fs/promises').writeFile, fs.promises.writeFile,
            'fs/promises and fs.promises must be the same object (the patch depends on it)');
        const denied = async (fn: () => Promise<any>) => {
            try { await fn(); return null; } catch (e: any) { return e.code; }
        };
        await runWithContext(PROBE, async () => {
            assert.strictEqual(await denied(() => fs.promises.writeFile(path.join(probeDir, 'public', 'p.css'), 'x')), 'EACCES');
            assert.strictEqual(await denied(() => fs.promises.writeFile(path.join(probeDir, 'dist', 'admin.bundle.css'), 'x')), 'EACCES');
            // NOTE: the module object captured OUTSIDE the plugin context is the real, patched fs —
            // which is exactly what the host-side bridge holds. (A require('fs/promises') issued from
            // INSIDE the context returns secure-require's proxy instead, a different guard entirely;
            // that one only ever covered plugin code, never the bridge, which is why the host's
            // fs.promises had to be patched here.)
            assert.strictEqual(await denied(() => fs.promises.writeFile(path.join(UPLOADS_ROOT, 'p.txt'), 'x')), 'EACCES');
            assert.strictEqual(await denied(() => fs.promises.writeFile(path.join(probeDir, 'planted.js'), 'x')), 'EACCES');
            // …and a legitimate write to its own private storage still succeeds.
            assert.strictEqual(await denied(() => fs.promises.writeFile(path.join(probeDir, 'data', 'ok.json'), '{}')), null);
        });
    });

    it('gives the /plugins handler a ROOT so a dot-directory in the install path cannot 404 every asset', async () => {
        // REGRESSION PIN. res.sendFile(abs) with no `root` makes `send` evaluate dotfiles against the
        // WHOLE absolute path, so an install under ~/.wordjs (or a CI checkout beneath ~/.cache)
        // 404s manifest.json, admin.css and the component bundle — deterministically, invisibly to a
        // checkout without a dot directory. Observe the arguments the REAL handler passes.
        const original = express.response.sendFile;
        const seen: any[] = [];
        express.response.sendFile = function (this: any, p: string, opts: any, cb: any) {
            seen.push({ p, opts });
            return original.call(this, p, opts, cb);
        };
        try {
            const r = await request(app).get(`/plugins/${PROBE}/public/probe.css`);
            assert.strictEqual(r.status, 200);
        } finally {
            express.response.sendFile = original;
        }
        assert.strictEqual(seen.length, 1, 'the handler must serve through res.sendFile');
        assert.strictEqual(seen[0].opts.root, PLUGINS_ROOT, 'sendFile must be given the served root');
        assert.ok(!path.isAbsolute(seen[0].p), `the path must be RELATIVE to that root (got ${seen[0].p})`);
        assert.strictEqual(path.resolve(PLUGINS_ROOT, seen[0].p), path.join(probeDir, 'public', 'probe.css'));
    });

    it('denies the case-variant of the published dir where the filesystem folds case', function (t: any) {
        // On Windows/macOS 'PUBLIC/x.css' IS 'public/x.css' — an exact-case check would deny the
        // write that matters and wave through its twin.
        if (process.platform === 'linux') {
            t.skip('case folding is a Windows/macOS filesystem property; ext4 is case-sensitive');
            return;
        }
        runWithContext(PROBE, () => {
            assert.strictEqual(isPathSafe(path.join(probeDir, 'PUBLIC', 'x.css'), true), false);
            assert.strictEqual(isPathSafe(path.join(probeDir, 'Manifest.JSON'), true), false);
        });
    });

    it('refuses to let a plugin write an .html document anywhere', () => {
        runWithContext(PROBE, () => {
            for (const name of ['pwn.html', 'pwn.htm', 'pwn.xhtml', 'pwn.shtml']) {
                assert.strictEqual(isPathSafe(path.join(probeDir, 'data', name), true), false, `${name} must be write-denied`);
            }
        });
    });

    it('confines the enqueue bridge to the same published surface', async () => {
        // The REAL bridge (core/plugin-assets.enqueue), the one plugin-api.ts hands plugins as
        // assets.enqueueScript/Style. Before #3 `src` could name any file in the plugin dir — which,
        // since the dir is writable with no grant, made the registry itself the exfiltration channel.
        const { enqueue } = require('../core/plugin-assets');
        const rejects = ['index.js', 'data/secret.txt', 'leak.txt', 'public/probe.html', '../hello-world/index.js', '/etc/passwd', 'https://evil.example/x.js'];
        for (const src of rejects) {
            await assert.rejects(
                () => enqueue(PROBE, 'style', { handle: 'h', src }),
                (e: any) => /Invalid asset src|escapes the plugin directory/.test(String(e && e.message)),
                `src=${src} must be refused`
            );
        }
    });
});

describe('#3 twin — /themes publishes an allowlist too, and the theme cannot write it', () => {
    const THEME = 'default';
    const themeDir = path.join(THEMES_ROOT, THEME);

    it('serves a theme\'s assets and compositions', async () => {
        for (const p of [`/themes/${THEME}/style.css`, `/themes/${THEME}/theme.json`]) {
            const r = await request(app).get(p);
            assert.strictEqual(r.status, 200, `${p} must still be served (got ${r.status})`);
            assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
        }
    });

    it('404s the theme\'s SERVER code, its partials and its sources', async () => {
        // functions.js used to answer 200 (Content-Disposition: attachment) — forcing a download
        // prevents execution as a document, not source disclosure. A theme ships no browser JS by
        // contract, so nothing legitimate is lost by refusing to publish it at all.
        for (const p of [
            `/themes/${THEME}/functions.js`,
            `/themes/${THEME}/partials/header.html`,
            `/themes/${THEME}/templates/index.html`,
            `/themes/${THEME}/`,
            `/themes/${THEME}`,
        ]) {
            const r = await request(app).get(p);
            assert.strictEqual(r.status, 404, `${p} must not be served (got ${r.status})`);
        }
    });

    it('404s a file a theme (or a plugin) dropped at runtime — the exfiltration channel', async () => {
        const leak = path.join(themeDir, 'leak.txt');
        fs.writeFileSync(leak, 'exfiltrated');
        try {
            const r = await request(app).get(`/themes/${THEME}/leak.txt`);
            assert.strictEqual(r.status, 404, 'a runtime-dropped file must not be readable over HTTP');
        } finally { fs.rmSync(leak, { force: true }); }
    });

    it('404s traversal attempts, encoded or not', async () => {
        // NOTE on the middle case: superagent resolves dot segments CLIENT-side, so the server never
        // sees '/themes/…/../..' — it sees '/wordjs-config.json'. That still pins something real (the
        // config file is not served from the app root), just not the /themes handler; the two ENCODED
        // spellings are the ones that reach it with the traversal intact. It is also why this case
        // used to hang on the install guard: the normalised path no longer starts with /themes, so
        // the guard's static bypass does not apply to it. (See the precondition at the top.)
        for (const p of [
            `/themes/${THEME}/%2e%2e/default/functions.js`,
            `/themes/${THEME}/../../wordjs-config.json`,
            `/themes/${THEME}/%2e%2e%2f%2e%2e%2fwordjs-config.json`,
        ]) {
            const r = await request(app).get(p);
            assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
            assert.ok(!String(r.text || '').includes('siteUrl'), `${p} leaked config`);
        }
    });

    it('makes the theme\'s published surface READ-ONLY to the theme', () => {
        runWithContext(`theme:${THEME}`, () => {
            // Everything /themes can serve, the theme may not write.
            for (const rel of ['style.css', 'theme.json', 'chrome/header.json', 'assets/logo.png']) {
                assert.strictEqual(isPathSafe(path.join(themeDir, ...rel.split('/')), true), false,
                    `${rel} is published, so it must be write-denied`);
                assert.ok(isThemeServedRelPath(rel), `${rel} must be on the served allowlist`);
            }
            // A sibling theme's directory was never its own — and neither is uploads/.
            assert.strictEqual(isPathSafe(path.join(THEMES_ROOT, 'gaceta', 'x.dat'), true), false);
            assert.strictEqual(isPathSafe(path.join(UPLOADS_ROOT, 'x.dat'), true), false);
            // Unpublished private storage in its own dir stays writable (no over-block).
            assert.strictEqual(isPathSafe(path.join(themeDir, 'cache.dat'), true), true);
        });
    });
});

describe('#19 — collaboration does not spend the global API budget', () => {
    it('gives /collab its own limiter, dimensioned from the FRAMES a client emits — and bounded', async () => {
        const { CONFIG } = require('../core/collab-rooms');
        const r = await request(app).post(`${API}/collab/1/ops`).send({});
        const limit = num(r.headers['ratelimit-limit']);

        // THE DERIVATION. One POST per 100 ms flush period per connection (the client's scheduler),
        // times the tabs one author may hold on a post, times the window, times an explicit slack of 2.
        const expected = Math.ceil((1000 / 100) * CONFIG.MAX_CONNS_PER_USER_POST * 60 * 2);
        assert.strictEqual(limit, expected,
            'the collab limiter must be derived from the client frame rate, not hand-written');

        // THE MAGNITUDE, asserted separately — this is what the previous test could not see. It pinned
        // MAX_OPS_PER_SEC × MAX_CONNS_PER_USER × 60 and would have stayed green at 30 000 req/min
        // (500 req/s per IP): 450× MORE permissive than the 1000/15 min global bucket it replaced, and
        // /collab is skipped by that bucket, so it removed the only per-IP brake on the #20 resync
        // amplifier. A derivation without a magnitude bound pins nothing.
        assert.ok(limit <= 5000, `the per-IP collab ceiling must stay bounded (got ${limit}/min)`);
        assert.ok(limit >= 600, `…but never below what one continuously-typing author emits (got ${limit}/min)`);
        assert.ok(limit < CONFIG.MAX_OPS_PER_SEC * CONFIG.MAX_CONNS_PER_USER * 60,
            'the ops×connections product is not a per-IP request ceiling');
    });

    it('leaves the 1000/15min global budget untouched while typing', async () => {
        // Baseline on a NON-collab route: whatever the global limiter says is left.
        const before = await request(app).get(`${API}/posts`);
        const remainingBefore = num(before.headers['ratelimit-remaining']);
        assert.ok(Number.isFinite(remainingBefore), 'the global limiter must be reporting a budget');

        // What the inline editor emits by design: one transaction per keystroke, ~10 POST/s.
        for (let i = 0; i < 40; i++) await request(app).post(`${API}/collab/1/ops`).send({ ops: [] });

        const after = await request(app).get(`${API}/posts`);
        const remainingAfter = num(after.headers['ratelimit-remaining']);
        assert.strictEqual(num(after.headers['ratelimit-limit']), 1000, 'still the global limiter');
        assert.strictEqual(remainingBefore - remainingAfter, 1,
            '40 collab ops must cost exactly 0 of the global budget (only the two /posts calls count)');
    });

    it('keeps PUT /posts/:id reachable after the collab window would have been exhausted', async () => {
        // The whole point of the finding: the Save button the client advertises as the safety net was
        // being 429'd by the traffic collaboration itself generates. Drive past the 1000-request
        // global window entirely with collab ops, then check the fallback still answers.
        for (let i = 0; i < 1100; i++) await request(app).post(`${API}/collab/1/ops`).send({ ops: [] });
        const save = await request(app).put(`${API}/posts/1`).send({ title: 'x' });
        assert.notStrictEqual(save.status, 429, 'PUT /posts/:id must not be rate-limited by collab traffic');
    });
});

describe('#11 (index.ts half) — the MFA limiter reaches the enrolment routes', () => {
    it('throttles POST /auth/mfa/setup and /auth/mfa/enable', async () => {
        const expected = config.auth.loginIpFailPerHour;
        for (const p of ['/auth/mfa', '/auth/mfa/setup', '/auth/mfa/enable', '/auth/mfa/disable', '/auth/mfa/backup-codes']) {
            const r = await request(app).post(`${API}${p}`).send({});
            assert.strictEqual(num(r.headers['ratelimit-limit']), expected,
                `POST ${p} must be covered by loginIpLimiter (got limit ${r.headers['ratelimit-limit']})`);
        }
    });

    it('leaves the polled read routes on the global budget', async () => {
        // GET /auth/mfa/status is fetched on every account-page load; putting it under the shared
        // 10/hr/IP bucket is the regression the previous exact-path mount existed to prevent.
        for (const p of ['/auth/mfa/status', '/auth/mfa/policy']) {
            const r = await request(app).get(`${API}${p}`);
            assert.strictEqual(num(r.headers['ratelimit-limit']), 1000, `GET ${p} must stay on the global limiter`);
        }
    });
});

describe('#21 — POST /analytics/track has its own per-IP bucket', () => {
    it('is not left on the global 1000/15min ceiling', async () => {
        const r = await request(app).post(`${API}/analytics/track`).send({ type: 'page_view', resource: '/' });
        assert.strictEqual(num(r.headers['ratelimit-limit']), 60,
            'the anonymous tracking beacon must have a dedicated limiter mounted on its exact route');
        // The admin read surface must NOT draw on that public write budget.
        const stats = await request(app).get(`${API}/analytics/stats`);
        assert.strictEqual(num(stats.headers['ratelimit-limit']), 1000);
    });
});

describe("the backend's own Content-Security-Policy", () => {
    it("grants script-src 'self' and 'unsafe-inline', and never 'unsafe-eval'", async () => {
        // Another mount-order property of index.ts, and the reason this file boots the real app: the
        // helmet header is written before any router, so no suite that builds its own express() can
        // see it. The backend serves exactly ONE HTML page (Swagger UI at `${API}/docs`, whose
        // bootstrap is an inline <script>) — 'unsafe-inline' is for that and nothing else, and the
        // "some CMS themes/plugins" that once justified 'unsafe-eval' do not exist: a theme ships no
        // JavaScript, and a plugin's admin bundle is executed by the frontend under ITS header.
        const res = await request(app).get(API);
        const csp = String(res.headers['content-security-policy'] || '');
        assert.ok(csp, 'helmet must set a Content-Security-Policy');

        // Tokenise the DIRECTIVE. Substring-matching the whole header would answer a different
        // question — 'unsafe-inline' also appears in style-src, and a source list can merely contain
        // the word — whereas what matters is which sources script-src itself grants.
        const directive = csp.split(';').map((d: string) => d.trim())
            .find((d: string) => /^script-src(\s|$)/.test(d));
        assert.ok(directive, `no script-src directive in: ${csp}`);
        const sources = String(directive).split(/\s+/).slice(1);

        assert.ok(sources.includes("'self'"), `script-src must keep 'self': ${directive}`);
        assert.ok(sources.includes("'unsafe-inline'"),
            `script-src must keep 'unsafe-inline' for the swagger-ui bootstrap: ${directive}`);
        assert.ok(!sources.includes("'unsafe-eval'"),
            `nothing this origin serves builds code from a string: ${directive}`);
    });
});
