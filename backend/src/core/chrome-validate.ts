/**
 * WordJS - Composable chrome validator (contract v1)
 *
 * AUTHORITY for the composable-chrome contract on the backend: every write path
 * (PUT /api/v1/chrome/:part) and the theme doctor validate a composition here before it is
 * stored or shipped. The frontend renderer keeps an independent mirror of this contract
 * (different package, no shared import) with the SAME error codes — keep both in sync when
 * the contract moves.
 *
 * A composition is Puck Data JSON: { root: { props: {} }, content: [ { type, props } ] }.
 * Nesting happens ONLY through ChromeRow's `items` slot, total depth <= 3. The allowlist is
 * CLOSED and validation is fail-closed: any unknown type, unsafe href or busted budget rejects
 * the WHOLE composition (never a partial render). Unknown top-level keys (e.g. an editor's
 * empty `zones`) are ignored — the renderer never reads them.
 *
 * Error codes (stable contract, mirrored by the frontend validator):
 *   CHROME_INVALID_JSON     raw string is not parseable JSON / object not JSON-serializable
 *   CHROME_TOO_LARGE        serialized composition exceeds the 64KB budget
 *   CHROME_INVALID_SHAPE    structural violation (root/content/block/props shape)
 *   CHROME_UNKNOWN_TYPE     block type outside the closed allowlist
 *   CHROME_MISSING_PROP     required prop absent
 *   CHROME_INVALID_PROP     prop present but wrong type / not in its enum
 *   CHROME_UNKNOWN_PROP     prop key the block's contract does not define
 *   CHROME_UNSAFE_HREF      href neither site-relative ('/', never '//') nor http(s)://
 *   CHROME_TOO_MANY_BLOCKS  more than 100 blocks in the whole composition
 *   CHROME_TOO_DEEP         nesting deeper than 3 levels
 *   CHROME_BLOCK_NOT_IN_PART  a document-scoped block in a NAMED TEMPLATE PART (see POSITION below)
 *
 * Dependency-free (no fs/db/npm) so the doctor and the CLI can load it anywhere.
 */

interface ChromeValidationError {
    code: string;
    path: string;
    message: string;
}

interface ChromeValidationResult {
    ok: boolean;
    errors: ChromeValidationError[];
}

const MAX_BYTES = 64 * 1024;
const MAX_BLOCKS = 100;
const MAX_DEPTH = 3;

type PropKind = 'string' | 'boolean' | 'enum' | 'href' | 'slot';

interface PropSpec {
    kind: PropKind;
    required?: boolean;
    values?: string[]; // enum only
}

