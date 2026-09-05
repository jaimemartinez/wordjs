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
const SCAN = path.resolve(__dirname, '../../scripts/scan-plugin.mjs');

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

test('the BUILDER refuses a manifest entry whose source file is missing', () => {
    withRoot((root) => {
        // This used to be the gate's problem: build-plugin.js silently SKIPPED a declared entry whose
        // source was gone, so the build stayed green while publishing a plugin whose admin page could
        // never load once installed — which is exactly how breadcrumbs, related-posts and
        // table-of-contents shipped with no component bundle. The builder now hard-fails instead, so
        // that failure mode is caught one step earlier, at the source. Pinned here because the gate's
        // own negative control below can no longer observe it.
        fs.rmSync(path.join(root, 'marketplace', 'plugins', 'fixture-alpha', 'client', 'admin', 'page.tsx'));

        const built = run(BUILD, root);
        assert.notEqual(built.status, 0, 'a declared-but-missing entry must fail the build, not be skipped');
        assert.match(built.out, /fixture-alpha/, built.out);
    });
});

test('a package that ships without the frontend bundle its manifest declares fails the gate', () => {
    withRoot((root) => {
        // The gate's own guarantee, independent of the builder: whatever produced the artefact, a package
        // whose manifest declares a frontend entry must actually CONTAIN the built bundle. Since the
        // builder now refuses to produce that state (see above), construct it the way the sibling data/
        // test does — build cleanly, then mutate the artefact — so this stays a real negative control
        // rather than a test that can only pass because the builder happens to be broken.
        assert.equal(run(BUILD, root).status, 0);

        const zip = distFile(root, 'fixture-alpha-1.0.0.zip');
        const pkg = new AdmZip(fs.readFileSync(zip));
        const BUNDLE = 'fixture-alpha/dist/admin.bundle.js';
        assert.ok(
            pkg.getEntries().some((e: { entryName: string }) => e.entryName === BUNDLE),
            'precondition: a clean build DOES ship the declared bundle',
        );

        // Simulate a packer regression that drops the built bundle from the artefact.
        pkg.deleteFile(BUNDLE);
        const buf = pkg.toBuffer();
        fs.writeFileSync(zip, buf);
        // Re-point the catalog at the new bytes so the sha256 check passes and the MISSING BUNDLE is
        // what fails — otherwise this would pass for the wrong reason.
        const indexPath = distFile(root, 'marketplace-index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const entry = index.plugins.find((p: { id: string }) => p.id === 'fixture-alpha');
        entry.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        entry.size = buf.length;
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a package missing its declared bundle must fail');
        assert.match(r.out, /is missing fixture-alpha\/dist\/admin\.bundle\.js/, r.out);
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

// ══════════════════ THE REVIEW BADGE (marketplace/REVIEW.md) ══════════════════
//
// `review.status: "reviewed"` is the only field in the catalog that asserts a HUMAN decision, which
// makes it the only one an author gains by simply writing it down. These tests are the negative
// controls for the three ways that could happen: a badge with no recorded decision behind it, a badge
// that outlived the permission set it was granted against, and the project quietly certifying itself.

function ledgerPath(root: string): string {
    return path.join(root, 'marketplace', 'reviews.json');
}

function writeLedger(root: string, ledger: unknown): void {
    fs.writeFileSync(ledgerPath(root), JSON.stringify(ledger, null, 4));
}

function readIndex(root: string): any {
    return JSON.parse(fs.readFileSync(distFile(root, 'marketplace-index.json'), 'utf8'));
}

function entryFor(root: string, slug: string): any {
    return readIndex(root).plugins.find((p: { id: string }) => p.id === slug);
}

/** Give fixture-beta a real permission set, so "the permissions changed" is a change of something. */
function setPermissions(root: string, slug: string, permissions: unknown[]): void {
    const manifestPath = path.join(root, 'marketplace', 'plugins', slug, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    m.permissions = permissions;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
}

const READ = { scope: 'database', access: 'read', reason: 'Read the fixture rows.' };
const WRITE = { scope: 'database', access: 'write', reason: 'Write the fixture rows.' };

/**
 * The three values a reviewer must record, obtained THE WAY A REVIEWER OBTAINS THEM: by letting the gate
 * report them. Deliberately not computed with the shared helper the gate itself uses — a test that
 * derives its expected value from the code under test agrees with that code even when both are wrong,
 * which is a trap this repository has already fallen into. Getting them out of the failure messages also
 * pins that those messages are actionable: a reviewer whose gate went red must be able to see what the
 * package is NOW without running anything else.
 */
type ReviewInputs = { version: string; permissions: string; content: string };

function reportedReviewInputs(root: string, slug: string): ReviewInputs {
    writeLedger(root, {
        [slug]: {
            status: 'reviewed',
            reviewer: 'probe',
            date: '2026-01-01',
            reviewedVersion: '0.0.0',
            reviewedPermissionsSha256: '0'.repeat(64),
            reviewedContentSha256: '0'.repeat(64),
        },
    });
    assert.equal(run(BUILD, root).status, 0);
    const r = run(VERIFY, root);
    const version = /manifest\.json now (\d+\.\d+\.\d+)/.exec(r.out);
    const permissions = /manifest\.json now ([0-9a-f]{64})/.exec(r.out);
    const content = new RegExp(`marketplace/plugins/${slug} now ([0-9a-f]{64})`).exec(r.out);
    assert.ok(version, `the gate must report the shipped version: ${r.out}`);
    assert.ok(permissions, `the gate must report the current permission hash so a reviewer can record it: ${r.out}`);
    assert.ok(content, `the gate must report the current content digest so a reviewer can record it: ${r.out}`);
    return { version: version[1], permissions: permissions[1], content: content[1] };
}

/** A complete, honest review record for `slug` as the package stands right now. */
function reviewRecord(root: string, slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const got = reportedReviewInputs(root, slug);
    return {
        status: 'reviewed',
        reviewer: 'octocat',
        date: '2026-09-04',
        reviewedVersion: got.version,
        reviewedPermissionsSha256: got.permissions,
        reviewedContentSha256: got.content,
        ...extra,
    };
}

test('every catalog entry publishes a review status, and with no ledger that status is "unreviewed"', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        for (const entry of readIndex(root).plugins) {
            assert.deepEqual(
                entry.review,
                { status: 'unreviewed' },
                `${entry.id} must publish an explicit "unreviewed", not an absent or blank field`,
            );
        }
        assert.equal(run(VERIFY, root).status, 0, 'an all-unreviewed catalog is perfectly valid');
    });
});

test('a "reviewed" badge is published from the ledger, and dies when the permissions it was granted against change', () => {
    withRoot((root) => {
        setPermissions(root, 'fixture-beta', [READ]);

        // A complete, honest review record.
        writeLedger(root, {
            'fixture-beta': reviewRecord(root, 'fixture-beta', { notes: 'Reads its own table; nothing else.' }),
        });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0, 'a well-formed review must verify clean');

        // The catalog publishes the decision — and NOT the gate input.
        const entry = entryFor(root, 'fixture-beta');
        assert.deepEqual(entry.review, {
            status: 'reviewed',
            reviewer: 'octocat',
            date: '2026-09-04',
            notes: 'Reads its own table; nothing else.',
        });
        for (const gateInput of ['reviewedPermissionsSha256', 'reviewedVersion', 'reviewedContentSha256']) {
            assert.ok(
                !(gateInput in entry.review),
                `${gateInput} is a gate input, not something the catalog publishes`,
            );
        }

        // THE REGRESSION THIS EXISTS FOR: the plugin quietly widens what it asks for, and the badge
        // rides along unchanged. Nothing else in the catalog is derived from the permission set, so
        // without this bind the badge would survive exactly the change it is supposed to gate.
        setPermissions(root, 'fixture-beta', [READ, WRITE]);
        assert.equal(run(BUILD, root).status, 0, 'the builder still packs it — this is the GATE\'s job');

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a reviewed plugin that widened its permissions must fail');
        assert.match(r.out, /permissions changed since the review of 2026-09-04 by octocat/, r.out);
        assert.match(r.out, /re-review is required/, r.out);
    });
});

test('reordering permissions is NOT a change — the bind must fire on capability, not on formatting', () => {
    withRoot((root) => {
        setPermissions(root, 'fixture-beta', [READ, WRITE]);
        writeLedger(root, { 'fixture-beta': reviewRecord(root, 'fixture-beta') });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0);

        // Same two capabilities, opposite order, and a rewritten rationale. A gate that fires here
        // trains people to re-stamp the hash without reading the diff, which is worse than no gate.
        // This also covers the CONTENT digest, which hashes manifest.json in canonical form for exactly
        // this reason: it would otherwise fire on the same re-wording, one file further out.
        setPermissions(root, 'fixture-beta', [
            { ...WRITE, reason: 'Rewritten prose that says the same thing at greater length.' },
            READ,
        ]);
        assert.equal(run(BUILD, root).status, 0);
        const reordered = run(VERIFY, root);
        assert.equal(reordered.status, 0, `reordering and re-wording must not invalidate a review: ${reordered.out}`);

        // Nor does reformatting the manifest — same JSON, different indentation and key order.
        const manifestPath = path.join(root, 'marketplace', 'plugins', 'fixture-beta', 'manifest.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        fs.writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(m).reverse())));
        assert.equal(run(BUILD, root).status, 0);
        const reformatted = run(VERIFY, root);
        assert.equal(reformatted.status, 0, `reformatting the manifest must not invalidate a review: ${reformatted.out}`);
    });
});

/**
 * THE OTHER HALF OF "a review is a statement about a version" (REVIEW.md §6). The permission hash pins
 * what the plugin MAY REACH and says nothing whatever about what the code DOES with it. Before the
 * content bind, a reviewed plugin could replace the whole of index.js, keep the identical permission
 * set, ship it as 1.0.1 — or jump to 3.0.0, which §6 already calls a new submission's worth of change —
 * and the badge was rebuilt and republished untouched, with nothing anywhere recording which version had
 * actually been read. These are the two negative controls for that.
 */
test('a reviewed plugin that ships a NEW VERSION loses the badge until it is re-reviewed', () => {
    withRoot((root) => {
        setPermissions(root, 'fixture-beta', [READ]);
        writeLedger(root, { 'fixture-beta': reviewRecord(root, 'fixture-beta') });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0);

        // Same code, same permissions, new version — the major bump §6 calls a new submission.
        const manifestPath = path.join(root, 'marketplace', 'plugins', 'fixture-beta', 'manifest.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.version = '3.0.0';
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
        assert.equal(run(BUILD, root).status, 0, "the builder still packs it — this is the GATE's job");

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a reviewed plugin that changed version must fail');
        assert.match(r.out, /version changed since the review of 2026-09-04 by octocat/, r.out);
        assert.match(r.out, /reviewed 2\.0\.0, manifest\.json now 3\.0\.0/, r.out);
        // ONE cause, ONE failure: the version is bound by its own field, so it must not also trip the
        // content digest. A gate that reports the same change twice teaches people to skim it.
        assert.doesNotMatch(r.out, /package contents changed/, r.out);
    });
});

test('a reviewed plugin that swaps its CODE at the same version and permissions loses the badge', () => {
    withRoot((root) => {
        setPermissions(root, 'fixture-beta', [READ]);
        writeLedger(root, { 'fixture-beta': reviewRecord(root, 'fixture-beta') });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0);

        // THE REGRESSION THIS EXISTS FOR. Nothing the badge was bound to has moved: same slug, same
        // version, same permission set, same file names. Only the code the reviewer read is gone.
        fs.writeFileSync(
            path.join(root, 'marketplace', 'plugins', 'fixture-beta', 'index.js'),
            'module.exports = { register(api) { api.doSomethingEntirelyDifferent(); } };\n',
        );
        assert.equal(run(BUILD, root).status, 0);

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a reviewed plugin whose sources changed must fail');
        assert.match(r.out, /package contents changed since the review of 2026-09-04 by octocat/, r.out);
        assert.match(r.out, /the code carrying the badge is not the code that was read/, r.out);
        // And the permission/version binds must NOT fire: neither moved.
        assert.doesNotMatch(r.out, /permissions changed since/, r.out);
        assert.doesNotMatch(r.out, /version changed since/, r.out);
    });
});

test('a catalog that claims "reviewed" with no record in the ledger fails the gate', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);

        // Hand-edit the published catalog to award itself the badge. The zip is untouched, so sha256 and
        // size still match and the badge is the only thing left that can fail.
        const indexPath = distFile(root, 'marketplace-index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        index.plugins.find((p: { id: string }) => p.id === 'fixture-beta').review = {
            status: 'reviewed', reviewer: 'nobody', date: '2026-09-04',
        };
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a self-awarded badge must fail');
        assert.match(r.out, /records no review for it/, r.out);
    });
});

