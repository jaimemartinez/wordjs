/**
 * The daily advisory sweep must exist, must cover EVERY npm workspace, and must still be able to shout.
 *
 * `.github/workflows/dependency-audit.yml` closes a window the push-time audit gate cannot: an advisory
 * published against a dependency we already ship changes nothing in our source, so `ci.yml` (push / PR /
 * tag only) does not run, and the CVE sits unnoticed until somebody happens to push. Dependabot ALERTS
 * would be the other half of that, but they are a repository SETTING, not a file — they cannot be
 * committed, reviewed, or relied on by a fork.
 *
 * Everything about that workflow is silent when it breaks, which is why it is pinned here:
 *
 *   - Delete the file, or drop the `schedule:` trigger, and the sweep stops. Nothing goes red — there is
 *     simply no run. "No failing run" and "no run at all" look identical on the Actions tab.
 *   - Add a seventh npm workspace (a new `packages/*`, say) and forget the matrix, and that workspace is
 *     audited by nothing at all, daily, forever. This is not hypothetical: `packages/create-wordjs`
 *     shipped a HIGH advisory (adm-zip) precisely because the audit list enumerated directories and it
 *     was none of them. So the matrix is checked against the population of committed lockfiles rather
 *     than against a copy of the list, which would only ever agree with itself.
 *   - Drop `issues: write`, or the `gh issue` call, and every failure is still detected and then
 *     discarded: a red run on a scheduled workflow that nobody is watching is a failure nobody reads.
 *
 * These are textual assertions on the workflow, not a YAML parse, on purpose: the backend declares no
 * YAML parser (js-yaml is only a transitive dependency here) and a gate must not rest on a dependency
 * that nothing pins.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const REPO = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'dependency-audit.yml');

function workflowSource(): string {
    assert.ok(
        fs.existsSync(WORKFLOW),
        '.github/workflows/dependency-audit.yml is missing — the daily advisory sweep is gone, and its absence produces no failing run to notice.',
    );
    return fs.readFileSync(WORKFLOW, 'utf8');
}

/**
 * Every npm workspace this repository ships, as the set of directories holding a COMMITTED
 * package-lock.json. Same authority-on-the-population idiom as repo-hygiene-secrets.test.ts: in a work
 * tree that is `git ls-files`; in an archive checkout (no .git) the disk walk is the same answer,
 * because everything there came out of the tree. Either way it is "what we ship", never local scratch.
 */
function workspaceDirs(): string[] {
    const toDir = (lock: string) => {
        const dir = path.posix.dirname(lock.replace(/\\/g, '/'));
        return dir === '.' ? '.' : dir;
    };

    const r = spawnSync('git', ['ls-files', '-z', '--', '*package-lock.json'], { cwd: REPO });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
        const dirs = r.stdout
            .toString('utf8')
            .split('\0')
            .filter(Boolean)
            .filter((f) => !f.includes('node_modules/'))
            .map(toDir);
        if (dirs.length) return [...new Set(dirs)].sort();
    }

    // Fallback: bounded walk (workspaces live at depth 0-2), skipping installed trees and build output.
    const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', 'data', 'releases']);
    const found: string[] = [];
    (function walk(rel: string, depth: number) {
        const abs = rel === '.' ? REPO : path.join(REPO, rel);
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            if (entry.isFile() && entry.name === 'package-lock.json') found.push(rel);
            else if (entry.isDirectory() && depth < 2 && !SKIP.has(entry.name) && !entry.name.startsWith('.')) {
                walk(rel === '.' ? entry.name : `${rel}/${entry.name}`, depth + 1);
            }
        }
    })('.', 0);
    return [...new Set(found)].sort();
}

/** The matrix legs, read out of the workflow's own `include:` list. */
function matrixLegs(src: string): { slug: string; dir: string; lock: string }[] {
    const legs: { slug: string; dir: string; lock: string }[] = [];
    for (const line of src.split('\n')) {
        const m = line.match(/^\s*-\s*\{\s*slug:\s*([^,]+),\s*dir:\s*([^,]+),\s*lock:\s*([^}]+)\}\s*$/);
        if (!m) continue;
        const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim();
        legs.push({ slug: unquote(m[1]), dir: unquote(m[2]), lock: unquote(m[3]) });
    }
    return legs;
}

