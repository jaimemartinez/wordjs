/** Wiring contract for the sole Linux native sandbox: Landlock plus an always-on seccomp filter. */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('../config/app');
const isolate = require('../core/plugin-isolate');
const linux = require('../core/sandbox-linux');

const STATES = ['unknown', 'unsupported', 'disabled', 'active', 'degraded'];

describe('Linux floor decision', () => {
    test('declared and reachable layers are exactly Landlock and none', () => {
        assert.deepStrictEqual([...isolate.__linuxFloorLayers], ['landlock', 'none']);
        const produced = new Set<string>();
        for (const platform of ['linux', 'win32']) {
            for (const zeroConf of STATES) {
                for (const netGranted of [false, true]) {
                    produced.add(isolate.__linuxFloorDecision({ platform, zeroConf, netGranted }).layer);
                }
            }
        }
        assert.deepStrictEqual([...produced].sort(), ['landlock', 'none']);
    });

    test('the network grant never removes filesystem or syscall confinement', () => {
        const denied = isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted: false });
        const granted = isolate.__linuxFloorDecision({ platform: 'linux', zeroConf: 'active', netGranted: true });
        assert.strictEqual(denied.layer, 'landlock');
        assert.strictEqual(granted.layer, 'landlock');
        assert.strictEqual(denied.denyNetwork, true);
        assert.strictEqual(granted.denyNetwork, false);
    });

    test('non-Linux platforms never claim the Linux floor', () => {
        for (const platform of ['win32', 'darwin', 'freebsd']) {
            assert.strictEqual(isolate.__linuxFloorDecision({
                platform, zeroConf: 'active', netGranted: false,
            }).layer, 'none');
        }
    });
});

