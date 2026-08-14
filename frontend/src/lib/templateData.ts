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

type PropSpec =
    | { kind: 'string' | 'number' | 'boolean' }
    | { kind: 'enum'; values: string[] }
    | { kind: 'classlist' }
    | { kind: 'partname' };
const S: PropSpec = { kind: 'string' };
const N: PropSpec = { kind: 'number' };
const B: PropSpec = { kind: 'boolean' };
const en = (...values: string[]): PropSpec => ({ kind: 'enum', values });

/**
 * The container wrapper affordance — MIRRORS TAGS/CLASS_TOKEN in backend/src/core/template-validate.ts.
 *
 * Adapted from Shopify, whose section `{% schema %}` may declare `tag` (the wrapper's element name, from
 * a closed list of six) and `class` (APPENDED to the wrapper class Shopify emits). The enum is what makes
 * it safe: the theme picks a name the platform owns, it never supplies structure.
 *
 * `main` is excluded on purpose — PublicLayoutShell already renders `<main id="main-content">` around
 * every template, and a nested <main> is an invalid landmark.
 */
export const TEMPLATE_TAGS = ['article', 'aside', 'div', 'footer', 'header', 'section'] as const;
export type TemplateTag = (typeof TEMPLATE_TAGS)[number];

/** One class name. Narrow on purpose: no space, quote, bracket, dot, colon or slash can appear. */
export const CLASS_TOKEN = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_CLASS_TOKENS = 3;

/** Space-separated, at most MAX_CLASS_TOKENS. Split on a single space so tabs/newlines/doubles FAIL. */
export function classListOk(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    if (value === '' || value !== value.trim()) return false;
    const tokens = value.split(' ');
    if (tokens.length > MAX_CLASS_TOKENS) return false;
    return tokens.every((t) => CLASS_TOKEN.test(t));
}

const TAG: PropSpec = en(...TEMPLATE_TAGS);
const CLASSNAME: PropSpec = { kind: 'classlist' };

/**
 * NAMED TEMPLATE PARTS — MIRRORS TEMPLATE_PART_AREAS / TEMPLATE_PART_NAME in
 * backend/src/core/chrome-validate.ts (the authority for the theme.json `templateParts` declaration)
 * and the `TemplatePart` block in backend/src/core/template-validate.ts.
 *
 * The name is a chrome/<name>.json FILE NAME that lands in a URL, so the pattern is deliberately the
 * same one server-api.ts's getThemeTemplate/getThemeChrome enforce before fetching. Two independent
 * gates on the same shape: one here, one at the fetch.
 */
export const TEMPLATE_PART_NAME = /^[a-z0-9-]{1,40}$/;
export const TEMPLATE_PART_AREAS = ['header', 'footer', 'sidebar', 'general'] as const;
export type TemplatePartArea = (typeof TEMPLATE_PART_AREAS)[number];
/** `header`/`footer` are the SITE chrome, resolved by the layout — never a part a page can pull in. */
const RESERVED_PART_NAMES = ['header', 'footer'];
const MAX_TEMPLATE_PARTS = 16;
const PARTNAME: PropSpec = { kind: 'partname' };

/**
 * Closed allowlist — mirrors BLOCKS in backend/src/core/template-validate.ts.
 *
 * Every prop here is one the PAGE BLOCK behind it actually honours (see TemplateRenderer, which renders
 * a template through those same components). A prop the block ignores would validate and do nothing,
 * so `minColumnWidth` and Section's `align` are absent rather than accepted-and-dropped.
 */
