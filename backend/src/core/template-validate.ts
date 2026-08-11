/**
 * WordJS — declarative page-template validator (contract v1)
 *
 * A theme may ship `templates/<name>.json`: a BLOCK TREE describing how a page is arranged, with a
 * hole where the page's own content goes. It is the answer to the one thing this theme system could
 * not do — a theme could pick colours and four layout switches, but it could not invent a layout.
 *
 * WHY A TREE AND NOT A TEMPLATE LANGUAGE. Handlebars, Liquid and Twig would buy the same
 * expressiveness and cost both properties this system exists for:
 *   · the theme would own the MARKUP, so the framework could no longer change how a block renders
 *     without breaking themes (this is exactly what breaks WordPress themes on core updates);
 *   · the theme would carry LOGIC, so installing one would again be an act of trust.
 * A validated tree is DATA. The framework's own server components render it, so a theme gains real
 * layout freedom while the markup — and the trust boundary — stay on this side.
 *
 * THE SECURITY PROPERTY, and it is the one this codebase learned the hard way: DATA FILLS SLOTS, IT
 * NEVER CHOOSES STRUCTURE. A stored-XSS critical shipped from a block that used an author-controlled
 * prop as the React ELEMENT TYPE (`level: "script"`), and the write-side sanitizer let it through
 * because it classifies string leaves as HTML-bearing or URL-bearing and a STRUCTURAL prop is
 * neither. So every prop here is checked against a type or a closed enum, and a template can no more
 * name an element than it can name a selector.
 *
 * Mirrors chrome-validate's shape and discipline on purpose (closed allowlist, fail-closed, whole-tree
 * rejection, byte/block/depth budgets) — two validators with the same instincts are easier to keep
 * honest than one clever one. Dependency-free so the doctor and the CLI can load it anywhere.
 *
 * Error codes (stable contract):
 *   TPL_INVALID_JSON      not parseable / not JSON-serializable
 *   TPL_TOO_LARGE         over the 64KB budget
 *   TPL_INVALID_SHAPE     structural violation (root/content/block/props shape)
 *   TPL_UNKNOWN_TYPE      block type outside the closed allowlist
 *   TPL_FORBIDDEN_TYPE    a real block type deliberately not allowed in a THEME-shipped template
 *   TPL_UNKNOWN_PROP      prop the block's contract does not define
 *   TPL_INVALID_PROP      wrong type, or a value outside its enum
 *   TPL_SLOT_MISSING      no PageContent slot — the page's content would have nowhere to render
 *   TPL_SLOT_DUPLICATE    more than one PageContent slot
 *   TPL_TOO_MANY_BLOCKS   over the 100-block budget
 *   TPL_TOO_DEEP          nested deeper than 4
 */

const MAX_BYTES = 64 * 1024;
const MAX_BLOCKS = 100;
const MAX_DEPTH = 4; // one deeper than chrome: a page arranges sections > rows > columns > parts

interface TemplateError { code: string; path: string; message: string }
interface TemplateResult { ok: boolean; errors: TemplateError[] }
/**
 * NAMING NOTE — `templates/` also holds the legacy Handlebars files (`index.html`, `single.html`,
 * `archive.html`) from the theme renderer that is not mounted. Block templates are the `.json` files in
 * that directory and nothing reads the `.html` ones; the two never collide because the extension picks
 * the system. Retiring the dead `.html` set is its own change, not a prerequisite for this one.
 */

/**
 * The hole the page's own content renders into. Exactly one per template: none and the content
 * silently disappears; two and it renders twice, duplicating every heading and id on the page.
 */
const CONTENT_SLOT = 'PageContent';

/**
 * Props are declared as a TYPE or a closed ENUM — never free-form. `enum` is what makes a structural
 * prop impossible to abuse: a value outside the set is rejected, so nothing here can become an
 * element name, a selector or a tag.
 */
type PropSpec = { kind: 'string' | 'number' | 'boolean' } | { kind: 'enum'; values: string[] };

const LEN = { kind: 'string' } as const;
const NUM = { kind: 'number' } as const;
const BOOL = { kind: 'boolean' } as const;
const en = (...values: string[]): PropSpec => ({ kind: 'enum', values });

/**
 * CLOSED allowlist. A template is STRUCTURE plus the dynamic blocks that derive their content from
 * the site, so this is deliberately narrower than the 30 types the page renderer knows.
 *
 * `slot` names the child list a block may nest, or null for a leaf.
 */
