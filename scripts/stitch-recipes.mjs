/**
 * B' — utility RECIPES as the theme format.
 *
 * The design screens already carry Tailwind utilities ON our contract markup, so the theme is
 * extracted by COPYING class attributes — no CSSOM, no computed styles, no reverse engineering.
 * The recipes compile to plain CSS with the repo's real Tailwind v4 (@apply), scoped under
 * .wjs-public-site, and become the theme skin. recipes.json is the human-editable source.
 *
 *   node scripts/stitch-recipes.mjs                    extract + compile + prove (vs PAGINA-TRADUCIDA)
 *   node scripts/stitch-recipes.mjs --extract-only     stop after recipes.json + report (inspection)
 *   node scripts/stitch-recipes.mjs --apply <slug>     ...then write the theme (recipes.json + skin + fonts)
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { resolveChromePath } from "./stitch-measure.mjs";

const require2 = createRequire(import.meta.url);
const puppeteer = require2("puppeteer-core");
const feReq = createRequire(path.resolve("frontend/package.json"));
const postcss = feReq("postcss");
const twPlugin = feReq("@tailwindcss/postcss");

const D = path.resolve(".stitch-cache/blocks/apex-enterprise");
const CRE_S = "^(wp-block-|wjs-|heading-h\\d)";
const MRE_S = "^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)";
// Icon vocabulary classes live in the MARKUP (React renders them); they are not utilities.
const PASS_S = "^(fa$|fa-|material-symbols|material-icons)";
const ROOT_SEL = ".wjs-public-site";
const NL = "\n";

const extractOnly = process.argv.includes("--extract-only");
const ai = process.argv.indexOf("--apply");
const applySlug = ai > 0 ? process.argv[ai + 1] : null;

const { screens } = JSON.parse(fs.readFileSync(path.join(D, "plan.json"), "utf8"));

/* ============================== 1. EXTRACT ============================== */

