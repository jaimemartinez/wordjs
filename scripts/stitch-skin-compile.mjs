/**
 * Skin compiler: make every contract class render EXACTLY as the Stitch design — by construction.
 *
 * Token translation has a hard ceiling: the contract's vocabulary is finite, so any declaration the
 * design makes without a matching token is unrepresentable and shows up as "no se ve igual". This tool
 * closes the gap from the other side: it renders BOTH sides, computes the per-class difference of the
 * visual properties, and emits the difference as generated CSS ("the skin") appended to the theme. Then
 * it re-renders and repeats until the difference is ZERO — a convergence loop, which is also the test:
 * exit code 0 only when nothing differs.
 *
 *   node scripts/stitch-skin-compile.mjs apex-enterprise http://localhost:3000/wordjs-block-library-complete
 *   node scripts/stitch-skin-compile.mjs apex-enterprise <url> --check     # test only, no writes
 *
 * Layering stays sane: the skin carries no `!important`, is scoped under `.wjs-public-site`, and sits in
 * a sentinel-delimited section of the theme's style.css — regenerated whole each run, never hand-edited.
 * Instance authoring (inline styles set in Puck) still outranks it, by design.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveChromePath } from "./stitch-measure.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const SKIN_MARK = "/* ==== stitch skin (generated — do not edit) ==== */";
const workDir = (slug) => path.resolve(".stitch-cache/blocks", slug);
const themeCss = (slug) => path.resolve("backend/themes", slug, "style.css");

/**
 * The visual vocabulary: everything a viewer perceives on the element itself. Outer geometry (margins,
 * widths) is layout- and content-dependent between two different pages, so it is compared only where the
 * property is a design decision that survives context (padding, border, radius, gap, alignment).
 */
const VISUAL_PROPS = [
  "display",
  "background-color", "background-image", "color", "opacity",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-top-style", "border-radius", "box-shadow",
  "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
  "text-transform", "text-decoration-line", "text-align", "text-shadow",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "gap", "row-gap", "column-gap", "flex-direction", "align-items", "justify-content",
  "backdrop-filter", "text-overflow", "white-space",
];

/** Values equal for practical purposes: sub-pixel rounding and color notation must not loop forever. */
function same(a, b) {
  const A = String(a ?? "").replace(/\s+/g, " ").trim(), B = String(b ?? "").replace(/\s+/g, " ").trim();
  if (A === B) return true;
  const nA = parseFloat(A), nB = parseFloat(B);
  if (!Number.isNaN(nA) && !Number.isNaN(nB) && /px|^[\d.]+$/.test(A) && /px|^[\d.]+$/.test(B)) {
    return Math.abs(nA - nB) < 0.6 && A.replace(/[\d.]+/g, "#") === B.replace(/[\d.]+/g, "#");
  }
  return false;
}

/** Snapshot: class-combo -> {prop: computedValue}, for every combo the screens exercise. */
async function snapshot(page, combos, { forceHover = false } = {}) {
  const cdp = forceHover ? await page.target().createCDPSession() : null;
  if (cdp) { await cdp.send("DOM.enable"); await cdp.send("CSS.enable"); }
  const out = {};
  for (const combo of combos) {
    const selector = "." + combo.split(" ").join(".");
    if (cdp) {
      try {
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        if (!nodeId) continue;
        await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
        await new Promise((r) => setTimeout(r, 380));      // let transitions land
      } catch { continue; }
    }
    const rec = await page.evaluate((sel, props) => {
      const els = [...document.querySelectorAll(sel)];
      const VAR_RE = /^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)/;
      const DEF_RE = /-(light|primary|default|base|solid|list)$/;
      const cost = (e) => {
        let n = 0;
        for (let a = e, i = 0; a && i < 7; a = a.parentElement, i++)
          for (const c of a.classList || []) if (VAR_RE.test(c) && !DEF_RE.test(c) && !sel.includes(c)) n += a === e ? 1 : 10;
        return n;
      };
      const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const el = vis.sort((x, y) => cost(x) - cost(y))[0] || els[0];
      if (!el) return null;
      const cs = getComputedStyle(el);
      const o = { __inline: el.getAttribute("style") || "" };
      // A DEGENERATE element — no children and only skeleton filler text — is a stray the skeleton
      // emitted in the wrong place; Stitch styles it as a random chip and copying that onto the REAL,
      // populated element wrecks the page (uppercase letter-soup pricing features). Structural shape is
      // part of the identity: mark it so the differ can refuse the transfer.
      o.__degenerate = el.children.length === 0 &&
        /^(Content|Section title|Get started|★|)$/.test((el.textContent || "").trim());
      o.__childCount = el.children.length;
      const ps = el.parentElement ? getComputedStyle(el.parentElement) : null;
      for (const p of props) {
        o[p] = cs.getPropertyValue(p);
        if (ps) o["parent:" + p] = ps.getPropertyValue(p);
      }
      return o;
    }, selector, VISUAL_PROPS);
    if (rec) out[combo] = rec;
    if (cdp) {
      try {
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        if (nodeId) await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
      } catch { /* ignore */ }
    }
  }
  if (cdp) await cdp.detach().catch(() => {});
  return out;
}

