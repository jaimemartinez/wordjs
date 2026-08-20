/**
 * Per-block Stitch pipeline: the contract's blocks designed as component sheets, measured EXACTLY.
 *
 * Why this exists: a whole-page Stitch design has to be reverse-engineered — we guess which element is
 * "the card", which button is "primary", and Stitch is free to omit components entirely (carbon-terminal
 * shipped zero of the requested ones). Here we hand Stitch OUR markup, one block at a time, and it may
 * only add Tailwind classes. Measurement stops being a heuristic: every token's element and property come
 * verbatim from the contract CSS (scripts/stitch-contract-dom.mjs), so nothing is inferred.
 *
 * Nothing about the block list is hardcoded. Add a Puck block with its `.wp-block-x` rules and `--wjs-x-*`
 * tokens and it gains a screen, a measurement and its tokens automatically.
 *
 * A screen is one Stitch generation — the slow part — so blocks are packed into as few as the markup
 * budget allows (see SCREEN_HTML_BUDGET). Measured on the same 675-token contract:
 *
 *     presupuesto   pantallas   fidelidad de la hoja más densa   tokens de esa hoja
 *     2600B (def.)      8       26/26 clases, 0 inventadas       64/102
 *     5000B             4       36/36 clases, 0 inventadas      173/261
 *
 *   node scripts/stitch-block-pipeline.mjs plan apex-enterprise --brief "…"   # writes prompts
 *   node scripts/stitch-block-pipeline.mjs plan apex-enterprise --budget 5000 # fewer, denser sheets
 *   node scripts/stitch-block-pipeline.mjs plan apex-enterprise --per-block   # one screen per block
 *   node scripts/stitch-block-pipeline.mjs assemble apex-enterprise           # measure downloaded screens
 *   node scripts/stitch-block-pipeline.mjs merge apex-enterprise              # into the theme's style.css
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { deriveContractBlocks } from "./stitch-contract-dom.mjs";
import { buildBemBridge } from "./stitch-theme-contract-map.mjs";
import { resolveChromePath } from "./stitch-measure.mjs";
import { readDeclared } from "./stitch-cascade-read.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const UI_CSS = path.resolve("backend/public/css/wordjs-ui.css");
const CACHE = path.resolve(".stitch-cache/blocks");
// The catalogue lives in marketplace/themes and the installed themes in backend/themes; the same
// pipeline has to be able to write either, so it honours the env var the CLI already uses.
const THEMES_ROOT = process.env.WORDJS_THEMES_DIR || "backend/themes";
const themeDir = (slug) => path.resolve(THEMES_ROOT, slug);
const workDir = (slug) => path.join(CACHE, slug);

/**
 * How much markup one generation may carry. A screen is one Stitch call — the slow, rate-limited part of
 * the run — so what matters is not "one block per screen" but how much markup Stitch still styles
 * faithfully in a single pass. Measured: the `misc` screen has always carried ~2.6KB (41 block roots) and
 * came back with the markup intact, so that size is the proven ceiling, not a guess. The whole contract is
 * only ~14KB, which is why bundling collapses 25 calls into a handful.
 *
 * Bundling also makes the DESIGN better, not just the run shorter: 25 independent generations invent 25
 * unrelated type scales and paddings that we then average into one theme. A sheet of components designed
 * together shares one system by construction.
 */
const SCREEN_HTML_BUDGET = 2600;

/** Sentinel so re-merging replaces the bridge instead of stacking copies of it. */
const BRIDGE_MARK = "/* ==== wordjs contract bem bridge ==== */";

/** `.wp-block-card__title` -> `.wp-block-card-title`: the selector this install's DOM actually has. */
const bridgeSelector = (sel) => sel.replace(/(wp-block-[a-z0-9-]+)__([a-z0-9-]+)/g, "$1-$2");

/**
 * The bridged rules must outrank two things the shipped components do to the same element:
 *   1. stacked utility classes (a card title also carries `.wp-block-heading.heading-h3`) — beaten by
 *      scoping under a doubled site class;
 *   2. INLINE styles (`style="font-size: var(--wjs-h3-size, …)"` emitted by the block components) — which
 *      no selector can outrank, so the bridge declarations carry `!important`.
 *
 * (2) is a compatibility layer, not the real fix: the components should defer to the contract token
 * instead of hardcoding an inline type scale. Until they do, the theme cannot reach the element at all.
 */
function raiseSpecificity(css, scope = ".wjs-public-site.wjs-public-site") {
  css = css.replace(/\{([^{}]*)\}/g, (whole, body) => {
    if (!body.trim()) return whole;
    const forced = body.split(";").map((d) => {
      const t = d.trim();
      if (!t || t.includes("!important") || t.startsWith("--")) return d;
      return `${d} !important`;
    }).join(";");
    return `{${forced}}`;
  });
  return css.replace(/(^|\}|\*\/)(\s*)([^{}@]+?)(\s*)\{/g, (whole, before, ws, selector, ws2) => {
    if (!selector.trim() || selector.includes("{")) return whole;
    const scoped = selector.split(",").map((s) => {
      const t = s.trim();
      return t.startsWith(scope) ? t : `${scope} ${t}`;
    }).join(", ");
    return `${before}${ws}${scoped}${ws2}{`;
  });
}

/* ------------------------------------------------------------------ plan */

/**
 * Group the contract's blocks into the screens we will ask Stitch for.
 * @param {string} cssPath
 * @param {{budget?:number, perBlock?:boolean}} [opts] `budget` = max markup bytes per screen;
 *        `perBlock` restores one generation per block (slowest, and each block designed in isolation).
 */
