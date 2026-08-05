/**
 * Give a catalog theme a point of view about BLOCKS, not just about colour.
 *
 *   node scripts/author-block-tokens.mjs [slug…] [--root <dir>] [--dry] [--force]
 *
 * With no slugs it runs every theme that has a RECIPE below.
 *
 * A theme imported from a Stitch design system comes out with ~28 tokens: the palette, the type
 * pairing, the radii, the hero. Everything else — buttons, cards, the post grid, quotes,
 * testimonials, stats, tabs, accordions, forms, search — falls through to the framework defaults in
 * wordjs-ui.css. Ten themes can therefore have ten palettes and one identical set of buttons, which
 * is exactly how a "catalog" ends up feeling like one theme wearing hats.
 *
 * Stitch has no opinion about any of this (its design system is colour + type + roundness), so the
 * opinion has to be declared here — but it is declared ONCE per theme, as a RECIPE, and every value
 * is then derived from that theme's OWN palette. Nothing is copied between themes and nothing is
 * typed twice, so `verify theme` keeps passing: the colours still come from the design.
 *
 * The recipes are deliberately few and strongly opposed — three corner languages (square / soft /
 * pill), three shadow languages (none / diffuse / hard offset), two border languages (hairline /
 * heavy). Two themes sharing a palette family still can't look alike if one has 0px corners with
 * hairline rules and no shadow and the other has 24px corners with no border and a pillow shadow.
 *
 * Only manifest-known token names are written; anything else is a bug in this script and aborts.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
// Without this a re-run keeps every value already in theme.json — including the ones this script
// wrote last time — so a changed RECIPE would silently do nothing.
const FORCE = argv.includes("--force");
const rootIdx = argv.indexOf("--root");
const ROOT = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : "marketplace/themes");
const asked = argv.filter((a, i) => !a.startsWith("--") && !(rootIdx >= 0 && i === rootIdx + 1));

const MANIFEST = JSON.parse(fs.readFileSync("backend/public/theme-tokens.json", "utf8"));
const KNOWN = new Set(Object.keys(MANIFEST.tokens || {}));

// ---------------------------------------------------------------- colour math
const hex2rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgb2hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex(...A.map((v, i) => v + (B[i] - v) * t)); };
const alpha = (h, a) => { const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; };
const lum = (h) => { const [r, g, b] = hex2rgb(h); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

/**
 * Recipes. `corners` / `weightOfLine` / `depth` are the three axes that carry most of the felt
 * difference; the rest is per-theme seasoning. Each entry names the design it belongs to so the
 * intent survives the next person to read it.
 */
