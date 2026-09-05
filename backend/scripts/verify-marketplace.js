/**
 * WordJS marketplace catalog verifier.
 *
 * WHY THIS EXISTS
 * ---------------
 * CI used to "verify" the catalog with `git diff --exit-code -- marketplace/dist`. That gate could
 * never fail: marketplace/dist/ is gitignored (.gitignore `**\/dist/`) and has ZERO tracked files, so
 * git had nothing to diff. It reported green while checking nothing — which is exactly how a stale or
 * mismatched plugin zip reaches a release unverified.
 *
 * The catalog is NOT committed: build-marketplace.js produces it and release.yml attaches it to the
 * GitHub Release (routes/marketplace.ts documents this — a raw.githubusercontent.com/main URL 404s).
 * So "is the committed catalog fresh?" is not a question that can be asked. The question that CAN be
 * asked, and that actually protects installs, is: does the catalog metadata match the artifacts it
 * publishes, and are those artifacts installable?
 *
 * WHAT IS ACTUALLY CHECKED (deliberately only things that cross a representation boundary — re-deriving
 * a field with the same formula the builder used would be tautological and would prove nothing):
 *
 *   1. sha256 + size of the BYTES ON DISK vs the catalog entry. routes/marketplace.ts refuses to
 *      install a package whose sha256 does not match its entry, so a drift here bricks every install.
 *   2. The manifest.json / theme.json INSIDE the zip vs the entry (id + version). Catches a zip that
 *      is advertised as one thing and contains another.
 *   3. Every frontend entry the source manifest DECLARES has its compiled dist/<name>.bundle.js
 *      inside the zip. build-plugin.js silently skips an entry whose file is missing
 *      (`if (fs.existsSync(fullPath))`), so the build stays green while shipping a plugin whose admin
 *      page or Puck block can never load — the exact regression that shipped twice already.
 *   4. No runtime state inside a zip: a plugin's top-level data/ holds live secrets (mail-server's AES
 *      root key data/.mailenc, user attachments). A packer regression here leaks them to every install.
 *   5. Installer-shape compatibility with routes/marketplace.ts: the filename must satisfy the same
 *      SAFE_FILE_RE, and the package must be under the same 10MB cap. Either violation makes the entry
 *      uninstallable no matter how well-formed the catalog looks.
 *   6. Coverage + orphans: every source package appears exactly once in its index, and no unreferenced
 *      file is left in dist to be uploaded as a release asset.
 *   7. (--rebuild) Determinism: a second build of unchanged sources must be byte-identical. The whole
 *      "deterministic catalog" claim rests on this and nothing verified it.
 *   8. The review badge (marketplace/REVIEW.md): every entry publishes a `review` object; a `reviewed`
 *      status matches a record in the tracked ledger marketplace/reviews.json; that record's
 *      reviewedPermissionsSha256 still matches the manifest's permission set (a plugin cannot widen
 *      its capabilities and keep the badge); its reviewedVersion + reviewedContentSha256 still match
 *      the package on disk (a plugin cannot swap its code and keep the badge); a first-party plugin can
 *      never be "reviewed"; and "first-party" can only be claimed by a first-party author.
 *
 * Usage:  node backend/scripts/verify-marketplace.js [--rebuild]
 *         (run build-marketplace.js first; --rebuild runs a second build and diffs it)
 *
 * Env:    WORDJS_MARKETPLACE_ROOT  repo root override (tests point this at a fixture tree)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { spawnSync } = require('child_process');
// Same resolver build-plugin.js uses, so "which bundles should be in this zip" cannot drift from
// "which bundles the builder emits" — the drift that already shipped bundle-less catalog zips once.
const { resolveBlockEntry } = require('./plugin-block-contract');
// The review ledger reader shared with build-marketplace.js. Same reason as above: "what does the
// review badge mean" must have exactly one definition, or the gate ends up certifying its own copy.
const { readLedger, reviewFor, permissionsSha256, packageContentSha256, isFirstPartyAuthor, REVIEW_STATUSES } = require('./marketplace-review');

const ROOT = process.env.WORDJS_MARKETPLACE_ROOT
    ? path.resolve(process.env.WORDJS_MARKETPLACE_ROOT)
    : path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'marketplace', 'plugins');
const THEMES_SRC = path.join(ROOT, 'marketplace', 'themes');
const DIST = path.join(ROOT, 'marketplace', 'dist');

const INDEX_FILE = 'marketplace-index.json';
const THEMES_INDEX_FILE = 'marketplace-themes-index.json';

// MUST stay in sync with backend/src/routes/marketplace.ts — an entry that fails either of these is
// rejected by the installer, so publishing it produces a catalog row that can never be installed.
const SAFE_FILE_RE = /^[A-Za-z0-9_-]+-[A-Za-z0-9][A-Za-z0-9.-]*\.zip$/;
const MAX_ZIP_BYTES = 10 * 1024 * 1024;

// Mirrors build-marketplace.js: junk that must never ship inside a package.
const JUNK_RE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.git|node_modules)(\/|$)/i;

const errors = [];
const fail = (msg) => errors.push(msg);

// The tracked review ledger (marketplace/reviews.json), loaded once by main(). {} when there is none —
// which is the correct reading of "nothing reviewed yet", and the state a fixture tree is in.
let ledger = {};

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceDirs(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/**
 * Re-derives the frontend bundles build-plugin.js would emit, sharing build-plugin.js's OWN resolver
 * (plugin-block-contract.js: versoComponents.entry → legacy puckComponents.entry → legacy
 * components[0].entry → conventional client/verso/<Pascal>Verso.tsx then client/puck/<Pascal>Puck.tsx;
 * `frontend.hooks` is a bare string path). Returns { expected: [...bundle names], missingSrc: [...] }.
 *
 * missingSrc is a DECLARED entry whose source file does not exist: build-plugin swallows that case, so
 * the manifest advertises a frontend the package cannot possibly contain.
 */