export function planScreens(cssPath = UI_CSS, opts = {}) {
  const budget = opts.perBlock ? 0 : (opts.budget || SCREEN_HTML_BUDGET);
  const all = deriveContractBlocks(cssPath);
  // A token several blocks consume is a GLOBAL scale/palette value (`--wjs-md`, `--wjs-border-subtle`),
  // not a property of any one component. Measuring it per block just lets the last screen win with a
  // value the other blocks never agreed to; those belong to the whole-page palette pass.
  const uses = new Map();
  for (const b of all) for (const t of b.targets) uses.set(t.token, (uses.get(t.token) || 0) + 1);
  // A shared token (`--wjs-text-size`, `--wjs-heading-leading`) must not be measured once per consumer —
  // the last screen would win with a value the others never agreed to — but dropping it entirely left the
  // global type scale unmeasured and the theme fell back to framework defaults. Assign each shared token
  // to exactly ONE owner: the first block that consumes it, in a stable order.
  const owned = new Set();
  const blocks = all.map((b) => ({
    ...b,
    targets: b.targets.filter((t) => {
      if (uses.get(t.token) === 1) return true;
      if (owned.has(t.token)) return false;
      owned.add(t.token);
      return true;
    }),
  })).filter((b) => b.targets.length);
  const one = blocks.map((b) => ({
    name: b.root.replace(/^wp-block-|^wjs-/, ""),
    blocks: [b.root], html: b.html, targets: b.targets,
  }));
  return budget ? packScreens(one, budget) : one;
}

/**
 * Fold one-block screens into as few generations as the budget allows. Kept separate from `planScreens`
 * because with `--from-dom` the real markup is only known AFTER extraction, and packing on skeleton sizes
 * would then overshoot the budget by whatever the real subtrees weigh.
 */
export function packScreens(screens, budget = SCREEN_HTML_BUDGET) {
  // Site chrome (header, footer, containers) dominates perception and its pieces belong together on ONE
  // screen, so Stitch designs them as a coherent frame instead of scattered fragments. Membership comes
  // from the registry, not from a hardcoded list.
  const isChrome = (s) => s.blocks.every((r) => /^wjs-/.test(r) && /header|footer|site/.test(r));
  const chrome = screens.filter(isChrome);
  const body = screens.filter((s) => !isChrome(s));

  // Pack in contract order: neighbouring blocks are the related ones, so a screen stays a coherent family
  // rather than a grab-bag. A block larger than the budget gets its own screen instead of being split —
  // splitting a block across generations would design its parts against different systems.
  const packed = [];
  for (const s of body) {
    const last = packed[packed.length - 1];
    if (last && last.bytes + s.html.length <= budget) { last.members.push(s); last.bytes += s.html.length; }
    else packed.push({ members: [s], bytes: s.html.length });
  }
  const join = (members, fallback) => members.length === 1 ? members[0] : {
    // Named after what it carries, so prompts/<name>.txt stays legible when a screen holds six blocks.
    name: fallback,
    blocks: members.flatMap((m) => m.blocks),
    html: members.map((m) => m.html).join("\n"),
    targets: members.flatMap((m) => m.targets),
  };
  const out = packed.map((p, i) => join(p.members, `sheet-${i + 1}`));
  if (chrome.length) out.push(join(chrome, "site-chrome"));
  return out;
}

/**
 * Screen 0: the INTENT screen — the brief alone, with no markup of ours.
 *
 * Two things make this mandatory rather than optional, both measured (2026-08-06):
 *   1. The FIRST generation in an empty project does not style markup, it invents a design SYSTEM: the
 *      same prompt that keeps 36/36 contract classes in an established project kept 2/16 in a fresh one,
 *      rewriting our elements into Stitch's own vocabulary (`bg-primary-container`, `border-outline-variant`).
 *      Spending that first generation on a screen with no markup to lose costs one call and makes every
 *      sheet after it faithful.
 *   2. That same event is the ONLY one that leaves `get_project` holding a RESOLVED `designTheme` —
 *      namedColors, the typography scale in px, spacing, roundness and a written designMd. Which is
 *      exactly the half of the contract a component sheet cannot supply: the global palette and scale.
 *
 * So the two halves come from two grounded sources that do not overlap: the system from here, the
 * per-component values from the sheets.
 */
function intentPrompt(brief) {
  return [
    `Design ONE page: the style guide of a website design system.${brief ? " " + brief : ""}`,
    ``,
    `Show the palette, the type scale from display down to caption, the spacing rhythm, the corner radius`,
    `and the core components (buttons, inputs, cards, links) as a designer would present a new system.`,
    `Decide the system: pick the fonts, the exact colours and the scale, and be consistent about them.`,
    ``,
    `Lay it out at 1440px wide. Load any Google Font you use via a <link> in <head> and keep the Tailwind`,
    `CDN script. Output one complete, self-contained HTML file.`,
  ].join("\n");
}

function promptFor(screen, brief) {
  if (screen.intent) return intentPrompt(brief);
  const many = screen.blocks.length > 1;
  return [
    many
      ? `Design ONE page of a design system's component sheet: ${screen.blocks.length} components that belong to`
        + ` the SAME system, shown one under another.${brief ? " " + brief : ""}`
      : `Design ONE polished UI component for a website design system.${brief ? " " + brief : ""}`,
    ``,
    `Style EXACTLY this markup with Tailwind utility classes. Do NOT add, remove, rename or re-nest any`,
    `element, and keep every existing class name exactly as written — they are the contract this design`,
    `maps onto. You may only ADD Tailwind classes alongside them and fill in the text content.`,
    ``,
    screen.html,
    ``,
    `Where the markup repeats an element, those repeats are siblings or variants of ONE component: give them`,
    `identical geometry (same padding, radius, type scale) and let them differ only in fill and ink.`,
    ...(many ? [
      ``,
      // The whole reason to bundle: components designed together share a system by construction, whereas
      // one generation per component invents a different type scale and rhythm each time.
      `Every component on this sheet must share ONE type scale, ONE spacing rhythm, ONE corner radius and`,
      `ONE palette — they are the same product, not separate exercises. Style ALL of them; none may be`,
      `left unstyled or dropped.`,
    ] : []),
    ``,
    `Lay ${many ? "them" : "it"} out on a plain background with generous padding so every element is clearly`,
    `visible at 1440px wide. Load any Google Font you use via a <link> in <head> and keep the Tailwind CDN`,
    `script. Output one complete, self-contained HTML file.`,
  ].join("\n");
}

/**
 * Replace each screen's derived skeleton with the block's REAL rendered subtree, taken from a live page
 * that shows every block. CSS-derived skeletons get classes and tokens right but can only guess nesting
 * (an accordion's icon belongs inside its trigger; the contract never says so). The render is the
 * authority on markup exactly as the contract is on tokens — and it auto-extends: a new block on the
 * page brings its real structure with it. Variant instances are cloned off the base with the modifier
 * class when the page does not already show one.
 */
