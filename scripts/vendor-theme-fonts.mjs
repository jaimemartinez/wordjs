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

const START = "/* ==== wjs fonts (vendored — do not edit; regenerate with scripts/vendor-theme-fonts.mjs) ==== */";
const END = "/* ==== end wjs fonts ==== */";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/**
 * Every URL a stylesheet can ADDRESS: the `url(…)` tokens and the string form of `@import`.
 *
 * This replaces a substring test for two Google hostnames (`/https?:\/\/(?:fonts\.googleapis\.com|
 * fonts\.gstatic\.com)\b/`). Unanchored, it answered a question about the whole file's text instead
 * of about each reference, and it under-answered in every direction that matters: `//fonts.
 * googleapis.com/…` (protocol-relative — still a third-party origin at runtime) did not match, nor
 * did `HTTPS://Fonts.GoogleAPIs.com` (no `i` flag, and hosts are case-insensitive), nor did ANY
 * other third party — the promise is "zero external origins", not "no Google".
 *
 * So each reference is extracted and classified AT ITS START (`^`): a scheme or a `//` authority
 * means another origin; a relative or root-relative path is ours; `data:`/`#` address nothing.
 * A local path that merely CONTAINS "https://" in a query string is no longer an offender either.
 */
const URL_TOKEN_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)|@import\s+(['"])([^'"]*)\3/gi;
const HAS_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const INERT_REF_RE = /^(?:data:|#)/i;

function externalRefs(cssText) {
    const refs = [];
    for (const m of cssText.matchAll(URL_TOKEN_RE)) {
        const ref = (m[2] ?? m[4] ?? "").trim();
        if (!ref || INERT_REF_RE.test(ref)) continue;
        if (HAS_SCHEME_RE.test(ref) || ref.startsWith("//")) refs.push(ref);
    }
    return refs;
}

// Where a downloaded face may come from and what it may be called on disk — see fontDest() below.
const FONT_HOST = "fonts.gstatic.com";
const SAFE_FONT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:woff2|ttf)$/;
const MAX_FONT_BYTES = 8 * 1024 * 1024;

/**
 * Read a file, or report "not there" — instead of asking existsSync() first and reading afterwards.
 * The two-step version answers a question about a path this script later WRITES to, and the answer is
 * stale the moment it is given (js/file-system-race). One syscall cannot be raced against itself.
 */
function readTextOrNull(p) {
    try {
        return fs.readFileSync(p, "utf8");
    } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EISDIR") return null;
        throw e;
    }
}

// The read IS the existence check: "theme not found" is now what the filesystem answered, not a
// guess taken a moment earlier about a path we are about to rewrite.
let css = readTextOrNull(cssPath);
if (css === null) {
    console.error(`theme not found: ${cssPath}`);
    process.exit(2);
}

if (CHECK) {
    const fontsCss = readTextOrNull(path.join(themeDir, "fonts.css")) ?? "";
    const offenders = [];
    for (const [file, text] of [["style.css", css], ["fonts.css", fontsCss]]) {
        for (const ref of externalRefs(text)) offenders.push(`${file}: ${ref}`);
    }
    if (offenders.length) {
        console.error(`❌ ${slug}: external origin referenced —\n   ${offenders.join("\n   ")}`);
        process.exit(1);
    }
    console.log(`✅ ${slug}: no external references`);
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
        const { name, dest } = fontDest(fontsDir, fileUrl);
        // 'wx' asks "create it if it isn't there" as ONE syscall, which is what the old
        // `if (!existsSync(dest))` meant. EEXIST is the "already vendored, skip" answer; anything else
        // is a real error. Nothing can be swapped in between the question and the write, and an
        // interrupted download leaves no 0-byte file pretending to be a font.
        let fd = null;
        try {
            fd = fs.openSync(dest, "wx");
        } catch (e) {
            if (e.code !== "EEXIST") throw e;
        }
        if (fd !== null) {
            try {
                const r = await fetch(fileUrl, { headers: { "User-Agent": UA } });
                if (!r.ok) throw new Error(`font file fetch failed: ${r.status} ${fileUrl}`);
                const buf = Buffer.from(await r.arrayBuffer());
                assertFontPayload(buf, name, fileUrl);
                fs.writeSync(fd, buf);
                fs.closeSync(fd);
                fd = null;
                bytes += buf.length;
                files++;
            } finally {
                if (fd !== null) {
                    fs.closeSync(fd);
                    fs.rmSync(dest, { force: true }); // don't leave the empty claim behind
                }
            }
        }
        // Theme CSS is served at /themes/<slug>/style.css, so a relative path resolves to
        // /themes/<slug>/fonts/<name> in every deploy mode.
        faceCss = faceCss.split(fileUrl).join(`fonts/${name}`);
    }
    out += faceCss.trim() + "\n";
}

