/**
 * The build-time half of the plugin block API compatibility layer.
 *
 * `frontend/scripts/generate-verso-plugin-registry.js` turns the plugins on disk into
 * `src/lib/versoPluginRegistry.ts`, the module the editor imports its plugin blocks from. It has to
 * keep working for plugins written BEFORE the editor was renamed to Verso — old manifest key
 * (`frontend.puckComponents`), old folder (`client/puck/<Pascal>Puck.tsx`), old export names
 * (`puckComponents` / `puckComponentDef`). A plugin someone installed months ago must keep showing
 * its blocks with nobody touching it.
 *
 * These tests SPAWN THE REAL SCRIPT over a fixture plugin tree (WORDJS_PLUGINS_DIR /
 * WORDJS_VERSO_REGISTRY_OUT) and read the file it emits. Re-implementing the resolution in the test
 * would prove something about the test, not about the generator that actually ships.
 *
 * Why the emitted TEXT is the assertion: the generator writes `import * as X from "…"` plus exactly
 * ONE static member reference per plugin, and Turbopack hard-errors on a member that is not a real
 * export. Emitting `X.versoComponentDef` for a bundle that exports `puckComponentDef` is therefore
 * not a missing block — it is a broken frontend build.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GENERATOR = path.resolve(__dirname, '../../../scripts/generate-verso-plugin-registry.js');

const SINGLE = (defName: string) => `
export const ${defName} = { category: 'c', fields: {}, defaultProps: {} };
export default function Block() { return null; }
`;
const MULTI = (mapName: string) => `
const R = () => null;
export const ${mapName} = { Alpha: { category: 'c', fields: {}, defaultProps: {}, render: R } };
`;

type Plugin = { slug: string; frontend?: Record<string, unknown>; files: Record<string, string> };

let root = '';
let outFile = '';
let registry = '';
let generatorOutput = '';

/** Every shape the loader has to survive, in one tree. */
const PLUGINS: Plugin[] = [
    // ── legacy, exactly as a plugin published before the rename looks on disk ──────────────────
    {
        slug: 'legacy-manifest',
        frontend: { puckComponents: { entry: 'client/puck/LegacyManifestPuck.tsx' } },
        files: { 'client/puck/LegacyManifestPuck.tsx': SINGLE('puckComponentDef') },
    },
    {
        // No manifest key at all: discovered purely by the old folder convention.
        slug: 'legacy-convention',
        frontend: {},
        files: { 'client/puck/LegacyConventionPuck.tsx': SINGLE('puckComponentDef') },
    },
    {
        slug: 'legacy-multi',
        frontend: { puckComponents: { entry: 'client/puck/LegacyMultiPuck.tsx' } },
        files: { 'client/puck/LegacyMultiPuck.tsx': MULTI('puckComponents') },
    },
    // ── current spelling ───────────────────────────────────────────────────────────────────────
    {
        slug: 'modern-manifest',
        frontend: { versoComponents: { entry: 'client/verso/ModernManifestVerso.tsx' } },
        files: { 'client/verso/ModernManifestVerso.tsx': SINGLE('versoComponentDef') },
    },
    {
        slug: 'modern-convention',
        frontend: {},
        files: { 'client/verso/ModernConventionVerso.tsx': SINGLE('versoComponentDef') },
    },
    {
        slug: 'modern-multi',
        frontend: { versoComponents: { entry: 'client/verso/ModernMultiVerso.tsx' } },
        files: { 'client/verso/ModernMultiVerso.tsx': MULTI('versoComponents') },
    },
    // ── precedence: both spellings present, on both axes ───────────────────────────────────────
    {
        slug: 'both-keys',
        frontend: {
            puckComponents: { entry: 'client/puck/BothKeysPuck.tsx' },
            versoComponents: { entry: 'client/verso/BothKeysVerso.tsx' },
        },
        files: {
            'client/puck/BothKeysPuck.tsx': SINGLE('puckComponentDef'),
            'client/verso/BothKeysVerso.tsx': SINGLE('versoComponentDef'),
        },
    },
    {
        slug: 'both-folders',
        frontend: {},
        files: {
            'client/puck/BothFoldersPuck.tsx': SINGLE('puckComponentDef'),
            'client/verso/BothFoldersVerso.tsx': SINGLE('versoComponentDef'),
        },
    },
    // ── plugins that ship NO block: neither may appear in the registry ────────────────────────
    {
        slug: 'backend-only',
        files: { 'index.js': 'module.exports = {};' },
    },
    {
        // The `"puckComponents": null` + `components[]` shape (video-gallery). That components entry
        // exports neither block shape, so importing it would be a hard Turbopack build error.
        slug: 'components-channel',
        frontend: { versoComponents: null, components: [{ entry: 'client/components/Carousel.tsx' }] },
        files: { 'client/components/Carousel.tsx': 'export default function C() { return null; }' },
    },
];

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-registry-gen-'));
    outFile = path.join(root, 'versoPluginRegistry.ts');
    for (const p of PLUGINS) {
        const dir = path.join(root, 'plugins', p.slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: p.slug, name: p.slug, version: '1.0.0', isolated: true,
            ...(p.frontend ? { frontend: p.frontend } : {}),
        }, null, 2));
        for (const [rel, src] of Object.entries(p.files)) {
            const f = path.join(dir, rel);
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, src);
        }
    }
    const r = spawnSync(process.execPath, [GENERATOR], {
        encoding: 'utf8',
        env: {
            ...process.env,
            WORDJS_PLUGINS_DIR: path.join(root, 'plugins'),
            WORDJS_VERSO_REGISTRY_OUT: outFile,
            // Every fixture plugin is "active"; without this the script would try to reach the dev
            // backend over HTTP and include everything on disk anyway, but slowly and flakily.
            WORDJS_ACTIVE_PLUGINS: JSON.stringify(PLUGINS.map((p) => p.slug)),
        },
    });
    generatorOutput = `${r.stdout || ''}${r.stderr || ''}`;
    expect(r.status, `generator failed:\n${generatorOutput}`).toBe(0);
    registry = fs.readFileSync(outFile, 'utf8');
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The single static member reference the registry emits for a plugin.
 * MULTI is a bare spread at the top of an entry line (`    ...XBlocks.versoComponents,`); SINGLE is a
 * spread NESTED inside a `"Pascal": { … }` object, so the multi probe is anchored to the start of the
 * line — otherwise it also matches the single form and every shape reads as multi.
 */
