/**
 * WordJS marketplace REVIEW LEDGER — the one reader.
 *
 * The public policy lives in marketplace/REVIEW.md; this module is the only place that knows how the
 * ledger is SHAPED and how a review is bound to the permissions it was granted against. Both the
 * builder (build-marketplace.js, which stamps `review` into every catalog entry) and the gate
 * (verify-marketplace.js, which re-derives it from the tracked ledger and refuses drift) go through
 * here on purpose: this repository has already shipped two bugs whose whole cause was a second,
 * private copy of a rule that then drifted from the first (see the header of build-marketplace.js).
 *
 * THE LEDGER  —  marketplace/reviews.json, a flat map keyed by plugin slug:
 *
 *     {
 *       "<slug>": {
 *         "status": "first-party" | "reviewed" | "unreviewed",
 *         "reviewer": "<GitHub handle of the reviewer>",     // "reviewed" ONLY
 *         "date": "YYYY-MM-DD",                              // "reviewed" ONLY
 *         "reviewedVersion": "<semver>",                     // "reviewed" ONLY
 *         "reviewedPermissionsSha256": "<64 hex>",           // "reviewed" ONLY
 *         "reviewedContentSha256": "<64 hex>",               // "reviewed" ONLY
 *         "notes": "<free text, published in the catalog>"
 *       }
 *     }
 *
 * A slug that is absent from the ledger is `unreviewed` — the default, and the only status a plugin
 * can reach without a human decision being recorded in a tracked file.
 *
 * THE FIVE REVIEW FIELDS ARE "reviewed" ONLY, AND THAT IS ENFORCED BOTH WAYS. REVIEW.md §9 has always
 * said they are "meaningless otherwise"; until this was enforced, readLedger validated their shape only
 * for a `reviewed` record and reviewFor() published `reviewer`/`date` for ANY status. So
 * `{"status":"unreviewed","reviewer":"security-team","date":"audited 2026"}` validated, built, verified
 * clean and shipped a reviewer and an unvalidated date on an entry the catalog itself calls unreviewed.
 * Now: a record that is not `reviewed` may not carry them at all (readLedger refuses it, naming §9), and
 * reviewFor() emits them only for `reviewed`. Revoking a review (§7) therefore means dropping the
 * evidence with the status — a record cannot keep a reviewer's name attached to a claim it no longer
 * makes.
 *
 * WHY THE PERMISSION HASH EXISTS. "Reviewed" is a statement about a specific set of capabilities a
 * human judged to be the minimum the plugin needs. If the plugin later asks for `filesystem:write`
 * and the badge rides along unchanged, the badge is a lie — and it is a lie that no test would catch,
 * because nothing else in the catalog is derived from the permission set. reviewedPermissionsSha256
 * pins the capability set that was actually reviewed; verify-marketplace.js recomputes it from the
 * manifest on disk and fails when the two disagree, which forces the re-review that REVIEW.md §6
 * requires instead of merely asking for it.
 *
 * WHAT THE HASH COVERS, AND WHY NOT MORE. The canonical form is the SORTED, DEDUPED set of grant
 * tokens — `scope:access`, or the bare `scope` for the scope-only `network` permission. That is
 * exactly the vocabulary the runtime grant system keys on (core/plugin-permissions.isGranted), so the
 * hash changes precisely when the plugin's reachable capability set changes, and never merely because
 * the manifest was reformatted or the permissions reordered. The human-readable `reason` prose is
 * deliberately NOT hashed: a typo fix there would otherwise invalidate a review, and a gate that
 * fires on noise trains people to re-stamp the hash without looking, which is worse than no gate.
 * A materially rewritten rationale is still a re-review trigger by policy (REVIEW.md §6) — that half
 * is a human judgement and this module does not pretend to enforce it.
 *
 * WHY THE CONTENT DIGEST EXISTS. The permission hash pins WHAT THE PLUGIN MAY REACH; it says nothing
 * about WHAT THE CODE DOES with it. A reviewed plugin could replace the whole of index.js, ship it as
 * 1.0.1 (or as 3.0.0, which §6 already calls a new submission's worth of change), keep the identical
 * permission set, and the badge was rebuilt and republished unchanged — nobody could even determine
 * afterwards WHICH version carried the review. reviewedVersion + reviewedContentSha256 pin the artefact
 * a human actually read, and verify-marketplace.js fails when the shipped package is not that artefact.
 *
 * WHAT THE CONTENT DIGEST COVERS. The files the packer ships out of marketplace/plugins/<slug>/ —
 * everything walk() would pack — MINUS `dist/`. The bundles under dist/ are build output, gitignored,
 * and reproduced from the `client/**` sources that ARE hashed; including them would bind the badge to
 * an esbuild patch version, so a dependency bump on OUR side would revoke someone else's review. That
 * is the "gate that fires on noise" failure the permission hash is careful to avoid. Text files are
 * hashed with CRLF normalised to LF for the same reason: this repository has no global `text=auto` in
 * .gitattributes, so the same commit is CRLF on a Windows checkout and LF on CI, and a digest that
 * moved between them would fire on nothing at all. manifest.json is hashed in canonical form for the
 * third time on the same principle — see canonicalManifest.
 *
 * WHY NOT THE ZIP's sha256. It is already in the catalog and already verified byte-for-byte — but it is
 * a BUILD output. Binding the badge to it would mean every rebuild on a different toolchain invalidates
 * every outside review; and it would compare a build product against a build product rather than
 * crossing ledger ↔ tracked source, which is the boundary the rest of this gate is built on.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** The three statuses a catalog entry may publish. */