const browser = await puppeteer.launch({
  executablePath: resolveChromePath(), headless: "new",
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
const page = await browser.newPage();
// DOM parsing only: no rendering, no external fetches.
await page.setRequestInterception(true);
page.on("request", (r) => (r.url().startsWith("file://") ? r.continue() : r.abort()));

const fonts = new Set();
const configs = [];           // {screen, cfg}
const occurrences = [];       // {sel, utils[], screen}  one per element instance
const instanceStyles = [];    // style="" attrs — instance-authored in Puck, never theme
const screenBody = new Map(); // screen -> raw body utility list (showcase context, prove page only)
const screenHtml = new Map(); // screen -> mutated body html (contract+icon classes, data-w scaffolding)
const scaffoldRules = [];     // per-element scaffolding recipes — prove page only, never the theme
let wSeq = 0;

for (const s of screens) {
  const f = path.join(D, "screens", `${s.name}.html`);
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f, "utf8");
  for (const l of raw.matchAll(/href="(https:\/\/fonts\.googleapis\.com[^"]+)"/g))
    fonts.add(l[1].replace(/&amp;/g, "&"));
  const ci = raw.indexOf("tailwind.config");
  if (ci >= 0) {
    const start = raw.indexOf("{", ci);
    let depth = 0, end = -1;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") { depth--; if (!depth) { end = i; break; } }
    }
    if (end > 0) {
      try { configs.push({ screen: s.name, cfg: vm.runInNewContext("(" + raw.slice(start, end + 1) + ")", {}) }); }
      catch (e) { configs.push({ screen: s.name, error: String(e) }); }
    }
  }

  await page.goto("file://" + f.replace(/\\/g, "/"), { waitUntil: "domcontentloaded", timeout: 20000 });
  const res = await page.evaluate((CREs, MREs, PASSs, wStart) => {
    const CRE = new RegExp(CREs), MRE = new RegExp(MREs), PASS = new RegExp(PASSs);
    const out = [], styles = [], scaffolds = [], jobs = [];
    let w = wStart;
    const widOf = new Map();
    const wid = (el) => { if (!widOf.has(el)) widOf.set(el, "w" + (++w)); return widOf.get(el); };
    const tagOf = (el) => el.tagName.toLowerCase();
    const contractSelOf = (el, withMods) => {
      const cs = [...el.classList].filter((c) => CRE.test(c));
      if (!cs.length) return null;
      const ms = withMods ? [...el.classList].filter((c) => MRE.test(c)) : [];
      return tagOf(el) + "." + cs.concat(ms).join(".");
    };
    const nearestContract = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
        if ([...(a.classList || [])].some((c) => CRE.test(c))) return a;
      return null;
    };
    // Proven ancestor-variant prefix: a rule under `.wp-block-pricing-plan.is-highlighted` is a
    // different design than the base one.
    const ancestorPrefixOf = (el) => {
      for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
        const mods = [...(a.classList || [])].filter((c) => MRE.test(c));
        if (mods.length) {
          const rootC = [...a.classList].find((c) => CRE.test(c));
          if (rootC) return "." + rootC + "." + mods.join(".") + " ";
        }
      }
      return "";
    };
    // tag segment, disambiguated with :nth-of-type only when same-tag siblings genuinely differ.
    const segOf = (el) => {
      const t = tagOf(el);
      const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => tagOf(c) === t) : [el];
      if (sibs.length > 1 && sibs.some((c) => c.getAttribute("class") !== el.getAttribute("class")))
        return t + ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
      return t;
    };
    const descSelOf = (el, anc) => {
      const segs = [];
      for (let n = el; n && n !== anc; n = n.parentElement) segs.unshift(segOf(n));
      return contractSelOf(anc, true) + " > " + segs.join(" > ");
    };

    // body-level utilities: the site CANVAS (background, base typography) feeds the root recipe;
    // the showcase body's LAYOUT (flex/justify/p-*) is scaffolding — kept apart for the prove page.
    const CANVAS_RE = /^(?:selection:)?(bg-|text-|font-|antialiased$|subpixel-antialiased$|leading-|tracking-)/;
    const bodyRaw = [...document.body.classList].filter((c) => !CRE.test(c) && !MRE.test(c) && !PASS.test(c) && c !== "group");
    const bodyUtils = bodyRaw.filter((c) => CANVAS_RE.test(c));
    if (bodyUtils.length) out.push({ sel: "__ROOT__", utils: bodyUtils });

    for (const el of [...document.body.querySelectorAll("*")]) {
      const tag = tagOf(el);
      if (["script", "style", "link", "meta", "title"].includes(tag)) { jobs.push({ el, remove: true }); continue; }
      const cls = [...el.classList];
      const isContract = cls.some((c) => CRE.test(c));
      const anc = nearestContract(el);
      const keep = cls.filter((c) => (isContract && (CRE.test(c) || MRE.test(c))) || PASS.test(c));

      const utils = [], groups = [];
      for (const c of cls) {
        if (CRE.test(c) || MRE.test(c) || PASS.test(c) || c === "group") continue;
        if (/^group-[a-z-]+:/.test(c)) groups.push(c); else utils.push(c);
      }

      if (!isContract && !anc) {
        // showcase scaffolding: styled by its OWN per-element recipe (prove page only, never theme)
        jobs.push({ el, cls: keep.join(" "), dataW: wid(el) });
        if (utils.length) scaffolds.push({ sel: `[data-w="${wid(el)}"]`, utils });
      } else {
        jobs.push({ el, cls: keep.join(" ") });
        const selfSel = isContract ? ancestorPrefixOf(el) + contractSelOf(el, true) : descSelOf(el, anc);
        if (utils.length) out.push({ sel: selfSel, utils });
        if (el.getAttribute("style")) styles.push({ sel: isContract ? contractSelOf(el, true) : descSelOf(el, anc), style: el.getAttribute("style") });
      }

      // group-<state>:x relocates to an ancestor-scoped rule; the React DOM drives state via
      // the contract modifier (.is-open) or real :hover, never a .group marker class.
      for (const g of groups) {
        const i = g.indexOf(":");
        const state = g.slice(6, i), bare = g.slice(i + 1);
        const ga = el.closest(".group");
        if (!ga) { utils.push(bare); continue; }
        const gaContract = [...ga.classList].some((c) => CRE.test(c));
        const gBase = gaContract ? contractSelOf(ga, false)
          : nearestContract(ga) ? descSelOf(ga, nearestContract(ga))
          : `[data-w="${wid(ga)}"]`;
        const gSel = state === "hover" ? gBase + ":hover"
          : state === "open" ? gBase + ".is-open"
          : gBase + ":" + state;
        const dSel = isContract ? contractSelOf(el, true)
          : anc ? descSelOf(el, anc)
          : `[data-w="${wid(el)}"]`;
        const entry = { sel: gSel + " " + dSel, utils: [bare] };
        if (!isContract && !anc) scaffolds.push(entry); else out.push(entry);
      }
    }
    // mutate AFTER the walk: descSelOf/segOf read sibling class attributes
    for (const j of jobs) {
      if (j.remove) { j.el.remove(); continue; }
      if (j.cls) j.el.setAttribute("class", j.cls); else j.el.removeAttribute("class");
      if (j.dataW) j.el.setAttribute("data-w", j.dataW);
    }
    return { out, styles, bodyRaw, scaffolds, html: document.body.innerHTML, w };
  }, CRE_S, MRE_S, PASS_S, wSeq);

  wSeq = res.w;
  for (const o of res.out) occurrences.push({ ...o, screen: s.name });
  for (const sc of res.scaffolds) scaffoldRules.push({ ...sc, screen: s.name });
  for (const st of res.styles) instanceStyles.push({ ...st, screen: s.name });
  screenBody.set(s.name, res.bodyRaw);
  screenHtml.set(s.name, res.html);
}
await browser.close();

/* ==================== 2. CONFIG MERGE → @theme vars ==================== */

