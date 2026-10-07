/**
 * GATE — a release build cannot prerender from a backend running on the packaging machine.
 *
 * `next build` prerenders pages, and every server-side read it makes goes to the backend these
 * modules resolve: `wordjs-config.json`, INTERNAL_API_URL, or `http://localhost:4000`. CI has nothing
 * listening there; a developer machine running `npm run bundle-release` usually does, and the bundle
 * shipped private content from that running dev backend — its site title on every prerendered page,
 * its posts as prerendered paths — plus an API rewrite aimed at that machine's gateway.
 *
 * Under `WORDJS_HERMETIC_BUILD=1` (set by scripts/make-release.js) every destination-choosing function
 * must ignore all of that and answer HERMETIC_BACKEND_BASE, and the read must still be ISSUED with its
 * ISR window — Next records a page's revalidate from the fetch call itself, so a skipped fetch would
 * turn /register into a page that never re-renders with the real site's settings.
 *
 * The prebuild plugin-registry generators are the other way the packaging machine reached the build:
 * they asked the running backend which plugins are active and otherwise took every folder under
 * backend/plugins, untracked private plugins included — whose code `next build` then compiled into
 * the shipped .next. Under the flag they ask nothing and take only the plugins git tracks.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// CommonJS root helpers, the same modules next.config.ts and make-release.js read.
import { HERMETIC_BACKEND_BASE, HERMETIC_BUILD_ENV, isHermeticBuild } from '../../../hermetic-build.js';
import proxyTarget from '../../../backend-proxy-target.js';

const { DEFAULT_PROXY_TARGET, rewriteSources } = proxyTarget as unknown as {
    DEFAULT_PROXY_TARGET: string;
    rewriteSources: () => string[];
};

/** Everything that could point the build at a backend, set to somewhere that is NOT the hermetic base. */
const HOSTILE_ENV: Record<string, string> = {
    INTERNAL_API_URL: 'http://10.9.9.9:4000/api/v1',
    WORDJS_MODE: 'mono',
    WORDJS_MONO_ORIGIN: 'http://127.0.0.1:4555',
    WORDJS_BACKEND_URL: 'http://10.9.9.9:3443',
};
const TOUCHED = [HERMETIC_BUILD_ENV, ...Object.keys(HOSTILE_ENV)];

const FRONTEND_DIR = path.resolve(__dirname, '../../..');
const REPO_DIR = path.resolve(FRONTEND_DIR, '..');

let savedEnv: Record<string, string | undefined> = {};
let savedCwd = '';
let tmp = '';
const sandboxes: string[] = [];

beforeEach(() => {
    savedEnv = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    for (const k of TOUCHED) delete process.env[k];
    savedCwd = process.cwd();
    tmp = '';
});

afterEach(() => {
    for (const k of TOUCHED) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    process.chdir(savedCwd);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

/**
 * Run from a directory holding a packaging machine's wordjs-config.json — every field the resolvers
 * read: an internal API URL, a backend port, a gateway port and a site URL. server-api/api read it
 * from process.cwd(), exactly as a build started in a real checkout does.
 */
function chdirIntoConfiguredCheckout(): void {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-hermetic-'));
    fs.writeFileSync(path.join(tmp, 'wordjs-config.json'), JSON.stringify({
        internalApiUrl: 'http://10.8.8.8:4000/api/v1',
        port: 4777,
        gatewayPort: 3443,
        siteUrl: 'https://dev-site.example',
    }));
    process.chdir(tmp);
}

function hermetic(): void {
    process.env[HERMETIC_BUILD_ENV] = '1';
}

function stubFetch(): Array<{ url: string; init: any }> {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        calls.push({ url: String(url), init });
        // What fetch() does with the hermetic base for real (see the "bad port" test below).
        throw new TypeError('fetch failed');
    }));
    return calls;
}

describe('the flag', () => {
    it('is on only for exactly "1"', () => {
        expect(isHermeticBuild({ [HERMETIC_BUILD_ENV]: '1' })).toBe(true);
        for (const v of [undefined, '', '0', 'false', 'true', ' 1']) {
            expect(isHermeticBuild({ [HERMETIC_BUILD_ENV]: v })).toBe(false);
        }
    });

    it('the hermetic base is one fetch() refuses before any network I/O (Fetch-standard bad port)', async () => {
        // The REAL fetch, not a stub: if this ever connected, a process on the build machine could answer.
        const err = await fetch(`${HERMETIC_BACKEND_BASE}/settings`).then(
            () => null,
            (e: any) => e,
        );
        expect(err, 'fetch to the hermetic base must reject').toBeTruthy();
        expect(String(err?.cause?.message ?? err?.cause ?? '')).toMatch(/bad port/i);
    });
});

