/**
 * WordJS marketplace SUBMISSION GATE (CLI).
 *
 * Runs the two mechanical halves of marketplace/REVIEW.md §3 against one or more plugin packages:
 *
 *   manifest  — the submission requirements of REVIEW.md §2 (author, OSI license, repository,
 *               isolated, a justification per permission, bundling and egress rules);
 *   scan      — the install-time AST scan an administrator's own upload gets, which is
 *               validatePluginPermissions() from backend/src/core/plugins.ts and NOT a reimplementation
 *               of it. It is a best-effort warning, not a proof (its own source says so) — a
 *               submission that trips it does not proceed, but a clean run proves nothing.
 *
 * Usage:
 *     node backend/scripts/scan-plugin.mjs <slug> [<slug> ...]
 *     node backend/scripts/scan-plugin.mjs --all
 *     node backend/scripts/scan-plugin.mjs --only=manifest <slug>
 *     node backend/scripts/scan-plugin.mjs --only=scan     <slug>
 *
 * Env:  WORDJS_MARKETPLACE_ROOT   repo root override (same knob the catalog scripts use)
 *
 * Exits non-zero on any finding. When GITHUB_STEP_SUMMARY is set it also appends a markdown report
 * there, which is how .github/workflows/plugin-review.yml surfaces the result on the pull request
 * without needing a write-scoped token.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const ROOT = process.env.WORDJS_MARKETPLACE_ROOT
    ? path.resolve(process.env.WORDJS_MARKETPLACE_ROOT)
    : path.resolve(BACKEND, '..');
const SRC = path.join(ROOT, 'marketplace', 'plugins');

/**
 * OSI-approved SPDX identifiers accepted without discussion. Deliberately a short list rather than a
 * dependency: an identifier that is missing is not a rejection, it is a conversation (open an issue).
 * AGPL/SSPL are refused outright — the repository's own dependency gate blocks network copyleft
 * (.github/workflows/ci.yml, `license-checker --failOn 'AGPL;SSPL'`) and the catalog holds the line.
 */
const ACCEPTED_LICENSES = [
    'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense',
    'MPL-2.0', 'LGPL-2.1-only', 'LGPL-3.0-only', 'GPL-2.0-only', 'GPL-3.0-only',
];
const REFUSED_LICENSE_RE = /AGPL|SSPL/i;

/**
 * A `network` justification documents its destinations when it names at least one host
 * (`api.stripe.com`), OR describes a destination class that is genuinely resolved at runtime and so
 * cannot be enumerated — an MTA's per-message MX lookup, a relay or webhook the operator configures —
 * OR spells the destinations out under an explicit `egress:` list. See REVIEW.md §3.6.
 *
 * WHY THESE ARE SO NARROW. The first version matched a bare `[a-z0-9-]+\.[a-z]{2,}` and a list of bare
 * ADJECTIVES, which meant prose that names no destination at all cleared the gate whenever it happened
 * to contain a filename or a loose word:
 *
 *     "The plugin performs dynamic content loading for the gallery widget."   PASSED  (`dynamic`)
 *     "Fetches remote content. Documented in README.md for the curious."      PASSED  (`README.md`
 *                                                                                      — .md is a ccTLD)
 *     "…needs network access.It is required for the feature."                 PASSED  (`access.It`)
 *
 * So: hosts must end in a TLD from a list that does NOT include bare two-letter ccTLDs (`.md`, `.it`,
 * `.js` and `1.0.0` are the false positives that mattered, and every one of them is two or three
 * characters), and a runtime destination must be a PHRASE naming the mechanism, never an adjective.
 * A real destination outside the TLD list is not a rejection — write it as a URL (`https://example.de`)
 * or under `egress:`, both of which are unambiguous. This gate refuses SILENCE about the destination;
 * whether the stated destination is the truth is §4's job, and no regex can do it.
 */
const EGRESS_TLDS = 'com|net|org|io|dev|edu|gov|mil|int|info|biz|app|cloud|xyz|online|site|tech|email|systems|tools|co|ai';
const EGRESS_DOCUMENTED_RE = new RegExp([
    // A URL, whatever its TLD.
    'https?://[^\\s)\\]]+',
    // A hostname: at least one label, then a TLD that cannot be a file extension or a version part.
    `\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${EGRESS_TLDS})\\b`,
    // An explicit list the author wrote out: `egress: api.example.de, the operator's webhook`.
    'egress\\s*[:=]\\s*\\S{3,}',
    // A destination class that is genuinely resolved at runtime — the mechanism, named.
    '\\bMX\\s+(?:record|host|lookup)s?\\b',
    '\\bremote\\s+MTAs?\\b',
    '\\b(?:SMTP|mail)\\s+relay\\b',
    '\\b(?:operator|user|admin|administrator|site)[- ]configured\\s+\\w+',
    '\\ba\\s+configured\\s+(?:relay|webhook|endpoint|host|server|instance)\\b',
    '\\b(?:resolved|chosen|configured|supplied|entered)\\s+at\\s+runtime\\b',
].join('|'), 'i');

