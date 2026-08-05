// Composable-chrome contract v1: parsing, validation and effective-source resolution for the
// site/theme header+footer compositions. Pure logic — NO React, NO fetching — so it runs in RSC,
// in the client editor and under vitest alike.
//
// FORMAT: Puck Data JSON { root: { props: {} }, content: [{ type, props }] }. Nesting ONLY through
// ChromeRow's "items" slot, total depth ≤ 3. Validation is FAIL-CLOSED: any violation (type outside
// the allowlist, bad prop, unsafe href, budget/depth overflow) invalidates the WHOLE composition —
// the caller falls to the next precedence level, never a silent partial render.

export type ChromeBlockType =
    | "ChromeLogo"
    | "ChromeSiteTitle"
    | "ChromeNav"
    | "ChromeSearch"
    | "ChromeSocials"
    | "ChromeText"
    | "ChromeButton"
    | "ChromeSpacer"
    | "ChromeRow";

export interface ChromeBlock {
    type: string;
    props: Record<string, unknown>;
}

export interface ChromeData {
    root: { props?: Record<string, unknown> };
    content: ChromeBlock[];
}

export interface ChromeParseContext {
    // Label prefixed to every error, e.g. "site" / "theme" — purely diagnostic.
    source?: string;
}

export interface ChromeParseResult {
    ok: boolean;
    data?: ChromeData;
    errors: string[];
}

// Resolved data the renderer binds into the blocks (blocks NEVER fetch — the shell fetched already).
export interface ChromeMenuItem {
    id: string | number;
    title: string;
    url: string;
    order?: number;
}

export interface ChromeSocialLink {
    platform?: string;
    url?: string;
    icon?: string;
}

export interface ChromeBindings {
    menus: { header: ChromeMenuItem[]; footer: ChromeMenuItem[] };
    settings: Record<string, any>;
}

// Budgets from the contract: a composition must stay small enough to parse per-request without a thought.
export const CHROME_MAX_BYTES = 64 * 1024;
export const CHROME_MAX_BLOCKS = 100;
export const CHROME_MAX_DEPTH = 3;

// ChromeButton.href: relative path ("/...") or absolute http(s) only. "//host" is protocol-RELATIVE
// (navigates to an external host), so it does NOT count as relative; javascript:, data: and every
// other scheme fail the http(s) test.
export function isSafeChromeHref(href: unknown): href is string {
    if (typeof href !== "string" || href.length === 0) return false;
    if (href.startsWith("//")) return false;
    if (href.startsWith("/")) return true;
    return /^https?:\/\//i.test(href);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(str: string): number {
    return new TextEncoder().encode(str).length;
}

// Per-prop schema: presence + type. `?` in the contract ⇒ optional (absent OK, present must be valid).
interface PropCheck {
    required: boolean;
    ok: (v: unknown) => boolean;
    expected: string;
}

const req = (ok: (v: unknown) => boolean, expected: string): PropCheck => ({ required: true, ok, expected });
const opt = (ok: (v: unknown) => boolean, expected: string): PropCheck => ({ required: false, ok, expected });
const oneOf = (...values: readonly unknown[]) => (v: unknown) => values.includes(v);
const isString = (v: unknown) => typeof v === "string";
const isBoolean = (v: unknown) => typeof v === "boolean";

// The closed allowlist. A `type` not present here invalidates the whole composition (fail-closed).
const BLOCK_SPECS: Record<ChromeBlockType, Record<string, PropCheck>> = {
    ChromeLogo: { size: opt(oneOf("sm", "md", "lg"), "'sm'|'md'|'lg'") },
    ChromeSiteTitle: { showTagline: opt(isBoolean, "boolean") },
    ChromeNav: {
        location: req(oneOf("header", "footer"), "'header'|'footer'"),
        orientation: req(oneOf("horizontal", "vertical"), "'horizontal'|'vertical'"),
    },
    ChromeSearch: { placeholder: opt(isString, "string") },
    ChromeSocials: { source: req(oneOf("settings"), "'settings'") },
    ChromeText: { text: req(isString, "a plain-text string") },
    ChromeButton: {
        label: req(isString, "string"),
        href: req(isSafeChromeHref, "a relative '/…' path or an http(s):// URL"),
        variant: req(oneOf("primary", "ghost"), "'primary'|'ghost'"),
    },
    ChromeSpacer: { size: req(oneOf("sm", "md", "lg"), "'sm'|'md'|'lg'") },
    ChromeRow: {
        items: req(Array.isArray, "an array of blocks"),
        align: req(oneOf("start", "center", "end", "between"), "'start'|'center'|'end'|'between'"),
        gap: req(oneOf("sm", "md", "lg"), "'sm'|'md'|'lg'"),
        wrap: opt(isBoolean, "boolean"),
    },
};

