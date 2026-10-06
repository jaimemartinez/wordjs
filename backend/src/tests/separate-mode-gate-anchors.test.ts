/**
 * WordJS — the separate-mode lab gate's SELF-TEST still has something to sabotage.
 *
 * scripts/separate-mode-gate.mjs proves it is not decorative by reverting one fix at a time in the
 * deployed tree (`--sabotage install-host | install-identity | public-route`) and going red on the
 * matching check. Each revert is an exact-substring edit that aborts with "ANCHOR NOT FOUND" when the
 * code moved on — and all three had: install-host anchored on pickInstallHost (gone with the host-policy
 * redesign), install-identity on an argument list setup.ts no longer has, public-route on a gateway file
 * that no longer holds the role allowlist. The proof the hard rule asks for silently stopped running.
 *
 * This test needs no lab: it compiles the backend sources the way the release does (tsconfig.build.json,
 * one file at a time), applies every patch of SABOTAGE_PATCHES to the text that would ship, and checks
 * the anchor is there, the patched file still parses, and — for install-host — that the patched
 * expression really brings bug 1 back: behind the gateway (a trusted hop that rewrites Host), the
 * install address becomes the backend's own instead of the public one.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BACKEND = path.join(REPO, 'backend');
const GATE = path.join(REPO, 'scripts', 'separate-mode-gate.mjs');

// A real dynamic import (ts-node compiles `import()` to require(), which an .mjs may refuse).
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

let PATCHES: Record<string, Array<{ node: string; file: string; from: string; to: string }>> = {};

before(async () => {
    PATCHES = (await importEsm(pathToFileURL(GATE).href)).SABOTAGE_PATCHES;
});

/** The compiler options the release build uses (tsconfig.build.json extends tsconfig.json). */
function buildOptions() {
    const configFile = path.join(BACKEND, 'tsconfig.build.json');
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    assert.ok(!read.error, 'tsconfig.build.json must parse');
    return ts.parseJsonConfigFileContent(read.config, ts.sys, BACKEND, undefined, configFile).options;
}

/** The text the deployed tree holds at `file` (relative to the app root). */
function shippedText(file: string): string {
    const dist = /^backend\/dist\/(.+)\.js$/.exec(file);
    if (dist) {
        const source = path.join(BACKEND, 'src', `${dist[1]}.ts`);
        return ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: buildOptions(), fileName: source }).outputText;
    }
    return fs.readFileSync(path.join(REPO, ...file.split('/')), 'utf8');
}

describe('every sabotage of the separate-mode gate still applies to the code that ships', () => {
    test('the gate exports its patches and runs nothing when imported', () => {
        assert.deepStrictEqual(Object.keys(PATCHES).sort(), ['install-host', 'install-identity', 'public-route']);
    });

    for (const name of ['install-host', 'install-identity', 'public-route']) {
        test(`${name}: every anchor is present, and the patched file still parses`, () => {
            const patches = PATCHES[name];
            assert.ok(Array.isArray(patches) && patches.length > 0, `no patches for ${name}`);
            for (const p of patches) {
                const src = shippedText(p.file);
                assert.ok(src.includes(p.from), `ANCHOR NOT FOUND in ${p.file}: ${p.from}`);
                const patched = src.split(p.from).join(p.to);
                assert.notStrictEqual(patched, src);
                assert.ok(!patched.includes(p.from) || p.to.includes(p.from), `${p.file}: the anchor survives the patch`);
                // Compiles as the CommonJS module it is, without running it.
                assert.doesNotThrow(() => new vm.Script(`(function (exports, require, module, __filename, __dirname) {${patched}\n})`, { filename: p.file }),
                    `${p.file} no longer parses after the ${name} patch`);
            }
        });
    }

    test('install-host really brings bug 1 back: behind the gateway, the backend\'s own address', () => {
        const hostPolicy = require('../core/host-policy');
        const [p] = PATCHES['install-host'];
        const evaluate = (expr: string, req: any) => new Function('hostPolicy', 'req', 'policy', `return ${expr};`)(hostPolicy, req, {});
        // The gateway's mTLS identity (a trusted hop) rewrote Host to the backend's address (changeOrigin)
        // and carries the address the operator used in X-Forwarded-Host.
        const req = {
            headers: { host: '10.0.0.21:4000', 'x-forwarded-host': '10.0.0.20:3000' },
            socket: { authorized: true, remoteAddress: '10.0.0.20', getPeerCertificate: () => ({ subject: { CN: 'gateway' } }) },
        };
        const fixed = evaluate(p.from, req);
        assert.strictEqual(fixed.source, 'x-forwarded-host');
        assert.strictEqual(hostPolicy.serialize(fixed.parsed), '10.0.0.20:3000', 'unpatched: the public address');
        const broken = evaluate(p.to, req);
        assert.strictEqual(broken.source, 'host');
        assert.strictEqual(hostPolicy.serialize(broken.parsed), '10.0.0.21:4000', 'patched: the backend records itself — bug 1');
    });
});
