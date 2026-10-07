/**
 * RELEASE PACKAGER — the frontend build must not prerender from a live backend.
 *
 * `npm run bundle-release` runs `next build`, which prerenders pages, and every server-side read of
 * that render goes to a backend. CI builds from a clean checkout with nothing listening, so published
 * releases carried the defaults. Run on a developer machine with a dev backend up, the same command
 * shipped private content from that running dev backend: its site title on every prerendered page,
 * its posts prerendered as static paths. And `.next/cache/fetch-cache` kept the answers of an earlier
 * build for the next one to reuse, backend or no backend.
 *
 * The prebuild plugin registries were the same leak through another door: they listed every plugin
 * folder on the packaging machine, untracked private ones included, and `next build` compiled each one
 * into the shipped .next.
 *
 * Two halves are pinned here:
 *   - the GUARD (scripts/release-hermetic-check.js) — the check that fails a bundle whose prerender
 *     shows any trace of a backend that answered, or whose registries import a plugin module git does
 *     not track, driven against fake build output so the suite never runs `next build`. Each trace has
 *     its own test AND the clean output is a control: a guard that rejected everything would pass every
 *     "it trips" test.
 *   - the WIRING (make-release.js buildFrontendForRelease) — the cache is gone BEFORE the build, the
 *     build runs with WORDJS_HERMETIC_BUILD=1 and none of the shell's NEXT_PUBLIC_* values, and the
 *     guard runs on what it produced.
 * The frontend half (what WORDJS_HERMETIC_BUILD=1 does to the backend base and the baked rewrites) is
 * frontend/src/lib/__tests__/hermeticBuild.test.ts.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
    DEFAULT_SITE_NAME,
    PLUGIN_REGISTRIES,
    findHermeticBuildViolations,
    assertHermeticFrontendBuild,
} = require('../../../scripts/release-hermetic-check.js');
const { buildFrontendForRelease, shouldIgnore, ROOT_DIR } = require('../../../scripts/make-release.js');
const { DEFAULT_PROXY_TARGET, rewriteSources } = require('../../../frontend/backend-proxy-target.js');
const { HERMETIC_BUILD_ENV } = require('../../../frontend/hermetic-build.js');

type Route = { srcRoute: string | null; dataRoute: string | null; title?: string; errorShell?: boolean };
type Build = {
    routes?: Record<string, Route>;
    dynamicRoutes?: string[];
    rewrites?: Array<{ source: string; destination: string }>;
    fetchCache?: string[];   // URLs a build-time fetch succeeded for
    // Generated registry (frontend-relative) → the plugin modules it imports (repo-relative, no extension).
    registries?: Record<string, string[]>;
};

/** What git tracks of the one plugin the clean build's registries import. */
const TRACKED: Set<string> = new Set([
    'backend/plugins/hello-world/manifest.json',
    'backend/plugins/hello-world/client/Widget.tsx',
    'backend/plugins/hello-world/client/admin/Page.tsx',
    'backend/plugins/hello-world/client/verso/HelloWorldVerso.tsx',
]);

