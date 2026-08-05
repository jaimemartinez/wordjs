/**
 * Replace the 44 archetype-generated catalogue themes with Stitch-designed ones.
 *
 *   node scripts/rebuild-catalogue-44.mjs [slug…] [--dry]
 *
 * The old catalogue was produced by scripts/create-40-themes.js: four seed colours per theme plus one
 * of six archetype CSS presets, pasted in as manual CSS. That preset painted `body` and the headings
 * from PRIVATE variables (--cyber-*, --edit-*), which is why the customizer could not move those
 * themes and why their own tokens were dead. Every one of them also carried a live Google Fonts
 * @import. They were, in the end, six designs wearing forty-four names.
 *
 * These are rebuilt the way the twenty Stitch themes were: a design system authored per theme, the
 * importer mapping it into tokens, the block recipe giving it an opinion below the fold, the fonts
 * self-hosted, and the verifier checking the compiled CSS still says what the design says.
 *
 * PROVENANCE OF `.design/stitch.json`. Its designTheme is exactly what Stitch echoed back when the
 * design system was created (project 16616215514125629154) — colour mode, the three fonts it
 * accepted, roundness and the overrides. Its `namedColors` block is DERIVED here rather than read
 * back, because the resolved palette is only exposed through a project that has generated screens,
 * and generating 44 screens to read 10 colours is not a trade worth making. The derivation is not a
 * guess: it is the rule Stitch demonstrably applies when every colour is pinned by an override —
 * verified against the twenty themes whose payloads DID come back resolved, where namedColors is the
 * overrides plus an on-colour per surface. The one thing this cannot catch is Stitch changing that
 * rule; `wordjs verify theme` compares against this file, so a drift there would show up as every
 * theme disagreeing at once rather than silently.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BRIEFS } from "./catalogue-44-briefs.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const only = new Set(argv.filter((a) => !a.startsWith("--")));
const ROOT = path.resolve("marketplace/themes");

const hex2rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(...A.map((v, i) => v + (B[i] - v) * t)); };
const relLum = (h) => {
    const c = hex2rgb(h).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** The on-colour Stitch pairs with a surface: whichever of near-black / near-white reads better. */
const onOf = (surface) => (contrast("#ffffff", surface) >= contrast("#0b0b0b", surface) ? "#ffffff" : "#0b0b0b");

/** Stitch enum name → the CSS family name, for the fields the importer reads. */
const FAMILY = {
    BE_VIETNAM_PRO: "Be Vietnam Pro", EPILOGUE: "Epilogue", INTER: "Inter", LEXEND: "Lexend",
    MANROPE: "Manrope", NEWSREADER: "Newsreader", NOTO_SERIF: "Noto Serif",
    PLUS_JAKARTA_SANS: "Plus Jakarta Sans", PUBLIC_SANS: "Public Sans", SPACE_GROTESK: "Space Grotesk",
    SPLINE_SANS: "Spline Sans", WORK_SANS: "Work Sans", DOMINE: "Domine",
    LIBRE_CASLON_TEXT: "Libre Caslon Text", EB_GARAMOND: "EB Garamond", LITERATA: "Literata",
    SOURCE_SERIF_4: "Source Serif 4", MONTSERRAT: "Montserrat", METROPHOBIC: "Metrophobic",
    SOURCE_SANS_3: "Source Sans 3", NUNITO_SANS: "Nunito Sans", ARIMO: "Arimo",
    HANKEN_GROTESK: "Hanken Grotesk", RUBIK: "Rubik", GEIST: "Geist", DM_SANS: "DM Sans",
    IBM_PLEX_SANS: "IBM Plex Sans", SORA: "Sora",
};

function designPayload(b) {
    const bg = b.neutral;
    // Stitch's LIGHT/DARK surfaces sit on the neutral; with an explicit override it uses it verbatim.
    const surface = bg;
    const on = onOf(bg);
    return {
        name: `stitch/${b.slug}`,
        designTheme: {
            colorMode: b.mode,
            customColor: b.primary,
            overridePrimaryColor: b.primary,
            overrideSecondaryColor: b.secondary,
            overrideNeutralColor: b.neutral,
            headlineFont: b.headline,
            headlineFontFamily: FAMILY[b.headline],
            bodyFont: b.body,
            bodyFontFamily: FAMILY[b.body],
            labelFont: b.body,
            labelFontFamily: FAMILY[b.body],
            roundness: b.roundness,
            namedColors: {
                background: bg,
                surface,
                on_surface: on === "#ffffff" ? mix("#ffffff", bg, 0.04) : mix("#0b0b0b", bg, 0.04),
                on_background: on === "#ffffff" ? mix("#ffffff", bg, 0.04) : mix("#0b0b0b", bg, 0.04),
                primary: b.primary,
                primary_container: b.primary,
                on_primary: onOf(b.primary),
                secondary: b.secondary,
                secondary_container: b.secondary,
                on_secondary: onOf(b.secondary),
            },
        },
    };
}

/** Everything the old theme was; what survives is the identity, not the design. */
function wipeLegacy(dir, meta) {
    for (const entry of fs.readdirSync(dir)) {
        if (entry === "theme.json") continue;
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
    // theme.json is reduced to identity + the layout the brief asks for; the importer fills the rest.
    fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify({
        name: meta.name,
        version: meta.version,
        description: meta.description,
        author: meta.author,
        generator: "wordjs",
        layout: meta.layout,
    }, null, 2) + "\n");
    // A theme with no style.css cannot be compiled into; the compiler needs a file to own.
    fs.writeFileSync(path.join(dir, "style.css"), `/* ${meta.name} — compiled from theme.json. */\n`);
}

const targets = BRIEFS.filter((b) => !only.size || only.has(b.slug));
console.log(`${targets.length} theme(s) to rebuild${DRY ? " (dry run)" : ""}\n`);

for (const b of targets) {
    const dir = path.join(ROOT, b.slug);
    if (!fs.existsSync(dir)) { console.error(`  ✗ ${b.slug}: no such theme`); process.exitCode = 1; continue; }
    const old = JSON.parse(fs.readFileSync(path.join(dir, "theme.json"), "utf8"));
    // Keep the marketplace identity and bump the version: the public stylesheet URL is keyed by it.
    const [maj, min, pat] = String(old.version || "1.0.0").split(".").map(Number);
    const meta = {
        name: b.name,
        version: `${maj}.${min + 1}.0`,
        description: b.md,
        author: old.author || "WordJS",
        layout: b.layout,
    };
    if (DRY) { console.log(`  · ${b.slug} → ${meta.version}, ${b.families.join(" + ")}`); continue; }

    wipeLegacy(dir, meta);
    fs.mkdirSync(path.join(dir, ".design"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".design", "stitch.json"), JSON.stringify(designPayload(b), null, 2) + "\n");
    console.log(`  ✓ ${b.slug} → v${meta.version}, ${b.families.join(" + ")}`);
}

if (!DRY) {
    console.log(`\nNext: import stitch, author-block-tokens, vendor-catalog-fonts, build theme.`);
}
