/**
 * Self-host the webfonts a CATALOG theme declares (perf F3: zero external origins on the public site).
 *
 *   node scripts/vendor-catalog-fonts.mjs <slug…|--all> [--check] [--root <dir>]
 *
 * Sibling of scripts/vendor-theme-fonts.mjs, which rewrites an EXISTING remote @import inside an
 * installed theme. Declarative themes have no @import to rewrite: the compiler rejects external
 * url()s outright, so a theme.json that asks for 'Bodoni Moda' compiles to a stylesheet that names
 * a family the browser has never heard of and silently paints the fallback stack. The type pairing —
 * half of what makes a theme look like itself — never reached the page.
 *
 * So the families are read from the theme's OWN tokens (--wjs-font-family-*), fetched from Google
 * Fonts once, and written into the theme as `fonts/*.woff2` + `fonts.css`, with style.css opening on
 * a relative `@import url('fonts.css');`.
 *
 * WHY per-theme copies instead of one shared store: a catalog theme ships as a self-contained zip and
 * installs by unpacking into themes/<slug>/. A shared store would have to be populated by the
 * installer, so any theme installed from a .zip by hand — or restored from a backup — would come up
 * with no type at all. Duplication across themes costs disk we have; a missing font costs the design.
 *
 * Only the `latin` and `latin-ext` subsets are kept. Google's CSS carries a dozen unicode-ranges
 * (cyrillic, greek, vietnamese…); shipping all of them multiplied the catalog by ~5x for glyphs these
 * designs never render. unicode-range is preserved verbatim on the blocks that stay, so the browser
 * still downloads only what a given page actually needs.
 *
 * --check exits non-zero if a theme declares a webfont family it does not ship (CI/doctor use).
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const rootIdx = argv.indexOf("--root");
const ROOT = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : "marketplace/themes");
const slugs = argv.filter((a, i) => !a.startsWith("--") && !(rootIdx >= 0 && i === rootIdx + 1));

const START = "/* ==== wjs fonts (vendored — do not edit; regenerate with scripts/vendor-catalog-fonts.mjs) ==== */";
const END = "/* ==== end wjs fonts ==== */";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);
// Where a downloaded face may come from and what it may be called on disk — see fontDest() below.
// Declared up here because the work loop runs before the bottom of this module is evaluated.
const FONT_HOST = "fonts.gstatic.com";
const SAFE_FONT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.woff2$/;
const MAX_FONT_BYTES = 8 * 1024 * 1024;

// Families the browser already has (or that next/font registers). Naming one of these is a fallback,
// not a request for a webfont.
const SYSTEM = new Set([
    "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "sans-serif", "serif",
    "monospace", "cursive", "fantasy", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto",
    "Helvetica Neue", "Helvetica", "Arial", "Georgia", "Times New Roman", "Times", "Courier New",
    "Courier", "Menlo", "Monaco", "Consolas", "Liberation Mono", "SFMono-Regular", "Apple Color Emoji",
    "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", "Cambria", "Palatino", "Verdana",
    "Tahoma", "Trebuchet MS", "Lucida Console", "Impact", "emoji",
]);

/**
 * Read a file, or report "not there" — instead of asking existsSync() first and reading afterwards.
 * The two-step version answers a question about a path we later WRITE to, and the answer is stale the
 * instant it is returned (js/file-system-race). One syscall cannot be raced against itself.
 */
function readTextOrNull(p) {
    try {
        return fs.readFileSync(p, "utf8");
    } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR" || e.code === "EISDIR") return null;
        throw e;
    }
}

/** Directory listing IS the existence check for ROOT — one call, no window in between. */
function listThemeDirs(root) {
    try {
        return fs.readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (e) {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") {
            console.error(`no theme root at ${root}`);
            process.exit(2);
        }
        throw e;
    }
}

const available = listThemeDirs(ROOT); // also the "no theme root" guard, for explicit slugs too
const targets = slugs.length ? slugs : available;

let failures = 0;
for (const slug of targets) {
    try {
        await one(slug);
    } catch (e) {
        failures++;
        console.error(`  ✗ ${slug}: ${e.message}`);
    }
}
if (failures) process.exit(1);