function memberRefFor(pascal: string): string {
    const single = new RegExp(`"${pascal}": \\{\\s*\\.\\.\\.${pascal}Blocks\\.([A-Za-z0-9_]+),`).exec(registry);
    if (single) return single[1];
    const multi = new RegExp(`^\\s*\\.\\.\\.${pascal}Blocks\\.([A-Za-z0-9_]+),`, 'm').exec(registry);
    return multi ? `...${multi[1]}` : '';
}

describe('generate-verso-plugin-registry — plugins published BEFORE the rename still register', () => {
    it('legacy manifest key (frontend.puckComponents) is honoured', () => {
        expect(registry).toContain('backend/plugins/legacy-manifest/client/puck/LegacyManifestPuck');
        expect(memberRefFor('LegacyManifest')).toBe('puckComponentDef');
    });

    it('legacy folder convention (client/puck/<Pascal>Puck.tsx) is still discovered', () => {
        expect(registry).toContain('backend/plugins/legacy-convention/client/puck/LegacyConventionPuck');
        expect(memberRefFor('LegacyConvention')).toBe('puckComponentDef');
    });

    it('a legacy MULTI bundle is spread under its own export name', () => {
        expect(memberRefFor('LegacyMulti')).toBe('...puckComponents');
    });

    it('the generator ANNOUNCES the deprecation instead of failing', () => {
        expect(generatorOutput).toMatch(/DEPRECATED/);
        expect(generatorOutput).toMatch(/puckComponents/);
        expect(generatorOutput).toMatch(/client\/puck/);
    });
});

describe('generate-verso-plugin-registry — the current spelling', () => {
    it('manifest key frontend.versoComponents is honoured', () => {
        expect(registry).toContain('backend/plugins/modern-manifest/client/verso/ModernManifestVerso');
        expect(memberRefFor('ModernManifest')).toBe('versoComponentDef');
    });

    it('folder convention client/verso/<Pascal>Verso.tsx is discovered', () => {
        expect(registry).toContain('backend/plugins/modern-convention/client/verso/ModernConventionVerso');
        expect(memberRefFor('ModernConvention')).toBe('versoComponentDef');
    });

    it('a modern MULTI bundle is spread under its own export name', () => {
        expect(memberRefFor('ModernMulti')).toBe('...versoComponents');
    });
});

describe('generate-verso-plugin-registry — precedence and exclusions', () => {
    it('with BOTH manifest keys, the verso one wins', () => {
        expect(registry).toContain('both-keys/client/verso/BothKeysVerso');
        expect(registry).not.toContain('both-keys/client/puck/BothKeysPuck');
        expect(memberRefFor('BothKeys')).toBe('versoComponentDef');
    });

    it('with BOTH conventional folders, client/verso wins', () => {
        expect(registry).toContain('both-folders/client/verso/BothFoldersVerso');
        expect(registry).not.toContain('both-folders/client/puck/BothFoldersPuck');
    });

    it('a backend-only plugin contributes nothing', () => {
        expect(registry).not.toContain('backend-only');
    });

    it('the legacy frontend.components[] channel is NOT imported as a block', () => {
        // It exports neither block shape; importing it would break the frontend build outright
        // rather than merely omit a block.
        expect(registry).not.toContain('components-channel');
    });

    it('emits exactly one entry per block-bearing plugin and nothing else', () => {
        // 8 of the 10 fixtures ship a block; backend-only and components-channel do not.
        const imports = registry.match(/^import \* as /gm) || [];
        expect(imports).toHaveLength(8);
        expect(registry).toContain('export const versoPluginComponents');
    });
});
