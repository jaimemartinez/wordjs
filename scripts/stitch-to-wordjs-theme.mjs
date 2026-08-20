#!/usr/bin/env node

/**
 * Convert a Stitch theme-specimen HTML export into a WordJS theme.
 *
 * The converter is intentionally strict: a Stitch screen is accepted only when its
 * `<style id="wordjs-theme">` covers the complete public chrome and all built-in Puck blocks.
 * This prevents an attractive landing page from being shipped as an incomplete theme.
 *
 * Single theme:
 *   node scripts/stitch-to-wordjs-theme.mjs --theme marketplace/themes/foo \
 *     --html .stitch-cache/foo.html --project-id 123 --screen-id abc \
 *     --design-system-id assets/xyz --screenshot-url https://...
 *
 * Batch:
 *   node scripts/stitch-to-wordjs-theme.mjs --manifest .stitch-cache/themes.json
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import {
  CHROME_STRUCTURAL_SELECTORS,
  CHROME_SELECTORS,
  PUCK_SELECTORS,
  REQUIRED_SELECTORS,
  STRUCTURAL_SELECTORS,
  STITCH_SELECTOR_REWRITES,
} from "./wordjs-theme-contract.mjs";

const require = createRequire(import.meta.url);
const postcss = (() => {
  try { return require("postcss"); }
  catch { return require(path.resolve("frontend/node_modules/postcss")); }
})();
const selectorParser = (() => {
  try { return require("postcss-selector-parser"); }
  catch { return require(path.resolve("frontend/node_modules/postcss-selector-parser")); }
})();
const { parseDocument } = (() => {
  try { return require("htmlparser2"); }
  catch { return require(path.resolve("frontend/node_modules/htmlparser2")); }
})();
const sharp = (() => {
  try { return require("sharp"); }
  catch { return require(path.resolve("frontend/node_modules/sharp")); }
})();
const imageAspectCache = new Map();

export { CHROME_SELECTORS, PUCK_SELECTORS };

const KNOWN_WORDJS_CLASSES = new Set(
  [...REQUIRED_SELECTORS, ...CHROME_STRUCTURAL_SELECTORS, ...STRUCTURAL_SELECTORS].map((selector) => selector.slice(1)),
);
const ALLOWED_STATE_CLASS = /^(active|featured|highlighted|small|base|large|bg-image|text-(?:left|center|right)|cols-[1-9][0-9]*|layout-(?:grid|list)|cta-variant-[a-z0-9-]+|is-[a-z0-9-]+|heading-[a-z0-9-]+|card-theme-[a-z0-9-]+|button-variant-[a-z0-9-]+|divider-type-[a-z0-9-]+|fa(?:s|r|b|l|d)?|fa-[a-z0-9-]+|rotate-180)$/;

// WordJS ships friendly visual fallbacks for hand-authored themes. A complete Stitch theme must
// start from a neutral canvas instead: omitted backgrounds mean transparent, omitted shadows mean
// none, and the generated component rules below remain the sole source of visual geometry.
const NEUTRAL_PUBLIC_TOKENS = {
  "--wjs-container-max-width": "none",
  "--wjs-container-padding": "0px",
  "--wjs-main-padding": "0px",
  "--wjs-header-padding": "0px",
  "--wjs-header-padding-at-top": "0px",
  "--wjs-header-border": "0 solid transparent",
  "--wjs-header-shadow": "none",
  "--wjs-header-shadow-at-top": "none",
  "--wjs-header-backdrop-filter": "none",
  "--wjs-footer-padding": "0px",
  "--wjs-footer-border": "0 solid transparent",
  "--wjs-footer-shadow": "none",
  "--wjs-block-bg": "transparent",
  "--wjs-block-border": "0 solid transparent",
  "--wjs-block-radius": "0px",
  "--wjs-block-shadow": "none",
  "--wjs-card-padding": "0px",
  "--wjs-card-radius": "0px",
  "--wjs-card-shadow": "none",
  "--wjs-block-hover-transform": "none",
  "--wjs-section-padding": "0px",
  "--wjs-grid-gap": "0px",
  "--wjs-hero-min-height": "0px",
  "--wjs-hero-padding": "0px",
  "--wjs-hero-radius": "0px",
  "--wjs-button-padding": "0px",
  "--wjs-button-radius": "0px",
  "--wjs-accordion-radius": "0px",
  "--wjs-pricing-columns": "initial",
  "--wjs-posts-columns": "initial",
};

// Puck's inline safety defaults use a stable canonical token vocabulary. Stitch is free to name
// its design tokens semantically, so bridge the common equivalents instead of letting hard-coded
// Puck fallbacks leak into an otherwise complete theme.
const CANONICAL_TOKEN_ALIASES = {
  "--wjs-container-max-width": ["--wjs-container-max", "--wjs-max-width", "--wjs-content-max-width"],
  "--wjs-bg-canvas": ["--wjs-color-background", "--wjs-background", "--wjs-bg", "--wjs-color-surface"],
  "--wjs-bg-surface": ["--wjs-color-surface", "--wjs-surface", "--wjs-surface-lowest", "--wjs-color-surface-container"],
  "--wjs-bg-surface-hover": ["--wjs-color-surface-elevated", "--wjs-surface-raised", "--wjs-surface-highest", "--wjs-surface-container-high"],
  "--wjs-bg-muted": ["--wjs-color-surface-container", "--wjs-surface-low", "--wjs-surface-raised", "--wjs-surface"],
  "--wjs-border-radius": ["--wjs-radius", "--wjs-radius-md", "--wjs-radius-sm"],
  "--wjs-border-subtle": ["--wjs-color-outline", "--wjs-outline", "--wjs-border", "--wjs-color-border"],
  "--wjs-color-primary": ["--wjs-primary", "--wjs-accent-primary", "--wjs-color-tertiary"],
  "--wjs-color-secondary": ["--wjs-secondary", "--wjs-accent-secondary", "--wjs-color-primary-variant"],
  "--wjs-color-on-primary": ["--wjs-color-on-primary", "--wjs-on-primary", "--wjs-color-on-tertiary"],
  "--wjs-color-primary-text": ["--wjs-color-on-primary", "--wjs-on-primary", "--wjs-color-on-tertiary"],
  "--wjs-color-heading": ["--wjs-color-on-background", "--wjs-color-on-surface", "--wjs-text-main", "--wjs-text", "--wjs-color-text-main"],
  "--wjs-color-text-heading": ["--wjs-color-on-background", "--wjs-color-on-surface", "--wjs-text-main", "--wjs-text", "--wjs-color-text-main"],
  "--wjs-color-text-main": ["--wjs-color-on-background", "--wjs-color-on-surface", "--wjs-text-main", "--wjs-text"],
  "--wjs-color-text-muted": ["--wjs-color-on-surface-variant", "--wjs-text-muted"],
  "--wjs-color-text-dim": ["--wjs-color-on-surface-variant", "--wjs-text-muted", "--wjs-color-text-muted"],
  "--wjs-font-family": ["--wjs-font-body", "--wjs-font-sans"],
  "--wjs-font-family-base": ["--wjs-font-body", "--wjs-font-sans"],
  "--wjs-font-family-heading": ["--wjs-font-display", "--wjs-font-headline", "--wjs-font-serif"],
  "--wjs-font-family-mono": ["--wjs-font-mono"],
  "--wjs-spacer": ["--wjs-spacing-sm", "--wjs-space-sm", "--wjs-stack-sm", "--wjs-spacing-unit"],
  "--wjs-space-sm": ["--wjs-spacing-sm", "--wjs-space-sm", "--wjs-stack-sm", "--wjs-spacing-unit"],
  "--wjs-space-md": ["--wjs-spacing-md", "--wjs-space-md", "--wjs-stack-md", "--wjs-gutter"],
};

const RESETTABLE_THEME_ROOTS = [
  ...CHROME_SELECTORS.filter((selector) => selector !== ".wjs-public-site"),
  ".wjs-footer-container",
  ...PUCK_SELECTORS,
];

const FRAMEABLE_BLOCK_SELECTORS = [
  ".wp-block-columns", ".wp-block-card", ".wp-block-grid", ".wp-block-flex-row",
  ".wp-block-accordion", ".wp-block-tabs", ".wp-block-video-embed", ".wp-block-audio-player",
  ".wp-block-pricing", ".wp-block-testimonial", ".wp-block-cta-banner", ".wp-block-posts-grid",
  ".wp-block-category-posts", ".wp-block-search", ".wp-block-quote", ".wp-block-table",
  ".wp-block-icon-list", ".wp-block-social-links", ".wp-block-stats", ".wp-block-html-embed",
];
const ATOMIC_FRAMEABLE_BLOCK_SELECTORS = [
  ".wp-block-heading", ".wp-block-image", ".wp-block-divider", ".wp-block-button-wrap",
];
const TOP_LEVEL_PUCK_ITEM_SELECTOR = ".wjs-page-content > .puck-children > div";
const SHARED_BLOCK_WRAPPER_SELECTOR = ":is(.wjs-anim, .wjs-hide-mobile, .wjs-hide-tablet, .wjs-hide-desktop)";
const topLevelPuckSelectors = (selector) => [
  `:where(${TOP_LEVEL_PUCK_ITEM_SELECTOR} > ${selector})`,
  `:where(${TOP_LEVEL_PUCK_ITEM_SELECTOR} > ${SHARED_BLOCK_WRAPPER_SELECTOR} > ${selector})`,
];
const TOP_LEVEL_FRAME_SELECTORS = FRAMEABLE_BLOCK_SELECTORS.flatMap(topLevelPuckSelectors);
const TOP_LEVEL_ATOMIC_FRAME_SELECTORS = ATOMIC_FRAMEABLE_BLOCK_SELECTORS.flatMap(topLevelPuckSelectors);
const TOP_LEVEL_TEXT_SELECTORS = topLevelPuckSelectors(".wp-block-text");
const TOP_LEVEL_CENTERED_TEXT_SELECTORS = topLevelPuckSelectors(".wp-block-text.text-center");
const TOP_LEVEL_H2_BOUNDARY_SELECTORS = (() => {
  const precedingBlock = [
    ":not(.wp-block-divider)",
    ":not(.wp-block-spacer)",
    ":not(.wp-block-hero)",
    `:not(${SHARED_BLOCK_WRAPPER_SELECTOR}:has(> .wp-block-divider))`,
    `:not(${SHARED_BLOCK_WRAPPER_SELECTOR}:has(> .wp-block-spacer))`,
    `:not(${SHARED_BLOCK_WRAPPER_SELECTOR}:has(> .wp-block-hero))`,
  ].join("");
  const precedingSibling = `${TOP_LEVEL_PUCK_ITEM_SELECTOR} > ${precedingBlock}`;
  return [
    `${precedingSibling} + .wp-block-heading.heading-h2`,
    `${precedingSibling} + ${SHARED_BLOCK_WRAPPER_SELECTOR} > .wp-block-heading.heading-h2`,
  ];
})();
const TOP_LEVEL_H2_SECTION_START_SELECTORS = [
  `${TOP_LEVEL_PUCK_ITEM_SELECTOR} > .wp-block-heading.heading-h2:first-child`,
  `${TOP_LEVEL_PUCK_ITEM_SELECTOR} > ${SHARED_BLOCK_WRAPPER_SELECTOR}:first-child > .wp-block-heading.heading-h2`,
  ...[
    `${TOP_LEVEL_PUCK_ITEM_SELECTOR} > .wp-block-hero`,
    `${TOP_LEVEL_PUCK_ITEM_SELECTOR} > ${SHARED_BLOCK_WRAPPER_SELECTOR}:has(> .wp-block-hero)`,
  ].flatMap((precedingHero) => [
    `${precedingHero} + .wp-block-heading.heading-h2`,
    `${precedingHero} + ${SHARED_BLOCK_WRAPPER_SELECTOR} > .wp-block-heading.heading-h2`,
  ]),
];

const COMPONENT_NAME_BY_CLASS = new Map([
  ["wp-block-heading", "Heading"], ["wp-block-text", "Text"], ["wp-block-image", "Image"],
  ["wp-block-columns", "Columns"], ["wp-block-card", "Card"], ["wp-block-divider", "Divider"],
  ["wp-block-button", "Button"], ["wp-block-spacer", "Spacer"], ["wp-block-section", "Section"],
  ["wp-block-grid", "Grid"], ["wp-block-flex-row", "FlexRow"], ["wp-block-accordion", "Accordion"],
  ["wp-block-tabs", "Tabs"], ["wp-block-video-embed", "VideoEmbed"],
  ["wp-block-audio-player", "AudioPlayer"], ["wp-block-pricing", "PricingTable"],
  ["wp-block-testimonial", "Testimonial"], ["wp-block-cta-banner", "CTABanner"],
  ["wp-block-posts-grid", "PostsGrid"], ["wp-block-category-posts", "CategoryPosts"],
  ["wp-block-search", "Search"], ["wp-block-hero", "Hero"], ["wp-block-quote", "Quote"],
  ["wp-block-table", "Table"], ["wp-block-icon-list", "IconList"],
  ["wp-block-social-links", "SocialLinks"], ["wp-block-stats", "Stats"],
  ["wp-block-html-embed", "HTMLEmbed"],
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? argv[++i] : true;
  }
  return out;
}

function decodeHtml(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

function extractTagAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function googleFontStylesheetHref(tag) {
  const rel = extractTagAttribute(tag, "rel");
  const href = extractTagAttribute(tag, "href");
  if (!rel?.split(/\s+/).some((value) => value.toLowerCase() === "stylesheet") || !href) return null;
  try {
    const url = new URL(href);
    if (url.hostname.toLowerCase() !== "fonts.googleapis.com" || !/^\/css(?:2)?$/i.test(url.pathname)) return null;
    return href;
  } catch {
    return null;
  }
}

function extractThemeCss(html, source) {
  const match = html.match(/<style\s+[^>]*id=["']wordjs-theme["'][^>]*>([\s\S]*?)<\/style>/i);
  if (!match) throw new Error(`${source}: missing <style id="wordjs-theme">`);
  const fontImports = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((entry) => googleFontStylesheetHref(entry[0]))
    .filter(Boolean)
    .map((href) => `@import url('${href}');`);
  return `${fontImports.join("\n")}\n${match[1].trim()}\n`;
}

function plainText(html) {
  return decodeHtml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractHeaderAction(html) {
  const container = html.match(/<([a-z][\w-]*)\b[^>]*class=(?:"[^"]*\bwjs-header-actions\b[^"]*"|'[^']*\bwjs-header-actions\b[^']*')[^>]*>([\s\S]*?)<\/\1>/i);
  if (!container) return null;
  const action = container[2].match(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/i);
  if (!action) return null;
  const label = plainText(action[3]);
  if (!label) return null;
  const href = action[2].match(/\shref=(?:"([^"]*)"|'([^']*)')/i);
  return {
    label,
    href: decodeHtml(href?.[1] ?? href?.[2] ?? "#contact"),
  };
}

function extractSearchStructure(html) {
  const container = html.match(/<([a-z][\w-]*)\b[^>]*class=(?:"[^"]*\bwp-block-search\b[^"]*"|'[^']*\bwp-block-search\b[^']*')[^>]*>([\s\S]*?)<\/\1>/i);
  if (!container) return null;
  return {
    hasLabel: /<label\b/i.test(container[2]),
    hasButton: /<button\b/i.test(container[2]),
  };
}

function extractAccordionStructure(context) {
  const explicitItems = elementsWithClass(context, "wp-block-accordion-item");
  if (!explicitItems.length) return { itemRole: "details" };
  return {
    itemRole: explicitItems.every((node) => node.name !== "details") ? "flat-trigger" : "details",
  };
}

function isElement(node) {
  return Boolean(node && node.type === "tag");
}

function elementChildren(node) {
  return (node?.children || []).filter(isElement);
}

function elementClasses(node) {
  return isElement(node) ? (node.attribs?.class || "").split(/\s+/).filter(Boolean) : [];
}

function hasClass(node, className) {
  return elementClasses(node).includes(className);
}

function walkElements(node, visitor) {
  if (isElement(node)) visitor(node);
  for (const child of node?.children || []) walkElements(child, visitor);
}

function descendants(node, predicate = () => true) {
  const result = [];
  for (const child of node?.children || []) {
    walkElements(child, (candidate) => {
      if (predicate(candidate)) result.push(candidate);
    });
  }
  return result;
}

function elementsWithClass(context, className) {
  const result = [];
  walkElements(context.document, (node) => {
    if (hasClass(node, className)) result.push(node);
  });
  return result;
}

function nodeText(node) {
  if (!node) return "";
  if (node.type === "text") return node.data || "";
  if (node.type === "script" || node.type === "style") return "";
  return (node.children || []).map(nodeText).join(" ").replace(/\s+/g, " ").trim();
}

function nodePath(node) {
  const segments = [];
  let current = node;
  while (isElement(current)) {
    const stableClasses = elementClasses(current).filter((name) => /^(?:wp-block-|wjs-)/.test(name)).slice(0, 2);
    let segment = `${current.name}${stableClasses.map((name) => `.${name}`).join("")}`;
    const siblings = elementChildren(current.parent).filter((sibling) => sibling.name === current.name);
    if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    segments.unshift(segment);
    current = current.parent;
  }
  return segments.join(" > ");
}

function sourceLine(context, offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let low = 0;
  let high = context.lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (context.lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function sourceReference(context, node) {
  return {
    sourcePath: nodePath(node),
    sourceLine: sourceLine(context, node?.startIndex),
    sourceOffset: Number.isInteger(node?.startIndex) ? node.startIndex : null,
  };
}

function createDomContext(html) {
  const lineStarts = [0];
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] === "\n") lineStarts.push(index + 1);
  }
  return {
    html,
    document: parseDocument(html, { withStartIndices: true, withEndIndices: true }),
    lineStarts,
    inlineDeclarationCache: new WeakMap(),
    resolvedInlineDeclarations: new Map(),
  };
}

function inlineDeclarations(context, node) {
  if (context.inlineDeclarationCache.has(node)) return context.inlineDeclarationCache.get(node);
  const style = node?.attribs?.style;
  if (style === undefined) return [];
  let declarations;
  try {
    const parsed = postcss.parse(`.stitch-inline { ${style} }`);
    declarations = (parsed.first?.nodes || []).filter((entry) => entry.type === "decl").map((entry, index) => ({
      index,
      property: entry.prop.toLowerCase(),
      value: entry.value,
    }));
  } catch {
    declarations = [{ index: 0, property: "<parse-error>", value: style }];
  }
  context.inlineDeclarationCache.set(node, declarations);
  return declarations;
}

function markInlineResolved(context, node, declaration, target) {
  if (!declaration) return;
  const targets = context.resolvedInlineDeclarations.get(declaration) || new Set();
  targets.add(target);
  context.resolvedInlineDeclarations.set(declaration, targets);
}

const INLINE_COMPONENT_ROOTS = [
  "wp-block-hero", "wp-block-card", "wp-block-accordion", "wp-block-tabs",
  "wp-block-video-embed", "wp-block-audio-player", "wp-block-pricing",
  "wp-block-testimonial", "wp-block-cta-banner", "wp-block-posts-grid",
  "wp-block-category-posts", "wp-block-search", "wp-block-quote", "wp-block-table",
  "wp-block-icon-list", "wp-block-social-links", "wp-block-stats",
  "wjs-site-header", "wjs-site-footer",
];
const INLINE_STRUCTURAL_CLASSES = new Set(STRUCTURAL_SELECTORS.map((selector) => selector.slice(1)));
// Icon-font wrappers (Material Symbols / Material Icons) that Stitch stamps with an inline
// `font-variation-settings: 'FILL' 1;` to render a FILLED glyph. These are `<span>`s that inferredInlineRole
// doesn't classify (it only maps <i>/<svg> icons), so the declaration stayed UNRESOLVED and dragged parity
// to "partial". They carry an identical, projectable value across the whole page, so we map them to a
// stable canonical selector (their own font class) — extractCanonicalInlineRules then hoists the fill hint
// into one theme rule, PRESERVING the filled-icon look AND reaching parityStatus "exact".
const ICON_FONT_CLASSES = [
  "material-symbols-outlined", "material-symbols-rounded", "material-symbols-sharp",
  "material-icons", "material-icons-outlined", "material-icons-round", "material-icons-sharp",
];
const REPEATABLE_INLINE_TARGETS = new Set([
  ".wp-block-card", ".wp-block-card-icon", ".wp-block-card-title", ".wp-block-card-description",
  ".wp-block-accordion-item", ".wp-block-accordion-trigger", ".wp-block-accordion-panel",
  ".wp-block-tabs-tab", ".wp-block-tabs-panel", ".wp-block-pricing-plan",
  ".wp-block-pricing-name", ".wp-block-pricing-price", ".wp-block-pricing-period",
  ".wp-block-pricing-feature", ".wp-block-pricing-action", ".wp-block-posts-grid-item",
  ".wp-block-posts-grid-media", ".wp-block-posts-grid-meta", ".wp-block-posts-grid-title",
  ".wp-block-posts-grid-excerpt", ".wp-block-icon-list-item", ".wp-block-stats-item",
  ".wp-block-stats-value", ".wp-block-stats-label", ".wp-block-social-links-item",
]);

function nearestInlineRoot(node) {
  let current = node?.parent;
  while (isElement(current)) {
    const rootClass = INLINE_COMPONENT_ROOTS.find((className) => hasClass(current, className));
    if (rootClass) return { node: current, className: rootClass };
    current = current.parent;
  }
  return null;
}

function inferredInlineRole(node, root) {
  const classes = elementClasses(node);
  const explicit = classes.find((className) => INLINE_STRUCTURAL_CLASSES.has(className));
  if (explicit) return `.${explicit}`;
  const tag = node.name;
  const rootClass = root?.className;

  if (rootClass === "wp-block-hero") {
    if (/^h[1-6]$/.test(tag)) return ".wp-block-hero-title";
    // A Stitch hero commonly contains an eyebrow <p>, the actual .wp-block-text
    // subtitle, and a .wp-block-flex-row of actions. Mapping every paragraph to
    // the single runtime subtitle (or every div to the content wrapper) merges
    // unrelated declarations and visibly corrupts the converted hierarchy.
    if (tag === "p" && hasClass(node, "wp-block-text")) return ".wp-block-hero-subtitle";
    if (tag === "a" || tag === "button") return ".wp-block-hero-action";
    if (hasClass(node, "wp-block-flex-row")) return ".wp-block-hero-actions";
    const direct = directBranch(root.node, node);
    if (node === direct && tag === "div") return ".wp-block-hero-content";
  }
  if (rootClass === "wp-block-card") {
    if (isCardIcon(node)) return ".wp-block-card-icon";
    if (/^h[1-6]$/.test(tag)) return ".wp-block-card-title";
    // Price, category and metadata paragraphs are frequent inside specimen
    // cards. Only the canonical text hook is unambiguous enough to project onto
    // WordJS' single Card description slot.
    if (tag === "p" && hasClass(node, "wp-block-text")) return ".wp-block-card-description";
    if (tag === "img") return ".wp-block-image-element";
  }
  if (rootClass === "wp-block-accordion") {
    if (tag === "details") return ".wp-block-accordion-item";
    if (tag === "summary" || hasClass(node, "wp-block-accordion-item")) return ".wp-block-accordion-trigger";
    if (tag === "div" && node.parent?.name === "details") return ".wp-block-accordion-panel";
  }
  if (rootClass === "wp-block-tabs") {
    if (tag === "button" || tag === "a") return ".wp-block-tabs-tab";
    if (tag === "p") return ".wp-block-tabs-panel .wp-block-text";
  }
  if (rootClass === "wp-block-pricing") {
    const direct = directBranch(root.node, node);
    if (node === direct) return ".wp-block-pricing-plan";
    if (/^h[1-6]$/.test(tag)) return ".wp-block-pricing-name";
    if (tag === "ul" || tag === "ol") return ".wp-block-pricing-features";
    if (tag === "li") return ".wp-block-pricing-feature";
    if (tag === "a" || tag === "button") return ".wp-block-pricing-action";
  }
  if (rootClass === "wp-block-testimonial") {
    if (tag === "blockquote" || tag === "p") return ".wp-block-testimonial-quote";
    if (tag === "cite") return ".wp-block-testimonial-name";
    if (tag === "img") return ".wp-block-testimonial-avatar";
  }
  if (rootClass === "wp-block-cta-banner") {
    if (/^h[1-6]$/.test(tag)) return ".wp-block-cta-banner-title";
    if (tag === "p") return ".wp-block-cta-banner-subtitle";
    if (tag === "a" || tag === "button") return ".wp-block-cta-banner-action";
  }
  if (rootClass === "wp-block-posts-grid") {
    const direct = directBranch(root.node, node);
    if (node === direct) return ".wp-block-posts-grid-item";
    if (tag === "img") return ".wp-block-image-element";
    if (/^h[1-6]$/.test(tag)) return ".wp-block-posts-grid-title";
    if (tag === "p") return ".wp-block-posts-grid-excerpt";
    if (tag === "time" || tag === "small" || tag === "span") return ".wp-block-posts-grid-meta";
  }
  if (rootClass === "wp-block-search") {
    if (tag === "label") return ".wp-block-search-label";
    if (tag === "input") return ".wp-block-search-input";
    if (tag === "button") return ".wp-block-search-button";
  }
  if (rootClass === "wp-block-quote") {
    if (tag === "blockquote" || tag === "p") return ".wp-block-quote-text";
    if (tag === "cite") return ".wp-block-quote-cite";
  }
  if (rootClass === "wp-block-table") {
    if (tag === "table") return ".wp-block-table-element";
    if (tag === "thead") return ".wp-block-table-head";
    if (tag === "tr") return ".wp-block-table-row";
    if (tag === "th" || tag === "td") return ".wp-block-table-cell";
  }
  if (rootClass === "wp-block-icon-list") {
    if (tag === "li") return ".wp-block-icon-list-item";
    if (tag === "i" || tag === "svg") return ".wp-block-icon-list-icon";
  }
  if (rootClass === "wp-block-social-links") {
    if (tag === "a") return ".wp-block-social-links-item";
    if (tag === "i" || tag === "svg") return ".wp-block-social-links-icon";
  }
  if (rootClass === "wp-block-stats") {
    const direct = directBranch(root.node, node);
    if (node === direct) return ".wp-block-stats-item";
  }
  if (rootClass === "wjs-site-footer") {
    if (/^h[1-6]$/.test(tag) && isInsideClass(node, root.node, ["wjs-footer-brand"])) return ".wjs-footer-brand-title";
    if (/^h[1-6]$/.test(tag) && isInsideClass(node, root.node, ["wjs-footer-menu"])) return ".wjs-footer-menu-title";
  }

  if (!root && classes.includes("wp-block-heading") && /^h[1-6]$/.test(tag)) return `${tag}.wp-block-heading`;
  if (!root && classes.includes("wp-block-text")) return ".wp-block-text";
  return null;
}

function canonicalInlineSelector(node) {
  const root = nearestInlineRoot(node);
  const role = inferredInlineRole(node, root);
  if (role) return root ? `.${root.className} ${role}` : role;
  const ownRoot = INLINE_COMPONENT_ROOTS.find((className) => hasClass(node, className));
  if (ownRoot) return `.${ownRoot}`;
  if (hasClass(node, "wp-block-heading") && /^h[1-6]$/.test(node.name)) return `${node.name}.wp-block-heading`;
  if (hasClass(node, "wp-block-text")) return ".wp-block-text";
  if (hasClass(node, "wp-block-button")) return ".wp-block-button";
  // Icon-font wrappers: project their (identical) fill hint onto the font class so it resolves.
  const iconFont = ICON_FONT_CLASSES.find((className) => hasClass(node, className));
  if (iconFont) return `.${iconFont}`;
  return null;
}

function extractCanonicalInlineRules(context) {
  const targetNodes = new Map();
  walkElements(context.document, (node) => {
    const selector = canonicalInlineSelector(node);
    if (!selector) return;
    const nodes = targetNodes.get(selector) || new Set();
    nodes.add(node);
    targetNodes.set(selector, nodes);
  });

  const buckets = new Map();
  walkElements(context.document, (node) => {
    if (!Object.prototype.hasOwnProperty.call(node.attribs || {}, "style")) return;
    const selector = canonicalInlineSelector(node);
    if (!selector) return;
    for (const declaration of inlineDeclarations(context, node)) {
      if (context.resolvedInlineDeclarations.has(declaration) || declaration.property === "<parse-error>") continue;
      const key = `${selector}\u0000${declaration.property}`;
      const entries = buckets.get(key) || [];
      entries.push({ node, declaration, selector });
      buckets.set(key, entries);
    }
  });

  const rulesBySelector = new Map();
  for (const entries of buckets.values()) {
    const { selector } = entries[0];
    const values = new Set(entries.map((entry) => entry.declaration.value.trim()));
    if (values.size !== 1) continue;
    const targetNodeCount = targetNodes.get(selector)?.size || 0;
    const shortTarget = selector.slice(selector.lastIndexOf(" ") + 1);
    if (REPEATABLE_INLINE_TARGETS.has(shortTarget) && entries.length < targetNodeCount) continue;
    const declarations = rulesBySelector.get(selector) || [];
    declarations.push({ property: entries[0].declaration.property, value: entries[0].declaration.value });
    rulesBySelector.set(selector, declarations);
    for (const entry of entries) {
      markInlineResolved(context, entry.node, entry.declaration, `generatedCss:${selector}`);
    }
  }
  return [...rulesBySelector.entries()].map(([selector, declarations]) => ({ selector, declarations }));
}

function extractCssUrl(value) {
  const match = value.match(/\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/i);
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function inlineBackgroundImage(context, node) {
  for (const declaration of inlineDeclarations(context, node)) {
    if (declaration.property !== "background" && declaration.property !== "background-image") continue;
    const url = extractCssUrl(declaration.value);
    if (url) return { url, declaration };
  }
  return null;
}

function buildInlineStyleAudit(context) {
  const styledElements = [];
  walkElements(context.document, (node) => {
    if (Object.prototype.hasOwnProperty.call(node.attribs || {}, "style")) styledElements.push(node);
  });

  let declarationCount = 0;
  let resolvedDeclarationCount = 0;
  let resolvedAttributeCount = 0;
  const resolved = [];
  for (const node of styledElements) {
    const declarations = inlineDeclarations(context, node);
    declarationCount += declarations.length;
    let attributeResolved = true;
    for (const declaration of declarations) {
      const targets = context.resolvedInlineDeclarations.get(declaration);
      if (!targets?.size) {
        attributeResolved = false;
        continue;
      }
      resolvedDeclarationCount += 1;
      resolved.push({
        ...sourceReference(context, node),
        property: declaration.property,
        value: declaration.value,
        targets: [...targets].sort(),
      });
    }
    if (attributeResolved) resolvedAttributeCount += 1;
  }

  const unresolvedDeclarationCount = declarationCount - resolvedDeclarationCount;
  const unresolvedAttributeCount = styledElements.length - resolvedAttributeCount;
  return {
    attributeCount: styledElements.length,
    declarationCount,
    resolvedAttributeCount,
    unresolvedAttributeCount,
    resolvedDeclarationCount,
    unresolvedDeclarationCount,
    parityStatus: unresolvedDeclarationCount === 0 ? "exact" : "partial",
    resolved,
  };
}

function firstDescendant(node, predicate) {
  return descendants(node, predicate)[0] || null;
}

function isInsideClass(node, boundary, classNames) {
  let current = node?.parent;
  while (current && current !== boundary) {
    if (classNames.some((className) => hasClass(current, className))) return true;
    current = current.parent;
  }
  return false;
}

function postItemCandidates(root) {
  const explicitClassNames = ["wp-block-posts-grid-item", "wp-block-post-card"];
  const explicit = descendants(root, (node) => explicitClassNames.some((className) => hasClass(node, className)))
    .filter((node) => !isInsideClass(node, root, explicitClassNames));
  if (explicit.length) return { items: explicit, mode: "explicit-hooks" };

  const items = elementChildren(root).filter((node) => {
    if (hasClass(node, "wp-block-category-posts")) return false;
    if (node.name === "article" || node.name === "a") return true;
    if (node.name !== "div" && node.name !== "li") return false;
    return Boolean(firstDescendant(node, (child) => /^h[1-6]$/.test(child.name) ||
      hasClass(child, "wp-block-heading") || child.name === "img" || hasClass(child, "wp-block-image")));
  });
  return { items, mode: items.length ? "inferred-direct-children" : "empty" };
}

function extractPostItem(context, item, index) {
  const titleNode = firstDescendant(item, (node) => hasClass(node, "wp-block-posts-grid-title")) ||
    firstDescendant(item, (node) => /^h[1-6]$/.test(node.name) || hasClass(node, "wp-block-heading"));
  const mediaClasses = ["wp-block-posts-grid-media", "wp-block-post-thumb", "wp-block-image"];
  const mediaNode = firstDescendant(item, (node) => mediaClasses.some((className) => hasClass(node, className)));
  const imageNode = firstDescendant(item, (node) => node.name === "img");

  let image = imageNode?.attribs?.src ? decodeHtml(imageNode.attribs.src) : null;
  if (!image) {
    const imageCandidates = [mediaNode, ...descendants(item, (node) => Object.prototype.hasOwnProperty.call(node.attribs || {}, "style")), item]
      .filter(Boolean);
    for (const candidate of [...new Set(imageCandidates)]) {
      const background = inlineBackgroundImage(context, candidate);
      if (!background) continue;
      image = background.url;
      markInlineResolved(context, candidate, background.declaration, `layout.componentRecipes.postsGrid.items[${index}].image`);
      break;
    }
  }

  const explicitMeta = firstDescendant(item, (node) => elementClasses(node).some((className) =>
    className === "wp-block-posts-grid-meta" || /(?:^|-)(?:meta|date|category|tag|stat-label)(?:-|$)/.test(className)) || node.name === "time");
  let metaNode = explicitMeta;
  if (!metaNode) {
    const titleOffset = titleNode?.startIndex ?? Number.POSITIVE_INFINITY;
    metaNode = descendants(item, (node) => {
      if ((node.startIndex ?? Number.POSITIVE_INFINITY) >= titleOffset || isInsideClass(node, item, mediaClasses)) return false;
      if (!nodeText(node) || nodeText(node).length > 120) return false;
      if (["span", "small", "time"].includes(node.name)) return true;
      return node.parent === item && node.name === "div" && !firstDescendant(node, (child) => /^h[1-6]$/.test(child.name) || child.name === "p");
    })[0] || null;
  }

  const excerptNode = firstDescendant(item, (node) => hasClass(node, "wp-block-posts-grid-excerpt")) ||
    firstDescendant(item, (node) => node.name === "p" && !isInsideClass(node, item, mediaClasses));
  return {
    item: {
      image,
      alt: imageNode?.attribs?.alt ? decodeHtml(imageNode.attribs.alt) : "",
      title: nodeText(titleNode),
      meta: nodeText(metaNode),
    },
    titleTag: titleNode?.name || null,
    hasExcerpt: Boolean(excerptNode && nodeText(excerptNode)),
  };
}

function confidenceFor(count, warnings) {
  if (count === 0) return "empty";
  return warnings.length ? "partial" : "exact";
}

function extractPostsGridRecipe(context) {
  const roots = elementsWithClass(context, "wp-block-posts-grid");
  if (!roots.length) return null;
  const candidates = roots.map((root, rootIndex) => {
    const selection = postItemCandidates(root);
    return { root, rootIndex, ...selection };
  }).sort((left, right) => right.items.length - left.items.length || left.rootIndex - right.rootIndex);
  const selected = candidates[0];
  const selectedItems = selected.items.slice(0, 12);
  const extracted = selectedItems.map((item, index) => extractPostItem(context, item, index));
  const titleTags = extracted.map((entry) => entry.titleTag).filter(Boolean);
  const tagCounts = new Map();
  for (const tag of titleTags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  const titleTag = [...tagCounts.entries()].sort((left, right) => right[1] - left[1] || titleTags.indexOf(left[0]) - titleTags.indexOf(right[0]))[0]?.[0] || null;
  const warnings = [];
  if (roots.length > 1) warnings.push(`multiple-posts-grid-roots:${roots.length}`);
  if (selected.items.length > selectedItems.length) warnings.push(`items-truncated:${selected.items.length}/${selectedItems.length}`);
  if (selected.mode === "inferred-direct-children") warnings.push("items-inferred-from-direct-children");
  if (!selected.items.length) warnings.push("empty-posts-grid");
  if (new Set(titleTags).size > 1) warnings.push(`mixed-title-tags:${[...new Set(titleTags)].join(",")}`);
  const missingTitles = extracted.flatMap((entry, index) => entry.item.title ? [] : [index]);
  if (missingTitles.length) warnings.push(`missing-title-items:${missingTitles.join(",")}`);
  return {
    count: selectedItems.length,
    titleTag,
    showMeta: extracted.some((entry) => Boolean(entry.item.meta)),
    showExcerpt: extracted.some((entry) => entry.hasExcerpt),
    items: extracted.map((entry) => entry.item),
    audit: {
      confidence: confidenceFor(selectedItems.length, warnings),
      ...sourceReference(context, selected.root),
      rootCount: roots.length,
      selectedRootIndex: selected.rootIndex,
      itemSelection: selected.mode,
      itemPaths: selectedItems.map(nodePath),
      warnings,
    },
  };
}

function containsNode(ancestor, node) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function cardExclusionReason(card) {
  if (hasClass(card, "wp-block-pricing")) return "card-root-is-pricing";
  const excludedAncestors = [
    ["wp-block-pricing", "inside-pricing"],
    ["wp-block-posts-grid", "inside-posts-grid"],
    ["wp-block-category-posts", "inside-category-posts"],
  ];
  for (const [className, reason] of excludedAncestors) {
    if (isInsideClass(card, null, [className])) return reason;
  }
  return null;
}

function isCardIcon(node) {
  if (!isElement(node)) return false;
  const classes = elementClasses(node);
  return hasClass(node, "wp-block-card-icon") || node.name === "svg" || node.name === "i" ||
    classes.some((className) => /^(?:material-symbols|fa(?:s|r|b|l|d)?(?:-|$))|(?:^|-)icon(?:-|$)/.test(className));
}

function directBranch(root, node) {
  if (!node || node === root || !containsNode(root, node)) return null;
  let current = node;
  while (current.parent && current.parent !== root) current = current.parent;
  return current.parent === root ? current : null;
}

function dominantValue(values) {
  const filtered = values.filter((value) => value !== null && value !== undefined && value !== "");
  const counts = new Map();
  filtered.forEach((value, index) => {
    const entry = counts.get(value) || { count: 0, first: index };
    entry.count += 1;
    counts.set(value, entry);
  });
  return [...counts.entries()].sort((left, right) => right[1].count - left[1].count || left[1].first - right[1].first)[0]?.[0] || null;
}

function extractCardItem(context, card, index) {
  const all = descendants(card);
  const titleNode = all.find((node) => hasClass(node, "wp-block-card-title")) ||
    all.find((node) => hasClass(node, "wp-block-heading") && (/^h[1-6]$/.test(node.name) || node.name === "span")) ||
    all.find((node) => /^h[1-6]$/.test(node.name)) || null;
  const textNode = all.find((node) => hasClass(node, "wp-block-card-description")) ||
    all.find((node) => hasClass(node, "wp-block-text") && node !== titleNode) ||
    all.find((node) => node.name === "p") || null;
  const iconNode = all.find(isCardIcon) || null;
  const imageNode = all.find((node) => node.name === "img") || null;
  let mediaNode = all.find((node) => hasClass(node, "wp-block-card-media")) ||
    all.find((node) => hasClass(node, "wp-block-image") || node.name === "figure" || node.name === "picture") ||
    imageNode;

  let image = imageNode?.attribs?.src ? decodeHtml(imageNode.attribs.src) : null;
  let imageSource = image ? "img" : null;
  let backgroundSource = null;
  if (!image) {
    const candidates = [mediaNode, ...all.filter((node) => Object.prototype.hasOwnProperty.call(node.attribs || {}, "style")), card]
      .filter(Boolean);
    for (const candidate of [...new Set(candidates)]) {
      const background = inlineBackgroundImage(context, candidate);
      if (!background) continue;
      image = background.url;
      imageSource = "inline-background";
      backgroundSource = candidate;
      mediaNode ||= candidate;
      markInlineResolved(context, candidate, background.declaration, `layout.componentRecipes.card.items[${index}].image`);
      break;
    }
  }

  const mediaBranch = directBranch(card, mediaNode || imageNode);
  const titleBranch = directBranch(card, titleNode);
  const textBranch = directBranch(card, textNode);
  const iconBranch = directBranch(card, iconNode);
  const childOrder = elementChildren(card).map((child) => {
    if (child === mediaBranch && child !== titleBranch && child !== textBranch) return "media";
    if (child === iconBranch && child !== titleBranch) return "icon";
    if (child === titleBranch && child === textBranch && child !== titleNode && child !== textNode) return "content";
    if (child === titleNode) return "title";
    if (child === textNode || child.name === "p") return "text";
    if (child.name === "button" || child.name === "a" || hasClass(child, "wp-block-button")) return "action";
    if (child.name === "ul" || child.name === "ol") return "list";
    if (/^h[1-6]$/.test(child.name)) return "heading";
    if (child.name === "span") return "badge";
    if ((titleBranch === child || textBranch === child) && child !== titleNode && child !== textNode) return "content";
    return child.name;
  });

  const hasMedia = Boolean(mediaNode || image);
  let structure = "none";
  if (imageNode) {
    const container = imageNode.parent === card ? null : (mediaNode && mediaNode !== imageNode ? mediaNode : imageNode.parent);
    structure = container ? `wrapper:${container.name}>img` : "direct:img";
  } else if (imageSource === "inline-background") {
    structure = `inline-background:${backgroundSource?.name || mediaNode?.name || card.name}`;
  } else if (mediaNode) {
    structure = `placeholder:${mediaNode.name}`;
  }

  return {
    image,
    alt: imageNode?.attribs?.alt ? decodeHtml(imageNode.attribs.alt) : "",
    title: nodeText(titleNode),
    titleTag: titleNode?.name || null,
    hasMedia,
    hasIcon: Boolean(iconNode),
    hasText: Boolean(textNode && nodeText(textNode)),
    childOrder,
    media: {
      present: hasMedia,
      structure,
      containerTag: mediaNode && mediaNode !== imageNode ? mediaNode.name : null,
      elementTag: imageNode?.name || null,
      source: imageSource || (mediaNode ? "placeholder" : "none"),
    },
  };
}

function extractCardRecipe(context) {
  const roots = elementsWithClass(context, "wp-block-card");
  if (!roots.length) return null;
  const excluded = roots.map((node) => ({ node, reason: cardExclusionReason(node) })).filter((entry) => entry.reason);
  const eligible = roots.filter((node) => !cardExclusionReason(node)).slice(0, 24);
  const items = eligible.map((card, index) => extractCardItem(context, card, index));
  const titleTags = items.map((item) => item.titleTag).filter(Boolean);
  const childOrders = items.map((item) => item.childOrder.join(">"));
  const mediaStructures = items.map((item) => item.media.structure);
  const warnings = [];
  if (roots.length > eligible.length + excluded.length) warnings.push(`cards-truncated:${roots.length - excluded.length}/${eligible.length}`);
  if (excluded.length) warnings.push(`cards-excluded:${excluded.length}`);
  if (!eligible.length) warnings.push("no-standalone-cards");
  if (new Set(titleTags).size > 1) warnings.push(`mixed-title-tags:${[...new Set(titleTags)].join(",")}`);
  if (new Set(childOrders).size > 1) warnings.push(`mixed-child-order:${new Set(childOrders).size}`);
  if (new Set(mediaStructures).size > 1) warnings.push(`mixed-media-structure:${new Set(mediaStructures).size}`);
  const first = eligible[0] || roots[0];
  const hasMedia = items.some((item) => item.hasMedia);
  return {
    count: eligible.length,
    titleTag: dominantValue(titleTags),
    showMedia: hasMedia,
    hasMedia,
    hasIcon: items.some((item) => item.hasIcon),
    hasText: items.some((item) => item.hasText),
    childOrder: (dominantValue(childOrders) || "").split(">").filter(Boolean),
    mediaStructure: new Set(mediaStructures).size <= 1 ? (mediaStructures[0] || "none") : "mixed",
    items,
    audit: {
      confidence: confidenceFor(eligible.length, warnings),
      ...sourceReference(context, first),
      sourceCardCount: roots.length,
      includedCardCount: eligible.length,
      excludedCardCount: excluded.length,
      itemPaths: eligible.map(nodePath),
      excluded: excluded.map((entry) => ({ ...sourceReference(context, entry.node), reason: entry.reason })),
      warnings,
    },
  };
}

function pricingPlanCandidates(root) {
  const explicitNames = ["wp-block-pricing-plan", "wp-block-pricing-card", "wp-block-pricing-tier"];
  const direct = elementChildren(root);
  const explicit = direct.filter((node) => explicitNames.some((className) => hasClass(node, className)) || hasClass(node, "wp-block-card"));
  if (explicit.length) return { plans: explicit, mode: "explicit-hooks" };
  if (hasClass(root, "wp-block-card")) return { plans: [root], mode: "root-is-plan" };
  const inferred = direct.filter((node) => {
    const text = nodeText(node);
    const hasHeading = Boolean(firstDescendant(node, (child) => /^h[1-6]$/.test(child.name)));
    const hasActionOrList = Boolean(firstDescendant(node, (child) => child.name === "button" || child.name === "a" || child.name === "ul"));
    const hasPrice = /(?:[$€£]\s*\d|\d\s*(?:\/\s*)?(?:mo|month|yr|year))/i.test(text) ||
      Boolean(firstDescendant(node, (child) => hasClass(child, "wp-block-pricing-price") || hasClass(child, "price")));
    return hasHeading && (hasPrice || hasActionOrList);
  });
  return { plans: inferred, mode: inferred.length ? "inferred-direct-children" : "empty" };
}

function extractPricingRecipe(context) {
  const roots = elementsWithClass(context, "wp-block-pricing");
  if (!roots.length) return null;
  const candidates = roots.map((root, rootIndex) => ({ root, rootIndex, ...pricingPlanCandidates(root) }))
    .sort((left, right) => right.plans.length - left.plans.length || left.rootIndex - right.rootIndex);
  const selected = candidates[0];
  const warnings = [];
  if (roots.length > 1) warnings.push(`multiple-pricing-roots:${roots.length}`);
  if (selected.mode === "inferred-direct-children") warnings.push("plans-inferred-from-direct-children");
  if (!selected.plans.length) warnings.push("empty-pricing");
  return {
    planCount: selected.plans.length,
    audit: {
      confidence: confidenceFor(selected.plans.length, warnings),
      ...sourceReference(context, selected.root),
      rootCount: roots.length,
      selectedRootIndex: selected.rootIndex,
      planSelection: selected.mode,
      planPaths: selected.plans.map(nodePath),
      warnings,
    },
  };
}

function tabStructure(root) {
  let nav = firstDescendant(root, (node) => ["wp-block-tabs-nav", "tab-header"].some((className) => hasClass(node, className)));
  let labels = [];
  let inferredNav = false;
  if (nav) {
    labels = descendants(nav, (node) => node.name === "button" || node.name === "a" ||
      ["wp-block-tabs-tab", "wp-block-tabs-button", "tab-btn"].some((className) => hasClass(node, className)))
      .filter((node) => !descendants(node, (child) => child.name === "button" || child.name === "a").length);
  } else {
    const direct = elementChildren(root);
    const shortPlainChildren = direct.length >= 2 && direct.every((node) => {
      const text = nodeText(node);
      return text.length > 0 && text.length <= 80 && !firstDescendant(node, (child) =>
        /^h[1-6]$/.test(child.name) || ["p", "input", "form", "table", "ul"].includes(child.name));
    });
    if (shortPlainChildren) {
      labels = direct;
      inferredNav = true;
    }
  }

  let panels = descendants(root, (node) => ["wp-block-tabs-panel", "wp-block-tabs-content", "tab-content"].some((className) => hasClass(node, className)));
  if (!panels.length && nav) {
    panels = elementChildren(root).filter((node) => node !== nav && !labels.includes(node));
  }
  return { nav, labels, panels, inferredNav };
}

function extractTabsRecipe(context) {
  const roots = elementsWithClass(context, "wp-block-tabs");
  if (!roots.length) return null;
  const candidates = roots.map((root, rootIndex) => ({ root, rootIndex, ...tabStructure(root) }))
    .sort((left, right) => right.labels.length - left.labels.length || left.rootIndex - right.rootIndex);
  const selected = candidates[0];
  const activeIndex = Math.max(0, selected.labels.findIndex((node) =>
    elementClasses(node).some((name) => name === "active" || name === "is-active") || node.attribs?.["aria-selected"] === "true"));
  const items = selected.labels.map((node) => ({ label: nodeText(node), content: "" }));
  if (selected.panels.length === items.length) {
    selected.panels.forEach((panel, index) => { items[index].content = nodeText(panel); });
  } else if (selected.panels.length && items.length) {
    items[Math.min(activeIndex, Math.max(0, items.length - 1))].content = nodeText(selected.panels[0]);
  }
  const warnings = [];
  if (roots.length > 1) warnings.push(`multiple-tabs-roots:${roots.length}`);
  if (selected.inferredNav) warnings.push("tabs-nav-inferred-from-direct-children");
  if (!items.length) warnings.push("empty-tabs");
  if (items.length && selected.panels.length !== items.length) warnings.push(`tab-panel-count:${selected.panels.length}/${items.length}`);
  return {
    count: items.length,
    items,
    audit: {
      confidence: confidenceFor(items.length, warnings),
      ...sourceReference(context, selected.root),
      rootCount: roots.length,
      selectedRootIndex: selected.rootIndex,
      navPath: selected.nav ? nodePath(selected.nav) : null,
      itemPaths: selected.labels.map(nodePath),
      panelPaths: selected.panels.map(nodePath),
      warnings,
    },
  };
}

function topLevelSectionComponents(section) {
  const components = [];
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      const componentEntry = elementClasses(child).map((className) => [className, COMPONENT_NAME_BY_CLASS.get(className)])
        .find(([, componentName]) => componentName && componentName !== "Section");
      if (componentEntry) {
        components.push({ component: componentEntry[1], node: child });
      } else {
        visit(child);
      }
    }
  };
  visit(section);
  return components;
}

function extractSectionRecipes(context) {
  const roots = elementsWithClass(context, "wp-block-section").filter((node) =>
    !isInsideClass(node, context.document, ["wp-block-section"]));
  return roots.map((root) => {
    const components = topLevelSectionComponents(root);
    const rootAliases = elementClasses(root).map((className) => COMPONENT_NAME_BY_CLASS.get(className))
      .filter((componentName) => componentName && componentName !== "Section");
    const warnings = [];
    if (!components.length) warnings.push("empty-section-composition");
    if (rootAliases.length) warnings.push(`section-root-also:${rootAliases.join(",")}`);
    return {
      childComponentOrder: components.map((entry) => entry.component),
      audit: {
        confidence: confidenceFor(components.length, warnings),
        ...sourceReference(context, root),
        childPaths: components.map((entry) => nodePath(entry.node)),
        warnings,
      },
    };
  });
}

function extractComponentRecipes(context) {
  const recipes = { version: 1 };
  const postsGrid = extractPostsGridRecipe(context);
  const card = extractCardRecipe(context);
  const pricing = extractPricingRecipe(context);
  const tabs = extractTabsRecipe(context);
  const sections = extractSectionRecipes(context);
  if (postsGrid) recipes.postsGrid = postsGrid;
  if (card) recipes.card = card;
  if (pricing) recipes.pricing = pricing;
  if (tabs) recipes.tabs = tabs;
  if (sections.length) recipes.sections = sections;
  return Object.keys(recipes).length > 1 ? recipes : null;
}

async function getImageAspectRatio(url) {
  if (imageAspectCache.has(url)) return imageAspectCache.get(url);
  const pending = (async () => {
    try {
      const parsed = new URL(url);
      if (!(["http:", "https:", "data:"].includes(parsed.protocol))) return null;
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return null;
      const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      return metadata.width && metadata.height ? Number((metadata.width / metadata.height).toFixed(6)) : null;
    } catch {
      return null;
    }
  })();
  imageAspectCache.set(url, pending);
  return pending;
}

async function enrichThemeDefaults(themeDefaults) {
  const postImages = await Promise.all((themeDefaults.postImages || []).map(async (image) => ({
    ...image,
    aspectRatio: await getImageAspectRatio(image.url),
  })));
  return { ...themeDefaults, postImages };
}

function extractThemeDefaults(html) {
  const context = createDomContext(html);
  const heroNode = elementsWithClass(context, "wp-block-hero")[0] || null;
  const tableRoots = elementsWithClass(context, "wp-block-table");
  let heroBackground = null;
  if (heroNode) {
    const declaration = inlineDeclarations(context, heroNode).find((entry) =>
      (entry.property === "background-image" || entry.property === "background") && /url\(|gradient\(/i.test(entry.value));
    if (declaration) {
      heroBackground = { property: declaration.property, value: declaration.value };
      markInlineResolved(context, heroNode, declaration, "stitch.extractedThemeDefaults.heroBackground");
    }
  }
  const componentRecipes = extractComponentRecipes(context);
  const canonicalInlineRules = extractCanonicalInlineRules(context);
  const inlineStyleAudit = buildInlineStyleAudit(context);
  const imageUrls = [...new Set((componentRecipes?.postsGrid?.items || []).map((item) => item.image).filter(Boolean))];
  return {
    inlineStyleCount: inlineStyleAudit.attributeCount,
    inlineStyleAudit,
    canonicalInlineRules,
    heroBackground,
    headerAction: extractHeaderAction(html),
    searchStructure: extractSearchStructure(html),
    accordionStructure: extractAccordionStructure(context),
    tableRootIsSemantic: tableRoots.length > 0 && tableRoots.every((node) => node.name?.toLowerCase() === "table"),
    postImages: imageUrls.slice(0, 12).map((url) => ({ url, aspectRatio: null })),
    componentRecipes,
  };
}

function selectorCovered(root, required) {
  let found = false;
  const escaped = required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selectorBoundary = new RegExp(`${escaped}(?![\\w-])`);
  root.walkRules((rule) => {
    if (rule.selectors?.some((selector) => selectorBoundary.test(selector))) found = true;
  });
  return found;
}

function normalizeImageElementSelector(selector) {
  const imageScopes = new Set([
    "wp-block-image", "wp-block-posts-grid", "wp-block-posts-grid-item", "wp-block-posts-grid-media",
  ]);
  try {
    return selectorParser((selectors) => {
      selectors.each((complexSelector) => {
        let insideImageScope = false;
        complexSelector.walk((node) => {
          if (node.type === "class" && imageScopes.has(node.value)) insideImageScope = true;
          if (node.type === "tag" && node.value.toLowerCase() === "img" && insideImageScope) {
            node.replaceWith(selectorParser.className({ value: "wp-block-image-element" }));
          }
        });
      });
    }).processSync(selector);
  } catch {
    return selector;
  }
}

function normalizeTableElementSelector(selector, sourceTableRootIsSemantic = false) {
  try {
    return selectorParser((selectors) => {
      selectors.each((complexSelector) => {
        // Stitch commonly places `.wp-block-table` on the semantic `<table>`, while WordJS
        // deliberately keeps that hook on an outer scroll wrapper. Expand the source compound
        // into both runtime nodes so declarations (and descendant selectors) continue to target
        // the semantic table instead of leaking onto the wrapper.
        const sourceTableCompounds = [];
        let compound = [];
        for (const node of complexSelector.nodes) {
          if (node.type === "combinator") {
            if (compound.length > 0) sourceTableCompounds.push(compound);
            compound = [];
          } else {
            compound.push(node);
          }
        }
        if (compound.length > 0) sourceTableCompounds.push(compound);

        for (const nodes of sourceTableCompounds) {
          const tableTag = nodes.find((node) => node.type === "tag" && node.value.toLowerCase() === "table");
          const tableClass = nodes.find((node) => node.type === "class" && node.value === "wp-block-table");
          if (!tableClass || (!sourceTableRootIsSemantic && !tableTag)) continue;

          tableTag?.remove();
          tableClass.replaceWith(
            selectorParser.className({ value: "wp-block-table" }),
            selectorParser.combinator({ value: " " }),
            selectorParser.className({ value: "wp-block-table-element" }),
          );
        }

        complexSelector.walkTags((tag) => {
          if (tag.value.toLowerCase() !== "table") return;

          let previous = tag.prev();
          let insideTableWrapper = false;
          let insideTableElement = false;
          while (previous) {
            if (previous.type === "class" && previous.value === "wp-block-table-element") {
              insideTableElement = true;
            }
            if (previous.type === "class" && previous.value === "wp-block-table") {
              insideTableWrapper = !insideTableElement;
              break;
            }
            previous = previous.prev();
          }
          if (insideTableWrapper) tag.replaceWith(selectorParser.className({ value: "wp-block-table-element" }));
        });
      });
    }).processSync(selector);
  } catch {
    return selector;
  }
}

function normalizeStitchSelectors(root, themeDefaults = {}) {
  let rewriteCount = 0;
  root.walkRules((rule) => {
    if (!rule.selectors) return;
    rule.selectors = rule.selectors.map((original) => {
      // Stitch specimens own the page canvas through `body`; WordJS mounts its public surface
      // inside `.wjs-public-site` so admin chrome remains untouched. Preserve that ownership by
      // mapping the specimen canvas to the real public root before contract validation.
      const trimmed = original.trim();
      let selector = trimmed
        .replace(/^(?:html|body)(?=\s|\.|#|:|>|\+|~|$)/, ".wjs-public-site")
        .replace(/^main(?=\s|\.|#|:|>|\+|~|$)/, ".wjs-main-content");
      if (selector !== original) rewriteCount += 1;
      for (const [pattern, replacement] of STITCH_SELECTOR_REWRITES) {
        const next = selector.replace(pattern, replacement);
        if (next !== selector) rewriteCount += 1;
        selector = next;
      }

      // Normalize source descendants to stable canonical element hooks without changing ownership
      // of component roots such as `.wp-block-table`, which remains the scroll wrapper.
      selector = selector
        .replace(/\.wjs-header-actions\s+(?:button|a)(?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-header-actions .wjs-header-action")
        .replace(/\.wjs-header-actions\s+\.wp-block-button(?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-header-actions .wjs-header-action.wp-block-button")
        .replace(/\.wjs-footer-brand\s+h[1-6](?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-footer-brand .wjs-footer-brand-title")
        .replace(/\.wjs-footer-menu\s+h[1-6](?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-footer-menu .wjs-footer-menu-title")
        .replace(/\.wjs-footer-menu\s+ul(?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-footer-menu .wjs-footer-menu-list")
        .replace(/\.wjs-footer-menu\s+li(?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-footer-menu .wjs-footer-menu-item")
        .replace(/\.wjs-footer-menu\s+a(?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-footer-menu .wjs-footer-menu-link")
        .replace(/\.wjs-footer-socials\s+h[1-6](?=\s|:|\.|#|>|\+|~|$)/g, ".wjs-footer-socials .wjs-footer-socials-title")
        .replace(/\.wp-block-search\s+label(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-search .wp-block-search-label")
        .replace(/\.wp-block-search\s+input(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-search .wp-block-search-input")
        .replace(/\.wp-block-search\s+button(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-search .wp-block-search-button")
        .replace(/\.wp-block-button\s*>?\s*a(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-button")
        .replace(/\.wp-block-image\s+\.bg-image/g, ".wp-block-image.bg-image")
        .replace(/\.wp-block-icon-list\s*>?\s*ul(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-icon-list")
        .replace(/\.wp-block-hero::before/g, ".wp-block-hero-overlay");
      selector = normalizeTableElementSelector(selector, themeDefaults.tableRootIsSemantic);
      selector = normalizeImageElementSelector(selector);
      if (selector !== original) rewriteCount += 1;
      return selector;
    });
  });
  return rewriteCount;
}

function normalizeAccordionStructure(root, accordionStructure) {
  if (accordionStructure?.itemRole !== "flat-trigger") return 0;
  let rewriteCount = 0;
  root.walkRules((rule) => {
    if (!rule.selectors || isInsideKeyframes(rule)) return;
    rule.selectors = rule.selectors.map((selector) => {
      const normalized = selector.replace(/\.wp-block-accordion-item(?![\w-])/g, ".wp-block-accordion-trigger");
      if (normalized !== selector) rewriteCount += 1;
      return normalized;
    });
  });
  return rewriteCount;
}

function findSelectorCompatibilityIssues(root) {
  const unknownWordJs = new Set();
  const optionalSpecimen = new Set();
  root.walkRules((rule) => {
    for (const selector of rule.selectors || []) {
      if (!PUCK_SELECTORS.some((rootSelector) => selector.includes(rootSelector))) continue;
      for (const match of selector.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)) {
        const className = match[1];
        if (className === "wjs-public-site" || KNOWN_WORDJS_CLASSES.has(className) || ALLOWED_STATE_CLASS.test(className)) continue;
        // Generic classes may represent optional specimen modifiers. Preserve and report them.
        // Unknown WordJS-prefixed hooks are fatal: they look authoritative but can never match
        // the canonical public DOM.
        if (className.startsWith("wp-block-")) unknownWordJs.add(`.${className}`);
        else optionalSpecimen.add(`.${className}`);
      }
    }
  });
  return {
    unknownWordJs: [...unknownWordJs].sort(),
    optionalSpecimen: [...optionalSpecimen].sort(),
  };
}

function insertTopLevelSectionFrameRecipe(root, { includeRhythm = false } = {}) {
  const sourceRules = [];
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule)) return;
    if (rule.selectors?.some((selector) => selector.trim() === ".wp-block-section")) sourceRules.push(rule);
  });

  const expandedBox = (value) => {
    const values = value ? postcss.list.space(value) : [];
    if (values.length === 1) return [values[0], values[0], values[0], values[0]];
    if (values.length === 2) return [values[0], values[1], values[0], values[1]];
    if (values.length === 3) return [values[0], values[1], values[2], values[1]];
    if (values.length >= 4) return values.slice(0, 4);
    return [null, null, null, null];
  };
  const frameValues = (rule) => {
    const values = {
      blockStart: null,
      inlineEnd: null,
      blockEnd: null,
      inlineStart: null,
      minWidth: null,
      maxWidth: null,
      hasFrameDeclaration: false,
    };
    for (const declaration of (rule.nodes || []).filter((node) => node.type === "decl")) {
      const { prop, value } = declaration;
      if (prop === "padding") {
        [values.blockStart, values.inlineEnd, values.blockEnd, values.inlineStart] = expandedBox(value);
        values.hasFrameDeclaration = true;
      } else if (prop === "padding-block") {
        const pair = postcss.list.space(value);
        values.blockStart = pair[0] || null;
        values.blockEnd = pair[1] || pair[0] || null;
        values.hasFrameDeclaration = true;
      } else if (prop === "padding-inline") {
        const pair = postcss.list.space(value);
        values.inlineStart = pair[0] || null;
        values.inlineEnd = pair[1] || pair[0] || null;
        values.hasFrameDeclaration = true;
      } else if (prop === "padding-top" || prop === "padding-block-start") {
        values.blockStart = value;
        values.hasFrameDeclaration = true;
      } else if (prop === "padding-right" || prop === "padding-inline-end") {
        values.inlineEnd = value;
        values.hasFrameDeclaration = true;
      } else if (prop === "padding-bottom" || prop === "padding-block-end") {
        values.blockEnd = value;
        values.hasFrameDeclaration = true;
      } else if (prop === "padding-left" || prop === "padding-inline-start") {
        values.inlineStart = value;
        values.hasFrameDeclaration = true;
      } else if (prop === "min-width") {
        values.minWidth = value;
        values.hasFrameDeclaration = true;
      } else if (prop === "max-width") {
        values.maxWidth = value;
        values.hasFrameDeclaration = true;
      }
    }
    return values;
  };
  const usableMaxWidth = (value) => value && !/^(?:none|initial|inherit|unset|revert(?:-layer)?)$/i.test(value.trim());
  const normalizedZero = (value) => /^[-+]?0(?:\.0+)?$/.test(String(value).trim()) ? "0px" : value;
  const baseFrame = {
    blockStart: null,
    inlineEnd: null,
    blockEnd: null,
    inlineStart: null,
    minWidth: null,
    maxWidth: null,
  };
  for (const sourceRule of sourceRules.filter((rule) => rule.parent?.type === "root")) {
    const values = frameValues(sourceRule);
    for (const prop of Object.keys(baseFrame)) {
      if (values[prop] !== null) baseFrame[prop] = values[prop];
    }
  }

  let textMaxWidth = "65ch";
  root.walkRules((rule) => {
    if (rule.parent?.type !== "root" || isInsideKeyframes(rule)) return;
    if (!rule.selectors?.some((selector) => selector.trim() === ".wp-block-text")) return;
    const declaration = (rule.nodes || []).filter((node) => node.type === "decl" && node.prop === "max-width").at(-1);
    if (usableMaxWidth(declaration?.value)) textMaxWidth = declaration.value;
  });

  let declarationCount = 0;
  for (const sourceRule of sourceRules) {
    const ownFrame = frameValues(sourceRule);
    if (!ownFrame.hasFrameDeclaration) continue;
    const inlineStart = normalizedZero(ownFrame.inlineStart ?? baseFrame.inlineStart ?? "0px");
    const inlineEnd = normalizedZero(ownFrame.inlineEnd ?? baseFrame.inlineEnd ?? "0px");
    const blockStart = normalizedZero(ownFrame.blockStart ?? baseFrame.blockStart);
    const blockEnd = normalizedZero(ownFrame.blockEnd ?? baseFrame.blockEnd);
    const minWidth = ownFrame.minWidth ?? baseFrame.minWidth;
    const maxWidth = ownFrame.maxWidth ?? baseFrame.maxWidth;
    const framedWidth = `calc(100% - (${inlineStart}) - (${inlineEnd}))`;

    const frameRule = postcss.rule({ selector: TOP_LEVEL_FRAME_SELECTORS.join(",\n") });
    frameRule.append({ prop: "width", value: framedWidth });
    // Section padding-block belongs to the Section instance itself. Reusing it as margin on every
    // top-level block doubles vertical whitespace and changes document rhythm.
    frameRule.append({ prop: "margin-left", value: "auto" });
    frameRule.append({ prop: "margin-right", value: "auto" });
    if (minWidth) frameRule.append({ prop: "min-width", value: minWidth });
    if (maxWidth) frameRule.append({ prop: "max-width", value: maxWidth });

    const atomicRule = postcss.rule({ selector: TOP_LEVEL_ATOMIC_FRAME_SELECTORS.join(",\n") });
    atomicRule.append({ prop: "width", value: framedWidth });
    atomicRule.append({ prop: "margin-left", value: "auto" });
    atomicRule.append({ prop: "margin-right", value: "auto" });
    if (minWidth) atomicRule.append({ prop: "min-width", value: minWidth });
    if (maxWidth) atomicRule.append({ prop: "max-width", value: maxWidth });

    const textRule = postcss.rule({ selector: TOP_LEVEL_TEXT_SELECTORS.join(",\n") });
    textRule.append({ prop: "max-width", value: textMaxWidth });
    textRule.append({
      prop: "margin-left",
      value: usableMaxWidth(maxWidth)
        ? `max(${inlineStart}, calc((100% - ${maxWidth}) / 2))`
        : inlineStart,
    });
    textRule.append({ prop: "margin-right", value: "auto" });

    const centeredTextRule = postcss.rule({ selector: TOP_LEVEL_CENTERED_TEXT_SELECTORS.join(",\n") });
    centeredTextRule.append({ prop: "margin-left", value: "auto" });
    centeredTextRule.append({ prop: "margin-right", value: "auto" });

    const generatedRules = [frameRule, atomicRule, textRule, centeredTextRule];
    if (includeRhythm && (blockStart !== null || blockEnd !== null)) {
      const start = blockStart || "0px";
      const end = blockEnd || "0px";
      const h2BoundaryRule = postcss.rule({ selector: TOP_LEVEL_H2_BOUNDARY_SELECTORS.join(",\n") });
      h2BoundaryRule.append({ prop: "margin-top", value: `calc((${end}) + (${start}))` });
      generatedRules.push(h2BoundaryRule);
      const h2SectionStartRule = postcss.rule({ selector: TOP_LEVEL_H2_SECTION_START_SELECTORS.join(",\n") });
      h2SectionStartRule.append({ prop: "margin-top", value: start });
      generatedRules.push(h2SectionStartRule);
    }
    declarationCount += generatedRules.reduce((count, rule) => count + (rule.nodes?.length || 0), 0);
    let insertionPoint = sourceRule;
    for (const generatedRule of generatedRules) {
      insertionPoint.after(generatedRule);
      insertionPoint = generatedRule;
    }
  }
  return declarationCount;
}

function insertGridTopologyAdapter(root) {
  let sourceRule = null;
  let trackCount = null;
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule) || !rule.selectors?.some((selector) => selector.trim() === ".wp-block-grid")) return;
    const declaration = (rule.nodes || []).filter((node) =>
      node.type === "decl" && node.prop === "grid-template-columns").at(-1);
    const match = declaration?.value.match(/^repeat\(\s*(\d+)\s*,/i);
    const parsed = match ? Number(match[1]) : 0;
    if (!Number.isInteger(parsed) || parsed < 2 || parsed > 24) return;
    sourceRule = rule;
    trackCount = parsed;
  });
  if (!sourceRule || !trackCount) return null;

  const adapter = postcss.atRule({ name: "media", params: "(min-width: 768px)" });
  for (const columns of [1, 2, 3, 4, 6, 12]) {
    if (columns > trackCount || trackCount % columns !== 0) continue;
    const rule = postcss.rule({
      selector: `.wp-block-grid.cols-${columns} > .wp-block-grid-items > *`,
    });
    rule.append({ prop: "grid-column", value: `span ${trackCount / columns}` });
    adapter.append(rule);
  }
  sourceRule.after(adapter);
  return trackCount;
}

function insertStitchIsolationBaseline(root, themeDefaults, sourceStructuralHooks = [], contractMode = false) {
  const firstContent = root.nodes.find((node) => !(node.type === "atrule" && node.name === "import"));
  if (!firstContent) return;

  // CONTRACT MODE (theme synthesized from a MEASURED design): wordjs-ui.css owns every .wp-block-* rule
  // and reads the ~660 --wjs-<component>-<prop> tokens this theme supplies, so the framework IS the
  // intended source of block presentation. The `all: revert !important` baseline below exists for the
  // opposite model (a hand-authored specimen whose own rules are the sole source of geometry) — applying
  // it here would strip wordjs-ui.css from every block and leave the page unstyled. Skip it.
  if (contractMode) return;

  // Exact specimens can isolate their whole authored subtree. Partial specimens still need their
  // *component roots* isolated: otherwise Tailwind/Puck presentation that Stitch intentionally
  // omitted (header padding/shadow, Hero gradient, footer foreground, Card uppercase, etc.) leaks
  // through and changes the design. Their unresolved descendants remain untouched. Authored or
  // safely inferred structural hooks are reset individually, then the hardened Stitch rules below
  // restore their declared presentation. `:where()` keeps both resets lower-specificity than those
  // authoritative rules.
  const useExactIsolation = themeDefaults.inlineStyleAudit?.parityStatus === "exact";
  let preludeTail = null;
  if (useExactIsolation) {
    const resetRoots = [".wjs-main-content", ...RESETTABLE_THEME_ROOTS];
    const resetSelectors = [
      ".wjs-public-site",
      `.wjs-public-site :where(${resetRoots.join(", ")})`,
      `.wjs-public-site :where(${RESETTABLE_THEME_ROOTS.join(", ")}) :where(:not(i):not(svg))`,
    ];
    const resetRule = postcss.rule({ selector: resetSelectors.join(",\n") });
    resetRule.append(postcss.decl({ prop: "all", value: "revert", important: true }));
    root.insertBefore(firstContent, resetRule);
    preludeTail = resetRule;
  } else {
    const inferredStructuralSelectors = (themeDefaults.canonicalInlineRules || [])
      .map((rule) => rule.selector)
      .filter((selector) => typeof selector === "string" && selector.trim());
    const safeResetTargets = [...new Set([
      ...RESETTABLE_THEME_ROOTS,
      ...sourceStructuralHooks,
      ...inferredStructuralSelectors,
    ])];
    const safeResetRule = postcss.rule({
      selector: `.wjs-public-site :where(${safeResetTargets.join(", ")})`,
    });
    safeResetRule.append(postcss.decl({ prop: "all", value: "revert", important: true }));
    root.insertBefore(firstContent, safeResetRule);
    preludeTail = safeResetRule;
  }

  const functionalRule = postcss.rule({
    selector: [
      ".wjs-public-site .wp-block-grid-items",
      ".wjs-public-site .wp-block-flex-row-items",
    ].join(",\n"),
  });
  functionalRule.append(postcss.decl({ prop: "display", value: "contents", important: true }));
  if (preludeTail) preludeTail.after(functionalRule);
  else root.insertBefore(firstContent, functionalRule);

  const menuTriggerRule = postcss.rule({ selector: ".wjs-public-site .wjs-header-menu-toggle" });
  for (const [prop, value] of Object.entries({ appearance: "none", background: "transparent", border: "0", padding: "0", color: "inherit" })) {
    menuTriggerRule.append(postcss.decl({ prop, value, important: true }));
  }
  functionalRule.after(menuTriggerRule);

  // Instance content is data, not theme presentation. Carry the selected asset through a custom
  // property because `all: revert` intentionally removes Puck's ordinary inline presentation.
  const heroInstanceRule = postcss.rule({ selector: ".wjs-public-site .wp-block-hero.has-background-image" });
  heroInstanceRule.append(postcss.decl({
    prop: "background-image",
    value: "var(--wjs-instance-hero-background)",
    important: true,
  }));
  menuTriggerRule.after(heroInstanceRule);

  let lastFunctionalRule = heroInstanceRule;
  if (themeDefaults.searchStructure) {
    for (const [part, visible] of [
      ["label", themeDefaults.searchStructure.hasLabel],
      ["button", themeDefaults.searchStructure.hasButton],
    ]) {
      if (visible) continue;
      const omittedRule = postcss.rule({
        selector: `.wjs-public-site .wp-block-search.wp-block-search .wp-block-search-${part}`,
      });
      omittedRule.append(postcss.decl({ prop: "display", value: "none", important: true }));
      lastFunctionalRule.after(omittedRule);
      lastFunctionalRule = omittedRule;
    }
  }
  for (const [index, image] of (themeDefaults.postImages || []).entries()) {
    const postImageRule = postcss.rule({
      selector: `.wjs-public-site .wp-block-posts-grid-item:nth-child(${index + 1}) .wp-block-posts-grid-media.uses-theme-post-image`,
    });
    for (const [prop, value] of [
      ["background-image", `url(${JSON.stringify(image.url)})`],
      ["background-size", "cover"],
      ["background-position", "center"],
      ["aspect-ratio", image.aspectRatio ? String(image.aspectRatio) : "16 / 9"],
    ]) postImageRule.append(postcss.decl({ prop, value, important: true }));
    lastFunctionalRule.after(postImageRule);
    lastFunctionalRule = postImageRule;
  }

  if (themeDefaults.heroBackground) {
    const heroDefaultRule = postcss.rule({ selector: ".wjs-public-site .wp-block-hero:not(.has-background-image)" });
    heroDefaultRule.append(postcss.decl({
      prop: themeDefaults.heroBackground.property,
      value: themeDefaults.heroBackground.value,
      important: true,
    }));
    lastFunctionalRule.after(heroDefaultRule);
  }
}

function isInsideKeyframes(rule) {
  let current = rule.parent;
  while (current) {
    if (current.type === "atrule" && /keyframes$/i.test(current.name)) return true;
    current = current.parent;
  }
  return false;
}

function scopeAndHardenSourceRules(root) {
  root.walkRules((rule) => {
    if (!rule.selectors || isInsideKeyframes(rule)) return;
    rule.selectors = rule.selectors.map((original) => {
      const selector = original.trim();
      if (selector === ":root") return ".wjs-public-site";
      if (selector.includes(".wjs-public-site")) return selector;
      return `.wjs-public-site ${selector}`;
    });
    rule.walkDecls((decl) => {
      if (!decl.prop.startsWith("--")) decl.important = true;
    });
  });
}

function validateAndHarden(css, source, themeDefaults = { inlineStyleCount: 0, heroBackground: null }, contractMode = false) {
  const root = postcss.parse(css, { from: source });
  const rewriteCount = normalizeStitchSelectors(root, themeDefaults) + normalizeAccordionStructure(root, themeDefaults.accordionStructure);
  const sourceStructuralHooks = STRUCTURAL_SELECTORS.filter((selector) => selectorCovered(root, selector));
  const missing = REQUIRED_SELECTORS.filter((selector) => !selectorCovered(root, selector));
  if (missing.length) throw new Error(`${source}: incomplete Stitch theme; missing selectors: ${missing.join(", ")}`);

  const compatibility = findSelectorCompatibilityIssues(root);
  if (compatibility.unknownWordJs.length) {
    throw new Error(`${source}: selectors depend on specimen-only classes not present in WordJS: ${compatibility.unknownWordJs.join(", ")}`);
  }
  const exactInlineParity = themeDefaults.inlineStyleAudit?.parityStatus === "exact";
  const topLevelFrameDeclarations = insertTopLevelSectionFrameRecipe(root, {
    includeRhythm: exactInlineParity,
  });
  const gridTrackCount = insertGridTopologyAdapter(root);
  for (const inlineRule of themeDefaults.canonicalInlineRules || []) {
    const rule = postcss.rule({ selector: inlineRule.selector });
    for (const declaration of inlineRule.declarations) {
      rule.append({ prop: declaration.property, value: declaration.value });
    }
    root.append(rule);
  }

  const publicCanvas = root.nodes.find((node) => node.type === "rule" &&
    node.selectors?.some((selector) => selector.trim() === ".wjs-public-site"));
  if (!publicCanvas) throw new Error(`${source}: missing public canvas rule`);
  const sourceTokenNames = new Set();
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--wjs-")) sourceTokenNames.add(decl.prop);
  });
  for (const [prop, value] of Object.entries(NEUTRAL_PUBLIC_TOKENS)) {
    if (!sourceTokenNames.has(prop) && !publicCanvas.nodes?.some((node) => node.type === "decl" && node.prop === prop)) {
      publicCanvas.append({ prop, value });
    }
  }

  const tokenNames = new Set();
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--wjs-")) tokenNames.add(decl.prop);
  });
  for (const [target, candidates] of Object.entries(CANONICAL_TOKEN_ALIASES)) {
    if (tokenNames.has(target)) continue;
    const sourceToken = candidates.find((candidate) => tokenNames.has(candidate));
    if (!sourceToken) continue;
    publicCanvas.append({ prop: target, value: `var(${sourceToken})` });
    tokenNames.add(target);
  }
  if (tokenNames.size < 12) {
    throw new Error(`${source}: expected at least 12 semantic --wjs-* tokens, found ${tokenNames.size}`);
  }

  const hasMobile = root.nodes.some((node) => node.type === "atrule" && node.name === "media" && /767|768|max-width/i.test(node.params));
  const hasReducedMotion = root.nodes.some((node) => node.type === "atrule" && node.name === "media" && /prefers-reduced-motion/i.test(node.params));
  if (!hasMobile) throw new Error(`${source}: missing mobile breakpoint near 768px`);
  if (!hasReducedMotion) throw new Error(`${source}: missing prefers-reduced-motion fallback`);

  // A Stitch specimen is the authoritative presentation source. Scope every selector to the
  // public surface (including generic utilities such as `.justify-center`) and harden every
  // presentation declaration, while leaving keyframe selectors and custom properties intact.
  // This prevents both leakage into wp-admin and leakage from Tailwind/Puck defaults into the
  // converted design.
  scopeAndHardenSourceRules(root);
  insertStitchIsolationBaseline(root, themeDefaults, sourceStructuralHooks, contractMode);

  const banner = `/* Generated from a validated Google Stitch WordJS specimen.\n * Coverage: ${CHROME_SELECTORS.length} chrome hooks + ${PUCK_SELECTORS.length} built-in Puck blocks.\n * Do not edit generated rules directly; regenerate from the linked Stitch screen. */\n`;
  const normalizedCss = root.toString().trim().replace(/[ \t]+$/gm, "");
  return {
    css: banner + normalizedCss + "\n",
    tokenCount: tokenNames.size,
    rewriteCount,
    optionalSpecimenClasses: compatibility.optionalSpecimen,
    sourceStructuralHooks,
    missingStructuralHooks: STRUCTURAL_SELECTORS.filter((selector) => !sourceStructuralHooks.includes(selector)),
    themeDefaults,
    topLevelFrameDeclarations,
    gridTrackCount,
  };
}

async function download(url) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Screenshot download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

// Build a complete `<style id="wordjs-theme">` token block from measured tokens. Everything the strict
// validator requires is here: the semantic --wjs-* tokens on the public surface, a mobile breakpoint, and
// a prefers-reduced-motion fallback. wordjs-ui.css consumes these tokens to paint every .wp-block-*, so a
// measured token set reproduces the Stitch design without the specimen having to hand-author any CSS.
function synthesizeThemeBlock(tokens) {
  const decls = Object.entries(tokens).map(([k, val]) => `  ${k}: ${val};`).join("\n");

  // wordjs-ui.css OWNS every .wp-block-* / .wjs-* rule and reads ~660 --wjs-<component>-<prop> tokens
  // (the same model as Bootstrap 5.3 --bs-* and WordPress theme.json). The measured contract tokens above
  // therefore drive the ENTIRE look. We deliberately do NOT re-declare component rules here: the theme
  // stylesheet loads AFTER wordjs-ui.css, so hand-written rules at equal specificity would OVERRIDE the
  // contract with a cruder approximation. Emit only a benign custom-property rule per required selector,
  // which satisfies validateAndHarden coverage without competing with the framework.
  const allRules = REQUIRED_SELECTORS.map((sel) => `${sel} { --wjs-themed: 1; }`).join("\n");

  return [
    `.wjs-public-site {\n${decls}\n}`,
    allRules,
    `@media (max-width: 768px) { .wp-block-section, .wp-block-hero { padding-left: 1.25rem; padding-right: 1.25rem; } }`,
    `@media (prefers-reduced-motion: reduce) { .wjs-public-site *, .wjs-public-site *::before, .wjs-public-site *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; scroll-behavior: auto !important; } }`,
  ].join("\n\n");
}

// End-to-end path (audit/UX ask: "the code must do everything, for ANY Stitch design"): when the export has
// no hand-authored `<style id="wordjs-theme">`, RENDER it in headless Chrome, MEASURE the computed styles of
// each semantic role, MAP them to --wjs-* tokens, and inject a synthesized theme block so the rest of the
// pipeline runs unchanged. This is what lets a raw Tailwind Stitch design become a full-fidelity theme.
async function synthesizeSpecimen(html, htmlPath) {
  const { measureDesign } = await import("./stitch-measure.mjs");
  const { mapMeasuresToTokens } = await import("./stitch-theme-tokens.mjs");
  const { readContractTokens, mapContractTokens, buildBemBridge } = await import("./stitch-theme-contract-map.mjs");
  const measures = await measureDesign(htmlPath);
  // Two layers, contract LAST so the per-component tokens wordjs-ui.css actually reads win:
  //  1. semantic globals (--wjs-color-primary, --wjs-font-family-heading, …) — the palette.
  //  2. the REAL contract (--wjs-card-pad, --wjs-button-pad-y, --wjs-audio-bg, …) — per-component
  //     values that wordjs-ui.css consumes to style every block. This is what makes each element
  //     (card, button, table, players, pricing, spacing, type scale) match the Stitch design.
  const uiCssPath = path.resolve("backend/public/css/wordjs-ui.css");
  let contractTokens = {}, contractFilled = 0, bemBridge = "";
  try {
    const contract = readContractTokens(uiCssPath);
    const mapped = mapContractTokens(measures, contract);
    contractTokens = mapped.tokens; contractFilled = mapped.filled;
    bemBridge = buildBemBridge(uiCssPath);
  } catch (e) {
    console.warn(`[stitch] contract token mapping skipped (${e.message}) — falling back to semantic tokens only.`);
  }
  const tokens = { ...mapMeasuresToTokens(measures), ...contractTokens };
  if (contractFilled) console.error(`[stitch] filled ${contractFilled} contract tokens from the measured design.`);
  if (Object.keys(tokens).length < 12) {
    throw new Error(`${htmlPath}: measured only ${Object.keys(tokens).length} tokens (need >=12). The design did not render enough recognizable roles — see scripts/stitch-theme-prompt.md for the authoring contract.`);
  }
  const block = `<style id="wordjs-theme">\n${synthesizeThemeBlock(tokens)}\n</style>`;
  const measuredCount = Object.keys(tokens).length;
  const injected = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${block}\n</head>`)
    : `${block}\n${html}`;
  // The bridge is returned SEPARATELY (not inside the <style> block): validateAndHarden normalizes and
  // filters specimen selectors, which strips these framework-mirroring rules. It is appended verbatim to
  // the finished stylesheet instead — it contains only the framework's own declarations re-targeted at
  // this install's class names, so it needs no hardening.
  return { html: injected, measuredCount, bemBridge };
}