export function parseChromeData(raw: unknown, ctx: ChromeParseContext = {}): ChromeParseResult {
    const where = ctx.source ? `${ctx.source}: ` : "";
    const errors: string[] = [];

    if (raw === null || raw === undefined || raw === "") {
        return { ok: false, errors: [`${where}empty composition`] };
    }

    // Budget FIRST — never JSON.parse an oversized payload.
    let value: unknown = raw;
    if (typeof raw === "string") {
        if (byteLength(raw) > CHROME_MAX_BYTES) {
            return { ok: false, errors: [`${where}composition exceeds ${CHROME_MAX_BYTES} bytes`] };
        }
        try {
            value = JSON.parse(raw);
        } catch {
            return { ok: false, errors: [`${where}invalid JSON`] };
        }
    } else {
        let serialized: string | undefined;
        try {
            serialized = JSON.stringify(raw);
        } catch {
            serialized = undefined;
        }
        if (typeof serialized !== "string") {
            return { ok: false, errors: [`${where}composition is not JSON-serializable`] };
        }
        if (byteLength(serialized) > CHROME_MAX_BYTES) {
            return { ok: false, errors: [`${where}composition exceeds ${CHROME_MAX_BYTES} bytes`] };
        }
    }

    if (!isPlainObject(value)) {
        return { ok: false, errors: [`${where}composition must be a JSON object`] };
    }
    const root = value.root;
    if (!isPlainObject(root) || (root.props !== undefined && !isPlainObject(root.props))) {
        errors.push(`${where}root must be an object with optional props object`);
    }
    const content = value.content;
    if (!Array.isArray(content)) {
        errors.push(`${where}content must be an array of blocks`);
    }
    if (errors.length > 0) return { ok: false, errors };

    let blockCount = 0;
    const visit = (block: unknown, depth: number, path: string): void => {
        blockCount++;
        if (blockCount > CHROME_MAX_BLOCKS) {
            // Report the overflow once; keep counting cheaply without validating further.
            if (blockCount === CHROME_MAX_BLOCKS + 1) {
                errors.push(`${where}composition exceeds ${CHROME_MAX_BLOCKS} blocks`);
            }
            return;
        }
        if (depth > CHROME_MAX_DEPTH) {
            errors.push(`${where}${path}: nesting depth ${depth} exceeds max ${CHROME_MAX_DEPTH}`);
            return;
        }
        if (!isPlainObject(block)) {
            errors.push(`${where}${path}: block must be an object`);
            return;
        }
        const type = block.type;
        // hasOwnProperty, NEVER `in`: `in` walks the prototype chain, so "toString"/"constructor"
        // would slip past the closed allowlist (backend parity vector).
        if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(BLOCK_SPECS, type)) {
            errors.push(`${where}${path}: unknown block type "${String(type)}"`);
            return;
        }
        const spec = BLOCK_SPECS[type as ChromeBlockType];
        const props = block.props === undefined ? {} : block.props;
        if (!isPlainObject(props)) {
            errors.push(`${where}${path}: ${type}.props must be an object`);
            return;
        }
        for (const [key, check] of Object.entries(spec)) {
            const v = props[key];
            if (v === undefined) {
                if (check.required) errors.push(`${where}${path}: ${type}.${key} is required`);
                continue;
            }
            if (!check.ok(v)) errors.push(`${where}${path}: ${type}.${key} must be ${check.expected}`);
        }
        for (const key of Object.keys(props)) {
            if (key === "id") {
                // The editor stamps every block with a string id — allowed everywhere.
                if (typeof props.id !== "string") errors.push(`${where}${path}: ${type}.id must be a string`);
                continue;
            }
            if (!Object.prototype.hasOwnProperty.call(spec, key)) errors.push(`${where}${path}: ${type} has unknown prop "${key}"`);
        }
        if (type === "ChromeRow" && Array.isArray(props.items)) {
            props.items.forEach((child, i) => visit(child, depth + 1, `${path}.items[${i}]`));
        }
    };
    (content as unknown[]).forEach((block, i) => visit(block, 1, `content[${i}]`));

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, data: value as unknown as ChromeData, errors: [] };
}