function expectedBundles(dir, manifest) {
    const fe = manifest.frontend || {};
    const expected = [];
    const missingSrc = [];
    const resolve = (name, rel, declared) => {
        if (!rel) return;
        if (fs.existsSync(path.join(dir, String(rel).replace('./', '')))) expected.push(name);
        else if (declared) missingSrc.push(`${name} → ${rel}`);
    };

    resolve('admin', fe.adminPage?.entry, true);

    // `warn: false` — this verifier walks the whole catalog twice (once per --rebuild pass) and the
    // deprecation lines belong to the BUILD output, where an author can act on them.
    const block = resolveBlockEntry(dir, manifest, { componentsChannel: true, warn: false });
    resolve('component', block?.entry, Boolean(block?.declared));

    // `frontend.hooks` is a bare string in the manifests that use it (mail-server), not an object.
    const hooks = typeof fe.hooks === 'string' ? fe.hooks : fe.hooks?.entry;
    resolve('hooks', hooks, Boolean(fe.hooks));

    return { expected, missingSrc };
}

/**
 * (8) THE REVIEW BADGE  —  marketplace/REVIEW.md.
 *
 * `review.status: "reviewed"` is the only field in the catalog that makes a claim about a HUMAN
 * decision, so it is the only one an author could gain by writing down and nobody would notice. Each of
 * the checks below crosses a representation boundary (catalog artifact ↔ tracked ledger ↔ source
 * manifest ↔ source tree) rather than re-deriving a field with the formula that produced it:
 *
 *   a. The published `review` matches what marketplace/reviews.json says today. A catalog built from
 *      an older ledger, or hand-edited after the build, disagrees here.
 *   b. A "reviewed" plugin's permissions are still the ones the reviewer approved. Every review is
 *      bound to reviewedPermissionsSha256 — the sorted, deduped grant-token set at review time — so a
 *      plugin that quietly adds `filesystem:write` after being reviewed FAILS and must be re-reviewed
 *      (REVIEW.md §6). Without this the badge would survive exactly the change it exists to gate.
 *   b2. A "reviewed" plugin is still the CODE the reviewer read. The permission hash pins what the
 *      plugin may reach and says nothing about what it does; without this bind a reviewed plugin could
 *      replace the whole of index.js, ship it under the same permissions at 1.0.1 (or jump to 3.0.0,
 *      which §6 already calls a new submission's worth of change), and the badge was republished
 *      unchanged — with nothing anywhere recording WHICH version had been reviewed. reviewedVersion +
 *      reviewedContentSha256 are checked against the manifest and the tracked source tree.
 *   c. The conflict-of-interest rule, BOTH WAYS. A first-party plugin is "first-party", never
 *      "reviewed": when the reviewer and the author are the same project the badge certifies nothing.
 *      And "first-party" is not a status an outside submission may award itself — it is what waives the
 *      two §2 requirements that exist for outside submissions (an OSI licence and a public repository
 *      where the source of this version can be read), so a submission that self-declares it publishes
 *      the first-party pill AND opts out of the requirements that make review possible at all. Both
 *      directions are mechanical; only one of them used to be.
 *
 * FAIL, NOT DOWNGRADE. Every one of these makes the run RED rather than quietly republishing the entry
 * as `unreviewed`. The badge is derived from the ledger by the BUILDER, so a silent downgrade would
 * need the same rule in build-marketplace.js as well — a second copy of a rule is precisely the drift
 * this module's shared reader exists to prevent — and it would drop a maintainer's recorded decision
 * with a green check on the run. Red is also cheap here: `reviewed` is a rare, outside-only claim (a
 * first-party package can never carry it), so routine maintenance cannot trip these.
 */
