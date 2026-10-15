/**
 * No new `console.*` in backend/src — log through core/module-logger instead.
 *
 * The backend's log lines go through `moduleLogger('<dir>/<file>')`: structured, levelled, tagged with
 * the module and the request, credential-scrubbed. `console.*` still works (the bridge in core/logger
 * turns it into a `legacy: true` line), which is exactly why it creeps back unnoticed. This gate walks
 * every source file under backend/src with the TypeScript parser — so a `console.log` inside a STRING
 * (the probe programs plugin-isolate hands to a child node) is not counted — and fails on any reference
 * to `console` (a call, `console[level]`, a `|| console` fallback) outside the allowlist below.
 *
 * The allowlist is per FILE with an exact COUNT and a reason. A count that grows fails; a count that
 * shrinks also fails, with a message asking for the entry to be lowered, so the list never keeps room
 * for a call that is gone.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '..');

/** Paths are relative to backend/src, '/'-separated. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
    'core/logger.ts': {
        count: 4,
        reason: 'the console bridge itself: it wraps and restores the console methods',
    },
    'core/host-policy.js': {
        count: 2,
        reason: 'shared verbatim with gateway/src/host-policy.js (parity-tested); the backend passes a module logger in',
    },
    'config/app.ts': {
        count: 9,
        reason: 'runs before the logger can exist: core/logger reads config/app at load time',
    },
    'core/plugin-context.ts': {
        count: 13,
        reason: 'loaded inside the isolated plugin child; its stdio is captured, slug-tagged and rate-limited by the host',
    },
    'core/io-guard.ts': {
        count: 2,
        reason: 'loaded inside the isolated plugin child; its stdio is captured, slug-tagged and rate-limited by the host',
    },
    'core/secure-require.ts': {
        count: 3,
        reason: 'loaded inside the isolated plugin child; its stdio is captured, slug-tagged and rate-limited by the host',
    },
    'core/install-token.ts': {
        count: 21,
        reason: 'the first-boot install banner for the operator, gated on whether stdout is a terminal',
    },
    'index.ts': {
        count: 11,
        reason: 'the bootstrap-administrator banner for the operator, gated on whether stdout is a terminal',
    },
};

const SKIP_DIRS = new Set(['tests', 'tests-integration']);

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (dir === SRC && SKIP_DIRS.has(entry.name)) continue;
            sourceFiles(full, out);
        } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Every REFERENCE to the global `console`, not only `console.x(...)` calls: `console[level](...)`,
 * `(cond ? console.warn : console.log)(line)`, `opts.logger || console` and a `console.log` handed to a
 * library as a callback all print around the module logger just the same.
 */
function consoleCalls(file: string): number[] {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lines: number[] = [];
    const visit = (n: any): void => {
        if (ts.isIdentifier(n) && n.text === 'console') {
            const p = n.parent;
            const isName = (ts.isPropertyAccessExpression(p) && p.name === n)
                || ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === n);
            if (!isName) lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return lines;
}

describe('backend/src logs through core/module-logger, not console', () => {
    const counts = new Map<string, number[]>();
    for (const file of sourceFiles(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const lines = consoleCalls(file);
        if (lines.length) counts.set(rel, lines);
    }

    it('has no console call outside the allowlist', () => {
        const offenders: string[] = [];
        for (const [rel, lines] of counts) {
            const allowed = ALLOWED[rel];
            if (!allowed) offenders.push(`${rel}: ${lines.length} call(s) at line(s) ${lines.join(', ')}`);
            else if (lines.length > allowed.count) offenders.push(`${rel}: ${lines.length} call(s), allowlisted ${allowed.count} (lines ${lines.join(', ')})`);
        }
        assert.deepStrictEqual(offenders, [], 'Use `const log = require(\'<rel>/core/module-logger\').moduleLogger(\'<dir>/<file>\')` '
            + 'instead of console.* (see core/module-logger.ts). Offending files:\n  ' + offenders.join('\n  '));
    });

    it('keeps the allowlist tight', () => {
        const stale: string[] = [];
        for (const [rel, allowed] of Object.entries(ALLOWED)) {
            const actual = (counts.get(rel) || []).length;
            if (actual < allowed.count) stale.push(`${rel}: allowlisted ${allowed.count}, found ${actual} — lower the entry`);
        }
        assert.deepStrictEqual(stale, []);
    });
});
