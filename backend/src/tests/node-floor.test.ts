/**
 * ONE Node.js floor, declared everywhere it is enforced.
 *
 * WordJS requires Node >= 22 (graphql 17 and the native modules declare it; Node 20 reached end of life
 * in April 2026). The floor lives in six manifests, five lockfiles and five entry-point preflights. A
 * floor raised in one place and not another lets an unsupported runtime past `npm install` and into a
 * crash mid-boot, or refuses a supported one.
 *
 * The preflights are RUN: each entry file is started with a preload that makes the process report
 * Node 20, and must exit 1 with the floor in its message before it does anything else (no server, no
 * file written; a timeout would mean it went on to boot). The pass side is checked on the source: the
 * one comparison every preflight makes is against 22.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../..');
const FLOOR = '>=22.0.0';

const MANIFESTS = ['package.json', 'backend/package.json', 'frontend/package.json', 'gateway/package.json', 'setup/package.json', 'packages/create-wordjs/package.json'];
const LOCKFILES = ['package-lock.json', 'backend/package-lock.json', 'frontend/package-lock.json', 'gateway/package-lock.json', 'setup/package-lock.json'];
const PREFLIGHTS = ['monolith.js', 'gateway/src/index.js', 'backend/server.js', 'setup/index.js', 'packages/create-wordjs/index.js'];

describe('the Node.js floor', () => {
    it('every manifest, and the root entry of every lockfile, declares the same floor', () => {
        for (const f of MANIFESTS) {
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8')).engines.node, FLOOR, f);
        }
        for (const f of LOCKFILES) {
            assert.strictEqual(JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8')).packages[''].engines.node, FLOOR, f);
        }
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-node-floor-'));
    const preload = path.join(dir, 'fake-node-20.js');
    fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '20.18.0' });\n");

    for (const f of PREFLIGHTS) {
        it(`${f} refuses Node 20 before doing anything else, and compares against 22`, () => {
            const r = spawnSync(process.execPath, ['-r', preload, path.join(REPO, f), '--install'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
            assert.strictEqual(r.status, 1, `${f} did not refuse Node 20 (status ${r.status}, signal ${r.signal}): ${r.stderr}`);
            assert.match(r.stderr, /WordJS requires Node\.js >= 22 — you are running 20\.18\.0/);
            const src = fs.readFileSync(path.join(REPO, f), 'utf8');
            assert.match(src, /process\.versions\.node\.split\('\.'\)\[0\]\)(\s*;\s*\n\s*if \(maj)?\s*<\s*22\)/, `${f}: the preflight does not compare the major version against 22`);
        });
    }

    it('cleans up', () => fs.rmSync(dir, { recursive: true, force: true }));
});