/** Load the real scanner: compiled dist when a build exists, ts-node otherwise. */
function loadCore() {
    const dist = path.join(BACKEND, 'dist', 'core', 'plugins.js');
    if (fs.existsSync(dist)) return require(dist);
    require('ts-node').register({ transpileOnly: true, project: path.join(BACKEND, 'tsconfig.json') });
    return require(path.join(BACKEND, 'src', 'core', 'plugins.ts'));
}

/**
 * REVIEW.md §2 — everything a SUBMISSION's manifest.json must carry.
 *
 * `firstParty` (the plugin is recorded as the project's own in marketplace/reviews.json) relaxes
 * exactly two requirements, and only those two: `license` and `repository`. Both are requirements
 * about being an OUTSIDE submission — they exist so a reviewer can read the source of a package that
 * lives somewhere else under terms someone stated. A first-party plugin's source is this repository,
 * under this repository's MIT LICENSE, changed through this repository's pull requests; demanding
 * that it restate that in 31 manifests would fail this workflow on every routine maintenance commit,
 * and a gate that is red for a reason nobody can act on is a gate people learn to ignore. They are
 * reported as notes instead of being dropped. Everything else — isolation, the permission vocabulary,
 * a justification per permission, the egress list, the bundling declaration — applies identically:
 * those are properties of the plugin, not of who wrote it.
 */
function checkManifest(slug, dir, manifest, core, { firstParty = false } = {}) {
    const problems = [];
    const notes = [];
    const add = (m) => problems.push(m);
    const addSubmissionOnly = (m) => (firstParty ? notes : problems).push(m);

    if (manifest.id !== slug) add(`manifest id "${manifest.id}" does not match the folder name "${slug}"`);
    for (const field of ['name', 'version', 'description', 'author']) {
        if (!manifest[field] || typeof manifest[field] !== 'string') add(`missing "${field}"`);
    }
    if (manifest.version && !/^\d+\.\d+\.\d+/.test(String(manifest.version))) {
        add(`version "${manifest.version}" is not semver`);
    }
    if (manifest.isolated !== true) add('must declare "isolated": true — legacy in-process plugins are not accepted');

    // License: declared, OSI, not network copyleft, and the text actually ships. A DECLARED licence is
    // always validated — a first-party plugin does not get to declare AGPL either.
    const license = String(manifest.license || '').trim();
    if (!license) {
        addSubmissionOnly('missing "license" — an OSI-approved SPDX identifier is required (REVIEW.md §2)');
    } else if (REFUSED_LICENSE_RE.test(license)) {
        add(`license "${license}" is network copyleft (AGPL/SSPL) and is not accepted in the catalog`);
    } else if (!ACCEPTED_LICENSES.includes(license)) {
        add(`license "${license}" is not in the accepted OSI list (${ACCEPTED_LICENSES.join(', ')}) — open an issue if yours is missing`);
    } else if (!fs.readdirSync(dir).some((f) => /^LICEN[CS]E(\.|$)/i.test(f))) {
        addSubmissionOnly(`declares "${license}" but ships no LICENSE file`);
    }

    // Repository: a reviewer who cannot read the source cannot review it.
    const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    if (!repo) addSubmissionOnly('missing "repository" — a public URL where this version\'s source can be read');
    else if (!/^https:\/\//.test(String(repo))) add(`repository "${repo}" must be an https URL`);

    // Permissions: known vocabulary (asked of core, not of a copy of core's list) ...
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const p of core.validateManifestPermissions(manifest.permissions)) add(p);

    // ... and a justification for every one of them. Either inline `reason` (the shape every existing
    // manifest uses) or an entry in `permissions_rationale` keyed by grant token.
    const rationale = manifest.permissions_rationale && typeof manifest.permissions_rationale === 'object'
        ? manifest.permissions_rationale
        : {};
    for (const p of permissions) {
        if (!p || !p.scope) continue;
        const token = p.scope === 'network' ? 'network' : (p.access ? `${p.scope}:${p.access}` : String(p.scope));
        const justification = String(p.reason || rationale[token] || '').trim();
        if (justification.length < 20) {
            add(`permission "${token}" has no usable justification — add a "reason" (or a permissions_rationale["${token}"]) saying what it is used for and why the feature needs it`);
            continue;
        }
        // REVIEW.md §3.6: `network` must document WHERE it goes. A concrete host list is the normal
        // answer (`api.stripe.com`, `googleapis.com`). Some egress is genuinely chosen at runtime and
        // cannot be enumerated — an MTA resolves an MX host per message, a relay or webhook is
        // configured by the operator — so an explicit description of that destination class satisfies
        // the rule too. What does NOT satisfy it is a justification that never says where the traffic
        // goes at all: "talks to the internet" is a rejection, and it is the case this catches.
        if (token === 'network' && !EGRESS_DOCUMENTED_RE.test(justification)) {
            add('permission "network" must document its destinations — name every host the plugin contacts, or, when the destination is resolved at runtime (MX lookup, an operator-configured relay or webhook), say so explicitly (REVIEW.md §3.6)');
        }
    }

    // Bundling: shipping node_modules makes a plugin bundled whether it says so or not, which silently
    // opts it out of shared dependency management. Make the choice visible.
    const nm = path.join(dir, 'node_modules');
    const shipsNodeModules = fs.existsSync(nm) && fs.statSync(nm).isDirectory() && fs.readdirSync(nm).length > 0;
    if (shipsNodeModules && manifest.bundled !== true) {
        add('ships node_modules/ but does not declare "bundled": true — declare it (REVIEW.md §2)');
    }

    return { problems, notes };
}

