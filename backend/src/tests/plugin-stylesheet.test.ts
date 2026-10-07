/**
 * Guards the plugin stylesheet step of the build (backend/scripts/build-plugin.js → plugin-stylesheet.js).
 *
 * ROOT CAUSE this locks down: a plugin installed from the marketplace is loaded at runtime from its own
 * pre-built bundle, and a release build of the host only compiles the Tailwind classes of the plugins git
 * tracks. Nothing ever generated the classes that only the plugin used, so on a live site its screens
 * rendered with whatever the host happened to share — the conference-manager meal scanner came out as a
 * transparent band over the page with a 0×0 aiming frame (no `bg-black`, `bg-black/80`, `w-[82%]`,
 * `aspect-[2.6/1]`). The build now compiles them into the stylesheets the host already loads: the admin
 * page's (dist/admin.css, shipped as client/admin/admin.css), the block's and the hooks' bundle CSS.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BUILD_PLUGIN = path.resolve(__dirname, '../../scripts/build-plugin.js');
const { UTILITIES_MARKER, withPackagedStylesheet, extractCandidates } = require('../../scripts/plugin-stylesheet');

/** The selector Tailwind emits for a class (`bg-black/80` → `.bg-black\/80`). */
const sel = (cls: string) => `.${cls.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`)}`;
const hasRule = (css: string, cls: string) => new RegExp(`${sel(cls).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=[\\s:{,\\[])`).test(css);

function write(dir: string, rel: string, text: string) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
}

function build(root: string, slug: string): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [BUILD_PLUGIN, slug], {
        env: { ...process.env, WORDJS_PLUGINS_DIR: root }, encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function withRoot(fn: (root: string) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-plugin-css-'));
    try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** An admin plugin shaped like conference-manager: a page, a portalled overlay it imports, a hand-written admin.css. */
function adminPlugin(root: string, slug: string) {
    const dir = path.join(root, slug);
    write(dir, 'manifest.json', JSON.stringify({
        id: slug, name: slug, version: '1.0.0', isolated: true,
        frontend: { adminPage: { entry: './client/admin/page.tsx', slug } },
    }));
    write(dir, 'client/admin/page.tsx', `
        import Scanner from './Scanner';
        export default function Admin() { return <div className="px-12 rounded-t-3xl"><Scanner /></div>; }
    `);
    // Rendered through a portal on <body> in the real plugin: outside .plugin-admin-<slug>, so the classes
    // must NOT be scoped under that wrapper.
    write(dir, 'client/admin/Scanner.tsx', `
        import { createPortal } from 'react-dom';
        export default function Scanner({ on }: { on?: boolean }) {
            const frame = \`w-[82%] aspect-[2.6/1] \${on ? 'border-white/90' : 'border-rose-500'}\`;
            return createPortal(<div className="fixed inset-0 z-[6000] bg-black"><div className="bg-black/80"><div className={frame} /></div></div>, document.body);
        }
    `);
    // In client/ but not imported by the page: still scanned (client/** is the plugin's UI).
    write(dir, 'client/lib/kit.ts', `export const sheet = cn('max-h-[85%]', ok && "ring-8");`);
    write(dir, 'client/admin/admin.css', `.plugin-admin-${slug} .own { color: rebeccapurple; }\n`);
    return dir;
}

test('the admin build compiles every Tailwind class the plugin UI uses into dist/admin.css, unscoped', () => {
    withRoot((root) => {
        const dir = adminPlugin(root, 'fixture-css');
        const ownBefore = fs.readFileSync(path.join(dir, 'client/admin/admin.css'), 'utf8');
        const r = build(root, 'fixture-css');
        assert.equal(r.status, 0, `build failed: ${r.out}`);

        const css = fs.readFileSync(path.join(dir, 'dist', 'admin.css'), 'utf8');
        for (const cls of ['bg-black', 'bg-black/80', 'w-[82%]', 'aspect-[2.6/1]', 'border-white/90', 'border-rose-500',
            'fixed', 'inset-0', 'z-[6000]', 'px-12', 'rounded-t-3xl', 'max-h-[85%]', 'ring-8']) {
            assert.ok(hasRule(css, cls), `dist/admin.css must define .${cls}`);
        }
        // Unscoped: a portalled overlay lives outside .plugin-admin-<slug>.
        assert.ok(!/\.plugin-admin-fixture-css\s+\.bg-black/.test(css), 'utilities must not be scoped under the admin wrapper');
        // In the host's cascade layers, and WITHOUT preflight (the host page already has the reset).
        assert.ok(css.includes('@layer theme, base, components, utilities;'), 'utilities sit in the host layer order');
        assert.ok(!/border:\s*0 solid/.test(css), 'no second preflight');
        // The plugin's own stylesheet comes first, verbatim, and its source file is untouched.
        assert.ok(css.startsWith(ownBefore), 'hand-written admin.css first, verbatim');
        assert.ok(css.includes(UTILITIES_MARKER), 'the compiled block carries the marker the catalog gate checks');
        assert.equal(fs.readFileSync(path.join(dir, 'client/admin/admin.css'), 'utf8'), ownBefore, 'the SOURCE admin.css is never written');
    });
});

test('the compiled stylesheet is deterministic: rebuilding unchanged sources is byte-identical', () => {
    withRoot((root) => {
        const dir = adminPlugin(root, 'fixture-det');
        assert.equal(build(root, 'fixture-det').status, 0);
        const first = fs.readFileSync(path.join(dir, 'dist', 'admin.css'));
        assert.equal(build(root, 'fixture-det').status, 0);
        assert.ok(first.equals(fs.readFileSync(path.join(dir, 'dist', 'admin.css'))), 'second build must produce the same bytes');
        assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(first.toString()), 'no timestamp in the output');
        assert.ok(!first.toString().includes(root), 'no absolute build path in the output');
    });
});

