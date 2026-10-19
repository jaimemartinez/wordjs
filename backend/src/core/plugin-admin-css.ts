/**
 * WordJS — A PLUGIN'S ADMIN STYLESHEET, CONFINED BEFORE THE ADMIN LINKS IT.
 *
 * The generated plugin admin page (/admin/plugin/<slug>) links plugins/<folder>/client/admin/admin.css as
 * a full-page stylesheet: it applies to the whole admin document, the shell around the plugin included.
 * Served verbatim, that file could restyle the host's own UI on that page (hide or relabel the sidebar,
 * paint over a confirmation dialog) and — through url() / @import — make the administrator's browser
 * fetch other hosts, with attribute selectors turning the fetch into a read of what is on the page. It is
 * plugin-authored build output the AST scanner never reads, so the host confines it here:
 *
 *   1. NOTHING IS FETCHED. @import, @namespace and @charset are dropped, and so is every declaration whose
 *      value would load something — url() / src() / image() / image-set() / cross-fade() — unless it is
 *      a `data:` URL, which loads nothing. The value is checked TOKEN BY TOKEN after the tokenizer has
 *      decoded escapes (`u\72 l(`), and custom-property values (kept raw by the parser) are tokenized the
 *      same way, so a value parked in `--x` and used through var() is caught where it is declared.
 *   2. IT STOPS SHORT OF HOST UI. Every style rule is wrapped in `@scope (:root) to ([data-wjs-host-ui])`:
 *      it still reaches the plugin's page and the overlays it portals to <body> (the reason the compiled
 *      sheet was left unprefixed — backend/scripts/plugin-stylesheet.js), but not the admin chrome, the
 *      host's confirmation dialogs or its toasts, which carry that attribute. Rules that cannot live inside
 *      @scope (@keyframes, @font-face, @property, …) stay where they were; layer blocks keep their layer
 *      (the sheet's own `@layer utilities { @layer wjs-plugin { … } }` ordering is unchanged) and get the
 *      scope inside. A selector that starts at `:root` / `html` is re-anchored on `:scope`, which is the
 *      same element: inside @scope a bare `:root` would no longer match it.
 *
 * The output is re-serialized from the AST (css-tree), so nothing the parser did not understand survives
 * as text. Pure: a string in, a string out — routes/plugin-bundles.ts caches it per file version.
 */

const csstree = require('css-tree');

/** The attribute the admin's own UI carries (frontend: Sidebar, admin header, ConfirmationModal, toasts). */
const HOST_UI_ATTRIBUTE = 'data-wjs-host-ui';
const SCOPE_PRELUDE = `(:root) to ([${HOST_UI_ATTRIBUTE}])`;

/** Hard cap on what is parsed at all (a compiled Tailwind sheet is tens of KB). */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

// At-rules that load another resource, or change how the rest of the sheet is read.
const DROPPED_AT_RULES = new Set(['import', 'namespace', 'charset']);
// At-rules that are not allowed inside @scope (only style rules and conditional group rules are); kept
// in place, outside the scope. None of them selects elements, so none can reach host UI.
const UNSCOPED_AT_RULES = new Set([
    'keyframes', '-webkit-keyframes', '-moz-keyframes', 'font-face', 'property', 'counter-style',
    'font-feature-values', 'font-palette-values', 'page', 'view-transition',
]);
// Functions whose arguments are fetched (strings in image-set()/image() are URLs too).
const FETCHING_FUNCTIONS = new Set(['url', 'src', 'image', 'image-set', '-webkit-image-set', 'cross-fade', '-webkit-cross-fade']);

const isDataUrl = (value: string): boolean => /^\s*data:/i.test(value);