async function skeletonsFromDom(screens, url) {
  const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: "new", args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
    for (const s of screens) {
      const roots = s.blocks;
      const html = await page.evaluate((rootClasses, variantsWanted) => {
        const SAMPLE = { title: "Section title", price: "$29", period: "/month", value: "99.9%", icon: "★", action: "Get started", desc: "Supporting copy that explains the value in one or two short lines." };
        const clean = (el, depth) => {
          if (depth > 7) return null;
          const keep = [...el.classList].filter((c) => /^(wp-block-|wjs-|is-|card-theme-|cta-variant-|button-variant-|layout-|divider-type-|heading-h)/.test(c));
          const tag = el.tagName.toLowerCase();
          if (["script", "style", "svg", "iframe"].includes(tag)) return null;
          let children = [...el.children];
          // Identity = the CONTRACT classes only; state words like the bare `highlighted` the component
          // adds alongside `is-highlighted` must not make siblings look structurally different.
          const sig = (e) => [...e.classList].filter((c) => /^(wp-block-|wjs-)/.test(c)).sort().join("|");
          if (children.length > 3 && new Set(children.map(sig)).size === 1) {
            // The page's authored collection (4 plans, 2 highlighted) is content, not design: normalize to
            // base + ONE variant instance + base so the design shows each look exactly once.
            const variant = children.find((e) => [...e.classList].some((c) => /^is-/.test(c)));
            const bases = children.filter((e) => e !== variant);
            children = variant ? [bases[0], variant, bases[1] || bases[0]] : children.slice(0, 3);
          }
          // TRUE DOM ORDER: the component renders <i> first, then the label; prepending text flipped the
          // sides under justify-between (check ended left in the design, right on the page). Interleave
          // text and element children exactly as the DOM has them.
          const parts = [];
          for (const n of el.childNodes) {
            if (n.nodeType === 3) { const t2 = n.textContent.trim(); if (t2) parts.push({ text: t2 }); }
            else if (n.nodeType === 1 && children.includes(n)) { const c2 = clean(n, depth + 1); if (c2) parts.push({ el: c2 }); }
          }
          const kids = parts.filter((x) => x.el).map((x) => x.el);
          const ordered = parts;
          // Mixed content is real structure: the price div holds "$29" AND the period span. Dropping the
          // text made Stitch style an empty box.
          const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
          const pad = "  ".repeat(depth);
          const attr = keep.length ? ` class="${keep.join(" ")}"` : "";
          if (tag === "img") return `${pad}<img${attr} src="https://placehold.co/600x400" alt="" />`;
          if (tag === "input") return `${pad}<input${attr} placeholder="Your email" />`;
          if (!kids.length) {
            const cls = keep.join(" ");
            const text = /title|name|heading/.test(cls) ? SAMPLE.title : /price/.test(cls) ? SAMPLE.price
              : /period/.test(cls) ? SAMPLE.period : /value|metric/.test(cls) ? SAMPLE.value
              : /icon|mark/.test(cls) ? SAMPLE.icon : /button|action|trigger|tab/.test(cls) ? SAMPLE.action
              : /desc|excerpt|text|panel|quote|subtitle/.test(cls) ? SAMPLE.desc
              : (el.textContent || "").trim() ? "Content" : "";
            return `${pad}<${tag}${attr}>${text}</${tag}>`;
          }
          return `${pad}<${tag}${attr}>\n${ownText ? pad + "  " + ownText + "\n" : ""}${kids.join("\n")}\n${pad}</${tag}>`;
        };
        const out = [];
        for (const root of rootClasses) {
          const el = document.querySelector(`.${root}`);
          if (!el) continue;
          const base = clean(el, 0);
          if (!base) continue;
          out.push(base);
          for (const mod of variantsWanted[root] || []) {
            if (base.includes(` ${mod}`) || document.querySelector(`.${root}.${mod}`)) {
              const ve = document.querySelector(`.${root}.${mod}`);
              if (ve && ve !== el) { const v = clean(ve, 0); if (v) { out.push(v); continue; } }
            }
            out.push(base.replace(`class="${root}`, `class="${root} ${mod}`));
          }
        }
        return out.join("\n");
      }, roots, Object.fromEntries(roots.map((r) => {
        // Variant modifiers bound to THIS ROOT class in the contract's own selectors. Grabbing every
        // modifier that merely appears somewhere in a selector cloned whole blocks for variants that
        // belong to a CHILD (`.wp-block-pricing-plan.is-highlighted` duplicated the entire pricing table).
        const re = new RegExp("\\." + r + "\\.((?:card-theme|cta-variant|button-variant|divider-type|layout)-[a-z-]+|is-[a-z-]+)", "g");
        const mods = [...new Set(s.targets.flatMap((t) => [...t.selector.matchAll(re)].map((m) => m[1])))];
        return [r, mods];
      })));
      // Page-level roots (`wjs-page-content`, `container`) drag the entire page in as their "subtree" —
      // hundreds of KB no design generator can honor. A component skeleton is small by nature; when the
      // extraction comes back huge, the CSS-derived skeleton was the better description. The ceiling is
      // relative to THIS screen's skeleton, not absolute: a screen that bundles six blocks legitimately
      // extracts six subtrees, and a fixed 8KB cap would silently send it back to skeletons.
      if (html && html.trim() && html.length < Math.max(8000, s.html.length * 6)) s.html = html;
    }
  } finally { await browser.close(); }
  return screens;
}

async function plan(slug, brief, domUrl, opts = {}) {
  const budget = opts.perBlock ? 0 : (opts.budget || SCREEN_HTML_BUDGET);
  // With a live page the real markup is the authority, so extract per block FIRST and pack on real sizes.
  let screens = planScreens(UI_CSS, domUrl ? { perBlock: true } : opts);
  if (domUrl) {
    screens = await skeletonsFromDom(screens, domUrl);
    if (budget) screens = packScreens(screens, budget);
  }
  // The intent screen goes FIRST and carries no markup — see intentPrompt(). It is generated, then read
  // back with `get_project` into .design/stitch.json; it is never measured, so it has no targets.
  screens = [{ name: "00-design-system", intent: true, blocks: [], html: "", targets: [] }, ...screens];
  const dir = workDir(slug);
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "screens"), { recursive: true });
  for (const s of screens) {
    s.prompt = promptFor(s, brief);
    fs.writeFileSync(path.join(dir, "prompts", `${s.name}.txt`), s.prompt);
  }
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ slug, brief, screens }, null, 1));
  const tokens = new Set(screens.flatMap((s) => s.targets.map((t) => t.token)));
  const bloques = screens.reduce((n, s) => n + s.blocks.length, 0);
  console.log(`plan: ${screens.length} pantallas · ${bloques} bloques · ${tokens.size} tokens medibles`);
  for (const s of screens) {
    console.log(`  ${s.name.padEnd(16)} ${String(s.blocks.length).padStart(2)} bloques  ${String(s.html.length).padStart(5)}B  ${String(s.targets.length).padStart(3)} tokens`);
  }
  console.log(`  prompts -> ${path.relative(process.cwd(), path.join(dir, "prompts"))}`);
  console.log(`  guarda cada diseño como screens/<nombre>.html`);
  return screens;
}

