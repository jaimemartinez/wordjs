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
const {
    UTILITIES_MARKER, PLUGIN_SUBLAYER, withPackagedStylesheet, extractCandidates, compileUtilities, nestInPluginLayer,
    handWritten, loadTailwind, hostThemeBlocks,
} = require('../../scripts/plugin-stylesheet');

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

// ── The cascade: a plugin sheet never restyles the host ────────────────────────────────────────────

/**
 * The top-level blocks of a stylesheet: `{ head, body }` per `head { body }`, skipping comments and
 * strings. Written here, not imported, so the assertion does not check the emitter with itself.
 */
function topLevelBlocks(css: string): { head: string; body: string }[] {
    const out: { head: string; body: string }[] = [];
    let depth = 0, start = 0, open = -1;
    for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '\\') { i++; continue; }
        if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2) + 1; if (!i) break; if (depth === 0) start = i + 1; continue; }
        if (c === '"' || c === "'") { for (i++; i < css.length && css[i] !== c; i++) if (css[i] === '\\') i++; continue; }
        if (c === ';' && depth === 0) { start = i + 1; continue; }
        if (c === '{') { if (depth === 0) open = i; depth++; continue; }
        if (c === '}') {
            depth--;
            if (depth === 0) { out.push({ head: css.slice(start, open).trim(), body: css.slice(open + 1, i).trim() }); start = i + 1; }
        }
    }
    return out;
}

/** Every `@layer x { … }` in the compiled part of `css` holds ONE block: `@layer wjs-plugin { … }`. */
function assertOneSubLayerBelowTheHost(css: string, label: string) {
    const compiled = css.slice(css.indexOf(UTILITIES_MARKER));
    const layers = topLevelBlocks(compiled).filter((b) => /^@layer\s+[\w-]+$/.test(b.head));
    assert.ok(layers.some((b) => b.head === '@layer utilities'), `${label}: has a utilities block`);
    for (const b of layers) {
        const inner = topLevelBlocks(b.body);
        assert.equal(inner.length, 1, `${label}: ${b.head} must hold exactly one block, got ${inner.map((x) => x.head).join(', ')}`);
        assert.equal(inner[0].head, `@layer ${PLUGIN_SUBLAYER}`, `${label}: ${b.head} must nest its rules in @layer ${PLUGIN_SUBLAYER}`);
    }
    // Nothing else at the top level may carry a style rule (only @property / @keyframes registrations).
    for (const b of topLevelBlocks(compiled)) {
        assert.ok(b.head.startsWith('@'), `${label}: style rule outside any layer: ${b.head}`);
    }
}

test('every compiled rule sits one cascade sub-layer below the host\'s own (admin, block and hooks sheets)', () => {
    // THE DESKTOP REGRESSION THIS PINS: a plugin sheet is a SECOND sheet, linked after the host's. With its
    // `.flex`/`.hidden`/`.fixed` directly in `@layer utilities` (same layer, same specificity, later) it beat
    // the host's `.md\:hidden`/`.md\:relative` on the host's OWN elements: on a 1280 px desktop the
    // conference-manager page showed the mobile header, a position:fixed sidebar over the content and no
    // collapse toggle; mail-server's hooks sheet did the same on every admin page. Rules of a sub-layer
    // always lose to the parent layer's own rules (CSS Cascade 5), so the host keeps its order.
    withRoot((root) => {
        const dir = adminPlugin(root, 'fixture-layer');
        write(dir, 'client/verso/Block.tsx', `
            export const versoComponentDef = { label: 'B', category: 'c', fields: {}, defaultProps: {} };
            export default function Block() { return <section className="hidden md:flex bg-amber-500/40" />; }
        `);
        write(dir, 'client/Ext.tsx', `
            import { pluginHooks } from '@/lib/plugin-hooks';
            const Ext = () => <label className="flex md:hidden bg-black/70" />;
            export const registerExt = () => pluginHooks.addAction('user_form_before_email', () => <Ext />, 10, 'x');
        `);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        manifest.frontend.versoComponents = { entry: './client/verso/Block.tsx' };
        manifest.frontend.hooks = './client/Ext.tsx';
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
        const r = build(root, 'fixture-layer');
        assert.equal(r.status, 0, `build failed: ${r.out}`);
        for (const f of ['dist/admin.css', 'dist/component.bundle.css', 'dist/hooks.bundle.css']) {
            const css = fs.readFileSync(path.join(dir, f), 'utf8');
            assertOneSubLayerBelowTheHost(css, f);
            // The classes are still there — only their rank changed.
            assert.ok(hasRule(css, f === 'dist/admin.css' ? 'bg-black/80' : f.includes('component') ? 'bg-amber-500/40' : 'bg-black/70'), `${f}: classes compiled`);
        }
        // The plugin's own (unlayered) stylesheet is untouched and still first.
        assert.ok(fs.readFileSync(path.join(dir, 'dist/admin.css'), 'utf8').startsWith('.plugin-admin-fixture-layer .own'));
    });
});

