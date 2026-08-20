/**
 * Render a Stitch design (Tailwind-CDN HTML) in headless Chrome and MEASURE the computed styles of each
 * semantic role. This is the fidelity source the static importer lacked: Tailwind utility classes only
 * resolve to real colors/spacing/radii/shadows when rendered, so we read them off the live layout.
 *
 * UNIVERSAL role detection: each role is found by its WordJS CONTRACT class first (guaranteed when the
 * design was authored with scripts/stitch-theme-prompt.md), then by a structural HEURISTIC fallback so an
 * arbitrary Stitch export still yields a usable measurement. Output schema matches stitch-theme-tokens.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { dumpPath } from "./stitch-dump-path.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

// Chrome/Edge executable — system browser (puppeteer-core ships no browser). Override with $CHROME_PATH.
export function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
  throw new Error("No Chrome/Edge found. Set CHROME_PATH to a Chromium-based browser executable.");
}

// role -> ordered selector list (contract class first, then heuristics). The FIRST selector that matches a
// VISIBLE element wins. Kept deliberately generous so a design that only partially follows the contract
// still measures.
const ROLE_SELECTORS = {
  pageWrap: [".wjs-public-site", "body > div", "body"],
  body: ["body"],
  nav: [".wjs-site-header", "header", "nav"],
  navLink: [".wjs-header-nav a", "header nav a", "header a:not([class*='bg-'])"],
  navCta: [".wjs-header-actions .wp-block-button", ".wjs-header-actions a", "header a[class*='bg-']", "header button"],
  h1: [".wp-block-hero-title", "h1"],
  hero: [".wp-block-hero", "main section:first-of-type", "section:has(h1)", "header + section"],
  heroBtnPrimary: [".wp-block-hero .button-variant-primary", ".wp-block-hero a[class*='bg-']", ".wp-block-hero button", "section:has(h1) a[class*='bg-']"],
  heroBtnSecondary: [".wp-block-hero .button-variant-secondary", ".wp-block-hero a:not([class*='bg-']) + a", "section:has(h1) a:nth-of-type(2)"],
  heroSubtitle: [".wp-block-hero-subtitle", ".wp-block-hero p", "section:has(h1) p"],
  card: [".wp-block-card", ".wp-block-posts-grid-item", "[class*='grid'] > div[class*='rounded']", "[class*='grid'] > div[class*='shadow']"],
  cardTitle: [".wp-block-card-title", ".wp-block-card h3", "[class*='grid'] > div h3"],
  cardDesc: [".wp-block-card-description", ".wp-block-card p", "[class*='grid'] > div p"],
  cardIcon: [".wp-block-card-icon", ".wp-block-card [class*='rounded']:first-child", "[class*='grid'] > div [class*='rounded-full']"],
  quote: [".wp-block-quote", "blockquote", ".wp-block-testimonial"],
  formInput: [".wp-block-search-input", "input[type='search']", "input[type='email']", "input[type='text']", "input"],
  formSubmit: [".wp-block-search-button", "form button", "form a[class*='bg-']"],
  footer: [".wjs-site-footer", "footer"],
  footerHeading: [".wjs-footer-menu h3", "footer h3", "footer h4"],
  footerLink: [".wjs-footer-menu a", "footer a"],
  // Section rhythm + additional Puck blocks so every editor element gets a MEASURED, designed look
  // (not just a base-token fallback). Contract/structural class first, then a heuristic.
  sectionHeading: [".wp-block-heading.heading-h2", "section h2", "h2"],
  accordionTrigger: [".wp-block-accordion-trigger", ".wp-block-accordion summary", "details summary", "[class*='accordion'] button"],
  accordionPanel: [".wp-block-accordion-panel", ".wp-block-accordion details[open] > *:last-child", "details[open] > div"],
  tab: [".wp-block-tabs-tab", "[role='tab']", "[class*='tab'] button"],
  tabPanel: [".wp-block-tabs-panel", "[role='tabpanel']"],
  tableHead: [".wp-block-table th", "table thead", "table th"],
  tableCell: [".wp-block-table td", "table td"],
  statValue: [".wp-block-stats-value", ".stat-value", "[class*='stat'] [class*='text-4xl'], [class*='stat'] [class*='text-5xl']"],
  statLabel: [".wp-block-stats-label", ".stat-label"],
  iconListItem: [".wp-block-icon-list-item", ".wp-block-icon-list li", "ul li:has(svg)"],
  iconListIcon: [".wp-block-icon-list-icon", ".wp-block-icon-list li svg", ".wp-block-icon-list li [class*='text-']"],
  // The pricing CONTAINER (grid) and a single PLAN are different elements: layout suffixes
  // (columns/gap) must come from the container, surface suffixes (bg/pad/radius) from the plan.
  pricing: [".wp-block-pricing", "[class*='pricing'][class*='grid']", "[class*='pricing']"],
  pricingPlan: [".wp-block-pricing-plan", "[class*='pricing'] > div"],
  pricingHighlighted: [".wp-block-pricing-plan.is-highlighted", "[class*='pricing'] [class*='scale-'], [class*='pricing'] [class*='ring-']"],
  pricingPrice: [".wp-block-pricing-price", ".price", "[class*='pricing'] [class*='text-4xl'], [class*='pricing'] [class*='text-5xl']"],
  testimonialCard: [".wp-block-testimonial", "[class*='testimonial']"],
  postCard: [".wp-block-posts-grid-item", "article", "[class*='blog'] article, [class*='post'] > div"],
  postTitle: [".wp-block-posts-grid-title", "article h3", "article h2"],
  ctaBanner: [".wp-block-cta-banner", "[class*='cta']"],
  badge: [".wp-block-posts-grid-meta", "[class*='badge']", "[class*='rounded-full'][class*='text-xs'], [class*='tag']"],
  // Heading scale + layout container: needed for --wjs-h1..h6 and --wjs-container-max, which drive
  // heading SIZE and content width. Without them a theme only recolors text and headings render at the
  // wordjs-ui.css default (visibly far too small next to the Stitch design).
  h2: [".wp-block-heading.heading-h2", "section h2", "h2"],
  h3: [".wp-block-card-title", "section h3", "h3"],
  container: [".wjs-header-container", ".wp-block-section", "main > section > div", "header > div"],
  pill: ["[class*='rounded-full']", ".wp-block-posts-grid-meta", "[class*='badge']"],
  stats: [".wp-block-stats", "[class*='stats']", "[class*='grid']:has([class*='text-4xl'])"],
  grid: [".wp-block-grid", "[class*='grid-cols-3']", "[class*='grid']"],
  audioPlayer: [".wp-block-audio-player", "[class*='audio']", "[class*='player']"],
  mono: ["code", "pre", "[class*='font-mono']"],
  // Audio player + video embed sub-elements (the play control, track, progress bar, title, placeholder).
  audioControl: [".wp-block-audio-player-control", ".wp-block-audio-player-icon", ".wp-block-audio-player button", "[class*='audio'] button", "[class*='player'] [class*='rounded-full']"],
  audioTrack: [".wp-block-audio-player-track", "[class*='audio'] [class*='track']", "[class*='audio'] [class*='bg-'][class*='h-1'], [class*='audio'] [class*='bg-'][class*='h-2'], [class*='audio'] [class*='rounded-full'][class*='w-full']"],
  audioProgress: [".wp-block-audio-player-progress", "[class*='audio'] [class*='progress']"],
  audioTitle: [".wp-block-audio-player-title", ".wp-block-audio-player h4", "[class*='audio'] [class*='font-semibold'], [class*='audio'] [class*='font-medium']"],
  videoFrame: [".wp-block-video-embed-frame", ".wp-block-video-embed", "[class*='video'] [class*='aspect'], [class*='aspect-video']"],
  videoPlaceholder: [".wp-block-video-embed-placeholder", ".wp-block-video-embed button", "[class*='video'] button", "[class*='video'] [class*='rounded-full']"],
};

// The computed-style properties captured per role (matches the existing stitch-measures schema).
// Every computed property the WordJS token contract can consume. The contract names tokens as
// `--wjs-<component>-<suffix>` where the suffix maps 1:1 onto one of these (color, bg, size, radius,
// weight, border-*, shadow, pad, family, tracking, transform, gap, leading, width, height, opacity,
// align, justify, columns, mb) — see scripts/stitch-theme-contract-map.mjs.
const MEASURED_PROPS = [
  "backgroundColor", "backgroundImage", "color", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "letterSpacing", "textTransform", "borderRadius", "boxShadow", "backdropFilter", "padding",
  "borderTopColor", "borderTopWidth", "borderTopStyle", "borderBottomWidth", "borderStyle",
  "gap", "gridTemplateColumns", "textAlign", "justifyContent", "opacity", "maxWidth", "minHeight",
  "marginBottom", "display", "aspectRatio", "width", "height",
];

/**
 * @param {string} htmlPathOrContent  a path to an .html file, or raw HTML (auto-detected).
 * @param {{chromePath?:string, viewport?:{width:number,height:number}, settleMs?:number}} [opts]
 * @returns {Promise<Record<string, Record<string,string>>>} role -> {prop: computedValue}, plus __meta.
 */
