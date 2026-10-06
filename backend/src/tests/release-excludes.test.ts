/**
 * RELEASE PACKAGER — what must NEVER reach the published artifact.
 *
 * The release ZIP is built from a REAL WORKING TREE (`npm run bundle-release`), not from a clean
 * checkout, so anything gitignored still sits on disk and gets packaged unless it is excluded here.
 * That is how `.claude/` ended up inside a published bundle: 6744 of 12169 entries and 46 MB of a
 * 97 MB artifact, including full git worktrees under `.claude/worktrees/` and, worse, `mcp.json`
 * and `settings.local.json` — local configuration that can hold credentials for connected servers.
 *
 * The list already carried `brain`, `.agent` and `.gemini`, so the RULE was understood and only one
 * entry was missing. These tests pin the whole family, because the next assistant directory will be
 * created by a tool nobody has installed yet.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const { shouldIgnore, IGNORE_PATTERNS, ROOT_DIR } = require('../../../scripts/make-release.js');

/** A path as the packager sees it: absolute, under the repo root. */
const p = (rel: string) => path.join(ROOT_DIR, ...rel.split('/'));

const PACKAGER = path.join(ROOT_DIR, 'scripts', 'make-release.js');

/**
 * The packager's structural rule ("untracked ⇒ does not ship") IS git: `make-release.js` asks
 * `git ls-files` and, when git cannot answer, says so out loud and falls back to the name list only.
 * A test of that rule therefore needs the same thing the packager needs. This probe is the packager's
 * own, so the test skips exactly where the rule is genuinely inexpressible — an archive/tarball
 * extraction — and nowhere else.
 */
function packagerCanConsultGit(): boolean {
    const r = spawnSync('git', ['ls-files', '-z', '--', '.'], { cwd: ROOT_DIR });
    return r.status === 0 && !!r.stdout && r.stdout.length > 0;
}

