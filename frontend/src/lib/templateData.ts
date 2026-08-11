/**
 * Declarative page templates — the RENDERER's side of the contract (v1).
 *
 * A theme may ship `templates/<name>.json`: a block tree describing how a page is arranged, with a
 * single `PageContent` hole where the page's own content renders. This is what lets a theme invent a
 * LAYOUT instead of only picking tokens and four switches.
 *
 * AUTHORITY LIVES ON THE BACKEND (backend/src/core/template-validate.ts). This is an independent
 * MIRROR — different package, no shared import — exactly like chromeData.ts mirrors chrome-validate.
 * Two copies is a deliberate trade: the renderer must never render a tree the backend would reject,
 * and it must not need a network round-trip to know that. Keep the allowlist, the enums and the
 * budgets in step when the contract moves.
 *
 * FAIL-CLOSED. Anything unexpected returns null and the page falls back to the default arrangement.
 * A partially-rendered layout is worse than no layout: half a template looks like a broken site, while
 * the fallback looks like a site that simply has no template.
 *
 * THE SECURITY PROPERTY: data fills slots, it never chooses structure. Every prop is a primitive type
 * or a CLOSED ENUM, so nothing in a template can become an element name — the failure mode that
 * produced a stored-XSS critical when a block used an author-controlled prop as its React element type.
 */

export const CONTENT_SLOT = 'PageContent';

const MAX_BYTES = 64 * 1024;
const MAX_BLOCKS = 100;
const MAX_DEPTH = 4;

type PropSpec = { kind: 'string' | 'number' | 'boolean' } | { kind: 'enum'; values: string[] };
const S: PropSpec = { kind: 'string' };
const N: PropSpec = { kind: 'number' };
const B: PropSpec = { kind: 'boolean' };
const en = (...values: string[]): PropSpec => ({ kind: 'enum', values });

/**
 * Closed allowlist — mirrors BLOCKS in backend/src/core/template-validate.ts.
 *
 * Every prop here is one the PAGE BLOCK behind it actually honours (see TemplateRenderer, which renders
 * a template through those same components). A prop the block ignores would validate and do nothing,
 * so `minColumnWidth` and Section's `align` are absent rather than accepted-and-dropped.
 */
const BLOCKS: Record<string, { props: Record<string, PropSpec>; slot: string | null }> = {
    [CONTENT_SLOT]: { props: {}, slot: null },
    Section: { props: { background: S, padding: S, maxWidth: S }, slot: 'items' },
    Grid: { props: { columns: N, gap: S, columnsTablet: N, columnsMobile: N }, slot: 'items' },
    FlexRow: { props: { gap: S, align: en('start', 'center', 'end', 'stretch'), justify: en('start', 'center', 'end', 'between', 'around'), wrap: B, direction: en('row', 'column', 'row-reverse', 'column-reverse') }, slot: 'items' },
    Columns: { props: { columns: N, gap: S }, slot: 'items' },
    Spacer: { props: { height: S }, slot: null },
    Divider: { props: { color: S, width: S, length: S, gap: S }, slot: null },
    // NOT IN v1: PostsGrid, CategoryPosts and SearchBar. They are the obvious things a theme wants in a
    // template, and they are deliberately held back — each derives its content from the site, which
    // after F3 arrives as a PROP the PAGE supplies, and that data path does not exist for a template
    // yet. Allowing them now would validate cleanly and render an empty block, which is the failure
    // mode this whole contract is built to avoid. They join the allowlist with their data path, not
    // before.
};

export interface TemplateBlock { type: string; props: Record<string, unknown> }
export interface TemplateTree { content: TemplateBlock[] }

const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

function propsOk(type: string, props: Record<string, unknown>): boolean {
    const spec = BLOCKS[type].props;
    const slotKey = BLOCKS[type].slot;
    for (const [key, value] of Object.entries(props)) {
        if (key === 'id') continue;
        if (slotKey && key === slotKey) continue; // the child list, walked as a tree
        const ps = spec[key];
        if (!ps) return false;
        if (ps.kind === 'enum') {
            if (typeof value !== 'string' || !ps.values.includes(value)) return false;
            continue;
        }
        if (typeof value !== ps.kind) return false;
    }
    return true;
}

function treeOk(list: unknown, depth: number, state: { blocks: number; slots: number }): boolean {
    if (!Array.isArray(list)) return false;
    if (depth > MAX_DEPTH) return false;
    for (const block of list) {
        if (++state.blocks > MAX_BLOCKS) return false;
        if (!isObj(block)) return false;
        const type = block.type;
        if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(BLOCKS, type)) return false;
        if (type === CONTENT_SLOT) state.slots++;
        const props = block.props === undefined ? {} : block.props;
        if (!isObj(props)) return false;
        if (!propsOk(type, props)) return false;
        const slotKey = BLOCKS[type].slot;
        if (slotKey) {
            const nested = props[slotKey];
            if (nested !== undefined && !treeOk(nested, depth + 1, state)) return false;
        } else {
            // A leaf must not smuggle children: the renderer would ignore them, so the author would be
            // debugging a template that validates and quietly drops half of itself.
            for (const k of ['items', 'content', 'children']) if (props[k] !== undefined) return false;
        }
    }
    return true;
}

/**
 * Parse and validate a theme template. Returns the tree, or null when anything is off — an unreadable
 * file, a contract violation, a busted budget, or the wrong number of content slots.
 */
export function parseTemplate(raw: string | null | undefined): TemplateTree | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // Byte budget BEFORE parsing: a 10MB "template" must not be parsed to find out it is too big.
    if (raw.length > MAX_BYTES) return null;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return null; }
    if (!isObj(data)) return null;
    const state = { blocks: 0, slots: 0 };
    if (!treeOk(data.content, 1, state)) return null;
    // Exactly one: none and the page's content disappears, two and it renders twice — duplicating every
    // heading and id on the page.
    if (state.slots !== 1) return null;
    return { content: data.content as TemplateBlock[] };
}

/**
 * Which template a route asks for, most specific first. The renderer takes the first one the theme
 * actually ships, so a theme may provide only `page.json` and still affect every page.
 */
export function templateCandidates(kind: 'home' | 'single' | 'page' | 'archive' | 'search'): string[] {
    switch (kind) {
        case 'home': return ['home', 'archive', 'page'];
        case 'single': return ['single', 'page'];
        case 'archive': return ['archive', 'page'];
        case 'search': return ['search', 'archive', 'page'];
        default: return ['page'];
    }
}