const NS = { colors: "color", fontFamily: "font", boxShadow: "shadow", borderRadius: "radius", spacing: "spacing", letterSpacing: "tracking", lineHeight: "leading", fontSize: "text" };
const themeVars = new Map(); // var name -> Map(value -> [screens])
const unmapped = [];
const feed = (name, value, screen) => {
  const v = Array.isArray(value) ? value.join(", ") : String(value);
  const m = themeVars.get(name) || new Map();
  const arr = m.get(v) || [];
  arr.push(screen); m.set(v, arr); themeVars.set(name, m);
};
for (const { screen, cfg, error } of configs) {
  if (error) { unmapped.push({ screen, error }); continue; }
  const theme = { ...(cfg.theme || {}) }, ext = theme.extend || {};
  delete theme.extend;
  for (const src of [theme, ext]) {
    for (const [group, defs] of Object.entries(src)) {
      if (!defs || !Object.keys(defs).length) continue;
      const ns = NS[group];
      if (!ns) { unmapped.push({ screen, group }); continue; }
      for (const [key, val] of Object.entries(defs)) {
        const base = key === "DEFAULT" ? `--${ns}` : `--${ns}-${key}`;
        if (val && typeof val === "object" && !Array.isArray(val)) {
          for (const [sub, v2] of Object.entries(val))
            feed(sub === "DEFAULT" ? base : `${base}-${sub}`, v2, screen);
        } else feed(base, val, screen);
      }
    }
  }
}
// The designs speak Tailwind v3 (Stitch ships the v3 CDN): pin the v3 default theme so v3 names
// keep v3 values under the v4 compiler. Unused pins are pruned from the output by Tailwind itself.
const V3_PALETTE = {
  slate: ["#f8fafc", "#f1f5f9", "#e2e8f0", "#cbd5e1", "#94a3b8", "#64748b", "#475569", "#334155", "#1e293b", "#0f172a", "#020617"],
  gray: ["#f9fafb", "#f3f4f6", "#e5e7eb", "#d1d5db", "#9ca3af", "#6b7280", "#4b5563", "#374151", "#1f2937", "#111827", "#030712"],
  zinc: ["#fafafa", "#f4f4f5", "#e4e4e7", "#d4d4d8", "#a1a1aa", "#71717a", "#52525b", "#3f3f46", "#27272a", "#18181b", "#09090b"],
  neutral: ["#fafafa", "#f5f5f5", "#e5e5e5", "#d4d4d4", "#a3a3a3", "#737373", "#525252", "#404040", "#262626", "#171717", "#0a0a0a"],
  stone: ["#fafaf9", "#f5f5f4", "#e7e5e4", "#d6d3d1", "#a8a29e", "#78716c", "#57534e", "#44403c", "#292524", "#1c1917", "#0c0a09"],
  red: ["#fef2f2", "#fee2e2", "#fecaca", "#fca5a5", "#f87171", "#ef4444", "#dc2626", "#b91c1c", "#991b1b", "#7f1d1d", "#450a0a"],
  orange: ["#fff7ed", "#ffedd5", "#fed7aa", "#fdba74", "#fb923c", "#f97316", "#ea580c", "#c2410c", "#9a3412", "#7c2d12", "#431407"],
  amber: ["#fffbeb", "#fef3c7", "#fde68a", "#fcd34d", "#fbbf24", "#f59e0b", "#d97706", "#b45309", "#92400e", "#78350f", "#451a03"],
  yellow: ["#fefce8", "#fef9c3", "#fef08a", "#fde047", "#facc15", "#eab308", "#ca8a04", "#a16207", "#854d0e", "#713f12", "#422006"],
  lime: ["#f7fee7", "#ecfccb", "#d9f99d", "#bef264", "#a3e635", "#84cc16", "#65a30d", "#4d7c0f", "#3f6212", "#365314", "#1a2e05"],
  green: ["#f0fdf4", "#dcfce7", "#bbf7d0", "#86efac", "#4ade80", "#22c55e", "#16a34a", "#15803d", "#166534", "#14532d", "#052e16"],
  emerald: ["#ecfdf5", "#d1fae5", "#a7f3d0", "#6ee7b7", "#34d399", "#10b981", "#059669", "#047857", "#065f46", "#064e3b", "#022c22"],
  teal: ["#f0fdfa", "#ccfbf1", "#99f6e4", "#5eead4", "#2dd4bf", "#14b8a6", "#0d9488", "#0f766e", "#115e59", "#134e4a", "#042f2e"],
  cyan: ["#ecfeff", "#cffafe", "#a5f3fc", "#67e8f9", "#22d3ee", "#06b6d4", "#0891b2", "#0e7490", "#155e75", "#164e63", "#083344"],
  sky: ["#f0f9ff", "#e0f2fe", "#bae6fd", "#7dd3fc", "#38bdf8", "#0ea5e9", "#0284c7", "#0369a1", "#075985", "#0c4a6e", "#082f49"],
  blue: ["#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8", "#1e40af", "#1e3a8a", "#172554"],
  indigo: ["#eef2ff", "#e0e7ff", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#4338ca", "#3730a3", "#312e81", "#1e1b4b"],
  violet: ["#f5f3ff", "#ede9fe", "#ddd6fe", "#c4b5fd", "#a78bfa", "#8b5cf6", "#7c3aed", "#6d28d9", "#5b21b6", "#4c1d95", "#2e1065"],
  purple: ["#faf5ff", "#f3e8ff", "#e9d5ff", "#d8b4fe", "#c084fc", "#a855f7", "#9333ea", "#7e22ce", "#6b21a8", "#581c87", "#3b0764"],
  fuchsia: ["#fdf4ff", "#fae8ff", "#f5d0fe", "#f0abfc", "#e879f9", "#d946ef", "#c026d3", "#a21caf", "#86198f", "#701a75", "#4a044e"],
  pink: ["#fdf2f8", "#fce7f3", "#fbcfe8", "#f9a8d4", "#f472b6", "#ec4899", "#db2777", "#be185d", "#9d174d", "#831843", "#500724"],
  rose: ["#fff1f2", "#ffe4e6", "#fecdd3", "#fda4af", "#fb7185", "#f43f5e", "#e11d48", "#be123c", "#9f1239", "#881337", "#4c0519"],
};
const V3_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
// v3 text scale: FIXED rem line-heights (v4 switched to relative calc() — not what the design saw).
const V3_TEXT = {
  xs: ["0.75rem", "1rem"], sm: ["0.875rem", "1.25rem"], base: ["1rem", "1.5rem"], lg: ["1.125rem", "1.75rem"],
  xl: ["1.25rem", "1.75rem"], "2xl": ["1.5rem", "2rem"], "3xl": ["1.875rem", "2.25rem"], "4xl": ["2.25rem", "2.5rem"],
  "5xl": ["3rem", "1"], "6xl": ["3.75rem", "1"], "7xl": ["4.5rem", "1"], "8xl": ["6rem", "1"], "9xl": ["8rem", "1"],
};
const v3Pins = [];
for (const [fam, vals] of Object.entries(V3_PALETTE))
  vals.forEach((hex, i) => v3Pins.push(`  --color-${fam}-${V3_STEPS[i]}: ${hex};`));
for (const [k, [size, lh]] of Object.entries(V3_TEXT))
  v3Pins.push(`  --text-${k}: ${size};`, `  --text-${k}--line-height: ${lh};`);

const themeDecl = [], conflicts = [];
const conflictRewrites = new Map(); // screen -> [{re, to}]
for (const [name, values] of themeVars) {
  const ranked = [...values.entries()].sort((a, b) => b[1].length - a[1].length);
  themeDecl.push(`  ${name}: ${ranked[0][0]};`);
  if (ranked.length === 1) continue;
  conflicts.push({ var: name, kept: ranked[0][0], losers: ranked.slice(1).map(([v, s]) => ({ value: v, screens: s })) });
  // A losing screen designed against ITS value: rewrite its named utilities to that literal so
  // exactness survives the merge. `_` is Tailwind's escaped space inside arbitrary values.
  for (const [value, losScreens] of ranked.slice(1)) {
    const arb = `[${value.replace(/ /g, "_")}]`;
    let re = null;
    const cm = /^--color-(.+)$/.exec(name);
    const sm2 = /^--shadow-(.+)$/.exec(name);
    if (cm) re = new RegExp(`^((?:hover:|focus:|active:|md:|lg:)*(?:bg|text|border|from|to|via|ring|divide|outline|decoration|fill|stroke|accent|caret)-)${cm[1]}$`);
    else if (sm2) re = new RegExp(`^((?:hover:|focus:|active:|md:|lg:)*shadow-)${sm2[1]}$`);
    if (!re) continue;
    for (const scr of losScreens) {
      const list = conflictRewrites.get(scr) || [];
      list.push({ re, to: (u) => u.replace(re, `$1${arb}`) });
      conflictRewrites.set(scr, list);
    }
  }
}

/* ==================== 3. MERGE (majority per selector) ==================== */

// Stitch-isms with an exact Tailwind equivalent (font-600 IS font-weight:600), plus the v3→v4
// renames: the designs are authored against the v3 CDN, so v3 names must keep their v3 VALUES.
const SAFE_ALIASES = {
  "font-500": "font-medium", "font-600": "font-semibold", "font-700": "font-bold", "font-800": "font-extrabold",
  "shadow": "shadow-[0_1px_3px_0_rgb(0,0,0,0.1),0_1px_2px_-1px_rgb(0,0,0,0.1)]",
  "shadow-sm": "shadow-[0_1px_2px_0_rgb(0,0,0,0.05)]",
  "rounded-sm": "rounded-[0.125rem]",
  "blur": "blur-[8px]", "blur-sm": "blur-[4px]",
  "ring": "ring-[3px]", "outline-none": "outline-hidden",
};
const normalizeUtils = (utils, screen) => {
  const rw = conflictRewrites.get(screen);
  return utils.map((u) => {
    const bare = u.replace(/^(?:[a-z-]+:)+/, "");
    if (SAFE_ALIASES[bare]) u = u.slice(0, u.length - bare.length) + SAFE_ALIASES[bare];
    if (rw) for (const { re, to } of rw) if (re.test(u)) u = to(u);
    return u;
  });
};
for (const o of occurrences) o.utils = normalizeUtils(o.utils, o.screen);
for (const sc of scaffoldRules) sc.utils = normalizeUtils(sc.utils, sc.screen);
for (const [scr, list] of screenBody) screenBody.set(scr, normalizeUtils(list, scr));

const groups = new Map();
for (const o of occurrences) {
  const g = groups.get(o.sel) || [];
  g.push(o); groups.set(o.sel, g);
}
// The DEDICATED screen is the design authority for its own block: `pricing` decides every
// `.wp-block-pricing-*` key even when combo screens outvote it with degraded renditions.
const screenNames = screens.map((s) => s.name).sort((a, b) => b.length - a.length);
const ownerOf = (sel) => {
  if (/\.wjs-/.test(sel)) return "site-chrome";
  const m = /wp-block-([a-z0-9-]+)/.exec(sel);
  if (!m) return null;
  return screenNames.find((n) => m[1] === n || m[1].startsWith(n + "-") || m[1].startsWith(n)) || null;
};
const recipes = {};     // sel -> apply string (owner-screen or majority)
const divergents = [];  // context outliers — instance-level styling, excluded from the theme
for (const [sel, list] of groups) {
  const owner = ownerOf(sel);
  const tally = new Map();
  for (const o of list) {
    const sig = [...o.utils].sort().join(" ");
    const t = tally.get(sig) || { n: 0, owned: 0, first: o };
    t.n++; if (o.screen === owner) t.owned++;
    tally.set(sig, t);
  }
  const ranked = [...tally.values()].sort((a, b) => (b.owned - a.owned) || (b.n - a.n));
  recipes[sel] = ranked[0].first.utils.join(" ");
  for (const v of ranked.slice(1))
    divergents.push({ sel, screen: v.first.screen, utils: v.first.utils.join(" "), instances: v.n });
}

/* ============================== 4. COMPILE ============================== */

const orderedSels = Object.keys(recipes).sort();
const buildInput = () => {
  const rules = orderedSels
    .filter((sel) => recipes[sel].trim())
    .map((sel) => {
      const scoped = sel === "__ROOT__" ? ROOT_SEL : `${ROOT_SEL} ${sel}`;
      return `${scoped} {${NL}  @apply ${recipes[sel]};${NL}}`;
    });
  return [`@import "tailwindcss/theme.css";`, `@theme {${NL}${v3Pins.join(NL)}${NL}${themeDecl.join(NL)}${NL}}`, ...rules].join(NL + NL);
};

const inputPath = path.resolve("frontend/.stitch-recipes.input.css");
const dropped = [];
let compiled = null;
for (let attempt = 0; attempt < 80; attempt++) {
  fs.writeFileSync(inputPath, buildInput());
  try {
    const r = await postcss([twPlugin({ base: path.resolve("frontend") })]).process(fs.readFileSync(inputPath, "utf8"), { from: inputPath });
    compiled = r.css;
    break;
  } catch (e) {
    const m = /Cannot apply unknown utility class[:\s`]*([^\s`']+)/.exec(String(e.message));
    if (!m) { fs.rmSync(inputPath, { force: true }); throw e; }
    const bad = m[1];
    dropped.push(bad);
    for (const sel of orderedSels)
      recipes[sel] = recipes[sel].split(/\s+/).filter((u) => u !== bad).join(" ");
  }
}
fs.rmSync(inputPath, { force: true });
if (compiled === null) throw new Error("compile did not converge");

// Scoped preflight: the utilities were designed against Tailwind's reset; ship it inside the
// site scope so the skin is self-sufficient without touching anything outside .wjs-public-site.
const preflightSrc = fs.readFileSync(path.resolve("frontend/node_modules/tailwindcss/preflight.css"), "utf8");
const pf = postcss.parse(preflightSrc);
pf.walkRules((rule) => {
  rule.selectors = [...new Set(rule.selectors.map((s) => {
    s = s.trim();
    if (/^(html|:host|body)\b/.test(s)) return ROOT_SEL;
    if (s === "*") return `${ROOT_SEL} *`;
    if (s.startsWith("::") || s.startsWith(":")) return `${ROOT_SEL} *${s}`;
    if (s.startsWith("*")) return `${ROOT_SEL} ${s}`;
    return `${ROOT_SEL} ${s}`;
  }))];
});
// v3 preflight defaults border-color to gray-200; v4 leaves currentColor. The design saw v3.
const preflightScoped = pf.toString() +
  `${NL}${ROOT_SEL} *, ${ROOT_SEL} *::before, ${ROOT_SEL} *::after { border-color: #e5e7eb; }`;

const SKIN = `/* recipes: ${orderedSels.length} · theme vars: ${themeDecl.length} */${NL}${preflightScoped}${NL}${compiled}`;

/* ============================== 5. PERSIST + REPORT ============================== */

const recipesJson = {
  version: 1,
  generatedFrom: "stitch screens (class attributes — no CSSOM)",
  fonts: [...fonts].sort(),
  theme: Object.fromEntries(themeDecl.map((l) => l.trim().replace(/;$/, "").split(": "))),
  recipes: Object.fromEntries(orderedSels.map((s) => [s, recipes[s]]).filter(([, v]) => v.trim())),
};
fs.writeFileSync(path.join(D, "recipes.json"), JSON.stringify(recipesJson, null, 2));
fs.writeFileSync(path.join(D, "recipes-report.json"), JSON.stringify({
  selectors: orderedSels.length,
  occurrences: occurrences.length,
  divergents, conflicts, dropped, unmapped, instanceStyles,
}, null, 2));
fs.writeFileSync(path.join(D, "recipes-skin.css"), SKIN);

console.log(`recetas: ${Object.keys(recipesJson.recipes).length} selectores (${occurrences.length} instancias)`);
console.log(`@theme: ${themeDecl.length} vars · conflictos: ${conflicts.length}`);
console.log(`divergentes (contenido): ${divergents.length} · dropped: ${dropped.length} ${dropped.length ? "→ " + dropped.join(", ") : ""}`);
console.log(`skin compilada: ${(SKIN.length / 1024).toFixed(0)}KB`);
if (extractOnly) process.exit(0);

/* ============================== 6. PROVE ============================== */
// PAGINA-RECETAS.html is 100% B'-generated: the mutated screen DOMs (contract + icon classes only,
// data-w ids on showcase scaffolding), styled ENTIRELY by compiled recipes — contract skin for the
// theme part, per-element scaffolding rules and per-screen body context for the showcase part.
// The reference is the ORIGINAL per-screen design on the v3 CDN. Element sequence matches by
// construction (the mutation only removed script/style/link).

let proveCss = "";
{
  const droppedCtx = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const css = [`@import "tailwindcss/theme.css";`, `@theme {${NL}${v3Pins.join(NL)}${NL}${themeDecl.join(NL)}${NL}}`,
      ...scaffoldRules.map((sc) => `${sc.sel} {${NL}  @apply ${sc.utils.join(" ")};${NL}}`),
      // v3 body defaults first (the original pages start from them), then each screen's own body
      `section[data-screen] {${NL}  @apply font-sans text-black bg-white leading-normal;${NL}}`,
      ...[...screenBody.entries()].filter(([, l]) => l.length)
        .map(([scr, l]) => `section[data-screen="${scr}"] {${NL}  @apply ${l.join(" ")};${NL}}`)].join(NL + NL);
    fs.writeFileSync(inputPath, css);
    try {
      const r = await postcss([twPlugin({ base: path.resolve("frontend") })]).process(css, { from: inputPath });
      proveCss = r.css;
      break;
    } catch (e) {
      const m = /Cannot apply unknown utility class[:\s`]*([^\s`']+)/.exec(String(e.message));
      if (!m) { fs.rmSync(inputPath, { force: true }); throw e; }
      droppedCtx.push(m[1]);
      for (const sc of scaffoldRules) sc.utils = sc.utils.filter((u) => u !== m[1]);
      for (const [scr, l] of screenBody) screenBody.set(scr, l.filter((u) => u !== m[1]));
    }
  }
  fs.rmSync(inputPath, { force: true });
  if (droppedCtx.length) console.log(`prueba (scaffolding/body): dropped ${droppedCtx.join(", ")}`);
}

const fontsHtml = [...fonts].sort().map((u) => `<link rel="stylesheet" href="${u}">`).join(NL);
const recPath = path.join(D, "PAGINA-RECETAS.html");
fs.writeFileSync(recPath,
  `<!doctype html><html><head><meta charset="utf-8"><title>R — recetas compiladas (cero Tailwind runtime)</title>${NL}` +
  `${fontsHtml}${NL}<style>body{margin:0}</style><style id="recetas">${NL}${SKIN}${NL}${proveCss}${NL}</style></head>` +
  `<body class="wjs-public-site">${NL}` +
  screens.filter((s) => screenHtml.has(s.name))
    .map((s) => `<section data-screen="${s.name}">${NL}${screenHtml.get(s.name)}${NL}</section>`).join(NL) +
  `${NL}</body></html>`);

// Paint + typography properties; box GEOMETRY is compared via real rects (margins are means, not
// ends — v3 space-y uses margin-top, v4 margin-bottom, same rendered layout).
const PROPS = ["display", "position", "padding-top", "padding-bottom", "padding-left", "padding-right",
  "color", "background-color", "background-image", "font-family", "font-size", "font-weight",
  "font-style", "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration-line",
  "border-top-width", "border-bottom-width", "border-left-width", "border-right-width",
  "border-top-color", "border-style", "border-radius", "box-shadow", "opacity", "gap",
  "justify-content", "align-items", "flex-direction", "grid-template-columns", "transform", "overflow"];

// Screen-context outliers lost the cross-screen majority vote — they are instance-level styling by
// design (Puck authoring), exactly what data-d marked in the harvest. Counted apart, not hidden.
const expectedDivergent = new Set(divergents.map((d) => d.screen + "|" + d.sel));

const b2 = await puppeteer.launch({
  executablePath: resolveChromePath(), headless: "new", protocolTimeout: 240000,
  args: ["--no-sandbox", "--allow-file-access-from-files", "--hide-scrollbars"],
});
// Per-element snapshot, shared by both sides. `root` is the walk scope (body or a section).
const SNAP_SRC = `(root, props, CREs, MREs) => {
  const CRE = new RegExp(CREs), MRE = new RegExp(MREs);
  const SKIP = ["script", "style", "link", "meta", "title"];
  const tagOf = (el) => el.tagName.toLowerCase();
  const contractSelOf = (el, withMods) => {
    const cs = [...el.classList].filter((c) => CRE.test(c));
    if (!cs.length) return null;
    const ms = withMods ? [...el.classList].filter((c) => MRE.test(c)) : [];
    return tagOf(el) + "." + cs.concat(ms).join(".");
  };
  const nearestContract = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
      if ([...(a.classList || [])].some((c) => CRE.test(c))) return a;
    return null;
  };
  const segOf = (el) => {
    const t = tagOf(el);
    const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => tagOf(c) === t) : [el];
    if (sibs.length > 1 && sibs.some((c) => c.getAttribute("class") !== el.getAttribute("class")))
      return t + ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
    return t;
  };
  const descSelOf = (el, anc) => {
    const segs = [];
    for (let n = el; n && n !== anc; n = n.parentElement) segs.unshift(segOf(n));
    return contractSelOf(anc, true) + " > " + segs.join(" > ");
  };
  const els = [...root.querySelectorAll("*")].filter((el) => !SKIP.includes(el.tagName.toLowerCase()));
  return els.map((el) => {
    const inContract = !!(el.closest('[class*="wp-block-"]') || el.closest('[class*="wjs-"]') ||
      [...el.classList].some((c) => CRE.test(c)));
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    // rebuild the extractor's key EXACTLY (only trustworthy on the original side, where the full
    // class attributes are still present)
    let selKey = null;
    const ccs = [...el.classList].filter((c) => CRE.test(c));
    if (ccs.length) {
      let prefix = "";
      for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
        const ms = [...(a.classList || [])].filter((c) => MRE.test(c));
        if (ms.length) {
          const rootC = [...a.classList].find((c) => CRE.test(c));
          if (rootC) { prefix = "." + rootC + "." + ms.join(".") + " "; break; }
        }
      }
      selKey = prefix + contractSelOf(el, true);
    } else {
      const anc = nearestContract(el);
      if (anc) selKey = descSelOf(el, anc);
    }
    const o = {
      k: el.tagName.toLowerCase() + (ccs.length ? "." + ccs.slice(0, 2).join(".") : (el.getAttribute("data-w") ? "[w]" : "")),
      selKey, inContract,
      rect: [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * 2) / 2),
    };
    for (const pr of props) o[pr] = cs.getPropertyValue(pr);
    return o;
  });
}`;
// normalize to the screen's first element: cross-page comparison must not depend on where the
// specimen sits in the page flow
const normalize = (list) => {
  if (!list.length) return list;
  const [ox, oy] = list[0].rect;
  for (const o of list) { o.rect[0] = Math.round((o.rect[0] - ox) * 2) / 2; o.rect[1] = Math.round((o.rect[1] - oy) * 2) / 2; }
  return list;
};

const settle = async (p) => {
  await p.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await new Promise((r) => setTimeout(r, 350));
};
const SHOT = ["pricing", "table", "card", "hero"];

// originals: one page object, one screen at a time
const orig = new Map();
{
  const p = await b2.newPage();
  await p.setViewport({ width: 1440, height: 1000 });
  for (const s of screens) {
    const f = path.join(D, "screens", `${s.name}.html`);
    if (!fs.existsSync(f)) continue;
    await p.goto("file://" + f.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 60000 });
    await settle(p);
    const data = await p.evaluate(`(${SNAP_SRC})(document.body, ${JSON.stringify(PROPS)}, ${JSON.stringify(CRE_S)}, ${JSON.stringify(MRE_S)})`);
    orig.set(s.name, normalize(data));
    if (SHOT.includes(s.name))
      await p.screenshot({ path: path.join(D, `compare/RECETAS-${s.name}-ORIG.png`) }).catch(() => {});
  }
  await p.close();
}

// recetas page: all sections at once
const rp = await b2.newPage();
await rp.setViewport({ width: 1440, height: 1000 });
await rp.goto("file://" + recPath.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 90000 });
await settle(rp);
const rsec = new Map();
for (const s of screens) {
  const data = await rp.evaluate(`(() => {
    const sec = document.querySelector('section[data-screen="${s.name}"]');
    if (!sec) return null;
    return (${SNAP_SRC})(sec, ${JSON.stringify(PROPS)}, ${JSON.stringify(CRE_S)}, ${JSON.stringify(MRE_S)});
  })()`);
  if (data) rsec.set(s.name, normalize(data));
}

