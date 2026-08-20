/**
 * The contract CSS, read as a specification.
 *
 * `wordjs-ui.css` already states, for every token, the exact selector and CSS property it feeds:
 *
 *     .wp-block-card__description { color: var(--wjs-card-desc-color, …) }
 *
 * So there is nothing to infer. This module parses those declarations and derives, per block:
 *   • the element tree to render (every selector the block's tokens touch)
 *   • the measurement target of each token (selector + property), verbatim from the CSS
 *
 * That removes the whole class of bugs where a convention was guessed wrong — `--wjs-accordion-header-*`
 * styles `.wp-block-accordion__header`, which no naming rule could have derived from `trigger`. Add a Puck
 * block with its rules and tokens and it is picked up here automatically.
 */

import fs from "node:fs";
import path from "node:path";
import { PUCK_SELECTORS, CHROME_SELECTORS } from "./wordjs-theme-contract.mjs";

const UI_CSS = path.resolve("backend/public/css/wordjs-ui.css");

/** Selectors that only scope the page, never an element we render in a specimen. */
const SCOPE_RE = /^(:root|html|body|\*|\.wjs-public-site|\.puck-content|\.wjs-theme-contract-v3|\.wjs-admin)/;
const STATE_RE = /::?[a-z-]+(\([^)]*\))?/g;

/** BEM root of a class: `wp-block-pricing__plan--highlighted` -> `wp-block-pricing`. */
// With the contract renamed to the hyphen convention there is no separator to split on: whether
// `wp-block-pricing-plan` is a block or a child of `wp-block-pricing` is knowledge, not syntax. The
// registry of real block roots (verified 1:1 against puckConfig) is the authority: fold every class to
// the LONGEST registry root that prefixes it, so children join their block and true roots stand alone.
const REGISTRY_ROOTS = [...PUCK_SELECTORS, ...CHROME_SELECTORS]
  .map((s) => s.slice(1))
  .sort((a, b) => b.length - a.length);
const canonical = (cls) => {
  const base = cls.split("__")[0].split("--")[0];        // tolerate leftover BEM in stale inputs
  return REGISTRY_ROOTS.find((r) => base === r || base.startsWith(r + "-")) || base;
};

/**
 * Where a `var()` sits inside a declaration's value — because a token is not always the whole property.
 *
 *   margin: 0 0 var(--wjs-heading-mb, .5em)          -> slot 2 of 3   (only the bottom side)
 *   border-left: var(--wjs-quote-bar-width, 4px) solid …  -> slot 0 of 3   (only the width)
 *   grid-template-columns: repeat(var(--wjs-posts-columns, 3), …) -> inside repeat() (a COUNT, not a track list)
 *
 * Measuring the whole property and writing it back into these produces `margin: 0 0 0px 0px 24px` and
 * `repeat(repeat(3, …), …)` — invalid, so the browser falls back and the theme silently loses the value.
 *
 * @returns {{slot:number, slots:number, fn:string|null}}
 */
function valueSlot(value, varStart) {
  // Enclosing function, if the var is an argument of one (`repeat(`, `calc(`, `minmax(`).
  let depth = 0, fn = null;
  for (let i = varStart - 1; i >= 0; i--) {
    const c = value[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) { const m = /([a-z-]+)$/i.exec(value.slice(0, i)); fn = m ? m[1] : null; break; }
      depth--;
    }
  }
  // Top-level, space-separated components of the value.
  const parts = [];
  let d = 0, start = 0;
  for (let i = 0; i <= value.length; i++) {
    const c = value[i];
    if (c === "(") d++;
    else if (c === ")") d--;
    if ((d === 0 && /\s/.test(c || " ")) || i === value.length) {
      if (i > start) parts.push([start, i]);
      start = i + 1;
    }
  }
  const slot = parts.findIndex(([a, b]) => varStart >= a && varStart < b);
  return { slot: slot < 0 ? 0 : slot, slots: parts.length || 1, fn: fn === "var" ? null : fn };
}

