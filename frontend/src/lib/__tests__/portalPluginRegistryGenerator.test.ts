/**
 * THE PORTAL REGISTRY GENERATOR (scripts/generate-portal-plugin-registry.js) — what /portal/<slug> compiles in.
 *
 * Its output, src/lib/portalPluginRegistry.ts, is generated and gitignored, so the generator's output is
 * the thing to pin: an ACTIVE plugin's frontend.portalPage maps its portal slug to a dynamic import of its
 * entry; nothing else does. The manifest is plugin-controlled text written into TypeScript source, so a
 * slug or entry outside the shape core/portal-pages.ts accepts must be dropped, never quoted into code —
 * and a slug two plugins claim must be nobody's, as the backend resolves it.
 *
 * The generator runs for real, in a sandbox laid out like the repo, with the active list passed through
 * the same env var the backend uses — so it asks no backend anything.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FRONTEND_DIR = path.resolve(__dirname, '../../..');
const OUT_REL = path.join('src', 'lib', 'portalPluginRegistry.ts');

const sandboxes: string[] = [];
afterEach(() => {
    while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

type Probe = { folder: string; portalPage: unknown; files?: string[] };

function generate(probes: Probe[], active: string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-portal-gen-'));
    sandboxes.push(root);
    fs.mkdirSync(path.join(root, 'frontend', 'scripts'), { recursive: true });
    for (const f of ['generate-portal-plugin-registry.js', 'hermetic-plugins.js']) {
        fs.copyFileSync(path.join(FRONTEND_DIR, 'scripts', f), path.join(root, 'frontend', 'scripts', f));
    }
    fs.copyFileSync(path.join(FRONTEND_DIR, 'hermetic-build.js'), path.join(root, 'frontend', 'hermetic-build.js'));
    for (const p of probes) {
        const dir = path.join(root, 'backend', 'plugins', p.folder);
        fs.mkdirSync(path.join(dir, 'client', 'portal'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: p.folder, name: p.folder, version: '1.0.0', frontend: { portalPage: p.portalPage },
        }));
        for (const rel of p.files || ['client/portal/page.tsx']) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), 'export default function P() { return null; }\n');
        }
    }
    const env: NodeJS.ProcessEnv = { ...process.env, WORDJS_ACTIVE_PLUGINS: JSON.stringify(active) };
    delete env.WORDJS_HERMETIC_BUILD;
    const r = spawnSync(process.execPath, [path.join(root, 'frontend', 'scripts', 'generate-portal-plugin-registry.js')], {
        cwd: path.join(root, 'frontend'), encoding: 'utf8', env,
    });
    expect(r.status, `generator failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    return fs.readFileSync(path.join(root, 'frontend', OUT_REL), 'utf8');
}

/** The slug → import specifier pairs of a generated registry. */
function entries(source: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of source.matchAll(/^ {4}("(?:[^"\\]|\\.)*"): \(\) => import\(("(?:[^"\\]|\\.)*")\),$/gm)) {
        out[JSON.parse(m[1])] = JSON.parse(m[2]);
    }
    return out;
}

describe('generate-portal-plugin-registry', () => {
    it('maps an active plugin\'s portal slug to its entry, as a client module', () => {
        const src = generate([
            { folder: 'field-portal', portalPage: { entry: 'client/portal/page.tsx', slug: 'field-portal' } },
            { folder: 'conference-manager', portalPage: { entry: './client/portal/page.tsx', slug: 'conference' } },
        ], ['field-portal', 'conference-manager']);
        expect(src.startsWith('"use client";')).toBe(true);
        expect(entries(src)).toEqual({
            conference: '../../../backend/plugins/conference-manager/client/portal/page',
            'field-portal': '../../../backend/plugins/field-portal/client/portal/page',
        });
    });

    it('leaves out an inactive plugin, and one whose entry file is missing', () => {
        const src = generate([
            { folder: 'inactive-one', portalPage: { entry: 'client/portal/page.tsx', slug: 'inactive-one' } },
            { folder: 'no-file', portalPage: { entry: 'client/portal/Missing.tsx', slug: 'no-file' } },
        ], ['no-file']);
        expect(entries(src)).toEqual({});
    });

    it('drops a slug or entry outside the accepted shape instead of writing it into the source', () => {
        const src = generate([
            { folder: 'evil-slug', portalPage: { entry: 'client/portal/page.tsx', slug: 'x"),alert(1);("' } },
            { folder: 'evil-entry', portalPage: { entry: 'client/portal/x");alert(1);("y.tsx', slug: 'evil-entry' } },
            { folder: 'escape', portalPage: { entry: 'client/../../../outside.tsx', slug: 'escape' }, files: ['client/portal/page.tsx'] },
            { folder: 'not-object', portalPage: 'client/portal/page.tsx' },
        ], ['evil-slug', 'evil-entry', 'escape', 'not-object']);
        expect(entries(src)).toEqual({});
        expect(src).not.toContain('alert');
        expect(src).not.toContain('outside');
    });

    it('a portal slug two active plugins declare is nobody\'s', () => {
        const src = generate([
            { folder: 'first', portalPage: { entry: 'client/portal/page.tsx', slug: 'shared' } },
            { folder: 'second', portalPage: { entry: 'client/portal/page.tsx', slug: 'shared' } },
            { folder: 'third', portalPage: { entry: 'client/portal/page.tsx', slug: 'own' } },
        ], ['first', 'second', 'third']);
        expect(entries(src)).toEqual({ own: '../../../backend/plugins/third/client/portal/page' });
    });
});
