/**
 * WordJS — ONE FORM KIT FOR THE ADMIN: the gate's scope, its exact counter and its allowlist.
 *
 * Every field, choice and action of the core admin comes from components/ui (Input, Textarea, Select,
 * Checkbox, Radio, Switch, ColorInput, Slider, the pickers, Button, IconButton, ButtonLink, FileButton,
 * SegmentedControl, Tabs, UnstyledButton). A raw <input>, <select>, <textarea> or <button> in the admin
 * drifts from the kit: its own borders and focus ring, no label wiring, no error text, a button that
 * submits its form by accident.
 *
 * Two checks share this file:
 *   - eslint.config.mjs refuses a raw control in every IN-scope file that is NOT on the allowlist, so a
 *     new file starts at zero;
 *   - src/components/ui/__tests__/formControlsGate.test.ts counts every IN-scope file exactly (the
 *     TypeScript parser, not a grep) against the allowlist, which only ever SHRINKS: a count above its
 *     entry fails, a count below it fails until the entry is lowered, a 0 entry must be deleted.
 * The migration lands screen by screen, each PR lowering or deleting its files' entries.
 *
 * OUT of scope on purpose: what renders inside a visitor's theme (the public routes, content and chrome
 * blocks, the form block, comments, Verso's block renderers, the root error boundary). A theme never
 * ships admin JavaScript; those keep their own markup, styled by wordjs-ui.css and the theme's tokens.
 *
 * `node scripts/form-controls-gate.mjs` prints the current counts; `--write` (re)writes the allowlist
 * from them, and refuses to RAISE an existing entry.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.resolve(HERE, "..", "src");
export const ALLOWLIST_FILE = path.join(SRC, "components", "ui", "formControlsAllowlist.json");

/** The raw intrinsic elements the kit replaces. */
export const RAW_CONTROLS = ["input", "select", "textarea", "button"];

/** IN scope, relative to src/ (a trailing "/" is a folder). */
export const INCLUDE = [
    "app/admin/",
    "app/login/",
    "app/register/",
    "app/install/",
    "app/reset-password/",
    "app/verify-email/",
    "app/migration/",
    "components/",
    "lib/",
];

/** OUT of scope inside those: the kit itself, and code that renders in the visitor's theme. */
export const EXCLUDE = [
    "components/ui/",
    "components/content/",
    "components/public/",
    "components/chrome/",
    "components/verso/blocks/",
    "components/blocks/FormBlock.tsx",
    "components/CommentsSection.tsx",
    "lib/verso/",
];

const posix = (p) => p.split(path.sep).join("/");
const under = (rel, prefixes) => prefixes.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
const isTest = (rel) => /(^|\/)__tests__\//.test(rel) || /\.(test|spec)\.[jt]sx?$/.test(rel);

/** Whether a src-relative path (posix) is under the gate. */
export function inScope(rel) {
    return /\.(tsx|jsx)$/.test(rel) && under(rel, INCLUDE) && !under(rel, EXCLUDE) && !isTest(rel);
}

/** Every IN-scope file, src-relative posix paths, sorted. */
export function scopeFiles(srcDir = SRC) {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); continue; }
            const rel = posix(path.relative(srcDir, full));
            if (inScope(rel)) out.push(rel);
        }
    };
    walk(srcDir);
    return out.sort();
}

/** How many raw <input>/<select>/<textarea>/<button> elements a TSX/JSX source contains (exact, via the parser). */
export function countRawControls(source, fileName = "file.tsx") {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX);
    let n = 0;
    const visit = (node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)
            && RAW_CONTROLS.includes(node.tagName.text)) n++;
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return n;
}

/** { file: count } for every IN-scope file that has at least one raw control. */
export function scan(srcDir = SRC) {
    const counts = {};
    for (const rel of scopeFiles(srcDir)) {
        const n = countRawControls(fs.readFileSync(path.join(srcDir, rel), "utf8"), rel);
        if (n > 0) counts[rel] = n;
    }
    return counts;
}

export function readAllowlist(file = ALLOWLIST_FILE) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

/** The ESLint globs (relative to frontend/) of the gate's scope and of its allowlisted files. */
export function eslintGlobs(allow = readAllowlist()) {
    // A route folder like users/[id] is a glob character class to ESLint: match its brackets literally.
    const literal = (p) => p.replace(/[[\]]/g, "[$&]");
    const glob = (p) => (p.endsWith("/") ? `src/${literal(p)}**/*.{tsx,jsx}` : `src/${literal(p)}`);
    return {
        files: INCLUDE.map(glob),
        ignores: [...EXCLUDE.map(glob), "src/**/__tests__/**", "src/**/*.test.{tsx,jsx}", ...Object.keys(allow).map((f) => `src/${literal(f)}`)],
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const counts = scan();
    if (process.argv.includes("--write")) {
        const prev = readAllowlist();
        const raised = Object.entries(counts).filter(([f, n]) => f in prev && n > prev[f]);
        if (raised.length) {
            console.error(`✖ The allowlist only shrinks. Raised: ${raised.map(([f, n]) => `${f} ${prev[f]} → ${n}`).join(", ")}`);
            process.exit(1);
        }
        const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
        fs.writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
        console.log(`wrote ${Object.keys(sorted).length} file(s), ${Object.values(sorted).reduce((a, b) => a + b, 0)} raw control(s)`);
    } else {
        for (const [f, n] of Object.entries(counts)) console.log(`${String(n).padStart(4)}  ${f}`);
        console.log(`${Object.keys(counts).length} file(s), ${Object.values(counts).reduce((a, b) => a + b, 0)} raw control(s)`);
    }
}