/** Split a selector list, drop `:where()/:is()` wrappers, and return usable descendant chains. */
function normalizeSelector(sel) {
  const unwrapped = sel.replace(/:where\(([^)]*)\)|:is\(([^)]*)\)/g, (_, a, b) => {
    const inner = (a || b || "").split(",")[0].trim();
    return SCOPE_RE.test(inner) ? "" : inner;
  });
  return unwrapped.split(",").map((s) => s.trim()).filter(Boolean).map((one) => {
    // Capture WHICH state, not just that there is one: `:hover`/`:focus`/`:active` can be forced through
    // the DevTools protocol and `::before`/`::after` read via getComputedStyle's second argument, so those
    // are measurable after all. Attribute states (`[aria-invalid="true"]`) and anything else stay opaque.
    const pseudo = (one.match(/:(hover|focus-visible|focus|active)\b/) || [])[1] || null;
    const pseudoEl = (one.match(/::(before|after)\b/) || [])[1] || null;
    const opaque = /\[[^\]]+\]/.test(one) ||
      (/::?[a-z-]+/.test(one.replace(/\.[a-z0-9_-]+/gi, "")) && !pseudo && !pseudoEl);
    const hasState = opaque ? { opaque: true } : (pseudo || pseudoEl) ? { pseudo, pseudoEl } : null;
    // Split into compounds AND the combinators between them, keeping the order.
    const parts = (one.trim().match(/[>+~]|[^\s>+~]+/g) || []).map((c) =>
      /^[>+~]$/.test(c) ? c : c.replace(/\[[^\]]*\]/g, "").replace(STATE_RE, "").trim());
    const keep = (c) =>
      // Keep bare element selectors: the contract styles `.wp-block-table__table th`, and dropping `th`
      // silently retargets the token at the table container — measured wrong on both sides of the diff.
      (c.startsWith(".") || /^[a-z][a-z0-9]*$/.test(c)) && !SCOPE_RE.test(c);
    // The chain is the ELEMENTS, used to build the skeleton's tree — there `>` and `+` are irrelevant,
    // an element either exists or it does not.
    const chain = parts.filter((c) => !/^[>+~]$/.test(c)).filter(keep);
    // The query is what we hand `querySelector`, and there the combinator is the whole meaning:
    // `.accordion__item + .accordion__item` (the divider between two items) flattened to a descendant
    // asks for an item INSIDE an item, which no skeleton ever renders — the token could never be measured.
    const query = [];
    for (const c of parts) {
      if (/^[>+~]$/.test(c)) { if (query.length && !/^[>+~]$/.test(query[query.length - 1])) query.push(c); continue; }
      if (!keep(c)) continue;
      query.push(c);
    }
    while (query.length && /^[>+~]$/.test(query[query.length - 1])) query.pop();
    return chain.length ? { chain, query: query.join(" "), hasState } : null;
  }).filter(Boolean);
}

/**
 * @returns {{blocks: Map<string, {root:string, selectors:Set<string>, tokens:Map<string,{chain:string[],prop:string,state:boolean}>}>}}
 */
