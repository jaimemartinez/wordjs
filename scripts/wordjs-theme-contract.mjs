/**
 * Canonical public DOM contract shared by Stitch theme conversion and its tests.
 *
 * Root hooks identify the 28 built-in Puck blocks. Structural hooks identify stable
 * descendants that a visual theme may style without depending on transient JSX tags,
 * Tailwind utilities, inline styles, or editor implementation details.
 */

export const CHROME_SELECTORS = [
  ".wjs-public-site",
  ".wjs-site-header", ".wjs-header-container", ".wjs-header-logo",
  ".wjs-header-nav", ".wjs-header-actions", ".wjs-header-mobile-panel",
  ".wjs-site-footer", ".wjs-footer-grid", ".wjs-footer-brand",
  ".wjs-footer-menu", ".wjs-footer-socials", ".wjs-footer-copyright",
];

// Stable implementation hooks used by the live WordJS shell. Stitch specimens may omit these
// support elements, so they are validated against React but are not counted as authored chrome.
export const CHROME_STRUCTURAL_SELECTORS = [
  ".wjs-main-content", ".wjs-header-action", ".wjs-header-menu-toggle",
  ".wjs-header-mobile-overlay", ".wjs-header-mobile-drawer",
  ".wjs-footer-container",
];

export const PUCK_SELECTORS = [
  ".wp-block-heading", ".wp-block-text", ".wp-block-image", ".wp-block-columns",
  ".wp-block-card", ".wp-block-divider", ".wp-block-button", ".wp-block-spacer",
  ".wp-block-section", ".wp-block-grid", ".wp-block-flex-row", ".wp-block-accordion",
  ".wp-block-tabs", ".wp-block-video-embed", ".wp-block-audio-player",
  ".wp-block-pricing", ".wp-block-testimonial", ".wp-block-cta-banner",
  ".wp-block-posts-grid", ".wp-block-category-posts", ".wp-block-search",
  ".wp-block-hero", ".wp-block-quote", ".wp-block-table", ".wp-block-icon-list",
  ".wp-block-social-links", ".wp-block-stats", ".wp-block-html-embed",
];

export const STRUCTURAL_SELECTORS = [
  ".wp-block-image-element", ".wp-block-column", ".wp-block-grid-items", ".wp-block-flex-row-items", ".wp-block-button-wrap",
  ".wp-block-card-media", ".wp-block-card-icon", ".wp-block-card-title", ".wp-block-card-description",
  ".wp-block-accordion-item", ".wp-block-accordion-trigger", ".wp-block-accordion-icon", ".wp-block-accordion-panel",
  ".wp-block-tabs-nav", ".wp-block-tabs-tab", ".wp-block-tabs-panel",
  ".wp-block-video-embed-frame", ".wp-block-video-embed-placeholder",
  ".wp-block-audio-player-layout", ".wp-block-audio-player-icon", ".wp-block-audio-player-body", ".wp-block-audio-player-title", ".wp-block-audio-player-track", ".wp-block-audio-player-progress", ".wp-block-audio-player-control",
  ".wp-block-pricing-plan", ".wp-block-pricing-name", ".wp-block-pricing-price", ".wp-block-pricing-period", ".wp-block-pricing-features", ".wp-block-pricing-feature", ".wp-block-pricing-action",
  ".wp-block-testimonial-mark", ".wp-block-testimonial-quote", ".wp-block-testimonial-author", ".wp-block-testimonial-avatar", ".wp-block-testimonial-name", ".wp-block-testimonial-role",
  ".wp-block-cta-banner-title", ".wp-block-cta-banner-subtitle", ".wp-block-cta-banner-action",
  ".wp-block-posts-grid-item", ".wp-block-posts-grid-media", ".wp-block-posts-grid-meta", ".wp-block-posts-grid-title", ".wp-block-posts-grid-excerpt",
  ".wp-block-category-posts-header", ".wp-block-category-posts-heading", ".wp-block-category-posts-link", ".wp-block-category-posts-list", ".wp-block-category-posts-item", ".wp-block-category-posts-title", ".wp-block-category-posts-excerpt",
  ".wp-block-search-label", ".wp-block-search-controls", ".wp-block-search-input", ".wp-block-search-button",
  ".wp-block-hero-overlay", ".wp-block-hero-content", ".wp-block-hero-title", ".wp-block-hero-subtitle", ".wp-block-hero-actions", ".wp-block-hero-action",
  ".wp-block-quote-mark", ".wp-block-quote-text", ".wp-block-quote-cite",
  ".wp-block-table-element", ".wp-block-table-head", ".wp-block-table-row", ".wp-block-table-cell",
  ".wp-block-icon-list-item", ".wp-block-icon-list-icon", ".wp-block-icon-list-content", ".wp-block-icon-list-title", ".wp-block-icon-list-text",
  ".wp-block-social-links-item", ".wp-block-social-links-icon",
  ".wp-block-stats-item", ".wp-block-stats-value", ".wp-block-stats-label",
];