const BLOCKS: Record<string, { props: Record<string, PropSpec>; slot: string | null; required?: string[] }> = {
    [CONTENT_SLOT]: { props: {}, slot: null },
    Section: { props: { background: S, padding: S, maxWidth: S, tag: TAG, className: CLASSNAME }, slot: 'items' },
    Grid: { props: { columns: N, gap: S, columnsTablet: N, columnsMobile: N, tag: TAG, className: CLASSNAME }, slot: 'items' },
    FlexRow: { props: { gap: S, align: en('start', 'center', 'end', 'stretch'), justify: en('start', 'center', 'end', 'between', 'around'), wrap: B, direction: en('row', 'column', 'row-reverse', 'column-reverse'), tag: TAG, className: CLASSNAME }, slot: 'items' },
    Columns: { props: { columns: N, gap: S, tag: TAG, className: CLASSNAME }, slot: 'items' },
    Spacer: { props: { height: S }, slot: null },
    Divider: { props: { color: S, width: S, length: S, gap: S }, slot: null },
    // DYNAMIC — the query loop. These derive their content from the SITE, so they may appear only now
    // that a template has a data path (lib/resolveTemplateBlocks.ts) and the route hands them its own
    // posts. Every prop below is one the block actually honours; `count` is consumed by the resolver.
    PostsGrid: { props: { count: N, columns: N, gap: S, bg: S, borderColor: S, radius: S, pad: S, thumbHeight: S }, slot: null },
    CategoryPosts: { props: { count: N, categorySlug: S, layout: en('grid', 'list'), columns: N, gap: S, bg: S, borderColor: S, radius: S, linkColor: S, headingColor: S }, slot: null },
    SearchBar: { props: { placeholder: S, buttonText: S, align: en('left', 'center', 'right'), width: S, inputBg: S, inputBorderColor: S, inputRadius: S, buttonBg: S, buttonColor: S, buttonRadius: S }, slot: null },
    // A named template part — chrome/<name>.json pulled into the page. Both props are REQUIRED: with
    // no name there is nothing to resolve and with no area there is no wrapper to render into.
    TemplatePart: { props: { name: PARTNAME, area: en(...TEMPLATE_PART_AREAS) }, slot: null, required: ['name', 'area'] },
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
        if (ps.kind === 'classlist') {
            if (!classListOk(value)) return false;
            continue;
        }
        if (ps.kind === 'partname') {
            if (typeof value !== 'string' || !TEMPLATE_PART_NAME.test(value)) return false;
            continue;
        }
        if (typeof value !== ps.kind) return false;
    }
    for (const key of BLOCKS[type].required || []) {
        if (props[key] === undefined) return false;
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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TEMPLATE HIERARCHY
 *
 * ADAPTED FROM WORDPRESS, which resolves a template most-specific-first and falls back until
 * something exists: single-{post_type}-{slug} → single-{post_type} → single → index. Shopify does the
 * same with alternate templates (product.tall.json). We take the SHAPE and keep the grammar closed —
 * a fixed set of kinds, names composed only from a slug and a post type, and nothing else.
 *
 * EVERY CHAIN ENDS AT `page`. It is this system's `index`: a theme that ships one page.json affects
 * every route, which is the property that makes the whole feature worth using at all.
 *
 * COMPOSED NAMES ARE SHAPE-CHECKED, NOT SANITIZED. A name becomes a URL path segment
 * (/themes/<slug>/templates/<name>.json), so anything that does not match TEMPLATE_NAME is DROPPED
 * from the chain rather than cleaned up — a post titled with an em-dash simply falls back to
 * `single-post`, and nothing a post slug contains can ever reach the fetch. server-api.ts's
 * getThemeTemplate re-checks the identical pattern; two gates, deliberately.
 */

/** A template file name. IDENTICAL to the guard in server-api.ts's getThemeTemplate — keep them so. */
export const TEMPLATE_NAME = /^[a-z0-9-]{1,40}$/;

/**
 * What a route IS. Only five of these are reachable today (see the table in documentation/themes.md):
 * `home`, `single`, `page`, `search` and `notFound` have routes under frontend/src/app/(public).
 * `category`, `tag`, `author` and `date` have NO route in this codebase — WordJS has no archive pages
 * — so they are the hierarchy's shape, ready for the routes, and NOT something a theme can see today.
 * They are documented as unreachable rather than quietly implied, because this system already shipped
 * one promise of an "Archive route" that did not exist.
 */
export type TemplateKind =
    | 'home' | 'single' | 'page' | 'search' | 'notFound'
    | 'category' | 'tag' | 'author' | 'date';

/** What the route knows that makes a name more specific: the thing's slug, and a post's type. */
export interface TemplateQuery {
    /** Post slug, page slug, or term slug. */
    slug?: string;
    /** `post`, `page`, or a custom post type — only meaningful for `single`. */
    postType?: string;
}

/** Lower-cased and trimmed, then shape-checked by TEMPLATE_NAME when the name is assembled. */
const seg = (v: string | undefined): string => String(v ?? '').trim().toLowerCase();

/**
 * Which templates a route asks for, MOST SPECIFIC FIRST. The renderer takes the first one the theme
 * actually ships. Names that cannot be a file name are dropped, duplicates collapse, and the chain
 * always ends at `page`.
 */
export function templateCandidates(kind: TemplateKind, query: TemplateQuery = {}): string[] {
    const slug = seg(query.slug);
    const type = seg(query.postType);
    // Compose ONLY from a part the route actually supplied. An empty slug would otherwise yield
    // `single-post-`, which passes the name pattern (a trailing hyphen is legal) and asks the theme
    // for a file whose name means nothing — a candidate that can only ever be a mistake.
    const join = (...bits: string[]): string => (bits.every(Boolean) ? bits.join('-') : '');
    let chain: string[];
    switch (kind) {
        case 'home':
            chain = ['home', 'archive', 'page'];
            break;
        case 'single':
            chain = [join('single', type, slug), join('single', type), 'single', 'page'];
            break;
        case 'page':
            chain = [join('page', slug), 'page'];
            break;
        case 'category':
            chain = [join('category', slug), 'category', 'archive', 'page'];
            break;
        case 'tag':
            chain = [join('tag', slug), 'tag', 'archive', 'page'];
            break;
        case 'author':
            chain = [join('author', slug), 'author', 'archive', 'page'];
            break;
        case 'date':
            chain = ['date', 'archive', 'page'];
            break;
        case 'search':
            chain = ['search', 'archive', 'page'];
            break;
        case 'notFound':
            // WordPress's 404.php. A digit-leading name is fine: TEMPLATE_NAME is [a-z0-9-].
            chain = ['404', 'page'];
            break;
        default:
            chain = ['page'];
    }
    const out: string[] = [];
    for (const name of chain) {
        if (!TEMPLATE_NAME.test(name) || out.includes(name)) continue;
        out.push(name);
    }
    // Belt and braces: `page` is always a legal name, so this can only fire if the switch ever grows a
    // branch that forgets it. A chain that does not end at `page` would silently strand a theme.
    if (out[out.length - 1] !== 'page') out.push('page');
    return out;
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * theme.json `templateParts` — the renderer's mirror of core/chrome-validate.ts's validateTemplateParts.
 */

/**
 * Parse a theme.json's `templateParts` declaration into name → area.
 *
 * FAIL-CLOSED AS A WHOLE, exactly like the backend validator: one bad entry drops every part, so a
 * theme can never half-load its parts and leave a page with some of its furniture missing. An absent
 * declaration is the normal case and yields an empty map, which is also what makes an undeclared
 * `TemplatePart` render nothing — the declaration is the ONLY thing that turns a chrome/<name>.json
 * into something a template may pull in.
 */
export function parseTemplateParts(raw: string | null | undefined): Map<string, TemplatePartArea> {
    const empty = new Map<string, TemplatePartArea>();
    if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_BYTES) return empty;
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return empty; }
    if (!isObj(data)) return empty;
    const decl = (data as Record<string, unknown>).templateParts;
    if (decl === undefined) return empty;
    if (!Array.isArray(decl) || decl.length > MAX_TEMPLATE_PARTS) return empty;
    const out = new Map<string, TemplatePartArea>();
    for (const entry of decl) {
        if (!isObj(entry)) return empty;
        for (const key of Object.keys(entry)) if (key !== 'name' && key !== 'area') return empty;
        const name = entry.name;
        const area = entry.area;
        if (typeof name !== 'string' || !TEMPLATE_PART_NAME.test(name)) return empty;
        if (RESERVED_PART_NAMES.includes(name) || out.has(name)) return empty;
        if (typeof area !== 'string' || !(TEMPLATE_PART_AREAS as readonly string[]).includes(area)) return empty;
        out.set(name, area as TemplatePartArea);
    }
    return out;
}
