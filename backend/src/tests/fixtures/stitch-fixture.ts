/**
 * The Stitch fixture the import/verify suites run against — a REAL Stitch export payload plus the
 * theme.json and compiled style.css it produces, frozen here as data.
 *
 * It used to be read out of an installed theme (backend/themes/herbario). That coupled two suites to
 * a theme happening to be on disk: when the theme catalogue was deleted, both files threw while being
 * IMPORTED and their 43 cases vanished from the run without a single failure being reported. The
 * payload lives here now so the suites are self-contained; they materialise it into a temp dir per
 * run and tear it down after, and every read happens INSIDE a test case so a missing fixture is a
 * loud failure instead of a silent disappearance.
 *
 * Frozen on purpose: STYLE_CSS is the byte-for-byte output of the real compiler for THEME_JSON, i.e.
 * the values a browser would actually have got, not a hand-written stand-in.
 */

export const STITCH_DESIGN = {
    "designTheme": {
        "bodyFont": "WORK_SANS",
        "bodyFontFamily": "Work Sans",
        "colorMode": "LIGHT",
        "colorVariant": "FIDELITY",
        "customColor": "#2F5D50",
        "headlineFont": "EB_GARAMOND",
        "headlineFontFamily": "Eb Garamond",
        "labelFont": "WORK_SANS",
        "labelFontFamily": "Work Sans",
        "overrideNeutralColor": "#F6F1E7",
        "overridePrimaryColor": "#2F5D50",
        "overrideSecondaryColor": "#B4694A",
        "roundness": "ROUND_FOUR",
        "spacingScale": 2,
        "namedColors": {
            "background": "#fef9ef",
            "error": "#ba1a1a",
            "error_container": "#ffdad6",
            "inverse_on_surface": "#f5f0e6",
            "inverse_primary": "#a0d1c0",
            "inverse_surface": "#32302a",
            "on_background": "#1d1c16",
            "on_error": "#ffffff",
            "on_error_container": "#93000a",
            "on_primary": "#ffffff",
            "on_primary_container": "#a3d4c3",
            "on_secondary": "#ffffff",
            "on_secondary_container": "#78391e",
            "on_surface": "#1d1c16",
            "on_surface_variant": "#404945",
            "on_tertiary": "#ffffff",
            "outline": "#717975",
            "outline_variant": "#c0c8c4",
            "primary": "#154539",
            "primary_container": "#2f5d50",
            "primary_fixed": "#bceddc",
            "primary_fixed_dim": "#a0d1c0",
            "secondary": "#904c2f",
            "secondary_container": "#fea683",
            "surface": "#fef9ef",
            "surface_bright": "#fef9ef",
            "surface_container": "#f2ede3",
            "surface_container_high": "#ede8de",
            "surface_container_highest": "#e7e2d8",
            "surface_container_low": "#f8f3e9",
            "surface_container_lowest": "#ffffff",
            "surface_dim": "#dedad0",
            "surface_tint": "#396759",
            "surface_variant": "#e7e2d8",
            "tertiary": "#5d322a",
            "tertiary_container": "#784840"
        }
    },
    "name": "projects/000000000000000000",
    "title": "WordJS — Stitch fixture"
} as any;

