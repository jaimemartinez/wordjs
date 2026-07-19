/**
 * Block patterns — curated, one-click starter layouts (Gutenberg's "Patterns" equivalent).
 *
 * Each pattern is a sequence of top-level blocks; a block may nest children into slot props via
 * `slots` (e.g. a Section's `children`), and the builder resolves them recursively. On insert,
 * every block merges the block's own `defaultProps` (read from the LIVE config, so it's always
 * valid) + the pattern's overrides + a fresh unique id, then the whole batch is appended to the
 * page via Puck's proven setData dispatch (the same mechanism updateComponent uses).
 *
 * USER patterns ("Mis plantillas") are captured from the live page and stored in localStorage as
 * raw Puck content items; ids are regenerated on every insert so repeats never collide.
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

/** Deep-clone a raw Puck content item with fresh ids (including children nested in slot props). */
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
 * Build valid Puck content items for a pattern, merging each block's real defaultProps from the live
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

/** Append prebuilt content items to the current page via Puck's live dispatch. */
function appendItems(items: any[]): boolean {
    if (!items.length) return false;
    const dispatch = (window as any).puckDispatch || (window.parent as any)?.puckDispatch;
    if (!dispatch) return false;
    dispatch({
        type: "setData",
        data: (prev: any) => ({ ...prev, content: [...(prev.content || []), ...items] }),
        recordHistory: true, // programmatic setData skips history by default → Ctrl+Z couldn't undo an insert
    });
    return true;
}

/**
 * Append a pattern's blocks to the current page. Uses Puck's live dispatch (window.puckDispatch) with
 * the function form of setData so it operates on Puck's authoritative store, not a stale mirror.
 * Returns false if nothing could be inserted (no dispatch yet, or all blocks unavailable).
 */
export function insertPattern(pattern: Pattern, components: Record<string, any>): boolean {
    return appendItems(buildPatternBlocks(pattern, components));
}

/**
 * Insert a SINGLE block (by type) — the ⌘K command palette's action. Merges the block's real
 * defaultProps from the live config + a fresh id. Positioning mirrors block paste: after the current
 * root selection when one exists, otherwise appended to the end. Returns false if the type isn't
 * registered in this config or Puck's dispatch isn't ready yet.
 */
export function insertBlock(
    type: string,
    components: Record<string, any>,
    sel?: { index: number; zone?: string } | null
): boolean {
    if (!components || !components[type]) return false;
    const item = { type, props: { ...(components[type]?.defaultProps || {}), id: genId(type) } };
    const dispatch = (window as any).puckDispatch || (window.parent as any)?.puckDispatch;
    if (!dispatch) return false;
    dispatch({
        type: "setData",
        data: (prev: any) => {
            const content = [...(prev.content || [])];
            // Insert after the selection when it lives in the root content; otherwise append.
            const inRoot = sel && (!sel.zone || /(^|:)(default-zone|content)$/.test(sel.zone));
            const at = inRoot ? Math.min(sel!.index + 1, content.length) : content.length;
            content.splice(at, 0, item);
            return { ...prev, content };
        },
        recordHistory: true, // programmatic setData skips history by default → keep ⌘K inserts undoable
    });
    return true;
}

// ---------------------------------------------------------------------------
// User patterns — captured from the live page, persisted per browser.
// ---------------------------------------------------------------------------

export type UserPattern = {
    id: string;
    name: string;
    /** Raw Puck content items (ids are regenerated on insert). */
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

/** Capture the CURRENT page content (live Puck store) as a reusable pattern. */
export function saveCurrentPageAsPattern(name: string): UserPattern | null {
    const getData = (window as any).puckGetData || (window.parent as any)?.puckGetData;
    const data = getData?.();
    const items = (data?.content || []).filter((i: any) => i && i.type && i.props);
    if (!items.length) return null;
    const pattern: UserPattern = {
        id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || "Mi plantilla",
        items,
        createdAt: new Date().toISOString(),
    };
    const list = loadUserPatterns();
    list.unshift(pattern);
    return persistUserPatterns(list.slice(0, 30)) ? pattern : null;
}

export function deleteUserPattern(id: string): UserPattern[] {
    const list = loadUserPatterns().filter((p) => p.id !== id);
    persistUserPatterns(list);
    return list;
}

/** Insert a user pattern: skip block types missing from this config, regenerate every id. */
export function insertUserPattern(pattern: UserPattern, components: Record<string, any>): boolean {
    const items = (pattern.items || [])
        .filter((i: any) => components && components[i.type])
        .map(regenIds);
    return appendItems(items);
}