function verifyReview(entry, meta, dir) {
    const label = `plugin ${entry.id}`;
    const got = entry.review;

    if (!got || typeof got !== 'object' || Array.isArray(got)) {
        fail(`${label}: catalog entry has no "review" object — every entry must publish one (see marketplace/REVIEW.md)`);
        return;
    }
    if (!REVIEW_STATUSES.includes(got.status)) {
        fail(`${label}: review.status "${got.status}" is not one of ${REVIEW_STATUSES.join(', ')}`);
        return;
    }

    // (a) The catalog must agree with the ledger that is committed right now.
    const expected = reviewFor(ledger, entry.id);
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(got)])].sort()) {
        if (String(expected[key] ?? '') !== String(got[key] ?? '')) {
            fail(`${label}: catalog publishes review.${key} "${got[key] ?? ''}" but marketplace/reviews.json says "${expected[key] ?? ''}" — rebuild the catalog`);
        }
    }

    const record = ledger[entry.id];

    // (c) Conflict of interest, the "first-party" direction. Checked for the CLAIM as published, so a
    // hand-edited index is caught as well as a self-written ledger record.
    if (got.status === 'first-party' && !isFirstPartyAuthor(meta.author)) {
        fail(
            `${label}: marketplace/reviews.json records "first-party" but manifest.json author is "${meta.author || ''}" — ` +
            `"first-party" means authored by the project itself, and it WAIVES the license and ` +
            `repository requirements that exist for outside submissions (REVIEW.md §2, §3 note, §8). ` +
            `An outside package is "unreviewed" until a reviewer records a decision`,
        );
    }

    if (got.status === 'reviewed') {
        if (!record || record.status !== 'reviewed') {
            fail(`${label}: catalog claims review.status "reviewed" but marketplace/reviews.json records no review for it`);
            return;
        }
        // (c) Conflict of interest, the "reviewed" direction.
        if (isFirstPartyAuthor(meta.author)) {
            fail(`${label}: author "${meta.author}" is the project itself — a first-party plugin carries review.status "first-party", never "reviewed" (REVIEW.md §8)`);
        }
        // (b) The review is bound to the capability set it was granted against.
        const current = permissionsSha256(meta.permissions);
        if (current !== record.reviewedPermissionsSha256) {
            fail(
                `${label}: permissions changed since the review of ${record.date} by ${record.reviewer} ` +
                `(reviewed ${record.reviewedPermissionsSha256}, manifest.json now ${current}) — ` +
                `re-review is required before the badge may be published (REVIEW.md §6)`,
            );
        }
        // (b2) ... and to the artefact the reviewer actually read. Both halves are reported in one run:
        // a version bump WITH a code change is one re-review, not two rounds of red.
        const srcVersion = String(meta.version || '1.0.0');
        if (srcVersion !== String(record.reviewedVersion)) {
            fail(
                `${label}: version changed since the review of ${record.date} by ${record.reviewer} ` +
                `(reviewed ${record.reviewedVersion}, manifest.json now ${srcVersion}) — ` +
                `a review is a statement about one version; re-review is required before the badge may be published (REVIEW.md §6)`,
            );
        }
        const content = packageContentSha256(dir);
        if (content !== record.reviewedContentSha256) {
            fail(
                `${label}: package contents changed since the review of ${record.date} by ${record.reviewer} ` +
                `(reviewed ${record.reviewedContentSha256}, marketplace/plugins/${entry.id} now ${content}) — ` +
                `the code carrying the badge is not the code that was read; re-review is required (REVIEW.md §6)`,
            );
        }
    }
}

/**
 * (8, continued) The ledger itself. A record for a plugin that no longer exists is not harmless: it is
 * a review decision that survives the code it was made about, ready to re-attach itself to whatever
 * later takes that slug.
 */
function verifyLedger(srcRoot) {
    const sources = new Set(sourceDirs(srcRoot));
    for (const slug of Object.keys(ledger)) {
        if (!sources.has(slug)) {
            fail(`marketplace/reviews.json: records "${slug}", which has no package under marketplace/plugins/ — drop the stale entry`);
        }
    }
}