test('a first-party plugin cannot be marked "reviewed" — the reviewer would be the author', () => {
    withRoot((root) => {
        const manifestPath = path.join(root, 'marketplace', 'plugins', 'fixture-beta', 'manifest.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.author = 'WordJS';
        m.permissions = [READ];
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

        writeLedger(root, { 'fixture-beta': reviewRecord(root, 'fixture-beta', { reviewer: 'wordjs-maintainer' }) });
        assert.equal(run(BUILD, root).status, 0);

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'the project may not certify its own plugin as independently reviewed');
        assert.match(r.out, /never "reviewed"/, r.out);

        // "first-party" is the honest label for the same package, and it verifies.
        writeLedger(root, { 'fixture-beta': { status: 'first-party' } });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0, r.out);
        assert.deepEqual(entryFor(root, 'fixture-beta').review, { status: 'first-party' });
    });
});

/**
 * THE SYMMETRIC HALF OF THE CONFLICT-OF-INTEREST RULE, and the one that was missing.
 *
 * The check above refuses "reviewed" for a package the project wrote. Nothing refused the opposite: an
 * OUTSIDE package writing `{"status":"first-party"}` for its own slug. That is not a cosmetic label —
 * `first-party` is what WAIVES the two §2 requirements that exist precisely for outside submissions (an
 * OSI licence and a public repository where the source of this version can be read), so a package could
 * waive the requirements that make review possible at all AND publish the project's own name as its
 * badge, with a tooltip made of free text the same submitter wrote. It is the status that is supposed
 * to mean "this is our code", and it was the one status bound to nothing about authorship.
 */
