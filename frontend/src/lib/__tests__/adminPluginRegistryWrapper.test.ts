/**
 * The generated plugin admin page (frontend/scripts/generate-admin-plugin-registry.js →
 * src/app/admin/plugin/[slug]/page.tsx) wraps every plugin screen in the element that SCROLLS it.
 *
 * On an iPhone, reaching the end of that scroller chained the drag to the document, which Safari
 * rubber-banded — the admin header slid down with the page. The wrapper now contains vertical
 * overscroll (`overscroll-y-contain`). The page is generated and untracked, so the generator is what has
 * to say it: this runs the REAL script on a sandbox plugin and reads what it wrote.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

const FRONTEND_DIR = path.resolve(__dirname, '../../..');
const roots: string[] = [];

afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A checkout laid out like the repo (the generator finds backend/plugins relative to itself) with one admin plugin. */
function sandbox(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-admin-registry-'));
    roots.push(root);
    fs.cpSync(path.join(FRONTEND_DIR, 'scripts'), path.join(root, 'frontend', 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(FRONTEND_DIR, 'hermetic-build.js'), path.join(root, 'frontend', 'hermetic-build.js'));
    const plugin = path.join(root, 'backend', 'plugins', 'demo-plugin');
    fs.mkdirSync(path.join(plugin, 'client', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({
        id: 'demo-plugin', name: 'Demo', version: '1.0.0',
        frontend: { adminPage: { entry: './client/admin/page.tsx', slug: 'demo' } },
    }));
    fs.writeFileSync(path.join(plugin, 'client', 'admin', 'page.tsx'), 'export default function Page() { return null; }\n');
    return root;
}

function generate(root: string): string {
    const env: NodeJS.ProcessEnv = { ...process.env, WORDJS_ACTIVE_PLUGINS: JSON.stringify(['demo-plugin']) };
    delete env.WORDJS_HERMETIC_BUILD;
    const r = spawnSync(process.execPath, [path.join(root, 'frontend', 'scripts', 'generate-admin-plugin-registry.js')], {
        cwd: path.join(root, 'frontend'), encoding: 'utf8', env,
    });
    expect(r.status, `generator failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    return fs.readFileSync(path.join(root, 'frontend', 'src', 'app', 'admin', 'plugin', '[slug]', 'page.tsx'), 'utf8');
}

describe('generated plugin admin page', () => {
    it('contains vertical overscroll on the wrapper that scrolls the plugin screen', () => {
        const page = generate(sandbox());
        const wrapper = /className=\{`(plugin-admin-wrapper [^`]*)`\}/.exec(page);
        expect(wrapper, 'the generated page has no plugin-admin-wrapper element').not.toBeNull();
        const classes = wrapper![1].split(/\s+/);
        expect(classes).toEqual(expect.arrayContaining(['h-full', 'overflow-y-auto', 'overscroll-y-contain']));
        // Vertical only: containing x on the scroller would swallow the browser's back/forward swipe.
        expect(classes).not.toContain('overscroll-contain');
        expect(classes).not.toContain('overscroll-x-contain');
    });

    it('is still a valid TSX module (the generator emits code, so a typo there breaks the build)', () => {
        const page = generate(sandbox());
        const out = ts.transpileModule(page, {
            reportDiagnostics: true,
            compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
            fileName: 'page.tsx',
        });
        expect(out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')) ?? []).toEqual([]);
        expect(page).toContain('"demo": () => import(');
    });
});