export function parseContract(cssPath = UI_CSS) {
  // The contract spans TWO files: the block rules in wordjs-ui.css and the site-chrome layer (header,
  // footer, page containers) whose token consumption lives in the frontend's globals.css. Reading only
  // the first silently drops every `--wjs-header-*`/`--wjs-footer-*` token — the chrome becomes
  // unthemeable and no screen is ever planned for it.
  const paths = Array.isArray(cssPath) ? cssPath : [cssPath, path.resolve("frontend/src/app/globals.css")];
  const css = paths.map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } })
    .join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = new Map();
  const aliases = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rawSel = m[1].trim().replace(/\s+/g, " ");
    if (rawSel.startsWith("@")) continue;
    const chains = normalizeSelector(rawSel);
    if (!chains.length) continue;
    for (const decl of m[2].split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      if (!prop) continue;
      if (prop.startsWith("--")) {
        // A variant re-points a base token at its own (`.wp-block-card.card-theme-accent {
        // --wjs-card-bg: var(--wjs-card-accent-bg) }`). One hop: the referenced token is measured from
        // THIS selector, using whatever property the base token feeds. Resolved after the main pass.
        for (const t of decl.slice(i + 1).matchAll(/var\(\s*(--wjs-[a-z0-9-]+)/g)) {
          aliases.push({ token: t[1], base: prop.trim(), chains });
        }
        continue;
      }
      const value = decl.slice(i + 1);
      for (const t of value.matchAll(/var\(\s*(--wjs-[a-z0-9-]+)/g)) {
        const token = t[1];
        const slot = valueSlot(value, t.index);
        for (const { chain, query, hasState } of chains) {
          const head = chain[0].split(".").filter(Boolean)[0];
          if (!head) continue;
          // BEM: `.wp-block-card__description` and `.wp-block-pricing__plan--highlighted` belong to their
          // block even when the rule targets them without an ancestor, so fold to the canonical root.
          const root = canonical(head);
          if (!blocks.has(root)) blocks.set(root, { root, selectors: new Set(), tokens: new Map() });
          const b = blocks.get(root);
          b.selectors.add(chain.join(" "));
          // First declaration wins: the contract states the base rule before its overrides.
          if (!b.tokens.has(token)) b.tokens.set(token, { chain, query, prop, state: hasState, ...slot });
        }
      }
    }
  }

  // Resolve the one-hop variant aliases now that every base token's element and property are known.
  const infoOf = new Map();
  for (const b of blocks.values()) for (const [tok, t] of b.tokens) if (!infoOf.has(tok)) infoOf.set(tok, t);
  for (const { token, base, chains } of aliases) {
    const baseInfo = infoOf.get(base);
    if (!baseInfo) continue;
    for (const { chain, query, hasState } of chains) {
      const head = chain[0].split(".").filter(Boolean)[0];
      if (!head) continue;
      const root = canonical(head);
      if (!blocks.has(root)) continue;                   // a variant of a block we do not otherwise style
      // The variant re-points a base token, so measure the base token's OWN element, scoped inside the
      // variant: `--wjs-card-dark-title-color` is the title inside `.card-theme-dark`, not the card itself.
      const inner = baseInfo.chain.filter((c) => c.split(".").filter(Boolean)[0] !== root);
      const full = [...chain, ...inner];
      const b = blocks.get(root);
      b.selectors.add(full.join(" "));
      if (!b.tokens.has(token)) {
        b.tokens.set(token, { chain: full, query: [query, ...inner].join(" "), prop: baseInfo.prop, state: hasState });
      }
    }
  }
  return blocks;
}

/* ------------------------------------------------------------ DOM shaping */

const TAG = (cls) => {
  if (/title|heading|name/.test(cls)) return "h3";
  if (/desc|excerpt|subtitle|text|quote|answer|panel|copy/.test(cls)) return "p";
  if (/button|trigger|action|tab|toggle|control|link/.test(cls)) return "button";
  if (/input|field/.test(cls)) return "input";
  if (/^(ul|list|menu|features|nav)/.test(cls) || /-(list|menu|nav)$/.test(cls)) return "ul";
  if (/item$/.test(cls)) return "li";
  if (/img|image|thumb|avatar|logo/.test(cls)) return "img";
  return "div";
};

/** Tags that only render inside a specific parent — HTML's content model, as a lookup. */
const CONTENT_PARENT = { th: "table", td: "table", tr: "table", li: "ul", option: "select", figcaption: "figure" };
const ROW_CHILD = new Set(["th", "td"]);

const SAMPLE = (cls) => {
  if (/title|heading|name/.test(cls)) return "Section title";
  if (/desc|excerpt|subtitle|text|quote|answer|panel|copy/.test(cls)) return "Supporting copy that explains the value in one or two short lines.";
  if (/price|amount/.test(cls)) return "$29";
  if (/period|interval/.test(cls)) return "/month";
  if (/value|number|metric/.test(cls)) return "99.9%";
  if (/label|meta|cite|role|caption|date/.test(cls)) return "Label";
  if (/icon|mark|bullet|glyph/.test(cls)) return "★";
  if (/button|trigger|action|tab|toggle|control|link/.test(cls)) return "Get started";
  return "Content";
};