/** REVIEW.md §3.2 — the install-time AST scan, unmodified. */
function runScan(slug, dir, manifest, core) {
    try {
        core.validatePluginPermissions(slug, dir, manifest);
        return [];
    } catch (e) {
        return [String((e && e.message) || e).trim()];
    }
}

function main() {
    const args = process.argv.slice(2);
    const onlyArg = args.find((a) => a.startsWith('--only='));
    const only = onlyArg ? onlyArg.split('=')[1] : 'all';
    if (!['all', 'manifest', 'scan'].includes(only)) {
        console.error(`Unknown --only value "${only}" (manifest | scan)`);
        process.exit(2);
    }

    if (!fs.existsSync(SRC)) {
        console.error(`No marketplace sources at ${SRC}`);
        process.exit(1);
    }
    const listed = args.filter((a) => !a.startsWith('--'));
    const slugs = args.includes('--all')
        ? fs.readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
        : listed;

    if (!slugs.length) {
        console.error('Nothing to check. Pass one or more plugin slugs, or --all.');
        process.exit(2);
    }

    const core = loadCore();
    // The same ledger the catalog is built from. It is what tells a first-party package from an outside
    // submission — see checkManifest's header for the two requirements that distinction relaxes.
    const { readLedger, isFirstPartyAuthor } = require('./marketplace-review');
    const ledger = readLedger(ROOT);
    const report = [];
    let failed = 0;

    for (const slug of slugs) {
        const dir = path.join(SRC, slug);
        const manifestPath = path.join(dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            report.push({ slug, problems: [`no manifest.json at marketplace/plugins/${slug}/`], notes: [] });
            failed++;
            continue;
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
            report.push({ slug, problems: [`manifest.json is not valid JSON: ${e.message}`], notes: [] });
            failed++;
            continue;
        }

        // The waiver needs BOTH halves. Taking it from the ledger alone meant an outside submission that
        // wrote `{"status":"first-party"}` for its own slug waived the two requirements that exist
        // precisely for outside submissions — no OSI licence, no public repository, so nobody could read
        // the source of the version being shipped. verify-marketplace.js refuses the same claim at the
        // catalog boundary; this refuses the waiver here, where it is actually spent.
        const firstParty = ledger[slug]?.status === 'first-party' && isFirstPartyAuthor(manifest.author);
        const problems = [];
        const notes = [];
        if (only !== 'scan') {
            const r = checkManifest(slug, dir, manifest, core, { firstParty });
            problems.push(...r.problems);
            notes.push(...r.notes);
        }
        if (only !== 'manifest') problems.push(...runScan(slug, dir, manifest, core));

        report.push({ slug, problems, notes, firstParty });
        if (problems.length) failed++;
    }

    for (const { slug, problems, notes, firstParty } of report) {
        if (!problems.length) console.log(`  ✓ ${slug}${firstParty ? ' (first-party)' : ''}`);
        else {
            console.error(`  ✗ ${slug}`);
            for (const p of problems) console.error(`      • ${p}`);
        }
        for (const n of notes) console.log(`      · note (submission-only, waived for a first-party package): ${n}`);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
        const lines = [`### Plugin submission checks (\`--only=${only}\`)`, ''];
        for (const { slug, problems, notes } of report) {
            lines.push(problems.length ? `**\`${slug}\`** — ${problems.length} problem(s):` : `**\`${slug}\`** — ok`);
            for (const p of problems) lines.push(`- ${p}`);
            for (const n of notes) lines.push(`- _note (submission-only, waived for a first-party package):_ ${n}`);
            lines.push('');
        }
        lines.push('See [marketplace/REVIEW.md](../blob/HEAD/marketplace/REVIEW.md) for what each check means.', '');
        try {
            fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
        } catch { /* a summary we cannot write must not fail the gate */ }
    }

    if (failed) {
        console.error(`\n✗ ${failed} of ${slugs.length} package(s) did not pass (marketplace/REVIEW.md §2–3).`);
        process.exit(1);
    }
    console.log(`\n✅ ${slugs.length} package(s) pass the mechanical submission checks.`);
}

main();