const RECIPES = {
    // Broadsheet newspaper: nothing is rounded, nothing floats, every division is a printed rule.
    "paper-press": { corners: "square", line: "hairline", depth: "none", pad: "tight", label: "upper", ink: "ink" },
    // Warm reprint of a 19th-century book: barely-there corners, sepia rules, no lift at all.
    "sepia-press": { corners: "soft", line: "hairline", depth: "none", pad: "roomy", label: "small-caps", ink: "primary" },
    // Japandi: the luxury is emptiness. No borders, no shadows, a lot of air.
    "japandi-haven": { corners: "soft", line: "none", depth: "none", pad: "airy", label: "plain", ink: "ink" },
    // Boutique: gallery-white, hairline frames, letterspaced capitals, one whisper of a shadow.
    "pearl-boutique": { corners: "square", line: "hairline", depth: "whisper", pad: "roomy", label: "upper-wide", ink: "ink" },
    // Workshop: honest craft. Heavy rules, flat as stamped card stock — weight without float.
    "amber-workshop": { corners: "soft", line: "heavy", depth: "none", pad: "roomy", label: "upper", ink: "primary" },
    // Clay: pillowy, rounded, no edges anywhere, soft diffuse depth.
    "clay-pop": { corners: "pill", line: "none", depth: "pillow", pad: "roomy", label: "plain", ink: "primary" },
    // Pop studio: neo-brutalist poster. Square, thick ink borders, hard offset, unapologetic.
    "pop-studio": { corners: "square", line: "heavy", depth: "offset", pad: "tight", label: "upper", ink: "ink" },
    // Sorbet: sticker book. Rounded and outlined, each element cut out and stuck on the page.
    "sorbet-play": { corners: "round", line: "heavy", depth: "offset", pad: "roomy", label: "plain", ink: "primary" },
    // Sage: a long calm read. Gentle corners, no rules, shadows you notice only when they're gone.
    "sage-calm": { corners: "round", line: "none", depth: "whisper", pad: "airy", label: "plain", ink: "ink" },
    // Verdant: botanical press. Fine green rules, flat, quietly editorial.
    "verdant-studio": { corners: "soft", line: "hairline", depth: "none", pad: "roomy", label: "small-caps", ink: "primary" },

    // The ten below already carry a hand-authored character; their recipe exists to fill the block
    // families nobody had reached yet (cta, pricing, the post grid, tables…) in the same key, not to
    // restate what they already declare — every existing value wins over this table.
    "atelier-noir": { corners: "square", line: "hairline", depth: "none", pad: "roomy", label: "upper-wide", ink: "ink" },
    "midnight-luxury": { corners: "soft", line: "hairline", depth: "whisper", pad: "roomy", label: "upper-wide", ink: "primary" },
    "noir-or": { corners: "square", line: "hairline", depth: "none", pad: "airy", label: "upper-wide", ink: "primary" },
    "midnight-signal": { corners: "round", line: "none", depth: "pillow", pad: "roomy", label: "plain", ink: "primary" },
    "sunset-drive": { corners: "pill", line: "none", depth: "pillow", pad: "roomy", label: "plain", ink: "primary" },
    "carbon-terminal": { corners: "square", line: "hairline", depth: "none", pad: "tight", label: "upper", ink: "primary" },
    "mono-lab": { corners: "soft", line: "hairline", depth: "none", pad: "tight", label: "plain", ink: "ink" },
    "neo-digital": { corners: "square", line: "heavy", depth: "offset", pad: "tight", label: "upper", ink: "ink" },
    "cobalt-corporate": { corners: "soft", line: "hairline", depth: "whisper", pad: "roomy", label: "plain", ink: "primary" },
    "swiss-minimal": { corners: "square", line: "hairline", depth: "none", pad: "roomy", label: "plain", ink: "ink" },
};

const CORNERS = {
    square: { sm: "0", md: "0", lg: "0", pill: "0", icon: "0" },
    soft: { sm: "2px", md: "4px", lg: "6px", pill: "4px", icon: "4px" },
    round: { sm: "8px", md: "12px", lg: "16px", pill: "999px", icon: "12px" },
    pill: { sm: "14px", md: "22px", lg: "28px", pill: "999px", icon: "999px" },
};
const PAD = {
    tight: { box: "1.25rem", btnX: "1.25rem", btnY: "0.6rem", panel: "1.25rem" },
    roomy: { box: "1.75rem", btnX: "1.75rem", btnY: "0.8rem", panel: "1.75rem" },
    airy: { box: "2.5rem", btnX: "2rem", btnY: "0.9rem", panel: "2.25rem" },
};