describe('real launch wiring and visibility', () => {
    test('shim argv carries both network shapes without changing its confinement prefix', () => {
        const base = { readRoots: ['/srv/wordjs'], writableDirs: ['/srv/wordjs/data'], command: ['/usr/bin/node', 'worker.js'] };
        const denied = linux.shimArgs({ ...base, denyNetwork: true });
        const granted = linux.shimArgs({ ...base, denyNetwork: false });
        const separator = denied.indexOf('--');
        assert.strictEqual(denied[separator - 1], '1');
        assert.strictEqual(granted[separator - 1], '0');
        assert.deepStrictEqual(denied.filter((_: string, i: number) => i !== separator - 1),
            granted.filter((_: string, i: number) => i !== separator - 1));
    });

    test('production source has no bwrap launcher or obsolete Linux switches', () => {
        const isolateSource = fs.readFileSync(path.resolve(__dirname, '../core/plugin-isolate.ts'), 'utf8');
        const configSource = fs.readFileSync(path.resolve(__dirname, '../config/app.ts'), 'utf8');
        assert.doesNotMatch(isolateSource, /spawn\s*\(\s*['"]bwrap['"]|__bwrapProfile/);
        assert.doesNotMatch(configSource, /useLinuxZeroConf|unshareNetwork/);
    });

    test('ts-node gets only its two literal project files, never a read grant on the backend root', () => {
        const isolateSource = fs.readFileSync(path.resolve(__dirname, '../core/plugin-isolate.ts'), 'utf8');
        assert.match(isolateSource, /tsNodeProjectFiles = __filename\.endsWith\('\.ts'\)/);
        assert.match(isolateSource, /\[path\.join\(APP_ROOT, 'tsconfig\.json'\), path\.join\(APP_ROOT, 'package\.json'\)\]/);
        assert.match(isolateSource, /\.\.\.tsNodeProjectFiles/);
        assert.doesNotMatch(isolateSource, /sandboxReadable[^\n]*APP_ROOT/,
            'the source-worker fix must not turn the whole backend root into plugin read authority');
    });

    test('macOS is fixed by a deterministic cwd, NOT by widening the profile', () => {
        // THE CHEAPER OF TWO WORKING FIXES, and both were measured on a real macOS runner rather than
        // reasoned about. An isolated plugin could not start there at all: ts-node calls process.cwd()
        // to find tsconfig.json, macOS resolves a working directory by READING each of its ancestors,
        // and the Seatbelt profile withholds them deliberately.
        //
        //   C3  grant the ancestors as literals ......... BOOTED — and hands a plugin a listing of
        //                                                 every directory above the app root
        //   C5  cwd="/" + TS_NODE_PROJECT ............... BOOTED — and changes no grant whatsoever
        //
        // C3 was committed first. C5 is what other macOS sandboxes do (Chromium's Seatbelt design
        // describes entering the sandbox with the working directory at the root, which has no ancestors
        // left to resolve), so the grant came back out. This test exists to keep it out.
        const isolateSource = fs.readFileSync(path.resolve(__dirname, '../core/plugin-isolate.ts'), 'utf8');

        assert.doesNotMatch(isolateSource, /seatbeltCwdAncestors/,
            'the ancestor grant is back; the cheaper fix makes it unnecessary');
        assert.match(isolateSource, /readOnlyFiles: tsNodeProjectFiles/,
            'readOnlyFiles must carry the two project files and nothing else');

        // Both halves, because cwd="/" ALONE was candidate C1 and it dies: ts-node then searches for
        // tsconfig.json from "/" and never finds it.
        // Generalised to Linux on 2026-09-04 as defence-in-depth (process.cwd() no longer discloses the
        // deployment path there either); the property under test is unchanged — a deterministic root cwd,
        // never an ancestor grant. Windows keeps the default (AppContainer relay / exempt dev worker).
        assert.match(isolateSource, /const childCwd = \(process\.platform === 'darwin' \|\| process\.platform === 'linux'\) \? path\.parse\(APP_ROOT\)\.root : undefined;/,
            'the child must get a deterministic working directory on macOS and Linux');
        assert.match(isolateSource, /workerEnv\.TS_NODE_PROJECT = path\.join\(APP_ROOT, 'tsconfig\.json'\)/,
            'ts-node must be told where its config is, or the cwd change strands it');
        assert.match(isolateSource, /'COMSPEC', 'TS_NODE_PROJECT'\]/,
            'TS_NODE_PROJECT must survive the child-side environment prune');

        // THE THIRD HALF, and it is the one that was missed. `-r ts-node/register` is a BARE specifier,
        // and Node resolves those for `-r` against the CURRENT WORKING DIRECTORY. Harmless while the
        // child inherited a cwd inside the project; fatal the moment the cwd becomes "/", because there
        // is no node_modules above it:
        //
        //     Error: Cannot find module 'ts-node/register'   Require stack: - internal/preload
        //
        // The candidate leg in the diagnostic had already been given an absolute path — which is exactly
        // why C5 booted there while the product did not.
        assert.doesNotMatch(isolateSource, /'-r', 'ts-node\/register'/,
            'the preload is a bare specifier again; with cwd="/" Node cannot resolve it');
        assert.match(isolateSource, /require\.resolve\('ts-node\/register'\)/,
            'the preload must be resolved to an absolute path from this module’s own scope');

        // EVERY spawn branch, not the one that was easiest to find. There are four; the AppContainer
        // launcher is a typed options object that sets its own working directory and is deliberately
        // not among them.
        const withCwd = (isolateSource.match(/cwd: childCwd,/g) || []).length;
        assert.strictEqual(withCwd, 4,
            `${withCwd} spawn branches carry the deterministic cwd; all four must`);
    });

    test('the config is zero-configuration and has one explicit Linux opt-out', () => {
        const config = require('../config/app');
        assert.strictEqual(config.sandbox.useKernelHardening, true);
        assert.strictEqual(config.sandbox.useLinuxZeroConf, undefined);
        assert.strictEqual(config.sandbox.unshareNetwork, undefined);
    });

    test('the platform report names one Linux floor and says it applies to every plugin', async () => {
        await isolate.probePlatformConfinement();
        const report = isolate.getSandboxPlatformConfinement();
        if (process.platform !== 'linux') {
            assert.strictEqual(report.floor, undefined);
            return;
        }
        assert.ok(report.floor);
        assert.ok(['landlock+seccomp', 'none'].includes(report.floor.inForce));
        assert.strictEqual(report.floor.layers.landlock.state, isolate.getLinuxZeroConfState());
        assert.match(report.appliesTo, /every isolated plugin/i);
    });
});