/* -------------------------------------------------------------- measure */

/**
 * A shorthand declaration (`border: var(--wjs-x-border-width) solid var(--wjs-x-border-color)`) feeds
 * several tokens from one property, and reading the shorthand back gives the whole thing. Resolve which
 * longhand each token actually wants from the words in its own name.
 */
const SHORTHAND = {
  background: ["background-color", "background-image"],
  border: ["border-top-width", "border-top-color", "border-top-style"],
  "border-top": ["border-top-width", "border-top-color", "border-top-style"],
  "border-bottom": ["border-bottom-width", "border-bottom-color", "border-bottom-style"],
  "border-left": ["border-left-width", "border-left-color", "border-left-style"],
  outline: ["outline-width", "outline-color", "outline-style"],
  font: ["font-size", "font-weight", "font-family"],
};
const WORD_ALIAS = { bg: "color", fill: "color", gradient: "image", ink: "color", weight: "weight", size: "size" };

/** Which side a value occupies in a 1-to-4-value box shorthand. */
const BOX_SIDE = (slot, slots) => (
  slots === 1 ? "top" :
  slots === 2 ? (slot === 0 ? "top" : "left") :
  slots === 3 ? ["top", "left", "bottom"][slot] :
  ["top", "right", "bottom", "left"][slot] || "top"
);
const BOX = { margin: "margin", padding: "padding", inset: "inset", "border-width": "border-width", "border-color": "border-color", "border-style": "border-style" };

function resolveProp(prop, token, meta = {}) {
  const { slot = 0, slots = 1 } = meta;
  // A var occupying ONE position of a multi-value declaration names that position only.
  if (slots > 1) {
    if (BOX[prop]) {
      const side = BOX_SIDE(slot, slots);
      return prop === "margin" || prop === "padding" || prop === "inset"
        ? `${prop}-${side}`
        : `border-${side}-${prop.split("-")[1]}`;
    }
    if (prop === "gap") return slot === 0 ? "row-gap" : "column-gap";
    if (/^border(-(top|right|bottom|left))?$/.test(prop)) {
      const side = prop.includes("-") ? prop.split("-")[1] : "top";
      return `border-${side}-${["width", "style", "color"][slot] || "width"}`;
    }
  }
  const longhands = SHORTHAND[prop];
  if (!longhands) return prop;
  const words = token.replace(/^--wjs-/, "").split("-").map((w) => WORD_ALIAS[w] || w);
  let best = longhands[0], bestScore = -1;
  for (const lh of longhands) {
    const score = lh.split("-").filter((w) => words.includes(w)).length;
    if (score > bestScore) { best = lh; bestScore = score; }
  }
  return best;
}

/**
 * Declared values are the author's own text, so almost nothing to do — no unit math, no ratio
 * reconstruction. What remains is parsing, not calculation.
 */
function normalize(prop, raw, ctx) {
  const v = String(raw ?? "").replace(/\s*!important\s*$/, "").trim();
  if (!v || ["inherit", "initial", "unset", "revert", "revert-layer"].includes(v)) return null;
  if (prop === "font-family") return v.split(",")[0].replace(/^["']|["']$/g, "").trim();
  if (prop === "grid-template-columns" && ctx.fn === "repeat") {
    // The contract embeds this token as a COUNT: `repeat(var(--x, 3), …)`. Take it from the author's
    // own `repeat(N, …)`, or count the explicit tracks.
    const m = /repeat\(\s*(\d+)/.exec(v);
    return m ? m[1] : String(v.split(/\s+/).filter(Boolean).length);
  }
  return v;
}

/** The contract classes a piece of markup carries, with how many times each appears. */
function contractClasses(src) {
  const counts = new Map();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      if (/^(wp-block-|wjs-|is-|card-theme-|cta-variant-|button-variant-|layout-|divider-type-|heading-h)/.test(c)) {
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * Did the design keep the markup we sent? Two failure modes make a screen unusable, and BOTH read as a
 * perfectly ordinary low token count if nobody checks:
 *   • the file was downloaded before the generation finished, so it is truncated;
 *   • the generation dropped a component (measured: an 11-component sheet lost one whole block).
 * Either way the tokens of the missing elements are silently absent, and merging that into a theme
 * records "the designer chose not to style this" for something the designer never saw.
 */
function fidelityOf(sentHtml, gotHtml) {
  const want = contractClasses(sentHtml), have = contractClasses(gotHtml);
  const missing = [...want.keys()].filter((c) => !have.has(c));
  return { of: want.size, kept: want.size - missing.length, missing };
}

async function measureScreens(slug) {
  const dir = workDir(slug);
  const { screens } = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(), headless: "new",
    args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files", "--font-render-hinting=none"],
  });
  const tokens = {};
  const report = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    for (const s of screens) {
      const file = path.join(dir, "screens", `${s.name}.html`);
      if (!fs.existsSync(file)) { report.push({ name: s.name, status: "SIN-PANTALLA", filled: 0, of: s.targets.length }); continue; }
      // Stitch occasionally omits the Tailwind runtime it was told to keep; the classes are then inert
      // and every declared value reads as user-agent defaults. Repair rather than discard the screen.
      const content = fs.readFileSync(file, "utf8");
      if (/class="[^"]*(?:bg-|text-|p-\d|rounded|flex)/.test(content) && !/cdn\.tailwindcss\.com|tailwindcss/.test(content)) {
        fs.writeFileSync(file, content.replace(/<head>/i, '<head><script src="https://cdn.tailwindcss.com"></script>'));
      }
      // Refuse to measure a screen that does not carry the markup we sent: its missing tokens would be
      // recorded as deliberate omissions. Below the bar the screen is reported and SKIPPED, not merged.
      const fid = fidelityOf(s.html, content);
      if (fid.kept / fid.of < 0.9) {
        report.push({ name: s.name, status: "INCOMPLETA", filled: 0, of: s.targets.length, fid });
        continue;
      }
      await page.goto("file://" + file.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));

      // ONE source of truth: the DECLARED value, straight from Chrome's cascade. No computed-style
      // reads, no unset-detection heuristics — a property no rule declares simply yields no token,
      // which is the correct outcome by construction.
      const measured = s.targets.map((t) => ({ ...t, cssProp: resolveProp(t.prop, t.token, t) }));
      const declared = await readDeclared(page, measured);

      let filled = 0, missing = 0;
      for (const t of measured) {
        const r = declared[t.token];
        if (!r) { missing++; continue; }
        const value = normalize(t.prop, r.value, { fn: t.fn });
        if (value === null) continue;
        tokens[t.token] = value;
        filled++;
      }
      report.push({ name: s.name, status: fid.kept < fid.of ? "PARCIAL" : "OK", filled, of: s.targets.length, missing, fid });
    }
  } finally { await browser.close(); }
  return { tokens, report };
}