describe('server-api under WORDJS_HERMETIC_BUILD=1', () => {
    it('resolves the hermetic base whatever the env and the checkout\'s config say', async () => {
        chdirIntoConfiguredCheckout();
        Object.assign(process.env, HOSTILE_ENV);
        hermetic();
        const { resolveServerBase, configuredPublicHost } = await import('@/lib/server-api');

        expect(resolveServerBase()).toBe(HERMETIC_BACKEND_BASE);
        // The packaging machine's siteUrl must not ride along either.
        expect(configuredPublicHost()).toBeNull();
    });

    it('still ISSUES each read, with its ISR window, and degrades to null like an unreachable backend', async () => {
        chdirIntoConfiguredCheckout();
        Object.assign(process.env, HOSTILE_ENV);
        hermetic();
        const calls = stubFetch();
        const { getSettings, getPosts } = await import('@/lib/server-api');

        expect(await getSettings()).toBeNull();
        expect(await getPosts('post', 'publish')).toBeNull();

        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c.url.startsWith(`${HERMETIC_BACKEND_BASE}/`)).toBe(true);
        // The revalidate travels on the call — that is what Next reads to give /register a 60s window.
        const settingsCall = calls.find((c) => c.url === `${HERMETIC_BACKEND_BASE}/settings`);
        expect(settingsCall?.init?.next?.revalidate).toBe(60);
        // No packaging-machine host forwarded.
        expect(settingsCall?.init?.headers?.['x-forwarded-host']).toBeUndefined();
    });

    it('control: WITHOUT the flag the same environment is honoured (the override is what changed)', async () => {
        Object.assign(process.env, { INTERNAL_API_URL: HOSTILE_ENV.INTERNAL_API_URL });
        const { resolveServerBase } = await import('@/lib/server-api');
        expect(resolveServerBase()).toBe(HOSTILE_ENV.INTERNAL_API_URL);
    });
});