export const REQUIRED_SELECTORS = [...CHROME_SELECTORS, ...PUCK_SELECTORS];

/**
 * Structural selectors commonly emitted by Stitch specimens that do not match the
 * canonical React DOM. Rewrites are deliberately narrow and auditable.
 */
export const STITCH_SELECTOR_REWRITES = [
  [/\.text-center\s+\.wp-block-text/g, ".wp-block-text.text-center"],
  [/\.wp-block-heading\.level-([1-6])/g, ".wp-block-heading.heading-h$1"],
  [/\.wp-block-button\.(primary|secondary|outline|container)/g, ".wp-block-button.button-variant-$1"],
  [/\.wp-block-card\.glass-panel/g, ".wp-block-card"],
  [/\.wp-block-icon-list\.center/g, ".wp-block-icon-list.is-centered"],
  [/\.wp-block-accordion-content/g, ".wp-block-accordion-panel"],
  [/\.wp-block-accordion-summary/g, ".wp-block-accordion-trigger"],
  [/\.wp-block-accordion\s+\.accordion-content/g, ".wp-block-accordion-panel"],
  [/\.wp-block-tabs-content/g, ".wp-block-tabs-panel"],
  [/\.wp-block-tabs-button/g, ".wp-block-tabs-tab"],
  [/\.wp-block-tabs\s+\.tab-header/g, ".wp-block-tabs-nav"],
  [/\.wp-block-tabs\s+\.tab-btn/g, ".wp-block-tabs-tab"],
  [/\.wp-block-tabs\s+\.tab-content/g, ".wp-block-tabs-panel"],
  [/\.wp-block-pricing-(?:card|tier)/g, ".wp-block-pricing-plan"],
  [/\.wp-block-pricing-plan\.(?:popular|featured)/g, ".wp-block-pricing-plan.is-highlighted"],
  [/\.wp-block-pricing-plan\s+\.price/g, ".wp-block-pricing-price"],
  [/\.wp-block-post-card/g, ".wp-block-posts-grid-item"],
  [/\.wp-block-post-thumb/g, ".wp-block-posts-grid-media"],
  [/\.wp-block-hero-bg/g, ".wp-block-hero-overlay"],
  [/\.wp-block-hero\s+\.hero-inner/g, ".wp-block-hero-content"],
  [/\.wp-block-stats\s+\.(?:stat-item)/g, ".wp-block-stats-item"],
  [/\.wp-block-stats\s+\.(?:stat-value|stat-number)/g, ".wp-block-stats-value"],
  [/\.wp-block-stat-number/g, ".wp-block-stats-value"],
  // Stitch reuses this specimen hook both for metric labels and post metadata. Preserve that
  // intentional shared styling while targeting the two canonical WordJS descendants.
  [/\.wp-block-stat-label/g, ":is(.wp-block-stats-label, .wp-block-posts-grid-meta)"],
  [/\.wp-block-stats\s+\.stat-label/g, ".wp-block-stats-label"],
  [/\.wp-block-video-embed\s+\.play-btn/g, ".wp-block-video-embed-placeholder"],
  [/\.wp-block-audio-player\s+\.play-btn/g, ".wp-block-audio-player-icon"],
  [/\.wp-block-audio-player\s+\.(?:track|progress)(?!-)/g, ".wp-block-audio-player-track"],
  [/\.wp-block-audio-player\s+\.(?:track-progress|progress-bar)/g, ".wp-block-audio-player-progress"],
  [/\.wp-block-icon-list\s+\.material-symbols-outlined/g, ".wp-block-icon-list-icon"],
  [/\.wp-block-accordion\s+details(?=\[|\s|:|\.|#|>|\+|~|$)/g, ".wp-block-accordion .wp-block-accordion-item"],
  [/\.wp-block-accordion-item((?:\[[^\]]+\])?)\s+summary/g, ".wp-block-accordion-item$1 .wp-block-accordion-trigger"],
  [/\.wp-block-accordion\s+summary(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-accordion .wp-block-accordion-trigger"],
  [/\.wp-block-icon-list\s+li(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-icon-list-item"],
  [/\.wp-block-pricing\s*>\s*div(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-pricing-plan"],
  [/\.wp-block-posts-grid\s*>?\s*article(?=\s|:|\.|#|>|\+|~|$)/g, ".wp-block-posts-grid-item"],
  [/\.wp-block-category-posts\s+\.post-item/g, ".wp-block-category-posts-item"],
  [/\.wp-block-button\.is-secondary/g, ".wp-block-button.button-variant-secondary"],
  [/\.wp-block-button\.is-primary/g, ".wp-block-button.button-variant-primary"],
];