test('block and hooks bundles get their own classes in dist/<name>.bundle.css, appended once per build', () => {
    withRoot((root) => {
        const slug = 'fixture-parts';
        const dir = path.join(root, slug);
        write(dir, 'manifest.json', JSON.stringify({
            id: slug, name: slug, version: '1.0.0', isolated: true,
            frontend: { versoComponents: { entry: './client/verso/Block.tsx' }, hooks: './client/Ext.tsx' },
        }));
        write(dir, 'client/verso/block.css', '.from-esbuild { color: teal; }\n');
        write(dir, 'client/verso/Block.tsx', `
            import './block.css';
            export const versoComponentDef = { label: 'B', category: 'c', fields: {}, defaultProps: {} };
            export default function Block() { return <section className="bg-amber-500/40 aspect-[4/3]" />; }
        `);
        write(dir, 'client/Ext.tsx', `
            import { pluginHooks } from '@/lib/plugin-hooks';
            const Ext = () => <label className="bg-black/70 min-h-[44px]" />;
            export const registerExt = () => pluginHooks.addAction('user_form_before_email', () => <Ext />, 10, 'x');
        `);
        for (let i = 0; i < 2; i++) assert.equal(build(root, slug).status, 0);

        const block = fs.readFileSync(path.join(dir, 'dist', 'component.bundle.css'), 'utf8');
        assert.ok(block.includes('.from-esbuild'), 'esbuild\'s own extracted CSS is kept');
        assert.ok(hasRule(block, 'bg-amber-500/40') && hasRule(block, 'aspect-[4/3]'), 'the block\'s classes are compiled');
        assert.ok(!hasRule(block, 'bg-black/70'), 'a block reaches public pages: only ITS classes, not the hooks\'');
        assert.equal(block.split(UTILITIES_MARKER).length - 1, 1, 'rebuilding must not append a second copy');

        const hooks = fs.readFileSync(path.join(dir, 'dist', 'hooks.bundle.css'), 'utf8');
        assert.ok(hasRule(hooks, 'bg-black/70') && hasRule(hooks, 'min-h-[44px]'), 'the hooked UI\'s classes are compiled');
        assert.ok(!fs.existsSync(path.join(dir, 'dist', 'admin.css')), 'no admin page → no admin stylesheet');
    });
});

