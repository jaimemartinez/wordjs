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

// POSITION — MIRRORS DOCUMENT_SCOPED_BLOCKS / chromePositionFor in backend/src/core/chrome-validate.ts
// (the authority; read the long comment there for the audit of all nine blocks).
//
// "chrome" is chrome/header.json + chrome/footer.json: the layout resolves each ONCE per document.
// "part" is a NAMED TEMPLATE PART a page template pulls in — a page body may hold N of them. A block
// that owns document-level state has no single-instance guarantee there, so it is refused.
//
// ChromeNav is the only one: its header/horizontal form mounts ChromeNavMobile, which portals into
// document.body, writes document.body.style.overflow to lock page scroll, and binds a document
// keydown listener. Two drawers restore overflow from each other's saved value and the page ends up
// permanently unscrollable. Barred wholesale, not only for the prop pair that mounts the island —
// which prop combination reaches the island is an internal of the block, not part of this contract.
export const CHROME_DOCUMENT_SCOPED_BLOCKS: readonly ChromeBlockType[] = ["ChromeNav"];

// "announcement" is the optional top bar the public layout resolves into a full-bleed band ABOVE the
// header. It is a single-instance site slot like the header/footer, but it still bars the
// document-scoped blocks: the header already mounts the one ChromeNav mobile drawer, so a ChromeNav in
// the announcement bar would be a SECOND owner of the body-scroll-lock global — the very failure the
// template-part position exists to stop. Mirrors chrome-validate's ANNOUNCEMENT_PART position.
export type ChromePosition = "chrome" | "part" | "announcement";

export interface ChromeParseContext {
    // Label prefixed to every error, e.g. "site" / "theme" — purely diagnostic.
    source?: string;
    // Where this composition will render. Defaults to "chrome" (the site header/footer), the only
    // position the write API can reach; the template-part resolver passes "part" and the announcement
    // bar passes "announcement" explicitly.
    position?: ChromePosition;
}

export interface ChromeParseResult {
    ok: boolean;
    data?: ChromeData;
    errors: string[];
}