async function one(slug) {
    const dir = path.join(ROOT, slug);
    const metaPath = path.join(dir, "theme.json");
    const cssPath = path.join(dir, "style.css");
    // Read both up front: the read itself decides whether this is a theme dir, and style.css is not
    // touched again before we rewrite it, so the single copy below is the same bytes the old second
    // read would have returned — minus the check→write race.
    const metaRaw = readTextOrNull(metaPath);
    const cssRaw = readTextOrNull(cssPath);
    if (metaRaw === null || cssRaw === null) return; // not a theme dir

    const meta = JSON.parse(metaRaw);
    const families = declaredFamilies(meta);

    if (CHECK) {
        // The external-origin check runs on EVERY theme, before anything else. It used to sit behind
        // the `families.length` early-return below, so the only themes it inspected were the ones
        // that already declare font tokens — i.e. the ones already vendored. It printed a screen of
        // ticks and exited 0 while 43 of the 64 catalogue themes carried a live Google Fonts import:
        // a gate that could never fail on the bug it exists to catch.
        const css = cssRaw;
        const fontsCss = readTextOrNull(path.join(dir, "fonts.css")) ?? "";
        const EXTERNAL = /https?:\/\/(?!localhost)[^\s'")]+/g;
        const offenders = [];
        for (const [file, text] of [["style.css", css], ["fonts.css", fontsCss]]) {
            for (const url of text.match(EXTERNAL) || []) offenders.push(`${file} → ${url.slice(0, 70)}`);
        }
        if (offenders.length) throw new Error(`references an external origin:\n      ${offenders.join("\n      ")}`);

        if (!families.length) { console.log(`  ✓ ${slug}: no external origin`); return; }
        const missing = families.filter((f) => !fontsCss.includes(`font-family: '${f}'`));
        if (missing.length) throw new Error(`declares ${missing.join(", ")} but ships no face for it`);
        console.log(`  ✓ ${slug}: no external origin, ${families.length} famil${families.length === 1 ? "y" : "ies"} self-hosted`);
        return;
    }

    if (!families.length) return;

    const fontsDir = path.join(dir, "fonts");
    fs.mkdirSync(fontsDir, { recursive: true });

    let out = "";
    let files = 0;
    let bytes = 0;
    for (const family of families) {
        const faceCss = await fetchFamilyCss(family);
        const kept = keepLatin(faceCss);
        if (!kept.trim()) throw new Error(`${family}: no latin subset in the returned CSS`);
        let block = kept;
        const urls = [...new Set([...block.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
        for (const fileUrl of urls) {
            const { name, dest } = fontDest(fontsDir, family, fileUrl);
            // 'wx' asks "create it if it isn't there" as ONE syscall, which is what the old
            // `if (!existsSync(dest))` meant. EEXIST is the "already vendored, skip" answer; anything
            // else is a real error. Nothing can be swapped in between the question and the write, and
            // an interrupted download leaves no 0-byte file pretending to be a font.
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
                    assertWoff2(buf, fileUrl);
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
            block = block.split(fileUrl).join(`fonts/${name}`);
        }
        out += block.trim() + "\n\n";
    }

    // `out` is CSS that came off the network. Both guards are about what it can still ADDRESS once it
    // is served from our own origin: an absolute URL (a third party back on the critical path) or an
    // @import (the same thing, one hop later). Everything else in a @font-face block is inert.
    if (/https?:\/\//.test(out)) throw new Error("a remote URL survived the rewrite — refusing to write");
    if (/@import/i.test(out)) throw new Error("the vendored CSS carries an @import — refusing to write");
    fs.writeFileSync(path.join(dir, "fonts.css"), `${START}\n${out}${END}\n`);

    // @import is only valid before any style rule, so it goes at the very top — ABOVE the compiler's
    // @wjs-generated marker, in the region `wordjs build theme` preserves byte-for-byte. A rebuild
    // therefore keeps the fonts wired up without this script running again.
    const css = cssRaw.replace(/@import\s+url\(\s*(['"]?)fonts\.css\1\s*\)\s*;\s*\n*/g, "");
    fs.writeFileSync(cssPath, `@import url('fonts.css');\n\n${css}`);

    // Drop stale files from a previous run with different families (e.g. after a redesign).
    // `force` so a file another run already removed is not an error — the listing is a snapshot.
    const live = new Set([...out.matchAll(/url\(fonts\/([^)]+)\)/g)].map((m) => m[1]));
    for (const f of fs.readdirSync(fontsDir)) if (!live.has(f)) fs.rmSync(path.join(fontsDir, f), { force: true });

    console.log(`  ✓ ${slug}: ${families.join(" + ")} → ${files} file(s), ${(bytes / 1024).toFixed(0)}KB`);
}

/** First (real) family of every --wjs-font-family-* token the theme declares, de-duplicated. */
function declaredFamilies(meta) {
    const seen = new Set();
    for (const [k, v] of Object.entries(meta.tokens || {})) {
        if (!/^--wjs-font-family-/.test(k)) continue;
        const first = String(v).split(",")[0].trim().replace(/^['"]|['"]$/g, "");
        if (!first || SYSTEM.has(first) || /^var\(/.test(first)) continue;
        seen.add(first);
    }
    return [...seen];
}

/**
 * Google's CSS2 API 400s on an axis a family does not have, so ask widest-first and step down.
 * A static family (Anton) has no wght axis at all; most have no italic.
 */
async function fetchFamilyCss(family) {
    const name = family.replace(/ /g, "+");
    const attempts = [
        `:ital,wght@0,300..800;1,300..800`,
        `:wght@300..800`,
        `:ital,wght@0,400;0,500;0,600;0,700;1,400;1,700`,
        `:wght@400;500;600;700`,
        ``,
    ];
    let lastStatus = 0;
    for (const axis of attempts) {
        const url = `https://fonts.googleapis.com/css2?family=${name}${axis}&display=swap`;
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (res.ok) return await res.text();
        lastStatus = res.status;
    }
    throw new Error(`${family}: Google Fonts returned ${lastStatus} for every axis query`);
}

/**
 * Google labels each @font-face with a `/* subset *\/` comment on the line above. Keep the latin ones,
 * drop the rest — same rules, same unicode-range, a fifth of the bytes.
 */
function keepLatin(css) {
    const out = [];
    const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
    let m;
    while ((m = re.exec(css))) {
        if (KEEP_SUBSETS.has(m[1])) out.push(`/* ${m[1]} */\n${m[2]}`);
    }
    // A family served without subset comments (rare) keeps every face rather than none.
    if (!out.length) return css;
    return out.join("\n");
}

/**
 * Where a downloaded face is allowed to land.
 *
 * The URL is NETWORK data — it is scraped out of the CSS Google returned — so it does not get to name
 * a file on this machine. The defence is not "strip `..`": it is shape + containment.
 *   1. The origin is checked against a single allowed host, parsed (not pattern-matched) by URL.
 *   2. basename() over the URL PATH drops every directory component and the query string with it.
 *   3. The final name must MATCH an anchored allowlist — a name that fails is an error, never a name
 *      that got "cleaned up" into something else.
 *   4. Containment is asserted on the RESOLVED paths with a trailing separator, so neither a symlinked
 *      component nor a `<fontsDir>-something` sibling can pass for the fonts directory.
 * For a well-formed gstatic URL the result is byte-identical to what this script has always written.
 */
function fontDest(fontsDir, family, u) {
    const url = new URL(u);
    if (url.protocol !== "https:" || url.hostname !== FONT_HOST) {
        throw new Error(`refusing a font from an unexpected origin: ${u}`);
    }
    const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const stem = path.basename(url.pathname)
        .replace(/\.woff2$/i, "")
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .replace(/^[._-]+/, "")
        .slice(0, 80);
    const name = `${slug}-${stem || "font"}.woff2`;
    if (!SAFE_FONT_FILE.test(name)) throw new Error(`refusing to write a font named ${JSON.stringify(name)}`);

    const root = path.resolve(fontsDir) + path.sep;
    const dest = path.resolve(fontsDir, name);
    if (!dest.startsWith(root)) throw new Error(`font destination escapes ${fontsDir}: ${dest}`);
    return { name, dest };
}

/**
 * What is downloaded must BE a woff2 before it is written under a .woff2 name. Without this a family
 * served as ttf (older UA, odd family) was written with a forced .woff2 extension: a file whose name
 * lies about its contents, which the browser then refuses — silently, as a missing typeface.
 */
function assertWoff2(buf, u) {
    if (buf.length === 0 || buf.length > MAX_FONT_BYTES) {
        throw new Error(`${u}: implausible font payload (${buf.length} bytes)`);
    }
    if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error(`${u}: not a woff2 payload — refusing to write`);
}
