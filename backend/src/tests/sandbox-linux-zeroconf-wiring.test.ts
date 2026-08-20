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
        assert.match(isolateSource, /readOnlyFiles: tsNodeProjectFiles/);
        assert.match(isolateSource, /\.\.\.tsNodeProjectFiles/);
        assert.doesNotMatch(isolateSource, /sandboxReadable[^\n]*APP_ROOT/,
            'the source-worker fix must not turn the whole backend root into plugin read authority');
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