// Resolved data the renderer binds into the blocks (blocks NEVER fetch — the shell fetched already).
// `parent` is the flat form the menu API returns (post_parent / _menu_item_menu_item_parent); the
// renderer never reads it directly — buildMenuTree consumes it to produce `children`, and ChromeNav
// renders that nesting. `children` is the nested form; absent/empty ⇒ a leaf, rendered exactly as a
// flat item was before submenus existed.
export interface ChromeMenuItem {
    id: string | number;
    title: string;
    url: string;
    order?: number;
    parent?: string | number;
    children?: ChromeMenuItem[];
    // Author data (server default '_self'). NEVER rendered raw: every consumer must pass it through
    // menuTargetRel, which whitelists _self|_blank and forces rel on _blank. Threaded by
    // buildMenuTree so tree consumers (the mobile drawer) see the same value the flat list carries.
    target?: string;
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

// Tabulador, salto de linea y retorno de carro: los tres caracteres que el parser de URL del
// navegador BORRA de la cadena ANTES de parsearla (WHATWG URL, "remove all ASCII tab or newline").
// Validar la cadena CRUDA es por tanto validar algo que el navegador nunca llega a ver.
const URL_STRIPPED_CONTROLS = /[\t\n\r]/g;

// ChromeButton.href: ruta relativa ("/...") o http(s) absoluta, nada mas. "//host" es
// protocolo-RELATIVA (navega a un host externo), asi que NO cuenta como relativa; javascript:,
// data: y cualquier otro esquema fallan el test de http(s).
//
// RESOLVER, no predicado: devuelve el valor LIMPIO que debe llegar al atributo, porque validar una
// cadena y pintar OTRA es justamente el hueco. "/\t/evil.example" empieza por "/" y su segundo
// caracter no es "/" ni "\", asi que pasaba el chequeo — pero el navegador borra el tabulador y
// acaba resolviendo https://evil.example/ (open redirect almacenado). Se limpia ANTES de decidir,
// exactamente lo que borra el parser, para que lo validado sea lo que el navegador vera.
// Espejado en backend/src/core/chrome-validate.ts (isSafeHref).
export function safeChromeHref(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const href = raw.replace(URL_STRIPPED_CONTROLS, "");
    // La limpieza puede vaciar la cadena ("\t\n" era todo control): un href vacio no es navegable.
    if (href.length === 0) return undefined;
    // '\' cuenta como '/' al parsear, asi que '/\evil.example' es authority-relative igual que
    // '//evil.example' y navega fuera del sitio. Se rechazan ambas grafias.
    if (/^\/[/\\]/.test(href)) return undefined;
    if (href.startsWith("/")) return href;
    return /^https?:\/\//i.test(href) ? href : undefined;
}

// Envoltorio fino para los consumidores que solo necesitan el si/no (el spec de props de abajo).
// Quien vaya a PINTAR el valor debe usar safeChromeHref y pintar SU retorno, no la cadena cruda.
export function isSafeChromeHref(href: unknown): href is string {
    return safeChromeHref(href) !== undefined;
}

// ── Menu-item render guards ──────────────────────────────────────────────────────────────────────
// Shared by EVERY surface that paints a bound menu item: the NavMenu/MegaMenu desktop <a>s
// (blocks.tsx) AND the mobile drawer (ChromeNavMobile). They live HERE — not in blocks.tsx — because
// blocks.tsx imports ChromeNavMobile, so a helper in blocks.tsx could never be imported back by the
// drawer without a cycle. Mirrors backend routes/menus.ts safeMenuUrl's allow-list so a stale or
// hand-edited value can never emit a javascript:/data:/vbscript: href (defence in depth: menu urls
// are sanitized on write, and re-validated at EVERY render).
//
// Unlike safeChromeHref above (chrome buttons: path or http(s), else the link disappears), a menu
// item may also be a fragment/query or a mailto:/tel: link, and an invalid value collapses to '#'
// (an inert href) instead of vanishing — a menu item must keep its label. The WHATWG-stripped
// controls (tab/LF/CR) are removed FIRST so the validated string is the one the browser will parse.
const MENU_SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
export function safeMenuHref(raw: unknown): string {
    if (typeof raw !== "string") return "#";
    const value = raw.replace(URL_STRIPPED_CONTROLS, "").trim();
    if (!value) return "#";
    if (/^\/[/\\]/.test(value)) return "#"; // authority-relative //host or /\host → external
    if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) return value;
    try {
        if (MENU_SAFE_SCHEMES.has(new URL(value).protocol)) return value;
    } catch { /* not absolute, not a recognized relative form */ }
    return "#";
}

