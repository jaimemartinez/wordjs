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

if (!fs.existsSync(ROOT)) {
    console.error(`no theme root at ${ROOT}`);
    process.exit(2);
}

const targets = slugs.length
    ? slugs
    : fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

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
    if (!fs.existsSync(metaPath) || !fs.existsSync(cssPath)) return; // not a theme dir

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const families = declaredFamilies(meta);
    if (!families.length) return;

    if (CHECK) {
        const fontsCss = fs.existsSync(path.join(dir, "fonts.css"))
            ? fs.readFileSync(path.join(dir, "fonts.css"), "utf8") : "";
        const missing = families.filter((f) => !fontsCss.includes(`font-family: '${f}'`));
        if (missing.length) throw new Error(`declares ${missing.join(", ")} but ships no face for it`);
        console.log(`  ✓ ${slug}: ${families.length} famil${families.length === 1 ? "y" : "ies"} self-hosted`);
        return;
    }

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
            const name = sanitizeName(family, fileUrl);
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
            block = block.split(fileUrl).join(`fonts/${name}`);
        }
        out += block.trim() + "\n\n";
    }

    if (/https?:\/\//.test(out)) throw new Error("a remote URL survived the rewrite — refusing to write");
    fs.writeFileSync(path.join(dir, "fonts.css"), `${START}\n${out}${END}\n`);

    // @import is only valid before any style rule, so it goes at the very top — ABOVE the compiler's
    // @wjs-generated marker, in the region `wordjs build theme` preserves byte-for-byte. A rebuild
    // therefore keeps the fonts wired up without this script running again.
    let css = fs.readFileSync(cssPath, "utf8");
    css = css.replace(/@import\s+url\(\s*(['"]?)fonts\.css\1\s*\)\s*;\s*\n*/g, "");
    fs.writeFileSync(cssPath, `@import url('fonts.css');\n\n${css}`);

    // Drop stale files from a previous run with different families (e.g. after a redesign).
    const live = new Set([...out.matchAll(/url\(fonts\/([^)]+)\)/g)].map((m) => m[1]));
    for (const f of fs.readdirSync(fontsDir)) if (!live.has(f)) fs.rmSync(path.join(fontsDir, f));

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

function sanitizeName(family, u) {
    const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const base = u.split("/").slice(-1)[0].replace(/[^A-Za-z0-9._-]/g, "_");
    return `${slug}-${base.endsWith(".woff2") ? base : `${base}.woff2`}`;
}