/**
 * Turn a block's selectors into a nested element tree, then into HTML.
 *
 * Nesting comes from two sources, in order: an explicit descendant chain in the CSS
 * (`.wp-block-accordion__item .wp-block-accordion__header`), and otherwise the BEM name itself
 * (`.wp-block-card__description` is a child of `.wp-block-card`). Modifier classes become extra
 * instances so variant tokens have a real element to measure.
 */
export function skeletonFor(block) {
  const nodes = new Map();                              // class -> {cls, mods:Set, children:Set}
  const node = (cls) => {
    if (!nodes.has(cls)) nodes.set(cls, { cls, mods: new Set(), children: new Set(), parent: null });
    return nodes.get(cls);
  };
  node(block.root);
  const parentOf = new Map();

  for (const sel of [...block.selectors].sort((a, b) => a.length - b.length)) {
    const compounds = sel.split(" ").map((c) => c.startsWith(".")
      ? { isTag: false, classes: c.split(".").filter(Boolean) }
      : { isTag: true, tag: c.split(".")[0], classes: c.split(".").filter(Boolean).slice(1) });
    let prev = null;
    for (const raw of compounds) {
      const classes = raw.classes;
      if (raw.isTag) {                                    // a bare `th`/`td`/`li`: a real tag, not a class
        const n = node(raw.tag);
        n.isTag = true;
        if (prev && prev !== raw.tag && !parentOf.has(raw.tag)) parentOf.set(raw.tag, prev);
        prev = raw.tag;
        continue;
      }
      const base = classes.find((c) => !c.includes("--")) || classes[0];
      // Strip a `--modifier` back to the element it modifies: `x__plan--highlighted` -> `x__plan`,
      // and `x--striped` -> `x` (a modifier on the block root, with no BEM element of its own).
      const part = base.includes("__") ? base.split("__")[1].split("--")[0] : null;
      const cls = base.includes("--") ? (part ? `${canonical(base)}__${part}` : canonical(base)) : base;
      const n = node(cls);
      classes.filter((c) => c !== cls).forEach((c) => n.mods.add(c));
      if (base.includes("--")) n.mods.add(base);
      if (prev && prev !== cls && !parentOf.has(cls)) parentOf.set(cls, prev);
      prev = cls;
    }
  }
  // Anything still unplaced nests inside the most specific sibling whose name CONTAINS it: first the
  // plural container (`-feature` inside `-features`), then the longest sibling that prefixes it
  // (`-audio-player-icon` inside `-audio-player-layout` does NOT prefix, but `-tabs-tab` sits under
  // `-tabs-nav` never — so only a true name prefix counts). Otherwise it hangs off the block root.
  for (const cls of nodes.keys()) {
    if (cls === block.root || parentOf.has(cls)) continue;
    const container = [...nodes.keys()]
      .filter((c) => c !== cls && c !== block.root && (c === cls + "s" || (cls.startsWith(c + "-") && nodes.get(c))))
      .sort((a, b) => b.length - a.length)[0];
    parentOf.set(cls, container || block.root);
  }
  for (const [child, parent] of parentOf) if (nodes.has(parent) && child !== parent) node(parent).children.add(child);

  // An element the contract lays out as a grid or flex row needs SIBLINGS, or there is no column count
  // and no gap to measure — the "pricing renders as one stacked banner" bug, derived instead of assumed.
  const REPEATS = 3;
  const repeats = new Set();
  for (const t of block.tokens.values()) {
    if (/grid-template-columns|^gap$|column-gap/.test(t.prop)) repeats.add(t.chain[t.chain.length - 1].split(".").filter(Boolean)[0]);
  }

  const render = (cls, depth, extraClass = "") => {
    const n = nodes.get(cls);
    const pad = "  ".repeat(depth);
    const kids = [...n.children];
    // HTML's content model is part of the contract too: `.wp-block-table__table th` only renders — and
    // only picks up table styling — if that element really is a <table> with a <tr> around its cells.
    // Infer the parent tag from the children instead of emitting a div nobody can style.
    const needed = kids.map((k) => (nodes.get(k).isTag ? CONTENT_PARENT[k] : null)).find(Boolean);
    const tag = n.isTag ? cls : needed || (kids.length ? "div" : TAG(cls));
    const attr = n.isTag ? "" : `class="${cls}${extraClass ? " " + extraClass : ""}"`;
    if (tag === "input") return `${pad}<input ${attr} placeholder="Your email" />`;
    if (tag === "img") return `${pad}<img ${attr} src="https://placehold.co/600x400" alt="" />`;
    const renderKids = () => kids.flatMap((k) => {
      // Siblings are only meaningful for a COLLECTION item: the single child class of a homogeneous grid
      // (posts in a grid), or a child that carries a variant modifier and therefore needs one instance per
      // variant (pricing plans with `is-highlighted`). A container with several distinct, unmodified child
      // classes (a banner's title + button + subtitle) uses its gap as internal spacing — tripling those
      // would hand Stitch markup no real page ever renders.
      const isCollectionItem = kids.length === 1 || nodes.get(k).mods.size > 0;
      if (!repeats.has(cls) || !isCollectionItem) return [render(k, depth + 1)];
      // Repeat the child, spending one repeat on each of its modifiers so variants sit inline.
      const mods = [...nodes.get(k).mods];
      return Array.from({ length: Math.max(REPEATS, mods.length + 1) }, (_, i) => render(k, depth + 1, mods[i - 1] || ""));
    });
    let rendered = renderKids();
    // Cells need a row around them for the table to lay out at all.
    if (kids.some((k) => nodes.get(k).isTag && ROW_CHILD.has(k))) rendered = [`${pad}  <tr>`, ...rendered, `${pad}  </tr>`];
    const inner = kids.length ? "\n" + rendered.join("\n") + "\n" + pad : SAMPLE(cls);
    return `${pad}<${tag}${attr ? " " + attr : ""}>${inner}</${tag}>`;
  };

  const out = [render(block.root, 0)];
  for (const mod of nodes.get(block.root).mods) out.push(render(block.root, 0, mod));
  // A modifier on an inner element that is NOT inside a repeated container still needs an instance.
  for (const [cls, n] of nodes) {
    if (cls === block.root || repeats.has(parentOf.get(cls))) continue;
    for (const mod of n.mods) {
      const one = render(block.root, 0).replace(`class="${cls}"`, `class="${cls} ${mod}"`);
      if (!out.includes(one)) out.push(one);
    }
  }
  return out.join("\n");
}

