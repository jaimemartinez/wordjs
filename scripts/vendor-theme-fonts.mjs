/**
 * Self-host a theme's webfonts (perf F3: zero external origins on the public site).
 *
 *   node scripts/vendor-theme-fonts.mjs <slug> [--check]
 *
 * A theme's style.css typically opens with
 *     @import url('https://fonts.googleapis.com/css2?family=…');
 * which costs the visitor TWO third-party origins on the critical path (googleapis for the CSS,
 * gstatic for the files) and leaks every page view to a third party. This fetches the font CSS
 * once, downloads the woff2 files into the theme's own `fonts/` directory, writes the @font-face
 * rules to the theme's `fonts.css`, and repoints style.css's @import at that LOCAL file.
 *
 * WHY a sibling file instead of inlining the faces into style.css: the default theme's stylesheet
 * exists twice (the shipped file and the literal core/themes.ts writes on "restore"), pinned
 * together by default-theme-parity.test.ts. Inlining would put ~10KB of @font-face in a TS
 * literal; a one-line relative @import keeps both copies trivially in sync — and keeps `restore`
 * from re-introducing the third party. The remaining @import hop is same-origin: no DNS, no TLS
 * handshake, no third party.
 *
 * Fidelity notes:
 *  - The CSS is fetched with a modern-Chrome UA so Google serves the woff2 + unicode-range
 *    variant (the same one real visitors get); asking without a UA yields legacy ttf.
 *  - unicode-range is preserved verbatim, so per-script subsetting keeps working: a Latin-only
 *    page still downloads only the Latin file.
 *  - `font-display: swap` (present in the theme's own URL) travels through unchanged.
 *  - The rules are written inside a MARKER block of their own, distinct from the declarative
 *    compiler's `@wjs-generated` markers, so both writers can coexist in one file.
 *
 * --check exits non-zero if the theme still references an external font host (CI/doctor use).
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
// The catalogue lives in marketplace/themes and the installed themes in backend/themes; both need
// vendoring, and the 43 catalogue themes that still @import Google Fonts are the reason this flag
// exists — they were unreachable while the path was hardcoded.
const rootIdx = argv.indexOf("--root");
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : "backend/themes";
const slug = argv.filter((a, i) => !a.startsWith("--") && !(rootIdx >= 0 && i === rootIdx + 1))[0];
if (!slug) {
    console.error("usage: node scripts/vendor-theme-fonts.mjs <slug> [--check] [--root <dir>]");
    process.exit(2);
}

const themeDir = path.resolve(ROOT, slug);
const cssPath = path.join(themeDir, "style.css");
if (!fs.existsSync(cssPath)) {
    console.error(`theme not found: ${cssPath}`);
    process.exit(2);
}

const START = "/* ==== wjs fonts (vendored — do not edit; regenerate with scripts/vendor-theme-fonts.mjs) ==== */";
const END = "/* ==== end wjs fonts ==== */";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EXTERNAL_FONT_RE = /https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\b/;

let css = fs.readFileSync(cssPath, "utf8");

if (CHECK) {
    const fontsCss = fs.existsSync(path.join(themeDir, "fonts.css"))
        ? fs.readFileSync(path.join(themeDir, "fonts.css"), "utf8") : "";
    const offenders = [];
    if (EXTERNAL_FONT_RE.test(css)) offenders.push("style.css");
    if (EXTERNAL_FONT_RE.test(fontsCss)) offenders.push("fonts.css");
    if (offenders.length) {
        console.error(`❌ ${slug}: external font host referenced in ${offenders.join(", ")}`);
        process.exit(1);
    }
    console.log(`✅ ${slug}: no external font references`);
    process.exit(0);
}

// Collect the @import lines that point at Google Fonts (leave any other @import alone).
const importRe = /@import\s+url\(\s*(['"]?)(https:\/\/fonts\.googleapis\.com\/[^'")]+)\1\s*\)\s*;/g;
const imports = [...css.matchAll(importRe)];
if (!imports.length) {
    console.log(`${slug}: no Google Fonts @import found — nothing to vendor`);
    process.exit(0);
}

const fontsDir = path.join(themeDir, "fonts");
fs.mkdirSync(fontsDir, { recursive: true });

let out = "";
let files = 0;
let bytes = 0;
for (const [, , url] of imports) {
    console.log(`⬇️  ${url}`);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`font CSS fetch failed: ${res.status} ${url}`);
    let faceCss = await res.text();

    // Download every referenced file and repoint the url() at the theme-local copy.
    const urls = [...new Set([...faceCss.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
    for (const fileUrl of urls) {
        const name = sanitizeName(fileUrl);
        const dest = path.join(fontsDir, name);
        if (!fs.existsSync(dest)) {
            const r = await fetch(fileUrl, { headers: { "User-Agent": UA } });
            if (!r.ok) throw new Error(`font file fetch failed: ${r.status} ${fileUrl}`);
            const buf = Buffer.from(await r.arrayBuffer());
            fs.writeFileSync(dest, buf);
            bytes += buf.length;
            files++;
        }
        // Theme CSS is served at /themes/<slug>/style.css, so a relative path resolves to
        // /themes/<slug>/fonts/<name> in every deploy mode.
        faceCss = faceCss.split(fileUrl).join(`fonts/${name}`);
    }
    out += faceCss.trim() + "\n";
}

if (EXTERNAL_FONT_RE.test(out)) throw new Error("a remote font URL survived the rewrite — refusing to write");

fs.writeFileSync(path.join(themeDir, "fonts.css"), `${START}\n${out}${END}\n`);

// Replace the remote @import(s) with ONE local one, kept at the very top of the file: @import is
// only valid before any style rule, and it must precede whatever uses the families.
css = css.replace(importRe, "").replace(/@import\s+url\(\s*(['"]?)fonts\.css\1\s*\)\s*;\s*\n?/g, "");
const localImport = `@import url('fonts.css');`;
// Keep the theme's leading comment banner, then the import, then the rest — with the SAME
// blank-line spacing the remote @import had. (The default theme's stylesheet is pinned
// byte-for-byte against a literal in core/themes.ts by default-theme-parity.test.ts, which
// caught exactly this: eating the blank lines is a diff.)
const bannerEnd = css.startsWith("/*") ? css.indexOf("*/") + 2 : 0;
const rest = css.slice(bannerEnd).replace(/^\s*\n+/, "");
fs.writeFileSync(cssPath, `${css.slice(0, bannerEnd)}\n\n${localImport}\n\n${rest}`);

console.log(`✅ ${slug}: vendored ${files} font file(s), ${(bytes / 1024).toFixed(0)}KB → themes/${slug}/fonts/ + fonts.css`);

function sanitizeName(u) {
    const base = u.split("/").slice(-2).join("-").replace(/[^A-Za-z0-9._-]/g, "_");
    return base.endsWith(".woff2") || base.endsWith(".ttf") ? base : `${base}.woff2`;
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