test('an outside package cannot award itself "first-party" — the status that means "we wrote it"', () => {
    withRoot((root) => {
        // fixture-beta's author is NOT the project (the fixture manifest has no author at all, which is
        // the weakest possible claim to being ours).
        writeLedger(root, { 'fixture-beta': { status: 'first-party', notes: 'Maintained by the WordJS project.' } });
        assert.equal(run(BUILD, root).status, 0, "the builder still packs it — this is the GATE's job");

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a package the project did not write may not claim first-party');
        assert.match(r.out, /records "first-party" but manifest\.json author is/, r.out);
        assert.match(r.out, /WAIVES the license and repository requirements/, r.out);

        // The same package under the honest status verifies clean.
        writeLedger(root, { 'fixture-beta': { status: 'unreviewed' } });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0, r.out);

        // And it is real authorship that unlocks the claim, not the ledger's say-so.
        const manifestPath = path.join(root, 'marketplace', 'plugins', 'fixture-beta', 'manifest.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        m.author = 'WordJS';
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
        writeLedger(root, { 'fixture-beta': { status: 'first-party' } });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0, 'a genuinely first-party package still verifies');
    });
});

/**
 * REVIEW.md §9 has always said `reviewer`, `date` and the gate inputs are "required for reviewed and
 * meaningless otherwise", and nothing enforced the second half: their shape was validated only for a
 * `reviewed` record, and reviewFor() copied reviewer/date for ANY status. So a record could ship a
 * reviewer's name, an unvalidated date and an audit-sounding note on an entry the catalog itself calls
 * unreviewed. Nothing renders those today, which made it a trap for the next consumer of the field
 * rather than a live bug — the kind that is cheap now and expensive later.
 */