// The CLOSED block allowlist. Props not listed here (except the editor's per-instance `id`)
// are rejected — a new prop is a contract change, not a free-for-all.
const BLOCKS: Record<string, Record<string, PropSpec>> = {
    ChromeLogo: {
        size: { kind: 'enum', values: ['sm', 'md', 'lg'] },
    },
    ChromeSiteTitle: {
        showTagline: { kind: 'boolean' },
    },
    ChromeNav: {
        location: { kind: 'enum', values: ['header', 'footer'], required: true },
        orientation: { kind: 'enum', values: ['horizontal', 'vertical'], required: true },
    },
    ChromeSearch: {
        placeholder: { kind: 'string' },
    },
    ChromeSocials: {
        source: { kind: 'enum', values: ['settings'], required: true },
    },
    ChromeText: {
        text: { kind: 'string', required: true }, // plain text — the renderer always escapes it
    },
    ChromeButton: {
        label: { kind: 'string', required: true },
        href: { kind: 'href', required: true },
        variant: { kind: 'enum', values: ['primary', 'ghost'], required: true },
    },
    ChromeSpacer: {
        size: { kind: 'enum', values: ['sm', 'md', 'lg'], required: true },
    },
    ChromeRow: {
        items: { kind: 'slot', required: true },
        align: { kind: 'enum', values: ['start', 'center', 'end', 'between'], required: true },
        gap: { kind: 'enum', values: ['sm', 'md', 'lg'], required: true },
        wrap: { kind: 'boolean' },
    },
};

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * POSITION — the same composition format, two very different render positions.
 *
 * 'chrome'  chrome/header.json and chrome/footer.json. The public layout resolves each ONCE per
 *           document, so a block in this position is guaranteed a single instance.
 * 'part'    a NAMED TEMPLATE PART (theme.json `templateParts`) that a page template pulls in with a
 *           `TemplatePart` block. A template may place N of them, and a page body renders inside
 *           <main> — so a block here has NEITHER a single-instance nor a top-of-document guarantee.
 *
 * Template parts widened chrome from "two files the layout renders once" to "arbitrary files a page
 * body can pull in N times". The blocks were written for the first world. A block that owns
 * DOCUMENT-LEVEL STATE — one global that two instances then fight over — is therefore refused in the
 * 'part' position and still allowed in 'chrome'.
 *
 * THE AUDIT (all nine blocks in frontend/src/components/chrome/, contract v1):
 *   ChromeLogo, ChromeSiteTitle, ChromeSearch, ChromeSocials, ChromeText, ChromeButton, ChromeSpacer
 *   and ChromeRow are presentational server components — no "use client", no hooks, no document or
 *   window access at all. Any number of instances is fine.
 *   ChromeNav is the one exception. Its horizontal/header form mounts the ChromeNavMobile client
 *   island, which portals its overlay to document.body, writes document.body.style.overflow to lock
 *   the page scroll while open, and binds a document-level keydown listener. Two open drawers restore
 *   overflow from each other's saved value, so closing one leaves the page permanently unscrollable.
 *
 * ChromeNav is barred WHOLESALE rather than only in the prop combination that mounts the island. The
 * island is an internal of the block, not part of this contract: pinning the rule to `location` +
 * `orientation` would mean a future change inside ChromeNav silently re-opens the hole with the
 * validator still green. It is also the rule this contract already made once — PARTS_RESERVED_NAME
 * refuses `header`/`footer` as part names because "a template pulling it in would render a second
 * masthead inside <main> — an invalid landmark and a duplicated nav" — and a ChromeNav in a part is
 * that same duplicated site nav by another route.
 *
 * The frontend keeps the mirror of this list in lib/chromeData.ts, and a vitest asserts the set
 * against what the components actually do, so the list cannot quietly drift from the audit above.
 */
const DOCUMENT_SCOPED_BLOCKS: Record<string, string> = {
    ChromeNav: 'it mounts the mobile drawer, which owns document.body scroll-lock, a document keydown '
        + 'listener and a portal into document.body — two instances on one page fight over that single global',
};

/** The two names the public layout resolves itself into a header/footer landmark. Position 'chrome'. */
const CHROME_SITE_PARTS = ['header', 'footer'];

/**
 * The optional announcement/top bar — a THIRD name the public layout resolves itself, rendered
 * full-bleed ABOVE the header when the theme or site ships it, emitting nothing when absent. It is a
 * single-instance site slot exactly like header/footer, but it does NOT get position 'chrome': the
 * header already mounts the one ChromeNav mobile drawer, so a second ChromeNav in the announcement bar
 * would fight over the very body-scroll-lock global the template-part rule bars. Its own position
 * therefore reuses the document-scoped bar (ChromeNav is refused) while staying a resolved site slot.
 */
const ANNOUNCEMENT_PART = 'announcement';

/**
 * Every name the public layout resolves ITSELF (no theme.json `templateParts` declaration needed).
 * These are the names that are NOT template parts — the reserved set validateTemplateParts refuses.
 */
const CHROME_LAYOUT_SLOTS = [...CHROME_SITE_PARTS, ANNOUNCEMENT_PART];

/**
 * Which position a composition is being validated for. DERIVED from the part name, because the name
 * is the only thing that decides it: `header`/`footer` are the site chrome, `announcement` is the top
 * bar, and validateTemplateParts REJECTS all three as template-part names, so no part can ever launder
 * itself into a laxer branch. An absent name is the site chrome — the position PUT /api/v1/chrome/:part
 * writes header/footer with (and 'announcement' when that part is written).
 */
function chromePositionFor(part?: string): 'chrome' | 'part' | 'announcement' {
    if (typeof part !== 'string' || CHROME_SITE_PARTS.includes(part)) return 'chrome';
    if (part === ANNOUNCEMENT_PART) return 'announcement';
    return 'part';
}