let paintDiffs = 0, geoDiffs = 0, expectedHits = 0, compared = 0, misaligned = [];
const bySel = new Map();
for (const s of screens) {
  const O = orig.get(s.name), R2 = rsec.get(s.name);
  if (!O || !R2) continue;
  if (O.length !== R2.length) misaligned.push(`${s.name} ${O.length}vs${R2.length}`);
  const n = Math.min(O.length, R2.length);
  for (let i = 0; i < n; i++) {
    const a = O[i], r = R2[i];
    if (!a.inContract && !r.inContract) continue;
    compared++;
    const expected = a.selKey && expectedDivergent.has(s.name + "|" + a.selKey);
    const geo = a.rect.some((v, j) => Math.abs(v - r.rect[j]) > 0.5);
    const diffs = PROPS.filter((pr) => a[pr] !== r[pr]);
    if (!geo && !diffs.length) continue;
    if (expected) { expectedHits++; continue; }
    if (geo) {
      geoDiffs++;
      const key = s.name + " › " + r.k + " :: RECT";
      const e = bySel.get(key) || { n: 0, a: a.rect.join(","), r: r.rect.join(",") };
      e.n++; bySel.set(key, e);
    }
    for (const pr of diffs) {
      paintDiffs++;
      const key = s.name + " › " + r.k + " :: " + pr;
      const e = bySel.get(key) || { n: 0, a: a[pr], r: r[pr] };
      e.n++; bySel.set(key, e);
    }
  }
}
console.log(`${NL}PRUEBA vs ORIGINALES: ${compared} elementos · GEOMETRIA: ${geoDiffs} · PINTURA: ${paintDiffs} · divergencia esperada (instancia): ${expectedHits}`);
if (misaligned.length) console.log(`AVISO desalineados: ${misaligned.join(", ")}`);
for (const [k, v] of [...bySel.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 35))
  console.log(`  ${v.n}x ${k}${NL}     O: ${String(v.a).slice(0, 95)}${NL}     R: ${String(v.r).slice(0, 95)}`);