export const THEME_JSON = {
    "name": "Stitch Fixture",
    "version": "1.0.6",
    "description": "Self-contained Stitch fixture: verde bosque sobre papel crema, titulares serif y esquinas de 4px.",
    "author": "WordJS × Stitch",
    "generator": "wordjs",
    "seeds": {
        "primary": "#2f5d50",
        "secondary": "#b4694a",
        "bg": "#fef9ef",
        "text": "#1d1c16"
    },
    "layout": {
        "containerWidth": "1100px",
        "sidebar": false,
        "header": {
            "variant": "classic",
            "sticky": true
        },
        "footer": {
            "variant": "columns",
            "columns": 3
        }
    },
    "tokens": {
        "--wjs-bg-canvas": "#fef9ef",
        "--wjs-bg-surface": "#ffffff",
        "--wjs-bg-muted": "#f2ede3",
        "--wjs-color-primary": "#2f5d50",
        "--wjs-color-primary-dark": "#154539",
        "--wjs-color-on-primary": "#ffffff",
        "--wjs-color-secondary": "#b4694a",
        "--wjs-color-secondary-dark": "#904c2f",
        "--wjs-color-on-secondary": "#ffffff",
        "--wjs-color-accent": "#b4694a",
        "--wjs-color-on-accent": "#ffffff",
        "--wjs-color-text-main": "#1d1c16",
        "--wjs-color-text-muted": "#404945",
        "--wjs-color-heading": "#1d1c16",
        "--wjs-color-link": "#154539",
        "--wjs-color-link-hover": "#904c2f",
        "--wjs-color-danger": "#ba1a1a",
        "--wjs-color-on-danger": "#ffffff",
        "--wjs-border-subtle": "#c0c8c4",
        "--wjs-focus-ring": "#2f5d50",
        "--wjs-font-family-base": "'Work Sans', 'Segoe UI', system-ui, sans-serif",
        "--wjs-font-family-heading": "'EB Garamond', Georgia, 'Times New Roman', serif",
        "--wjs-h1": "3.5rem",
        "--wjs-h2": "2.25rem",
        "--wjs-h3": "1.5rem",
        "--wjs-heading-line-height": "1.15",
        "--wjs-radius": "4px",
        "--wjs-radius-md": "4px",
        "--wjs-radius-lg": "4px",
        "--wjs-radius-pill": "4px",
        "--wjs-xs": "0.25rem",
        "--wjs-sm": "0.5rem",
        "--wjs-md": "1rem",
        "--wjs-lg": "1.5rem",
        "--wjs-xl": "2.5rem",
        "--wjs-bg-footer": "#154539",
        "--wjs-color-text-footer-main": "#f2ede3",
        "--wjs-color-text-footer-dim": "#a0d1c0",
        "--wjs-color-text-footer-heading": "#ffffff",
        "--wjs-bg-surface-glass": "#fef9ef",
        "--wjs-h1-tracking": "-0.02em",
        "--wjs-h2-tracking": "-0.01em",
        "--wjs-h1-leading": "1.1",
        "--wjs-radius-sm": "4px",
        "--wjs-card-radius": "4px",
        "--wjs-card-border-width": "1px",
        "--wjs-card-border-color": "#c0c8c4",
        "--wjs-line-height-base": "1.7",
        "--wjs-hero-bg": "#fef9ef",
        "--wjs-hero-gradient-from": "#fef9ef",
        "--wjs-hero-gradient-to": "#fef9ef",
        "--wjs-hero-color": "#1d1c16",
        "--wjs-hero-title-color": "#2f5d50",
        "--wjs-hero-title-size": "4.5rem",
        "--wjs-hero-title-tracking": "-0.02em",
        "--wjs-hero-subtitle-color": "#404945",
        "--wjs-hero-subtitle-size": "1.125rem",
        "--wjs-hero-subtitle-opacity": "1",
        "--wjs-hero-button-bg": "#2f5d50",
        "--wjs-hero-button-color": "#ffffff",
        "--wjs-hero-button-radius": "4px",
        "--wjs-hero-button-outline-color": "#2f5d50",
        "--wjs-hero-button-outline-border": "#2f5d50",
        "--wjs-hero-bg-image": "none",
        "--wjs-outline": "#717975",
        "--wjs-2xl": "4.5rem"
    },
    "styles": {
        "headings": {
            "text-wrap": "balance"
        },
        "links": {
            "text-underline-offset": "3px",
            "text-decoration-thickness": "1px"
        },
        "hero": {
            "min-height": "62vh",
            "text-align": "left",
            "button": {
                "border-radius": "4px",
                "letter-spacing": "0.04em",
                "text-transform": "uppercase",
                "font-size": "0.8rem"
            },
            "mobile": {
                "min-height": "48vh"
            }
        },
        "card": {
            "border-style": "solid",
            "border-width": "1px",
            "box-shadow": "none"
        },
        "pricing": {
            "border-style": "solid",
            "border-width": "1px",
            "box-shadow": "none"
        },
        "cta-banner": {
            "border-radius": "4px"
        }
    }
} as any;