function build(slug, design, existing) {
    const r = RECIPES[slug];
    if (!r) throw new Error(`no recipe for ${slug}`);
    const c = design.designTheme.namedColors;
    const bg = c.background, surface = c.surface, ink = c.on_surface;
    const primary = c.primary, onPrimary = c.on_primary, secondary = c.secondary, onSecondary = c.on_secondary;
    const dark = lum(bg) < 0.35;
    const toward = dark ? "#ffffff" : "#000000";

    const rad = CORNERS[r.corners];
    const pad = PAD[r.pad];
    const muted = mix(ink, bg, 0.42);
    const faint = mix(ink, bg, 0.86);
    const raised = mix(surface, toward, dark ? 0.07 : 0.035);
    const accentInk = r.ink === "primary" ? primary : ink;

    // Line language.
    const lineW = { none: "0", hairline: "1px", heavy: "2px" }[r.line];
    const lineC = { none: "transparent", hairline: r.ink === "primary" ? mix(primary, bg, 0.7) : faint, heavy: accentInk }[r.line];

    // Depth language. `offset` is a hard un-blurred shadow — the axis that reads instantly as a
    // different design language rather than a different colour.
    const shadow = {
        none: "none",
        whisper: `0 1px 2px ${alpha(ink, 0.05)}`,
        pillow: `0 10px 30px -12px ${alpha(ink, dark ? 0.6 : 0.22)}`,
        offset: `4px 4px 0 ${accentInk}`,
    }[r.depth];
    const shadowHover = {
        none: "none",
        whisper: `0 4px 14px ${alpha(ink, 0.09)}`,
        pillow: `0 18px 40px -14px ${alpha(ink, dark ? 0.7 : 0.3)}`,
        offset: `7px 7px 0 ${accentInk}`,
    }[r.depth];
    const lift = r.depth === "none" ? "none" : r.depth === "offset" ? "translate(-3px,-3px)" : "translateY(-4px)";

    // Label language (buttons, tabs, stats labels, testimonial roles).
    const caseT = { upper: "uppercase", "upper-wide": "uppercase", "small-caps": "uppercase", plain: "none" }[r.label];
    const track = { upper: "0.06em", "upper-wide": "0.18em", "small-caps": "0.1em", plain: "0" }[r.label];
    const labelSize = r.label === "upper-wide" ? "0.72rem" : "0.8rem";

    const headFam = "var(--wjs-font-family-heading)";
    const bodyFam = "var(--wjs-font-family-base)";

    // The footer band is usually the one surface a theme already decided on (--wjs-bg-footer), and it
    // is frequently the inverse of the page — so the text on it must be read off THAT colour, not off
    // the page ink. Reading it from the page is how a dark footer ends up with near-black type.
    const hexOr = (v, fb) => (/^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? String(v) : fb);
    const footerBg = hexOr(existing["--wjs-bg-footer"], hexOr(existing["--wjs-footer-bg"], mix(bg, toward, 0.9)));
    const onFooter = lum(footerBg) < 0.5 ? "#ffffff" : mix(ink, footerBg, 0.05);

    const t = {
        // ---- hero surface
        //
        // wordjs-ui.css paints the hero as
        //   background-image: var(--wjs-hero-bg-image, var(--wjs-hero-gradient, linear-gradient(…from…, …to…)))
        // so a theme that declares --wjs-hero-bg but stays silent on --wjs-hero-gradient gets its flat
        // surface painted over by the gradient PAIR any hero block may carry from whatever theme it
        // was authored under. The theme still pins --wjs-hero-title-color, tuned for its own surface —
        // and a dark title lands on someone else's dark band, unreadable. Declaring `none` makes the
        // theme's hero self-consistent: the colour it chose is the colour the title sits on.
        //
        // The trade is real and worth stating: a per-block gradient no longer shows. A per-block
        // background IMAGE still does (--wjs-hero-bg-image is earlier in the chain), and a theme that
        // wants its own gradient just declares one — eight of the twenty do, and keep it.
        "--wjs-hero-gradient": "none",

        // ---- buttons
        "--wjs-button-bg": primary,
        "--wjs-button-color": onPrimary,
        "--wjs-button-radius": rad.pill,
        "--wjs-button-pad-x": pad.btnX,
        "--wjs-button-pad-y": pad.btnY,
        "--wjs-button-border-width": r.line === "heavy" ? "2px" : "0",
        "--wjs-button-border-color": r.line === "heavy" ? accentInk : "transparent",
        "--wjs-button-transform": caseT,
        "--wjs-button-tracking": track,
        "--wjs-button-weight": "600",
        "--wjs-button-family": r.label === "plain" ? bodyFam : headFam,
        "--wjs-button-shadow": shadow,
        "--wjs-button-hover-bg": mix(primary, toward, 0.16),
        "--wjs-button-hover-color": onPrimary,
        "--wjs-button-hover-shadow": shadowHover,
        "--wjs-button-hover-transform": lift,
        "--wjs-button-secondary-bg": secondary,
        "--wjs-button-secondary-color": onSecondary,
        "--wjs-button-outline-bg": "transparent",
        "--wjs-button-outline-color": accentInk,
        "--wjs-button-outline-border-color": accentInk,
        "--wjs-button-outline-hover-bg": alpha(primary, 0.1),

        // ---- cards
        "--wjs-card-bg": surface === bg ? raised : surface,
        "--wjs-card-color": ink,
        "--wjs-card-radius": rad.lg,
        "--wjs-card-pad": pad.box,
        "--wjs-card-border-width": lineW,
        "--wjs-card-border-color": lineC,
        "--wjs-card-shadow": shadow,
        "--wjs-card-hover-shadow": shadowHover,
        "--wjs-card-hover-transform": lift,
        "--wjs-card-hover-border-color": r.line === "none" ? "transparent" : primary,
        "--wjs-card-title-color": ink,
        "--wjs-card-title-weight": "700",
        "--wjs-card-title-tracking": r.label === "upper-wide" ? "0.04em" : "-0.01em",
        "--wjs-card-desc-color": muted,
        "--wjs-card-desc-family": bodyFam,
        "--wjs-card-icon-bg": alpha(primary, dark ? 0.2 : 0.12),
        "--wjs-card-icon-color": primary,
        "--wjs-card-icon-radius": rad.icon,

        // ---- post grid
        "--wjs-posts-bg": surface === bg ? raised : surface,
        "--wjs-posts-radius": rad.lg,
        "--wjs-posts-pad": pad.box,
        "--wjs-posts-gap": r.pad === "airy" ? "2.5rem" : "1.75rem",
        "--wjs-posts-border-width": lineW,
        "--wjs-posts-border-color": lineC,
        "--wjs-posts-shadow": shadow,
        "--wjs-posts-hover-shadow": shadowHover,
        "--wjs-posts-hover-transform": lift,
        "--wjs-posts-hover-border-color": r.line === "none" ? "transparent" : primary,
        "--wjs-posts-title-color": ink,
        "--wjs-posts-title-weight": "700",
        "--wjs-posts-excerpt-color": muted,
        "--wjs-posts-date-color": muted,
        "--wjs-posts-thumb-bg": mix(bg, toward, 0.08),
        "--wjs-posts-thumb-radius": r.corners === "pill" ? rad.md : rad.sm,
        "--wjs-posts-family": bodyFam,

        // ---- quotes
        "--wjs-quote-family": headFam,
        "--wjs-quote-color": ink,
        "--wjs-quote-accent": primary,
        "--wjs-quote-bar-width": r.line === "heavy" ? "4px" : r.line === "none" ? "0" : "2px",
        "--wjs-quote-style": r.label === "plain" ? "normal" : "italic",
        "--wjs-quote-cite-color": muted,
        "--wjs-quote-mark-opacity": r.depth === "none" ? "0.18" : "0.1",

        // ---- testimonials
        "--wjs-testimonial-bg": surface === bg ? raised : surface,
        "--wjs-testimonial-radius": rad.lg,
        "--wjs-testimonial-pad": pad.box,
        "--wjs-testimonial-border-width": lineW,
        "--wjs-testimonial-border-color": lineC,
        "--wjs-testimonial-shadow": shadow,
        "--wjs-testimonial-quote-color": ink,
        "--wjs-testimonial-quote-family": headFam,
        "--wjs-testimonial-quote-style": r.label === "plain" ? "normal" : "italic",
        "--wjs-testimonial-author-color": ink,
        "--wjs-testimonial-role-color": muted,
        "--wjs-testimonial-role-transform": caseT,
        "--wjs-testimonial-role-tracking": track,
        "--wjs-testimonial-avatar-bg": alpha(primary, 0.16),
        "--wjs-testimonial-avatar-color": primary,
        "--wjs-testimonial-avatar-radius": r.corners === "square" ? "0" : "999px",
        "--wjs-testimonial-mark-color": primary,
        "--wjs-testimonial-mark-opacity": "0.14",

        // ---- stats
        "--wjs-stats-bg": r.line === "none" ? "transparent" : surface === bg ? raised : surface,
        "--wjs-stats-radius": rad.md,
        "--wjs-stats-pad": pad.box,
        "--wjs-stats-border-width": lineW,
        "--wjs-stats-border-color": lineC,
        "--wjs-stats-shadow": r.depth === "offset" ? "none" : shadow,
        "--wjs-stats-value-color": accentInk,
        "--wjs-stats-value-family": headFam,
        "--wjs-stats-value-weight": "700",
        "--wjs-stats-label-color": muted,
        "--wjs-stats-label-transform": caseT,
        "--wjs-stats-label-tracking": track,
        "--wjs-stats-label-size": labelSize,

        // ---- tabs
        "--wjs-tabs-family": r.label === "plain" ? bodyFam : headFam,
        "--wjs-tabs-color": muted,
        "--wjs-tabs-transform": caseT,
        "--wjs-tabs-tracking": track,
        "--wjs-tabs-radius": rad.sm,
        "--wjs-tabs-active-color": onPrimary,
        "--wjs-tabs-active-bg": primary,
        "--wjs-tabs-active-weight": "700",
        "--wjs-tabs-list-bg": r.line === "none" ? alpha(ink, 0.05) : "transparent",
        "--wjs-tabs-list-radius": rad.md,
        "--wjs-tabs-list-border-width": r.line === "hairline" ? "1px" : "0",
        "--wjs-tabs-list-border-color": lineC,
        "--wjs-tabs-panel-bg": "transparent",
        "--wjs-tabs-panel-color": ink,
        "--wjs-tabs-panel-pad": pad.panel,

        // ---- accordion
        "--wjs-accordion-item-bg": surface === bg ? raised : surface,
        "--wjs-accordion-item-radius": rad.md,
        "--wjs-accordion-item-border-width": lineW,
        "--wjs-accordion-item-border-color": lineC,
        "--wjs-accordion-item-gap": r.pad === "airy" ? "1rem" : "0.5rem",
        "--wjs-accordion-header-color": ink,
        "--wjs-accordion-header-family": r.label === "plain" ? bodyFam : headFam,
        "--wjs-accordion-header-weight": "600",
        "--wjs-accordion-header-transform": caseT === "uppercase" && r.label === "upper-wide" ? "uppercase" : "none",
        "--wjs-accordion-icon-color": primary,
        "--wjs-accordion-panel-color": muted,
        "--wjs-accordion-panel-family": bodyFam,
        "--wjs-accordion-shadow": r.depth === "offset" ? "none" : shadow,

        // ---- forms + search
        "--wjs-form-input-bg": dark ? raised : mix(bg, "#ffffff", 0.6),
        "--wjs-form-input-color": ink,
        "--wjs-form-input-border-color": r.line === "none" ? mix(ink, bg, 0.8) : lineC,
        "--wjs-form-input-radius": rad.sm,
        "--wjs-form-label-color": ink,
        "--wjs-form-placeholder-color": mix(ink, bg, 0.6),
        "--wjs-form-accent": primary,
        "--wjs-form-submit-bg": primary,
        "--wjs-form-submit-color": onPrimary,
        "--wjs-form-submit-radius": rad.pill,
        "--wjs-form-submit-family": r.label === "plain" ? bodyFam : headFam,
        "--wjs-form-submit-weight": "600",
        "--wjs-form-submit-shadow": shadow,
        "--wjs-form-submit-hover-bg": mix(primary, toward, 0.16),
        "--wjs-search-input-bg": dark ? raised : mix(bg, "#ffffff", 0.6),
        "--wjs-search-input-color": ink,
        "--wjs-search-input-border-color": r.line === "none" ? mix(ink, bg, 0.8) : lineC,
        "--wjs-search-input-radius": rad.pill,
        "--wjs-search-placeholder-color": mix(ink, bg, 0.6),
        "--wjs-search-button-bg": primary,
        "--wjs-search-button-color": onPrimary,
        "--wjs-search-button-radius": rad.pill,
        "--wjs-search-button-transform": caseT,
        "--wjs-search-button-tracking": track,
        "--wjs-search-focus-ring": alpha(primary, 0.3),
        "--wjs-search-focus-color": primary,

        // ---- CTA banner (the loudest block on a landing page — it should read as the theme's voice
        // raised, not as a stock blue bar)
        "--wjs-cta-bg": r.depth === "pillow" ? primary : mix(primary, bg, dark ? 0.72 : 0.88),
        "--wjs-cta-color": r.depth === "pillow" ? onPrimary : ink,
        "--wjs-cta-title-color": r.depth === "pillow" ? onPrimary : accentInk,
        "--wjs-cta-title-family": headFam,
        "--wjs-cta-title-weight": "700",
        "--wjs-cta-title-transform": r.label === "upper-wide" ? "uppercase" : "none",
        "--wjs-cta-title-tracking": r.label === "upper-wide" ? "0.12em" : "-0.01em",
        "--wjs-cta-radius": rad.lg,
        "--wjs-cta-pad": pad.box,
        "--wjs-cta-border-width": lineW,
        "--wjs-cta-border-color": lineC,
        "--wjs-cta-shadow": shadow,
        "--wjs-cta-button-bg": r.depth === "pillow" ? bg : primary,
        "--wjs-cta-button-color": r.depth === "pillow" ? primary : onPrimary,
        "--wjs-cta-button-radius": rad.pill,
        "--wjs-cta-button-family": r.label === "plain" ? bodyFam : headFam,
        "--wjs-cta-button-weight": "600",
        "--wjs-cta-button-transform": caseT,
        "--wjs-cta-button-tracking": track,
        "--wjs-cta-button-shadow": shadow,
        "--wjs-cta-button-hover-bg": r.depth === "pillow" ? mix(bg, toward, 0.1) : mix(primary, toward, 0.16),
        "--wjs-cta-button-hover-color": r.depth === "pillow" ? primary : onPrimary,
        "--wjs-cta-button-hover-shadow": shadowHover,
        "--wjs-cta-subtitle-opacity": "0.78",

        // ---- pricing
        "--wjs-pricing-bg": surface === bg ? raised : surface,
        "--wjs-pricing-radius": rad.lg,
        "--wjs-pricing-pad": pad.box,
        "--wjs-pricing-border-width": lineW,
        "--wjs-pricing-border-color": lineC,
        "--wjs-pricing-shadow": shadow,
        "--wjs-pricing-hover-shadow": shadowHover,
        "--wjs-pricing-hover-transform": lift,
        "--wjs-pricing-hover-border-color": r.line === "none" ? "transparent" : primary,
        "--wjs-pricing-accent": primary,
        "--wjs-pricing-name-color": muted,
        "--wjs-pricing-name-family": r.label === "plain" ? bodyFam : headFam,
        "--wjs-pricing-name-transform": caseT,
        "--wjs-pricing-name-tracking": track,
        "--wjs-pricing-price-color": ink,
        "--wjs-pricing-price-family": headFam,
        "--wjs-pricing-price-weight": "700",
        "--wjs-pricing-period-color": muted,
        "--wjs-pricing-feature-color": muted,
        "--wjs-pricing-button-bg": primary,
        "--wjs-pricing-button-color": onPrimary,
        "--wjs-pricing-button-radius": rad.pill,
        "--wjs-pricing-button-hover-bg": mix(primary, toward, 0.16),
        "--wjs-pricing-highlight-bg": dark ? mix(surface, primary, 0.12) : mix(surface, primary, 0.06),
        "--wjs-pricing-highlight-border-color": primary,
        "--wjs-pricing-highlight-border-width": r.line === "none" ? "1px" : lineW,
        "--wjs-pricing-highlight-shadow": shadowHover,
        "--wjs-pricing-highlight-price-color": accentInk,

        // ---- footer text (the band colour is already themed; these are the words on it)
        "--wjs-color-text-footer-heading": onFooter,
        "--wjs-color-text-footer-main": onFooter,
        "--wjs-color-text-footer-dim": mix(onFooter, footerBg, 0.42),
        "--wjs-footer-text-heading": onFooter,
        "--wjs-footer-text-body": mix(onFooter, footerBg, 0.42),
        "--wjs-footer-text-hover": onFooter,

        // ---- chrome (header nav + logo). Without these the nav inherits the framework fallback,
        // which is fine but generic; a theme this deliberate should say what its menu looks like.
        "--wjs-nav-color": r.ink === "primary" && !dark ? mix(ink, bg, 0.15) : ink,
        "--wjs-nav-color-hover": primary,
        "--wjs-logo-color": accentInk,
        // When the logo is ALREADY the primary colour, hovering to primary is a no-op — the mark just
        // doesn't respond. Shift it instead of repeating it.
        "--wjs-logo-color-hover": accentInk.toLowerCase() === primary.toLowerCase() ? mix(primary, toward, 0.28) : primary,
        "--wjs-social-hover-color": onPrimary,

        // ---- socials, images, tables, dividers
        "--wjs-social-bg": r.line === "none" ? alpha(primary, 0.12) : "transparent",
        "--wjs-social-color": accentInk,
        "--wjs-social-hover-bg": primary,
        "--wjs-social-hover-color": onPrimary,
        "--wjs-social-radius": r.corners === "square" ? "0" : "999px",
        "--wjs-image-radius": rad.lg,
        "--wjs-image-shadow": r.depth === "offset" ? "none" : shadow,
        "--wjs-table-border-color": faint,
        "--wjs-table-head-bg": r.line === "none" ? alpha(ink, 0.05) : "transparent",
        "--wjs-table-head-color": ink,
        "--wjs-table-head-transform": caseT,
        "--wjs-table-head-tracking": track,
        "--wjs-divider-color": lineC === "transparent" ? faint : lineC,
    };

    // Never overwrite a value the theme (or its design import) already decided — which also makes a
    // re-run a no-op, so editing a RECIPE above has no effect until you pass --force.
    const out = {};
    for (const [k, v] of Object.entries(t)) {
        if (!KNOWN.has(k)) throw new Error(`invented token ${k}`);
        if (!FORCE && Object.prototype.hasOwnProperty.call(existing, k)) continue;
        out[k] = String(v);
    }
    return out;
}

const targets = asked.length ? asked : Object.keys(RECIPES);
let added = 0;
for (const slug of targets) {
    const dir = path.join(ROOT, slug);
    const metaPath = path.join(dir, "theme.json");
    const designPath = path.join(dir, ".design", "stitch.json");
    if (!fs.existsSync(metaPath) || !fs.existsSync(designPath)) {
        console.error(`  ✗ ${slug}: needs theme.json + .design/stitch.json`);
        process.exitCode = 1;
        continue;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const design = JSON.parse(fs.readFileSync(designPath, "utf8"));
    const fresh = build(slug, design, meta.tokens || {});
    meta.tokens = { ...(meta.tokens || {}), ...fresh };
    if (!DRY) fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    added += Object.keys(fresh).length;
    console.log(`  ✓ ${slug}: +${Object.keys(fresh).length} token(s) → ${Object.keys(meta.tokens).length} total  [${RECIPES[slug].corners}/${RECIPES[slug].line}/${RECIPES[slug].depth}]`);
}
console.log(`\n${added} token(s) written across ${targets.length} theme(s)${DRY ? " (dry run)" : ""}.`);
