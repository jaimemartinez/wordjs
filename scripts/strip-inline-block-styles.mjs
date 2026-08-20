/**
 * Remove the hardcoded inline styles the Puck block components write onto their own elements.
 *
 * An inline style outranks every stylesheet, so any property a component writes inline is a property no
 * theme can ever change. That is why themes could only ever restyle a block's outermost element: the ~85
 * nested ones (card title, pricing children, hero copy, accordion trigger…) had their geometry and type
 * scale baked in at render time.
 *
 * A declaration is removed ONLY when the contract (backend/public/css/wordjs-ui.css) demonstrably declares
 * that same CSS property for that element's own class — so the pixel keeps its value, but now through a
 * token a theme can override. Anything the contract does not cover is left alone and reported, because
 * deleting it would silently drop styling instead of moving it.
 *
 *   node scripts/strip-inline-block-styles.mjs            # dry run: what would change
 *   node scripts/strip-inline-block-styles.mjs --write
 */

import fs from "node:fs";
import path from "node:path";

const TSX = path.resolve("frontend/src/components/puckConfig.tsx");
const UI = path.resolve("backend/public/css/wordjs-ui.css");

const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/** class -> set of CSS properties the contract declares for it (as the selector's own subject). */
function contractProperties(cssPath = UI) {
  const css = fs.readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const map = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].trim();
    if (selectors.startsWith("@")) continue;
    const props = [...m[2].matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map((d) => d[2]).filter((p) => !p.startsWith("--"));
    if (!props.length) continue;
    for (const one of selectors.split(",")) {
      // The SUBJECT of the selector is its last compound; that is the element being styled.
      const last = one.trim().split(/\s+|>/).filter(Boolean).pop() || "";
      for (const cls of last.split(".").filter(Boolean).map((c) => c.replace(/[:[].*$/, ""))) {
        if (!/^(wp-block|wjs-)/.test(cls)) continue;
        if (!map.has(cls)) map.set(cls, new Set());
        for (const p of props) map.get(cls).add(p);
      }
    }
  }
  return map;
}

/**
 * Shorthands the contract may use to cover a longhand the component writes inline: a rule declaring
 * `border` already governs `border-width/style/color`, so an inline `borderColor` is still redundant.
 */
const SHORTHAND_COVERS = {
  background: [/^background-/],
  border: [/^border-(top|right|bottom|left)?-?(width|style|color)$/],
  "border-width": [/^border-(top|right|bottom|left)-width$/],
  "border-color": [/^border-(top|right|bottom|left)-color$/],
  "border-radius": [/^border-.*-radius$/],
  margin: [/^margin-/],
  padding: [/^padding-/],
  font: [/^font-/],
  flex: [/^flex-(grow|shrink|basis)$/],
  gap: [/^(row|column)-gap$/],
  inset: [/^(top|right|bottom|left)$/],
};

function contractCovers(owned, prop) {
  if (owned.has(prop)) return true;
  for (const [shorthand, patterns] of Object.entries(SHORTHAND_COVERS)) {
    if (owned.has(shorthand) && patterns.some((re) => re.test(prop))) return true;
  }
  return false;
}

/**
 * A literal value is a hardcoded default and safe to drop once the contract covers it. A value that
 * references anything else — a prop, a ternary, a template — is the user's per-instance authoring, and
 * deleting it would silently change what they built. Those are kept and reported for conversion.
 */