const isPlainObject = (v: any): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Allowlist, not denylist: only '/…' (site-relative — '//' is protocol-RELATIVE, i.e. external,
 * so it does not count) and http(s):// pass. javascript:, data:, vbscript:, mailto:, tel:,
 * scheme-smuggling with control characters, … all fall through to rejection by simply never
 * matching.
 */
function isSafeHref(v: string): boolean {
    // A leading '/' followed by another slash OR A BACKSLASH is authority-relative, not site-relative:
    // browsers normalize '\' to '/' while parsing, so '/\evil.example' navigates OFF-SITE exactly like
    // '//evil.example'. Rejecting only '//' left that open-redirect spelling through.
    if (v.startsWith('/')) return !/^\/[/\\]/.test(v);
    return /^https?:\/\//i.test(v);
}

function describeProp(spec: PropSpec): string {
    switch (spec.kind) {
        case 'enum': return `one of ${(spec.values || []).map((v: string) => JSON.stringify(v)).join(', ')}`;
        case 'boolean': return 'a boolean';
        case 'slot': return 'an array of blocks';
        case 'href': return `a site-relative path ('/…') or an http(s):// URL`;
        default: return 'a string';
    }
}

interface WalkState { blocks: number; tooMany: boolean; tooDeep: boolean; position: 'chrome' | 'part' | 'announcement'; }

function validateBlock(node: any, blockPath: string, depth: number, state: WalkState, errors: ChromeValidationError[]): void {
    // Budget caps report ONCE and stop the walk — a hostile 10k-item payload costs O(cap), and
    // past the depth cap we never descend, so recursion is bounded at MAX_DEPTH + 1 frames.
    if (state.blocks >= MAX_BLOCKS) {
        if (!state.tooMany) {
            state.tooMany = true;
            errors.push({ code: 'CHROME_TOO_MANY_BLOCKS', path: blockPath, message: `composition exceeds the ${MAX_BLOCKS}-block budget` });
        }
        return;
    }
    state.blocks++;
    if (depth > MAX_DEPTH) {
        if (!state.tooDeep) {
            state.tooDeep = true;
            errors.push({ code: 'CHROME_TOO_DEEP', path: blockPath, message: `nesting exceeds the maximum depth of ${MAX_DEPTH}` });
        }
        return;
    }

    if (!isPlainObject(node)) {
        errors.push({ code: 'CHROME_INVALID_SHAPE', path: blockPath, message: 'block must be an object { type, props }' });
        return;
    }
    if (typeof node.type !== 'string') {
        errors.push({ code: 'CHROME_INVALID_SHAPE', path: blockPath, message: 'block is missing its "type" string' });
        return;
    }
    const spec = Object.prototype.hasOwnProperty.call(BLOCKS, node.type) ? BLOCKS[node.type] : null;
    if (!spec) {
        errors.push({
            code: 'CHROME_UNKNOWN_TYPE',
            path: blockPath,
            message: `unknown block type "${node.type}" — allowed: ${Object.keys(BLOCKS).join(', ')}`
        });
        return;
    }
    // POSITION gate, at EVERY depth: a barred block is just as document-scoped nested three
    // ChromeRows down as it is at the top level. Rejected here and not merely warned about — the
    // whole point is that the second instance is what breaks, so an author who cannot see it in a
    // preview of one page must be stopped at authoring time.
    if ((state.position === 'part' || state.position === 'announcement')
        && Object.prototype.hasOwnProperty.call(DOCUMENT_SCOPED_BLOCKS, node.type)) {
        const reason = DOCUMENT_SCOPED_BLOCKS[node.type];
        const message = state.position === 'announcement'
            ? `${node.type} may not appear in the site announcement bar: ${reason}. The announcement bar renders once `
                + `above the header — which already mounts the one drawer — so a second ${node.type} would fight over that `
                + `same document.body global. Keep ${node.type} in chrome/header.json or chrome/footer.json.`
            : `${node.type} may not appear in a named template part: ${reason}. `
                + `A template may place the part more than once and it renders inside the page body, so the single `
                + `instance the block assumes is not guaranteed — keep ${node.type} in chrome/header.json or chrome/footer.json.`;
        errors.push({ code: 'CHROME_BLOCK_NOT_IN_PART', path: blockPath, message });
        return;
    }

    const props = node.props === undefined ? {} : node.props;
    if (!isPlainObject(props)) {
        errors.push({ code: 'CHROME_INVALID_SHAPE', path: `${blockPath}.props`, message: '"props" must be an object' });
        return;
    }

    // Unknown keys — the editor's per-instance `id` is the one universal extra.
    for (const key of Object.keys(props)) {
        if (key === 'id') {
            if (typeof props.id !== 'string') {
                errors.push({ code: 'CHROME_INVALID_PROP', path: `${blockPath}.props.id`, message: '"id" must be a string' });
            }
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(spec, key)) {
            errors.push({ code: 'CHROME_UNKNOWN_PROP', path: `${blockPath}.props.${key}`, message: `"${key}" is not a prop of ${node.type}` });
        }
    }

    for (const [key, propSpec] of Object.entries(spec)) {
        const value = props[key];
        const propPath = `${blockPath}.props.${key}`;
        if (value === undefined) {
            if (propSpec.required) {
                errors.push({ code: 'CHROME_MISSING_PROP', path: propPath, message: `${node.type} requires "${key}" (${describeProp(propSpec)})` });
            }
            continue;
        }
        switch (propSpec.kind) {
            case 'string':
                if (typeof value !== 'string') {
                    errors.push({ code: 'CHROME_INVALID_PROP', path: propPath, message: `"${key}" must be a string` });
                }
                break;
            case 'boolean':
                if (typeof value !== 'boolean') {
                    errors.push({ code: 'CHROME_INVALID_PROP', path: propPath, message: `"${key}" must be a boolean` });
                }
                break;
            case 'enum':
                if (typeof value !== 'string' || !(propSpec.values || []).includes(value)) {
                    errors.push({ code: 'CHROME_INVALID_PROP', path: propPath, message: `"${key}" must be ${describeProp(propSpec)} (got ${JSON.stringify(value)})` });
                }
                break;
            case 'href':
                if (typeof value !== 'string' || !isSafeHref(value)) {
                    errors.push({ code: 'CHROME_UNSAFE_HREF', path: propPath, message: `"${key}" must be ${describeProp(propSpec)} — never javascript: or any other scheme` });
                }
                break;
            case 'slot':
                if (!Array.isArray(value)) {
                    errors.push({ code: 'CHROME_INVALID_PROP', path: propPath, message: `"${key}" must be an array of blocks` });
                    break;
                }
                value.forEach((child: any, i: number) => validateBlock(child, `${propPath}[${i}]`, depth + 1, state, errors));
                break;
        }
    }
}