/**
 * Why a target token came back empty. A token is filled only when some author rule DECLARES that property
 * on that element, so a miss is one of three very different things — and only one of them is worth another
 * generation:
 *   SIN-ELEMENTO      the selector matched nothing (the block was dropped, or the contract's selector does
 *                     not exist in the skeleton we sent);
 *   ESTADO            a :hover/:focus/::before target — a static design has no reason to declare it, and
 *                     asking harder will not change that;
 *   SIN-DECLARACIÓN   the element is there and the designer simply did not set that property (no border on
 *                     a borderless card). That is a real design decision, not a failure — PROVIDED the
 *                     contract states a fallback, which is then what renders. Where it does not, the
 *                     declaration resolves to nothing and the property falls back to its initial value:
 *                     that one is a genuine hole, reported apart as HUECO.
 */
async function gaps(slug, only) {
  const dir = workDir(slug);
  // A token is only a hole when the contract NEVER gives it a fallback. `var(--x, 1px)` renders 1px with
  // the token unset, so leaving it unset is the framework default doing its job.
  const css = fs.readFileSync(UI_CSS, "utf8");
  const withFallback = new Set(), bare = new Set();
  for (const m of css.matchAll(/var\(\s*(--wjs-[a-z0-9-]+)\s*(,)?/g)) (m[2] ? withFallback : bare).add(m[1]);
  const unbacked = new Set([...bare].filter((t) => !withFallback.has(t)));
  const { screens } = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(), headless: "new",
    args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files"],
  });
  const rows = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    for (const s of screens) {
      if (only && s.name !== only) continue;
      const file = path.join(dir, "screens", `${s.name}.html`);
      if (!fs.existsSync(file)) continue;
      await page.goto("file://" + file.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
      await new Promise((r) => setTimeout(r, 400));
      const measured = s.targets.map((t) => ({ ...t, cssProp: resolveProp(t.prop, t.token, t) }));
      const declared = await readDeclared(page, measured);
      const exists = await page.evaluate(
        (sels) => Object.fromEntries(sels.map((x) => { try { return [x, !!document.querySelector(x)]; } catch { return [x, false]; } })),
        [...new Set(measured.map((t) => t.selector))]);
      for (const t of measured) {
        const why = declared[t.token] ? "LLENO"
          : !exists[t.selector] ? "SIN-ELEMENTO"
          : (t.pseudo || t.pseudoEl) ? "ESTADO"
          : unbacked.has(t.token) ? "HUECO"
          : "SIN-DECLARACIÓN";
        rows.push({ screen: s.name, token: t.token, prop: t.cssProp, selector: t.selector, why });
      }
    }
  } finally { await browser.close(); }
  return rows;
}

/* ----------------------------------------------------------------- merge */

const toRgb = (v) => {
  const m = /rgba?\(([^)]+)\)/i.exec(String(v || ""));
  if (m) {
    // Declared values use the modern space-separated syntax (`rgb(0 33 71 / 1)`); splitting on commas
    // parsed that as r=0 and nothing else, so every contrast judgment on a declared ink was garbage.
    const p = m[1].replace("/", " ").split(/[\s,]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  }
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v || "").trim());
  if (!h) return null;
  const x = h[1].length === 3 ? h[1].split("").map((c) => c + c).join("") : h[1];
  return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: 1 };
};
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

/**
 * Re-home inks that were measured against a background the block does not carry.
 *
 * Every value here was read off the exact element the contract styles, so a low-contrast pairing is
 * normally the designer's call and must be preserved. The exception is a block with NO background of its
 * own: its ink was measured against whatever surface that Stitch screen happened to use, and on a page
 * with a different canvas it renders invisible — white-on-white icon lists and pull quotes. Judge each
 * ink against the background it will ACTUALLY sit on: the block's own fill when it has one, the page
 * canvas otherwise.
 */
function fixInkAgainstEffectiveBackground(tokens) {
  const canvas = toRgb(tokens["--wjs-bg-canvas"] || tokens["--wjs-bg"] || "#ffffff") || { r: 255, g: 255, b: 255, a: 1 };
  let fixed = 0;
  for (const token of Object.keys(tokens)) {
    if (!token.endsWith("-color")) continue;
    // Walk outward for the fill this ink actually sits on: a card's dark-variant TITLE inherits the dark
    // variant's background, not the page canvas — `--wjs-card-dark-title-color` -> `--wjs-card-dark-bg`.
    // Checking only `<token>-bg` finds nothing for nested inks and wrongly judges them against the page.
    const parts = token.replace(/-color$/, "").split("-");
    let own = null;
    for (let i = parts.length; i > 2 && !own; i--) {
      const candidate = toRgb(tokens[`${parts.slice(0, i).join("-")}-bg`]);
      if (candidate && candidate.a > 0.5) own = candidate;
    }
    const bg = own || canvas;                          // a transparent fill is not a background
    const fg = toRgb(tokens[token]);
    if (!fg || contrast(fg, bg) >= 3) continue;
    tokens[token] = lum(bg) > 0.45 ? "rgb(17, 17, 17)" : "rgb(255, 255, 255)";
    fixed++;
  }
  return fixed;
}

