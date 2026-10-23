/**
 * WordJS — LINT FOR THE MARKETPLACE PLUGINS' CLIENT CODE (marketplace/plugins/<slug>/client/**).
 *
 * `npm run lint` here covered only frontend/: the plugins' admin screens, blocks and portals — which the
 * frontend build compiles into the same bundle — were never linted, so an unused import there was first
 * caught by CodeQL after the push (#591). This runs ESLint over that code with the rules that matter for it:
 *
 *   - @typescript-eslint/no-unused-vars (unused imports, variables and parameters) — an ERROR, held by a
 *     shrink-only per-file baseline (marketplace/lint-baseline.json): a file above its entry fails, a file
 *     not listed fails on its first hit, and a file BELOW its entry fails until the entry is lowered, so a
 *     fixed one cannot quietly come back. A plugin's own fix lowers or deletes its entries.
 *   - any other ESLint error (a parse error included) fails outright.
 *
 * Vendored third-party files (any `vendor` folder under a plugin's client code) are left out.
 *
 * The react-hooks and @next/next plugins are registered (no rules enabled) only so the `eslint-disable`
 * comments the plugins already carry for those rules resolve instead of reporting "rule not found".
 *
 * ESLint ignores files outside its base path, which is the working directory when the config is given
 * here: so it runs with cwd = marketplace/, using this package's own ESLint install.
 *
 * `node scripts/lint-marketplace-clients.mjs` checks; `--write` (re)writes the baseline from the current
 * counts and refuses to RAISE an existing entry or add a new one.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ESLint } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";

// The TypeScript parser and the @next/next plugin come with eslint-config-next (this package's direct
// dependency, the same ones `eslint .` runs with): resolved from there, not from wherever npm hoisted them.
const fromNextConfig = createRequire(createRequire(import.meta.url).resolve("eslint-config-next"));
const tseslint = fromNextConfig("typescript-eslint");
const nextPlugin = fromNextConfig("@next/eslint-plugin-next");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKETPLACE = path.resolve(HERE, "..", "..", "marketplace");
const BASELINE_FILE = path.join(MARKETPLACE, "lint-baseline.json");
const BASELINED_RULE = "@typescript-eslint/no-unused-vars";

const CONFIG = [
    {
        files: ["plugins/*/client/**/*.{ts,tsx,js,jsx,mjs}"],
        // Third-party code vendored as-is (a QR decoder) is not ours to restyle.
        ignores: ["plugins/*/client/**/vendor/**"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
        },
        linterOptions: { reportUnusedDisableDirectives: "off" },
        plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks, "@next/next": nextPlugin },
        rules: {
            [BASELINED_RULE]: ["error", { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
        },
    },
];

/** Per-file count of the baselined rule, and every other error, keyed by a path relative to marketplace/. */
export async function lintCounts() {
    const eslint = new ESLint({ cwd: MARKETPLACE, overrideConfigFile: true, overrideConfig: CONFIG, errorOnUnmatchedPattern: false });
    const results = await eslint.lintFiles(["plugins/*/client/**/*.{ts,tsx,js,jsx,mjs}"]);
    const counts = {};
    const others = [];
    for (const r of results) {
        const rel = path.relative(MARKETPLACE, r.filePath).split(path.sep).join("/");
        for (const m of r.messages) {
            if (m.ruleId === BASELINED_RULE) counts[rel] = (counts[rel] || 0) + 1;
            else if (m.severity === 2) others.push(`${rel}:${m.line}:${m.column} ${m.ruleId || "error"}: ${m.message}`);
        }
    }
    return { counts, others, files: results.length };
}

function readBaseline() {
    try { return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")); } catch { return {}; }
}

/** Compare counts with the baseline: every problem as one line (empty = pass). */
export function compare(counts, baseline) {
    const problems = [];
    for (const [file, n] of Object.entries(counts)) {
        const allowed = baseline[file] || 0;
        if (n > allowed) problems.push(`${file}: ${n} unused (allowed ${allowed}) — remove the unused import/variable`);
    }
    for (const [file, allowed] of Object.entries(baseline)) {
        const n = counts[file] || 0;
        if (n < allowed) problems.push(`${file}: ${n} unused, the baseline still allows ${allowed} — lower its entry in marketplace/lint-baseline.json${n === 0 ? " (delete it)" : ""}`);
    }
    return problems;
}

async function main() {
    const write = process.argv.includes("--write");
    const { counts, others, files } = await lintCounts();
    const baseline = readBaseline();
    if (write) {
        const next = {};
        for (const [file, n] of Object.entries(counts)) {
            if (!(file in baseline) && Object.keys(baseline).length) { console.error(`refusing to add ${file} (${n}): fix it instead`); process.exitCode = 1; continue; }
            if (file in baseline && n > baseline[file]) { console.error(`refusing to raise ${file} from ${baseline[file]} to ${n}`); process.exitCode = 1; continue; }
            next[file] = n;
        }
        const sorted = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
        fs.writeFileSync(BASELINE_FILE, JSON.stringify(sorted, null, 2) + "\n");
        console.log(`wrote ${Object.keys(sorted).length} entries to marketplace/lint-baseline.json`);
        return;
    }
    const problems = [...others, ...compare(counts, baseline)];
    if (problems.length) {
        console.error(`Marketplace plugin client lint: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
        process.exitCode = 1;
        return;
    }
    const held = Object.values(baseline).reduce((a, b) => a + b, 0);
    console.log(`Marketplace plugin client lint: ${files} files clean (${held} baselined unused-variable hits left to fix).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error(e); process.exitCode = 1; });
}
