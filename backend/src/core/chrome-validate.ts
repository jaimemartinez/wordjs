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

interface WalkState { blocks: number; tooMany: boolean; tooDeep: boolean; }

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
 * `opts.part` ('header' | 'footer') is reserved for part-specific rules; v1 validates both
 * parts identically.
 */
function validateChromeData(raw: any, opts: { part?: string } = {}): ChromeValidationResult {
    void opts;
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

    const state: WalkState = { blocks: 0, tooMany: false, tooDeep: false };
    data.content.forEach((node: any, i: number) => validateBlock(node, `content[${i}]`, 1, state, errors));

    return { ok: errors.length === 0, errors };
}

module.exports = {
    validateChromeData,
    CHROME_MAX_BYTES: MAX_BYTES,
    CHROME_MAX_BLOCKS: MAX_BLOCKS,
    CHROME_MAX_DEPTH: MAX_DEPTH,
    CHROME_BLOCK_TYPES: Object.keys(BLOCKS),
};
