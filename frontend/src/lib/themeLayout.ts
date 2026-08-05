// Pure normalization of the active theme's structure config (theme.json `layout`, schema v2 — see
// backend/public/theme-layouts.schema.json). Every key is optional and ABSENCE must reproduce today's
// chrome exactly, so each default below mirrors the current hard-coded rendering. Invalid values fall
// back to those same defaults silently — the theme doctor reports them in its own lane.

export type HeaderVariant = "classic" | "centered" | "minimal";
export type FooterVariant = "columns" | "minimal";
export type FooterColumns = 1 | 2 | 3 | 4;
export type SidebarPosition = "left" | "right";

export interface ThemeLayoutConfig {
    header: { variant: HeaderVariant; sticky: boolean; transparent: boolean };
    footer: { variant: FooterVariant; columns: FooterColumns };
    sidebar: { enabled: boolean; position: SidebarPosition };
    containerWidth: string | null;
}

const HEADER_VARIANTS: readonly HeaderVariant[] = ["classic", "centered", "minimal"];
const FOOTER_VARIANTS: readonly FooterVariant[] = ["columns", "minimal"];
const FOOTER_COLUMNS: readonly FooterColumns[] = [1, 2, 3, 4];

// containerWidth ends up in an INLINE style (max-width on <main>), so an arbitrary theme.json string
// would let a theme smuggle further declarations or a url() into the page. Only a plain CSS
// length/percentage — or a simple calc() built from those — is accepted.
const CSS_UNITS = "px|rem|em|ch|ex|vw|vh|vmin|vmax|cm|mm|q|in|pt|pc|%";
const CSS_LENGTH_RE = new RegExp(`^\\d+(?:\\.\\d+)?(?:${CSS_UNITS})$`, "i");
const CSS_NUMBER_RE = /^\d+(?:\.\d+)?$/;
// calc() body: everything between the operators/parens/spaces must be a length or a bare number. The
// body is SPLIT and each token matched on its own — an `(?:number|operator)+` scan over one string
// nests quantifiers and backtracks exponentially on a digit run ending in garbage (ReDoS).
const CALC_SEPARATORS_RE = /[\s+\-*/()]+/;
const CONTAINER_WIDTH_MAX_LENGTH = 64;

function parseContainerWidth(value: string): string | null {
    const width = value.trim();
    if (width.length === 0 || width.length > CONTAINER_WIDTH_MAX_LENGTH) return null;
    if (CSS_LENGTH_RE.test(width)) return width;
    const calc = /^calc\((.+)\)$/i.exec(width);
    if (!calc) return null;
    const operands = calc[1].split(CALC_SEPARATORS_RE).filter(Boolean);
    // A letter can only reach here as part of a unit, so url(), var() and any ';'/'}' break-out fail.
    if (operands.length > 0 && operands.every((op) => CSS_LENGTH_RE.test(op) || CSS_NUMBER_RE.test(op))) return width;
    return null;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseThemeLayout(layout: unknown): ThemeLayoutConfig {
    const src = asRecord(layout);
    const header = asRecord(src.header);
    const footer = asRecord(src.footer);

    let sidebar: ThemeLayoutConfig["sidebar"] = { enabled: false, position: "right" };
    if (src.sidebar === true || src.sidebar === "true") {
        // Legacy boolean form (and its historical "true" string) ≡ { position: "right" }.
        sidebar = { enabled: true, position: "right" };
    } else if (src.sidebar && typeof src.sidebar === "object" && !Array.isArray(src.sidebar)) {
        const pos = (src.sidebar as Record<string, unknown>).position;
        sidebar = { enabled: true, position: pos === "left" ? "left" : "right" };
    }

    return {
        header: {
            variant: HEADER_VARIANTS.includes(header.variant as HeaderVariant) ? (header.variant as HeaderVariant) : "classic",
            sticky: header.sticky !== false,
            transparent: header.transparent === true,
        },
        footer: {
            variant: FOOTER_VARIANTS.includes(footer.variant as FooterVariant) ? (footer.variant as FooterVariant) : "columns",
            columns: FOOTER_COLUMNS.includes(footer.columns as FooterColumns) ? (footer.columns as FooterColumns) : 4,
        },
        sidebar,
        containerWidth: typeof src.containerWidth === "string" ? parseContainerWidth(src.containerWidth) : null,
    };
}