export interface EffectiveChrome {
    source: "site" | "theme" | null;
    data?: ChromeData;
}

// Precedence levels 1º (site option) → 2º (theme chrome file). Levels 3º (layout v2 variant) and 4º
// (default chrome) stay with the existing shell: it applies them whenever this returns source null.
// Any invalid/unreadable level falls THROUGH to the next without breaking (console.warn only in dev).
export function resolveEffectiveChrome({ siteRaw, themeRaw }: { siteRaw?: unknown; themeRaw?: unknown }): EffectiveChrome {
    if (siteRaw !== null && siteRaw !== undefined && siteRaw !== "") {
        const site = parseChromeData(siteRaw, { source: "site" });
        if (site.ok) return { source: "site", data: site.data };
        warnDev(site.errors);
    }
    if (themeRaw !== null && themeRaw !== undefined && themeRaw !== "") {
        const theme = parseChromeData(themeRaw, { source: "theme" });
        if (theme.ok) return { source: "theme", data: theme.data };
        warnDev(theme.errors);
    }
    return { source: null };
}

function warnDev(errors: string[]): void {
    if (process.env.NODE_ENV !== "production") {
        console.warn(`[chrome] invalid composition — falling back: ${errors.join("; ")}`);
    }
}

// Assembles the renderer bindings from data the shell ALREADY fetched (settings + location menus).
// Pure, so the RSC layout and the editor preview derive them identically and it tests without a DOM.
// null/undefined inputs normalize to empty (a missing menu renders an empty nav, never throws).
export function buildChromeBindings(
    settings: Record<string, any> | null | undefined,
    headerMenu: ChromeMenuItem[] | null | undefined,
    footerMenu: ChromeMenuItem[] | null | undefined,
): ChromeBindings {
    return {
        menus: {
            header: Array.isArray(headerMenu) ? headerMenu : [],
            footer: Array.isArray(footerMenu) ? footerMenu : [],
        },
        settings: isPlainObject(settings) ? settings : {},
    };
}

// settings.footer_socials arrives as a JSON string (option) or an already-parsed array (editor
// preview). Guard the typeof BEFORE JSON.parse — parsing an object throws (layout-v2 lesson).
export function parseChromeSocials(settings: Record<string, any> | undefined | null): ChromeSocialLink[] {
    const raw = settings?.footer_socials;
    if (!raw) return [];
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed.filter((l): l is ChromeSocialLink => isPlainObject(l)) : [];
    } catch {
        return [];
    }
}

// Editor starting points approximating today's "classic" chrome, so authoring starts from the real
// look instead of an empty canvas. Both MUST pass parseChromeData (covered by tests).
export const STARTER_TEMPLATES: { header: ChromeData; footer: ChromeData } = {
    header: {
        root: { props: {} },
        content: [
            {
                type: "ChromeRow",
                props: {
                    align: "between",
                    gap: "md",
                    items: [
                        { type: "ChromeLogo", props: {} },
                        { type: "ChromeNav", props: { location: "header", orientation: "horizontal" } },
                    ],
                },
            },
        ],
    },
    footer: {
        root: { props: {} },
        content: [
            {
                type: "ChromeRow",
                props: {
                    align: "between",
                    gap: "lg",
                    wrap: true,
                    items: [
                        { type: "ChromeSiteTitle", props: { showTagline: true } },
                        { type: "ChromeNav", props: { location: "footer", orientation: "vertical" } },
                        { type: "ChromeSocials", props: { source: "settings" } },
                    ],
                },
            },
        ],
    },
};