/**
 * Declarative sink: the measured tokens become theme.json's `tokens`, which the compiler turns into
 * the `:root` block of style.css. Only tokens the CONTRACT knows are written — a measurement whose
 * name is not in the manifest would be rejected by the compiler as UNKNOWN_TOKEN, and silently
 * dropping it here is better than emitting a theme that fails to build.
 */
/**
 * A measured value is whatever the browser reported, and Tailwind's spacing utilities report their
 * own arithmetic: `margin-top: 0` comes back as `calc(1rem * calc(1 - 0))`. That is not design
 * intent, it is the utility's implementation leaking, and the compiler rejects it as outside the
 * portable token charset — two tokens were enough to abort the whole build. Collapse the identities;
 * return null for anything still unportable so it is skipped and counted rather than written.
 */
function normalizeMeasured(raw) {
  let v = String(raw).trim().replace(/\s+/g, " ");
  for (let i = 0; i < 4; i++) {
    const before = v;
    v = v.replace(/calc\(\s*([0-9.]+[a-z%]*)\s*\*\s*calc\(\s*1\s*-\s*0\s*\)\s*\)/gi, "$1")
      .replace(/calc\(\s*([0-9.]+[a-z%]*)\s*\*\s*1\s*\)/gi, "$1")
      .replace(/calc\(\s*[0-9.]+[a-z%]*\s*\*\s*0\s*\)/gi, "0");
    if (v === before) break;
  }
  // The compiler's charset: the printable subset a token value may use. Anything else (a stray
  // backslash, a control character, a smart quote from copied content) is not worth guessing at.
  return /^[\x20-\x7E]+$/.test(v) && !/calc\([^)]*calc\(/i.test(v) ? v : null;
}

function mergeIntoThemeJson(slug, metaPath, tokens) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve("backend/public/theme-tokens.json"), "utf8"));
  const known = new Set(Object.keys(manifest.tokens || {}));
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const before = { ...(meta.tokens || {}) };
  const accepted = {}, rejected = [];
  for (const [k, v] of Object.entries(tokens)) {
    if (!known.has(k)) { rejected.push(k); continue; }
    const n = normalizeMeasured(v);
    if (n === null) { rejected.push(k); continue; }
    accepted[k] = n;
  }
  meta.tokens = { ...before, ...accepted };                     // measurements win over derivation
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return {
    droppedRules: 0, contrastFixes: 0,
    total: Object.keys(meta.tokens).length,
    added: Object.keys(accepted).filter((k) => !(k in before)).length,
    changed: Object.keys(accepted).filter((k) => k in before && before[k] !== accepted[k]).length,
    rejected: rejected.length,
    sink: "theme.json",
  };
}

