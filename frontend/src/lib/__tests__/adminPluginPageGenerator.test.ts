/**
 * THE GENERATED ADMIN PLUGIN PAGE ASKS AN AUTHENTICATED ENDPOINT FOR ITS STYLING.
 *
 * frontend/src/app/admin/plugin/[slug]/page.tsx is GENERATED (gitignored) by
 * scripts/generate-admin-plugin-registry.js, so the generator's output is the thing to pin. That page
 * used to fetch /plugins/<dir>/manifest.json (for the manifest's `style` / `theme` fields) and to HEAD
 * and link /plugins/<dir>/client/admin/admin.css — URLs on the backend's static mount, which answered
 * anyone for every INSTALLED plugin: name, exact version, author, requested permissions and
 * dependencies, active or not. The backend no longer serves either file there (a 404 for everyone);
 * the page must ask GET /api/v1/plugins/:slug/admin-style (signed-in, active plugins only) and link
 * <that>/css. If the generator still emitted the old URLs, every plugin admin page would silently lose
 * its styling — so this asserts the output, not the intent.
 *
 * The generator runs for real, in a sandbox laid out like the repo (it resolves backend/plugins and
 * its output relative to its own location), with the active list passed through the same env var the
 * backend uses — so it asks no backend anything.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const FRONTEND_DIR = path.resolve(__dirname, '../../..');
const OUT_REL = path.join('src', 'app', 'admin', 'plugin', '[slug]', 'page.tsx');

const sandboxes: string[] = [];
afterEach(() => {
    while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

/** A checkout with the generator and one plugin whose admin slug differs from its folder. */
function generate(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-admin-page-gen-'));
    sandboxes.push(root);
    for (const f of ['generate-admin-plugin-registry.js', 'hermetic-plugins.js']) {
        fs.mkdirSync(path.join(root, 'frontend', 'scripts'), { recursive: true });
        fs.copyFileSync(path.join(FRONTEND_DIR, 'scripts', f), path.join(root, 'frontend', 'scripts', f));
    }
    fs.copyFileSync(path.join(FRONTEND_DIR, 'hermetic-build.js'), path.join(root, 'frontend', 'hermetic-build.js'));
    const plugin = path.join(root, 'backend', 'plugins', 'probe-folder');
    fs.mkdirSync(path.join(plugin, 'client', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({
        id: 'probe-folder', name: 'Probe', version: '1.0.0',
        frontend: { adminPage: { entry: './client/admin/page.tsx', slug: 'probe-admin' } },
    }));
    fs.writeFileSync(path.join(plugin, 'client', 'admin', 'page.tsx'), 'export default function P() { return null; }\n');

    const env: NodeJS.ProcessEnv = { ...process.env, WORDJS_ACTIVE_PLUGINS: JSON.stringify(['probe-folder']) };
    delete env.WORDJS_HERMETIC_BUILD;
    const r = spawnSync(process.execPath, [path.join(root, 'frontend', 'scripts', 'generate-admin-plugin-registry.js')], {
        cwd: path.join(root, 'frontend'), encoding: 'utf8', env,
    });
    expect(r.status, `generator failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    return fs.readFileSync(path.join(root, 'frontend', OUT_REL), 'utf8');
}

describe('generate-admin-plugin-registry: the page\'s styling comes from the authenticated admin-style API', () => {
    it('fetches GET /api/v1/plugins/<id>/admin-style with the session, and links <that>/css', () => {
        const page = generate();
        expect(page).toContain('`/api/v1/plugins/${encodeURIComponent(id)}/admin-style`');
        expect(page).toMatch(/fetch\(endpoint, \{ credentials: "same-origin" \}\)/);
        expect(page).toContain('setCssUrl(`${endpoint}/css`)');
        expect(page).toContain('{cssUrl && <link rel="stylesheet" href={cssUrl} />}');
        // Asked by FOLDER when the plugin is known at build time (exact match), else by URL slug.
        expect(page).toContain('"probe-admin": "probe-folder",');
        expect(page).toContain('adminStyleEndpoint(PLUGIN_ADMIN_DIRS[slug] || slug)');
    });

    it('never requests the plugin manifest or the admin stylesheet from the static /plugins mount', () => {
        // The CODE, without its comments (which explain the old URLs on purpose).
        const code = generate()
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
        expect(code).not.toContain('manifest.json');
        expect(code).not.toContain('client/admin/admin.css');
        // No URL on the static mount at all: every quoted or template string that starts with /plugins/.
        expect(code).not.toMatch(/["'`]\/plugins\//);
        expect(code).not.toMatch(/method: "HEAD"/);
    });
});
