/**
 * Map measured Stitch computed styles (stitch-measures JSON, one design's role -> computed-style object)
 * onto the WordJS theme token vocabulary that wordjs-ui.css actually reads.
 *
 * This is the FIDELITY CORE the earlier static importer lost: the raw Stitch design encodes its colors,
 * radii, shadows, spacing and type in Tailwind utility classes, which only resolve to real values when
 * rendered. The measurer captures those computed values per semantic role; this module turns them into the
 * --wjs-* tokens so the emitted theme reproduces the design instead of falling back to a neutral canvas.
 *
 * Base layer (wordjs-ui.css reads these): --wjs-color-*, --wjs-bg-*, --wjs-font-family-*, --wjs-radius*,
 * --wjs-shadow*, --wjs-heading-*. Public geometry layer (per-region): --wjs-header-*, --wjs-footer-*,
 * --wjs-hero-*, --wjs-card-*, --wjs-button-*, --wjs-section-padding, --wjs-grid-gap, --wjs-block-*.
 */

// ---- value helpers ---------------------------------------------------------------------------------

const EMPTY = new Set(["", "none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)", "transparent"]);
const isSet = (v) => v !== undefined && v !== null && !EMPTY.has(String(v).trim());

/** A CSS color that actually paints (not fully transparent). Keeps rgb()/rgba()/hex verbatim. */
function paintColor(v) {
  if (!isSet(v)) return null;
  const m = String(v).match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length === 4 && parts[3] === 0) return null; // fully transparent
  }
  return String(v).trim();
}

/**
 * Tailwind stacks shadow/ring layers and reports zero-size, zero-alpha placeholders
 * ("rgba(0, 0, 0, 0) 0px 0px 0px 0px, ...") for the unused ones. Drop those so we keep only the layers
 * that actually cast a shadow. Returns "none" if nothing real remains.
 */
function cleanShadow(v) {
  if (!isSet(v)) return null;
  const layers = String(v).split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  const real = layers.filter((layer) => {
    const rgba = layer.match(/rgba?\(([^)]+)\)/i);
    const transparent = rgba && rgba[1].split(",").map((p) => parseFloat(p)).slice(3)[0] === 0;
    const zeroGeom = /(^|\s)0px 0px 0px 0px(\s|$)/.test(layer);
    return !(transparent || zeroGeom);
  });
  return real.length ? real.join(", ") : null;
}

/** First finite pixel from a shorthand like "16px 32px" -> 16. */
const firstPx = (v) => { const m = String(v || "").match(/-?\d*\.?\d+px/); return m ? parseFloat(m[0]) : null; };

/** A border shorthand from a measured width + color, or null when there is no visible border. */
function borderFrom(width, color) {
  const w = firstPx(width);
  const c = paintColor(color);
  if (!w || w <= 0 || !c) return null;
  return `${w}px solid ${c}`;
}

/** Parse an rgb/rgba string into components, or null. */
function rgbParts(v) {
  const m = String(v || "").match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
}
/** Drop alpha so a translucent brand tint (e.g. an icon chip at 10%) becomes its solid brand color. */
function deAlpha(v) { const c = rgbParts(v); return c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : null; }
/** Extract the color stops from a CSS gradient (Stitch renders many brand buttons as linear-gradients,
 *  whose computed backgroundColor is transparent — so the brand color lives here, not in backgroundColor). */
function gradientColors(v) {
  if (!v || !/gradient/i.test(String(v))) return [];
  return String(v).match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g) || [];
}
/** The gradient value itself (for a --wjs-primary-gradient token), or null. */
function gradientOf(v) { return v && /gradient/i.test(String(v)) ? String(v).trim() : null; }
/** A color worth using as the BRAND accent: opaque-ish, not near-white, not near-black, and either
 *  saturated or a mid/deep tone (so a navy/forest brand still qualifies). */
function isBrandable(v) {
  const c = rgbParts(v);
  if (!c || c.a < 0.5) return false;
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
  if (c.r > 232 && c.g > 232 && c.b > 232) return false; // near-white
  if (c.r < 32 && c.g < 32 && c.b < 32) return false;    // near-black (that's ink, not a brand accent)
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  return sat > 0.15 || mx < 200;
}