test('a stale dist/admin.css does not outlive the admin page it styled', () => {
    withRoot((root) => {
        const slug = 'fixture-stale';
        const dir = path.join(root, slug);
        write(dir, 'manifest.json', JSON.stringify({ id: slug, name: slug, version: '1.0.0', isolated: true, frontend: {} }));
        write(dir, 'dist/admin.css', '/* from an older build */\n');
        assert.equal(build(root, slug).status, 0);
        assert.ok(!fs.existsSync(path.join(dir, 'dist', 'admin.css')), 'the packers would ship it as client/admin/admin.css');
    });
});

test('packers ship the built stylesheet AS client/admin/admin.css, once', () => {
    const dir = path.join(os.tmpdir(), 'wjs-pack-map');
    const map = (rels: string[]) => withPackagedStylesheet(dir, rels).map((e: { rel: string; abs: string }) =>
        [e.rel, path.relative(dir, e.abs).split(path.sep).join('/')]);
    // Replaces the hand-written source in place.
    assert.deepStrictEqual(map(['client/admin/admin.css', 'client/admin/page.tsx', 'dist/admin.bundle.js', 'dist/admin.css', 'manifest.json']), [
        ['client/admin/admin.css', 'dist/admin.css'],
        ['client/admin/page.tsx', 'client/admin/page.tsx'],
        ['dist/admin.bundle.js', 'dist/admin.bundle.js'],
        ['manifest.json', 'manifest.json'],
    ]);
    // Inserted at its sorted position when the plugin has no admin.css of its own.
    assert.deepStrictEqual(map(['client/admin/page.tsx', 'dist/admin.css', 'index.js']).map(([rel]: string[]) => rel),
        ['client/admin/admin.css', 'client/admin/page.tsx', 'index.js']);
    // No build output → the folder is shipped as it is.
    assert.deepStrictEqual(map(['client/admin/admin.css', 'index.js']), [
        ['client/admin/admin.css', 'client/admin/admin.css'], ['index.js', 'index.js'],
    ]);
});

test('the CLI packer (`wordjs pack --build`) ships the compiled stylesheet as client/admin/admin.css too', () => {
    withRoot((root) => {
        const dir = adminPlugin(root, 'fixture-cli');
        const out = path.join(root, 'out');
        const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../cli/wordjs.js'), 'pack', 'fixture-cli', '--build', '--out', out], {
            env: { ...process.env, WORDJS_PLUGINS_DIR: root }, encoding: 'utf8',
        });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(path.join(out, 'fixture-cli.zip'));
        const css = zip.readAsText('fixture-cli/client/admin/admin.css');
        assert.ok(css.startsWith(fs.readFileSync(path.join(dir, 'client/admin/admin.css'), 'utf8')), 'own stylesheet first');
        assert.ok(hasRule(css, 'bg-black/80') && hasRule(css, 'w-[82%]'), 'the compiled classes ship');
        assert.ok(!zip.getEntry('fixture-cli/dist/admin.css'), 'the intermediate copy is not shipped twice');
    });
});

test('candidate extraction keeps arbitrary values whole and finds classes inside JSX/JS punctuation', () => {
    const found: Set<string> = extractCandidates(`
        <div className={cn("shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]", on && 'bg-black/80')}>
        const c = \`pt-[max(env(safe-area-inset-top),12px)] \${x}\`; style={{}} className={open?"flex":"hidden"}
    `);
    for (const c of ['shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]', 'bg-black/80', 'pt-[max(env(safe-area-inset-top),12px)]', 'flex', 'hidden']) {
        assert.ok(found.has(c), `must extract ${c}`);
    }
});
