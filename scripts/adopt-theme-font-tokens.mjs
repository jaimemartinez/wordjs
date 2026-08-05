/**
 * Make a theme's own typefaces reach the blocks.
 *
 *   node scripts/adopt-theme-font-tokens.mjs [slug…] [--root <dir>] [--dry]
 *
 * Forty of the sixty-four catalogue themes style `body` and `h1..h6` with a font-family in their own
 * CSS and declare no --wjs-font-family-* token. That reads as "the theme has a typeface", and for
 * plain page copy it is true — but every block the visual editor renders (card titles, hero titles,
 * stat figures, CTA headings, button labels, form fields) takes its face from the TOKEN, because
 * wordjs-ui.css writes `font-family: var(--wjs-font-family-heading)` into each of those rules. With
 * no token they all fall back to the framework's Inter, so a theme designed around Chakra Petch and
 * JetBrains Mono renders its landing page in Inter and only its paragraphs in the real face.
 *
 * The families are not invented here: they are lifted from the theme's OWN `body` / heading rules
 * (and, failing that, from the @font-face blocks it ships), and written into theme.json's tokens so
 * the declared contract finally says what the stylesheet always meant.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const rootIdx = argv.indexOf("--root");
const ROOT = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : "marketplace/themes");
const asked = argv.filter((a, i) => !a.startsWith("--") && !(rootIdx >= 0 && i === rootIdx + 1));

/** Strip comments so a commented-out rule never wins. */
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The font-family declared by the first rule whose selector list matches one of `selectors`. */
function familyFor(css, selectors) {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
        const sels = m[1].split(",").map((s) => s.trim().toLowerCase());
        if (!sels.some((s) => selectors.includes(s))) continue;
        const f = /(?:^|[;{\s])font-family\s*:\s*([^;}]+)/i.exec(m[2]);
        if (f) return f[1].replace(/!important/i, "").trim();
    }
    return null;
}

/** Families the theme actually ships, in @font-face order — the last-resort source. */
function shippedFamilies(dir) {
    const p = path.join(dir, "fonts.css");
    if (!fs.existsSync(p)) return [];
    const out = [];
    for (const m of fs.readFileSync(p, "utf8").matchAll(/font-family:\s*['"]([^'"]+)['"]/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

const slugs = asked.length
    ? asked
    : fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

let touched = 0;
for (const slug of slugs) {
    const dir = path.join(ROOT, slug);
    const metaPath = path.join(dir, "theme.json");
    const cssPath = path.join(dir, "style.css");
    if (!fs.existsSync(metaPath) || !fs.existsSync(cssPath)) continue;

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.tokens = meta.tokens || {};
    const css = decomment(fs.readFileSync(cssPath, "utf8"));
    // A theme that already declares the family — in tokens or anywhere in its CSS — is left alone.
    if (Object.keys(meta.tokens).some((k) => k.startsWith("--wjs-font-family-")) || /--wjs-font-family-/.test(css)) continue;

    const shipped = shippedFamilies(dir);
    const quote = (f) => (/^[A-Za-z0-9-]+$/.test(f) || /^['"]/.test(f) ? f : `'${f}'`);
    const bodyFamily = familyFor(css, ["body", "html", ":root"])
        || (shipped[0] ? `${quote(shipped[0])}, system-ui, sans-serif` : null);
    const headingFamily = familyFor(css, ["h1", "h1, h2, h3, h4, h5, h6", "h1,h2,h3,h4,h5,h6"])
        || familyFor(css, ["h2", "h3"])
        || (shipped[1] ? `${quote(shipped[1])}, Georgia, serif` : bodyFamily);
    if (!bodyFamily && !headingFamily) continue;

    if (bodyFamily) meta.tokens["--wjs-font-family-base"] = bodyFamily;
    if (headingFamily) meta.tokens["--wjs-font-family-heading"] = headingFamily;
    if (!DRY) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    touched++;
    console.log(`  ✓ ${slug}`);
    console.log(`      base    ${bodyFamily || "—"}`);
    console.log(`      heading ${headingFamily || "—"}`);
}
console.log(`\n${touched} theme(s) given their own typefaces${DRY ? " (dry run)" : ""}.`);