/** Does this CSS text (a declaration value) load anything when applied? Decided on decoded tokens. */
function valueFetches(text: string): boolean {
    let fetches = false;
    let pendingUrlFunction = false;
    const types = csstree.tokenTypes;
    csstree.tokenize(text, (type: number, start: number, end: number) => {
        if (fetches) return;
        const token = text.slice(start, end);
        if (type === types.Url) {
            if (!isDataUrl(csstree.url.decode(token))) fetches = true;
        } else if (type === types.BadUrl) {
            fetches = true;
        } else if (type === types.Function) {
            const name = csstree.ident.decode(token.slice(0, -1)).toLowerCase();
            if (name === 'url') pendingUrlFunction = true;
            else if (FETCHING_FUNCTIONS.has(name)) fetches = true;
        } else if (pendingUrlFunction && type === types.String) {
            if (!isDataUrl(csstree.string.decode(token))) fetches = true;
            pendingUrlFunction = false;
        } else if (pendingUrlFunction && type !== types.WhiteSpace) {
            // url( followed by anything but a string (e.g. var()): not a URL we can prove inert.
            fetches = true;
        }
    });
    return fetches;
}

/** The at-rule's name as the browser reads it — escapes decoded (an escaped `@import` IS @import). */
function atRuleName(node: any): string {
    return csstree.ident.decode(String(node && node.name ? node.name : '')).toLowerCase();
}

/** Drop fetching declarations and dropped at-rules anywhere in the tree (in place). */
function stripFetches(ast: any): void {
    csstree.walk(ast, {
        visit: 'Declaration',
        enter(node: any, item: any, list: any) {
            if (list && valueFetches(csstree.generate(node.value))) list.remove(item);
        },
    });
    csstree.walk(ast, {
        visit: 'Atrule',
        enter(node: any, item: any, list: any) {
            if (list && DROPPED_AT_RULES.has(atRuleName(node))) list.remove(item);
        },
    });
}

/** Re-anchor a selector that starts at the document root on `:scope` (the same element, inside @scope). */
function anchorRootSelectors(rule: any): void {
    if (!rule || !rule.prelude || rule.prelude.type !== 'SelectorList') return;
    rule.prelude.children.forEach((selector: any) => {
        const first = selector && selector.children && selector.children.first;
        if (!first) return;
        const isRoot = (first.type === 'PseudoClassSelector' && String(first.name).toLowerCase() === 'root')
            || (first.type === 'TypeSelector' && String(first.name).toLowerCase() === 'html');
        if (isRoot) selector.children.replace(selector.children.head, selector.children.createItem({ type: 'PseudoClassSelector', name: 'scope', children: null }));
    });
}

function scopeBlock(children: any[]): any {
    for (const child of children) {
        csstree.walk(child, { visit: 'Rule', enter: anchorRootSelectors });
    }
    return {
        type: 'Atrule',
        name: 'scope',
        prelude: { type: 'Raw', value: SCOPE_PRELUDE },
        block: { type: 'Block', children: new csstree.List().fromArray(children) },
    };
}

/** Rebuild a list of rules with every element-selecting part inside @scope. */
function confineList(list: any): any {
    const out: any[] = [];
    let pending: any[] = [];
    const flush = () => {
        if (pending.length) out.push(scopeBlock(pending));
        pending = [];
    };
    list.forEach((node: any) => {
        if (node.type === 'Atrule') {
            const name = atRuleName(node);
            if (UNSCOPED_AT_RULES.has(name)) { flush(); out.push(node); return; }
            if (name === 'layer') {
                flush();
                // `@layer a, b;` (no block) only orders layers; a layer BLOCK keeps its layer outermost.
                if (node.block) node.block.children = confineList(node.block.children);
                out.push(node);
                return;
            }
        }
        pending.push(node);
    });
    flush();
    return new csstree.List().fromArray(out);
}

/**
 * The confined stylesheet: nothing that fetches, and every rule scoped away from host UI. Throws only for
 * input over the size cap; anything css-tree cannot parse is dropped by its tolerant parser.
 */
function confinePluginAdminCss(source: string): string {
    const text = String(source == null ? '' : source);
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) throw new Error('plugin admin stylesheet is too large');
    const ast = csstree.parse(text, { parseCustomProperty: false, parseValue: true });
    stripFetches(ast);
    ast.children = confineList(ast.children);
    return csstree.generate(ast);
}

module.exports = { confinePluginAdminCss, valueFetches, HOST_UI_ATTRIBUTE, SCOPE_PRELUDE, MAX_SOURCE_BYTES };
