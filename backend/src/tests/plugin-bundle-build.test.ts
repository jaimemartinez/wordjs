/**
 * Guards the runtime plugin-bundle build (backend/scripts/build-plugin.js).
 *
 * ROOT CAUSE this locks down: marketplace-plugin admin UIs were dead in production because the bundle
 * was emitted with React and the host `@/lib/api` left as bare `import ... from "react"` specifiers.
 * The frontend loads the bundle via `import(blobURL)`, and a blob module cannot resolve a bare
 * specifier → every plugin admin page rendered blank. The fix rewrites those imports onto the
 * host-injected `window.WordJS.*` globals. If someone reverts to `external`, these tests fail.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BUILD_PLUGIN = path.resolve(__dirname, '../../scripts/build-plugin.js');

function mkFixture(root: string, slug: string, adminSrc: string): string {
    const dir = path.join(root, slug);
    fs.mkdirSync(path.join(dir, 'client', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        id: slug, name: slug, version: '1.0.0', isolated: true,
        frontend: { adminPage: { entry: './client/admin/page.tsx', slug } },
    }));
    fs.writeFileSync(path.join(dir, 'client', 'admin', 'page.tsx'), adminSrc);
    return dir;
}

function build(root: string, slug: string): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [BUILD_PLUGIN, slug], {
        env: { ...process.env, WORDJS_PLUGINS_DIR: root }, encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('plugin bundle maps react + host modules to WordJS globals (no bare specifiers)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-bundle-'));
    try {
        const dir = mkFixture(root, 'fixture-ok', `
            import { useState, useEffect } from 'react';
            import { api, apiGet } from '@/lib/api';
            import { useModal } from '@/contexts/ModalContext';
            export default function Admin() {
                const [n] = useState(0);
                useEffect(() => { apiGet('/x'); }, []);
                const m = useModal();
                return <div onClick={() => { api('/y', { method: 'POST' }); void m; }}>{n}</div>;
            }
        `);
        const r = build(root, 'fixture-ok');
        assert.equal(r.status, 0, `build failed: ${r.out}`);
        const code = fs.readFileSync(path.join(dir, 'dist', 'admin.bundle.js'), 'utf8');
        assert.ok(!/from\s*["'](react|react-dom|@\/)/.test(code), 'bundle must not contain bare react/@ import specifiers');
        assert.ok(code.includes('globalThis.WordJS.React'), 'react mapped to window.WordJS.React');
        assert.ok(code.includes('globalThis.WordJS.host') && code.includes('"lib/api"'), '@/lib/api mapped to window.WordJS.host["lib/api"]');
        assert.ok(code.includes('"contexts/ModalContext"'), '@/contexts/ModalContext mapped to window.WordJS.host["contexts/ModalContext"]');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('plugin builds a Puck block (component) bundle from frontend.puckComponents.entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-bundle-'));
    try {
        const slug = 'fixture-block';
        const dir = path.join(root, slug);
        fs.mkdirSync(path.join(dir, 'client', 'puck'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: slug, name: slug, version: '1.0.0', isolated: true,
            // The block entry lives under puckComponents.entry — NOT frontend.component (the key the
            // build script used to read, which is why block bundles never built).
            frontend: { puckComponents: { entry: './client/puck/Block.tsx' } },
        }));
        fs.writeFileSync(path.join(dir, 'client', 'puck', 'Block.tsx'), `
            import { useState } from 'react';
            export const puckComponentDef = { label: 'My Block', category: 'content', fields: {}, defaultProps: {} };
            export default function Block() { const [n] = useState(0); return <div className="my-block">{n}</div>; }
        `);
        const r = build(root, slug);
        assert.equal(r.status, 0, `build failed: ${r.out}`);
        const out = path.join(dir, 'dist', 'component.bundle.js');
        assert.ok(fs.existsSync(out), 'component.bundle.js must be produced from puckComponents.entry');
        const code = fs.readFileSync(out, 'utf8');
        assert.ok(/puckComponentDef/.test(code), 'block bundle exposes puckComponentDef');
        assert.ok(!/from\s*["'](react|react-dom|@\/)/.test(code), 'block bundle has no bare react/@ specifiers');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('plugin builds a hooks bundle from frontend.hooks (a STRING entry) exporting register*', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-bundle-'));
    try {
        const slug = 'fixture-hooks';
        const dir = path.join(root, slug);
        fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: slug, name: slug, version: '1.0.0', isolated: true,
            // frontend.hooks is a plain STRING, not { entry } — the shape every real plugin uses.
            frontend: { hooks: './client/Ext.tsx' },
        }));
        fs.writeFileSync(path.join(dir, 'client', 'Ext.tsx'), `
            import { useState } from 'react';
            import { pluginHooks } from '@/lib/plugin-hooks';
            const Ext = () => { const [n] = useState(0); return <div>{n}</div>; };
            export const registerExt = () => {
                pluginHooks.addAction('user_form_before_email', () => <Ext />, 10, 'fixture:ext');
            };
        `);
        const r = build(root, slug);
        assert.equal(r.status, 0, `build failed: ${r.out}`);
        const out = path.join(dir, 'dist', 'hooks.bundle.js');
        assert.ok(fs.existsSync(out), 'hooks.bundle.js must be produced from the frontend.hooks string entry');
        const code = fs.readFileSync(out, 'utf8');
        // The runtime loader (pluginBundleLoader.loadRuntimePluginHooks) invokes every export whose name
        // starts with 'register' — the name must survive minification as an export alias.
        assert.ok(/\bregisterExt\b/.test(code), 'hooks bundle must export the register* entry point');
        assert.ok(code.includes('"lib/plugin-hooks"'), 'pluginHooks resolves to the HOST singleton, not a bundled copy');
        assert.ok(!/from\s*["'](react|react-dom|@\/)/.test(code), 'hooks bundle has no bare react/@ specifiers');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('plugin bundle build FAILS when the manifest declares a frontend entry that does not exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-bundle-'));
    try {
        const slug = 'fixture-ghost-entry';
        const dir = path.join(root, slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: slug, name: slug, version: '1.0.0', isolated: true,
            frontend: { hooks: './client/Missing.tsx' },
        }));
        // Silently skipping a declared-but-missing entry is how a plugin ships with its UI extension
        // simply absent at runtime — indistinguishable from "the plugin has no frontend".
        const r = build(root, slug);
        assert.notEqual(r.status, 0, 'build must fail (exit non-zero) on a declared entry that is not on disk');
        assert.ok(/Missing\.tsx|do not exist/i.test(r.out), `error should name the missing entry; got: ${r.out.slice(0, 400)}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('plugin bundle build FAILS loudly on a host import the host does not expose', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-bundle-'));
    try {
        mkFixture(root, 'fixture-bad', `
            import { helper } from '@/lib/not-a-real-host-module';
            export default function Admin() { return <div>{String(helper)}</div>; }
        `);
        const r = build(root, 'fixture-bad');
        assert.notEqual(r.status, 0, 'build must fail (exit non-zero) — a blank panel in prod is worse than a loud build failure');
        assert.ok(/not-a-real-host-module|not exposed|GLOBAL_MODULES/i.test(r.out), `error should name the unexposed module; got: ${r.out.slice(0, 400)}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