function isLiteral(value) {
  const v = value.trim();
  if (/^-?[\d.]+$/.test(v)) return true;
  if (/^(["'])(?:(?!\1).)*\1$/.test(v)) return true;
  // A template literal with no `${}` is just a string — including the `var(--puck-…, var(--wjs-…))`
  // fallback chains the components invented, which are hardcoded defaults, not per-instance authoring.
  return /^`[^`]*`$/.test(v) && !v.includes("${");
}

/** Split an object literal body into top-level entries, respecting nesting and template literals. */
function splitEntries(body) {
  const out = [];
  let depth = 0, start = 0, tpl = false, str = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (str) { if (c === str && body[i - 1] !== "\\") str = null; continue; }
    if (tpl) { if (c === "`" && body[i - 1] !== "\\") tpl = false; continue; }
    if (c === '"' || c === "'") { str = c; continue; }
    if (c === "`") { tpl = true; continue; }
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  if (body.slice(start).trim()) out.push(body.slice(start));
  return out;
}

/** The property name an entry declares, or null for a spread / computed key. */
function entryKey(entry) {
  const t = entry.trim();
  if (t.startsWith("...")) return null;
  const m = /^["']?([A-Za-z-]+)["']?\s*:/.exec(t);
  return m ? m[1] : null;
}

const source = fs.readFileSync(TSX, "utf8");
const contract = contractProperties();
const write = process.argv.includes("--write");

let out = "", cursor = 0, removed = 0, keptEntries = [], attrsDropped = 0;
let i = 0;
while ((i = source.indexOf("style={{", i)) >= 0) {
  // Locate the object literal and the JSX expression separately. `style={{…} as React.CSSProperties}`
  // puts a suffix between the two closing braces, so scanning only for the outer brace swallows the cast
  // and scanning only for the inner one leaves the outer `}` orphaned in the source.
  let depth = 0, innerEnd = -1;
  for (let j = i + 7; j < source.length; j++) {
    if (source[j] === "{") depth++;
    else if (source[j] === "}") { depth--; if (depth === 0) { innerEnd = j; break; } }
  }
  if (innerEnd < 0) break;
  let end = -1;
  for (let j = innerEnd + 1; j < source.length; j++) if (source[j] === "}") { end = j + 1; break; }
  if (end < 0) break;
  const suffix = source.slice(innerEnd + 1, end - 1);   // e.g. " as React.CSSProperties"

  const tagStart = source.lastIndexOf("<", i);
  const tag = source.slice(tagStart, i);
  const cm = /className=["`]([^"`]*)/.exec(tag) || /className=\{`([^`]*)/.exec(tag);
  const classes = cm ? cm[1].split(/\s+/).filter((c) => /^(wp-block|wjs-)/.test(c)) : [];
  const owned = new Set();
  for (const c of classes) for (const p of contract.get(c) || []) owned.add(p);

  const body = source.slice(i + 8, innerEnd);
  const entries = splitEntries(body);
  const kept = [];
  for (const e of entries) {
    const key = entryKey(e);
    if (key === null) { kept.push(e); continue; }          // ...css escape hatch stays
    const value = e.slice(e.indexOf(":") + 1);
    if (contractCovers(owned, kebab(key)) && isLiteral(value)) { removed++; continue; }
    kept.push(e);
    keptEntries.push({
      line: source.slice(0, i).split("\n").length, cls: classes[0] || "(sin clase)", key,
      why: !contractCovers(owned, kebab(key)) ? "sin-regla-en-contrato" : "valor-dinamico",
    });
  }

  out += source.slice(cursor, i);
  const meaningful = kept.filter((k) => k.trim());
  if (!meaningful.length) { attrsDropped++; out = out.replace(/\s*$/, ""); }
  else out += `style={{${meaningful.join(",")} }${suffix}}`;
  cursor = end;
  i = end;
}
out += source.slice(cursor);

console.log(`declaraciones eliminadas (el contrato ya las declara): ${removed}`);
console.log(`atributos style eliminados por completo: ${attrsDropped}`);
console.log(`declaraciones CONSERVADAS (el contrato no las cubre): ${keptEntries.length}`);
const byKey = {};
for (const k of keptEntries) byKey[`${k.why} · ${k.cls} · ${k.key}`] = (byKey[`${k.why} · ${k.cls} · ${k.key}`] || 0) + 1;
for (const [k, n] of Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`   ${n}x  ${k}`);

if (write) { fs.writeFileSync(TSX, out); console.log("\n-> puckConfig.tsx reescrito"); }
else console.log("\n(dry run — usa --write para aplicar)");
