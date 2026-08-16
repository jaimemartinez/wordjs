/**
 * The plugin BLOCK API compatibility layer — the promise that renaming the editor to Verso does not
 * break a single plugin already published or installed out there.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A compatibility layer nobody exercises is a promise, not a behaviour. The rename touched three
 * plugin-facing names at once:
 *
 *      manifest key   frontend.versoComponents        ←  frontend.puckComponents
 *      folder         client/verso/<Pascal>Verso.tsx  ←  client/puck/<Pascal>Puck.tsx
 *      exports        versoComponents/versoComponentDef ← puckComponents/puckComponentDef
 *
 * Every one of them is read in BOTH spellings, new first, by backend/scripts/plugin-block-contract.js.
 * The tests below drive that resolver AND the real build-plugin.js over fixture plugins written the
 * OLD way, so a regression shows up as a red test instead of as a plugin whose blocks silently
 * vanish from the editor.
 *
 * The registry-generator half of the same promise (which member name the generated
 * versoPluginRegistry.ts references) is proved in
 * frontend/src/lib/__tests__/versoRegistryGenerator.test.ts, which runs the shipping generator script.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BUILD_PLUGIN = path.resolve(__dirname, '../../scripts/build-plugin.js');
const contract = require('../../scripts/plugin-block-contract');

type Fixture = {
    slug: string;
    /** manifest.frontend, verbatim */
    frontend?: Record<string, unknown>;
    /** relative path → file contents */
    files: Record<string, string>;
};

const BLOCK_SRC = (defName: string) => `
    import { useState } from 'react';
    export const ${defName} = { label: 'B', category: 'content', fields: {}, defaultProps: {} };
    export default function Block() { const [n] = useState(0); return <div className="b">{n}</div>; }
`;

const MULTI_SRC = (mapName: string) => `
    const R = () => null;
    export const ${mapName} = { Alpha: { category: 'c', fields: {}, defaultProps: {}, render: R } };
`;

function writeFixture(root: string, f: Fixture): string {
    const dir = path.join(root, f.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: f.slug, name: f.slug, version: '1.0.0', isolated: true,
        ...(f.frontend ? { frontend: f.frontend } : {}),
    }, null, 2));
    for (const [rel, src] of Object.entries(f.files)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, src);
    }
    return dir;
}

