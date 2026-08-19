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
const { spawnSync } = require('child_process');

const { shouldIgnore, IGNORE_PATTERNS, ROOT_DIR } = require('../../../scripts/make-release.js');

/** A path as the packager sees it: absolute, under the repo root. */
const p = (rel: string) => path.join(ROOT_DIR, ...rel.split('/'));

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
            'backend/plugins/toscano/index.js',
        ]) {
            assert.strictEqual(shouldIgnore(p(rel)), true, `debería excluirse: ${rel}`);
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