describe('api.ts under WORDJS_HERMETIC_BUILD=1', () => {
    it('its server-side base is the hermetic one too', async () => {
        chdirIntoConfiguredCheckout();
        Object.assign(process.env, HOSTILE_ENV);
        hermetic();
        const calls = stubFetch();
        const { apiGet } = await import('@/lib/api'); // API_URL is computed at module load

        await expect(apiGet('/settings')).rejects.toThrow();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${HERMETIC_BACKEND_BASE}/settings`);
    });
});

describe('next.config rewrites under WORDJS_HERMETIC_BUILD=1', () => {
    async function rewrites(): Promise<Array<{ source: string; destination: string }>> {
        const { default: nextConfig } = await import('../../../next.config');
        return (await (nextConfig.rewrites as () => Promise<any>)()) as Array<{ source: string; destination: string }>;
    }

    const rewritesTo = (target: string) =>
        rewriteSources().map((source) => ({ source, destination: `${target}${source}` }));

    /**
     * The packaging machine's wordjs-config.json, as next.config sees it. next.config reads the file
     * from ITS OWN directory (frontend/, then ../backend/), not from the cwd, so it is answered
     * through fs for exactly those two paths; every other read goes to the real disk.
     */
    function packagingMachineConfig(config: Record<string, unknown>): void {
        const configFiles = new Set([
            path.join(FRONTEND_DIR, 'wordjs-config.json'),
            path.join(REPO_DIR, 'backend', 'wordjs-config.json'),
        ]);
        const isConfig = (p: unknown) => typeof p === 'string' && configFiles.has(path.resolve(p));
        const realExists = fs.existsSync;
        const realRead = fs.readFileSync;
        vi.spyOn(fs, 'existsSync').mockImplementation(((p: fs.PathLike) =>
            isConfig(p) || realExists(p)) as typeof fs.existsSync);
        vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) =>
            isConfig(p) ? JSON.stringify(config) : (realRead as any)(p, ...rest)) as typeof fs.readFileSync);
    }

    it('bakes the compiled-in default, ignoring WORDJS_BACKEND_URL and WORDJS_MODE', async () => {
        Object.assign(process.env, HOSTILE_ENV);
        hermetic();
        expect(await rewrites()).toEqual(rewritesTo(DEFAULT_PROXY_TARGET));
    });

    it('bakes the compiled-in default, ignoring the packaging machine\'s wordjs-config.json gatewayPort', async () => {
        packagingMachineConfig({ gatewayPort: 3443 });
        hermetic();
        expect(await rewrites()).toEqual(rewritesTo(DEFAULT_PROXY_TARGET));
    });

    it('control: WITHOUT the flag that same config bakes https://localhost:<gatewayPort>', async () => {
        // Proves the stub reaches next.config — otherwise the test above would pass vacuously.
        packagingMachineConfig({ gatewayPort: 3443 });
        expect(await rewrites()).toEqual(rewritesTo('https://localhost:3443'));
    });

    it('control: WITHOUT the flag a monolith environment bakes no rewrites at all', async () => {
        process.env.WORDJS_MODE = 'mono';
        expect(await rewrites()).toEqual([]);
    });
});

describe('plugin registries under WORDJS_HERMETIC_BUILD=1', () => {
    /**
     * The prebuild generators (frontend/scripts) and what each writes. Every plugin a registry
     * imports is compiled into .next by `next build`, so the registries decide which plugin code a
     * release carries.
     */
    const GENERATORS = [
        { script: 'generate-plugin-registry.js', out: 'src/lib/pluginRegistry.ts' },
        { script: 'generate-admin-plugin-registry.js', out: 'src/app/admin/plugin/[slug]/page.tsx' },
        { script: 'generate-verso-plugin-registry.js', out: 'src/lib/versoPluginRegistry.ts' },
    ];

    /**
     * Preloaded into each generator: records every http(s) request it starts and fails it, so the
     * test sees whether a generator ASKED a backend without anything being able to answer.
     */
    const RECORD_HTTP = `
const fs = require('fs');
const { EventEmitter } = require('events');
for (const mod of [require('http'), require('https')]) {
    for (const fn of ['get', 'request']) {
        mod[fn] = function (target) {
            fs.appendFileSync(process.env.WJS_HTTP_LOG, String((target && target.href) || target) + '\\n');
            const req = new EventEmitter();
            req.end = () => req;
            process.nextTick(() => req.emit('error', new Error('network disabled by the test')));
            return req;
        };
    }
}
`;

    function git(cwd: string, ...args: string[]): void {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
        expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
    }

    /** A plugin with an admin page, a frontend component and a Verso block — one entry per registry. */
    function writePlugin(root: string, slug: string, pascal: string): void {
        const dir = path.join(root, 'backend', 'plugins', slug);
        const files: Record<string, string> = {
            'manifest.json': JSON.stringify({
                id: slug, name: slug, version: '1.0.0',
                frontend: {
                    components: [{ entry: './client/Widget.tsx' }],
                    adminPage: { entry: './client/admin/Page.tsx', slug },
                    versoComponents: { entry: `client/verso/${pascal}Verso.tsx` },
                },
            }),
            'client/Widget.tsx': 'export default function Widget() { return null; }\n',
            'client/admin/Page.tsx': 'export default function Page() { return null; }\n',
            [`client/verso/${pascal}Verso.tsx`]:
                'export const versoComponentDef = { category: "c", fields: {}, defaultProps: {} };\n' +
                'export default function Block() { return null; }\n',
        };
        for (const [rel, text] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), text);
        }
    }

    /**
     * A checkout laid out like the repo — the generators find backend/plugins and their helpers
     * relative to their own location — with one plugin git tracks and one it does not (a local or
     * private plugin folder in the packaging machine's working tree).
     */
    function sandbox(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-hermetic-plugins-'));
        sandboxes.push(root);
        fs.cpSync(path.join(FRONTEND_DIR, 'scripts'), path.join(root, 'frontend', 'scripts'), { recursive: true });
        fs.copyFileSync(path.join(FRONTEND_DIR, 'hermetic-build.js'), path.join(root, 'frontend', 'hermetic-build.js'));
        fs.mkdirSync(path.join(root, 'backend', 'scripts'), { recursive: true });
        fs.copyFileSync(
            path.join(REPO_DIR, 'backend', 'scripts', 'plugin-block-contract.js'),
            path.join(root, 'backend', 'scripts', 'plugin-block-contract.js'),
        );
        writePlugin(root, 'shipped-plugin', 'ShippedPlugin');
        writePlugin(root, 'local-plugin', 'LocalPlugin');
        git(root, 'init', '-q');
        git(root, 'add', '--', 'backend/plugins/shipped-plugin');
        fs.writeFileSync(path.join(root, 'record-http.cjs'), RECORD_HTTP);
        return root;
    }

    /** Run the three real generators, as the frontend prebuild does, and collect what they wrote. */
    function generate(root: string, env: Record<string, string>) {
        const httpLog = path.join(root, 'http.log');
        const base: NodeJS.ProcessEnv = { ...process.env };
        // Inputs of the generators this test sets itself (and the Verso generator's test seams).
        for (const k of [HERMETIC_BUILD_ENV, 'WORDJS_ACTIVE_PLUGINS', 'WORDJS_PLUGINS_DIR', 'WORDJS_VERSO_REGISTRY_OUT']) {
            delete base[k];
        }
        const outputs: Record<string, string> = {};
        let stdout = '';
        for (const g of GENERATORS) {
            const r = spawnSync(
                process.execPath,
                ['-r', path.join(root, 'record-http.cjs'), path.join(root, 'frontend', 'scripts', g.script)],
                {
                    cwd: path.join(root, 'frontend'),
                    encoding: 'utf8',
                    env: { ...base, ...env, WJS_HTTP_LOG: httpLog },
                },
            );
            expect(r.status, `${g.script} failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
            stdout += r.stdout;
            outputs[g.out] = fs.readFileSync(path.join(root, 'frontend', g.out), 'utf8');
        }
        const requests = fs.existsSync(httpLog) ? fs.readFileSync(httpLog, 'utf8').split('\n').filter(Boolean) : [];
        return { outputs, requests, stdout };
    }

    it('compiles in only the plugins git tracks, and asks no backend which ones are active', () => {
        const root = sandbox();
        const { outputs, requests } = generate(root, {
            [HERMETIC_BUILD_ENV]: '1',
            // What the packaging machine says is active — a release must not depend on it either.
            WORDJS_ACTIVE_PLUGINS: JSON.stringify(['local-plugin']),
        });
        for (const [file, text] of Object.entries(outputs)) {
            expect(text, file).toContain('backend/plugins/shipped-plugin/');
            expect(text, file).not.toContain('local-plugin');
        }
        expect(requests, 'a release build asked a backend which plugins are active').toEqual([]);
    });

    it('control: WITHOUT the flag the dev loop is unchanged — it asks the backend, then takes every folder on disk', () => {
        const root = sandbox();
        const { outputs, requests } = generate(root, {});
        for (const [file, text] of Object.entries(outputs)) {
            expect(text, file).toContain('backend/plugins/shipped-plugin/');
            expect(text, file).toContain('backend/plugins/local-plugin/');
        }
        expect(requests).toHaveLength(GENERATORS.length);
        for (const url of requests) expect(url).toBe('http://localhost:3000/api/v1/plugins/active');
    });

    it('with no git to ask (a tree without .git, like the Docker build context) it keeps every folder and SAYS so', () => {
        const root = sandbox();
        const { outputs, requests, stdout } = generate(root, {
            [HERMETIC_BUILD_ENV]: '1',
            GIT_DIR: path.join(root, 'no-such-git-dir'),
        });
        for (const [file, text] of Object.entries(outputs)) {
            expect(text, file).toContain('backend/plugins/shipped-plugin/');
            expect(text, file).toContain('backend/plugins/local-plugin/');
        }
        expect(requests).toEqual([]);
        expect(stdout).toMatch(/git is unavailable/);
    });
});

describe('the fetch cache the release guard inspects', () => {
    it('is still where this Next version writes build-time fetches (.next/cache/fetch-cache)', () => {
        // scripts/release-hermetic-check.js treats an EMPTY .next/cache/fetch-cache as "no build-time
        // fetch succeeded". If a Next upgrade moved that directory the check would pass on nothing, so
        // the location is pinned to Next's own file-system cache handler.
        const nextDir = path.dirname(createRequire(path.join(FRONTEND_DIR, 'package.json')).resolve('next/package.json'));
        const handler = fs.readFileSync(
            path.join(nextDir, 'dist', 'server', 'lib', 'incremental-cache', 'file-system-cache.js'),
            'utf8',
        );
        expect(handler).toMatch(/join\(this\.serverDistDir,\s*'\.\.',\s*'cache',\s*'fetch-cache'\)/);
    });
});