test('nestInPluginLayer: only top-level @layer blocks, braces inside strings and escapes are not blocks', () => {
    const input = [
        '@layer properties;',
        '@layer theme, base, components, utilities;',
        '@layer utilities {',
        '  .content-\\[\\\'\\{\\\'\\] { --tw-content: \'{\'; content: var(--tw-content); }',
        '  @media (width >= 40rem) { .sm\\:flex { display: flex; } }',
        '}',
        '@property --tw-x { syntax: "*"; inherits: false; }',
        '@keyframes spin { to { transform: rotate(360deg); } }',
    ].join('\n');
    const out = nestInPluginLayer(input);
    const blocks = topLevelBlocks(out);
    assert.deepStrictEqual(blocks.map((b) => b.head), ['@layer utilities', '@property --tw-x', '@keyframes spin']);
    assert.equal(topLevelBlocks(blocks[0].body)[0].head, `@layer ${PLUGIN_SUBLAYER}`);
    assert.ok(topLevelBlocks(blocks[0].body)[0].body.includes("content: var(--tw-content)"));
    assert.ok(out.startsWith('@layer properties;\n@layer theme, base, components, utilities;\n'), 'layer order statements kept');
    assert.ok(out.includes('@keyframes spin { to { transform: rotate(360deg); } }'), 'keyframes untouched');
});

test('rebuilding an INSTALLED package (own CSS + compiled block) keeps exactly one compiled block', () => {
    // pack:plugin on backend/plugins and the dev "Build & download ZIP" build the installed folder, whose
    // client/admin/admin.css is the PACKAGED stylesheet. Treating it as hand-written stacked one more
    // compiled block per cycle (1 → 2 → 3 → 4), each keeping classes the UI no longer uses.
    withRoot((root) => {
        const dir = adminPlugin(root, 'fixture-repack');
        const own = fs.readFileSync(path.join(dir, 'client/admin/admin.css'), 'utf8');
        for (let cycle = 1; cycle <= 3; cycle++) {
            assert.equal(build(root, 'fixture-repack').status, 0);
            const built = fs.readFileSync(path.join(dir, 'dist', 'admin.css'), 'utf8');
            assert.equal(built.split(UTILITIES_MARKER).length - 1, 1, `cycle ${cycle}: exactly one compiled block`);
            assert.ok(built.startsWith(own.trimEnd()), `cycle ${cycle}: the hand-written part, once`);
            // What the installer puts on disk: the packaged sheet at client/admin/admin.css.
            fs.writeFileSync(path.join(dir, 'client/admin/admin.css'), built);
        }
        assert.equal(handWritten(`${own}\n/*! ${UTILITIES_MARKER} x */\n.a{}\n`), own.trimEnd());
        assert.equal(handWritten(null), '');
    });
});

test('candidate extraction keeps arbitrary values that contain quotes', async () => {
    const found: Set<string> = extractCandidates(`
        <p className={cn("after:content-['']", on && "font-['Inter']")} />
        <div className="bg-[url('/a.png')] before:content-['x'] grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]" />
    `);
    for (const c of ["after:content-['']", "font-['Inter']", "bg-[url('/a.png')]", "before:content-['x']", 'grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]']) {
        assert.ok(found.has(c), `must extract ${c}`);
    }
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-quoted-')), 'Q.tsx');
    try {
        fs.writeFileSync(f, `export const Q = () => <p className="after:content-[''] font-['Inter'] bg-[url('/a.png')]" />;\n`);
        const css: string = await compileUtilities([f], 'quoted');
        assert.match(css, /content: var\(--tw-content\)/, 'content-[\'\'] compiled');
        assert.match(css, /font-family: 'Inter'/, 'font-[\'Inter\'] compiled');
        assert.match(css, /background-image: url\('\/a\.png'\)/, 'bg-[url(…)] compiled');
    } finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
});

// ── Parity with the host's Tailwind ─────────────────────────────────────────────────────────────────

test('plugin sheets and the host compile with the same Tailwind, against the host\'s theme', () => {
    // A class must mean the same thing in both sheets. Two lockfiles decide it (backend/ compiles the
    // plugins, frontend/ the host); a drift gives different bytes with no error, and a different Tailwind
    // re-declares the theme variables with different values.
    const lockVersion = (rel: string) => {
        const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8'));
        return lock.packages?.['node_modules/tailwindcss']?.version;
    };
    const backendTw = lockVersion('backend/package-lock.json');
    const frontendTw = lockVersion('frontend/package-lock.json');
    assert.ok(backendTw && frontendTw, 'both lockfiles resolve tailwindcss');
    assert.equal(backendTw, frontendTw, 'backend (plugin sheets) and frontend (host CSS) resolve the same tailwindcss');
    assert.equal(loadTailwind().version, frontendTw, 'the compiler the build loads is that version (the banner says so)');
    // The host's @theme tokens are part of the input; a missing host stylesheet is an error, not ''.
    assert.match(hostThemeBlocks(), /--color-brand-blue/);
    assert.throws(() => hostThemeBlocks(path.join(os.tmpdir(), 'wjs-no-such-globals.css')), /cannot read the host stylesheet/);
});