const REVIEW_STATUSES = ['first-party', 'reviewed', 'unreviewed'];

/**
 * Authors that are the project itself. A first-party plugin can never be "reviewed": the reviewer and
 * the author would be the same party, so the badge would certify nothing (REVIEW.md §8). The check is
 * mechanical rather than a note in the policy because a conflict-of-interest rule nobody can violate
 * by accident is the only kind that survives contact with a busy release.
 */
const FIRST_PARTY_AUTHORS = ['WordJS'];

function ledgerPath(root) {
    return path.join(root, 'marketplace', 'reviews.json');
}

function isFirstPartyAuthor(author) {
    return FIRST_PARTY_AUTHORS.includes(String(author || '').trim());
}

/**
 * One permission → its grant token. `network` is SCOPE-ONLY (its token is the bare literal, never
 * `network:<access>`), mirroring core/plugins.ts and core/plugin-permissions.ts.
 */
function permissionToken(p) {
    if (!p || !p.scope) return null;
    if (p.scope === 'network') return 'network';
    return p.access ? `${p.scope}:${p.access}` : String(p.scope);
}

/**
 * The capability set a review was granted against, as a stable digest. Sorted and deduped so manifest
 * reordering is not a change; see the header for what is deliberately left out.
 */
function permissionsSha256(permissions) {
    const tokens = (Array.isArray(permissions) ? permissions : [])
        .map(permissionToken)
        .filter(Boolean);
    const canonical = JSON.stringify([...new Set(tokens)].sort());
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Junk the packer never ships (build-marketplace.js SKIP_RE), plus the two directories that are not
 * part of the reviewed SOURCE: `data/` is runtime state the packer already excludes, and `dist/` is
 * build output (see the header for why it is not hashed).
 */
const CONTENT_SKIP_RE = /(^|[\\/])(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|\.git|node_modules)([\\/]|$)/i;
const CONTENT_SKIP_ROOTS = ['data', 'dist'];

/** Every file under `dir` the content digest covers, as repo-relative POSIX paths, sorted. */
function contentFiles(dir) {
    const out = [];
    const walk = (abs) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const p = path.join(abs, e.name);
            if (CONTENT_SKIP_RE.test(p)) continue;
            const rel = path.relative(dir, p).split(path.sep).join('/');
            if (CONTENT_SKIP_ROOTS.includes(rel.split('/')[0])) continue;
            if (e.isDirectory()) walk(p);
            else out.push(rel);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out.sort();
}

/** JSON with object keys in a fixed order, so re-serialising a manifest is not a change. */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

/**
 * manifest.json is hashed in CANONICAL form rather than byte-for-byte, and drops exactly three things:
 *
 *   - `version`               — bound on its own by the ledger's reviewedVersion, with its own message;
 *   - `permissions`           — bound on its own by reviewedPermissionsSha256, with its own message;
 *   - `permissions_rationale` — free prose, deliberately unhashed (see the header): a typo fix in a
 *                               justification must not invalidate a review.
 *
 * Without this, every one of those would fire TWO failures for one cause, and — worse — re-wording a
 * `reason` or reordering the permission list would invalidate a review, which is the exact "gate that
 * fires on noise" the permission hash is written to avoid. Key order and whitespace do not count
 * either. Everything else in the manifest does: the entry points, the admin menu, the bundling flag,
 * the isolation flag, the author.
 *
 * A manifest that does not parse falls back to its raw bytes — malformed JSON is a problem the manifest
 * gate reports, not something for this digest to swallow.
 */
function canonicalManifest(buf) {
    let m;
    try {
        m = JSON.parse(buf.toString('utf8'));
    } catch {
        return null;
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const copy = { ...m };
    delete copy.version;
    delete copy.permissions;
    delete copy.permissions_rationale;
    return Buffer.from(stableStringify(copy), 'utf8');
}

/**
 * The digest of the package SOURCE a review was made about. Deterministic across platforms: paths are
 * POSIX, the file list is sorted, and text files (no NUL byte) are normalised to LF before hashing so a
 * Windows checkout and a Linux CI runner agree on the same commit.
 *
 * The digest is over the PAIRS (path, per-file digest), not over concatenated bytes: concatenation
 * cannot tell `a.js` + `b.js` from a single file holding both, and renaming a file must be a change.
 */
function packageContentSha256(dir) {
    const parts = contentFiles(dir).map((rel) => {
        let buf = fs.readFileSync(path.join(dir, rel));
        if (!buf.includes(0)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
        if (rel === 'manifest.json') buf = canonicalManifest(buf) || buf;
        return [rel, crypto.createHash('sha256').update(buf).digest('hex')];
    });
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The fields that only ever mean something on a `reviewed` record (REVIEW.md §9). */
const REVIEWED_ONLY_FIELDS = ['reviewer', 'date', 'reviewedVersion', 'reviewedPermissionsSha256', 'reviewedContentSha256'];

/**
 * Read and VALIDATE the ledger. Returns a plain slug → record map ({} when the file is absent, which
 * is the correct reading of "nothing has been reviewed yet" — a fixture tree in the catalog tests has
 * no ledger and every entry there is `unreviewed`).
 *
 * Throws on a malformed ledger rather than degrading to `unreviewed`: a typo that silently downgrades
 * every badge is the failure mode this whole file exists to prevent.
 */
function readLedger(root) {
    const file = ledgerPath(root);
    if (!fs.existsSync(file)) return {};

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new Error(`marketplace/reviews.json is not valid JSON: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('marketplace/reviews.json must be an object keyed by plugin slug');
    }

    for (const [slug, record] of Object.entries(raw)) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error(`marketplace/reviews.json: "${slug}" must be an object`);
        }
        if (!REVIEW_STATUSES.includes(record.status)) {
            throw new Error(
                `marketplace/reviews.json: "${slug}" has status "${record.status}" (valid: ${REVIEW_STATUSES.join(', ')})`,
            );
        }
        // `notes` is the one optional field any status may carry — it is published verbatim in the
        // catalog and rendered as the first-party tooltip, so its TYPE is checked for every status.
        if ('notes' in record && typeof record.notes !== 'string') {
            throw new Error(`marketplace/reviews.json: "${slug}" notes must be a string`);
        }

        if (record.status === 'reviewed') {
            for (const field of ['reviewer', 'date', 'reviewedVersion', 'reviewedPermissionsSha256', 'reviewedContentSha256']) {
                if (!record[field] || typeof record[field] !== 'string') {
                    throw new Error(`marketplace/reviews.json: "${slug}" is "reviewed" but has no ${field}`);
                }
            }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
                throw new Error(`marketplace/reviews.json: "${slug}" date "${record.date}" is not YYYY-MM-DD`);
            }
            if (!/^\d+\.\d+\.\d+/.test(record.reviewedVersion)) {
                throw new Error(`marketplace/reviews.json: "${slug}" reviewedVersion "${record.reviewedVersion}" is not semver`);
            }
            for (const field of ['reviewedPermissionsSha256', 'reviewedContentSha256']) {
                if (!/^[0-9a-f]{64}$/.test(record[field])) {
                    throw new Error(`marketplace/reviews.json: "${slug}" ${field} is not a 64-char lowercase hex digest`);
                }
            }
        } else {
            // The symmetric half. Validating these fields ONLY for `reviewed` left them free-form
            // everywhere else, so a record could carry a reviewer's name and an unvalidated date under a
            // status that claims no review — see the header.
            const stray = REVIEWED_ONLY_FIELDS.filter((f) => f in record);
            if (stray.length) {
                throw new Error(
                    `marketplace/reviews.json: "${slug}" has status "${record.status}" but carries ${stray.join(', ')} — ` +
                    `those fields belong to a "reviewed" record and are meaningless on any other (REVIEW.md §9). ` +
                    `Revoking a review drops the evidence with the status (§7).`,
                );
            }
        }
    }
    return raw;
}

/**
 * The `review` object a catalog entry publishes for `slug`. Keys are emitted in a FIXED order and
 * optional ones are omitted when empty, so `JSON.stringify` of the index is byte-stable across
 * rebuilds — the property verify-marketplace.js --rebuild enforces for the whole catalog.
 *
 * `reviewedVersion`, `reviewedPermissionsSha256` and `reviewedContentSha256` stay in the ledger and are
 * NOT published: they are gate inputs, not something an admin browsing the marketplace has any use for.
 * (The version in particular would be redundant — the gate refuses to let the catalog publish a badge
 * for any version other than the reviewed one, so the entry's own `version` already is it.)
 *
 * `reviewer` and `date` are emitted ONLY for `reviewed`. They used to be copied for any status, which
 * is how a non-reviewed record could ship a reviewer's name in the catalog; `notes` stays unconditional
 * because a first-party record's note is exactly what the admin UI shows on hover.
 */
function reviewFor(ledger, slug) {
    const record = ledger[slug];
    if (!record) return { status: 'unreviewed' };
    const out = { status: record.status };
    if (record.status === 'reviewed') {
        if (record.reviewer) out.reviewer = record.reviewer;
        if (record.date) out.date = record.date;
    }
    if (record.notes) out.notes = record.notes;
    return out;
}

module.exports = {
    REVIEW_STATUSES,
    FIRST_PARTY_AUTHORS,
    REVIEWED_ONLY_FIELDS,
    ledgerPath,
    isFirstPartyAuthor,
    permissionToken,
    permissionsSha256,
    packageContentSha256,
    readLedger,
    reviewFor,
};

/**
 * `node backend/scripts/marketplace-review.js <slug>` prints the three gate inputs a NEW review record
 * needs. Without it the only way to obtain them is to commit a record with placeholder values and read
 * the real ones out of the gate's failure message, which is a ritual that teaches re-stamping.
 *
 * It is for RECORDING a decision, never for renewing one: a re-review is a re-read of §4, and these
 * values are what you write down afterwards, not a way to make a red gate go green.
 */
if (require.main === module) {
    const slug = process.argv[2];
    const root = process.env.WORDJS_MARKETPLACE_ROOT
        ? path.resolve(process.env.WORDJS_MARKETPLACE_ROOT)
        : path.resolve(__dirname, '../..');
    const dir = path.join(root, 'marketplace', 'plugins', String(slug || ''));
    if (!slug || !fs.existsSync(path.join(dir, 'manifest.json'))) {
        console.error('Usage: node backend/scripts/marketplace-review.js <slug>   (a directory under marketplace/plugins/)');
        process.exit(2);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    console.log(JSON.stringify({
        status: 'reviewed',
        reviewer: '<your-github-handle>',
        date: new Date().toISOString().slice(0, 10),
        reviewedVersion: String(manifest.version || '1.0.0'),
        reviewedPermissionsSha256: permissionsSha256(manifest.permissions),
        reviewedContentSha256: packageContentSha256(dir),
        notes: '<short public summary of what you checked, and any caveat>',
    }, null, 4));
}
