/**
 * Translator lab — proves the design→CSS translator in ISOLATION, outside WordJS entirely.
 *
 * Two pages, identical in every way except the stylesheet:
 *   A: the design screen as Stitch produced it (its own Tailwind utilities).
 *   B: the SAME HTML, but every contract element stripped down to its contract classes only, styled
 *      exclusively by OUR translated CSS. Non-contract wrappers keep their utilities on both sides, so
 *      the only variable is the translation.
 * If A and B render identically, the translator is correct by demonstration — before WordJS, its
 * contract, its components or its cache can interfere. The lab is also the test: it reports every
 * computed difference per contract element and writes side-by-side screenshots for human eyes.
 *
 *   node scripts/translator-lab.mjs pricing            # one screen
 *   node scripts/translator-lab.mjs all                # every screen in the plan
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveChromePath } from "./stitch-measure.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const SLUG = "apex-enterprise";
const DIR = path.resolve(".stitch-cache/blocks", SLUG);
const LAB = path.join(DIR, "lab");
const CONTRACT_RE_S = "^(wp-block-|wjs-|heading-h\\d)";
const MOD_RE_S = "^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)";

const CHECK_PROPS = [
  "display", "background-color", "background-image", "color", "opacity",
  "border-top-width", "border-top-color", "border-radius", "box-shadow",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "text-transform", "text-align", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "gap", "flex-direction", "align-items", "justify-content",
];

/** Harvest the translated CSS from page A: per contract combo (with ancestor-variant prefix), the
 *  declarations its utility classes produce, plus computed ink and unclassed-leaf chips. */
async function harvest(page) {
  return await page.evaluate((CRE_S, MRE_S) => {
    const CRE = new RegExp(CRE_S), MRE = new RegExp(MRE_S);
    const NL = String.fromCharCode(10);
    const rules = [];
    const walk = (rs, media) => {
      for (const r of rs) {
        const m = r.media ? [...r.media].join(", ") : media;
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, m);
        if (r.selectorText) rules.push({ r, media: m || "" });
      }
    };
    for (const sheet of document.styleSheets) {
      let list = null; try { list = sheet.cssRules; } catch { continue; }
      if (list) walk(list, "");
    }
    const buckets = {};   // selKey -> pseudoKey -> {prop: value}
    const order = [];
    const els = [...document.querySelectorAll("*")].filter((e) => [...e.classList].some((c) => CRE.test(c)));
    for (const el of els) {
      const contract = [...el.classList].filter((c) => CRE.test(c) || MRE.test(c));
      if (!contract.length) continue;
      let prefix = "";
      for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
        const mods = [...(a.classList || [])].filter((c) => MRE.test(c));
        if (mods.length) {
          const rootC = [...a.classList].find((c) => CRE.test(c));
          if (rootC) { prefix = "." + rootC + "." + mods.join(".") + " "; break; }
        }
      }
      const selKey = prefix + "." + contract.join(".");
      if (!buckets[selKey]) { buckets[selKey] = {}; order.push(selKey); }
      const B = buckets[selKey];
      const cs = getComputedStyle(el);
      // rule harvest (cascade order; later wins) — Tailwind plumbing resolved per element
      for (const { r, media } of rules) {
        for (const selRaw of r.selectorText.split(",")) {
          const sel = selRaw.trim();
          const pm = sel.match(/(:{1,2}(?:hover|focus-visible|focus-within|focus|active|disabled|visited|checked|placeholder|before|after|selection)(?:\([^)]*\))?)$/);
          const pseudo = pm ? pm[1] : "";
          const base = pseudo ? sel.slice(0, sel.length - pseudo.length) : sel;
          let hit = false; try { hit = el.matches(base); } catch { continue; }
          if (!hit) continue;
          const key = media ? "@" + media + "|" + pseudo : pseudo;
                    const bucket = (B[key] = B[key] || {});
          // Read the AUTHOR's declarations from cssText, not the longhand enumeration: a shorthand set
          // with var() ("border-color: rgb(226 232 240 / var(--tw-border-opacity,1))") serializes every
          // longhand as EMPTY, so enumeration silently drops the rule and the border falls to preflight.
          const txt = r.style.cssText || "";
          let depth0 = 0, start0 = 0;
          const decls0 = [];
          for (let i = 0; i <= txt.length; i++) {
            const ch = txt[i];
            if (ch === "(") depth0++; else if (ch === ")") depth0--;
            if ((ch === ";" && depth0 === 0) || i === txt.length) { decls0.push(txt.slice(start0, i)); start0 = i + 1; }
          }
          for (const d of decls0) {
            const ci = d.indexOf(":");
            if (ci < 0) continue;
            const prop = d.slice(0, ci).trim();
            if (!prop || prop.startsWith("--tw-")) continue;
            let v = d.slice(ci + 1).replace(/!important\s*$/, "").trim();
            if (/var\(\s*--tw-/.test(v)) {
              const csx = getComputedStyle(el);
              let g = 0;
              while (/var\(\s*--tw-/.test(v) && g++ < 6) {
                v = v.replace(/var\(\s*(--tw-[a-z0-9-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
                  (_, name, fb) => csx.getPropertyValue(name).trim() || (fb || "").trim() || "");
              }
              v = v.replace(/\s+/g, " ").trim();
              if (!v) continue;
            }
            bucket[prop] = v;
          }
        }
      }
      // context ink: inheritance-painted text survives translation
      const base0 = (B[""] = B[""] || {});
      for (const ip of ["color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align"]) {
        if (!(ip in base0)) base0[ip] = cs.getPropertyValue(ip);
      }
      // unclassed leaves (check <i>, svg): computed essentials as descendant rules
      for (const leaf of el.querySelectorAll(":scope > i, :scope > svg, :scope > span:not([class])")) {
        const lc = getComputedStyle(leaf);
        const key = "LEAF>" + leaf.tagName.toLowerCase();
        const bucket = (B[key] = B[key] || {});
        for (const lp of ["color", "background-color", "border-radius", "font-size", "width", "height", "display", "align-items", "justify-content", "margin-right", "margin-left"]) {
          const v = lc.getPropertyValue(lp);
          if (v && v !== "auto" && !(lp === "background-color" && v === "rgba(0, 0, 0, 0)")) bucket[lp] = v;
        }
      }
    }
    // emit
    const lines = [];
    for (const selKey of order) {
      for (const [key, decls] of Object.entries(buckets[selKey])) {
        const body = Object.entries(decls).map(([p, v]) => "  " + p + ": " + v + ";").join(NL);
        if (!body) continue;
        if (key.startsWith("LEAF>")) { lines.push(selKey + " > " + key.slice(5) + " {" + NL + body + NL + "}"); continue; }
        const media = key.startsWith("@") ? key.slice(1).split("|")[0] : null;
        const pseudo = key.startsWith("@") ? key.split("|")[1] : key;
        const rule = selKey + pseudo + " {" + NL + body + NL + "}";
        lines.push(media ? "@media " + media + " {" + NL + rule + NL + "}" : rule);
      }
    }
    return lines.join(NL);
  }, CONTRACT_RE_S, MOD_RE_S);
}

/** Page B: identical HTML, contract elements stripped to contract classes, our CSS instead. */
function buildB(htmlA, translated) {
  // Strip non-contract classes ONLY on elements that carry a contract class.
  const stripped = htmlA.replace(/class="([^"]+)"/g, (whole, cls) => {
    const parts = cls.split(/\s+/).filter(Boolean);
    const contract = parts.filter((c) => new RegExp(CONTRACT_RE_S).test(c) || new RegExp(MOD_RE_S).test(c));
    return contract.length ? `class="${contract.join(" ")}"` : whole;
  });
  // Our stylesheet replaces nothing for wrappers (they keep Tailwind); it only governs contract elements.
  return stripped.replace("</head>", `<style id="translated">\n${translated}\n</style></head>`);
}