/** Strip the quotes Chrome adds around multi-word / fallback font-family lists; take the FIRST family. */
function primaryFont(v) {
  if (!isSet(v)) return null;
  const first = String(v).split(",")[0].trim().replace(/^["']|["']$/g, "");
  return first || null;
}

// ---- the mapping ------------------------------------------------------------------------------------

/**
 * @param {Record<string, any>} m  one design's measures: { nav, navLink, navCta, h1, hero, heroBtnPrimary,
 *   heroBtnSecondary, heroSubtitle, card, cardTitle, cardDesc, cardIcon, quote, formInput, formSubmit,
 *   footer, footerHeading, footerLink, body, pageWrap }
 * @returns {Record<string,string>} --wjs-* token -> value (only tokens we could derive; callers merge over
 *   NEUTRAL_PUBLIC_TOKENS so anything absent stays neutral).
 */
export function mapMeasuresToTokens(m) {
  const r = (name) => m?.[name] || {};
  const body = r("body"), h1 = r("h1"), hero = r("hero"), heroSub = r("heroSubtitle");
  const btnP = r("heroBtnPrimary"), btnS = r("heroBtnSecondary"), navCta = r("navCta");
  const card = r("card"), cardTitle = r("cardTitle"), cardDesc = r("cardDesc"), cardIcon = r("cardIcon");
  const nav = r("nav"), navLink = r("navLink"), footer = r("footer"), footerLink = r("footerLink");
  // Additional Puck blocks (measured when the specimen showcases them; empty otherwise).
  const secHead = r("sectionHeading"), accTrig = r("accordionTrigger"), accPanel = r("accordionPanel");
  const tab = r("tab"), tableHead = r("tableHead"), tableCell = r("tableCell");
  const statVal = r("statValue"), statLab = r("statLabel"), iconIcon = r("iconListIcon");
  const priceHi = r("pricingHighlighted"), price = r("pricingPrice"), testi = r("testimonialCard");
  const postCard = r("postCard"), postTitle = r("postTitle"), cta = r("ctaBanner"), badge = r("badge");
  const audioControl = r("audioControl"), audioTrack = r("audioTrack"), audioProgress = r("audioProgress");
  const audioTitle = r("audioTitle"), videoFrame = r("videoFrame"), videoPlaceholder = r("videoPlaceholder");
  const out = {};
  const put = (token, value) => { if (value !== null && value !== undefined && value !== "") out[token] = value; };

  // --- palette -----------------------------------------------------------------------------------
  // PRIMARY is measured from the design, NOT read from a "--primary" design token (Material-3 / Stitch
  // frequently name a near-white surface "primary"). Prefer the primary BUTTON background, then other
  // accents, but SKIP near-white/near-black candidates (a white-on-gradient CTA is not the brand color)
  // in favor of the first genuinely brand-worthy accent — the icon-chip tint (deAlpha'd), the nav CTA, a
  // secondary-button ink. Falls back to the raw button bg only if nothing brandable is found.
  // Gradient buttons/heroes report a transparent backgroundColor — pull the brand color from the gradient
  // stops so a gradient-forward design (e.g. an "aurora" theme) still gets a real primary, not a glass tint.
  const gradientCands = [btnP.backgroundImage, navCta.backgroundImage, hero.backgroundImage, cta.backgroundImage]
    .flatMap(gradientColors);
  const primaryCandidates = [
    btnP.backgroundColor, navCta.backgroundColor, ...gradientCands, deAlpha(cardIcon.backgroundColor),
    btnS.color, navLink.color,
  ].map(paintColor).filter(Boolean);
  const primary = primaryCandidates.find(isBrandable) || primaryCandidates[0] || null;
  // Preserve the actual gradient so buttons/CTA can render it (not just the flattened primary).
  const primaryGradient = gradientOf(btnP.backgroundImage) || gradientOf(navCta.backgroundImage) || gradientOf(cta.backgroundImage);
  if (primaryGradient) put("--wjs-primary-gradient", primaryGradient);
  put("--wjs-color-primary", primary);
  put("--wjs-primary", primary);
  put("--wjs-color-on-primary", paintColor(btnP.color) || paintColor(navCta.color));
  // Secondary = the secondary button's brand ink (its bg is usually a translucent glass surface).
  const secondary = paintColor(btnS.color) || primary;
  put("--wjs-color-secondary", secondary);
  put("--wjs-color-on-secondary", paintColor(btnS.backgroundColor) || paintColor(body.backgroundColor));

  put("--wjs-bg-canvas", paintColor(body.backgroundColor));
  put("--wjs-bg", paintColor(body.backgroundColor));
  put("--wjs-bg-surface", paintColor(card.backgroundColor) || paintColor(nav.backgroundColor));
  put("--wjs-bg-muted", paintColor(footer.backgroundColor) || paintColor(cardIcon.backgroundColor));

  const textMain = paintColor(body.color) || paintColor(h1.color);
  put("--wjs-color-text-main", textMain);
  put("--wjs-text-main", textMain);
  // Muted text: the description/subtitle grey (distinct from the near-black body ink).
  const textMuted = paintColor(cardDesc.color) || paintColor(heroSub.color) || paintColor(footerLink.color) || paintColor(navLink.color);
  put("--wjs-color-text-muted", textMuted);
  put("--wjs-text-muted", textMuted);
  put("--wjs-color-heading", paintColor(h1.color) || textMain);
  put("--wjs-color-link", paintColor(navLink.color) || primary);
  put("--wjs-color-link-hover", primary);

  // --- typography --------------------------------------------------------------------------------
  put("--wjs-font-family-base", primaryFont(body.fontFamily));
  put("--wjs-font-body", primaryFont(body.fontFamily));
  // Display font only if the H1 actually uses a different family than body.
  const bodyFont = primaryFont(body.fontFamily), headFont = primaryFont(h1.fontFamily) || primaryFont(cardTitle.fontFamily);
  if (headFont && headFont !== bodyFont) { put("--wjs-font-family-heading", headFont); put("--wjs-font-display", headFont); }
  if (isSet(body.fontSize)) put("--wjs-font-size-base", body.fontSize);
  if (isSet(body.lineHeight) && isSet(body.fontSize)) {
    const lh = firstPx(body.lineHeight), fs = firstPx(body.fontSize);
    if (lh && fs) put("--wjs-line-height-base", String(Math.round((lh / fs) * 100) / 100));
  }
  // HEADING SCALE (--wjs-h1..h6). wordjs-ui.css sizes headings via `h1 { font-size: var(--wjs-h1) }`,
  // and these names have no `<component>-<suffix>` separator so the convention mapper skips them — yet
  // without them every heading falls back to the framework default (2.5rem) and renders visibly smaller
  // than the design. Measure h1/h2/h3 directly and interpolate the rest down to the body size.
  const h1px = firstPx(h1.fontSize), h2px = firstPx(r("h2").fontSize), h3px = firstPx(r("h3").fontSize) || firstPx(cardTitle.fontSize);
  const basePx = firstPx(body.fontSize) || 16;
  const scale = [h1px, h2px, h3px].filter(Boolean);
  if (scale.length) {
    const s1 = h1px || scale[0];
    const s2 = h2px || Math.round(s1 * 0.66);
    const s3 = h3px || Math.round(s2 * 0.72);
    // h4..h6 interpolate geometrically from h3 down toward the body size (never below it).
    const s4 = Math.max(basePx, Math.round(s3 * 0.82));
    const s5 = Math.max(basePx, Math.round(s4 * 0.85));
    const s6 = Math.max(basePx, Math.round(s5 * 0.88));
    const sizes = { "--wjs-h1": s1, "--wjs-h2": s2, "--wjs-h3": s3, "--wjs-h4": s4, "--wjs-h5": s5, "--wjs-h6": s6 };
    for (const [token, value] of Object.entries(sizes)) if (value) put(token, `${value}px`);
  }
  if (isSet(h1.fontWeight)) put("--wjs-heading-weight", h1.fontWeight);
  if (isSet(h1.lineHeight) && isSet(h1.fontSize)) {
    const lh = firstPx(h1.lineHeight), fs = firstPx(h1.fontSize);
    if (lh && fs) put("--wjs-heading-line-height", (Math.round((lh / fs) * 100) / 100).toString());
  }

  // --- radius scale (from the real card & button corners) ----------------------------------------
  const cardRadius = firstPx(card.borderRadius), btnRadius = firstPx(btnP.borderRadius) || firstPx(navCta.borderRadius);
  const baseRadius = cardRadius ?? btnRadius;
  if (baseRadius != null) {
    put("--wjs-radius", `${baseRadius}px`);
    put("--wjs-radius-sm", `${Math.max(2, Math.round(baseRadius / 2))}px`);
    put("--wjs-radius-lg", `${Math.round(baseRadius * 1.5)}px`);
  }
  if (btnRadius != null) put("--wjs-button-radius", `${btnRadius}px`);
  if (cardRadius != null) { put("--wjs-card-radius", `${cardRadius}px`); put("--wjs-block-radius", `${cardRadius}px`); put("--wjs-accordion-radius", `${cardRadius}px`); }

  // --- shadow scale (from the real card & button elevation) --------------------------------------
  const cardShadow = cleanShadow(card.boxShadow), btnShadow = cleanShadow(btnP.boxShadow), navShadow = cleanShadow(nav.boxShadow);
  const baseShadow = cardShadow || navShadow || btnShadow;
  if (baseShadow) { put("--wjs-shadow", baseShadow); put("--wjs-shadow-lg", btnShadow || baseShadow); if (navShadow) put("--wjs-shadow-sm", navShadow); }
  if (cardShadow) { put("--wjs-card-shadow", cardShadow); put("--wjs-block-shadow", cardShadow); }

  // --- surfaces (card / block) -------------------------------------------------------------------
  put("--wjs-block-bg", paintColor(card.backgroundColor));
  if (isSet(card.padding)) put("--wjs-card-padding", card.padding);

  // --- header / nav ------------------------------------------------------------------------------
  put("--wjs-header-bg", paintColor(nav.backgroundColor));
  if (isSet(nav.padding)) put("--wjs-header-padding", nav.padding);
  put("--wjs-header-shadow", navShadow);
  if (isSet(nav.backdropFilter)) put("--wjs-header-backdrop-filter", nav.backdropFilter);
  put("--wjs-header-border", borderFrom(nav.borderBottomWidth, nav.borderTopColor));

  // --- footer ------------------------------------------------------------------------------------
  put("--wjs-footer-bg", paintColor(footer.backgroundColor));
  if (isSet(footer.padding)) put("--wjs-footer-padding", footer.padding);

  // --- hero + section rhythm + grid --------------------------------------------------------------
  if (isSet(hero.padding)) { put("--wjs-hero-padding", hero.padding); put("--wjs-section-padding", hero.padding); }
  if (isSet(btnP.padding)) put("--wjs-button-padding", btnP.padding);

  // --- additional blocks (per-block region tokens, consumed by the synthesized block rules) ------
  if (isSet(secHead.fontSize)) put("--wjs-section-heading-size", secHead.fontSize);
  put("--wjs-section-heading-color", paintColor(secHead.color) || paintColor(h1.color));
  // accordion
  put("--wjs-accordion-trigger-color", paintColor(accTrig.color) || paintColor(h1.color));
  if (isSet(accTrig.padding)) put("--wjs-accordion-trigger-padding", accTrig.padding);
  put("--wjs-accordion-panel-color", paintColor(accPanel.color) || textMuted);
  // tabs
  put("--wjs-tabs-active-color", primary);
  put("--wjs-tabs-tab-color", paintColor(tab.color) || textMuted);
  // table
  put("--wjs-table-head-bg", paintColor(tableHead.backgroundColor) || paintColor(footer.backgroundColor));
  put("--wjs-table-head-color", paintColor(tableHead.color) || paintColor(h1.color));
  if (isSet(tableCell.padding)) put("--wjs-table-cell-padding", tableCell.padding);
  put("--wjs-table-border", borderFrom(tableCell.borderBottomWidth || "1px", tableCell.borderTopColor));
  // stats
  put("--wjs-stats-value-color", paintColor(statVal.color) || primary || paintColor(h1.color));
  if (isSet(statVal.fontSize)) put("--wjs-stats-value-size", statVal.fontSize);
  put("--wjs-stats-label-color", paintColor(statLab.color) || textMuted);
  // icon list
  put("--wjs-icon-color", paintColor(iconIcon.color) || primary);
  // pricing
  put("--wjs-pricing-highlight-bg", paintColor(priceHi.backgroundColor));
  if (isSet(price.fontSize)) put("--wjs-pricing-price-size", price.fontSize);
  // testimonial
  put("--wjs-testimonial-bg", paintColor(testi.backgroundColor) || paintColor(card.backgroundColor));
  // post card
  const postRadius = firstPx(postCard.borderRadius);
  if (postRadius != null) put("--wjs-post-card-radius", `${postRadius}px`);
  put("--wjs-post-title-color", paintColor(postTitle.color) || paintColor(h1.color));
  // cta banner
  put("--wjs-cta-bg", paintColor(cta.backgroundColor) || primary);
  put("--wjs-cta-color", paintColor(cta.color) || paintColor(btnP.color));
  const ctaRadius = firstPx(cta.borderRadius);
  if (ctaRadius != null) put("--wjs-cta-radius", `${ctaRadius}px`);
  // badge / tag
  put("--wjs-badge-bg", paintColor(badge.backgroundColor));
  put("--wjs-badge-color", paintColor(badge.color) || primary);
  const badgeRadius = firstPx(badge.borderRadius);
  if (badgeRadius != null) put("--wjs-badge-radius", `${badgeRadius}px`);
  // audio player: the play control, track and progress bar are the brand-driven parts.
  put("--wjs-audio-control-bg", paintColor(audioControl.backgroundColor) || primary);
  put("--wjs-audio-control-color", paintColor(audioControl.color) || paintColor(btnP.color) || "#fff");
  put("--wjs-audio-track-bg", paintColor(audioTrack.backgroundColor) || textMuted);
  put("--wjs-audio-progress-color", paintColor(audioProgress.backgroundColor) || primary);
  put("--wjs-audio-title-color", paintColor(audioTitle.color) || paintColor(h1.color));
  // video embed: rounded frame + a brand play placeholder.
  const videoRadius = firstPx(videoFrame.borderRadius);
  if (videoRadius != null) put("--wjs-video-frame-radius", `${videoRadius}px`);
  put("--wjs-video-placeholder-bg", paintColor(videoPlaceholder.backgroundColor) || primary);
  put("--wjs-video-placeholder-color", paintColor(videoPlaceholder.color) || "#fff");

  return out;
}

export default mapMeasuresToTokens;