/** Replace the values of measured tokens inside the theme's existing `.wjs-public-site { … }` block. */
function merge(slug, tokens) {
  const cssPath = path.join(themeDir(slug), "style.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const open = css.indexOf(".wjs-public-site {");
  // A DECLARATIVE theme has no `.wjs-public-site` skin block: its tokens live in theme.json and the
  // compiler writes them into :root. That is the shipping model, so the measurements go there and
  // `wordjs build theme` emits the CSS — which keeps the doctor, the verifier and the generated-block
  // markers working. Writing a skin block instead would produce a file the compiler then overwrites.
  const metaPath = path.join(themeDir(slug), "theme.json");
  if (open < 0 && fs.existsSync(metaPath)) return mergeIntoThemeJson(slug, metaPath, tokens);
  if (open < 0) throw new Error(`no encuentro el bloque de tokens en ${cssPath}`);
  const close = css.indexOf("}", open);
  const head = css.slice(0, open), block = css.slice(open, close), tail = css.slice(close);

  const existing = {};
  for (const m of block.matchAll(/(--wjs-[a-z0-9-]+)\s*:\s*([^;]+);/g)) existing[m[1]] = m[2].trim();
  const merged = { ...existing, ...tokens };                    // per-block measurements win
  // Contrast enforcement guards inks that were GUESSED from a whole-page render. Here every ink was read
  // off the exact element the contract styles, so a low-contrast pairing is the designer's call (an amber
  // icon glyph on white) — overriding it is precisely the infidelity this pipeline exists to remove.
  // NO ink correction of any kind. Every ink is now measured off the exact element in its exact screen
  // context, so the designer's contrast is right by construction — and this pass was the LAST remaining
  // heuristic mutating measured values: it flipped the hero's white outline ink to near-black because it
  // judged it against the page canvas instead of the navy hero it actually sits on. Exact CSS, verbatim.
  const contrastFixes = 0;
  const body = Object.entries(merged).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  if (!body) throw new Error("merge abortado: el conjunto de tokens quedó vacío");

  // A THEME IS A TOKEN BLOCK AND NOTHING ELSE.
  //
  // Everything after the token block is dropped. The previous generator wrote ~150 per-component rules
  // (plus a BEM bridge and a lot of `!important`) into every theme, and because they load after the
  // contract they silently outranked it — `.wp-block-pricing-plan` existed in both files, so the theme's
  // stale copy won and the measured tokens never reached the pixel. That is what made themes diverge from
  // each other and from the design. The contract owns the rules; the theme owns the values; the only way
  // a theme can restyle an element is by declaring the token the contract reads.
  const droppedRules = (tail.match(/\{/g) || []).length;
  fs.writeFileSync(cssPath, `${head}.wjs-public-site {\n${body}\n}\n`);
  return {
    droppedRules, contrastFixes,
    total: Object.keys(merged).length,
    added: Object.keys(tokens).filter((k) => !(k in existing)).length,
    changed: Object.keys(tokens).filter((k) => k in existing && existing[k] !== tokens[k]).length,
  };
}


/* ---------------------------------------------------------------- verify */

/**
 * Render the contract's own skeletons under the generated theme and compare what WordJS actually paints
 * against what was measured in Stitch. This is the fidelity proof: a token can be written correctly and
 * still not reach the pixel (wrong scope, a framework rule winning, a missing contract-v3 class).
 * Runs entirely offline against the theme files — it never touches the site's active theme.
 */
async function verifyLive(slug, url) {
  const dir = workDir(slug);
  const { screens } = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const expected = JSON.parse(fs.readFileSync(path.join(dir, "tokens.json"), "utf8"));
  const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: "new", args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files"] });
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
    const targets = screens.flatMap((s) => s.targets)
      .filter((t) => expected[t.token] !== undefined)
      // A resting page cannot exhibit :hover/:focus values; comparing them against the resting computed
      // style manufactures mismatches. State fidelity is proven at measurement time instead.
      .filter((t) => !t.pseudo && !t.pseudoEl)
      .map((t) => ({ ...t, cssProp: resolveProp(t.prop, t.token, t), live: bridgeSelector(t.selector) }));
    const got = await p.evaluate((ts) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const out = {};
      for (const t of ts) {
        let el = null;
        // The real DOM uses the bridged (hyphenated) names; fall back to BEM for anything already emitting it.
        // Candidate RANKING instead of a binary filter: (a) variant classes on ANCESTORS disqualify first —
        // a pricing name inside the highlighted plan reports the variant's ink, not the base token; classes
        // on the element itself only count when some other candidate lacks them (every pricing action
        // carries `button-variant-primary`, so it discriminates nothing). (b) A token whose name doesn't
        // belong to the ancestor block is being read inside a FOREIGN component that restyles it — the
        // global `--wjs-h3-size` measured on pricing's h3 reports pricing's scale.
        const VAR_RE = /^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)/;
        // The DEFAULT variant IS the base: when every card on the page carries some `card-theme-*`,
        // `card-theme-light` is where base tokens live, not a disqualifier.
        const DEFAULT_RE = /-(light|primary|default|base|solid|list)$/;
        const costly = (c) => VAR_RE.test(c) && !DEFAULT_RE.test(c) && !t.selector.includes(c);
        const score = (e) => {
          let s = 0;
          for (let n = e.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
            for (const c of n.classList) if (costly(c)) s += 10;
            for (const c of n.classList) {
              if (!c.startsWith("wp-block-")) continue;
              const comp = c.replace(/^wp-block-/, "").split("-")[0];
              if (!t.token.includes(`-${comp}`)) s += 3;   // foreign block context
              break;
            }
          }
          for (const c of e.classList) if (costly(c)) s += 1;
          return s;
        };
        for (const sel of [t.live, t.selector]) {
          try {
            const all = [...document.querySelectorAll(sel)].filter(vis);
            if (all.length) { el = all.sort((x, y) => score(x) - score(y))[0]; }
            else el = document.querySelector(sel);
          } catch { /* ignore */ }
          if (el) break;
        }
        // Instance authoring: the page author set this very token inline on the element or an ancestor.
        // The pixel then follows the author, by design — report it as such, not as a theme failure.
        let authored = false;
        for (let n = el; n && !authored; n = n.parentElement) {
          const st = n.getAttribute && n.getAttribute("style");
          if (st && st.includes(t.token + ":")) authored = true;
        }
        if (authored) { out[t.token] = { authored: true }; continue; }
        const cs = el && getComputedStyle(el);
        out[t.token] = el ? { value: cs.getPropertyValue(t.cssProp), fontSize: cs.getPropertyValue("font-size") } : null;
      }
      return out;
    }, targets);

    // Expected values are DECLARED author text (`2rem`, `rgb(0 33 71 / 1)`, `translate(0, -0.25rem)`);
    // the page reports COMPUTED values (`32px`, `rgb(0, 33, 71)`, `matrix(…)`). Same value, different
    // notation. Canonicalize through the browser itself: apply the declared text to a probe element and
    // read it back computed — then both sides speak computed and string-compare honestly.
    const canon = await p.evaluate((items) => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const out = {};
      for (const [token, prop, value, fontSize] of items) {
        probe.style.cssText = "";
        // Font-relative values (`-0.025em` tracking, unitless line-height) canonicalize differently at
        // every font size; resolving them on a 16px probe while the page element sits at 48px reports
        // -0.4px vs -1.2px for the SAME author value. The probe must adopt the element's font.
        if (fontSize) probe.style.fontSize = fontSize;
        probe.style.setProperty(prop, value);
        out[token] = probe.style.getPropertyValue(prop) ? getComputedStyle(probe).getPropertyValue(prop) : value;
      }
      probe.remove();
      return out;
    }, targets.map((t) => [t.token, t.cssProp, String(expected[t.token]), got[t.token]?.fontSize || null]));

    const rows = [];
    for (const t of targets) {
      const g = got[t.token];
      if (!g) { rows.push({ token: t.token, status: "SIN-ELEMENTO", want: expected[t.token], got: "-" }); continue; }
      if (g.authored) { rows.push({ token: t.token, status: "AUTORÍA", want: "-", got: "instancia" }); continue; }
      const a = String(g.value ?? "").replace(/\s+/g, " ").trim();
      const want = String(canon[t.token] ?? expected[t.token]).replace(/\s+/g, " ").trim();
      let same = a === want || (/px/.test(want) && /px/.test(a) && Math.abs(parseFloat(a) - parseFloat(want)) < 0.51);
      // A grid template compares by what it MEANS: the theme says `3` (a count) or `repeat(4, …)`; the
      // page reports resolved pixel tracks. Same column count = same value.
      if (!same && t.cssProp === "grid-template-columns") {
        const count = (v) => { const m = /repeat\(\s*(\d+)/.exec(v); if (m) return +m[1];
          return /^\d+$/.test(v.trim()) ? +v.trim() : v.split(/\s+/).filter((x) => /px|fr|%/.test(x)).length; };
        same = count(want) > 0 && count(want) === count(a);
      }
      if (!same) rows.push({ token: t.token, status: "DISTINTO", want: want.slice(0, 40), got: a.slice(0, 40) || "(vacío)" });
    }
    return { checked: targets.length, rows };
  } finally { await browser.close(); }
}