/** Per-token measurement target: the selector to query and the property to read. */
export function measureTargets(block) {
  const out = [];
  for (const [token, { chain, query, prop, state, slot, slots, fn }] of block.tokens) {
    if (state?.opaque) continue;                          // attribute/`:nth` states cannot be reproduced
    out.push({ token, selector: query || chain.join(" "), prop, slot, slots, fn, ...(state || {}) });
  }
  return out;
}

/** All blocks that have at least one measurable token, largest first. */
export function deriveContractBlocks(cssPath = UI_CSS) {
  return [...parseContract(cssPath).values()]
    .map((b) => ({ ...b, targets: measureTargets(b), html: skeletonFor(b) }))
    .filter((b) => b.targets.length)
    .sort((a, b) => b.targets.length - a.targets.length);
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); }
  catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const blocks = deriveContractBlocks();
  const want = args.includes("--block") ? args[args.indexOf("--block") + 1] : null;
  if (want) {
    const b = blocks.find((x) => x.root === want || x.root === `wp-block-${want}`);
    if (!b) { console.error(`desconocido: ${want}`); process.exit(1); }
    console.log(b.html);
    console.log(`\n/* ${b.targets.length} tokens medibles */`);
  } else {
    const tot = blocks.reduce((n, b) => n + b.targets.length, 0);
    console.log(`Bloques con tokens medibles: ${blocks.length}  ·  tokens: ${tot}\n`);
    console.log("BLOQUE".padEnd(34) + "ELEMS".padStart(6) + "TOKENS".padStart(8));
    for (const b of blocks.slice(0, 24)) console.log(b.root.padEnd(34) + String(b.selectors.size).padStart(6) + String(b.targets.length).padStart(8));
  }
}
