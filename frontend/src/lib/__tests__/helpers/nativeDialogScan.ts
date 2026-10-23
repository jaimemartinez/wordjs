/**
 * Finds every call to the browser's own alert(), confirm() and prompt() in code a browser runs: the admin
 * and public frontend, the backend's public assets and themes, and every marketplace plugin's client code.
 *
 * Scope-aware, so a `confirm` destructured from useModal() — a local binding — is not a finding, while a
 * bare `confirm(...)` that resolves to the global is. The JavaScript/TypeScript is linted with ESLint's
 * `no-alert` plus the `globalThis` / `self` / `top` / `parent` spellings it does not cover. An .html file is
 * read with an HTML tokenizer (htmlparser2, which sanitize-html already brings): the text of every
 * `<script>` element and the value of every `on…` attribute are linted like any script, so an end tag
 * spelled `</SCRIPT >` or a handler in single quotes is read the way a browser reads it. Markup written
 * inside code (a server or a theme building HTML as a string) gets a text check for inline handlers.
 */
import fs from "node:fs";
import path from "node:path";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { Parser } from "htmlparser2";

export const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/** The trees a browser loads code from. Relative to the repository root. */
export const SCAN_ROOTS = [
    "frontend/src",
    "frontend/public",
    "backend/public",
    "backend/themes",
    "backend/src",
    "gateway/src",
    "marketplace/plugins",
];

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", "__tests__", "tests", "test", "vendor"]);
const CODE_EXT = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const MARKUP_EXT = new Set([".html", ".htm"]);
// Minified third-party bundles are not ours to rewrite, and their names say so.
const SKIP_FILE = /\.min\.(js|css)$|\.d\.ts$|\.test\.[jt]sx?$|\.spec\.[jt]sx?$/;

export interface DialogFinding { file: string; line: number; column: number; what: string }

const DIALOG_OBJECTS = ["window", "globalThis", "self", "top", "parent"];
const rules = {
    "no-alert": "error",
    "no-restricted-properties": ["error", ...DIALOG_OBJECTS.flatMap((object) => ["alert", "confirm", "prompt"].map((property) => ({ object, property })))],
} as const;

const linter = new Linter({ configType: "flat" });

function lintCode(code: string, filename: string): Array<{ line: number; column: number; message: string }> {
    const ts = /\.tsx?$/.test(filename);
    // The Linter matches configs by file name; a neutral name with the right extension is enough here.
    const name = "scanned" + (path.extname(filename).toLowerCase() || ".js");
    const messages = linter.verify(code, [{
        files: ["**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            ...(ts ? { parser: tsParser as any } : {}),
            parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: rules as any,
        // An `eslint-disable` comment does not hide a call from this scan.
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off" },
    }], { filename: name });
    // A file the parser cannot read is a finding too: an unscanned file is not a clean one. `window.confirm(…)`
    // is reported by both rules at one position; one call is one finding.
    const seen = new Set<string>();
    return messages
        .filter((m) => m.fatal || m.ruleId === "no-alert" || m.ruleId === "no-restricted-properties")
        .filter((m) => { const key = `${m.line}:${m.column}`; if (seen.has(key)) return false; seen.add(key); return true; })
        .map((m) => ({ line: m.line, column: m.column, message: m.fatal ? `unparsed: ${m.message}` : m.message }));
}

// What a file must contain to call one: the name followed by "(", or read off a global object (`window.confirm`,
// `window["confirm"]`, an alias such as `const ask = window.confirm`). Everything else is not parsed.
const MAY_CALL = /\b(?:alert|confirm|prompt)\s*\(|\b(?:window|globalThis|self|top|parent)\s*(?:\.\s*(?:alert|confirm|prompt)\b|\[\s*["'`](?:alert|confirm|prompt)["'`])/;
const INLINE_HANDLER = /\bon[a-z]+\s*=\s*\\?["'][^"'\n]*?(?<![.\w$])(?:(?:window|globalThis|self|top|parent)\s*\.\s*)?(alert|confirm|prompt)\s*\(/gi;
// A <script> whose type is one of these runs as JavaScript; any other type (a template, JSON) does not.
const JS_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"]);

interface MarkupCode { code: string; start: number; what: "script" | "handler"; wrap: boolean }

/** The JavaScript an HTML document carries: its script elements' text and its on… attributes' values. */
export function markupCode(html: string): MarkupCode[] {
    const out: MarkupCode[] = [];
    let script: MarkupCode | null = null;
    const parser = new Parser({
        onopentag(name, attribs) {
            for (const [attr, value] of Object.entries(attribs)) {
                if (/^on/i.test(attr) && value) out.push({ code: value, start: parser.startIndex, what: "handler", wrap: true });
            }
            if (name === "script" && !attribs.src && JS_SCRIPT_TYPES.has((attribs.type || "").trim().toLowerCase())) {
                script = { code: "", start: -1, what: "script", wrap: false };
            }
        },
        ontext(text) {
            if (!script) return;
            if (script.start < 0) script.start = parser.startIndex;
            script.code += text;
        },
        onclosetag(name) {
            if (name === "script" && script) {
                if (script.code.trim()) out.push(script);
                script = null;
            }
        },
    }, { decodeEntities: true });
    parser.write(html);
    parser.end();
    return out;
}

function lineOf(text: string, index: number): number {
    let n = 1;
    for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
}

/** The findings in one file's text. `rel` decides how it is read (by extension). */
export function scanText(text: string, rel: string): DialogFinding[] {
    const ext = path.extname(rel).toLowerCase();
    const out: DialogFinding[] = [];
    // Only a file that could call one is parsed: a whole-repository scan stays at a few seconds.
    if (!MAY_CALL.test(text)) return out;
    if (CODE_EXT.has(ext)) {
        for (const m of lintCode(text, rel)) out.push({ file: rel, line: m.line, column: m.column, what: m.message });
    }
    if (MARKUP_EXT.has(ext)) {
        for (const part of markupCode(text)) {
            const offset = lineOf(text, Math.max(0, part.start)) - 1;
            // A handler's value is a function body (`return confirm(…)` is legal there).
            const code = part.wrap ? `(function () { ${part.code}\n})` : part.code;
            for (const f of lintCode(code, rel + ".js")) {
                out.push({ file: rel, line: f.line + offset, column: part.wrap ? 0 : f.column, what: part.what === "handler" ? `inline handler: ${f.message}` : f.message });
            }
        }
    } else {
        // Markup a server or a theme writes as a string: its inline handlers, by text.
        for (const m of text.matchAll(INLINE_HANDLER)) {
            out.push({ file: rel, line: lineOf(text, m.index!), column: 0, what: `inline handler calls ${m[1]}()` });
        }
    }
    return out;
}

function walk(dir: string, files: string[]) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(full, files);
        } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if ((CODE_EXT.has(ext) || MARKUP_EXT.has(ext)) && !SKIP_FILE.test(e.name)) files.push(full);
        }
    }
}

/** Every finding under SCAN_ROOTS, with repository-relative POSIX paths. */
export function scanRepository(root = REPO_ROOT): DialogFinding[] {
    const files: string[] = [];
    for (const r of SCAN_ROOTS) walk(path.join(root, r), files);
    const out: DialogFinding[] = [];
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join("/");
        out.push(...scanText(fs.readFileSync(f, "utf8"), rel));
    }
    return out;
}

/** Findings per file. */
export function countByFile(findings: DialogFinding[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.file] = (counts[f.file] || 0) + 1;
    return counts;
}
