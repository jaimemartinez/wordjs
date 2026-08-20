/**
 * Two COMPLETE, standalone pages for human comparison — no iframes, and page B carries ZERO Tailwind:
 *   PAGINA-ORIGINAL.html   every design screen concatenated, styled by Stitch's own Tailwind.
 *   PAGINA-TRADUCIDA.html  the same DOM, but: contract elements keep ONLY their contract classes and are
 *                          styled by the translated contract CSS; every other element gets a stable
 *                          data-w id and its harvested declarations as [data-w] rules. No CDN, no
 *                          utilities — if B looks like A, the translation carries ALL of the design.
 *
 * B is produced by MUTATING page A's live DOM in the browser and serializing it, so element alignment
 * between the harvest and the markup is exact by construction.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveChromePath } from "./stitch-measure.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const D = path.resolve(".stitch-cache/blocks/apex-enterprise");
const CRE_S = "^(wp-block-|wjs-|heading-h\\d)";
const MRE_S = "^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)";

const { screens } = JSON.parse(fs.readFileSync(path.join(D, "plan.json"), "utf8"));
const browser = await puppeteer.launch({
  executablePath: resolveChromePath(), headless: "new",
  args: ["--no-sandbox", "--allow-file-access-from-files", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const fonts = new Set();
const bodiesA = [], bodiesB = [];
const cssParts = [];
const skinParts = [];
let wSeq = 0;

for (const s of screens) {
  const f = path.join(D, "screens", `${s.name}.html`);
  if (!fs.existsSync(f)) continue;
  const raw = fs.readFileSync(f, "utf8");
  for (const l of raw.matchAll(/<link[^>]+fonts\.googleapis[^>]*>/g)) fonts.add(l[0].replace(/&amp;/g, "&"));
  const bm = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
  bodiesA.push(`<section data-screen="${s.name}">\n${bm ? bm[1] : ""}\n</section>`);

  await page.goto("file://" + f.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await new Promise((r) => setTimeout(r, 350));

  const res = await page.evaluate((CREs, MREs, wStart) => {
    const CRE = new RegExp(CREs), MRE = new RegExp(MREs);
    const NL = String.fromCharCode(10);
    // 1) flatten author rules in cascade order
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
    // 2) harvest the effective declarations of ONE element from the rules that match it
    const harvestEl = (el) => {
      const cs = getComputedStyle(el);
      const buckets = {};
      for (const { r, media } of rules) {
        for (const selRaw of r.selectorText.split(",")) {
          const sel = selRaw.trim();
          const pm = sel.match(/(:{1,2}(?:hover|focus-visible|focus-within|focus|active|disabled|visited|checked|placeholder|before|after|selection)(?:\([^)]*\))?)$/);
          const pseudo = pm ? pm[1] : "";
          const base = pseudo ? sel.slice(0, sel.length - pseudo.length) : sel;
          let hit = false; try { hit = el.matches(base); } catch { continue; }
          if (!hit) continue;
          const key = media ? "@" + media + "|" + pseudo : pseudo;
                    const bucket = (buckets[key] = buckets[key] || {});
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
      return buckets;
    };
    const emit = (selector, buckets, lines) => {
      for (const [key, decls] of Object.entries(buckets)) {
        const body = Object.entries(decls).map(([p, v]) => "  " + p + ": " + v + ";").join(NL);
        if (!body) continue;
        const media = key.startsWith("@") ? key.slice(1).split("|")[0] : null;
        const pseudo = key.startsWith("@") ? key.split("|")[1] : key;
        const rule = selector + pseudo + " {" + NL + body + NL + "}";
        lines.push(media ? "@media " + media + " {" + NL + rule + NL + "}" : rule);
      }
    };

    // 3) TWO PHASES. Phase 1 harvests every element against the intact DOM; phase 2 mutates. Stripping
    // classes while iterating broke every descendant-dependent match for later elements (the icon font's
    // ligature rule, the highlighted plan's inner text) — the harvest must see the document as designed.
    const lines = [];
    const skinLines = [];
    const contentLines = [];
    let w = wStart;
    const jobs = [];
    const groups = {};      // selKey -> [{el, buckets}] — same key, possibly different designs per instance
    for (const el of [...document.body.querySelectorAll("*")]) {
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "link"].includes(tag)) { jobs.push({ el, remove: true }); continue; }
      const contract = [...el.classList].filter((c) => CRE.test(c) || MRE.test(c));
      if (contract.length) {
        let prefix = "";
        for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
          const mods = [...(a.classList || [])].filter((c) => MRE.test(c));
          if (mods.length) {
            const rootC = [...a.classList].find((c) => CRE.test(c));
            if (rootC) { prefix = "." + rootC + "." + mods.join(".") + " "; break; }
          }
        }
        // TAG in the key: th and td share `.wp-block-table-cell` but are different designs (white header
        // vs slate body). The tag is real, stable context — not content.
        const selKey = prefix + tag + "." + contract.join(".");
        const buckets = harvestEl(el);
        const b0 = (buckets[""] = buckets[""] || {});
        const cs = getComputedStyle(el);
        for (const ip of ["color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align"]) {
          if (!(ip in b0)) b0[ip] = cs.getPropertyValue(ip);
        }
        (groups[selKey] = groups[selKey] || []).push({ el, buckets });
        jobs.push({ el, cls: contract.join(" ") });
      } else {
        const id = "w" + (++w);
        const buckets = harvestEl(el);
        // CROSS-ORIGIN stylesheets (Google Fonts' own CSS defines .material-symbols-outlined) are
        // unreadable — their effects vanish from the harvest and the icon ligature renders as literal
        // text. Whatever an unreadable sheet set shows up computed: record any text-critical property
        // that differs from the parent, per element, deterministically.
        {
          const cs2 = getComputedStyle(el);
          const ps2 = el.parentElement ? getComputedStyle(el.parentElement) : null;
          const b2 = (buckets[""] = buckets[""] || {});
          for (const fp of ["font-family", "font-weight", "font-style", "font-size", "line-height", "letter-spacing", "text-transform", "word-wrap", "white-space", "direction", "font-feature-settings", "font-variation-settings", "display"]) {
            if (fp in b2) continue;
            const v2 = cs2.getPropertyValue(fp);
            if (ps2 && v2 && v2 !== ps2.getPropertyValue(fp)) b2[fp] = v2;
          }
        }
        emit('[data-w="' + id + '"]', buckets, lines);
        jobs.push({ el, dataW: id });
      }
    }
    // GROUPS: one rule when every instance of a key agrees; when they diverge (the amber status cell vs
    // its slate siblings — CONTENT-level styling), the majority becomes the base rule and each outlier
    // gets a data-d stamp with its own exact rule. A≡B without polluting the reusable base.
    let dSeq = 0;
    const sig = (b) => JSON.stringify(Object.keys(b).sort().map((k) => [k, Object.keys(b[k]).sort().map((p) => [p, b[k][p]])]));
    for (const [selKey, list] of Object.entries(groups)) {
      const tally = {};
      for (const g of list) { const s2 = sig(g.buckets); (tally[s2] = tally[s2] || []).push(g); }
      const variants = Object.values(tally).sort((x, y) => y.length - x.length);
      emit(selKey, variants[0][0].buckets, skinLines);
      for (const variant of variants.slice(1)) {
        for (const g of variant) {
          const id = "d" + (++dSeq);
          g.el.setAttribute("data-d", id);
          emit(selKey.split(" ").pop() + '[data-d="' + id + '"]', g.buckets, contentLines);
        }
      }
    }
    for (const j of jobs) {
      if (j.remove) { j.el.remove(); continue; }
      if (j.cls !== undefined) j.el.setAttribute("class", j.cls);
      if (j.dataW) { j.el.removeAttribute("class"); j.el.setAttribute("data-w", j.dataW); }
      j.el.removeAttribute("style");
    }
    return { css: lines.concat(skinLines, contentLines).join(NL), skin: skinLines.join(NL), html: document.body.innerHTML, w };
  }, CRE_S, MRE_S, wSeq);

  wSeq = res.w;
  cssParts.push(res.css);
  skinParts.push(res.skin);
  bodiesB.push(`<section data-screen="${s.name}">\n${res.html}\n</section>`);
}
await browser.close();

const chrome = `<style>body{margin:0}section[data-screen]{border-top:4px solid #0b1220}section[data-screen]::before{content:attr(data-screen);display:block;background:#0b1220;color:#7dd3fc;font:11px system-ui;letter-spacing:.1em;text-transform:uppercase;padding:6px 14px}</style>`;
const fontsHtml = [...fonts].join("\n");

fs.writeFileSync(path.join(D, "PAGINA-ORIGINAL.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>A — CSS original (Stitch)</title>\n${fontsHtml}\n<script src="https://cdn.tailwindcss.com"><\/script>${chrome}</head><body>` +
  bodiesA.join("\n") + "</body></html>");

fs.writeFileSync(path.join(D, "PAGINA-TRADUCIDA.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>B — CSS traducido (sin Tailwind)</title>\n${fontsHtml}\n${chrome}<style id="translated">\n${cssParts.join("\n")}\n</style></head><body>` +
  bodiesB.join("\n") + "</body></html>");

const a = fs.statSync(path.join(D, "PAGINA-ORIGINAL.html")).size;
const b2 = fs.statSync(path.join(D, "PAGINA-TRADUCIDA.html")).size;

// --theme <slug>: apply the proven skin (contract rules only — no [data-w] wrappers, no [data-d]
// content) to the theme, scoped under .wjs-public-site, in the sentinel section. The same CSS the
// A/B pages just validated is what WordJS serves: nothing new can break between lab and site.
const ti = process.argv.indexOf("--theme");
if (ti > 0 && process.argv[ti + 1]) {
  const slug = process.argv[ti + 1];
  const SKIN_MARK = "/* ==== stitch skin (generated — do not edit) ==== */";
  const themeFile = path.resolve("backend/themes", slug, "style.css");
  const NL3 = String.fromCharCode(10);
  // Scope every top-level selector line under the public-site wrapper; @media and indented lines pass.
  const scoped = skinParts.join(NL3).split(NL3)
    .map((ln) => (/^[.a-z\[]/i.test(ln) && !ln.startsWith("@")) ? ".wjs-public-site " + ln : ln)
    .join(NL3);
  const cur = fs.readFileSync(themeFile, "utf8");
  const base = cur.split(SKIN_MARK)[0].trimEnd();
  fs.writeFileSync(themeFile, base + NL3 + NL3 + SKIN_MARK + NL3 + scoped + NL3);
  const tj = path.resolve("backend/themes", slug, "theme.json");
  const meta = JSON.parse(fs.readFileSync(tj, "utf8"));
  meta.layout = meta.layout || {}; meta.layout.ownCss = true;
  fs.writeFileSync(tj, JSON.stringify(meta, null, 2));
  const av = path.resolve("frontend/src/lib/assetVersion.ts");
  fs.writeFileSync(av, fs.readFileSync(av, "utf8").replace(/ASSET_VERSION = "[^"]+"/, 'ASSET_VERSION = "skin-' + slug + '-' + skinParts.join("").length + '"'));
  console.log("tema " + slug + ": piel aplicada (" + (scoped.length / 1024).toFixed(0) + "KB) · cache busteada");
}
console.log(`PAGINA-ORIGINAL.html: ${(a / 1024).toFixed(0)}KB (Tailwind CDN)`);
console.log(`PAGINA-TRADUCIDA.html: ${(b2 / 1024).toFixed(0)}KB — CERO Tailwind: ${!fs.readFileSync(path.join(D, "PAGINA-TRADUCIDA.html"), "utf8").includes("tailwindcss")}`);