async function verify(slug) {
  const dir = workDir(slug);
  const { screens } = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const expected = JSON.parse(fs.readFileSync(path.join(dir, "tokens.json"), "utf8"));
  const ui = fs.readFileSync(UI_CSS, "utf8");
  const theme = fs.readFileSync(path.join(themeDir(slug), "style.css"), "utf8");
  const body = screens.map((s) => s.html).join("\n");
  const page = `<style>${ui}</style><style>${theme}</style>
<div class="wjs-public-site wjs-theme-contract-v3"><div class="wjs-content puck-content">${body}</div></div>`;
  const file = path.join(dir, "specimen.html");
  fs.writeFileSync(file, page);

  const browser = await puppeteer.launch({ executablePath: resolveChromePath(), headless: "new", args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files"] });
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto("file://" + file.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 600));
    const targets = screens.flatMap((s) => s.targets).filter((t) => expected[t.token] !== undefined)
      .map((t) => ({ ...t, cssProp: resolveProp(t.prop, t.token, t) }));
    const got = await p.evaluate((ts) => {
      const out = {};
      for (const t of ts) {
        let el = null;
        try { el = document.querySelector(t.selector); } catch { /* ignore */ }
        out[t.token] = el ? { value: getComputedStyle(el).getPropertyValue(t.cssProp), fontSize: getComputedStyle(el).getPropertyValue("font-size") } : null;
      }
      return out;
    }, targets);

    const rows = [];
    for (const t of targets) {
      const g = got[t.token];
      if (!g) { rows.push({ token: t.token, status: "SIN-ELEMENTO", want: expected[t.token], got: "-" }); continue; }
      const actual = normalize(t.prop, g.value, { "font-size": g.fontSize, fn: t.fn });
      const want = String(expected[t.token]).trim();
      const same = String(actual ?? "").trim() === want ||
        // px vs unitless line-height and 400/normal style equivalences are not real differences.
        Math.abs(parseFloat(actual) - parseFloat(want)) < 0.51 && /px$/.test(want) && /px$/.test(String(actual));
      if (!same) rows.push({ token: t.token, status: "DISTINTO", want, got: String(actual ?? "(vacío)") });
    }
    return { checked: targets.length, rows };
  } finally { await browser.close(); }
}

/* ------------------------------------------------------------------- CLI */

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); }
  catch { return false; }
})();

if (isMain) {
  const [cmd, slug, ...rest] = process.argv.slice(2);
  if (!cmd || !slug) { console.error("usage: node scripts/stitch-block-pipeline.mjs <plan|assemble|merge|verify> <theme-slug> [--brief \"…\"] [--budget <bytes>|--per-block]"); process.exit(1); }
  const brief = rest.includes("--brief") ? rest[rest.indexOf("--brief") + 1] : "";

  if (cmd === "plan") {
    const domUrl = rest.includes("--from-dom") ? rest[rest.indexOf("--from-dom") + 1] : null;
    const budget = rest.includes("--budget") ? Number(rest[rest.indexOf("--budget") + 1]) : 0;
    await plan(slug, brief, domUrl, { budget, perBlock: rest.includes("--per-block") });
  } else if (cmd === "assemble" || cmd === "merge") {
    const { tokens, report } = await measureScreens(slug);
    fs.writeFileSync(path.join(workDir(slug), "tokens.json"), JSON.stringify(tokens, null, 1));
    const done = report.filter((r) => r.status === "OK");
    console.log(`\nPANTALLAS: ${done.length}/${report.length}  ·  TOKENS MEDIDOS: ${Object.keys(tokens).length}\n`);
    console.log("PANTALLA".padEnd(24) + "ESTADO".padEnd(14) + "LLENOS".padStart(8) + "OBJETIVO".padStart(10) + "   FIDELIDAD");
    for (const r of report) {
      console.log(r.name.padEnd(24) + r.status.padEnd(14) + String(r.filled).padStart(8) + String(r.of).padStart(10) +
        (r.fid ? `   ${r.fid.kept}/${r.fid.of}` : ""));
      if (r.fid?.missing.length) console.log(`      falta: ${r.fid.missing.join(", ")}`);
    }
    if (cmd === "merge") {
      const res = merge(slug, tokens);
      console.log(`\nstyle.css: ${res.total} tokens (${res.added} nuevos, ${res.changed} corregidos, ${res.droppedRules} reglas heredadas fuera, ${res.contrastFixes} tintas re-alojadas)`);
    }
  } else if (cmd === "verify") {
    // `--url` measures the REAL page. Without it we only measure the contract against itself, which is
    // circular: it cannot see that the shipped DOM uses different class names than the contract styles.
    const url = rest.includes("--url") ? rest[rest.indexOf("--url") + 1] : null;
    const { checked, rows } = url ? await verifyLive(slug, url) : await verify(slug);
    if (!url) console.log("\n⚠ specimen derivado del contrato (verificación circular). Usa --url <página real>.");
    const diff = rows.filter((r) => r.status === "DISTINTO");
    const auth = rows.filter((r) => r.status === "AUTORÍA");
    const gone = rows.filter((r) => r.status === "SIN-ELEMENTO");
    console.log(`\nVERIFICADOS ${checked} tokens · coinciden ${checked - rows.length} · distintos ${diff.length} · autoría ${auth.length} · sin elemento ${gone.length}\n`);
    for (const r of diff.slice(0, 40)) console.log("  " + r.token.padEnd(38) + String(r.want).slice(0, 26).padEnd(28) + "-> " + String(r.got).slice(0, 26));
    if (diff.length > 40) console.log(`  … y ${diff.length - 40} más`);
  } else if (cmd === "gaps") {
    const only = rest.includes("--screen") ? rest[rest.indexOf("--screen") + 1] : null;
    const rows = await gaps(slug, only);
    const by = (w) => rows.filter((r) => r.why === w);
    const total = rows.length, lleno = by("LLENO").length;
    console.log(`\nOBJETIVOS ${total} · llenos ${lleno} (${Math.round((lleno / total) * 100)}%)\n`);
    for (const why of ["HUECO", "ESTADO", "SIN-ELEMENTO", "SIN-DECLARACIÓN"]) {
      const v = by(why);
      if (!v.length) continue;
      const byProp = new Map();
      for (const r of v) byProp.set(r.prop, (byProp.get(r.prop) || 0) + 1);
      console.log(`${why.padEnd(16)} ${String(v.length).padStart(4)}`);
      console.log("   " + [...byProp].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `${p}×${n}`).join(", "));
      if (rest.includes("--list")) for (const r of v) console.log(`     ${r.token.padEnd(40)} ${r.selector}`);
    }
  } else { console.error(`comando desconocido: ${cmd}`); process.exit(1); }
}

export { plan, measureScreens, merge, promptFor, resolveProp };