const BLOCKS: Record<string, { props: Record<string, PropSpec>; slot: string | null }> = {
    [CONTENT_SLOT]: { props: {}, slot: null },

    // Layout
    Section: { props: { background: LEN, padding: LEN, maxWidth: LEN }, slot: 'items' },
    Grid: { props: { columns: NUM, gap: LEN, columnsTablet: NUM, columnsMobile: NUM }, slot: 'items' },
    FlexRow: { props: { gap: LEN, align: en('start', 'center', 'end', 'stretch'), justify: en('start', 'center', 'end', 'between', 'around'), wrap: BOOL, direction: en('row', 'column', 'row-reverse', 'column-reverse') }, slot: 'items' },
    Columns: { props: { columns: NUM, gap: LEN }, slot: 'items' },
    Spacer: { props: { height: LEN }, slot: null },
    Divider: { props: { color: LEN, width: LEN, length: LEN, gap: LEN }, slot: null },

    // NOT IN v1: PostsGrid, CategoryPosts and SearchBar. They are the obvious things a theme wants in a
    // template, and they are deliberately held back — each derives its content from the site, which
    // after F3 arrives as a PROP the PAGE supplies, and that data path does not exist for a template
    // yet. Allowing them now would validate cleanly and render an empty block, which is the failure
    // mode this whole contract is built to avoid. They join the allowlist with their data path, not
    // before.
};

/**
 * Real block types a theme-shipped template may NOT use, with the reason. Reported as
 * TPL_FORBIDDEN_TYPE rather than TPL_UNKNOWN_TYPE so a theme author is told "not here" instead of
 * hunting a typo.
 */
const FORBIDDEN: Record<string, string> = {
    HTMLEmbed: 'raw HTML in a theme-shipped template is an injection surface — the page body is the place for it',
    Symbol: 'a Symbol resolves to stored content a theme cannot see at validation time',
    Form: 'a form needs a per-site configuration a theme cannot carry',
    Heading: 'a template arranges the page; the page supplies its own headings',
    Text: 'a template arranges the page; the page supplies its own copy',
    Image: 'a template must not ship page imagery — use the page content or a token-driven background',
};

const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkProps(type: string, props: any, path: string, errors: TemplateError[]): void {
    const spec = BLOCKS[type].props;
    const slotKey = BLOCKS[type].slot;
    for (const [key, value] of Object.entries(props)) {
        if (key === 'id') continue; // editor-assigned, ignored by the renderer
        // The slot key is not a prop: it is the child list, validated by walk() as a TREE. Checking it
        // here would reject every nesting block, which is most of the allowlist.
        if (slotKey && key === slotKey) continue;
        const ps = spec[key];
        if (!ps) {
            errors.push({ code: 'TPL_UNKNOWN_PROP', path: `${path}.props.${key}`, message: `"${type}" has no prop "${key}"` });
            continue;
        }
        if (ps.kind === 'enum') {
            if (typeof value !== 'string' || !ps.values.includes(value)) {
                errors.push({ code: 'TPL_INVALID_PROP', path: `${path}.props.${key}`, message: `must be one of: ${ps.values.join(', ')}` });
            }
            continue;
        }
        // eslint-disable-next-line valid-typeof
        if (typeof value !== ps.kind) {
            errors.push({ code: 'TPL_INVALID_PROP', path: `${path}.props.${key}`, message: `must be a ${ps.kind}` });
        }
    }
}