/**
 * Shared per-entry verification for both catalogs. `kind` is 'plugin' | 'theme'.
 */
function verifyEntry(entry, kind, srcRoot, seenFiles) {
    const label = `${kind} ${entry.id}`;
    const dir = path.join(srcRoot, entry.id);

    if (!SAFE_FILE_RE.test(String(entry.file || ''))) {
        fail(`${label}: file "${entry.file}" does not match the installer's SAFE_FILE_RE — uninstallable`);
        return;
    }

    // Filename derived from the TRACKED source of truth, not copied from the index.
    const metaFile = kind === 'theme' ? 'theme.json' : 'manifest.json';
    const metaPath = path.join(dir, metaFile);
    if (!fs.existsSync(metaPath)) {
        fail(`${label}: index entry has no source package at ${dir}`);
        return;
    }
    const meta = readJson(metaPath);
    const srcVersion = String(meta.version || '1.0.0');
    const expectedFile = kind === 'theme' ? `theme-${entry.id}-${srcVersion}.zip` : `${entry.id}-${srcVersion}.zip`;
    if (entry.file !== expectedFile) {
        fail(`${label}: catalog publishes "${entry.file}" but ${metaFile} version ${srcVersion} means "${expectedFile}"`);
    }
    if (String(entry.version) !== srcVersion) {
        fail(`${label}: catalog says version ${entry.version} but ${metaFile} says ${srcVersion}`);
    }

    const zipPath = path.join(DIST, entry.file);
    if (!fs.existsSync(zipPath)) {
        fail(`${label}: catalog references ${entry.file} but that file is not in dist/`);
        return;
    }
    seenFiles.add(entry.file);

    // (1) Integrity of the BYTES ON DISK — the exact check routes/marketplace.ts runs before install.
    const buf = fs.readFileSync(zipPath);
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 || ''))) {
        fail(`${label}: sha256 "${entry.sha256}" is not a 64-char lowercase hex digest`);
    } else if (digest !== String(entry.sha256).toLowerCase()) {
        fail(`${label}: sha256 MISMATCH — catalog ${entry.sha256}, ${entry.file} on disk ${digest} (every install would be refused)`);
    }
    if (buf.length !== entry.size) {
        fail(`${label}: size mismatch — catalog ${entry.size}, ${entry.file} on disk ${buf.length}`);
    }
    if (buf.length > MAX_ZIP_BYTES) {
        fail(`${label}: ${entry.file} is ${(buf.length / 1024 / 1024).toFixed(1)}MB — over the installer's ${MAX_ZIP_BYTES / 1024 / 1024}MB cap`);
    }

    const names = new AdmZip(buf).getEntries().map((e) => e.entryName);

    // (2) The package must contain the metadata the catalog advertises.
    const innerMetaName = `${entry.id}/${metaFile}`;
    const innerMetaEntry = new AdmZip(buf).getEntry(innerMetaName);
    if (!innerMetaEntry) {
        fail(`${label}: ${entry.file} does not contain ${innerMetaName}`);
    } else {
        let inner;
        try {
            inner = JSON.parse(innerMetaEntry.getData().toString('utf8'));
        } catch {
            fail(`${label}: ${innerMetaName} inside ${entry.file} is not valid JSON`);
        }
        if (inner) {
            if (kind === 'plugin' && inner.id !== entry.id) {
                fail(`${label}: ${entry.file} contains manifest id "${inner.id}" — the catalog advertises "${entry.id}"`);
            }
            if (String(inner.version || '1.0.0') !== String(entry.version)) {
                fail(`${label}: ${entry.file} contains version ${inner.version} — the catalog advertises ${entry.version}`);
            }
        }
    }

    // (4) Runtime state / junk must never ship.
    for (const n of names) {
        if (n === `${entry.id}/data` || n.startsWith(`${entry.id}/data/`)) {
            fail(`${label}: ${entry.file} ships runtime state "${n}" — plugin data/ holds live secrets`);
            break;
        }
    }
    const junk = names.find((n) => JUNK_RE.test(n));
    if (junk) fail(`${label}: ${entry.file} ships junk entry "${junk}"`);

    // (3) Declared frontend must actually be compiled into the package (plugins only).
    if (kind === 'plugin') {
        // (8) The review badge, against the tracked ledger, the source manifest's permissions and the
        // package source tree the review was made about.
        verifyReview(entry, meta, dir);

        const { expected, missingSrc } = expectedBundles(dir, meta);
        for (const m of missingSrc) {
            fail(`${label}: manifest declares a frontend entry whose source file is missing (${m}) — build-plugin skips it silently and the package ships without that bundle`);
        }
        for (const name of expected) {
            const bundle = `${entry.id}/dist/${name}.bundle.js`;
            if (!names.includes(bundle)) {
                fail(`${label}: ${entry.file} is missing ${bundle} — its admin page / block can never load once installed`);
            }
        }
    }
}