/**
 * Validate a chrome composition against contract v1. `raw` accepts BOTH storage forms — the
 * JSON string (option value / chrome/*.json file) and the already-parsed object (API body) —
 * because a validator that only takes one shape invites the classic JSON.parse(object) bug.
 * The 64KB budget is measured on the serialized bytes either way.
 *
 * `opts.part` is the composition's NAME. It selects the POSITION (see chromePositionFor): 'header'
 * and 'footer' are the site chrome the layout renders once, and any other name is a named template
 * part a page body may pull in N times — which is what bars the document-scoped blocks. Passing no
 * name means the site chrome, the only position the write API can reach.
 */
function validateChromeData(raw: any, opts: { part?: string } = {}): ChromeValidationResult {
    const position = chromePositionFor(opts.part);
    const errors: ChromeValidationError[] = [];

    let text: string | undefined;
    let data: any;
    if (typeof raw === 'string') {
        text = raw;
        if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
            return { ok: false, errors: [{ code: 'CHROME_TOO_LARGE', path: '$', message: `composition is ${Buffer.byteLength(text, 'utf8')} bytes — the budget is ${MAX_BYTES} (64KB)` }] };
        }
        try {
            data = JSON.parse(text);
        } catch (e: any) {
            return { ok: false, errors: [{ code: 'CHROME_INVALID_JSON', path: '$', message: `not valid JSON: ${e.message}` }] };
        }
    } else {
        try {
            text = JSON.stringify(raw); // undefined for raw === undefined — caught by the shape check below
        } catch {
            return { ok: false, errors: [{ code: 'CHROME_INVALID_JSON', path: '$', message: 'composition is not JSON-serializable' }] };
        }
        if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
            return { ok: false, errors: [{ code: 'CHROME_TOO_LARGE', path: '$', message: `composition is ${Buffer.byteLength(text, 'utf8')} bytes — the budget is ${MAX_BYTES} (64KB)` }] };
        }
        data = raw;
    }

    if (!isPlainObject(data)) {
        return { ok: false, errors: [{ code: 'CHROME_INVALID_SHAPE', path: '$', message: 'composition must be an object { root, content }' }] };
    }
    // `root` is REQUIRED by the format (Puck Data always carries one) — the frontend renderer
    // rejects a root-less composition, so accepting it here would store data that silently
    // falls back at render time (parity vector: frontend and backend must agree).
    if (!isPlainObject(data.root)) {
        errors.push({ code: 'CHROME_INVALID_SHAPE', path: 'root', message: '"root" must be an object' });
    } else if (data.root.props !== undefined && !isPlainObject(data.root.props)) {
        errors.push({ code: 'CHROME_INVALID_SHAPE', path: 'root.props', message: '"root.props" must be an object' });
    }
    if (!Array.isArray(data.content)) {
        errors.push({ code: 'CHROME_INVALID_SHAPE', path: 'content', message: '"content" must be an array of blocks' });
        return { ok: false, errors };
    }

    const state: WalkState = { blocks: 0, tooMany: false, tooDeep: false, position };
    data.content.forEach((node: any, i: number) => validateBlock(node, `content[${i}]`, 1, state, errors));

    return { ok: errors.length === 0, errors };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * NAMED TEMPLATE PARTS — theme.json `templateParts`
 *
 * Until now a theme could ship exactly two compositions, because the public layout asked for exactly
 * two names: chrome/header.json and chrome/footer.json. `templateParts` is the declaration that lets a
 * theme ship MORE of them and have a page template pull one in (the `TemplatePart` block in
 * core/template-validate.ts).
 *
 * ADAPTED FROM WORDPRESS, whose theme.json declares `templateParts: [{ name, title, area }]` with
 * `area` a small closed enum. We keep the shape and drop `title`: nothing in this system would render
 * it, and a declared field no consumer honours is the exact failure this contract exists to prevent.
 * `area` stays because it IS consumed — the renderer picks the part's wrapper element from it.
 *
 * THE NAME IS THE FILE NAME, so it is the same shape a template name must have — the very pattern
 * frontend/src/lib/server-api.ts guards before a name reaches a URL. Keep the two identical: this is
 * what stops a declaration from ever becoming a path.
 *
 * `header`, `footer` and `announcement` are REJECTED as part names. Those files are the site's chrome,
 * resolved by the public layout on every page; letting a template pull one in would render a second
 * masthead (or a second announcement bar) inside <main> — a duplicated landmark from a declaration
 * that looked harmless. The reserved set is exactly CHROME_LAYOUT_SLOTS — the names the layout owns.
 *
 * Error codes (stable contract):
 *   PARTS_INVALID_SHAPE   not an array / an entry that is not an object
 *   PARTS_UNKNOWN_KEY     a key outside { name, area }
 *   PARTS_INVALID_NAME    missing name, or one outside ^[a-z0-9-]{1,40}$
 *   PARTS_RESERVED_NAME   "header" / "footer" — the site chrome, not a template part
 *   PARTS_DUPLICATE_NAME  the same name declared twice
 *   PARTS_INVALID_AREA    missing area, or one outside the enum
 *   PARTS_TOO_MANY        more than 16 declared parts
 */
