/**
 * io-guard's module-resolution exemption covers only the folders Node's resolver actually reaches.
 *
 * Reads of anything under a path with a `node_modules` segment used to be allowed to every plugin, and
 * exempted from a refused `filesystem:read` - wherever that segment was: inside the plugin's own data, in
 * a folder it created, under another tree on the disk. The sibling-plugin check also compared names
 * case-sensitively, which Windows and macOS do not. Now the exemption is `<a>/node_modules` for the
 * plugin's own directory and its ancestors (require()'s lookup paths) plus the backend's own, compared
 * case-folded like every other io-guard path.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

require('../config/app');
const io = require('../core/io-guard');
const { runWithContext } = require('../core/plugin-context');
const { prepareOwnDataLink } = require('../core/plugin-own-data');
const { ownDataDir } = require('../core/sandbox-paths');

const ROOT = path.resolve(__dirname, '..', '..');
const SLUG = `nm-resolve-${process.pid}`;
const SIB = `nm-sibling-${process.pid}`;
const own = path.join(ROOT, 'plugins', SLUG);
const sib = path.join(ROOT, 'plugins', SIB);
for (const d of [own, sib]) {
    fs.mkdirSync(path.join(d, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: path.basename(d), permissions: [{ scope: 'filesystem', access: 'read' }] }));
    fs.writeFileSync(path.join(d, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
}
prepareOwnDataLink(ROOT, SLUG);
fs.mkdirSync(path.join(own, 'data', 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(own, 'data', 'node_modules', 'state.json'), '{"secret":true}');
after(() => {
    for (const d of [own, sib, ownDataDir(ROOT, SLUG), ownDataDir(ROOT, SIB)]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
});

const read = (p: string) => runWithContext(SLUG, () => io.isPathSafe(p, false));

test('its own node_modules and the backend\'s resolve', () => {
    assert.strictEqual(read(path.join(own, 'node_modules', 'dep', 'index.js')), true);
    assert.strictEqual(read(path.join(ROOT, 'node_modules', 'express', 'package.json')), true);
});

test('a node_modules folder anywhere else is just a folder name', () => {
    assert.strictEqual(read(path.join(ROOT, 'data', 'plugins', 'someone-else', 'node_modules', 'x.json')), false, 'another plugin\'s private storage');
    assert.strictEqual(read(path.join(ROOT, 'logs', 'node_modules', 'x.log')), false);
    assert.strictEqual(read(path.join(path.parse(ROOT).root, 'elsewhere', 'node_modules', 'x.txt')), false);
});

test('a sibling plugin\'s tree stays closed, in any letter case', () => {
    assert.strictEqual(read(path.join(sib, 'node_modules', 'dep', 'index.js')), false);
    if (process.platform !== 'linux') {
        assert.strictEqual(read(path.join(ROOT, 'PLUGINS', SIB.toUpperCase(), 'node_modules', 'dep', 'index.js')), false,
            'a case variant of a sibling\'s path is the same folder on this filesystem');
    }
});

test('a refused filesystem:read is not bypassed by naming a data folder node_modules', () => {
    // The plugin declared filesystem:read and the administrator did not grant it: its own data is refused,
    // and a `node_modules` segment inside that data must not turn the read into a module-loader read.
    assert.strictEqual(io.isModuleLoaderRead(path.join(own, 'data', 'node_modules', 'state.json'), false, own), false);
    assert.strictEqual(read(path.join(own, 'data', 'node_modules', 'state.json')), false);
    assert.strictEqual(io.isModuleLoaderRead(path.join(own, 'node_modules', 'dep', 'index.js'), false, own), true, 'its real dependencies still load');
});
