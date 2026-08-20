/**
 * Measured fidelity diff: Stitch design vs the live WordJS page rendered with the generated theme.
 *
 * Renders BOTH, measures the SAME semantic roles on each, and reports every property that differs —
 * together with the contract token that controls it (or MISSING when no token exists, which is the
 * signal that the contract needs a new one). This replaces eyeballing with evidence.
 *
 *   node scripts/stitch-fidelity-diff.mjs <design.html> <wordjs-url>
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { measureDesign, resolveChromePath } from "./stitch-measure.mjs";
import { readContractTokens } from "./stitch-theme-contract-map.mjs";
import { dumpPath, REPO_ROOT } from "./stitch-dump-path.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

// Properties worth comparing (visual, not layout-position dependent).
const COMPARE = ["backgroundColor", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "letterSpacing", "textTransform", "borderRadius", "boxShadow", "padding", "borderTopWidth", "gap"];

// Roles that exist on a WordJS page via contract classes.
const WJS_ROLE_SELECTORS = {
  nav: [".wjs-site-header"], navLink: [".wjs-header-nav a"], navCta: [".wjs-header-actions .wp-block-button, .wjs-header-action"],
  h1: [".wp-block-hero-title", ".wp-block-heading.heading-h1", "h1"],
  h2: [".wp-block-heading.heading-h2", "h2"],
  hero: [".wp-block-hero"], heroSubtitle: [".wp-block-hero-subtitle"],
  heroBtnPrimary: [".wp-block-hero .wp-block-button__link, .wp-block-button__link"],
  card: [".wp-block-card"], cardTitle: [".wp-block-card-title"], cardDesc: [".wp-block-card-description"],
  cardIcon: [".wp-block-card-icon"],
  pricingPlan: [".wp-block-pricing-plan"], pricingPrice: [".wp-block-pricing-price"],
  statValue: [".wp-block-stats-value"], statLabel: [".wp-block-stats-label"],
  tableHead: [".wp-block-table th, .wp-block-table-head"], tableCell: [".wp-block-table td, .wp-block-table-cell"],
  accordionTrigger: [".wp-block-accordion-trigger"], tab: [".wp-block-tabs-tab"],
  audioPlayer: [".wp-block-audio-player"], audioControl: [".wp-block-audio-player-icon, .wp-block-audio-player-control"],
  videoFrame: [".wp-block-video-embed"], testimonialCard: [".wp-block-testimonial"],
  postCard: [".wp-block-posts-grid-item"], postTitle: [".wp-block-posts-grid-title"],
  ctaBanner: [".wp-block-cta-banner"], footer: [".wjs-site-footer"], footerLink: [".wjs-footer-menu a"],
  iconListIcon: [".wp-block-icon-list-icon"], formInput: [".wp-block-search-input"],
  body: [".wjs-public-site"],
};

async function measureUrl(url, roleSelectors) {
  const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: "new", args: ["--no-sandbox", "--hide-scrollbars"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
    return await page.evaluate((sel, props) => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const c = getComputedStyle(el); return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden"; };
      const out = {};
      for (const [role, list] of Object.entries(sel)) {
        let el = null;
        for (const s of list) { let n = []; try { n = Array.from(document.querySelectorAll(s)); } catch { continue; } el = n.find(vis); if (el) break; }
        if (!el) { out[role] = null; continue; }
        const c = getComputedStyle(el); const rec = {};
        for (const p of props) rec[p] = c[p];
        out[role] = rec;
      }
      return out;
    }, roleSelectors, COMPARE);
  } finally { await browser.close(); }
}

// suffix used by the contract for a given CSS property
const PROP_SUFFIX = { backgroundColor: "bg", color: "color", fontFamily: "family", fontSize: "size",
  fontWeight: "weight", lineHeight: "leading", letterSpacing: "tracking", textTransform: "transform",
  borderRadius: "radius", boxShadow: "shadow", padding: "pad", borderTopWidth: "border-width", gap: "gap" };
// role -> contract component name
const ROLE_COMPONENT = { nav: "header", navLink: "nav-link", navCta: "button", h1: "hero-title", h2: "heading",
  hero: "hero", heroSubtitle: "hero-subtitle", heroBtnPrimary: "button", card: "card", cardTitle: "card-title",
  cardDesc: "card-desc", cardIcon: "card-icon", pricingPlan: "pricing-plan", pricingPrice: "pricing-price",
  statValue: "stats-value", statLabel: "stats-label", tableHead: "table-head", tableCell: "table-cell",
  accordionTrigger: "accordion-trigger", tab: "tabs-tab", audioPlayer: "audio", audioControl: "audio-icon",
  videoFrame: "video", testimonialCard: "testimonial", postCard: "posts-item", postTitle: "posts-title",
  ctaBanner: "cta", footer: "footer", footerLink: "footer-link", iconListIcon: "icon", formInput: "search-input" };

const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const NEUTRAL = new Set(["", "none", "normal", "auto", "rgba(0, 0, 0, 0)", "0px"]);

const [designPath, wjsUrl] = process.argv.slice(2);
if (!designPath || !wjsUrl) { console.error("usage: node scripts/stitch-fidelity-diff.mjs <design.html> <wordjs-url>"); process.exit(1); }

const stitch = await measureDesign(path.resolve(designPath));
const wjs = await measureUrl(wjsUrl, WJS_ROLE_SELECTORS);
const contract = new Set(readContractTokens(path.resolve("backend/public/css/wordjs-ui.css")));

const rows = [];
for (const [role, comp] of Object.entries(ROLE_COMPONENT)) {
  const s = stitch[role], w = wjs[role];
  if (!s || !w) { rows.push({ role, prop: "(role)", stitch: s ? "ok" : "AUSENTE-en-diseño", wjs: w ? "ok" : "AUSENTE-en-wordjs", token: "-", status: "SKIP" }); continue; }
  for (const prop of COMPARE) {
    const sv = norm(s[prop]), wv = norm(w[prop]);
    if (sv === wv) continue;
    if (NEUTRAL.has(sv) && NEUTRAL.has(wv)) continue;
    if (NEUTRAL.has(sv)) continue; // design has nothing to impose
    const token = `--wjs-${comp}-${PROP_SUFFIX[prop]}`;
    rows.push({ role, prop, stitch: sv.slice(0, 34), wjs: wv.slice(0, 34), token, status: contract.has(token) ? "TOKEN-OK" : "TOKEN-FALTA" });
  }
}

const diffs = rows.filter((r) => r.status !== "SKIP");
const missing = diffs.filter((r) => r.status === "TOKEN-FALTA");
console.log(`\nDIFERENCIAS: ${diffs.length}  ·  sin token en el contrato: ${missing.length}\n`);
console.log("ROL".padEnd(17) + "PROP".padEnd(16) + "STITCH".padEnd(36) + "WORDJS".padEnd(36) + "TOKEN");
for (const r of diffs.slice(0, 60)) console.log(r.role.padEnd(17) + r.prop.padEnd(16) + r.stitch.padEnd(36) + r.wjs.padEnd(36) + (r.status === "TOKEN-FALTA" ? "FALTA " : "") + r.token);
const skipped = rows.filter((r) => r.status === "SKIP");
if (skipped.length) { console.log("\nROLES NO COMPARABLES:"); for (const r of skipped) console.log("  " + r.role.padEnd(18) + "diseño=" + r.stitch + " · wordjs=" + r.wjs); }
// Into the ignored dump directory — writing the SAME path we resolved, never the bare name.
const diffOut = dumpPath("fidelity-diff.json");
fs.writeFileSync(diffOut, JSON.stringify({ diffs, skipped }, null, 1));
console.log("\n-> " + path.relative(REPO_ROOT, diffOut));