test('a non-"reviewed" record may not carry review evidence, and none is ever published', () => {
    withRoot((root) => {
        writeLedger(root, {
            'fixture-beta': { status: 'unreviewed', reviewer: 'security-team', date: 'audited 2026', notes: 'Full audit, no findings' },
        });
        const built = run(BUILD, root);
        assert.notEqual(built.status, 0, 'a record that claims no review may not name a reviewer');
        assert.match(built.out, /carries reviewer, date/, built.out);
        assert.match(built.out, /meaningless on any other \(REVIEW\.md §9\)/, built.out);

        // Dropping the evidence with the status is what revocation means (§7), and it builds clean —
        // `notes` stays, because a note is the one field every status may carry and is what the admin UI
        // shows on hover.
        writeLedger(root, { 'fixture-beta': { status: 'unreviewed', notes: 'Review withdrawn 2026-09-04; see the pull request.' } });
        assert.equal(run(BUILD, root).status, 0);
        assert.equal(run(VERIFY, root).status, 0);
        assert.deepEqual(entryFor(root, 'fixture-beta').review, {
            status: 'unreviewed',
            notes: 'Review withdrawn 2026-09-04; see the pull request.',
        });
    });
});

test('a ledger record for a package that no longer exists fails the gate', () => {
    withRoot((root) => {
        assert.equal(run(BUILD, root).status, 0);
        // A review decision that outlives the code it was made about is waiting to re-attach itself to
        // whatever later takes that slug.
        writeLedger(root, { 'fixture-gone': { status: 'first-party' } });

        const r = run(VERIFY, root);
        assert.equal(r.status, 1, 'a stale ledger record must fail');
        assert.match(r.out, /has no package under marketplace\/plugins\//, r.out);
    });
});

test('a malformed ledger fails the BUILD instead of silently downgrading every badge', () => {
    withRoot((root) => {
        // The dangerous failure mode is not a crash — it is a typo that makes readLedger return nothing
        // and every entry quietly publish "unreviewed" while the build stays green.
        writeLedger(root, { 'fixture-beta': { status: 'trusted' } });
        const built = run(BUILD, root);
        assert.notEqual(built.status, 0, 'an unknown review status must fail the build');
        assert.match(built.out, /status "trusted"/, built.out);

        // Same for a "reviewed" record that is missing the evidence a review is made of.
        writeLedger(root, { 'fixture-beta': { status: 'reviewed', reviewer: 'octocat' } });
        const second = run(BUILD, root);
        assert.notEqual(second.status, 0, 'a reviewed record with no date must fail the build');
        assert.match(second.out, /is "reviewed" but has no date/, second.out);
    });
});

// ══════════════ THE EGRESS RULE (marketplace/REVIEW.md §3.6, scan-plugin.mjs) ══════════════
//
// §3.6 says what is refused is "a justification that never says where the traffic goes at all". The
// first regex did not do that: it accepted a bare `[a-z0-9-]+\.[a-z]{2,}` (so any filename with an
// extension, and any sentence whose full stop is not followed by a space) and a list of loose
// ADJECTIVES (`dynamic`, `arbitrary`, `unbounded`). Prose naming no destination whatsoever cleared the
// gate whenever it happened to mention a file or use one of those words in an unrelated sense — only
// the literal example in the doc ("talks to the internet") was actually caught.
//
// These drive the REAL script over real packages, because the regex is only half of it: what matters is
// whether a submission with that rationale is refused.

/** A minimal but COMPLETE outside submission, so the only thing that can fail is the egress rule. */
function mkEgressRoot(cases: { slug: string; reason: string }[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-egress-'));
    for (const { slug, reason } of cases) {
        const dir = path.join(root, 'marketplace', 'plugins', slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: slug,
            name: slug,
            version: '1.0.0',
            description: 'A fixture submission that requests network access.',
            author: 'An Outside Author',
            license: 'MIT',
            repository: 'https://example.org/an-outside-author/' + slug,
            isolated: true,
            permissions: [{ scope: 'network', reason }],
        }, null, 2));
        fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n');
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    }
    return root;
}

