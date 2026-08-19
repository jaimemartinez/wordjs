/**
 * REPO HYGIENE — a gate, not a paragraph.
 *
 * Finding #31 was closed by adding rules to `.gitignore`. Rules are a NAME list: they stop `cj.txt`
 * (the curl cookie jar that holds a live `wordjs_token` every time it is regenerated) and the dumps
 * we have already met, and nothing at all stops the next jar called `jar.txt` or the next dump called
 * `probe.json`. Worse, nothing PINNED any of it — deleting the whole block left the suite green, and
 * `release-excludes.test.ts` only protects the ZIP by filtering `git ls-files`, a protection that
 * INVERTS the moment one of these files becomes tracked.
 *
 * So this file pins the three things that actually hold:
 *   1. the CONTENT scanner behind `.githooks/pre-commit` really rejects a session token, and really
 *      does NOT reject the ordinary source code that mentions the cookie by name (the control),
 *   2. no tracked file in this repo carries one, today,
 *   3. the producers of debug dumps write into the ignored directory, so the ignore rule and the
 *      script that creates the file agree instead of racing each other.
 *
 * Every assertion runs the REAL artefact: the scanner is spawned exactly as the hook spawns it, and
 * `dumpPath()` is imported from the module the stitch scripts import.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCANNER = path.join(REPO_ROOT, '.githooks', 'secret-scan.mjs');
const DUMP_HELPER = path.join(REPO_ROOT, 'scripts', 'stitch-dump-path.mjs');

/** A syntactically valid, WORTHLESS JWT: three base64url parts, signed with nothing. */
const FAKE_JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJ1c2VySWQiOjEsImV4cCI6MTAwMDAwMDAwMH0' +
    '.tHiSiSnOtArEaLsIgNaTuReAtAlLnOtAtAlL00';

