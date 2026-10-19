import { describe, test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

const { sandboxPaths, storageKey } = require('../core/sandbox-paths');

describe('shared native sandbox filesystem authority', () => {
    const root = path.resolve(path.join(path.sep, 'srv', 'wordjs', 'backend'));
    const core = path.join(root, 'dist', 'core');

    test('never grants the install root or shared mutable roots', () => {
        const p = sandboxPaths(root, 'alpha', core);
        assert.deepStrictEqual(p.readOnly, [core, path.join(root, 'node_modules'), path.join(root, 'plugins', 'alpha')]);
        assert.ok(!p.readOnly.includes(root));
        for (const shared of ['uploads', 'data', 'logs', 'os-tmp', 'themes']) {
            assert.ok(!p.writable.includes(path.join(root, shared)), `${shared} root must not be writable`);
        }
        assert.ok(!p.readOnly.some((entry: string) => /wordjs-config|\.sqlite|\.db$/i.test(entry)));
    });

    test('private storage is deterministic, collision-resistant and disjoint between plugins', () => {
        const a = sandboxPaths(root, 'alpha', core);
        const a2 = sandboxPaths(root, 'alpha', core);
        const b = sandboxPaths(root, 'beta', core);
        assert.deepStrictEqual(a.storage, a2.storage);
        assert.strictEqual(new Set(a.storage).size, 3);
        assert.ok(!a.storage.some((entry: string) => b.storage.includes(entry)));
        assert.notStrictEqual(storageKey('theme:alpha'), storageKey('theme-alpha'));
        for (const entry of a.storage) assert.ok(entry.includes(`${path.sep}plugins${path.sep}${storageKey('alpha')}`));
    });

    test('plugin and theme ownership remain narrow and traversal is not read authority', () => {
        const plugin = sandboxPaths(root, 'alpha', core);
        const theme = sandboxPaths(root, 'theme:aurora', core);
        assert.strictEqual(plugin.own, path.join(root, 'plugins', 'alpha'));
        assert.strictEqual(theme.own, path.join(root, 'themes', 'aurora'));
        assert.ok(plugin.traverse.includes(root));
        assert.ok(!plugin.readOnly.includes(root));
        assert.ok(!plugin.writable.includes(theme.own));
    });

    test('multisite: another site\'s worker has its own storage and never writes the shared code directory', () => {
        const main = sandboxPaths(root, 'alpha', core);
        const two = sandboxPaths(root, 'alpha', core, 2);
        const three = sandboxPaths(root, 'alpha', core, 3);
        assert.strictEqual(main.ownWritable, true);
        assert.ok(main.writable.includes(main.own), 'site 1 keeps its historical write floor');
        assert.deepStrictEqual(sandboxPaths(root, 'alpha', core, 1), main, 'site 1 is exactly the single-site answer');
        assert.strictEqual(two.own, main.own, 'the code is shared');
        assert.ok(two.readOnly.includes(two.own), 'and readable');
        assert.strictEqual(two.ownWritable, false);
        assert.ok(!two.writable.includes(two.own), 'but never writable from another site');
        // Every site has a non-empty write set: the native launch needs at least one zone to exist.
        assert.ok(two.writable.length > 0);
        assert.ok(!two.storage.some((e: string) => main.storage.includes(e) || three.storage.includes(e)), 'storage never shared across sites');
    });

    test('invalid internal identities fail closed before becoming kernel paths', () => {
        for (const bad of ['', '.', '..', '../alpha', 'alpha/beta', 'alpha\\beta', '/absolute', 'theme:', 'theme:../x']) {
            assert.throws(() => sandboxPaths(root, bad, core), /invalid isolated-plugin slug/);
        }
    });
});
