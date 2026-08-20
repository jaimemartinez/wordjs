/**
 * Derive, per Puck block, everything the Stitch pipeline needs — with NO hardcoded block list.
 *
 * Single source of truth = the contract itself:
 *   • PUCK_SELECTORS / CHROME_SELECTORS  → which blocks exist (their root class)
 *   • STRUCTURAL_SELECTORS               → each block's sub-elements (grouped by root prefix)
 *   • wordjs-ui.css `var(--wjs-…)`       → which tokens that block can be styled with
 *
 * From those it builds the HTML skeleton, the measurement selectors and the Stitch prompt for every
 * block. Add a new Puck block (root class + structural parts + its --wjs-<block>-* tokens) and it is
 * picked up automatically: a screen gets generated, measured and its tokens filled, with no edit here.
 *
 *   node scripts/stitch-block-skeletons.mjs            # coverage report
 *   node scripts/stitch-block-skeletons.mjs --block card --prompt
 */

import fs from "node:fs";
import path from "node:path";
import { PUCK_SELECTORS, CHROME_SELECTORS, STRUCTURAL_SELECTORS } from "./wordjs-theme-contract.mjs";

const UI_CSS = path.resolve("backend/public/css/wordjs-ui.css");

/** Tokens the contract reads, indexed by the component prefix they belong to. */
function tokensByComponent(uiCssPath = UI_CSS) {
  const css = fs.readFileSync(uiCssPath, "utf8");
  const all = [...new Set([...css.matchAll(/var\(\s*(--wjs-[a-z0-9-]+)/g)].map((m) => m[1]))];
  return { all, css };
}

/** Text a skeleton uses for a given part, so the design has something real to lay out. */
function sampleFor(part) {
  if (/title|name|heading/.test(part)) return "Section title";
  if (/desc|excerpt|subtitle|text|panel|quote/.test(part)) return "Supporting copy that explains the value in one or two lines.";
  if (/price/.test(part)) return "$29";
  if (/period/.test(part)) return "/mo";
  if (/value/.test(part)) return "99.9%";
  if (/label|meta|cite|role/.test(part)) return "Label";
  if (/icon|mark/.test(part)) return "★";
  if (/action|button|trigger|tab|link/.test(part)) return "Action";
  if (/input/.test(part)) return "";
  return "Content";
}

/** The HTML tag a part should render as, so Stitch styles semantic markup. */
function tagFor(part) {
  if (/title|name|heading/.test(part)) return "h3";
  if (/desc|excerpt|subtitle|text|quote|panel/.test(part)) return "p";
  if (/action|button|trigger|tab/.test(part)) return "button";
  if (/input/.test(part)) return "input";
  if (/item|plan|row|col/.test(part)) return "div";
  if (/list|features|nav/.test(part)) return "ul";
  return "div";
}

/**
 * Modifier classes the contract applies to a block root (`.wp-block-card.card-theme-accent`,
 * `.wp-block-button__link.button-variant-outline`). The variant KEY is what remains after the block name
 * and the connector word the contract uses (`theme-`, `variant-`, `style-`, `is-`) — which is exactly how
 * its tokens are named (`--wjs-card-accent-bg`). Derived from the CSS, so a variant added later is picked
 * up with no edit here.
 * @returns {Array<{key:string, cls:string}>}
 */
function variantsFor(css, root, block) {
  const re = new RegExp(`\\.${root}(?:__[a-z]+)?\\.([a-z0-9-]+)`, "g");
  const seen = new Map();
  for (const m of css.matchAll(re)) {
    const cls = m[1];
    const key = cls.replace(new RegExp(`^${block}-`), "").replace(/^(theme|variant|style|is)-/, "");
    // Only real modifiers: a class that is another block's root, or a state, is not a variant.
    if (key && key !== cls && !/^(hover|focus|active|dark)$/.test(key)) seen.set(key, cls);
  }
  return [...seen].map(([key, cls]) => ({ key, cls }));
}

/**
 * @returns {Array<{block:string, root:string, parts:string[], variants:Array, tokens:string[], html:string}>}
 */
export function deriveBlocks(uiCssPath = UI_CSS) {
  const { all: contractTokens, css } = tokensByComponent(uiCssPath);
  const roots = [...PUCK_SELECTORS, ...CHROME_SELECTORS];
  const out = [];
  for (const rootSel of roots) {
    const root = rootSel.slice(1);                       // .wp-block-card -> wp-block-card
    const block = root.replace(/^wp-block-|^wjs-/, "");  // -> card
    // Sub-elements are the structural selectors that extend this root (longest-root wins so
    // `.wp-block-card-icon` attaches to `card`, not to a shorter block that happens to prefix-match).
    const parts = STRUCTURAL_SELECTORS
      .map((s) => s.slice(1))
      .filter((s) => s.startsWith(root + "-"))
      .filter((s) => !roots.some((r) => r.slice(1) !== root && s.startsWith(r.slice(1) + "-") && r.slice(1).length > root.length));
    // The contract often shortens a compound block name for its token prefix (`audio-player` →
    // `--wjs-audio-*`, `cta-banner` → `--wjs-cta-*`, `posts-grid` → `--wjs-posts-*`). Try the full name
    // first, then progressively shorter prefixes, so a block is never wrongly reported as un-themeable —
    // and a future compound block resolves without adding an alias by hand.
    // Try dropping trailing segments (`audio-player` → `audio`) AND leading ones (`site-header` →
    // `header`), covering both shortening conventions the contract uses.
    const seg = block.split("-");
    const candidates = [
      ...seg.map((_, i) => seg.slice(0, seg.length - i).join("-")),
      ...seg.map((_, i) => seg.slice(i).join("-")),
    ].filter(Boolean);
    let tokenPrefix = block, tokens = [];
    for (const cand of candidates) {
      const hit = contractTokens.filter((t) => t.startsWith(`--wjs-${cand}-`) || t === `--wjs-${cand}`);
      if (hit.length) { tokenPrefix = cand; tokens = hit; break; }
    }
    const inner = parts.length
      ? parts.map((p) => {
          const label = p.slice(root.length + 1);
          const tag = tagFor(label);
          return tag === "input"
            ? `  <input class="${p}" placeholder="${sampleFor(label) || "Search…"}" />`
            : `  <${tag} class="${p}">${sampleFor(label)}</${tag}>`;
        }).join("\n")
      : `  <p>Content</p>`;
    // Render the base plus one instance per variant, so a single screen also yields the variants' tokens
    // (`--wjs-button-outline-*`) measured from a real element instead of being left unthemed.
    const variants = variantsFor(css, root, block).filter((v) =>
      contractTokens.some((t) => t.startsWith(`--wjs-${tokenPrefix}-${v.key}-`)));
    const base = `<div class="${root}">\n${inner}\n</div>`;
    const html = [base, ...variants.map((v) => `<div class="${root} ${v.cls}">\n${inner}\n</div>`)].join("\n");
    out.push({ block, root, parts, variants, tokens, tokenPrefix, html });
  }
  return out;
}

/** The per-block Stitch prompt: style THIS markup, change nothing structural. */
export function promptFor(entry, designBrief = "") {
  return [
    `Design a single, polished presentation of ONE component for a website design system.${designBrief ? " " + designBrief : ""}`,
    ``,
    `Style EXACTLY this markup with Tailwind utility classes. Do NOT add, remove, rename or re-nest any`,
    `element, and keep every class name exactly as written — they are the contract this design maps onto.`,
    `You may only ADD Tailwind classes alongside the existing ones, and fill in the text content.`,
    ``,
    entry.html,
    ``,
    `Center it on a plain background with generous padding so the component is clearly visible. Load any`,
    `Google Font you use via a <link> in <head> and keep the Tailwind CDN script. Output one complete,`,
    `self-contained HTML file.`,
  ].join("\n");
}

// CLI
const isMain = (() => {
  // Windows drive letters make a naive `file://${argv[1]}` comparison fail — resolve both sides instead.
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); }
  catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const blocks = deriveBlocks();
  const want = args.includes("--block") ? args[args.indexOf("--block") + 1] : null;
  if (want) {
    const e = blocks.find((b) => b.block === want);
    if (!e) { console.error(`Unknown block '${want}'. Known: ${blocks.map((b) => b.block).join(", ")}`); process.exit(1); }
    console.log(args.includes("--prompt") ? promptFor(e) : e.html);
  } else {
    console.log(`Bloques derivados del contrato: ${blocks.length}\n`);
    console.log("BLOQUE".padEnd(20) + "PARTES".padStart(7) + "TOKENS".padStart(8) + "   sub-elementos");
    for (const b of blocks.sort((x, y) => y.tokens.length - x.tokens.length)) {
      console.log(b.block.padEnd(20) + String(b.parts.length).padStart(7) + String(b.tokens.length).padStart(8) +
        "   " + b.parts.map((p) => p.slice(b.root.length + 1)).slice(0, 4).join(", "));
    }
    const noTokens = blocks.filter((b) => !b.tokens.length).map((b) => b.block);
    if (noTokens.length) console.log(`\n⚠ sin tokens en el contrato (no se pueden tematizar aún): ${noTokens.join(", ")}`);
  }
}