/**
 * A skip is honest only where the rule cannot run. In CI the repo is checked out WITH git, so a
 * missing work tree there means the checkout is broken and the answer is red — not a "skipped" line
 * that the summary rolls up into a green run. The same shape guards the hygiene gates.
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

describe('release packager — agent/assistant directories never ship', () => {
    test('.claude and its contents are excluded, at any depth', () => {
        for (const rel of [
            '.claude',
            '.claude/mcp.json',
            '.claude/settings.local.json',
            '.claude/worktrees/some-branch/backend/src/index.ts',
            'frontend/.claude/settings.local.json',
        ]) {
            assert.strictEqual(shouldIgnore(p(rel)), true, `debería excluirse: ${rel}`);
        }
    });

    test('the whole family is listed, not just the one that bit us', () => {
        for (const dir of ['brain', '.agent', '.gemini', '.claude', '.cursor']) {
            assert.ok(IGNORE_PATTERNS.includes(dir), `falta en IGNORE_PATTERNS: ${dir}`);
        }
    });

    test('secrets and local state stay out', () => {
        for (const rel of [
            'wordjs-config.json',
            'gateway/gateway-config.json',
            '.env',
            'backend/data/database.sqlite',
            'marketplace/plugins/faq/index.js',
            '.release-exclude',
        ]) {
            assert.strictEqual(shouldIgnore(p(rel)), true, `debería excluirse: ${rel}`);
        }
    });

    /**
     * THE GATEWAY'S PUSHED HOST POLICY (gateway/gateway-host-policy.json, written by POST /host-policy,
     * plus the temp file an interrupted push leaves next to it) is per-install state: shipped or
     * committed, it makes another install answer 421 on every address but the one it names. Asked by
     * NAME, in a packager that cannot reach git — the structural "untracked does not ship" rule would
     * hide a missing entry wherever git can answer, and an archive extraction is exactly where it cannot.
     */
    test('the gateway\'s pushed host policy never ships, and git never tracks it', (t: any) => {
        const rels = ['gateway/gateway-host-policy.json', 'gateway/gateway-host-policy.json.4242.tmp', 'gateway/src/host-edge.js'];
        const script = `const path = require('path');
const { shouldIgnore } = require(${JSON.stringify(path.join(ROOT_DIR, 'scripts', 'make-release.js'))});
const root = ${JSON.stringify(ROOT_DIR)};
const rels = ${JSON.stringify(rels)};
process.stdout.write('\\nRESULT ' + JSON.stringify(rels.map((r) => shouldIgnore(path.join(root, ...r.split('/'))))) + '\\n');`;
        const run = spawnSync(process.execPath, ['-e', script], { cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env, PATH: '' } });
        assert.strictEqual(run.status, 0, run.stderr);
        assert.match(run.stdout, /git unavailable/, 'the child must run the name-list fallback, not the git rule');
        const line = run.stdout.split('\n').find((l: string) => l.startsWith('RESULT '));
        assert.deepStrictEqual(JSON.parse(String(line).slice('RESULT '.length)), [true, true, false],
            'the policy file and its temp sibling are excluded by name; the gateway source next to them still ships');

        if (!runnableOrSkip(t, packagerCanConsultGit(), 'no git work tree: .gitignore cannot be evaluated')) return;
        for (const rel of rels.slice(0, 2)) {
            const ignored = spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT_DIR });
            assert.strictEqual(ignored.status, 0, `.gitignore must cover ${rel}`);
        }
    });

    /**
     * LA REGLA ESTRUCTURAL, que es la que de verdad cierra la clase: lo que git no trackea es local
     * del desarrollador y no viaja, salvo los artefactos de build que se envían a propósito. Una
     * lista de NOMBRES siempre va un paso por detrás — se le escapó `.claude/`, y en cuanto se
     * añadió, se le escaparon `.mcp.json` y los ficheros de trabajo sueltos de la raíz.
     */
    test('lo que git no conoce no viaja, aunque nadie lo haya puesto en la lista', (t: any) => {
        // El paquete se construye SIEMPRE desde un árbol de trabajo con git; una extracción de
        // `git archive` no lo es, y allí la regla no existe — el propio empaquetador lo anuncia y
        // degrada a la lista de nombres. Se salta con motivo, y en CI se prohíbe saltarla.
        if (!runnableOrSkip(t, packagerCanConsultGit(), 'no hay work tree de git (extracción archive/tarball): el empaquetador degrada a la lista de nombres y la regla estructural no puede evaluarse')) return;

        for (const rel of ['.mcp.json', 'emitted.json', 'page172.json', 'mirror-puck.json', 'temp_manifest.json']) {
            assert.strictEqual(shouldIgnore(p(rel)), true, `no trackeado, debería excluirse: ${rel}`);
        }

        // EL CONTROL: "excluir todo lo que no esté en la lista blanca" pasaría las cinco líneas de
        // arriba. Un fichero que git SÍ trackea tiene que seguir viajando, y se elige leyendo el
        // índice — no un nombre escrito a mano que mañana se renombra y deja el control inerte.
        const tracked = spawnSync('git', ['ls-files', '-z', '--', 'documentation'], { cwd: ROOT_DIR })
            .stdout.toString('utf8')
            .split('\0')
            .filter(Boolean)
            .filter((f: string) => f.endsWith('.md') && fs.existsSync(p(f)));
        assert.ok(tracked.length > 0, 'el índice no devolvió ningún .md de documentation/: el control no está mirando nada');
        for (const rel of tracked.slice(0, 5)) {
            assert.strictEqual(shouldIgnore(p(rel)), false, `trackeado, debería viajar: ${rel}`);
        }
    });

    test('los artefactos de build SÍ viajan, aunque git los ignore', () => {
        // Sin esta lista blanca, la regla de arriba dejaría el release sin backend compilado.
        for (const rel of [
            'backend/dist/index.js',
            'backend/dist/routes/marketplace.js',
            'frontend/.next/standalone/server.js',
            'frontend/src/lib/pluginRegistry.ts',
        ]) {
            assert.strictEqual(shouldIgnore(p(rel)), false, `artefacto de build, debería viajar: ${rel}`);
        }
    });

    /**
     * THE CONTROL. Without this, "exclude everything" would pass every assertion above — and the
     * packager has already shipped a broken bundle exactly that way: a bare `marketplace` match
     * stripped `backend/dist/routes/marketplace.js` and the backend crashed on boot with
     * `Cannot find module './marketplace'`.
     */
    test('legitimate source is still packaged', () => {
        for (const rel of [
            'backend/dist/routes/marketplace.js',
            'backend/dist/index.js',
            'frontend/.next/standalone/server.js',
            'gateway/src/index.js',
            'backend/cli/wordjs.js',
            'documentation/deployment.md',
        ]) {
            assert.strictEqual(shouldIgnore(p(rel)), false, `NO debería excluirse: ${rel}`);
        }
    });
});