for (const sec of SHOT) {
  const found = await rp.evaluate((sn) => {
    const el = document.querySelector(`section[data-screen="${sn}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: "start" });
    return true;
  }, sec);
  if (found) {
    await new Promise((r) => setTimeout(r, 150));
    await rp.screenshot({ path: path.join(D, `compare/RECETAS-${sec}-R.png`) })
      .catch((e) => console.log(`captura ${sec}-R: ${e.message.split(String.fromCharCode(10))[0]}`));
  }
}
await b2.close();

/* ============================== 7. APPLY ============================== */

if (applySlug) {
  const themeDir = path.resolve("backend/themes", applySlug);
  const themeFile = path.join(themeDir, "style.css");
  const SKIN_MARK = "/* ==== stitch skin (generated — do not edit) ==== */";
  const FONTS_MARK = "/* ==== stitch fonts (generated) ==== */";
  const cur = fs.readFileSync(themeFile, "utf8");
  let base = cur.split(SKIN_MARK)[0];
  base = base.replace(new RegExp(`^[\\s\\S]*?${FONTS_MARK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n(@import[^\\n]*\\n)*`), "");
  const fontImports = [...fonts].sort().map((u) => `@import url("${u}");`).join(NL);
  fs.writeFileSync(themeFile,
    FONTS_MARK + NL + fontImports + NL + base.trimEnd() + NL + NL + SKIN_MARK + NL + SKIN + NL);
  fs.copyFileSync(path.join(D, "recipes.json"), path.join(themeDir, "recipes.json"));
  const tj = path.join(themeDir, "theme.json");
  const meta = JSON.parse(fs.readFileSync(tj, "utf8"));
  meta.layout = meta.layout || {}; meta.layout.ownCss = true;
  fs.writeFileSync(tj, JSON.stringify(meta, null, 2));
  const av = path.resolve("frontend/src/lib/assetVersion.ts");
  fs.writeFileSync(av, fs.readFileSync(av, "utf8").replace(/ASSET_VERSION = "[^"]+"/, `ASSET_VERSION = "recipes-${applySlug}-${SKIN.length}"`));
  console.log(`${NL}tema ${applySlug}: recipes.json + skin (${(SKIN.length / 1024).toFixed(0)}KB) + fuentes · cache busteada`);
}