// target is author data → whitelist to the two valid values; _blank forces rel so the opened tab
// cannot reach window.opener (reverse-tabnabbing). Anything else coerces to _self.
export function menuTargetRel(target: unknown): { target: "_self" | "_blank"; rel?: string } {
    return target === "_blank"
        ? { target: "_blank", rel: "noopener noreferrer" }
        : { target: "_self" };
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
    const position: ChromePosition = ctx.position === "part" || ctx.position === "announcement" ? ctx.position : "chrome";
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
        // Position gate at EVERY depth — a barred block is just as document-scoped three ChromeRows
        // down. Fail-closed like every other violation here: the whole part falls back to nothing
        // rather than render a second scroll-lock owner into the page.
        if ((position === "part" || position === "announcement") && (CHROME_DOCUMENT_SCOPED_BLOCKS as readonly string[]).includes(type)) {
            const scope = position === "announcement"
                ? `the site announcement bar — the header already mounts the one drawer, so a second ${type} would fight over that global`
                : `a named template part — a page may render the part more than once`;
            errors.push(`${where}${path}: ${type} may not appear in ${scope}; it owns document-level state (body scroll-lock, a document keydown listener and a portal into document.body)`);
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
// `position` selects the validation branch: header/footer omit it ("chrome"), the announcement bar
// passes "announcement" so both its precedence levels are checked against the document-scoped bar.
export function resolveEffectiveChrome(
    { siteRaw, themeRaw, position }: { siteRaw?: unknown; themeRaw?: unknown; position?: ChromePosition },
): EffectiveChrome {
    if (siteRaw !== null && siteRaw !== undefined && siteRaw !== "") {
        const site = parseChromeData(siteRaw, { source: "site", position });
        if (site.ok) return { source: "site", data: site.data };
        warnDev(site.errors);
    }
    if (themeRaw !== null && themeRaw !== undefined && themeRaw !== "") {
        const theme = parseChromeData(themeRaw, { source: "theme", position });
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

// Nest a FLAT location menu (each item carrying a `parent` id) into a tree ChromeNav can render as
// submenus. The menu model already stores the hierarchy (post_parent); the location API returns it
// flat, so this is where "the model has parents" becomes "the nav has submenus". Pure and DOM-free so
// ChromeNav (server) and the tests derive the same shape.
//
// A LEAF STAYS A LEAF: an item with no children gets `children: []`, and ChromeNav renders a menu with
// zero submenus byte-for-byte as it did before this existed — the flat path is unchanged.
//
// DEFENSIVE against malformed parent chains (a self-parent, a 2-cycle, a parent id that names no item):
// such nodes are treated as roots or dropped, never followed into an infinite render. parent 0 / null /
// undefined all mean "top level" (the model's convention: post_parent 0 is a root item).
export function buildMenuTree(items: ChromeMenuItem[] | null | undefined): ChromeMenuItem[] {
    if (!Array.isArray(items)) return [];
    type Node = ChromeMenuItem & { children: ChromeMenuItem[] };
    const byId = new Map<string, Node>();
    // First pass: one fresh node per item (drop entries with no usable id — they can anchor nothing).
    for (const it of items) {
        if (!isPlainObject(it) || it.id === undefined || it.id === null) continue;
        const node: Node = { id: it.id, title: it.title, url: it.url, order: it.order, children: [] };
        // `target` rides along only when present (menuTargetRel whitelists it at render) — no
        // undefined-valued key, so strict-equality snapshots of pre-target trees stay byte-stable.
        if (typeof it.target === "string") node.target = it.target;
        byId.set(String(it.id), node);
    }
    const roots: Node[] = [];
    // Second pass: attach each node to its parent, or promote it to a root.
    for (const it of items) {
        if (!isPlainObject(it) || it.id === undefined || it.id === null) continue;
        const node = byId.get(String(it.id))!;
        const parentKey = it.parent === undefined || it.parent === null ? "" : String(it.parent);
        const parent = parentKey && parentKey !== "0" && parentKey !== String(it.id) ? byId.get(parentKey) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }
    // Sort every level by `order`, and cut any node reached twice — a malformed cycle cannot survive as
    // an infinite branch (each node is emitted at most once in the final tree).
    const seen = new Set<Node>();
    const sortLevel = (level: Node[]): void => {
        level.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        for (const n of level) {
            if (seen.has(n)) { n.children = []; continue; }
            seen.add(n);
            sortLevel(n.children as Node[]);
        }
    };
    sortLevel(roots);
    return roots;
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
export const STARTER_TEMPLATES: { header: ChromeData; footer: ChromeData; announcement: ChromeData } = {
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
    // The announcement bar starts as one centered line + a CTA — and NO ChromeNav (the position bars it).
    announcement: {
        root: { props: {} },
        content: [
            {
                type: "ChromeRow",
                props: {
                    align: "center",
                    gap: "md",
                    items: [
                        { type: "ChromeText", props: { text: "Announcement" } },
                        { type: "ChromeButton", props: { label: "Learn more", href: "/", variant: "primary" } },
                    ],
                },
            },
        ],
    },
};