export const STYLE_CSS = "/* @wjs-generated:start — compiled from theme.json; DO NOT EDIT inside. Edit theme.json and run: node backend/cli/wordjs.js build theme stitch-fixture */\n:root {\n  --wjs-bg-canvas: #fef9ef;\n  --wjs-bg-surface: #ffffff;\n  --wjs-bg-surface-raised: #efeae1;\n  --wjs-color-primary: #2f5d50;\n  --wjs-color-primary-dark: #154539;\n  --wjs-color-on-primary: #ffffff;\n  --wjs-color-accent: #b4694a;\n  --wjs-color-on-accent: #ffffff;\n  --wjs-color-text-main: #1d1c16;\n  --wjs-color-text-muted: #404945;\n  --wjs-color-heading: #1d1c16;\n  --wjs-color-link: #154539;\n  --wjs-color-link-hover: #904c2f;\n  --wjs-border-subtle: #c0c8c4;\n  --wjs-outline: #717975;\n  --wjs-outline-variant: #dcd8ce;\n  --wjs-focus-ring: #2f5d50;\n  --wjs-bg-muted: #f2ede3;\n  --wjs-color-secondary: #b4694a;\n  --wjs-color-secondary-dark: #904c2f;\n  --wjs-color-on-secondary: #ffffff;\n  --wjs-color-danger: #ba1a1a;\n  --wjs-color-on-danger: #ffffff;\n  --wjs-font-family-base: 'Work Sans', 'Segoe UI', system-ui, sans-serif;\n  --wjs-font-family-heading: 'EB Garamond', Georgia, 'Times New Roman', serif;\n  --wjs-h1: 3.5rem;\n  --wjs-h2: 2.25rem;\n  --wjs-h3: 1.5rem;\n  --wjs-heading-line-height: 1.15;\n  --wjs-radius: 4px;\n  --wjs-radius-md: 4px;\n  --wjs-radius-lg: 4px;\n  --wjs-radius-pill: 4px;\n  --wjs-xs: 0.25rem;\n  --wjs-sm: 0.5rem;\n  --wjs-md: 1rem;\n  --wjs-lg: 1.5rem;\n  --wjs-xl: 2.5rem;\n  --wjs-bg-footer: #154539;\n  --wjs-color-text-footer-main: #f2ede3;\n  --wjs-color-text-footer-dim: #a0d1c0;\n  --wjs-color-text-footer-heading: #ffffff;\n  --wjs-bg-surface-glass: #fef9ef;\n  --wjs-h1-tracking: -0.02em;\n  --wjs-h2-tracking: -0.01em;\n  --wjs-h1-leading: 1.1;\n  --wjs-radius-sm: 4px;\n  --wjs-card-radius: 4px;\n  --wjs-card-border-width: 1px;\n  --wjs-card-border-color: #c0c8c4;\n  --wjs-line-height-base: 1.7;\n  --wjs-hero-bg: #fef9ef;\n  --wjs-hero-gradient-from: #fef9ef;\n  --wjs-hero-gradient-to: #fef9ef;\n  --wjs-hero-color: #1d1c16;\n  --wjs-hero-title-color: #2f5d50;\n  --wjs-hero-title-size: 4.5rem;\n  --wjs-hero-title-tracking: -0.02em;\n  --wjs-hero-subtitle-color: #404945;\n  --wjs-hero-subtitle-size: 1.125rem;\n  --wjs-hero-subtitle-opacity: 1;\n  --wjs-hero-button-bg: #2f5d50;\n  --wjs-hero-button-color: #ffffff;\n  --wjs-hero-button-radius: 4px;\n  --wjs-hero-button-outline-color: #2f5d50;\n  --wjs-hero-button-outline-border: #2f5d50;\n  --wjs-hero-bg-image: none;\n  --wjs-2xl: 4.5rem;\n  --wjs-hero-text-align: left;\n  --wjs-pricing-border-width: 1px;\n}\nh1,h2,h3,h4,h5,h6 { text-wrap: balance }\na { text-underline-offset: 3px; text-decoration-thickness: 1px }\n.wp-block-hero { min-height: 62vh }\n.wp-block-hero__button { border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; font-size: 0.8rem }\n.wp-block-card { border-style: solid; box-shadow: none }\n.wp-block-pricing { border-style: solid; box-shadow: none }\n.wp-block-cta-banner { border-radius: 4px }\n@media (max-width: 767.98px) {\n  .wp-block-hero { min-height: 48vh }\n}\n/* @wjs-generated:end */\n";