// The CSS being written came off the network. What matters once it is served from our own origin is
// what it can still ADDRESS: an absolute URL (a third party back on the critical path) or an @import
// (the same thing, one hop later). Everything else inside a @font-face block is inert.
const survivors = externalRefs(out);
if (survivors.length) throw new Error(`an external URL survived the rewrite — refusing to write: ${survivors[0]}`);
if (/@import/i.test(out)) throw new Error("the vendored CSS carries an @import — refusing to write");

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

/**
 * Where a downloaded face is allowed to land.
 *
 * The URL is NETWORK data — scraped out of the CSS Google returned — so it does not get to name a file
 * on this machine. The defence is shape + containment, not "strip `..`":
 *   1. The origin is PARSED (not pattern-matched) and compared against one allowed host.
 *   2. The name is built from the URL PATH only, so a query string cannot leak into it.
 *   3. The result must MATCH an anchored allowlist — a name that fails is an error, never a name that
 *      got quietly rewritten into something else.
 *   4. Containment is asserted on the RESOLVED paths with a trailing separator, so neither a symlinked
 *      component nor a `<fontsDir>-something` sibling can pass for the fonts directory.
 * For a well-formed gstatic URL the name is byte-identical to what this script has always written.
 */
function fontDest(fontsDir, u) {
    const url = new URL(u);
    if (url.protocol !== "https:" || url.hostname !== FONT_HOST) {
        throw new Error(`refusing a font from an unexpected origin: ${u}`);
    }
    const raw = url.pathname.split("/").filter(Boolean).slice(-2).join("-").replace(/[^A-Za-z0-9._-]/g, "_");
    const name = (raw.endsWith(".woff2") || raw.endsWith(".ttf") ? raw : `${raw}.woff2`).slice(0, 120);
    if (!SAFE_FONT_FILE.test(name)) throw new Error(`refusing to write a font named ${JSON.stringify(name)}`);

    const root = path.resolve(fontsDir) + path.sep;
    const dest = path.resolve(fontsDir, name);
    if (!dest.startsWith(root)) throw new Error(`font destination escapes ${fontsDir}: ${dest}`);
    return { name, dest };
}

/**
 * What is downloaded must BE the format its name claims. A payload written under a .woff2 name that
 * is not a woff2 is a file whose name lies, and the browser reports that as no typeface at all —
 * silently. Magic numbers: 'wOF2' for woff2, 0x00010000 / 'true' / 'ttcf' for the TrueType family.
 */
function assertFontPayload(buf, name, u) {
    if (buf.length < 4 || buf.length > MAX_FONT_BYTES) {
        throw new Error(`${u}: implausible font payload (${buf.length} bytes)`);
    }
    const magic = buf.toString("latin1", 0, 4);
    const ok = name.endsWith(".woff2")
        ? magic === "wOF2"
        : buf.readUInt32BE(0) === 0x00010000 || magic === "true" || magic === "ttcf";
    if (!ok) throw new Error(`${u}: payload is not a ${name.endsWith(".woff2") ? "woff2" : "TrueType"} font — refusing to write`);
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