const temps: string[] = [];
afterEach(() => {
    while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function tempFrontend(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-release-hermetic-'));
    temps.push(dir);
    return dir;
}

const defaultRewrites = () =>
    rewriteSources().map((source: string) => ({ source, destination: `${DEFAULT_PROXY_TARGET}${source}` }));

/**
 * What a clean, backend-less `next build` of this frontend leaves behind (shape taken from a real one):
 * static pages titled with the default site name, Next's own error shell, a route handler with no
 * HTML, dynamic routes that prerendered NOTHING, the default rewrites and no fetch cache.
 */
function cleanBuild(): Required<Build> {
    return {
        routes: {
            '/': { srcRoute: '/', dataRoute: '/index.rsc', title: DEFAULT_SITE_NAME },
            '/register': { srcRoute: '/register', dataRoute: '/register.rsc', title: DEFAULT_SITE_NAME },
            '/login': { srcRoute: '/login', dataRoute: '/login.rsc', title: `Sign in | ${DEFAULT_SITE_NAME}` },
            '/_not-found': { srcRoute: '/_not-found', dataRoute: '/_not-found.rsc', title: DEFAULT_SITE_NAME },
            '/_global-error': { srcRoute: '/_global-error', dataRoute: '/_global-error.rsc', title: '500: This page couldn’t load', errorShell: true },
            '/feed.xml': { srcRoute: '/feed.xml', dataRoute: null },
        },
        dynamicRoutes: ['/[slug]', '/pages/[slug]'],
        rewrites: defaultRewrites(),
        fetchCache: [],
        registries: {
            'src/lib/pluginRegistry.ts': ['backend/plugins/hello-world/client/Widget'],
            'src/app/admin/plugin/[slug]/page.tsx': ['backend/plugins/hello-world/client/admin/Page'],
            'src/lib/versoPluginRegistry.ts': ['backend/plugins/hello-world/client/verso/HelloWorldVerso'],
        },
    };
}

function writeBuild(frontendDir: string, build: Build): void {
    const next = path.join(frontendDir, '.next');
    const app = path.join(next, 'server', 'app');
    fs.mkdirSync(app, { recursive: true });
    const routes = build.routes || {};
    fs.writeFileSync(path.join(next, 'prerender-manifest.json'), JSON.stringify({
        version: 4,
        routes: Object.fromEntries(Object.entries(routes).map(([r, v]) => [r, {
            initialRevalidateSeconds: 60, srcRoute: v.srcRoute, dataRoute: v.dataRoute,
        }])),
        dynamicRoutes: Object.fromEntries((build.dynamicRoutes || []).map((r) => [r, { fallback: null }])),
    }));
    for (const [route, v] of Object.entries(routes)) {
        if (v.title === undefined) continue;
        const file = path.join(app, `${route === '/' ? 'index' : route.slice(1)}.html`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const html = v.errorShell ? '<html id="__next_error__">' : '<html lang="en" dir="ltr">';
        fs.writeFileSync(file, `<!DOCTYPE html>${html}<head><title>${v.title}</title></head><body></body></html>`);
    }
    fs.writeFileSync(path.join(next, 'routes-manifest.json'), JSON.stringify({
        version: 3,
        rewrites: { beforeFiles: [], afterFiles: build.rewrites || [], fallback: [] },
    }));
    // The registries as the prebuild generators write them: dynamic import() calls in the plugin and
    // admin registries, static `import * as … from` in the Verso one — specifiers relative to the file.
    for (const [file, modules] of Object.entries(build.registries || {})) {
        const full = path.join(frontendDir, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const fromDir = path.posix.dirname(`frontend/${file}`);
        const lines = modules.map((m, i) => {
            const spec = path.posix.relative(fromDir, m);
            return file.endsWith('versoPluginRegistry.ts')
                ? `import * as P${i}Blocks from "${spec}";`
                : `    "p${i}": () => import("${spec}"),`;
        });
        fs.writeFileSync(full, `// AUTO-GENERATED FILE - DO NOT EDIT\n${lines.join('\n')}\n`);
    }
    if (build.fetchCache && build.fetchCache.length) {
        const fc = path.join(next, 'cache', 'fetch-cache');
        fs.mkdirSync(fc, { recursive: true });
        build.fetchCache.forEach((url, i) => {
            fs.writeFileSync(path.join(fc, `entry${i}`), JSON.stringify({
                kind: 'FETCH', data: { headers: {}, body: 'e30=', status: 200, url }, revalidate: 60, tags: [],
            }));
        });
    }
}

function violationsOf(build: Build, trackedFiles: Set<string> | null = TRACKED): string[] {
    const dir = tempFrontend();
    writeBuild(dir, build);
    return findHermeticBuildViolations(dir, { trackedFiles });
}

describe('release hermetic-build guard — the clean case passes (control)', () => {
    test('a backend-less build has no findings', () => {
        assert.deepStrictEqual(violationsOf(cleanBuild()), []);
    });

    test('assertHermeticFrontendBuild returns a summary for it instead of throwing', () => {
        const dir = tempFrontend();
        writeBuild(dir, cleanBuild());
        assert.deepStrictEqual(
            assertHermeticFrontendBuild(dir, { trackedFiles: TRACKED }),
            { prerendered: 6, pluginModules: 3 },
        );
    });

    test('with no git to ask, the plugin check is skipped OUT LOUD (pluginModules: null), not passed', () => {
        const dir = tempFrontend();
        writeBuild(dir, cleanBuild());
        assert.deepStrictEqual(
            assertHermeticFrontendBuild(dir, { trackedFiles: null }),
            { prerendered: 6, pluginModules: null },
        );
    });

    test('the tracked-file set is a required argument — forgetting it must not silently skip the plugin check', () => {
        const dir = tempFrontend();
        writeBuild(dir, cleanBuild());
        assert.throws(() => findHermeticBuildViolations(dir), /trackedFiles/);
        assert.throws(() => assertHermeticFrontendBuild(dir), /trackedFiles/);
    });

    test('the registries it reads are the files the prebuild generators write', () => {
        // If a generator moved its output, the guard would read a stale or missing file instead.
        const scripts = path.join(ROOT_DIR, 'frontend', 'scripts');
        const sources = fs.readdirSync(scripts)
            .filter((f: string) => /^generate-.*registry\.js$/.test(f))
            .map((f: string) => fs.readFileSync(path.join(scripts, f), 'utf8'))
            .join('\n');
        assert.strictEqual(PLUGIN_REGISTRIES.length, 3);
        for (const registry of PLUGIN_REGISTRIES) {
            assert.ok(sources.includes(`'../${registry}'`), `no generator writes frontend/${registry}`);
        }
    });

    test('the default site name is the one the root layout falls back to', () => {
        // If layout.tsx changes its fallback, every clean release build would trip the title check.
        const layout = fs.readFileSync(path.join(ROOT_DIR, 'frontend', 'src', 'app', 'layout.tsx'), 'utf8');
        assert.ok(
            layout.includes(`settings?.blogname || "${DEFAULT_SITE_NAME}"`),
            `frontend/src/app/layout.tsx no longer falls back to "${DEFAULT_SITE_NAME}" — update DEFAULT_SITE_NAME`,
        );
    });
});

describe('release hermetic-build guard — every trace of a live backend trips it', () => {
    test('a successful build-time fetch (fetch-cache entry) is reported with its URL', () => {
        const v = violationsOf({ ...cleanBuild(), fetchCache: ['http://localhost:4000/api/v1/settings'] });
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /fetch-cache/);
        assert.match(v[0], /GET http:\/\/localhost:4000\/api\/v1\/settings/);
    });

    test('a path prerendered from generateStaticParams is reported', () => {
        const build = cleanBuild();
        build.routes['/a-private-post'] = { srcRoute: '/[slug]', dataRoute: '/a-private-post.rsc', title: DEFAULT_SITE_NAME };
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /generateStaticParams/);
        assert.match(v[0], /\/a-private-post {2}\(from \/\[slug\]\)/);
    });

    test('a title that merely STARTS with the default name is a leaked site title too', () => {
        // The shape of a home title when the backend answered with a tagline but the site kept its name.
        const build = cleanBuild();
        build.routes['/'].title = `${DEFAULT_SITE_NAME} — a private tagline`;
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /a private tagline/);
    });

    test('a prerendered page whose HTML is not where the check looks fails closed', () => {
        // Otherwise a Next upgrade that moved the prerendered HTML would turn the title check into a
        // check of nothing — and it would still pass.
        const build = cleanBuild();
        delete build.routes['/register'].title;   // listed in the manifest as a page, no HTML written
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /\/register/);
        assert.match(v[0], /no prerendered HTML/);
    });

    test('a plugin module git does not track, compiled in through a registry, is reported', () => {
        const build = cleanBuild();
        build.registries['src/lib/versoPluginRegistry.ts']
            .push('backend/plugins/a-private-plugin/client/verso/APrivatePluginVerso');
        build.registries['src/app/admin/plugin/[slug]/page.tsx']
            .push('backend/plugins/a-private-plugin/client/admin/Page');
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /2 plugin module\(s\)/);
        assert.match(v[0], /backend\/plugins\/a-private-plugin\/client\/verso\/APrivatePluginVerso {2}\(imported by frontend\/src\/lib\/versoPluginRegistry\.ts\)/);
        assert.match(v[0], /backend\/plugins\/a-private-plugin\/client\/admin\/Page {2}\(imported by frontend\/src\/app\/admin\/plugin\/\[slug\]\/page\.tsx\)/);
    });

    test('an untracked file inside a TRACKED plugin is reported too — the check is per module, not per folder', () => {
        const build = cleanBuild();
        build.registries['src/lib/pluginRegistry.ts'].push('backend/plugins/hello-world/client/LocalExperiment');
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /hello-world\/client\/LocalExperiment/);
    });

    test('a missing registry fails closed', () => {
        const build = cleanBuild();
        delete build.registries['src/lib/pluginRegistry.ts'];
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /src\/lib\/pluginRegistry\.ts is missing/);
    });

    test('a prerendered title that is not the default site name is reported — bare or templated', () => {
        const build = cleanBuild();
        build.routes['/register'].title = 'Somebody Else’s Site';
        build.routes['/login'].title = 'Sign in | Somebody Else’s Site';
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /2 prerendered page\(s\)/);
        assert.match(v[0], /\/register/);
        assert.match(v[0], /\/login/);
    });

    test('a rewrite baked from this machine’s gateway port is reported', () => {
        const build = cleanBuild();
        build.rewrites = build.rewrites.map((r) =>
            r.source === '/api/:path*' ? { ...r, destination: 'https://localhost:3443/api/:path*' } : r);
        const v = violationsOf(build);
        assert.strictEqual(v.length, 1, v.join('\n'));
        assert.match(v[0], /https:\/\/localhost:3443\/api\/:path\*/);
    });

    test('a build with NO backend rewrites (monolith env leaked in) is reported', () => {
        const v = violationsOf({ ...cleanBuild(), rewrites: [] });
        assert.strictEqual(v.length, 1, v.join('\n'));
        for (const source of rewriteSources()) assert.ok(v[0].includes(source), `missing ${source} in: ${v[0]}`);
    });

    test('missing manifests fail closed instead of passing an output nobody looked at', () => {
        const dir = tempFrontend();
        fs.mkdirSync(path.join(dir, '.next'), { recursive: true });
        const v = findHermeticBuildViolations(dir, { trackedFiles: TRACKED });
        assert.ok(v.some((x: string) => /prerender-manifest\.json/.test(x)), v.join('\n'));
        assert.ok(v.some((x: string) => /routes-manifest\.json/.test(x)), v.join('\n'));
    });

    test('assertHermeticFrontendBuild throws one error naming every finding', () => {
        const dir = tempFrontend();
        const build = cleanBuild();
        build.fetchCache = ['http://localhost:4000/api/v1/settings'];
        build.routes['/register'].title = 'Somebody Else’s Site';
        writeBuild(dir, build);
        assert.throws(() => assertHermeticFrontendBuild(dir, { trackedFiles: TRACKED }), (e: Error) => {
            assert.match(e.message, /NOT hermetic/);
            assert.match(e.message, /Do NOT publish/);
            assert.match(e.message, /fetch-cache/);
            assert.match(e.message, /\/register/);
            return true;
        });
    });
});

