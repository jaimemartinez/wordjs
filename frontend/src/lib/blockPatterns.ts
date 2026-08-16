/**
 * Block patterns — curated, one-click starter layouts (Gutenberg's "Patterns" equivalent).
 *
 * Each pattern is a sequence of top-level blocks; a block may nest children into slot props via
 * `slots` (e.g. a Section's `children`), and the builder resolves them recursively.
 *
 * SCOPE: this module is the ENGINE-INDEPENDENT half — pure pattern data, recursive id regeneration
 * and the localStorage store for user patterns. The half that touches the editor lives in
 * components/verso/editor/patterns.ts, which builds against the live BlockRegistry and inserts via
 * `handle.transact` (one transaction per pattern = one undo entry).
 *
 * The insert/capture helpers that used to live here were removed with the retired editor: they
 * reached for `window.puckDispatch` / `window.puckGetData`, globals that engine published and that
 * nothing sets any more, so every one of them could only return false/null. Their live replacements
 * are insertVersoPattern / insertItemsAtEnd / saveDocAsPattern in that same module.
 *
 * USER patterns ("Mis plantillas") are stored in localStorage as raw content items under a key
 * SHARED with that module (`wjs_user_patterns`); ids are regenerated on every insert so repeats
 * never collide.
 */

type PatternBlock = { type: string; props?: Record<string, any>; slots?: Record<string, PatternBlock[]> };

export type Pattern = {
    id: string;
    name: string;
    icon: string;
    description: string;
    blocks: PatternBlock[];
};

export const PATTERNS: Pattern[] = [
    {
        id: "hero",
        name: "Hero",
        icon: "fa-mountain-sun",
        description: "Cabecera de impacto con botones",
        blocks: [
            { type: "Hero", props: {} },
        ],
    },
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
        id: "features",
        name: "Ventajas",
        icon: "fa-list-check",
        description: "Encabezado + lista de ventajas con iconos",
        blocks: [
            { type: "Heading", props: { title: "Por qué elegirnos", level: "h2" } },
            { type: "IconList", props: {} },
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
        id: "stats",
        name: "Cifras",
        icon: "fa-chart-simple",
        description: "Números que generan confianza",
        blocks: [
            { type: "Heading", props: { title: "En números", level: "h2" } },
            { type: "Stats", props: {} },
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

/** Deep-clone a raw content item with fresh ids (including children nested in slot props). */
export function regenIds(item: any): any {
    if (!item || typeof item !== "object") return item;
    const props: any = { ...(item.props || {}) };
    for (const key in props) {
        const val = props[key];
        if (Array.isArray(val) && val.some((c: any) => c && typeof c === "object" && c.type && c.props)) {
            props[key] = val.map(regenIds);
        }
    }
    props.id = genId(item.type || "Block");
    return { ...item, props };
}

/**
 * Build valid content items for a pattern, merging each block's real defaultProps from the live
 * config; `slots` children are built recursively into the matching slot props. Blocks whose type
 * isn't registered in this config (e.g. a disabled plugin) are skipped.
 */
export function buildPatternBlocks(pattern: Pattern, components: Record<string, any>) {
    const build = (b: PatternBlock): any | null => {
        if (!components || !components[b.type]) return null;
        const defaults = components[b.type]?.defaultProps || {};
        const props: any = { ...defaults, ...(b.props || {}), id: genId(b.type) };
        for (const [slot, children] of Object.entries(b.slots || {})) {
            props[slot] = (children || []).map(build).filter(Boolean);
        }
        return { type: b.type, props };
    };
    return pattern.blocks.map(build).filter(Boolean);
}

// ---------------------------------------------------------------------------
// User patterns — captured from the live page, persisted per browser.
// ---------------------------------------------------------------------------

export type UserPattern = {
    id: string;
    name: string;
    /** Raw content items (ids are regenerated on insert). */
    items: any[];
    createdAt: string;
};

const USER_PATTERNS_KEY = "wjs_user_patterns";

export function loadUserPatterns(): UserPattern[] {
    try {
        const raw = localStorage.getItem(USER_PATTERNS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((p) => p && p.id && Array.isArray(p.items)) : [];
    } catch {
        return [];
    }
}

function persistUserPatterns(list: UserPattern[]): boolean {
    try {
        localStorage.setItem(USER_PATTERNS_KEY, JSON.stringify(list));
        return true;
    } catch {
        return false; // storage full/blocked
    }
}

export function deleteUserPattern(id: string): UserPattern[] {
    const list = loadUserPatterns().filter((p) => p.id !== id);
    persistUserPatterns(list);
    return list;
}