function walk(list: any, path: string, depth: number, state: { blocks: number; slots: number }, errors: TemplateError[]): void {
    if (!Array.isArray(list)) {
        errors.push({ code: 'TPL_INVALID_SHAPE', path, message: 'must be an array of blocks' });
        return;
    }
    if (depth > MAX_DEPTH) {
        errors.push({ code: 'TPL_TOO_DEEP', path, message: `nesting exceeds the maximum depth of ${MAX_DEPTH}` });
        return; // never descend past the cap: recursion is bounded at MAX_DEPTH + 1 frames
    }
    for (let i = 0; i < list.length; i++) {
        const block = list[i];
        const p = `${path}[${i}]`;
        if (++state.blocks > MAX_BLOCKS) {
            errors.push({ code: 'TPL_TOO_MANY_BLOCKS', path: p, message: `template exceeds the ${MAX_BLOCKS}-block budget` });
            return;
        }
        if (!isPlainObject(block)) {
            errors.push({ code: 'TPL_INVALID_SHAPE', path: p, message: 'block must be an object' });
            continue;
        }
        const type = block.type;
        if (typeof type !== 'string' || !type) {
            errors.push({ code: 'TPL_INVALID_SHAPE', path: p, message: 'block needs a string "type"' });
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(FORBIDDEN, type)) {
            errors.push({ code: 'TPL_FORBIDDEN_TYPE', path: p, message: `"${type}" is not allowed in a theme template: ${FORBIDDEN[type]}` });
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(BLOCKS, type)) {
            errors.push({ code: 'TPL_UNKNOWN_TYPE', path: p, message: `"${type}" is not a template block` });
            continue;
        }
        if (type === CONTENT_SLOT) state.slots++;

        const props = block.props === undefined ? {} : block.props;
        if (!isPlainObject(props)) {
            errors.push({ code: 'TPL_INVALID_SHAPE', path: `${p}.props`, message: 'props must be an object' });
            continue;
        }
        checkProps(type, props, p, errors);

        const slotKey = BLOCKS[type].slot;
        const nested = slotKey ? props[slotKey] : undefined;
        if (nested !== undefined) walk(nested, `${p}.props.${slotKey}`, depth + 1, state, errors);
        else if (!slotKey) {
            for (const k of ['items', 'content', 'children']) {
                if (props[k] !== undefined) {
                    errors.push({ code: 'TPL_INVALID_PROP', path: `${p}.props.${k}`, message: `"${type}" is a leaf and nests nothing` });
                }
            }
        }
    }
}

/**
 * Validate a page template. Accepts the parsed object or its raw JSON text.
 * FAIL-CLOSED: any error rejects the WHOLE template, so a page never renders half a layout.
 */
function validateTemplate(input: any): TemplateResult {
    let data: any = input;
    if (typeof input === 'string') {
        if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) {
            return { ok: false, errors: [{ code: 'TPL_TOO_LARGE', path: '$', message: `template is ${Buffer.byteLength(input, 'utf8')} bytes — the budget is ${MAX_BYTES}` }] };
        }
        try { data = JSON.parse(input); } catch (e: any) {
            return { ok: false, errors: [{ code: 'TPL_INVALID_JSON', path: '$', message: `not parseable JSON: ${e.message}` }] };
        }
    } else {
        let text: string;
        try { text = JSON.stringify(data); } catch {
            return { ok: false, errors: [{ code: 'TPL_INVALID_JSON', path: '$', message: 'template is not JSON-serializable' }] };
        }
        if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
            return { ok: false, errors: [{ code: 'TPL_TOO_LARGE', path: '$', message: `template is ${Buffer.byteLength(text, 'utf8')} bytes — the budget is ${MAX_BYTES}` }] };
        }
    }
    if (!isPlainObject(data)) {
        return { ok: false, errors: [{ code: 'TPL_INVALID_SHAPE', path: '$', message: 'template must be an object' }] };
    }

    const errors: TemplateError[] = [];
    const state = { blocks: 0, slots: 0 };
    walk(data.content, '$.content', 1, state, errors);

    // The slot check runs even when the tree had errors: "you also forgot the content hole" is the most
    // useful thing to hear while fixing a template, not a second round-trip.
    if (state.slots === 0) {
        errors.push({ code: 'TPL_SLOT_MISSING', path: '$.content', message: `a template needs exactly one ${CONTENT_SLOT} block — the page's content has nowhere to render without it` });
    } else if (state.slots > 1) {
        errors.push({ code: 'TPL_SLOT_DUPLICATE', path: '$.content', message: `${state.slots} ${CONTENT_SLOT} blocks — the page's content would render more than once, duplicating its headings and ids` });
    }

    return { ok: errors.length === 0, errors };
}

module.exports = {
    validateTemplate,
    CONTENT_SLOT,
    TEMPLATE_BLOCKS: Object.keys(BLOCKS),
    FORBIDDEN_TEMPLATE_BLOCKS: Object.keys(FORBIDDEN),
    TEMPLATE_LIMITS: { MAX_BYTES, MAX_BLOCKS, MAX_DEPTH },
};