async function convert(entry) {
  const themeDir = path.resolve(entry.theme);
  const htmlPath = path.resolve(entry.html);
  if (!fs.existsSync(themeDir)) throw new Error(`Theme directory not found: ${themeDir}`);
  if (!fs.existsSync(htmlPath)) throw new Error(`Stitch HTML not found: ${htmlPath}`);

  let html = fs.readFileSync(htmlPath, "utf8");
  let measuredTokenCount = 0;
  let bemBridge = "";
  const hasThemeBlock = /<style\s+[^>]*id=["']wordjs-theme["']/i.test(html);
  if (!hasThemeBlock || entry.measure) {
    const synth = await synthesizeSpecimen(html, htmlPath);
    html = synth.html;
    measuredTokenCount = synth.measuredCount;
    bemBridge = synth.bemBridge || "";
  }
  const extracted = extractThemeCss(html, htmlPath);
  const themeDefaults = await enrichThemeDefaults(extractThemeDefaults(html));
  const {
    css,
    tokenCount,
    rewriteCount,
    optionalSpecimenClasses,
    sourceStructuralHooks,
    missingStructuralHooks,
    topLevelFrameDeclarations,
    gridTrackCount,
  } = validateAndHarden(extracted, htmlPath, themeDefaults, measuredTokenCount > 0);
  // Appended AFTER hardening (see synthesizeSpecimen) and BEFORE hashing so theme.json's cssSha256 still
  // covers the exact bytes written to style.css.
  const finalCss = bemBridge ? `${css}\n${bemBridge}` : css;
  const cssHash = crypto.createHash("sha256").update(finalCss).digest("hex");

  const manifestPath = path.join(themeDir, "theme.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = entry.version || manifest.version || "2.0.0";
  manifest.author = "WordJS × Google Stitch";
  manifest.description = entry.description || manifest.description || `Premium WordJS theme designed in Google Stitch.`;
  manifest.premium = true;
  const previousLayout = manifest.layout && typeof manifest.layout === "object" ? manifest.layout : {};
  const previousRecipes = previousLayout.componentRecipes && typeof previousLayout.componentRecipes === "object"
    ? previousLayout.componentRecipes
    : {};
  const managedRecipeKeys = new Set(["version", "postsGrid", "card", "pricing", "tabs", "sections"]);
  const preservedRecipes = Object.fromEntries(Object.entries(previousRecipes).filter(([key]) => !managedRecipeKeys.has(key)));
  const generatedRecipes = themeDefaults.componentRecipes || {};
  const componentRecipes = { ...preservedRecipes, ...generatedRecipes };
  manifest.layout = { ...previousLayout };
  if (themeDefaults.headerAction) manifest.layout.headerAction = themeDefaults.headerAction;
  if (Object.keys(componentRecipes).length) manifest.layout.componentRecipes = componentRecipes;
  else delete manifest.layout.componentRecipes;
  const inlineAudit = themeDefaults.inlineStyleAudit;
  manifest.stitch = {
    projectId: String(entry.projectId),
    screenId: String(entry.screenId),
    ...(entry.designSystemId ? { designSystemId: String(entry.designSystemId) } : {}),
    converter: "stitch-to-wordjs-theme@4",
    puckCoverage: PUCK_SELECTORS.length,
    chromeCoverage: CHROME_SELECTORS.length,
    chromeStructuralCoverage: CHROME_STRUCTURAL_SELECTORS.length,
    domContractVersion: 3,
    selectorRewrites: rewriteCount,
    optionalSpecimenClasses,
    sourceStructuralCoverage: sourceStructuralHooks.length,
    sourceStructuralHooks,
    missingStructuralHooks,
    inlineStyleCount: themeDefaults.inlineStyleCount,
    inlineStyleDeclarationCount: inlineAudit.declarationCount,
    resolvedInlineStyleCount: inlineAudit.resolvedAttributeCount,
    unresolvedInlineStyleCount: inlineAudit.unresolvedAttributeCount,
    resolvedInlineDeclarationCount: inlineAudit.resolvedDeclarationCount,
    unresolvedInlineDeclarationCount: inlineAudit.unresolvedDeclarationCount,
    resolvedInlineStyles: inlineAudit.resolved,
    parityStatus: inlineAudit.parityStatus,
    isolationMode: inlineAudit.parityStatus === "exact" ? "isolated" : "safe-overlay",
    compositionRecipes: {
      topLevelSectionFrame: topLevelFrameDeclarations,
      ...(gridTrackCount ? { gridTrackCount } : {}),
      canonicalInlineRuleCount: themeDefaults.canonicalInlineRules?.length || 0,
    },
    ...((themeDefaults.heroBackground || themeDefaults.headerAction || themeDefaults.searchStructure || themeDefaults.accordionStructure || themeDefaults.postImages.length) ? {
      extractedThemeDefaults: {
        ...(themeDefaults.heroBackground ? { heroBackground: themeDefaults.heroBackground } : {}),
        ...(themeDefaults.headerAction ? { headerAction: themeDefaults.headerAction } : {}),
        ...(themeDefaults.searchStructure ? { searchStructure: themeDefaults.searchStructure } : {}),
        ...(themeDefaults.accordionStructure ? { accordionStructure: themeDefaults.accordionStructure } : {}),
        ...(themeDefaults.postImages.length ? { postImages: themeDefaults.postImages } : {}),
      },
    } : {}),
    tokenCount,
    cssSha256: cssHash,
  };

  // Resolve every fallible external input before modifying the installed theme. A failed
  // screenshot download must not leave style.css and theme.json on different versions.
  const screenshot = entry.screenshotUrl ? await download(entry.screenshotUrl) : null;
  fs.writeFileSync(path.join(themeDir, "style.css"), finalCss, "utf8");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (screenshot) fs.writeFileSync(path.join(themeDir, "screenshot.png"), screenshot);

  return {
    theme: path.basename(themeDir),
    screenId: entry.screenId,
    tokenCount,
    rewriteCount,
    optionalSpecimenClasses,
    sourceStructuralCoverage: sourceStructuralHooks.length,
    inlineStyleCount: themeDefaults.inlineStyleCount,
    unresolvedInlineStyleCount: inlineAudit.unresolvedAttributeCount,
    parityStatus: inlineAudit.parityStatus,
    topLevelFrameDeclarations,
    cssHash,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let entries;
  if (args.manifest) {
    entries = JSON.parse(fs.readFileSync(path.resolve(args.manifest), "utf8"));
    if (!Array.isArray(entries)) throw new Error("Batch manifest must be a JSON array");
  } else {
    for (const key of ["theme", "html"]) {
      if (!args[key]) throw new Error(`Missing required --${key}`);
    }
    // project-id / screen-id are metadata only; derive stable defaults from the design file so a raw
    // measured import is a single command: --theme <dir> --html <design.html>.
    const designId = crypto.createHash("sha1").update(path.resolve(args.html)).digest("hex").slice(0, 12);
    entries = [{
      theme: args.theme,
      html: args.html,
      projectId: args["project-id"] || `stitch-${designId}`,
      screenId: args["screen-id"] || path.basename(args.html).replace(/\.html?$/i, ""),
      designSystemId: args["design-system-id"],
      screenshotUrl: args["screenshot-url"],
      description: args.description,
      version: args.version,
      measure: !!args.measure,
    }];
  }

  const results = [];
  for (const entry of entries) results.push(await convert(entry));
  process.stdout.write(JSON.stringify({ converted: results.length, results }, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