export async function measureDesign(htmlPathOrContent, opts = {}) {
  const isPath = !/\n/.test(htmlPathOrContent) && /\.html?$/i.test(htmlPathOrContent) && fs.existsSync(htmlPathOrContent);
  const chromePath = opts.chromePath || resolveChromePath();
  const viewport = opts.viewport || { width: 1440, height: 900 };
  const settleMs = opts.settleMs ?? 1200;

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    if (isPath) {
      await page.goto("file://" + path.resolve(htmlPathOrContent).replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
    } else {
      await page.setContent(htmlPathOrContent, { waitUntil: "networkidle0", timeout: 45000 });
    }
    // Tailwind's CDN build applies its utilities via a JIT scan AFTER load; give it a beat to settle so
    // getComputedStyle reads the resolved values rather than the pre-JIT defaults.
    await new Promise((r) => setTimeout(r, settleMs));

    const measures = await page.evaluate((roleSelectors, props) => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
      };
      const firstVisible = (selectors) => {
        for (const sel of selectors) {
          let nodes = [];
          try { nodes = Array.from(document.querySelectorAll(sel)); } catch { continue; }
          const el = nodes.find(visible);
          if (el) return el;
        }
        return null;
      };
      const measure = (el) => { const cs = getComputedStyle(el); const rec = {}; for (const p of props) rec[p] = cs[p]; return rec; };
      const out = {};
      for (const [role, selectors] of Object.entries(roleSelectors)) {
        const el = firstVisible(selectors);
        out[role] = el ? measure(el) : {};
      }

      // SMART BUTTON / PRIMARY detection (universal fallback): raw Stitch designs rarely carry the
      // .button-variant-* contract classes, so the selector pass above misses the CTA — and the primary
      // BRAND color is the single most important token. Score every visible link/button by how "solid and
      // saturated" its painted background is, preferring ones inside the hero, and fill the button roles.
      const parseRgb = (v) => { const m = String(v).match(/rgba?\(([^)]+)\)/i); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
      const saturation = (c) => { const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return mx === 0 ? 0 : (mx - mn) / mx; };
      const isNearWhite = (c) => c.r > 235 && c.g > 235 && c.b > 235;
      const heroEl = firstVisible(roleSelectors.hero) || document.body;
      const scoreBtn = (el) => {
        const cs = getComputedStyle(el);
        const bg = parseRgb(cs.backgroundColor);
        if (!bg || bg.a < 0.6 || isNearWhite(bg)) return -1;                 // must have a solid, non-white fill
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 24) return -1;
        const inHero = heroEl && heroEl.contains(el);
        const darkness = 1 - (bg.r + bg.g + bg.b) / 765;                     // brand CTAs tend to be bold/dark
        return saturation(bg) * 2 + darkness + (inHero ? 1.5 : 0) - rect.top / 4000;
      };
      const btnCandidates = Array.from(document.querySelectorAll("a, button, [role='button']"))
        .filter(visible)
        .map((el) => ({ el, score: scoreBtn(el) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (!out.heroBtnPrimary || !out.heroBtnPrimary.backgroundColor || out.heroBtnPrimary.backgroundColor === "rgba(0, 0, 0, 0)") {
        if (btnCandidates[0]) out.heroBtnPrimary = measure(btnCandidates[0].el);
      }
      if (!out.navCta || !out.navCta.backgroundColor || out.navCta.backgroundColor === "rgba(0, 0, 0, 0)") {
        const navEl = firstVisible(roleSelectors.nav);
        const navBtn = btnCandidates.find((x) => navEl && navEl.contains(x.el));
        if (navBtn) out.navCta = measure(navBtn.el);
      }
      // Secondary CTA: a prominent hero button that is NOT the primary (glass/outline style).
      if (!out.heroBtnSecondary || !out.heroBtnSecondary.borderRadius) {
        const heroBtns = Array.from(heroEl.querySelectorAll("a, button")).filter(visible);
        const secondary = heroBtns.find((el) => el !== btnCandidates[0]?.el && (() => { const r = el.getBoundingClientRect(); return r.width >= 40 && r.height >= 24; })());
        if (secondary) out.heroBtnSecondary = measure(secondary);
      }

      out.__meta = { title: document.title || "", width: window.innerWidth, buttonCandidates: btnCandidates.length };
      return out;
    }, ROLE_SELECTORS, MEASURED_PROPS);

    return measures;
  } finally {
    await browser.close();
  }
}

// CLI: node scripts/stitch-measure.mjs <design.html> [--out measures.json]
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const file = process.argv[2];
  const outIdx = process.argv.indexOf("--out");
  if (!file) { console.error("usage: node scripts/stitch-measure.mjs <design.html> [--out measures.json]"); process.exit(1); }
  measureDesign(file)
    .then((m) => {
      const json = JSON.stringify(m, null, 2);
      // `--out probe.json` used to land in the repo root under whatever name was typed, which is how
      // page172.json / put208.json / mirror2.json were born untracked-but-uncovered. dumpPath() re-homes
      // it into the ignored /.debug-dumps/, and we write the path it RETURNS, not the raw argument.
      if (outIdx >= 0 && process.argv[outIdx + 1]) { const out = dumpPath(process.argv[outIdx + 1]); fs.writeFileSync(out, json); console.error("wrote " + out); }
      else process.stdout.write(json + "\n");
    })
    .catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