/** Run the scanner over explicit paths, the way `.githooks/pre-commit` runs it. */
function scan(...files: string[]) {
    const r = spawnSync(process.execPath, [SCANNER, ...files], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

/** Write a fixture into a temp dir (never into the repo — a test must not create what it forbids). */
function fixture(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-hygiene-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
}

function insideWorkTree(): boolean {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return r.status === 0 && String(r.stdout).trim() === 'true';
}

/**
 * A SKIP IS ONLY HONEST WHERE THE RULE CANNOT RUN.
 *
 * These gates need a git work tree, and an archive/tarball extraction does not have one. Skipping
 * there is correct. Skipping in CI is not: CI checks the repo out WITH git, so if the work tree is
 * missing there, something is wrong with the checkout and the right answer is red, not a quiet
 * "skipped" that the summary reports as a green run.
 */
function runnableOrSkip(t: any, ok: boolean, reason: string): boolean {
    if (ok) return true;
    assert.ok(
        !process.env.CI,
        `${reason} — but CI checks the repo out WITH git: this gate must not self-skip here`,
    );
    t.skip(reason);
    return false;
}

/**
 * THE POPULATION THIS RULE COVERS — what GIT carries, never what sits on a developer's disk.
 *
 * `fs.readdirSync('scripts')` reads the DISK, which is neither what the repo ships nor what CI
 * checks out. On the machine where these rules were written, `scripts/` held 20 untracked scratch
 * files from another session: the rule was silently scanning twenty files the repo does not carry
 * (so a local scratch file could turn the suite red), while the same commit checked out clean had
 * none of them (so the rule covered a different, smaller set — and hard-coded assertions about two
 * of those files failed with ENOENT). The authority on what the repo carries is git.
 *
 * In a work tree the population is `git ls-files`. In an archive/tarball checkout there is no git —
 * but everything on disk there came OUT of the tree, so the recursive walk is the same answer. Either
 * way the set is "what this repo ships", and it never includes anybody's local scratch.
 */
function scriptPopulation(): { files: string[]; source: 'git' | 'disk' } {
    const isScript = (name: string) => /\.(mjs|cjs|js)$/.test(name);

    const r = spawnSync('git', ['ls-files', '-z', '--', 'scripts'], { cwd: REPO_ROOT });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
        const files = r.stdout.toString('utf8').split('\0').filter(Boolean).filter(isScript);
        if (files.length) return { files, source: 'git' };
    }

    const files: string[] = [];
    (function walk(rel: string) {
        for (const entry of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
            const child = `${rel}/${entry.name}`;
            if (entry.isDirectory()) walk(child);
            else if (isScript(entry.name)) files.push(child);
        }
    })('scripts');
    return { files, source: 'disk' };
}

/**
 * THE RULE, as a pure function so a POSITIVE CONTROL can prove it is not a no-op regex.
 *
 * Three offender shapes, all of them ways the checked value stops being the written value:
 *   1. a write to a bare literal file name  — `writeFileSync("probe.json", …)`
 *   2. a write straight to an argv element  — `writeFileSync(process.argv[3], …)`
 *   3. inside a dump producer (a file that imports the helper), a write to ANY destination that did
 *      not come out of `dumpPath()`/`writeDump()` — sanitising one path and writing another is how
 *      containment checks die, and it is invisible to shapes 1 and 2.
 */
function bareDumpWrites(label: string, src: string): string[] {
    const offenders: string[] = [];

    // Every binding whose value came from dumpPath(): those, and only those, are legal destinations.
    const resolved = new Set<string>();
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?dumpPath\s*\(/g)) {
        resolved.add(m[1]);
    }
    const isDumpProducer =
        /from\s+["'][^"']*stitch-dump-path\.mjs["']/.test(src) ||
        /require\(\s*["'][^"']*stitch-dump-path(?:\.mjs)?["']\s*\)/.test(src);

    src.split(/\r?\n/).forEach((line: string, i: number) => {
        const where = `${label}:${i + 1}  ${line.trim().slice(0, 100)}`;

        if (/writeFileSync\(\s*["'][^"'/\\]+\.(json|txt|har|html)["']/.test(line)) {
            offenders.push(`${where}   <-- bare literal name, bypasses dumpPath()`);
            return;
        }
        if (/writeFileSync\(\s*process\.argv\[/.test(line)) {
            offenders.push(`${where}   <-- raw argv, bypasses dumpPath()`);
            return;
        }
        if (!isDumpProducer) return;

        const m = line.match(/writeFileSync\(\s*([^,]+?)\s*,/);
        if (!m) return;
        const dest = m[1].trim();
        if (/dumpPath|writeDump|DUMP_DIR/.test(dest)) return;
        if (/^[A-Za-z_$][\w$]*$/.test(dest) && resolved.has(dest)) return;
        offenders.push(`${where}   <-- destination never passed through dumpPath()`);
    });

    return offenders;
}

describe('secret scan — the pre-commit gate', () => {
    test('the hook actually calls the scanner (a hook that greps nothing is a document)', () => {
        const hook = fs.readFileSync(path.join(REPO_ROOT, '.githooks', 'pre-commit'), 'utf8');
        assert.match(hook, /secret-scan\.mjs["']?\s+--staged/, 'pre-commit must scan the STAGED set');
        assert.ok(fs.existsSync(SCANNER), 'the scanner the hook invokes must exist');

        // core.hooksPath is per-clone local config, so the only thing that can be committed is the
        // documented way to turn it on.
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        assert.ok(pkg.scripts['hooks:install'], 'npm run hooks:install must exist');
        assert.match(pkg.scripts['hooks:install'], /\.githooks/);
        assert.ok(pkg.scripts['scan:secrets'], 'npm run scan:secrets must exist');
    });

    /**
     * core.hooksPath REPLACES .git/hooks. Adding this gate must not silently remove the ones already
     * installed — the theme-tokens drift gate lives in .git/hooks/pre-push, and losing it is how three
     * pushes went red in a single afternoon.
     */
    test('switching hooksPath does not switch the local hooks off', () => {
        for (const name of ['pre-commit', 'pre-push', 'post-commit', 'post-checkout']) {
            const hook = fs.readFileSync(path.join(REPO_ROOT, '.githooks', name), 'utf8');
            assert.match(hook, /run_local_hook\s+/, `${name} must delegate to its local namesake`);
            assert.match(hook, /_local\.sh/, `${name} must source the delegation helper`);
        }
    });

    test('a curl cookie jar with a live session token is rejected', () => {
        const jar = fixture(
            'jar.txt', // deliberately NOT one of the names .gitignore knows
            `# Netscape HTTP Cookie File\nlocalhost\tFALSE\t/\tFALSE\t0\twordjs_token\t${FAKE_JWT}\n`,
        );
        const r = scan(jar);
        assert.strictEqual(r.code, 1, 'the scanner must fail the commit');
        assert.match(r.stderr, /jwt|session-cookie/);
        assert.ok(!r.stderr.includes(FAKE_JWT), 'the report must not reprint the whole credential');
    });

    test('the other shapes the same token arrives in are rejected too', () => {
        for (const [name, body] of [
            ['set-cookie.http', `HTTP/1.1 200 OK\nSet-Cookie: wordjs_token=${FAKE_JWT}; HttpOnly; Path=/\n`],
            ['req.har', `{"headers":[{"name":"authorization","value":"Bearer ${FAKE_JWT}"}]}`],
            ['probe.json', `{"note":"captured","token":"${FAKE_JWT}"}`],
        ] as [string, string][]) {
            assert.strictEqual(scan(fixture(name, body)).code, 1, `must reject ${name}`);
        }
    });

    /**
     * THE CONTROL. Without it, a scanner that rejects everything passes every assertion above — and a
     * gate that fires on the cookie NAME would reject every commit that touches authentication, which
     * is a gate that gets `--no-verify`d out of existence in a week.
     */
    test('ordinary source that merely names the cookie is NOT rejected', () => {
        const src = fixture(
            'auth.ts',
            [
                "export const SESSION_COOKIE = 'wordjs_token';",
                "res.cookie('wordjs_token', token, { httpOnly: true, sameSite: 'lax' });",
                "req.cookies?.wordjs_token ?? req.headers['x-install-token'];",
                "const bad = { wordjs_token: 'esto-no-tiene-tres-partes' };", // real fixture from collab-routes.test.ts
                '// eyJ is base64url for {" — a bare mention must not trip the rule',
            ].join('\n'),
        );
        const r = scan(src);
        assert.strictEqual(r.code, 0, `false positive:\n${r.stderr}`);
    });

    /**
     * THE GATE ITSELF: everything git already tracks, scanned with the real scanner. This is the
     * assertion that turns "we wrote a rule" into "the suite goes red if a token lands in the tree".
     */
    test('no tracked file carries a session token', (t: any) => {
        if (!runnableOrSkip(t, insideWorkTree(), 'not a git work tree (archive/tarball checkout)')) return;
        const r = spawnSync(process.execPath, [SCANNER, '--tracked'], { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `a tracked file carries a credential:\n${r.stderr}`);

        // Exit 0 over an EMPTY list is also exit 0 — the summary is what distinguishes "clean" from
        // "never looked", which is the difference between a gate and a decoration.
        const m = String(r.stdout).match(/scanned (\d+) of (\d+) paths/);
        assert.ok(m, `the scan must report what it covered, got: ${r.stdout}`);
        assert.ok(Number(m![1]) > 500, `only ${m![1]} files were actually read — the gate is not covering the tree`);
    });
});

describe('debug dumps are born covered', () => {
    const HELPER_URL = new URL(`file://${DUMP_HELPER.replace(/\\/g, '/')}`).href;

    /** Run a snippet against the REAL ESM helper the stitch scripts import, and read back stdout. */
    function runHelper(body: string): string {
        return execFileSync(process.execPath, ['--input-type=module', '-e', body], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        }).trim();
    }

    function resolveDump(arg: string): string {
        return runHelper(
            `import { dumpPath } from ${JSON.stringify(HELPER_URL)};` +
                `process.stdout.write(dumpPath(${JSON.stringify(arg)}, { mkdir: false, quiet: true }));`,
        );
    }

    const inDumps = (name: string) => path.join(REPO_ROOT, '.debug-dumps', name);

    /**
     * The helper is the single producer every rule below leans on. If the repo stops carrying it, say
     * so by name — the previous shape failed with an opaque ENOENT from a spawned child process.
     */
    test('the repo carries the dump helper the rules are written against', () => {
        assert.ok(
            fs.existsSync(DUMP_HELPER),
            `scripts/stitch-dump-path.mjs is missing from this checkout — every dump rule below is ` +
                `meaningless without it`,
        );
    });

    test('an operator-typed name lands in the ignored directory, whatever it is called', () => {
        // These are exactly the names that produced page172.json / put208.json / mirror2.json.
        for (const name of ['probe.json', 'snap.json', 'emitted2.json', 'measures.json']) {
            assert.strictEqual(resolveDump(name), inDumps(name));
        }
    });

    test('a path aimed at the working tree is re-homed, not obeyed', () => {
        assert.strictEqual(resolveDump(path.join(REPO_ROOT, 'page999.json')), inDumps('page999.json'));
        assert.strictEqual(resolveDump(path.join(REPO_ROOT, 'backend', 'x.json')), inDumps('x.json'));
        assert.strictEqual(resolveDump('../../put208.json'), inDumps('put208.json'));
    });

    test('a path outside the repo is left alone — git can never see it', () => {
        const outside = path.join(os.tmpdir(), 'wjs-dump-outside.json');
        assert.strictEqual(resolveDump(outside), path.resolve(outside));
    });

    /**
     * The value that is CHECKED must be the value that is USED. Every dump write in scripts/stitch-*.mjs
     * has to write the path dumpPath() returned; sanitising one path and writing another is how
     * containment checks die.
     */
    test('no script writes a dump to a bare name — not just the two we caught', () => {
        // Deliberately EVERY script the repo carries, not only stitch-*: the rule is about the shape,
        // and the next dump producer will not be called stitch-anything. The population comes from git
        // (see scriptPopulation) so it is the set the repo ships, in a work tree and in a checkout
        // alike — a developer's local scratch can neither satisfy this rule nor break it.
        const { files, source } = scriptPopulation();

        // A rule over an empty list is exit 0 as surely as a clean tree is. Pin the floor, and pin the
        // two files that must always be in it, so a broken population reads as red, not as green.
        assert.ok(files.length >= 20, `only ${files.length} scripts in the population (${source}) — that is not the repo`);
        for (const must of ['scripts/make-release.js', 'scripts/stitch-dump-path.mjs']) {
            assert.ok(files.includes(must), `${must} missing from the population (${source}) — the scan is not covering scripts/`);
        }

        const offenders: string[] = [];
        for (const rel of files) {
            offenders.push(...bareDumpWrites(rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')));
        }
        assert.deepStrictEqual(
            offenders,
            [],
            `these dumps bypass dumpPath() (${files.length} scripts scanned, population from ${source}):\n` +
                offenders.join('\n'),
        );
    });

    /**
     * THE CONTROL, and the acceptance rule for the gate above: adding a member must turn it red. The
     * scan is a set of regexes, and a regex that matches nothing passes every clean tree ever built —
     * so feed it the three shapes it exists for and require each one to be caught.
     */
    test('the scan really catches the shapes it exists for (a no-op regex would pass the tree too)', () => {
        const HELPER_IMPORT = 'import { dumpPath } from "./stitch-dump-path.mjs";\n';
        for (const [what, src] of [
            ['a bare literal name', 'fs.writeFileSync("probe.json", body);'],
            ['a raw argv element', 'fs.writeFileSync(process.argv[3], body);'],
            [
                'one path sanitised, another written',
                `${HELPER_IMPORT}const out = dumpPath(process.argv[3]);\nfs.writeFileSync(process.argv[3] + ".bak", body);`,
            ],
        ] as [string, string][]) {
            assert.ok(bareDumpWrites('synthetic.mjs', src).length > 0, `the rule does not catch: ${what}`);
        }

        // And the control OF the control: a compliant producer must not be flagged, or the gate is a
        // blanket ban on writing files and gets deleted the first time it blocks something real.
        assert.deepStrictEqual(
            bareDumpWrites(
                'compliant.mjs',
                `${HELPER_IMPORT}const out = dumpPath(process.argv[3]); fs.writeFileSync(out, json);\n` +
                    'const diffOut = dumpPath("fidelity-diff.json");\nfs.writeFileSync(diffOut, JSON.stringify(diffs));\n',
            ),
            [],
        );
    });

    /**
     * THE VALUE CHECKED IS THE VALUE USED — asserted against the helper itself, which is where the
     * guarantee can actually be made. (This used to hard-code the two producers that happened to exist
     * on one developer's disk; `scripts/stitch-measure.mjs` and `scripts/stitch-fidelity-diff.mjs` are
     * NOT in the repo, so a checkout failed here with ENOENT. Any producer the repo does carry is
     * covered by the shape rule above, whatever it is called.)
     */
    test('writeDump writes exactly the path dumpPath resolved, never its own input', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-dump-'));
        try {
            const asked = path.join(dir, 'nested', 'probe.json');
            const out = JSON.parse(
                runHelper(
                    `import { dumpPath, writeDump } from ${JSON.stringify(HELPER_URL)};` +
                        `const resolved = dumpPath(${JSON.stringify(asked)}, { mkdir: false, quiet: true });` +
                        `const written = writeDump(${JSON.stringify(asked)}, { ok: 1 }, { quiet: true });` +
                        `process.stdout.write(JSON.stringify({ resolved, written }));`,
                ),
            );
            assert.strictEqual(out.written, out.resolved, 'writeDump returned a path dumpPath did not resolve');
            assert.strictEqual(out.resolved, path.resolve(asked), 'an absolute path outside the repo must be obeyed');
            assert.ok(fs.existsSync(out.resolved), 'the bytes must be at the resolved path, not somewhere else');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('.gitignore covers the class, not the file', () => {
    /** `git check-ignore` answers with the RULES, which is what `git add -A` will consult. */
    function ignored(rel: string): boolean {
        return spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: REPO_ROOT }).status === 0;
    }

    test('cookie jars, dumps and the dump directory are ignored', (t: any) => {
        if (!runnableOrSkip(t, insideWorkTree(), 'not a git work tree (archive/tarball checkout)')) return;
        for (const rel of [
            'cj.txt',
            'session.cookies',
            'cookies-admin.txt',
            'cookie-jar-2.txt',
            '.debug-dumps/probe.json',
            '.debug-dumps/nested/whatever.bin',
            '.stitch-cache/blocks/x.json',
            'backend/plugins/stitch-themes/foo/theme.json',
        ]) {
            assert.strictEqual(ignored(rel), true, `debería estar ignorado: ${rel}`);
        }
    });

    /** THE CONTROL: an ignore rule wide enough to swallow source would be worse than none. */
    test('real source is not ignored', (t: any) => {
        if (!runnableOrSkip(t, insideWorkTree(), 'not a git work tree (archive/tarball checkout)')) return;
        for (const rel of [
            'backend/src/index.ts',
            'package.json',
            '.githooks/pre-commit',
            '.githooks/secret-scan.mjs',
            'scripts/stitch-dump-path.mjs',
            'documentation/deployment.md',
        ]) {
            assert.strictEqual(ignored(rel), false, `NO debería estar ignorado: ${rel}`);
        }
    });
});