async function runScreen(browser, name) {
  const fileA = path.join(DIR, "screens", `${name}.html`);
  if (!fs.existsSync(fileA)) return null;
  fs.mkdirSync(LAB, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  // A
  await page.goto("file://" + fileA.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const translated = await harvest(page);
  const snapA = await snap(page);
  await page.screenshot({ path: path.join(LAB, `${name}-A.png`), fullPage: true });

  // B
  const htmlB = buildB(fs.readFileSync(fileA, "utf8"), translated);
  const fileB = path.join(LAB, `${name}-B.html`);
  fs.writeFileSync(fileB, htmlB);
  await page.goto("file://" + fileB.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const snapB = await snap(page);
  await page.screenshot({ path: path.join(LAB, `${name}-B.png`), fullPage: true });
  await page.close();

  // diff
  const diffs = [];
  for (const k of Object.keys(snapA)) {
    const a = snapA[k], b = snapB[k] || {};
    for (const p of CHECK_PROPS) {
      const va = String(a[p] ?? "").replace(/\s+/g, " ").trim();
      const vb = String(b[p] ?? "").replace(/\s+/g, " ").trim();
      if (va === vb) continue;
      const na = parseFloat(va), nb = parseFloat(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && Math.abs(na - nb) < 0.6 &&
          va.replace(/[\d.]+/g, "#") === vb.replace(/[\d.]+/g, "#")) continue;
      if (p === "font-family" && va.split(",")[0] === vb.split(",")[0]) continue;
      diffs.push({ el: k, p, A: va.slice(0, 40), B: vb.slice(0, 40) });
    }
  }
  return { name, els: Object.keys(snapA).length, diffs };
}

async function snap(page) {
  return await page.evaluate((CRE_S, MRE_S, props) => {
    const CRE = new RegExp(CRE_S), MRE = new RegExp(MRE_S);
    const out = {};
    const counts = {};
    for (const el of [...document.querySelectorAll("*")]) {
      const contract = [...el.classList].filter((c) => CRE.test(c) || MRE.test(c));
      if (!contract.length) continue;
      const base = contract.join(".");
      const n = (counts[base] = (counts[base] || 0) + 1);
      const key = base + "#" + n;
      const cs = getComputedStyle(el);
      const o = {};
      for (const p of props) o[p] = cs.getPropertyValue(p);
      out[key] = o;
    }
    return out;
  }, CONTRACT_RE_S, MOD_RE_S, CHECK_PROPS);
}

const target = process.argv[2] || "pricing";
const { screens } = JSON.parse(fs.readFileSync(path.join(DIR, "plan.json"), "utf8"));
const names = target === "all" ? screens.map((s) => s.name) : [target];
const browser = await puppeteer.launch({
  executablePath: resolveChromePath(), headless: "new",
  args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files", "--font-render-hinting=none"],
});
let total = 0, totalEls = 0;
try {
  for (const n of names) {
    const r = await runScreen(browser, n);
    if (!r) continue;
    total += r.diffs.length; totalEls += r.els;
    console.log(`${n}: ${r.els} elementos · ${r.diffs.length} diferencias A↔B`);
    for (const d of r.diffs.slice(0, 12)) console.log(`   ${d.el.slice(0, 44).padEnd(46)}${d.p.padEnd(18)}A:${d.A}  B:${d.B}`);
  }
} finally { await browser.close(); }
console.log(`\nTOTAL: ${totalEls} elementos · ${total} diferencias — ${total === 0 ? "TRADUCTOR EXACTO" : "iterar"}`);
process.exit(total === 0 ? 0 : 1);