/** The problems the report printed for one slug (the report is one block per package). */
function problemsFor(out: string, slug: string): string {
    const lines = out.split(/\r?\n/);
    // The report prints "  ✓ <slug>" / "  ✗ <slug>" and then indented bullets, so a block runs to the
    // next such heading. Matched by hand rather than by regex: the markers are non-ASCII and the slug
    // would have to be escaped into a pattern for nothing.
    const heading = (l: string): string | null => {
        const t = l.trim();
        return t.startsWith('✓ ') || t.startsWith('✗ ') ? t.slice(2).split(' ')[0] : null;
    };
    const start = lines.findIndex((l) => heading(l) === slug);
    assert.ok(start >= 0, `no report block for ${slug}:\n${out}`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => heading(l) !== null);
    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

test('the egress rule refuses prose that names no destination, and accepts prose that does', () => {
    const REFUSED = [
        // The bare adjective `dynamic` used to satisfy the rule on its own.
        { slug: 'egress-adjective', reason: 'The plugin performs dynamic content loading for the gallery widget when a visitor scrolls.' },
        // `README.md` used to satisfy the "a host is a dotted name" alternative — .md is a ccTLD.
        { slug: 'egress-filename', reason: 'Fetches remote content for the widget. Documented in README.md for the curious reader.' },
        // A full stop with no space after it used to produce a "hostname" out of two ordinary words.
        { slug: 'egress-nospace', reason: 'The plugin requires outbound network access.It is needed for the feature to work at all.' },
        // The case the doc itself names as a rejection.
        { slug: 'egress-silent', reason: 'Talks to the internet on behalf of the site owner when the feature is enabled.' },
    ];
    const ACCEPTED = [
        { slug: 'egress-host', reason: 'Creates and verifies Checkout Sessions against api.stripe.com when a Stripe key is configured.' },
        // The mail-server case: a destination genuinely resolved per message, named as a MECHANISM.
        { slug: 'egress-runtime', reason: 'Resolves MX records (DNS) and delivers mail directly to remote MTAs, or to a configured relay.' },
        // An explicit list, which is how an author names a destination whose TLD the host pattern does
        // not know — a rejection there is a conversation, never a dead end.
        { slug: 'egress-list', reason: 'Posts each submission to the endpoint the operator enters. egress: https://hooks.example.de/ingest' },
    ];

    const root = mkEgressRoot([...REFUSED, ...ACCEPTED]);
    try {
        const slugs = [...REFUSED, ...ACCEPTED].map((c) => c.slug);
        const r = run(SCAN, root, ['--only=manifest', ...slugs]);

        for (const { slug } of REFUSED) {
            const block = problemsFor(r.out, slug);
            assert.match(block, /must document its destinations/, `${slug} must be refused:\n${block}`);
        }
        for (const { slug } of ACCEPTED) {
            const block = problemsFor(r.out, slug);
            assert.doesNotMatch(block, /must document its destinations/, `${slug} must be accepted:\n${block}`);
            // ... and nothing ELSE may fail either, or the fixture is not proving what it claims.
            assert.match(block, /✓/, `${slug} must pass the whole manifest check:\n${block}`);
        }
        assert.equal(r.status, 1, 'a run containing refused packages must exit non-zero');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an outside package cannot buy the first-party licence/repository waiver with a ledger record', () => {
    // scan-plugin.mjs read `firstParty` from the ledger ALONE, so the two §2 requirements that exist for
    // outside submissions — an OSI licence and a public repository where this version's source can be
    // read — were waived by a line the submitter wrote about themselves.
    const root = mkEgressRoot([{ slug: 'outsider', reason: 'Calls api.stripe.com to create Checkout Sessions when a key is configured.' }]);
    try {
        const manifestPath = path.join(root, 'marketplace', 'plugins', 'outsider', 'manifest.json');
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        delete m.license;
        delete m.repository;
        fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
        fs.writeFileSync(path.join(root, 'marketplace', 'reviews.json'), JSON.stringify({ outsider: { status: 'first-party' } }, null, 4));

        const r = run(SCAN, root, ['--only=manifest', 'outsider']);
        assert.equal(r.status, 1, 'the waiver must not follow from the ledger alone');
        assert.match(r.out, /missing "license"/, r.out);
        assert.match(r.out, /missing "repository"/, r.out);
        // As PROBLEMS, not as the notes a genuinely first-party package gets.
        assert.doesNotMatch(problemsFor(r.out, 'outsider'), /waived for a first-party package/, r.out);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// ═══════ WHICH CATALOG THE BADGE SPEAKS FOR (backend/src/routes/marketplace.ts) ═══════
//
// `review` travels INSIDE whichever catalog index answered, and an administrator may point WordJS at
// any number of sources — "any number of catalogs, official or private" is what resolveSources() is
// for. The ledger, this gate and all of REVIEW.md cover exactly one catalog: the one this repository
// publishes. Nothing validates a review claim made by a private, third-party or compromised index, so
// an arbitrary URL could otherwise hand the admin an emerald "Reviewed" pill with a reviewer's name and
// a date on it, on the highest-privilege screen in the product, immediately above an Install button.
//
// The backend answers that by republishing every entry from a non-official source as `unreviewed`, and
// isOfficialSource is the decision. It is tested directly because it is where the whole property lives:
// get it wrong in the permissive direction and the badge is forgeable by anyone who can get an admin to
// add a source.

test('isOfficialSource: only this project\'s own catalog is one the badge may speak for', () => {
    const { isOfficialSource } = require('../routes/marketplace');
    const officialDist = path.resolve(__dirname, '../../../marketplace/dist');

    // The two shapes that ARE ours: the release feed the product ships with, and this checkout's own
    // build output (built from the tracked sources and the tracked ledger, gated in CI).
    assert.equal(isOfficialSource('https://github.com/jaimemartinez/wordjs/releases/latest/download', false), true);
    assert.equal(isOfficialSource(officialDist, true), true,
        'the repo-local dist is built from the tracked ledger — it is the catalog the gate runs over');

    // Pinning a fixed release is documented and supported (the marketplace_source option), so it must
    // not cost the entry its badge.
    assert.equal(isOfficialSource('https://github.com/jaimemartinez/wordjs/releases/download/v1.6.1', false), true);

    // Everything else is somebody else's index.
    for (const foreign of [
        'https://example.com/wordjs/catalog',
        // A look-alike host. Substring matching on "github.com" would accept this.
        'https://github.com.evil.example/jaimemartinez/wordjs/releases/latest/download',
        // A look-alike path under the real host.
        'https://github.com/someone-else/wordjs/releases/latest/download',
        // Traversal that resolves back out of our path (WHATWG URL normalises the dot segments).
        'https://github.com/jaimemartinez/wordjs/releases/../../someone-else/wordjs/releases/latest/download',
        // Plain http, even to the right place: a catalog that can be rewritten in flight cannot carry a
        // claim about who reviewed what.
        'http://github.com/jaimemartinez/wordjs/releases/latest/download',
        '',
    ]) {
        assert.equal(isOfficialSource(foreign, false), false, `must not be treated as official: ${foreign}`);
    }

    // A local directory that is not this checkout's dist is equally somebody else's index.
    assert.equal(isOfficialSource(path.join(os.tmpdir(), 'not-our-dist'), true), false);
    assert.equal(isOfficialSource(path.join(officialDist, 'nested'), true), false);
});

test('the catalog merge strips a review claim that did not come from the official catalog', () => {
    // The merge itself: every entry is stamped with whether its source is ours, and `review` is
    // REPLACED (not passed through) for everything else. Read out of the shipping source because the
    // handler around it needs a database, an administrator and an HTTP client to reach, and this one
    // expression is the whole of the rule.
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/marketplace.ts'), 'utf8');
    const push = src.slice(src.indexOf('merged.push({'), src.indexOf('added++;'));

    assert.ok(push.includes('official'), `the merged entry must carry the official flag:\n${push}`);
    assert.match(push, /review:\s*official\s*\?\s*e\.review\s*:\s*\{\s*status:\s*'unreviewed'\s*\}/, push);
    // And the flag must be computed per SOURCE, from the predicate above — not read off the entry,
    // which is exactly the data a hostile index controls.
    assert.match(src, /const official = isOfficialSource\(s\.url, s\.isLocal\)/, 'official must be derived from the source');
});
