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
 *
 * `classlist` is the one shape-checked string: a class name is not a primitive we can leave open,
 * because the value lands in an attribute. See CLASS_TOKEN below.
 */
type PropSpec =
    | { kind: 'string' | 'number' | 'boolean' }
    | { kind: 'enum'; values: string[] }
    | { kind: 'classlist' };

const LEN = { kind: 'string' } as const;
const NUM = { kind: 'number' } as const;
const BOOL = { kind: 'boolean' } as const;
const en = (...values: string[]): PropSpec => ({ kind: 'enum', values });

/**
 * THE WRAPPER AFFORDANCE, borrowed from Shopify and cut down to this contract's grammar.
 *
 * A Shopify section's `{% schema %}` may declare `tag` and `class`: `tag` picks the wrapper's element
 * NAME from a closed list of six, and `class` is APPENDED to the wrapper class Shopify itself emits.
 * That is safe for exactly the reason this whole file is safe — the theme chooses from a set the
 * platform owns and never supplies structure, and appending means the framework's own hook survives.
 * Without it every Section a theme places is indistinguishable from every other, so a theme cannot even
 * mark one as its hero.
 *
 * TAGS is Shopify's six verbatim. `main` is deliberately NOT here: the public layout already emits
 * `<main id="main-content">` (frontend/src/components/public/PublicLayoutShell.tsx) and a template
 * renders INSIDE it, so allowing `main` would let a well-meaning theme nest a second one — an invalid
 * landmark and a screen-reader regression, from a prop that looked like good semantics.
 *
 * Both props are CONTAINERS-ONLY (Section, Grid, FlexRow, Columns). A Spacer or a Divider has no
 * content to label and no wrapper worth naming, and PageContent is a hole, not an element.
 */
const TAGS = ['article', 'aside', 'div', 'footer', 'header', 'section'];

/**
 * A single class name: lower-case, starts with a letter, then letters/digits/hyphens, 40 chars max.
 * Deliberately narrower than what CSS permits. It cannot carry a space, a quote, a bracket, a dot, a
 * colon or a slash, so nothing written here can close the attribute, name a second selector, or read
 * as anything but a class — and REJECTION, not sanitizing, is the response to a value that tries. A
 * sanitizer turns an attack into a silently-different class name; a rejection tells the theme author.
 *
 * NOTE for anyone porting this: `$` in a JavaScript regex without the `m` flag matches END OF INPUT
 * only (unlike Perl/Python, where it also matches before a trailing newline). The whitespace check in
 * classListOk covers that anyway, belt and braces.
 */
const CLASS_TOKEN = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_CLASS_TOKENS = 3;

/**
 * Space-separated, at most MAX_CLASS_TOKENS. Split on a single space rather than /\s+/ on purpose: a
 * double space, a tab or a newline then yields a token the pattern refuses, instead of being quietly
 * normalised away.
 */
function classListOk(value: any): boolean {
    if (typeof value !== 'string') return false;
    if (value === '' || value !== value.trim()) return false; // an empty/padded class is a no-op prop
    const tokens = value.split(' ');
    if (tokens.length > MAX_CLASS_TOKENS) return false;
    return tokens.every((t) => CLASS_TOKEN.test(t));
}

/** The wrapper props every CONTAINER block carries. Spread into each container's prop table below. */
const TAG = en(...TAGS);
const CLASSNAME = { kind: 'classlist' } as const;

/**
 * CLOSED allowlist. A template is STRUCTURE plus the dynamic blocks that derive their content from
 * the site, so this is deliberately narrower than the 30 types the page renderer knows.
 *
 * `slot` names the child list a block may nest, or null for a leaf.
 */
const BLOCKS: Record<string, { props: Record<string, PropSpec>; slot: string | null }> = {
    [CONTENT_SLOT]: { props: {}, slot: null },

    // Layout. `tag` + `className` are the container affordance — see TAGS/CLASS_TOKEN above.
    Section: { props: { background: LEN, padding: LEN, maxWidth: LEN, tag: TAG, className: CLASSNAME }, slot: 'items' },
    Grid: { props: { columns: NUM, gap: LEN, columnsTablet: NUM, columnsMobile: NUM, tag: TAG, className: CLASSNAME }, slot: 'items' },
    FlexRow: { props: { gap: LEN, align: en('start', 'center', 'end', 'stretch'), justify: en('start', 'center', 'end', 'between', 'around'), wrap: BOOL, direction: en('row', 'column', 'row-reverse', 'column-reverse'), tag: TAG, className: CLASSNAME }, slot: 'items' },
    Columns: { props: { columns: NUM, gap: LEN, tag: TAG, className: CLASSNAME }, slot: 'items' },
    Spacer: { props: { height: LEN }, slot: null },
    Divider: { props: { color: LEN, width: LEN, length: LEN, gap: LEN }, slot: null },

    // DYNAMIC — the query loop. These derive their content from the SITE, so they may appear only now
    // that a template has a data path (frontend/src/lib/resolveTemplateBlocks.ts) and the route hands them its own
    // posts. Every prop below is one the block actually honours; `count` is consumed by the resolver.
    PostsGrid: { props: { count: NUM, columns: NUM, gap: LEN, bg: LEN, borderColor: LEN, radius: LEN, pad: LEN, thumbHeight: LEN }, slot: null },
    CategoryPosts: { props: { count: NUM, categorySlug: LEN, layout: en('grid', 'list'), columns: NUM, gap: LEN, bg: LEN, borderColor: LEN, radius: LEN, linkColor: LEN, headingColor: LEN }, slot: null },
    SearchBar: { props: { placeholder: LEN, buttonText: LEN, align: en('left', 'center', 'right'), width: LEN, inputBg: LEN, inputBorderColor: LEN, inputRadius: LEN, buttonBg: LEN, buttonColor: LEN, buttonRadius: LEN }, slot: null },
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
        if (ps.kind === 'classlist') {
            if (!classListOk(value)) {
                errors.push({ code: 'TPL_INVALID_PROP', path: `${path}.props.${key}`, message: `must be up to ${MAX_CLASS_TOKENS} space-separated class names, each matching ${CLASS_TOKEN.source} — it is APPENDED to the block's own classes, never a replacement` });
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
    /** The container wrapper affordance, exported so the doctor and the tests read the real set. */
    TEMPLATE_TAGS: TAGS.slice(),
    TEMPLATE_CLASS: { TOKEN: CLASS_TOKEN, MAX_TOKENS: MAX_CLASS_TOKENS },
};