function build(root: string, slug: string): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [BUILD_PLUGIN, slug], {
        env: { ...process.env, WORDJS_PLUGINS_DIR: root }, encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function withTmp(fn: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-block-contract-'));
    try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ───────────────────────────────────────────────── A. the resolver: which spelling wins, and when

describe('plugin-block-contract — manifest key resolution', () => {
    test('the NEW key wins when a manifest carries both', () => {
        contract.resetDeprecationWarnings();
        const r = contract.readDeclaredBlockEntry({
            id: 'x',
            frontend: {
                puckComponents: { entry: 'client/puck/XPuck.tsx' },
                versoComponents: { entry: 'client/verso/XVerso.tsx' },
            },
        });
        assert.deepStrictEqual(r, { entry: 'client/verso/XVerso.tsx', key: 'versoComponents', legacy: false });
    });

    test('the LEGACY key alone still resolves — this is the whole promise', () => {
        const r = contract.readDeclaredBlockEntry({ id: 'x', frontend: { puckComponents: { entry: 'client/puck/XPuck.tsx' } } });
        assert.deepStrictEqual(r, { entry: 'client/puck/XPuck.tsx', key: 'puckComponents', legacy: true });
    });

    test('a key present with a null value is "ships no block", not a declaration', () => {
        // video-gallery says exactly this. Treating it as a declaration would turn it into a
        // "declared entry whose file is missing" build FAILURE.
        assert.strictEqual(contract.readDeclaredBlockEntry({ id: 'x', frontend: { puckComponents: null } }), null);
        assert.strictEqual(contract.readDeclaredBlockEntry({ id: 'x', frontend: { versoComponents: null } }), null);
        assert.strictEqual(contract.readDeclaredBlockEntry({ id: 'x', frontend: {} }), null);
        assert.strictEqual(contract.readDeclaredBlockEntry({}), null);
    });

    test('the legacy key emits a DEPRECATION line — a warning, never an error', () => {
        withTmp((root) => {
            contract.resetDeprecationWarnings();
            const lines: string[] = [];
            const original = console.warn;
            console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
            try {
                const r = contract.resolveBlockEntry(root, { id: 'legacy-plugin', frontend: { puckComponents: { entry: 'client/puck/A.tsx' } } });
                // Resolved (not rejected) …
                assert.strictEqual(r.entry, 'client/puck/A.tsx');
                assert.strictEqual(r.legacy, true);
                assert.strictEqual(r.declared, true);
                // … and announced exactly once, naming both the old and the new key.
                assert.strictEqual(lines.length, 1, `expected one warning, got ${JSON.stringify(lines)}`);
                assert.match(lines[0], /DEPRECATED/);
                assert.match(lines[0], /puckComponents/);
                assert.match(lines[0], /versoComponents/);
                // Repeats are suppressed: the resolver runs once per plugin per tool, and a wall of
                // identical lines is how people learn to ignore the one that matters.
                contract.resolveBlockEntry(root, { id: 'legacy-plugin', frontend: { puckComponents: { entry: 'client/puck/A.tsx' } } });
                assert.strictEqual(lines.length, 1);
            } finally { console.warn = original; }
        });
    });

    test('the new key is silent', () => {
        withTmp((root) => {
            contract.resetDeprecationWarnings();
            const lines: string[] = [];
            const original = console.warn;
            console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
            try {
                contract.resolveBlockEntry(root, { id: 'new-plugin', frontend: { versoComponents: { entry: 'client/verso/AVerso.tsx' } } });
                assert.deepStrictEqual(lines, []);
            } finally { console.warn = original; }
        });
    });
});

describe('plugin-block-contract — folder convention resolution', () => {
    test('client/verso/<Pascal>Verso.tsx is tried BEFORE client/puck/<Pascal>Puck.tsx', () => {
        withTmp((root) => {
            contract.resetDeprecationWarnings();
            const dir = writeFixture(root, {
                slug: 'my-plugin',
                files: {
                    'client/puck/MyPluginPuck.tsx': BLOCK_SRC('puckComponentDef'),
                    'client/verso/MyPluginVerso.tsx': BLOCK_SRC('versoComponentDef'),
                },
            });
            const r = contract.resolveBlockEntry(dir, { id: 'my-plugin' });
            assert.strictEqual(r.entry, 'client/verso/MyPluginVerso.tsx');
            assert.strictEqual(r.legacy, false);
            assert.strictEqual(r.viaConvention, true);
            assert.strictEqual(r.declared, false, 'a convention hit is DISCOVERY, never a declaration');
        });
    });

    test('the legacy folder alone still resolves, with a deprecation line', () => {
        withTmp((root) => {
            contract.resetDeprecationWarnings();
            const dir = writeFixture(root, {
                slug: 'old-plugin',
                files: { 'client/puck/OldPluginPuck.tsx': BLOCK_SRC('puckComponentDef') },
            });
            const lines: string[] = [];
            const original = console.warn;
            console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
            let r;
            try { r = contract.resolveBlockEntry(dir, { id: 'old-plugin' }); } finally { console.warn = original; }
            assert.strictEqual(r.entry, 'client/puck/OldPluginPuck.tsx');
            assert.strictEqual(r.legacy, true);
            assert.strictEqual(lines.length, 1);
            assert.match(lines[0], /client\/puck/);
            assert.match(lines[0], /client\/verso/);
        });
    });

    test('no manifest key and no conventional file → null (the plugin simply ships no block)', () => {
        withTmp((root) => {
            const dir = writeFixture(root, { slug: 'backend-only', files: { 'index.js': 'module.exports = {};' } });
            assert.strictEqual(contract.resolveBlockEntry(dir, { id: 'backend-only' }), null);
        });
    });

    test('the pre-Puck frontend.components[] channel is OPT-IN, so the registry generator cannot import it', () => {
        withTmp((root) => {
            const manifest = { id: 'vg', frontend: { versoComponents: null, components: [{ entry: 'client/components/C.tsx' }] } };
            const dir = writeFixture(root, { slug: 'vg', files: { 'client/components/C.tsx': 'export default function C(){return null;}' } });
            // Bundlers opt in — that file has always been compiled into component.bundle.js …
            assert.strictEqual(contract.resolveBlockEntry(dir, manifest, { componentsChannel: true }).entry, 'client/components/C.tsx');
            // … the registry generator does NOT: the file exports neither block shape, so importing
            // it would be a hard Turbopack build error rather than a missing block.
            assert.strictEqual(contract.resolveBlockEntry(dir, manifest), null);
        });
    });
});

describe('plugin-block-contract — export shape detection', () => {
    const cases: Array<[string, string, { multi: boolean; member: string }]> = [
        ['new multi', MULTI_SRC('versoComponents'), { multi: true, member: 'versoComponents' }],
        ['legacy multi', MULTI_SRC('puckComponents'), { multi: true, member: 'puckComponents' }],
        ['new single', BLOCK_SRC('versoComponentDef'), { multi: false, member: 'versoComponentDef' }],
        ['legacy single', BLOCK_SRC('puckComponentDef'), { multi: false, member: 'puckComponentDef' }],
    ];
    for (const [label, src, expected] of cases) {
        test(`${label} is detected and reported by its OWN member name`, () => {
            withTmp((root) => {
                const p = path.join(root, 'entry.tsx');
                fs.writeFileSync(p, src);
                assert.deepStrictEqual(contract.resolveBlockExports(p), expected);
            });
        });
    }

    test('a bundle exporting BOTH names reports the new one', () => {
        withTmp((root) => {
            const p = path.join(root, 'entry.tsx');
            // online-store's real shape: a multi map plus a legacy single def "for tooling that
            // expects the single-block convention".
            fs.writeFileSync(p, `${MULTI_SRC('versoComponents')}\nexport const puckComponentDef = {};`);
            assert.deepStrictEqual(contract.resolveBlockExports(p), { multi: true, member: 'versoComponents' });
        });
    });

    test('an unreadable entry falls back to the historical single shape (pre-rename behaviour)', () => {
        assert.deepStrictEqual(contract.resolveBlockExports('/definitely/not/a/file.tsx'),
            { multi: false, member: 'puckComponentDef' });
    });
});

// ─────────────────────────────────── B. end to end: the REAL builder over an OLD-convention plugin

describe('build-plugin.js — a plugin written the OLD way still builds its block bundle', () => {
    test('legacy manifest key + legacy folder + legacy export name', () => {
        withTmp((root) => {
            const slug = 'legacy-everything';
            const dir = writeFixture(root, {
                slug,
                frontend: { puckComponents: { entry: './client/puck/LegacyEverythingPuck.tsx' } },
                files: { 'client/puck/LegacyEverythingPuck.tsx': BLOCK_SRC('puckComponentDef') },
            });
            const r = build(root, slug);
            assert.strictEqual(r.status, 0, `an already-published plugin must still build: ${r.out}`);
            const out = path.join(dir, 'dist', 'component.bundle.js');
            assert.ok(fs.existsSync(out), 'component.bundle.js must be produced from the LEGACY manifest key');
            assert.match(fs.readFileSync(out, 'utf8'), /puckComponentDef/,
                'the bundle keeps exporting the name the plugin actually wrote');
            // Deprecated, not rejected: the build says so and succeeds anyway.
            assert.match(r.out, /DEPRECATED/, `the build must announce the deprecation; got: ${r.out.slice(0, 400)}`);
        });
    });

    test('no manifest key at all: the legacy client/puck/<Pascal>Puck.tsx convention still builds', () => {
        withTmp((root) => {
            const slug = 'convention-only';
            const dir = writeFixture(root, {
                slug,
                frontend: {},
                files: { 'client/puck/ConventionOnlyPuck.tsx': BLOCK_SRC('puckComponentDef') },
            });
            const r = build(root, slug);
            assert.strictEqual(r.status, 0, `build failed: ${r.out}`);
            assert.ok(fs.existsSync(path.join(dir, 'dist', 'component.bundle.js')),
                'the conventional legacy path must still be discovered');
        });
    });

    test('the NEW convention builds too, and says nothing about deprecation', () => {
        withTmp((root) => {
            const slug = 'modern-plugin';
            const dir = writeFixture(root, {
                slug,
                frontend: { versoComponents: { entry: './client/verso/ModernPluginVerso.tsx' } },
                files: { 'client/verso/ModernPluginVerso.tsx': BLOCK_SRC('versoComponentDef') },
            });
            const r = build(root, slug);
            assert.strictEqual(r.status, 0, `build failed: ${r.out}`);
            assert.ok(fs.existsSync(path.join(dir, 'dist', 'component.bundle.js')));
            assert.doesNotMatch(r.out, /DEPRECATED/, 'the current spelling must not be nagged about');
        });
    });

    test('both keys present: the NEW entry is the one compiled', () => {
        withTmp((root) => {
            const slug = 'both-keys';
            const dir = writeFixture(root, {
                slug,
                frontend: {
                    puckComponents: { entry: './client/puck/BothKeysPuck.tsx' },
                    versoComponents: { entry: './client/verso/BothKeysVerso.tsx' },
                },
                files: {
                    'client/puck/BothKeysPuck.tsx': BLOCK_SRC('puckComponentDef'),
                    'client/verso/BothKeysVerso.tsx': BLOCK_SRC('versoComponentDef'),
                },
            });
            const r = build(root, slug);
            assert.strictEqual(r.status, 0, `build failed: ${r.out}`);
            const code = fs.readFileSync(path.join(dir, 'dist', 'component.bundle.js'), 'utf8');
            assert.match(code, /versoComponentDef/, 'the new key must win');
            assert.doesNotMatch(code, /puckComponentDef/, 'the legacy entry must not be the one compiled');
        });
    });
});

// ─────────────────────────────────────────── C. the catalog must not lose a migrated plugin's badge

describe('the marketplace catalog counts BOTH manifest spellings as "ships a block"', () => {
    test('readDeclaredBlockEntry is what build-marketplace derives hasVersoBlock from', () => {
        // Guards the regression the rename would otherwise have caused: build-marketplace read the
        // literal `fe.puckComponents`, so migrating the 24 catalog plugins would have flipped every
        // hasPuckBlock to false and the marketplace UI would have quietly dropped the block badge.
        const src = fs.readFileSync(path.resolve(__dirname, '../../scripts/build-marketplace.js'), 'utf8');
        assert.match(src, /readDeclaredBlockEntry/, 'the catalog must derive the flag from the shared resolver');
        assert.doesNotMatch(src, /fe\.puckComponents/, 'no literal single-spelling read may come back');
        assert.match(src, /hasVersoBlock:/);
        assert.match(src, /hasPuckBlock:/, 'the deprecated mirror stays for installs running an older frontend');
    });
});