describe('release packager — buildFrontendForRelease wiring', () => {
    function stalePriorBuild(dir: string): string {
        const stale = path.join(dir, '.next', 'cache', 'fetch-cache', 'from-an-earlier-build');
        fs.mkdirSync(path.dirname(stale), { recursive: true });
        fs.writeFileSync(stale, JSON.stringify({ kind: 'FETCH', data: { url: 'http://localhost:4000/api/v1/settings' } }));
        return stale;
    }

    /** Drive buildFrontendForRelease with a fake `npm run build` that leaves `build` behind. */
    function release(dir: string, env: Record<string, string | undefined>, build: Build = cleanBuild()) {
        const calls: any[] = [];
        const summary = buildFrontendForRelease({
            frontendDir: dir,
            env,
            trackedFiles: TRACKED,
            exec: (cmd: string, opts: any) => {
                calls.push({ cmd, opts });
                writeBuild(dir, build);
            },
        });
        return { calls, summary };
    }

    test('clears .next/cache BEFORE building, builds with the hermetic flag, then passes a clean output', () => {
        const dir = tempFrontend();
        const stale = stalePriorBuild(dir);
        const calls: any[] = [];
        const summary = buildFrontendForRelease({
            frontendDir: dir,
            env: { PATH: process.env.PATH, [HERMETIC_BUILD_ENV]: undefined },
            trackedFiles: TRACKED,
            exec: (cmd: string, opts: any) => {
                calls.push({ cmd, opts, staleAtBuild: fs.existsSync(stale) });
                writeBuild(dir, cleanBuild());   // what a hermetic `next build` leaves
            },
        });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].cmd, 'npm run build');
        assert.strictEqual(calls[0].opts.cwd, dir);
        assert.strictEqual(calls[0].staleAtBuild, false, 'the previous build\'s fetch-cache was still there when next build ran');
        assert.strictEqual(calls[0].opts.env[HERMETIC_BUILD_ENV], '1');
        assert.strictEqual(calls[0].opts.env.PATH, process.env.PATH, 'the rest of the environment must be kept');
        assert.deepStrictEqual(summary, { prerendered: 6, pluginModules: 3 });
    });

    test('clears .next/cache with retries — a briefly locked file (Windows, a synced folder) must not abort the release', (t: any) => {
        const dir = tempFrontend();
        const rm = t.mock.method(fs, 'rmSync');
        release(dir, {});
        const cacheCall = rm.mock.calls.find((c: any) => c.arguments[0] === path.join(dir, '.next', 'cache'));
        assert.ok(cacheCall, 'rmSync was not called on .next/cache');
        const opts = cacheCall.arguments[1];
        assert.strictEqual(opts.recursive, true);
        assert.strictEqual(opts.force, true);
        assert.ok(opts.maxRetries > 0, `no retries: ${JSON.stringify(opts)}`);
    });

    test('builds with none of the shell\'s NEXT_PUBLIC_* values — Next inlines them into the shipped bundles', () => {
        const dir = tempFrontend();
        const { calls } = release(dir, { PATH: process.env.PATH, NEXT_PUBLIC_WORDJS_COLLAB: 'off', NEXT_PUBLIC_ANYTHING: 'x' });
        const passed = Object.keys(calls[0].opts.env).filter((k) => k.startsWith('NEXT_PUBLIC_'));
        assert.deepStrictEqual(passed, []);
        assert.strictEqual(calls[0].opts.env.PATH, process.env.PATH);
    });

    test('refuses to build while a frontend .env file a production build loads sets a NEXT_PUBLIC_* value', () => {
        for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
            const dir = tempFrontend();
            fs.writeFileSync(path.join(dir, file), '# local\nexport NEXT_PUBLIC_WORDJS_COLLAB=off\n');
            let built = false;
            assert.throws(
                () => buildFrontendForRelease({
                    frontendDir: dir, env: {}, trackedFiles: TRACKED,
                    exec: () => { built = true; },
                }),
                (e: Error) => {
                    assert.match(e.message, new RegExp(`frontend/${file.replace(/\./g, '\\.')}: NEXT_PUBLIC_WORDJS_COLLAB`));
                    return true;
                },
                file,
            );
            assert.strictEqual(built, false, `${file}: next build ran anyway`);
        }
    });

    test('control: .env files without NEXT_PUBLIC_* values, or that a production build never loads, do not block it', () => {
        const dir = tempFrontend();
        fs.writeFileSync(path.join(dir, '.env.local'), 'INTERNAL_API_URL=http://localhost:4000/api/v1\n');
        fs.writeFileSync(path.join(dir, '.env.development'), 'NEXT_PUBLIC_WORDJS_COLLAB=off\n');
        const { calls } = release(dir, {});
        assert.strictEqual(calls.length, 1);
    });

    test('aborts the release when the build it ran still reached a backend', () => {
        const dir = tempFrontend();
        assert.throws(
            () => release(dir, {}, { ...cleanBuild(), fetchCache: ['http://127.0.0.1:4000/api/v1/posts'] }),
            /NOT hermetic/,
        );
    });

    test('aborts the release when the build compiled in a plugin git does not track', () => {
        const dir = tempFrontend();
        const build = cleanBuild();
        build.registries['src/lib/pluginRegistry.ts'].push('backend/plugins/a-private-plugin/client/Widget');
        assert.throws(() => release(dir, {}, build), /a-private-plugin/);
    });

    test('run() builds the frontend through buildFrontendForRelease, never a bare npm run build', () => {
        const src = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'make-release.js'), 'utf8');
        const run = src.slice(src.indexOf('async function run()'), src.indexOf('function buildFrontendForRelease('));
        assert.match(run, /buildFrontendForRelease\(\)/);
        assert.doesNotMatch(run, /cwd:\s*path\.join\(ROOT_DIR,\s*'frontend'\)/);
    });

    test('the fetch cache never ships, even if a build left one', () => {
        assert.strictEqual(shouldIgnore(path.join(ROOT_DIR, 'frontend', '.next', 'cache', 'fetch-cache', 'x')), true);
    });
});