/**
 * PRIVATE, UNTRACKED PLUGINS — kept out of the bundle without being named anywhere public.
 *
 * The packager used to keep private plugin directories out of the ZIP by listing them in
 * IGNORE_PATTERNS, which published in the repository exactly what it was meant to protect. What keeps
 * them out now is structural (git does not track them), plus the gitignored `.release-exclude` for a
 * tree where git cannot answer. These tests build a throwaway project, run the packager's own copy step
 * over it and read what came out: the question is what lands in the bundle, not what a predicate says
 * about one path.
 */
describe('release packager — private, untracked plugins never ship', () => {
    /** Write `files` (project-relative path → content) under `root`. */
    function writeTree(root: string, files: Record<string, string>) {
        for (const [rel, body] of Object.entries(files)) {
            const abs = path.join(root, ...rel.split('/'));
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, body);
        }
    }

    /**
     * A throwaway project with the packager inside it. make-release.js anchors ROOT_DIR on its own
     * location (`scripts/..`), so a copy of the real file packages the fixture instead of this
     * repository — and requiring it from there is a fresh module instance, with its own git and
     * `.release-exclude` caches.
     */
    function fixtureProject(files: Record<string, string>): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-release-fixture-'));
        writeTree(root, files);
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.copyFileSync(PACKAGER, path.join(root, 'scripts', 'make-release.js'));
        return root;
    }

    /** Every path in the bundle, directories included: an empty directory still publishes its name. */
    function bundleListing(dir: string): string[] {
        const out: string[] = [];
        const walk = (rel: string) => {
            for (const e of fs.readdirSync(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
                const r = rel ? `${rel}/${e.name}` : e.name;
                out.push(r);
                if (e.isDirectory()) walk(r);
            }
        };
        walk('');
        return out.sort();
    }

    /**
     * Run `fn` with git pointed where the test says. The packager shells out to git with the inherited
     * environment, so a GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE left over from the caller (a git hook,
     * say) would make it read some other repository.
     */
    function withGitEnv<T>(gitDir: string | undefined, fn: () => T): T {
        const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
        const saved = keys.map((k) => process.env[k]);
        for (const k of keys) delete process.env[k];
        if (gitDir !== undefined) process.env.GIT_DIR = gitDir;
        try {
            return fn();
        } finally {
            keys.forEach((k, i) => {
                if (saved[i] === undefined) delete process.env[k];
                else process.env[k] = saved[i];
            });
        }
    }

    /** Package `root` with its own copy of the packager; returns the bundle's listing. */
    function packageFixture(root: string): string[] {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wjs-release-bundle-'));
        try {
            const { copyFiles } = require(path.join(root, 'scripts', 'make-release.js'));
            copyFiles(root, path.join(out, 'pkg'));
            return bundleListing(path.join(out, 'pkg'));
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    }

    const PUBLIC: Record<string, string> = {
        'backend/plugins/public-plugin/manifest.json': '{"slug":"public-plugin"}',
        'backend/plugins/public-plugin/index.js': 'module.exports = {};',
        'backend/themes/public-theme/theme.json': '{"slug":"public-theme"}',
    };

    test('an untracked plugin or theme directory does not reach the bundle — not even its name', (t: any) => {
        if (!runnableOrSkip(t, packagerCanConsultGit(), 'git cannot list files here, so the structural rule cannot be exercised')) return;

        const root = fixtureProject({
            ...PUBLIC,
            // Gitignored, as private extensions are in a real working tree...
            '.gitignore': 'backend/plugins/private-ignored/\nbackend/themes/private-theme/\n',
            'backend/plugins/private-ignored/manifest.json': '{"slug":"private-ignored"}',
            'backend/plugins/private-ignored/index.js': 'module.exports = {};',
            'backend/themes/private-theme/theme.json': '{"slug":"private-theme"}',
            // ...and merely never added: no ignore rule, no name anywhere. It must not matter.
            'backend/plugins/private-untracked/index.js': 'module.exports = {};',
        });
        try {
            const listing = withGitEnv(undefined, () => {
                const git = (...args: string[]) => {
                    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
                    assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
                };
                git('init', '-q');
                git('add', '--', '.gitignore', 'scripts', 'backend/plugins/public-plugin', 'backend/themes/public-theme');
                return packageFixture(root);
            });

            // THE CONTROL: an exclusion that dropped everything would pass the assertion below.
            for (const rel of Object.keys(PUBLIC)) {
                assert.ok(listing.includes(rel), `tracked, should ship: ${rel}\nbundle: ${listing.join(', ')}`);
            }
            const leaked = listing.filter((rel) => rel.includes('private-'));
            assert.deepStrictEqual(leaked, [], 'untracked extension directories reached the bundle');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('where git cannot answer, .release-exclude keeps private paths out — and never ships itself', () => {
        const root = fixtureProject({
            ...PUBLIC,
            'backend/plugins/private-listed/index.js': 'module.exports = {};',
            'backend/themes/private-listed-theme/theme.json': '{"slug":"private-listed-theme"}',
            // CRLF, a comment line, a blank line, a trailing slash, indentation and a trailing comment:
            // the file is hand-written, so the parser has to take it as people write it.
            '.release-exclude': [
                '# private, untracked extensions',
                'backend/plugins/private-listed/',
                '',
                '   backend/themes/private-listed-theme   # trailing comment',
                '',
            ].join('\r\n'),
        });
        try {
            // GIT_DIR at a directory that does not exist: git fails, as it does on a tree copied without
            // `.git/` (the Docker build context excludes it) or when git refuses the repository.
            const listing = withGitEnv(path.join(root, 'no-such-git-dir'), () => packageFixture(root));

            // THE CONTROL, and the proof the fallback ran: nothing here is tracked, so with git answering
            // the public plugin would have been dropped too.
            for (const rel of Object.keys(PUBLIC)) {
                assert.ok(listing.includes(rel), `should ship in the name-list fallback: ${rel}\nbundle: ${listing.join(', ')}`);
            }
            const leaked = listing.filter((rel) => rel.includes('private-'));
            assert.deepStrictEqual(leaked, [], 'paths listed in .release-exclude reached the bundle');
            assert.ok(!listing.includes('.release-exclude'), '.release-exclude names what must stay private: it must never ship');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    /**
     * The other half of the fix: the packager keeps private extensions out WITHOUT naming them. A test
     * cannot list the names it guards against without publishing them, so it asserts the shape instead —
     * the packager names no individual plugin or theme directory at all, and no bare entry in its list
     * is the name of an extension present in this tree (on a developer machine that includes the
     * private, untracked ones).
     */
    test('make-release.js names no individual plugin or theme', () => {
        const source = fs.readFileSync(PACKAGER, 'utf8');
        const named = [...source.matchAll(/(?:^|[^\w-])((?:plugins|themes)\/[A-Za-z0-9_][\w.-]*)/g)].map((m) => m[1]);
        assert.deepStrictEqual(named, [], 'make-release.js names extension directories; exclude them structurally or via .release-exclude');

        const extensionDirs: string[] = ['backend/plugins', 'backend/themes'].flatMap((dir) =>
            fs.readdirSync(p(dir), { withFileTypes: true })
                .filter((e: any) => e.isDirectory())
                .map((e: any) => e.name),
        );
        assert.ok(extensionDirs.length > 0, 'no plugin or theme directories found: the check below is looking at nothing');
        const listed = IGNORE_PATTERNS.filter((entry: string) => extensionDirs.includes(entry));
        assert.deepStrictEqual(listed, [], 'IGNORE_PATTERNS names an extension directory; exclude it structurally or via .release-exclude');
    });
});
