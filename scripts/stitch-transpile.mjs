/**
 * Transpiler: the design's OWN CSS, verbatim, re-targeted onto the contract classes. No diffing.
 *
 * Everything before this reconciled two different documents (design screens vs live page) by comparing
 * computed styles — and every comparison frame (inheritance, layout models, degenerate fillers, authored
 * content) produced its own class of poison. This removes the second document entirely: Stitch styles OUR
 * class names, so for each contract element in a screen we read the DECLARATIONS its utility classes
 * produce (from the CSSOM, in cascade order, hover/focus and media variants included) and emit them as a
 * rule for that element's contract combo. The theme's skin section IS the design's CSS. Single-sided,
 * exact by construction; verification is a separate concern.
 *
 *   node scripts/stitch-transpile.mjs apex-enterprise
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

const CONTRACT_RE = "^(wp-block-|wjs-|heading-h\\d)";
const MOD_RE = "^(is-|card-theme-|cta-variant-|button-variant-|divider-type-|layout-)";

async function transpile(slug) {
  const dir = workDir(slug);
  const { screens } = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(), headless: "new",
    args: ["--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files"],
  });
  // combo -> { "": {prop: value}, ":hover": {...}, "@media …::hover" … }
  const out = {};
  const order = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    for (const s of screens) {
      const file = path.join(dir, "screens", `${s.name}.html`);
      if (!fs.existsSync(file)) continue;
      await page.goto("file://" + file.replace(/\\/g, "/"), { waitUntil: "networkidle0", timeout: 45000 });
      await new Promise((r) => setTimeout(r, 400));
      const found = await page.evaluate((CONTRACT_RE_S, MOD_RE_S) => {
        const CRE = new RegExp(CONTRACT_RE_S), MRE = new RegExp(MOD_RE_S);
        // Flatten author rules with their media context, in document (cascade) order.
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
        const out = {};
        const els = [...document.querySelectorAll("*")].filter((e) =>
          [...e.classList].some((c) => CRE.test(c)));
        for (const el of els) {
          const contract = [...el.classList].filter((c) => CRE.test(c) || MRE.test(c));
          if (!contract.length) continue;
          // ANCESTOR VARIANT CONTEXT: the design says ".is-highlighted .name { white }" — the name's own
          // classes are identical in both plans, so keying by them alone keeps only the base ink and the
          // highlighted plan's heading goes navy-on-navy. Carry the nearest variant ancestor as a selector
          // prefix so both variants of every descendant survive.
          let prefix = "";
          for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
            const mods = [...(a.classList || [])].filter((c) => MRE.test(c));
            if (mods.length) {
              const rootC = [...a.classList].find((c) => CRE.test(c));
              if (rootC) { prefix = "." + rootC + "." + mods.join(".") + " "; break; }
            }
          }
          const combo = prefix + contract.join(" ");
          // Inherited ink: the design often paints a variant's text via the PARENT (text-white on the
          // highlighted plan), declaring nothing on the heading itself — so rule harvesting alone keeps
          // only the base ink and the variant goes navy-on-navy. The computed value at THIS element in
          // THIS context is exact by definition; record it as the context's baseline.
          {
            const cs0 = getComputedStyle(el);
            const bucket0 = ((out[combo] = out[combo] || {})[""] = out[combo][""] || {});
            for (const ip of ["color"]) if (!(ip in bucket0)) bucket0[ip] = cs0.getPropertyValue(ip);
          }
          // Unclassed leaves (the check <i>, inline svg) carry the design's chip styling but no contract
          // class; harvest their computed essentials under a parent-scoped descendant selector.
          for (const leaf of el.querySelectorAll(":scope > i, :scope > svg, :scope > span:not([class])")) {
            const lc = getComputedStyle(leaf);
            const key = "LEAF>" + leaf.tagName.toLowerCase();
            const bucket = ((out[combo] = out[combo] || {})[key] = out[combo][key] || {});
            for (const lp of ["color","background-color","border-radius","font-size","width","height","display","align-items","justify-content","padding-top","padding-right","padding-bottom","padding-left","margin-right","margin-left"]) {
              const v = lc.getPropertyValue(lp);
              if (v && v !== "auto" && !(lp === "background-color" && v === "rgba(0, 0, 0, 0)")) bucket[lp] = v;
            }
          }
          // For every author rule matching this element (base or with a forceable pseudo), harvest the
          // declarations. Later rules overwrite earlier — that IS the cascade for equal-specificity
          // utilities, which is how Tailwind operates.
          for (const { r, media } of rules) {
            for (const selRaw of r.selectorText.split(",")) {
              const sel = selRaw.trim();
              // pseudo suffix of THIS selector (`:hover`, `::before`), ignoring escaped colons in names
              const pm = sel.match(/(:{1,2}(?:hover|focus-visible|focus-within|focus|active|disabled|visited|checked|placeholder|before|after|selection)(?:\([^)]*\))?)$/);
              const pseudo = pm ? pm[1] : "";
              const base = pseudo ? sel.slice(0, sel.length - pseudo.length) : sel;
              let hit = false;
              try { hit = el.matches(base); } catch { continue; }
              if (!hit) continue;
              const key = media ? `@${media}|${pseudo}` : pseudo;
              const bucket = ((out[combo] = out[combo] || {})[key] = out[combo][key] || {});
              const st = r.style;
              for (let i = 0; i < st.length; i++) {
                const prop = st[i];
                if (prop.startsWith("--tw-")) continue;          // plumbing resolved below
                let v = st.getPropertyValue(prop);
                // Resolve Tailwind plumbing against this element so values stand alone.
                if (/var\(\s*--tw-/.test(v)) {
                  const cs = getComputedStyle(el);
                  let guard = 0;
                  while (/var\(\s*--tw-/.test(v) && guard++ < 6) {
                    v = v.replace(/var\(\s*(--tw-[a-z0-9-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
                      (_, name, fb) => cs.getPropertyValue(name).trim() || (fb || "").trim() || "");
                  }
                  v = v.replace(/\s+/g, " ").trim();
                  if (!v) continue;
                }
                bucket[prop] = st.getPropertyPriority(prop) === "important" ? v : v;
              }
            }
          }
        }
        return out;
      }, CONTRACT_RE, MOD_RE);
      for (const [combo, buckets] of Object.entries(found)) {
        if (!out[combo]) { out[combo] = buckets; order.push(combo); }
        // first screen that exhibits a combo wins; later screens don't overwrite (stable source)
      }
    }
  } finally { await browser.close(); }

  // Emit: one rule per combo/pseudo, scoped; media variants wrapped. No !important anywhere.
  const lines = [];
  for (const combo of order) {
    const parts = combo.split(" ");
    const pref = parts[0].startsWith(".") ? parts.shift() + " " : "";
    const selBase = ".wjs-public-site " + pref + "." + parts.join(".");
    for (const [key, decls] of Object.entries(out[combo])) {
      if (key.startsWith("LEAF>")) {
        const NL2 = String.fromCharCode(10);
        const body = Object.entries(decls).map(([p2, v]) => "  " + p2 + ": " + v + ";").join(NL2);
        if (body) lines.push(selBase + " > " + key.slice(5) + " {" + NL2 + body + NL2 + "}");
        continue;
      }
      const media = key.startsWith("@") ? key.slice(1).split("|")[0] : null;
      const pseudo = key.startsWith("@") ? key.split("|")[1] : key;
      const body = Object.entries(decls).map(([p, v]) => `  ${p}: ${v};`).join("\n");
      if (!body) continue;
      const rule = `${selBase}${pseudo} {\n${body}\n}`;
      lines.push(media ? `@media ${media} {\n${rule}\n}` : rule);
    }
  }
  const css = lines.join("\n");

  const file = themeCss(slug);
  const cur = fs.readFileSync(file, "utf8");
  const base = cur.split(SKIN_MARK)[0].trimEnd();
  fs.writeFileSync(file, `${base}\n\n${SKIN_MARK}\n/* transpiled verbatim from the design's own stylesheet */\n${css}\n`);
  return { combos: order.length, rules: lines.length, bytes: css.length };
}

const slug = process.argv[2];
if (!slug) { console.error("uso: node scripts/stitch-transpile.mjs <tema>"); process.exit(1); }
const r = await transpile(slug);
console.log(`transpilado: ${r.combos} combos · ${r.rules} reglas · ${(r.bytes / 1024).toFixed(1)}KB → tema`);
