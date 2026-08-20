/**
 * Convention-driven mapping of MEASURED Stitch styles onto the REAL WordJS token contract.
 *
 * wordjs-ui.css owns every `.wp-block-*` / `.wjs-*` rule and reads ~660 tokens named
 * `--wjs-<component>-<suffix>` (e.g. `--wjs-card-pad`, `--wjs-button-pad-y`, `--wjs-audio-bg`).
 * A theme supplies VALUES for those tokens — exactly the model Bootstrap 5.3 (`--bs-card-bg`,
 * `--bs-btn-padding-y`) and WordPress theme.json (per-block styles compiled to custom properties) use.
 *
 * Rather than hand-writing 660 mappings, this module derives them:
 *   token  --wjs-<component>-<suffix>
 *          └── component → the measured DOM role (COMPONENT_ROLE)
 *          └── suffix    → the measured CSS property (SUFFIX_SOURCE)
 * so any token the contract adds later is filled automatically as long as its component has a role.
 *
 * The inventory is parsed from the live wordjs-ui.css at convert time, so the theme can never drift
 * from the contract it is meant to fill.
 */

import fs from "node:fs";

// ---- contract inventory -----------------------------------------------------------------------

/** Every `--wjs-*` token wordjs-ui.css READS (these are the ones a theme can control). */
export function readContractTokens(uiCssPath) {
  const css = fs.readFileSync(uiCssPath, "utf8");
  return [...new Set([...css.matchAll(/var\(\s*(--wjs-[a-z0-9-]+)/g)].map((m) => m[1]))];
}

// ---- BEM bridge ----------------------------------------------------------------------------------

/**
 * The shipped contract styles BEM elements (`.wp-block-card__title`, `.wp-block-button__link`, …) — 82
 * classes across ~176 rule references — but this install's React components render the dash form
 * (`.wp-block-card-title`). Every one of those contract rules therefore matches nothing, so the tokens the
 * theme fills have no effect on those sub-elements.
 *
 * Rather than editing the framework or the components, mirror the contract: clone each rule whose selector
 * contains a `wp-block-<block>__<part>` class, rewriting it to the dash form this DOM actually uses. The
 * clone carries the SAME `var(--wjs-*)` declarations, so it cannot disagree with the contract — it just
 * reaches the elements the contract meant to style. Emitted into the theme, which loads after the
 * framework. Returns CSS text ('' when the install already uses BEM markup).
 */
export function buildBemBridge(uiCssPath) {
  const css = fs.readFileSync(uiCssPath, "utf8");
  const out = [];
  // Match `selector { decls }` at any nesting depth we care about (media blocks are handled by keeping
  // their @media wrapper around the cloned rule).
  const ruleRe = /(@media[^{]+\{)?\s*([^{}@]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css))) {
    const [, media, selector, decls] = m;
    if (!/wp-block-[a-z0-9-]+__[a-z0-9-]+/.test(selector)) continue;
    if (!decls.trim()) continue;
    const bridged = selector.replace(/(wp-block-[a-z0-9-]+)__([a-z0-9-]+)/g, "$1-$2");
    if (bridged === selector) continue;
    const rule = `${bridged.trim()} {${decls.trimEnd()} }`;
    out.push(media ? `${media.trim()} ${rule} }` : rule);
  }
  // Structural compatibility: the contract centres content through an INNER wrapper
  // (`.wp-block-section__inner { max-width; margin-inline: auto }`) and unstyles nav links — but these
  // components render no inner element at all, so sections span the full viewport flush to the edge and
  // nav links keep the UA underline. That reads as "nothing matches the design" even when every colour and
  // size token is correct, because layout dominates perception. Re-home those declarations onto the
  // elements this DOM does render.
  const structural = `
/* Structural compatibility: this install renders no .wp-block-section inner wrapper, so the contract's
 * centring never applies. Re-home max-width/gutter onto the elements that exist. */
.wjs-public-site .wp-block-section,
.wjs-public-site .wjs-header-container,
.wjs-public-site .wjs-footer-grid {
  max-width: var(--wjs-section-max-width, var(--wjs-container-max, 1140px));
  margin-inline: auto;
  padding-inline: var(--wjs-section-gutter, 24px);
}
.wjs-public-site .wp-block-hero > * {
  max-width: var(--wjs-section-max-width, var(--wjs-container-max, 1140px));
  margin-inline: auto;
  width: 100%;
}
.wjs-public-site .wjs-header-nav a,
.wjs-public-site .wjs-footer-menu a,
.wjs-public-site .wp-block-button,
.wjs-public-site .wp-block-button-link { text-decoration: none; }
`;

  return out.length || structural
    ? `/* Contract BEM bridge: the shipped contract targets .wp-block-*__* while this install's components\n * render .wp-block-*-*. Same declarations, reachable selectors. */\n${out.join("\n")}\n${structural}`
    : "";
}

// ---- component → measured role ------------------------------------------------------------------
// Longest prefix wins, so `card-icon` is matched before `card`.
const COMPONENT_ROLE = {
  // cards
  "card-icon": "cardIcon", "card-title": "cardTitle", "card-desc": "cardDesc", card: "card",
  // buttons (the contract's canonical button == the design's primary CTA)
  button: "heroBtnPrimary", "button-secondary": "heroBtnSecondary",
  // hero
  "hero-title": "h1", "hero-subtitle": "heroSubtitle", "hero-actions": "heroBtnPrimary", hero: "hero",
  // headings / text
  heading: "h2", text: "body",
  // chrome
  header: "nav", nav: "nav", "nav-link": "navLink", logo: "navLink",
  footer: "footer", "footer-link": "footerLink", "footer-heading": "footerHeading",
  // sections / layout
  section: "hero", container: "container", grid: "grid",
  // stats
  "stats-value": "statValue", "stats-label": "statLabel", stats: "stats",
  // pricing
  "pricing-price": "pricingPrice", "pricing-name": "cardTitle",
  "pricing-plan": "pricingPlan", "pricing-highlight": "pricingHighlighted", pricing: "pricingPlan",
  // accordion
  "accordion-trigger": "accordionTrigger", "accordion-panel": "accordionPanel",
  "accordion-item": "accordionTrigger", accordion: "accordionTrigger",
  // tabs
  "tabs-tab": "tab", "tabs-panel": "tabPanel", "tabs-list": "tab", tabs: "tab",
  // table
  "table-head": "tableHead", "table-cell": "tableCell", "table-row": "tableCell", table: "tableCell",
  // media
  "audio-title": "audioTitle", "audio-track": "audioTrack", "audio-progress": "audioProgress",
  "audio-icon": "audioControl", "audio-control": "audioControl", audio: "audioPlayer",
  "video-placeholder": "videoPlaceholder", "video-frame": "videoFrame", video: "videoFrame",
  // posts
  "posts-title": "postTitle", "posts-meta": "badge", "posts-item": "postCard", posts: "postCard",
  // testimonial / quote
  "testimonial-quote": "quote", "testimonial-name": "cardDesc", testimonial: "testimonialCard",
  quote: "quote",
  // cta
  "cta-title": "h2", cta: "ctaBanner",
  // search
  "search-input": "formInput", "search-button": "formSubmit", search: "formInput",
  // misc
  "icon-list": "iconListItem", icon: "iconListIcon", social: "footerLink", badge: "badge",
};

// ---- suffix → measured CSS property --------------------------------------------------------------
// value: [measuredProperty, optional transform]
const px = (v) => (v && /^-?\d*\.?\d+px$/.test(String(v).trim()) ? v : v);
export const SUFFIX_SOURCE = {
  color: ["color"],
  // A gradient wins over the flat color; a genuinely UNFILLED element keeps an explicit `transparent`
  // (outline buttons, ghost cards) instead of being dropped — dropping it lets the component fall back to
  // the framework/primary fill and an outline button renders as a solid one.
  bg: ["backgroundColor", (v, role) => {
    if (role?.backgroundImage && /gradient/i.test(role.backgroundImage)) return role.backgroundImage;
    const m = String(v || "").match(/rgba?\(([^)]+)\)/i);
    if (m) { const p = m[1].split(",").map(parseFloat); if (p.length === 4 && p[3] === 0) return "transparent"; }
    return v;
  }],
  size: ["fontSize"],
  family: ["fontFamily", (v) => String(v || "").split(",")[0].replace(/^["']|["']$/g, "").trim()],
  weight: ["fontWeight"],
  radius: ["borderRadius"],
  shadow: ["boxShadow"],
  pad: ["padding"],
  "pad-x": ["padding", (v) => { const p = String(v || "").trim().split(/\s+/); return p[1] || p[0]; }],
  "pad-y": ["padding", (v) => String(v || "").trim().split(/\s+/)[0]],
  "border-color": ["borderTopColor"],
  "border-width": ["borderTopWidth"],
  tracking: ["letterSpacing", (v) => (v === "normal" ? "0px" : v)],
  transform: ["textTransform"],
  gap: ["gap", (v) => (v === "normal" ? null : v)],
  leading: ["lineHeight", (v, role) => {
    const lh = parseFloat(v), fs = parseFloat(role?.fontSize);
    return lh && fs ? String(Math.round((lh / fs) * 100) / 100) : v;
  }],
  width: ["maxWidth"],
  height: ["minHeight"],
  opacity: ["opacity"],
  align: ["textAlign"],
  justify: ["justifyContent"],
  columns: ["gridTemplateColumns", (v) => { const n = String(v || "").trim().split(/\s+/).filter(Boolean).length; return n > 1 ? String(n) : null; }],
  aspect: ["aspectRatio"],
  mb: ["marginBottom", px],
  // Long-form spellings the contract also uses for the same property, so `--wjs-heading-line-height`
  // is measured rather than silently dropped as an unknown suffix.
  "line-height": ["lineHeight", (v, role) => {
    const lh = parseFloat(v), fs = parseFloat(role?.fontSize);
    return lh && fs ? String(Math.round((lh / fs) * 100) / 100) : v;
  }],
  "font-weight": ["fontWeight"],
  "min-height": ["minHeight"],
  "flex-direction": ["flexDirection"],
  "flex-wrap": ["flexWrap"],
  measure: ["maxWidth"],
  max: ["maxWidth"],
  template: ["gridTemplateColumns"],
  fit: ["objectFit"],
  mt: ["marginTop", px],
  display: ["display"],
  overflow: ["overflow"],
};

// `transparent` is deliberately ABSENT: the bg transform emits it on purpose for outline/ghost elements.
const EMPTY = new Set(["", "none", "normal", "auto", "rgba(0, 0, 0, 0)", "0px", "0s", "normal normal"]);
const isMeaningful = (v) => v !== null && v !== undefined && !EMPTY.has(String(v).trim());

/** Split `--wjs-card-icon-bg` into { component:'card-icon', suffix:'bg' } using longest-suffix/prefix match. */
export function splitToken(token) {
  const body = token.replace(/^--wjs-/, "");
  // try 2-segment suffixes first (border-color, pad-x, …), then 1-segment
  const parts = body.split("-");
  for (const take of [2, 1]) {
    if (parts.length <= take) continue;
    const suffix = parts.slice(-take).join("-");
    if (!SUFFIX_SOURCE[suffix]) continue;
    const component = parts.slice(0, -take).join("-");
    if (component) return { component, suffix };
  }
  return null;
}

// Components whose contract prefix covers BOTH a layout container and the item inside it: the contract
// names a plan's fill `--wjs-pricing-bg` and the grid's track count `--wjs-pricing-columns` under the same
// `pricing` prefix. Measuring both from one element is wrong — reading `columns` off a single PLAN yields a
// one-column grid (the "pricing renders as stacked full-width banners" bug). Route layout suffixes to the
// container role and everything else to the item role.
const LAYOUT_SUFFIXES = new Set(["gap", "columns", "justify", "align", "width"]);
const CONTAINER_ROLE = { pricing: "pricing", stats: "stats", grid: "grid", posts: "postsGrid", "icon-list": "iconList" };

/** Longest-prefix component → role lookup (so `card-icon` beats `card`). */
function roleNameFor(component, suffix) {
  if (suffix && LAYOUT_SUFFIXES.has(suffix) && CONTAINER_ROLE[component]) return CONTAINER_ROLE[component];
  if (COMPONENT_ROLE[component]) return COMPONENT_ROLE[component];
  const parts = component.split("-");
  for (let i = parts.length - 1; i > 0; i--) {
    const cand = parts.slice(0, i).join("-");
    if (COMPONENT_ROLE[cand]) return COMPONENT_ROLE[cand];
  }
  return null;
}

/**
 * Fill the real contract from measurements.
 * @param {Record<string, any>} measures  role -> computed style object (scripts/stitch-measure.mjs)
 * @param {string[]} contractTokens       tokens wordjs-ui.css reads (readContractTokens)
 * @returns {{tokens: Record<string,string>, filled: number, skipped: number}}
 */
// ---- contrast guard ------------------------------------------------------------------------------
// Relative luminance / WCAG contrast on rgb()/rgba()/hex values.
function toRgb(v) {
  const s = String(v || "").trim();
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(",").map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; }
  const h = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (h) {
    const x = h[1].length === 3 ? h[1].split("").map((c) => c + c).join("") : h[1];
    return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: 1 };
  }
  return null;
}
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

/**
 * A measured design can pair a component's TEXT color with a background this theme measured from a
 * different surface (e.g. the Stitch hero is light, so its heading ink is near-black — but the WordJS
 * hero renders on a dark fill, leaving dark-on-dark text). After mapping, re-check each component whose
 * `-color` and `-bg` were both emitted and flip the ink to white/near-black when contrast is unusable.
 */
export function enforceContrast(tokens) {
  let fixed = 0;
  for (const token of Object.keys(tokens)) {
    if (!token.endsWith("-color")) continue;
    const bgToken = token.replace(/-color$/, "-bg");
    const fg = toRgb(tokens[token]);
    const bg = toRgb(tokens[bgToken]);
    if (!fg || !bg || bg.a === 0) continue;
    if (contrast(fg, bg) >= 3) continue;
    tokens[token] = lum(bg) > 0.45 ? "#111111" : "#ffffff";
    fixed++;
  }
  return fixed;
}

export function mapContractTokens(measures, contractTokens) {
  const tokens = {};
  let filled = 0, skipped = 0;
  for (const token of contractTokens) {
    const split = splitToken(token);
    if (!split) { skipped++; continue; }
    const roleName = roleNameFor(split.component, split.suffix);
    const role = roleName ? measures[roleName] : null;
    if (!role) { skipped++; continue; }
    const [prop, transform] = SUFFIX_SOURCE[split.suffix];
    let value = role[prop];
    if (transform) value = transform(value, role);
    if (!isMeaningful(value)) { skipped++; continue; }
    tokens[token] = String(value).trim();
    filled++;
  }
  // The Hero block paints its own background INLINE as
  // `linear-gradient(135deg, var(--wjs-color-primary), #111827)` whenever the instance has no image
  // (frontend/src/components/puckConfig.tsx), and an inline style beats every stylesheet — so the hero's
  // real backdrop is a primary-derived DARK gradient, not the (often light) surface this theme measured.
  // Pin the hero ink to that actual backdrop, otherwise a design with dark body text renders
  // dark-on-dark and the hero headline becomes invisible.
  // `--wjs-color-primary` is produced by the semantic mapper, not here, so read the brand color from the
  // same measured source it uses: the primary CTA's painted fill (nav CTA as fallback).
  const contrastFixed = enforceContrast(tokens);

  // Applied AFTER the generic guard on purpose: that guard checks the hero ink against `--wjs-hero-bg`
  // (the light surface measured from the design) and would flip this pin straight back to dark ink.
  // `--wjs-color-primary` is produced by the semantic mapper, not here, so read the brand color from the
  // same measured source it uses: the primary CTA's painted fill (nav CTA as fallback).
  const primary = toRgb(tokens["--wjs-color-primary"])
    || toRgb(measures?.heroBtnPrimary?.backgroundColor)
    || toRgb(measures?.navCta?.backgroundColor);
  if (primary && primary.a !== 0) {
    const heroInk = lum(primary) > 0.45 ? "#111111" : "#ffffff";
    for (const t of ["--wjs-hero-color", "--wjs-hero-title-color", "--wjs-hero-subtitle-color", "--wjs-hero-overlay-color"]) {
      if (contractTokens.includes(t) || tokens[t]) tokens[t] = heroInk;
    }
  }

  return { tokens, filled, skipped, contrastFixed };
}

export default mapContractTokens;