test('the scheduled dependency audit runs on a timer and can be triggered by hand', () => {
    const src = workflowSource();

    // A `workflow_dispatch`-only version of this file would look almost identical and would never run.
    assert.match(src, /^on:/m, 'the workflow declares no triggers');
    assert.match(
        src,
        /schedule:\s*\n(?:\s*#.*\n)*\s*-\s*cron:\s*'[^']+'/,
        'no `schedule: - cron:` trigger — without it the audit only runs when somebody remembers to press the button, which is the gap this workflow exists to close.',
    );
    assert.match(src, /workflow_dispatch:/, 'no workflow_dispatch — a failure must be re-runnable on demand after the fix.');
});

test('the audit matrix covers every npm workspace that ships a lockfile', () => {
    const src = workflowSource();
    const legs = matrixLegs(src);
    assert.ok(legs.length >= 6, `parsed only ${legs.length} matrix legs — the include list's shape changed, so this gate stopped checking anything.`);

    const covered = new Set(legs.map((l) => l.dir));
    const missing = workspaceDirs().filter((d) => !covered.has(d));
    assert.deepStrictEqual(
        missing,
        [],
        `these npm workspaces ship a package-lock.json but are audited by NOTHING on the daily sweep: ${missing.join(', ')}. ` +
            'Add a matrix leg in .github/workflows/dependency-audit.yml — an audit list that enumerates directories always misses the next one added.',
    );

    for (const leg of legs) {
        const expected = leg.dir === '.' ? 'package-lock.json' : `${leg.dir}/package-lock.json`;
        assert.strictEqual(leg.lock, expected, `matrix leg '${leg.slug}' caches ${leg.lock}, which is not ${leg.dir}'s lockfile — the npm cache key would be keyed on another workspace.`);
        assert.ok(fs.existsSync(path.join(REPO, leg.lock)), `matrix leg '${leg.slug}' points at ${leg.lock}, which does not exist — setup-node fails on a missing cache-dependency-path.`);
        // Artifact names are how the report job learns WHICH legs failed; `.` and `/` are not legal in one.
        assert.match(leg.slug, /^[A-Za-z0-9._-]+$/, `matrix leg slug '${leg.slug}' is not a legal artifact-name fragment.`);
    }
});

test('the sweep runs the same audit gate CI runs, and every job is bounded', () => {
    const src = workflowSource();

    // The whole value of the sweep is that a scheduled failure means exactly what a CI failure means.
    // A hand-rolled `npm audit` here would drop the outage handling and turn every npm blip into a filed
    // issue — which trains everyone to ignore the issues this workflow files.
    assert.match(
        src,
        /node "\$GITHUB_WORKSPACE\/scripts\/ci-audit\.mjs"/,
        'the sweep does not invoke scripts/ci-audit.mjs — it must run the SAME wrapper as ci.yml/release.yml, not a second implementation.',
    );
    assert.ok(fs.existsSync(path.join(REPO, 'scripts', 'ci-audit.mjs')), 'scripts/ci-audit.mjs is missing — the workflow would fail on every leg.');

    // GitHub's default job timeout is six hours; a hung job on a DAILY workflow stacks up silently.
    // Only the keys under `jobs:` — a bare `^  key:$` scan also catches `schedule:` and
    // `workflow_dispatch:` under `on:`, which would inflate the count and make this assertion lie.
    const jobsBlock = src.slice(src.indexOf('\njobs:\n'));
    const jobs = jobsBlock.split('\n').filter((l) => /^ {2}[a-z0-9_-]+:\s*$/.test(l)).map((l) => l.trim().replace(':', ''));
    assert.ok(jobs.length >= 2, `expected at least the audit and report jobs, parsed ${jobs.length}`);
    const timeouts = (src.match(/^\s*timeout-minutes:/gm) || []).length;
    assert.ok(timeouts >= jobs.length, `${jobs.length} jobs but only ${timeouts} timeout-minutes — every job must carry one (see the note at the top of ci.yml).`);
});

test('a failed sweep files an issue instead of dying quietly', () => {
    const src = workflowSource();

    // A red scheduled run that nobody subscribes to is a failure nobody reads. The issue is the alarm.
    assert.match(src, /needs:\s*audit/, 'the report job does not depend on the audit job.');
    assert.match(src, /if:\s*failure\(\)/, "the report job is not gated on failure() — either it never fires, or it fires on green runs and becomes noise.");
    assert.match(src, /issues:\s*write/, 'no `issues: write` — the report job cannot open or comment on anything, so every failure is detected and then discarded.');
    assert.match(src, /gh issue create --title/, 'nothing opens an issue.');
    assert.match(src, /gh issue comment/, 'nothing comments on the existing issue — a re-run would file a duplicate every time.');
    assert.match(src, /Dependency audit failed \(/, 'the issue title changed; SECURITY.md documents it as "Dependency audit failed (<date>)".');

    // Least privilege: the sweep reads the repo. The single write is granted on the one job that writes.
    assert.match(src, /^permissions:\n {2}contents: read\n/m, 'the workflow-level permission floor is not `contents: read`.');
});

test('SECURITY.md still describes the sweep it now has', () => {
    // SECURITY.md used to say the push-time gate "is the only automatic advisory check in the pipeline".
    // That sentence became false the moment this workflow landed, and a security posture document that
    // understates what exists is only marginally better than one that overstates it — both are wrong.
    const security = fs.readFileSync(path.join(REPO, 'SECURITY.md'), 'utf8');
    assert.match(
        security,
        /dependency-audit\.yml/,
        'SECURITY.md does not mention .github/workflows/dependency-audit.yml — the Supply-Chain paragraph is describing a pipeline that no longer exists.',
    );
    assert.doesNotMatch(
        security,
        /is the only automatic advisory check in the pipeline/,
        'SECURITY.md still claims the push-time gate is the ONLY automatic advisory check; the daily sweep is a second one.',
    );
});