const TEMPLATE_PART_AREAS = ['header', 'footer', 'sidebar', 'general'];
/** Identical to the template-name guard in frontend/src/lib/server-api.ts — a name becomes a URL. */
const TEMPLATE_PART_NAME = /^[a-z0-9-]{1,40}$/;
const TEMPLATE_PART_RESERVED = CHROME_LAYOUT_SLOTS.slice();
const MAX_TEMPLATE_PARTS = 16;
const TEMPLATE_PART_KEYS = ['name', 'area'];

/**
 * Validate a theme.json `templateParts` declaration. FAIL-CLOSED as a WHOLE: the renderer's mirror
 * drops every part when the declaration is invalid, so a single bad entry disables the lot rather
 * than half-loading a theme's parts. Returns { ok, errors, parts } — `parts` is the normalized
 * [{ name, area }] list, empty whenever ok is false.
 */
function validateTemplateParts(decl: any): { ok: boolean; errors: ChromeValidationError[]; parts: { name: string; area: string }[] } {
    const errors: ChromeValidationError[] = [];
    if (!Array.isArray(decl)) {
        return { ok: false, errors: [{ code: 'PARTS_INVALID_SHAPE', path: 'templateParts', message: '"templateParts" must be an array of { name, area }' }], parts: [] };
    }
    if (decl.length > MAX_TEMPLATE_PARTS) {
        errors.push({ code: 'PARTS_TOO_MANY', path: 'templateParts', message: `${decl.length} parts declared — the budget is ${MAX_TEMPLATE_PARTS}` });
    }
    const parts: { name: string; area: string }[] = [];
    const seen = new Set<string>();
    decl.forEach((entry: any, i: number) => {
        const p = `templateParts[${i}]`;
        if (!isPlainObject(entry)) {
            errors.push({ code: 'PARTS_INVALID_SHAPE', path: p, message: 'a template part must be an object { name, area }' });
            return;
        }
        for (const key of Object.keys(entry)) {
            if (!TEMPLATE_PART_KEYS.includes(key)) {
                errors.push({ code: 'PARTS_UNKNOWN_KEY', path: `${p}.${key}`, message: `"${key}" is not a template-part key — allowed: ${TEMPLATE_PART_KEYS.join(', ')}` });
            }
        }
        const name = entry.name;
        const area = entry.area;
        let nameOk = true;
        if (typeof name !== 'string' || !TEMPLATE_PART_NAME.test(name)) {
            errors.push({ code: 'PARTS_INVALID_NAME', path: `${p}.name`, message: `"name" must match ${TEMPLATE_PART_NAME.source} — it is the chrome/<name>.json file name` });
            nameOk = false;
        } else if (TEMPLATE_PART_RESERVED.includes(name)) {
            errors.push({ code: 'PARTS_RESERVED_NAME', path: `${p}.name`, message: `"${name}" is the site chrome (chrome/${name}.json), not a template part — a template pulling it in would render a second ${name} inside the page` });
            nameOk = false;
        } else if (seen.has(name)) {
            errors.push({ code: 'PARTS_DUPLICATE_NAME', path: `${p}.name`, message: `"${name}" is declared more than once` });
            nameOk = false;
        }
        if (typeof area !== 'string' || !TEMPLATE_PART_AREAS.includes(area)) {
            errors.push({ code: 'PARTS_INVALID_AREA', path: `${p}.area`, message: `"area" must be one of: ${TEMPLATE_PART_AREAS.join(', ')}` });
            nameOk = false;
        }
        if (nameOk) { seen.add(name); parts.push({ name, area }); }
    });
    const ok = errors.length === 0;
    return { ok, errors, parts: ok ? parts : [] };
}

module.exports = {
    validateChromeData,
    CHROME_MAX_BYTES: MAX_BYTES,
    CHROME_MAX_BLOCKS: MAX_BLOCKS,
    CHROME_MAX_DEPTH: MAX_DEPTH,
    CHROME_BLOCK_TYPES: Object.keys(BLOCKS),
    CHROME_SITE_PARTS: CHROME_SITE_PARTS.slice(),
    CHROME_DOCUMENT_SCOPED_BLOCKS: Object.keys(DOCUMENT_SCOPED_BLOCKS),
    CHROME_LAYOUT_SLOTS: CHROME_LAYOUT_SLOTS.slice(),
    CHROME_ANNOUNCEMENT_PART: ANNOUNCEMENT_PART,
    chromePositionFor,
    validateTemplateParts,
    TEMPLATE_PART_AREAS: TEMPLATE_PART_AREAS.slice(),
    TEMPLATE_PART_NAME,
    TEMPLATE_PART_RESERVED: TEMPLATE_PART_RESERVED.slice(),
    MAX_TEMPLATE_PARTS,
};