function verifyCatalog(kind, indexFile, listKey, srcRoot, seenFiles) {
    const indexPath = path.join(DIST, indexFile);
    if (!fs.existsSync(indexPath)) {
        fail(`${indexFile} is missing from ${DIST} — run 'npm run build:marketplace' first`);
        return;
    }
    seenFiles.add(indexFile);

    let index;
    try {
        index = readJson(indexPath);
    } catch (e) {
        fail(`${indexFile} is not valid JSON: ${e.message}`);
        return;
    }
    const list = index[listKey];
    if (!Array.isArray(list)) {
        fail(`${indexFile}: "${listKey}" is not an array`);
        return;
    }
    if (index.count !== list.length) {
        fail(`${indexFile}: count says ${index.count} but ${listKey} has ${list.length} entries`);
    }

    // (6) Coverage: every source package is published exactly once.
    const ids = list.map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) fail(`${indexFile}: duplicate entries for ${[...new Set(dupes)].join(', ')}`);

    const sources = sourceDirs(srcRoot);
    const missing = sources.filter((s) => !ids.includes(s));
    if (missing.length) {
        fail(`${indexFile}: source ${kind}(s) not published in the catalog: ${missing.join(', ')}`);
    }

    for (const entry of list) verifyEntry(entry, kind, srcRoot, seenFiles);
}

/**
 * (7) Determinism: rebuild and require byte-identical output. Reproducibility is what lets anyone
 * re-derive a published zip from the tagged sources; it is also the premise every "catalog freshness"
 * idea rests on. Nothing verified it before.
 */
function verifyDeterminism() {
    const snapshot = () => {
        const out = {};
        for (const f of fs.readdirSync(DIST).sort()) {
            out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIST, f))).digest('hex');
        }
        return out;
    };
    const before = snapshot();
    const builder = path.join(__dirname, 'build-marketplace.js');
    const r = spawnSync(process.execPath, [builder], { encoding: 'utf8', env: process.env });
    if (r.status !== 0) {
        fail(`rebuild failed: ${(r.stdout || '') + (r.stderr || '')}`);
        return;
    }
    const after = snapshot();
    for (const f of Object.keys(before)) {
        if (!(f in after)) fail(`determinism: rebuild dropped ${f}`);
        else if (before[f] !== after[f]) fail(`determinism: rebuilding unchanged sources changed ${f} (${before[f]} → ${after[f]})`);
    }
    for (const f of Object.keys(after)) {
        if (!(f in before)) fail(`determinism: rebuild added ${f}`);
    }
}

function main() {
    if (!fs.existsSync(DIST)) {
        console.error(`✗ ${DIST} does not exist — run 'npm run build:marketplace' first.`);
        process.exit(1);
    }

    // The review ledger is a GATE INPUT, so a malformed one is a failure, never a silent {} that would
    // downgrade every badge to `unreviewed` and pass.
    try {
        ledger = readLedger(ROOT);
    } catch (e) {
        fail(e.message);
    }
    verifyLedger(SRC);

    const seenFiles = new Set();
    verifyCatalog('plugin', INDEX_FILE, 'plugins', SRC, seenFiles);
    verifyCatalog('theme', THEMES_INDEX_FILE, 'themes', THEMES_SRC, seenFiles);

    // (6) Orphans: release.yml uploads `marketplace/dist/*` wholesale, so an unreferenced file is
    // published as a release asset nobody's catalog points at (e.g. a zip left from an older version).
    for (const f of fs.readdirSync(DIST)) {
        if (!seenFiles.has(f)) fail(`dist/${f} is not referenced by any catalog entry — it would still be uploaded as a release asset`);
    }

    if (process.argv.includes('--rebuild')) verifyDeterminism();

    if (errors.length) {
        console.error(`\n✗ marketplace catalog verification FAILED (${errors.length} problem(s)):\n`);
        for (const e of errors) console.error(`  • ${e}`);
        console.error('');
        process.exit(1);
    }
    console.log(`✅ marketplace catalog verified — every published zip matches its catalog entry (sha256, size, inner manifest, compiled bundles) and every review badge matches the ledger.`);
}

main();
