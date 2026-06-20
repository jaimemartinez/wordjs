/**
 * Block patterns — curated, one-click starter layouts (Gutenberg's "Patterns" equivalent).
 *
 * Each pattern is a flat sequence of top-level blocks. On insert, every block merges the block's own
 * `defaultProps` (read from the LIVE config, so it's always valid) + the pattern's overrides + a fresh
 * unique id, then the whole batch is appended to the page via Puck's proven setData dispatch (the same
 * mechanism updateComponent uses). Flat-only (no slot nesting) keeps insertion robust.
 */

type PatternBlock = { type: string; props?: Record<string, any> };

export type Pattern = {
    id: string;
    name: string;
    icon: string;
    description: string;
    blocks: PatternBlock[];
};

export const PATTERNS: Pattern[] = [
    {
        id: "intro",
        name: "Introducción",
        icon: "fa-heading",
        description: "Título, descripción y botón",
        blocks: [
            { type: "Heading", props: { title: "Un título que engancha", level: "h2" } },
            { type: "Text", props: { content: "Acompaña tu título con una frase breve que explique el valor de lo que ofreces a tus visitantes." } },
            { type: "Button", props: { label: "Saber más", href: "#", align: "left" } },
        ],
    },
    {
        id: "services",
        name: "Servicios",
        icon: "fa-grip",
        description: "Encabezado + 3 tarjetas",
        blocks: [
            { type: "Heading", props: { title: "Lo que ofrecemos", level: "h2" } },
            { type: "Card", props: { title: "Servicio uno", description: "Describe brevemente este servicio o característica destacada.", icon: "fa-bolt" } },
            { type: "Card", props: { title: "Servicio dos", description: "Describe brevemente este servicio o característica destacada.", icon: "fa-heart" } },
            { type: "Card", props: { title: "Servicio tres", description: "Describe brevemente este servicio o característica destacada.", icon: "fa-star" } },
        ],
    },
    {
        id: "pricing",
        name: "Precios",
        icon: "fa-tags",
        description: "Encabezado + tabla de precios",
        blocks: [
            { type: "Heading", props: { title: "Planes y precios", level: "h2" } },
            { type: "Text", props: { content: "Elige el plan que mejor se adapta a ti." } },
            { type: "PricingTable", props: {} },
        ],
    },
    {
        id: "testimonials",
        name: "Testimonios",
        icon: "fa-quote-left",
        description: "Encabezado + testimonio",
        blocks: [
            { type: "Heading", props: { title: "Lo que dicen de nosotros", level: "h2" } },
            { type: "Testimonial", props: {} },
        ],
    },
    {
        id: "faq",
        name: "Preguntas frecuentes",
        icon: "fa-circle-question",
        description: "Encabezado + acordeón",
        blocks: [
            { type: "Heading", props: { title: "Preguntas frecuentes", level: "h2" } },
            { type: "Accordion", props: {} },
        ],
    },
    {
        id: "cta",
        name: "Llamada a la acción",
        icon: "fa-bullhorn",
        description: "Separador + banner de conversión",
        blocks: [
            { type: "Divider", props: {} },
            { type: "CTABanner", props: {} },
        ],
    },
];

const genId = (type: string): string =>
    `${type}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Build valid Puck content items for a pattern, merging each block's real defaultProps from the live
 * config. Blocks whose type isn't registered in this config (e.g. a disabled plugin) are skipped.
 */
export function buildPatternBlocks(pattern: Pattern, components: Record<string, any>) {
    return pattern.blocks
        .filter((b) => components && components[b.type])
        .map((b) => {
            const defaults = components[b.type]?.defaultProps || {};
            return {
                type: b.type,
                props: { ...defaults, ...(b.props || {}), id: genId(b.type) },
            };
        });
}

/**
 * Append a pattern's blocks to the current page. Uses Puck's live dispatch (window.puckDispatch) with
 * the function form of setData so it operates on Puck's authoritative store, not a stale mirror.
 * Returns false if nothing could be inserted (no dispatch yet, or all blocks unavailable).
 */
export function insertPattern(pattern: Pattern, components: Record<string, any>): boolean {
    const blocks = buildPatternBlocks(pattern, components);
    if (!blocks.length) return false;
    const dispatch = (window as any).puckDispatch || (window.parent as any)?.puckDispatch;
    if (!dispatch) return false;
    dispatch({
        type: "setData",
        data: (prev: any) => ({ ...prev, content: [...(prev.content || []), ...blocks] }),
    });
    return true;
}