/** Every class combo the design screens exercise, from the skeletons the prompts were built on. */
function combosFromPlan(plan) {
  const combos = new Set();
  for (const s of plan.screens) {
    for (const m of String(s.html).matchAll(/class="([^"]+)"/g)) {
      const cls = m[1].split(/\s+/).filter((c) => /^(wp-block-|wjs-|heading-h\d)/.test(c) ||
        /^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)/.test(c));
      if (!cls.length) continue;
      // base class alone, plus the full combo when it carries variant/state modifiers
      combos.add(cls[0]);
      if (cls.length > 1) combos.add(cls.join(" "));
    }
  }
  return [...combos];
}

async function run(slug, liveUrl, { check = false, maxRounds = 3 } = {}) {
  const plan = JSON.parse(fs.readFileSync(path.join(workDir(slug), "plan.json"), "utf8"));
  const combos = combosFromPlan(plan);
  const screensDir = path.join(workDir(slug), "screens");
  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(), headless: "new",
    args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files", "--font-render-hinting=none"],
  });

  try {
    // The DESIGN side is fixed: measure it once, screen by screen (each combo lives on some screen).
    const design = {};
    const designHover = {};
    const dPage = await browser.newPage();
    await dPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    for (const s of plan.screens) {
      const file = path.join(screensDir, `${s.name}.html`);
      if (!fs.existsSync(file)) continue;
      await dPage.goto("file://" + file.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
      await dPage.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await new Promise((r) => setTimeout(r, 350));
      const here = combos.filter((c) => !(c in design));
      Object.assign(design, await snapshot(dPage, here));
      Object.assign(designHover, await snapshot(dPage, here.filter((c) => !c.includes(" ")), { forceHover: true }));
    }
    await dPage.close();

    let report = null;
    for (let round = 1; round <= maxRounds; round++) {
      const lPage = await browser.newPage();
      await lPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
      await lPage.goto(liveUrl + (liveUrl.includes("?") ? "&" : "?") + "skinround=" + round, { waitUntil: "networkidle0", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 1800));
      const live = await snapshot(lPage, Object.keys(design));
      const liveHover = await snapshot(lPage, Object.keys(designHover).filter((c) => c in live), { forceHover: true });
      await lPage.close();

      // Diff design → live. A property the live element carries INLINE is instance authoring: report, skip.
      const rules = {};
      const diffs = [];
      const INHERITABLE = new Set(["color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform", "text-align"]);
      const firstFam = (v) => String(v || "").split(",")[0].replace(/["']/g, "").trim();
      const diffOne = (combo, want, got, pseudo) => {
        if (!want || !got) return;
        // Refuse style transfer when the two sides are not the same KIND of element: a childless filler
        // div in the design cannot dictate the styling of a populated list on the page (and vice versa).
        if (want.__degenerate && got.__childCount > 0) return;
        if (got.__degenerate && want.__childCount > 0) return;
        // Layout-model dependency: flex/grid sub-properties are meaningless across different displays —
        // a block element reports flex-direction "row" as an inert initial value, and transferring it
        // onto a flex list lays the pricing features out sideways. Reconcile display FIRST; dependents
        // wait for the next round, when both sides speak the same layout language.
        const displaysMatch = same(want["display"], got["display"]);
        const FLEXY = new Set(["flex-direction", "flex-wrap", "align-items", "justify-content", "gap", "row-gap", "column-gap"]);
        for (const p of VISUAL_PROPS) {
          if (p === "font-family" && firstFam(want[p]) === firstFam(got[p])) continue;
          if (/^border-top-(color|style)$/.test(p) &&
              parseFloat(want["border-top-width"]) === 0 && parseFloat(got["border-top-width"]) === 0) continue;
          if (same(want[p], got[p])) continue;
          if (FLEXY.has(p) && !displaysMatch) continue;
          // An inheritable property neither side SET on this node is ambient context (body line-height,
          // canvas ink), not a decision about this element — skinning it would freeze inheritance.
          if (INHERITABLE.has(p) && same(want[p], want["parent:" + p]) && !pseudo) continue;
          if ((got.__inline || "").includes(p + ":")) { diffs.push({ combo, p, status: "AUTORÍA" }); continue; }
          // background-image: none↔gradient only; arbitrary url() images are content, not skin
          if (p === "background-image" && /url\(/.test(String(want[p]))) continue;
          const sel = "." + combo.split(" ").join(".") + (pseudo || "");
          (rules[sel] = rules[sel] || {})[p] = want[p];
          diffs.push({ combo: combo + (pseudo || ""), p, want: String(want[p]).slice(0, 44), got: String(got[p]).slice(0, 44), status: "DIFF" });
        }
      };
      for (const combo of Object.keys(design)) diffOne(combo, design[combo], live[combo], "");
      for (const combo of Object.keys(designHover)) diffOne(combo, designHover[combo], liveHover[combo], ":hover");

      const real = diffs.filter((d) => d.status === "DIFF");
      report = { round, diffs: real, authored: diffs.length - real.length, combos: Object.keys(design).length };
      console.log(`\nRONDA ${round}: ${Object.keys(design).length} combos · diferencias ${real.length} · autoría ${report.authored}`);
      for (const d of real.slice(0, 25)) console.log("  " + d.combo.padEnd(42).slice(0, 42) + d.p.padEnd(22) + String(d.want).padEnd(46) + "|pág: " + d.got);
      if (real.length > 25) console.log(`  … y ${real.length - 25} más`);

      if (!real.length || check) break;

      // THE THEME OWNS ITS CSS (the Shopify/classic-WP model). Minting a contract token per differing
      // property was tried and condemned by its own numbers — 111 tokens and 329 generated rules in the
      // SHARED contract for one theme. The skin lives in the theme's own style.css instead: unbounded
      // expressiveness ("cualquier diseño"), zero impact on other themes, and the bounded token set stays
      // what it should be — the user-customization surface. Tokens are still minted, but they live in the
      // theme too, so the Customizer can tweak the skin without editing rules.
      const SUFFIX = {
        "background-color": "bg", "background-image": "bg-image", color: "color", opacity: "opacity",
        "border-top-width": "border-width", "border-right-width": "border-right-width",
        "border-bottom-width": "border-bottom-width", "border-left-width": "border-left-width",
        "border-top-color": "border-color", "border-top-style": "border-style",
        "border-radius": "radius", "box-shadow": "shadow",
        "font-family": "family", "font-size": "size", "font-weight": "weight", "font-style": "font-style",
        "line-height": "leading", "letter-spacing": "tracking", "text-transform": "transform",
        "text-decoration-line": "decoration", "text-align": "align", "text-shadow": "text-shadow",
        "padding-top": "pad-top", "padding-right": "pad-right", "padding-bottom": "pad-bottom", "padding-left": "pad-left",
        gap: "gap", "row-gap": "row-gap", "column-gap": "column-gap",
        "flex-direction": "direction", "align-items": "items", "justify-content": "justify",
        "backdrop-filter": "backdrop", "text-overflow": "text-overflow", "white-space": "white-space",
      };
      const variantWord = (c) => c.replace(/^is-|^card-theme-|^cta-variant-|^button-variant-|^divider-type-|^layout-/, "").replace(/^highlighted$/, "highlight");
      const extRules = {};       // selector -> [ [prop, tokenName, fallback] ]
      const themeTokens = {};    // tokenName -> design value
      for (const [sel, decls] of Object.entries(rules)) {
        const hover = sel.endsWith(":hover");
        const combo = sel.replace(/^\./, "").replace(/:hover$/, "").split(".");
        const component = combo[0].replace(/^wp-block-|^wjs-/, "");
        const mods = combo.slice(1).map(variantWord).filter(Boolean);
        // Compose the four pad sides into ONE -pad token when they all differ together.
        const sides = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
        if (sides.every((x) => decls[x] !== undefined)) {
          const [t, r2, b2, l] = sides.map((x) => decls[x]);
          decls["__pad__"] = t === b2 && r2 === l ? (t === r2 ? t : `${t} ${r2}`) : `${t} ${r2} ${b2} ${l}`;
          sides.forEach((x) => delete decls[x]);
        }
        for (const [prop, value] of Object.entries(decls)) {
          const isPad = prop === "__pad__";
          const suffix = isPad ? "pad" : SUFFIX[prop] || prop;
          const token = `--wjs-${[component, ...mods, hover ? "hover" : null, suffix].filter(Boolean).join("-")}`;
          themeTokens[token] = value;
          const liveVal = (hover ? liveHover : live)[combo.join(" ")]?.[isPad ? "padding-top" : prop];
          const fallback = isPad
            ? ["padding-top", "padding-right", "padding-bottom", "padding-left"].map((x) => (hover ? liveHover : live)[combo.join(" ")]?.[x] ?? "0px").join(" ")
            : (liveVal ?? "initial");
          (extRules[sel] = extRules[sel] || []).push([isPad ? "padding" : prop, token, fallback]);
        }
      }

      // Emit into the THEME: token-consuming rules + the token values, one self-contained
      // sentinel section. No shared file is touched; deleting the section restores tokens-only rendering.
      const NL = "\n";
      const extCss = Object.entries(extRules).map(([sel, list]) =>
        ".wjs-public-site " + sel + " {" + NL +
        list.map(([p2, tok, fb]) => "  " + p2 + ": var(" + tok + ", " + fb + ");").join(NL) +
        NL + "}").join(NL);
      const tokCss = ".wjs-public-site {" + NL +
        Object.entries(themeTokens).map(([k2, v2]) => "  " + k2 + ": " + v2 + ";").join(NL) + NL + "}";
      const file = themeCss(slug);
      const cur = fs.readFileSync(file, "utf8");
      const base = cur.split(SKIN_MARK)[0].trimEnd();
      const prevSkin = cur.includes(SKIN_MARK) ? cur.split(SKIN_MARK)[1] : "";
      fs.writeFileSync(file, `${base}

${SKIN_MARK}
${prevSkin.trim()}
${tokCss}
${extCss}
`);
      console.log(`  tema: +${Object.keys(extRules).length} reglas de piel · +${Object.keys(themeTokens).length} tokens`);

      // Cache-bust so the next round actually sees the new skin.
      const av = path.resolve("frontend/src/lib/assetVersion.ts");
      fs.writeFileSync(av, fs.readFileSync(av, "utf8").replace(/ASSET_VERSION = "[^"]+"/, `ASSET_VERSION = "skin-${slug}-r${round}-${round * 7919}"`));
      await new Promise((r) => setTimeout(r, 9000));
    }
    return report;
  } finally { await browser.close(); }
}

const [slug, url, ...rest] = process.argv.slice(2);
if (!slug || !url) { console.error("uso: node scripts/stitch-skin-compile.mjs <tema> <url> [--check]"); process.exit(1); }
const rep = await run(slug, url, { check: rest.includes("--check") });
console.log(`\nRESULTADO: ${rep.diffs.length === 0 ? "EXACTO — 0 diferencias" : rep.diffs.length + " diferencias tras " + rep.round + " ronda(s)"}`);
process.exit(rep.diffs.length === 0 ? 0 : 1);
