/**
 * Guards the marketplace catalog gate (backend/scripts/verify-marketplace.js).
 *
 * WHAT THIS LOCKS DOWN: CI's "Marketplace catalog freshness" step used to be
 * `git diff --exit-code -- marketplace/dist`, which could never fail — marketplace/dist/ is gitignored
 * and has zero tracked files, so git had nothing to diff. A stale or mismatched plugin zip could reach
 * a release with a green check on it. verify-marketplace.js replaces that with real assertions; these
 * tests prove the assertions actually go RED, because a gate nobody has seen fail is the same
 * decoration we just removed.
 *
 * Every fixture is packed by the REAL producer (build-marketplace.js → build-plugin.js) via
 * WORDJS_MARKETPLACE_ROOT. Nothing here re-implements the packing rules: a fixture built by anything
 * other than the shipping builder would prove nothing about the shipping builder.
 */
import { test } from 'node:test';
import assert from 'node:assert';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { spawnSync } = require('child_process');

const BUILD = path.resolve(__dirname, '../../scripts/build-marketplace.js');
const VERIFY = path.resolve(__dirname, '../../scripts/verify-marketplace.js');

type Run = { status: number | null; out: string };

function run(script: string, root: string, args: string[] = []): Run {
    const r = spawnSync(process.execPath, [script, ...args], {
        env: { ...process.env, WORDJS_MARKETPLACE_ROOT: root },
        encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * A miniature marketplace: one plugin with a real frontend entry (so build-plugin actually compiles a
 * bundle into the zip), one plain plugin that also holds runtime state in data/, and one theme.
 */
function mkRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-catalog-'));
    const plugins = path.join(root, 'marketplace', 'plugins');
    const themes = path.join(root, 'marketplace', 'themes');

    const alpha = path.join(plugins, 'fixture-alpha');
    fs.mkdirSync(path.join(alpha, 'client', 'admin'), { recursive: true });
    fs.writeFileSync(path.join(alpha, 'manifest.json'), JSON.stringify({
        id: 'fixture-alpha', name: 'Fixture Alpha', version: '1.0.0', isolated: true,
        frontend: { adminPage: { entry: 'client/admin/page.tsx', slug: 'alpha' } },
    }, null, 2));
    fs.writeFileSync(path.join(alpha, 'client', 'admin', 'page.tsx'),
        'export default function Admin() { return <div>alpha</div>; }\n');
    fs.writeFileSync(path.join(alpha, 'index.js'), 'module.exports = {};\n');

    const beta = path.join(plugins, 'fixture-beta');
    fs.mkdirSync(path.join(beta, 'data'), { recursive: true });
    fs.writeFileSync(path.join(beta, 'manifest.json'), JSON.stringify({
        id: 'fixture-beta', name: 'Fixture Beta', version: '2.0.0', isolated: true,
    }, null, 2));
    fs.writeFileSync(path.join(beta, 'index.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(beta, 'data', 'secret.key'), 'AES-ROOT-KEY-DO-NOT-SHIP\n');

    const theme = path.join(themes, 'fixture-theme');
    fs.mkdirSync(theme, { recursive: true });
    fs.writeFileSync(path.join(theme, 'theme.json'), JSON.stringify({ name: 'Fixture Theme', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(theme, 'style.css'), 'body{}\n');

    return root;
}

function distFile(root: string, name: string): string {
    return path.join(root, 'marketplace', 'dist', name);
}

function withRoot(fn: (root: string) => void): void {
    const root = mkRoot();
    try {
        fn(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('a freshly built catalog verifies clean, and the build is reproducible', () => {
    withRoot((root) => {
        const built = run(BUILD, root);
        assert.equal(built.status, 0, `build failed: ${built.out}`);

        const ok = run(VERIFY, root);
        assert.equal(ok.status, 0, `verify should pass on a fresh catalog: ${ok.out}`);

        // Determinism: a second build of identical sources must be byte-identical. This is the property
        // the old freshness gate assumed and never checked (it was in fact false — build-plugin.js
        // stamped `new Date()` into every bundle banner and build manifest).
        const det = run(VERIFY, root, ['--rebuild']);
        assert.equal(det.status, 0, `rebuild must be byte-identical: ${det.out}`);
    });
});

test('a plugin zip whose bytes no longer match the catalog sha256 fails the gate', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        // Tamper with a published package exactly as a corrupted/substituted artifact would.
        const zip = distFile(root, 'fixture-beta-2.0.0.zip');
        const z = new AdmZip(fs.readFileSync(zip));
        z.addFile('fixture-beta/backdoor.js', Buffer.from('module.exports = 1;\n'));
        fs.writeFileSync(zip, z.toBuffer());

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'tampered zip must fail');
        assert.match(r.out, /sha256 MISMATCH/, r.out);
    });
});

test('a source version bump without a catalog rebuild fails the gate (the stale-catalog case)', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        // Ship a new plugin version but forget to rebuild the catalog: the index still advertises the
        // old version/filename. This is precisely what the git-diff gate was supposed to catch and
        // structurally could not.
        const manifestPath = path.join(root, 'marketplace', 'plugins', 'fixture-alpha', 'manifest.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.version = '1.1.0';
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'stale catalog must fail');
        assert.match(r.out, /catalog says version 1\.0\.0 but manifest\.json says 1\.1\.0/, r.out);
        assert.match(r.out, /fixture-alpha-1\.1\.0\.zip/, r.out);

        // ...and rebuilding is what makes it green again.
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0);
    });
});

test('a package that ships without the frontend bundle its manifest declares fails the gate', () => {
    withRoot((root) => {
        // build-plugin.js silently skips a declared entry whose file is missing, so the catalog build
        // stays GREEN while publishing a plugin whose admin page can never load once installed.
        fs.rmSync(path.join(root, 'marketplace', 'plugins', 'fixture-alpha', 'client', 'admin', 'page.tsx'));

        const built = run(BUILD, root);
        assert.equal(built.status, 0, 'the builder does not notice — that is the point of this gate');

        const zipped = new AdmZip(fs.readFileSync(distFile(root, 'fixture-alpha-1.0.0.zip')))
            .getEntries().map((e: { entryName: string }) => e.entryName);
        assert.ok(!zipped.includes('fixture-alpha/dist/admin.bundle.js'), 'precondition: the bundle really is absent');

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a package missing its declared bundle must fail');
        assert.match(r.out, /declares a frontend entry whose source file is missing/, r.out);
    });
});

test("a package that ships a plugin's runtime data/ fails the gate", () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        const zip = distFile(root, 'fixture-beta-2.0.0.zip');
        const clean = new AdmZip(fs.readFileSync(zip));
        assert.ok(
            !clean.getEntries().some((e: { entryName: string }) => e.entryName.startsWith('fixture-beta/data/')),
            'precondition: the builder excludes data/',
        );

        // Simulate a packer regression that stops excluding data/ (that directory holds live secrets —
        // mail-server keeps its AES root key in data/.mailenc).
        clean.addFile('fixture-beta/data/secret.key', Buffer.from('AES-ROOT-KEY-DO-NOT-SHIP\n'));
        const buf = clean.toBuffer();
        fs.writeFileSync(zip, buf);
        // Re-point the catalog at the new bytes so the sha256 check passes and the leak is what fails.
        const indexPath = distFile(root, 'marketplace-index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const entry = index.plugins.find((p: { id: string }) => p.id === 'fixture-beta');
        entry.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        entry.size = buf.length;
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a package shipping runtime state must fail');
        assert.match(r.out, /ships runtime state/, r.out);
    });
});

test('an unreferenced leftover in dist/ fails the gate', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        // release.yml uploads marketplace/dist/* wholesale, so a leftover zip becomes a published
        // release asset that no catalog entry points at.
        fs.writeFileSync(distFile(root, 'fixture-beta-1.9.9.zip'), 'stale');

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'an orphan dist artifact must fail');
        assert.match(r.out, /not referenced by any catalog entry/, r.out);
    });
});

test('a package missing from the catalog fails the gate', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        const indexPath = distFile(root, 'marketplace-index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const dropped = index.plugins.filter((p: { id: string }) => p.id !== 'fixture-beta');
        fs.writeFileSync(indexPath, JSON.stringify({ count: dropped.length, plugins: dropped }, null, 2));
        fs.rmSync(distFile(root, 'fixture-beta-2.0.0.zip'));

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a dropped package must fail');
        assert.match(r.out, /not published in the catalog: fixture-beta/, r.out);
    });
});
