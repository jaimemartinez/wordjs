/**
 * Shared, SERVER-COMPATIBLE render components for the public content blocks (perf F3).
 *
 * Single source of truth: versoConfig's per-block `render` delegates here, and the public
 * ContentRenderer (server) imports these directly — the editor canvas and the live site can never
 * drift. NO "use client", no hooks, no fetching: blocks are purely presentational; anything
 * interactive lives in its own client-island module, not here.
 *
 * Markup contract: identical class names and identical blockVars() emission — themes style both
 * surfaces the same way. Every block class is built by `bc()` (components/blocks/blockVars.ts), the
 * single point that emits WordJS's own identity first and the historical WordPress-compatible alias
 * second: `class="wjs-block-heading wp-block-heading"`. Never spell a block class inline here — the
 * suite in __tests__/blockClassEmission.test.tsx fails the build if you do.
 */
import React from "react";
import { bc, blockVars, cx, unit } from "@/components/blocks/blockVars";
import { ixWordSpans } from "@/components/blocks/IxWords";
import { ixSplitWords, ixTargetsWords, IX_SYS_CTX, type IxCompileCtx } from "@/lib/verso/interactions";
import { resolveVideoEmbedUrl, sameOriginPath, sanitizeHTML } from "@/lib/sanitize";

/**
 * ── SPLIT POR PALABRAS (motor de interacciones, F9-D) ───────────────────────────────────────────
 *
 * Los bloques que lo declaran (`ixText: true` en su definición: Heading y Quote) parten su texto en
 * `<span class="wjs-ixw">` CUANDO Y SOLO CUANDO su propia interacción apunta a `words`. Esa
 * condición se evalúa aquí, en el componente, y no en un renderer: hay dos renderers (el público y
 * el del canvas) y la condición tiene que ser literalmente la misma función en los dos.
 *
 * Lo que decide es el `ix` YA RESUELTO, no el crudo: el objetivo `words` puede venir dentro de un
 * preajuste del sitio, así que hace falta el catálogo. `ixCtx` lo pasa quien renderiza; sin él se
 * cae a los preajustes del SISTEMA, igual que hace el wrapper compartido.
 *
 * `ixWords={false}` es una NEGATIVA explícita, el único valor que se honra de esa prop: la usa el
 * canvas mientras se edita el texto en línea, porque en esa sesión la prop del bloque no es el
 * texto sino un centinela y partirlo dejaría el contenteditable dentro de un span de una palabra.
 * Un `ixWords: true` colado en `_puck_data` NO parte nada: el dato que manda es `ix`.
 */
type IxTextProps = { ix?: unknown; ixCtx?: IxCompileCtx; ixWords?: false };

const splitForBlock = (text: unknown, html: boolean, p: IxTextProps) =>
    p.ixWords === false || !ixTargetsWords(p.ix, p.ixCtx ?? IX_SYS_CTX)
        ? null
        : ixSplitWords(text, { html });
import { sizesForWidth } from "@/lib/imageSrcset";
import SelfHostedVideo from "./SelfHostedVideo";
import AudioTransport from "./AudioTransport";
import ParticleFieldCanvas from "./ParticleField";
import ChromeNavMobile from "@/components/chrome/ChromeNavMobile";
import NavMenuMobile from "./NavMenuMobile";
import NavClickSubmenus from "./NavClickSubmenus";
import OffCanvasClient from "./OffCanvasClient";
import TocScrollSpy from "./TocScrollSpy";
import { buildMenuTree, safeMenuHref, menuTargetRel, type ChromeMenuItem } from "@/lib/chromeData";
import { parseLocale, isRtlLocale } from "@/lib/documentLanguage";

export function AudioPlayerBlock({ src, title, bg, borderColor, radius, pad, iconSize, iconBg, iconColor, css }: any) {
    return (
        <div
            className={bc('audio-player')}
            style={{
                ...blockVars('audio', {
                    bg,
                    'border-color': borderColor,
                    radius: unit(radius),
                    pad: unit(pad),
                    'icon-size': unit(iconSize),
                    'icon-bg': iconBg,
                    'icon-color': iconColor,
                }),
                ...css,
            }}
        >
            <AudioTransport src={src} title={title} />
        </div>
    );
}

/**
 * ParticleField — a full-bleed animated canvas background (constellation / particle field). This
 * is the SERVER half: an out-of-flow layer that carries no visible pixels until its client island
 * (ParticleFieldCanvas) hydrates and starts drawing, so the served HTML causes ZERO CLS.
 *
 * Layout: `position:absolute; inset:0; z-index:0; pointer-events:none` — it fills its nearest
 * positioned ancestor and sits BEHIND the content. wordjs-ui.css turns the host container into that
 * positioning context and lifts the field's siblings to `z-index:1` (see the `.wjs-block-particle-field`
 * rules there); the inline styles below keep the block self-describing even without that stylesheet.
 * The author's colour travels as the `--wjs-particle-color` custom property (blockVars, omitted when
 * empty → the theme's `--wjs-color-primary` wins) — a validated CSS value, never raw concatenated CSS.
 */
export function ParticleFieldBlock({ count, color, speed, linkLines, linkDistance, pointer, css }: any) {
    return (
        <div
            className={bc('particle-field')}
            aria-hidden="true"
            style={{
                position: 'absolute',
                inset: 0,
                zIndex: 0,
                overflow: 'hidden',
                pointerEvents: 'none',
                ...blockVars('particle', { color }),
                ...css,
            }}
        >
            <ParticleFieldCanvas
                count={count}
                speed={speed}
                linkLines={linkLines}
                linkDistance={linkDistance}
                pointer={pointer}
            />
        </div>
    );
}

/**
 * ── NavMenu (Navigation Menu) ────────────────────────────────────────────────────────────────────
 *
 * A CORE block that BINDS to the site's navigation menu instead of storing its own items: the block
 * carries only a reference (a location key or a menu id) and the nav_menu store stays the single
 * source of truth (zero data to migrate). `menu` arrives ALREADY RESOLVED — server-side via
 * resolveDynamicBlocks on the public site, from useEditorMenu (a client fetch of the same store)
 * inside the editor canvas — so this is a pure, SERVER-SAFE presentational component: the full <nav>
 * and every <a> land in the SSR HTML (SEO / no-JS), and ONLY the mobile hamburger/collapse is a
 * client island. It emits the ChromeNav vocabulary (.wjs-chrome-nav*, .wjs-chrome-nav-item,
 * .wjs-has-submenu, .wjs-chrome-submenu) so themes style it through the rules they already ship,
 * wrapped in .wjs-block-nav-menu which wordjs-ui.css gives the page-content surface.
 *
 * SECURITY (the HeadingBlock tag-whitelist lesson): author menu data may fill a slot but never choose
 * structure. `target` is whitelisted to exactly _self|_blank and _blank forces rel="noopener
 * noreferrer" (reverse-tabnabbing); labels render as TEXT (React-escaped), never as HTML; and every
 * href is re-validated here (defence in depth) even though menu urls are sanitized on write.
 */

// Render-time href guard — mirrors backend routes/menus.ts safeMenuUrl's allow-list so a stale or
// hand-edited value can never emit a javascript:/data:/vbscript: href. Same-origin relative / fragment
// / query, or an absolute http(s)/mailto/tel URL; anything else collapses to '#'.
//
// The IMPLEMENTATION lives in chromeData.ts (safeMenuHref / menuTargetRel): the mobile drawer
// (ChromeNavMobile) must apply the exact same floor, and this module imports that island — a helper
// defined here could never flow back without a cycle. Kept under the historical local names so every
// call site below reads unchanged.
const safeNavHref = safeMenuHref;

// target is author data → whitelist to the two valid values; _blank forces rel so the opened tab
// cannot reach window.opener. Anything else coerces to _self. (Shared: see safeNavHref above.)
const navTargetRel = menuTargetRel;

// depth is 1–3 (top level = 1). Clamp to the allow-set, then cut every branch past it so a hostile or
// stale value can neither deepen the tree nor drop it below one visible level.
function navClampDepth(depth: unknown): 1 | 2 | 3 {
    const n = Number(depth);
    return n === 1 || n === 3 ? n : 2;
}
function navPruneDepth(items: ChromeMenuItem[], maxDepth: number, level = 1): ChromeMenuItem[] {
    return items.map((it) => ({
        ...it,
        children: level < maxDepth ? navPruneDepth(it.children ?? [], maxDepth, level + 1) : [],
    }));
}

function NavMenuItem({
    item,
    orientation,
    submenuTrigger,
    depth,
    targetOf,
}: {
    item: ChromeMenuItem;
    orientation: "horizontal" | "vertical";
    submenuTrigger: "hover" | "click";
    depth: number;
    targetOf: (id: string | number) => unknown;
}) {
    const children = item.children ?? [];
    const tr = navTargetRel(targetOf(item.id));
    // Label as TEXT (React escapes it) — never dangerouslySetInnerHTML.
    const link = (
        <a href={safeNavHref(item.url)} target={tr.target} rel={tr.rel}>
            {item.title}
        </a>
    );

    if (children.length === 0) {
        return <li className="wjs-chrome-nav-item">{link}</li>;
    }

    const sublist = children.map((child) => (
        <NavMenuItem key={child.id} item={child} orientation={orientation} submenuTrigger={submenuTrigger} depth={depth + 1} targetOf={targetOf} />
    ));

    // Vertical: a static indented list — every link is always shown (no hover affordance to reveal).
    if (orientation === "vertical") {
        return (
            <li className="wjs-chrome-nav-item wjs-has-submenu">
                {link}
                <ul className="wjs-chrome-submenu flex flex-col gap-2 list-none m-0 mt-2 ps-4">{sublist}</ul>
            </li>
        );
    }

    // Horizontal: a dropdown whose hidden/open state lives in wordjs-ui.css on the block's own hooks
    // (`.wjs-has-submenu > .wjs-chrome-submenu`, the MegaMenu-flyout pattern) and deliberately NOT in
    // Tailwind visible/invisible utilities: the framework sheet ships an UNLAYERED
    // `.invisible { visibility: hidden !important }` that out-cascades any LAYERED utility toggle, so
    // a group-hover/group-focus-within reveal could never open on the public surface. Here only the
    // panel's position + tokenized surface. Logical start/ps keep it correct under RTL, like ChromeNav.
    //
    // hover trigger: CSS-only (opens on :hover and :focus-within under [data-trigger="hover"]).
    // click trigger: the caret is a REAL <button> (aria-expanded/aria-haspopup) and the
    // NavClickSubmenus island flips [data-open] on this <li> — a parent <a> with a real URL keeps
    // navigating on click while the button, keyboard-activatable everywhere (Safari never focuses
    // links on click, so :focus-within alone could never open it there), owns the disclosure.
    const panelPos = depth === 0 ? "top-full start-0 mt-1" : "top-0 start-full ms-1";
    const panel =
        "wjs-chrome-submenu absolute z-50 min-w-[12rem] flex flex-col gap-1 list-none m-0 p-2 rounded-lg shadow-lg "
        + "bg-[var(--wjs-bg-surface,white)] border border-[var(--wjs-border-subtle,#e5e7eb)]";
    const caret = (
        <svg aria-hidden="true" className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
    );
    return (
        <li className="wjs-chrome-nav-item wjs-has-submenu relative">
            <span className="inline-flex items-center gap-1">
                {link}
                {submenuTrigger === "click" ? (
                    <button
                        type="button"
                        className="wjs-submenu-toggle inline-flex items-center justify-center p-1 m-0 bg-transparent border-0 cursor-pointer text-current"
                        aria-expanded={false}
                        aria-haspopup="true"
                        aria-label={`Abrir submenú de ${item.title}`}
                    >
                        {caret}
                    </button>
                ) : caret}
            </span>
            <ul className={`${panel} ${panelPos}`}>{sublist}</ul>
        </li>
    );
}

export function NavMenuBlock({ menu, orientation = "horizontal", depth = 2, submenuTrigger = "hover", mobileBehavior = "drawer", align = "start", css, isEditing }: any) {
    const flat: ChromeMenuItem[] = Array.isArray(menu) ? menu : [];
    const orient: "horizontal" | "vertical" = orientation === "vertical" ? "vertical" : "horizontal";
    const trigger: "hover" | "click" = submenuTrigger === "click" ? "click" : "hover";
    // `target` rides on the FLAT item, not on the tree buildMenuTree returns — look it up by id.
    const targetById = new Map<string, unknown>();
    for (const it of flat) {
        const id = it && (it as { id?: unknown }).id;
        if (id != null) targetById.set(String(id), (it as { target?: unknown }).target);
    }
    const targetOf = (id: string | number) => targetById.get(String(id));
    const tree = navPruneDepth(buildMenuTree(flat), navClampDepth(depth));

    if (tree.length === 0) {
        // Nothing on the public site; a quiet authoring notice while editing (mirrors the dynamic blocks).
        if (isEditing) {
            return (
                <div className={bc("nav-menu", "nav-menu--empty")} style={css}>
                    Vincula este bloque a un menú (Origen → Ubicación / Menú). El menú elegido está vacío o no existe.
                </div>
            );
        }
        return null;
    }

    const hook = orient === "vertical" ? "wjs-footer-nav" : "wjs-header-nav";
    const orientClass = orient === "vertical" ? "wjs-chrome-nav-vertical" : "wjs-chrome-nav-horizontal";
    const alignClass = orient === "vertical"
        ? (align === "center" ? "items-center" : align === "end" ? "items-end" : "items-start")
        : (align === "center" ? "justify-center" : align === "end" ? "justify-end" : "justify-start");
    const listClass = orient === "vertical"
        ? cx("flex flex-col gap-2 list-none m-0 p-0", alignClass)
        : cx("flex flex-wrap items-center gap-8 list-none m-0 p-0", alignClass);

    const nav = (
        <nav aria-label="Menu" className={cx("wjs-chrome-nav", orientClass, hook)}>
            <ul className={listClass}>
                {tree.map((item) => (
                    <NavMenuItem key={item.id} item={item} orientation={orient} submenuTrigger={trigger} depth={0} targetOf={targetOf} />
                ))}
            </ul>
        </nav>
    );

    // Mobile affordance — ONLY the small-screen toggle is a client island; the desktop <nav> above is
    // fully server-rendered (so its links are always in the SSR HTML). Vertical menus are already
    // stacked, so they stay visible at every width regardless of mobileBehavior.
    let body: React.ReactNode = nav;
    if (orient === "horizontal" && mobileBehavior === "drawer") {
        // Reuse the header's hamburger + slide-in drawer; the desktop nav hides below md. The tree
        // handed over carries the SAME re-validated hrefs the desktop <a>s render (a stored
        // javascript: url must collapse to '#' on BOTH surfaces) — and the drawer re-checks them
        // itself, since it is shared with the composed header chrome (defence in depth, twice).
        const sanitizeForDrawer = (items: ChromeMenuItem[]): ChromeMenuItem[] =>
            items.map((it) => ({
                ...it,
                url: safeNavHref(it.url),
                children: sanitizeForDrawer(it.children ?? []),
            }));
        body = (
            <>
                <div className="hidden md:block">{nav}</div>
                <ChromeNavMobile items={sanitizeForDrawer(tree)} />
            </>
        );
    } else if (orient === "horizontal" && mobileBehavior === "collapse") {
        body = <NavMenuMobile label="Menú">{nav}</NavMenuMobile>;
    }
    // mobileBehavior "none": the nav wraps and stays visible at all widths (no island).

    // Click trigger only: the tiny delegated-listener island that flips [data-open] on the submenu
    // <li>s (Escape / outside-click close). Hover mode stays zero-JS, and the editor canvas mounts
    // no island (the Puck overlay owns pointer events there).
    if (orient === "horizontal" && trigger === "click" && !isEditing) {
        body = <NavClickSubmenus>{body}</NavClickSubmenus>;
    }

    // data-trigger is a RENDERED attr (not a stored prop): wordjs-ui.css keys the :hover /
    // :focus-within reveal on [data-trigger="hover"], exactly like MegaMenu's flyout.
    return (
        <div className={bc("nav-menu")} data-orientation={orient} data-trigger={trigger} style={css}>
            {body}
        </div>
    );
}

/**
 * ── MegaMenu ───────────────────────────────────────────────────────────────────────────────────────
 *
 * HYBRID navigation block: the menu STRUCTURE stays BOUND to the canonical nav_menu store exactly like
 * NavMenu (the block stores only source/location/menuId; `menu` arrives already resolved — server-side
 * via resolveDynamicBlocks, from useEditorMenu inside the editor canvas), while each top-level item's
 * rich flyout PANEL is an INLINE slot of arbitrary blocks.
 *
 * PANEL MAPPING (the Columns precedent): slots must be statically declared (`makeSlotResolver` reads
 * the registry's `fields`, same as Columns' col-0/col-1/col-2), so the panels are the FIXED set
 * panel0…panel5, mapped to the FIRST 6 top-level items of the bound menu IN ORDER (panel0 → first
 * item, panel1 → second…). The editor shows the same mapping as a hint. An item whose panel is
 * empty/absent renders as a plain link — byte-identical to a NavMenu top-level item. Depth is FIXED:
 * top-level items + their panel; a MegaMenu never recurses submenus (bind a NavMenu for a cascade).
 *
 * The flyout is CSS-ONLY (a theme still ships no JS): hidden with visibility until the item holds
 * focus (keyboard / tap; Tab-out closes) and, when `trigger` is "hover", also on hover — the same
 * SEMANTICS as the NavMenu submenu. The state itself lives in wordjs-ui.css on the .wjs-* hooks
 * (`.wjs-has-submenu > .wjs-mega-menu__panel`, opened by :focus-within and, under
 * [data-trigger="hover"], by :hover) instead of the Tailwind visible/invisible utilities: the
 * framework sheet ships an UNLAYERED `.invisible { visibility: hidden !important }` that
 * out-cascades any LAYERED utility toggle, so a utility-based reveal never opens on the public
 * surface. `fullWidth` panels span the nav's width (positioned against the relative <nav>);
 * anchored panels hang from their own item. Panels render SERVER-side (crawlable); nested
 * NavMenu/SiteLogo/etc. inside a panel are decorated by resolveDynamicBlocks, which recurses slot
 * arrays.
 *
 * SECURITY (the NavMenu lessons, verbatim): every href re-validated at render (safeNavHref), target
 * whitelisted to _self|_blank with rel="noopener noreferrer" forced on _blank, labels as escaped TEXT,
 * and author data never chooses structure — the panel set and depth are fixed by this component.
 */
const MEGA_MENU_PANEL_COUNT = 6;
export const MEGA_MENU_PANEL_SLOTS = Array.from({ length: MEGA_MENU_PANEL_COUNT }, (_, i) => `panel${i}`);

export function MegaMenuBlock({ menu, fullWidth = true, trigger = "hover", panels, css, isEditing }: any) {
    const flat: ChromeMenuItem[] = Array.isArray(menu) ? menu : [];
    const trig: "hover" | "click" = trigger === "click" ? "click" : "hover";
    const full = fullWidth !== false && fullWidth !== "false";
    // A panel is a render function (the slot) or null (empty/absent → plain link).
    const slotFns: Array<((className?: string) => React.ReactNode) | null> = Array.isArray(panels)
        ? panels.map((p) => (typeof p === "function" ? p : null))
        : [];
    // `target` rides on the FLAT item, not on the tree buildMenuTree returns — look it up by id.
    const targetById = new Map<string, unknown>();
    for (const it of flat) {
        const id = it && (it as { id?: unknown }).id;
        if (id != null) targetById.set(String(id), (it as { target?: unknown }).target);
    }
    // Top-level items only, in menu order. Children in the bound menu are NOT rendered (fixed depth).
    const top = buildMenuTree(flat);

    if (top.length === 0) {
        // Nothing on the public site; a quiet authoring notice while editing (same as NavMenu).
        if (isEditing) {
            return (
                <div className={bc("mega-menu", "mega-menu--empty")} style={css}>
                    Vincula este bloque a un menú (Origen → Ubicación / Menú). El menú elegido está vacío o no existe.
                </div>
            );
        }
        return null;
    }

    // Hidden/open state comes from wordjs-ui.css (see the block comment): here only the panel's
    // position + tokenized surface. The li>panel CHILD relationship is the selector contract.
    const panelCls =
        "wjs-mega-menu__panel absolute z-50 m-0 p-4 rounded-lg shadow-lg "
        + "bg-[var(--wjs-bg-surface,white)] border border-[var(--wjs-border-subtle,#e5e7eb)]"
        + (full ? " top-full inset-x-0 mt-1" : " top-full start-0 mt-1 min-w-[16rem]");

    const targetOf = (id: string | number) => targetById.get(String(id));
    const items = top.map((item, i) => {
        const tr = navTargetRel(targetOf(item.id));
        // The trigger is a REAL link; the label as TEXT (React escapes it) — never innerHTML.
        const link = (
            <a href={safeNavHref(item.url)} target={tr.target} rel={tr.rel}>
                {item.title}
            </a>
        );
        // While editing, the nav shows plain links and the panels render ONCE in the authoring area
        // below (a slot function must not be invoked twice — its drop zone is a single instance).
        const panelFn = !isEditing && i < MEGA_MENU_PANEL_COUNT ? slotFns[i] ?? null : null;
        if (!panelFn) {
            // Byte-identical to a NavMenu top-level item without children.
            return <li key={item.id} className="wjs-chrome-nav-item">{link}</li>;
        }
        return (
            <li key={item.id} className={cx("wjs-chrome-nav-item wjs-has-submenu", !full && "relative")}>
                <span className="inline-flex items-center gap-1">
                    {link}
                    <svg aria-hidden="true" className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </span>
                {/* The slot's own wrapper div IS the panel (one div per slot, classed by the container). */}
                {panelFn(panelCls)}
            </li>
        );
    });

    return (
        <div className={bc("mega-menu")} data-full-width={full ? "true" : "false"} data-trigger={trig} style={css}>
            <nav aria-label="Menu" className={cx("wjs-chrome-nav wjs-chrome-nav-horizontal wjs-header-nav wjs-mega-menu", full && "relative")}>
                <ul className="flex flex-wrap items-center gap-8 list-none m-0 p-0">{items}</ul>
            </nav>
            {isEditing && (
                <div className="wjs-mega-menu__editor-panels mt-2 flex flex-col gap-2">
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)] text-xs m-0">
                        Paneles: se asignan a los 6 primeros elementos de nivel superior, en orden (panel 1 → primer
                        elemento…). Un panel vacío deja su elemento como enlace simple.
                    </p>
                    {top.slice(0, MEGA_MENU_PANEL_COUNT).map((item, i) => {
                        const fn = slotFns[i];
                        if (!fn) return null;
                        return (
                            <div key={item.id} className="rounded-lg border border-[var(--wjs-border-subtle,#e5e7eb)] p-2">
                                <p className="text-[var(--wjs-color-text-muted,#6b7280)] text-xs m-0 mb-1">Panel de «{item.title}»</p>
                                {fn("wjs-mega-menu__panel")}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/**
 * ── SiteLogo (Site Logo / Title) ───────────────────────────────────────────────────────────────────
 *
 * Renders the site's brand — its logo image, its title, or both — optionally linked home. Like NavMenu
 * it BINDS to a store instead of storing its own copy: the site `blogname` + `site_logo` arrive already
 * resolved (server-side via resolveDynamicBlocks → `resolvedIdentity`; from useEditorIdentity inside the
 * editor canvas), so this is a pure, SERVER-SAFE presentational component — the real brand lands in the
 * SSR HTML for crawlers / no-JS. Reuses the header brand hooks `.wjs-header-logo` (on the link/wrapper)
 * and `.wjs-site-title` (on the title text) so themes style it through rules they already ship.
 *
 * SECURITY: `siteLogo` is re-validated at render (same allow-list shape as safeNavHref — same-origin
 * path or absolute http(s), else no image); `blogname` renders as TEXT (React-escaped), never HTML.
 */

// Render-time image-src guard: a same-origin path or an absolute http(s) URL, else undefined (no img).
// Mirrors sameOriginPath + the NAV_SAFE_SCHEMES allow-list; strips the WHATWG-removed controls first.
function safeLogoSrc(raw: unknown): string | undefined {
    if (typeof raw !== "string") return undefined;
    const value = raw.replace(/[\t\n\r]/g, "").trim();
    if (!value) return undefined;
    if (/^\/[/\\]/.test(value)) return undefined; // authority-relative //host or /\host → external
    if (value.startsWith("/")) return value; // same-origin path
    try {
        const proto = new URL(value).protocol;
        if (proto === "http:" || proto === "https:") return value;
    } catch { /* not absolute, not a same-origin path */ }
    return undefined;
}

export function SiteLogoBlock({ mode = "both", linkToHome = true, maxHeight = 40, altOverride, identity, css, isEditing }: any) {
    const blogname = typeof identity?.blogname === "string" ? identity.blogname : "";
    const logoSrc = safeLogoSrc(identity?.siteLogo);
    const alt = (typeof altOverride === "string" && altOverride.trim()) ? altOverride : (blogname || "Logo");

    // mode: logo | title | both. A logo-only block with no logo falls back to the title so the brand is
    // never invisible; a title-only block never shows the image.
    const wantLogo = mode === "logo" || mode === "both";
    const wantTitle = mode === "title" || mode === "both" || (mode === "logo" && !logoSrc);
    const showLogo = wantLogo && !!logoSrc;
    const showTitle = wantTitle && blogname.length > 0;

    if (!showLogo && !showTitle) {
        if (isEditing) {
            return (
                <div className={bc("site-logo", "site-logo--empty")} style={css}>
                    Configura el nombre del sitio o el logotipo (Ajustes → Identidad) para que este bloque los muestre.
                </div>
            );
        }
        return null;
    }

    const maxH = unit(maxHeight);
    const inner = (
        <>
            {showLogo && (
                <img
                    className="wjs-header-logo-img"
                    src={logoSrc}
                    alt={alt}
                    decoding="async"
                    style={maxH ? { maxHeight: maxH, width: "auto" } : { width: "auto" }}
                />
            )}
            {showTitle && <span className="wjs-site-title">{blogname}</span>}
        </>
    );

    // `.wjs-header-logo` is the brand hook themes target (Header.tsx emits it on this same <a>/<span>
    // shape). Link home unless the author turned it off — logical, no author URL is involved.
    const brand = linkToHome !== false
        ? <a className="wjs-header-logo inline-flex items-center gap-2" href="/">{inner}</a>
        : <span className="wjs-header-logo inline-flex items-center gap-2">{inner}</span>;

    return (
        <div className={bc("site-logo")} data-mode={mode} style={css}>
            {brand}
        </div>
    );
}

/**
 * ── OffCanvas (drawer) ─────────────────────────────────────────────────────────────────────────────
 *
 * A trigger button that opens a slide-in drawer holding a SLOT of arbitrary blocks (authors typically
 * drop a NavMenu inside). This is the SERVER SHELL: the panel and its slotted children render here on
 * the server (crawlable, in the SSR HTML) and are handed as `children` to OffCanvasClient — the small
 * `"use client"` island that flips open/aria-expanded, optionally locks body scroll and closes on
 * Escape. A nested NavMenu is already decorated by resolveDynamicBlocks (it recurses slots), so no new
 * data wiring is needed for the common case. Emits `.wjs-offcanvas` and reuses the header's
 * `.wjs-header-mobile-overlay` / `.wjs-header-mobile-panel` hooks so themes style it.
 */
export function OffCanvasBlock({ slot, triggerLabel = "Menú", triggerIcon = "fa-bars", side = "left", breakpoint = "always", closeOnEsc = true, scrollLock = true, css, isEditing }: any) {
    const sideSafe = side === "right" ? "right" : "left";
    const bpSafe = breakpoint === "md" || breakpoint === "lg" ? breakpoint : "always";
    // The slot arrives as a render function on BOTH surfaces (editor DropZone / public wrapper div).
    const panelChildren = typeof slot === "function" ? slot(bc("offcanvas__content")) : null;

    return (
        <div className={bc("offcanvas")} data-side={sideSafe} data-breakpoint={bpSafe} style={css}>
            <OffCanvasClient
                triggerLabel={triggerLabel}
                triggerIcon={triggerIcon}
                side={sideSafe}
                breakpoint={bpSafe}
                closeOnEsc={closeOnEsc !== false}
                scrollLock={scrollLock !== false}
            >
                {panelChildren}
                {isEditing && !panelChildren ? (
                    <p className="text-[var(--wjs-color-text-muted,#6b7280)] text-sm">Arrastra bloques aquí (p. ej. un menú de navegación).</p>
                ) : null}
            </OffCanvasClient>
        </div>
    );
}

/**
 * ── Breadcrumbs ──────────────────────────────────────────────────────────────────────────────────────
 *
 * The ancestor trail for the current page. Like NavMenu/SiteLogo it stores NO copy of the path: the
 * ordered `resolvedTrail` (each { label, href }, the current page LAST with no href) is built for THIS
 * concrete post in a NON-cached pass (resolveDynamicBlocks' withResolvedBlocks → injectPostContext),
 * so the real chain lands in the SSR HTML for crawlers / no-JS. Pure SERVER-SAFE component.
 *
 * SECURITY (the NavMenu lesson): trail labels render as TEXT (React-escaped), every href is
 * re-validated at render (safeNavHref), and the current page is plain text with aria-current="page" —
 * author data fills the slots, it never chooses structure. Emits `.wjs-breadcrumbs`; bc('breadcrumbs').
 */
const BREADCRUMB_SEPARATORS = new Set(["›", "/", "—"]);

export function BreadcrumbsBlock({ resolvedTrail, resolvedIsFront, separator = "›", showHome = true, homeLabel = "Inicio", hideOnHome = true, css, isEditing }: any) {
    const sep = typeof separator === "string" && BREADCRUMB_SEPARATORS.has(separator) ? separator : "›";
    const home = typeof homeLabel === "string" && homeLabel.trim() ? homeLabel : "Inicio";
    const trail: Array<{ label?: unknown; href?: unknown }> = Array.isArray(resolvedTrail) ? resolvedTrail : [];

    // The editor canvas has no published-post context — show a REPRESENTATIVE preview so the block is
    // visible while composing. Never faked on the public path (no trail → render nothing there).
    if (!trail.length) {
        if (isEditing) {
            const parts = [showHome !== false ? home : null, "…", "Esta página"].filter(Boolean) as string[];
            return (
                <nav aria-label="Breadcrumb" className={cx(bc("breadcrumbs", "breadcrumbs--preview"), "wjs-breadcrumbs")} style={css}>
                    <ol className="wjs-breadcrumbs__list flex flex-wrap items-center gap-2 list-none m-0 p-0">
                        {parts.map((p, i) => (
                            <li key={i} className="wjs-breadcrumbs__item inline-flex items-center gap-2">
                                {i > 0 && <span className="wjs-breadcrumbs__sep" aria-hidden="true">{sep}</span>}
                                <span>{p}</span>
                            </li>
                        ))}
                    </ol>
                </nav>
            );
        }
        return null;
    }

    // Nothing on the site front page when the author asked to hide it there.
    if (hideOnHome !== false && resolvedIsFront) return null;

    // The crumb list: optional Home, then the ancestor chain and the current page (last, not linked).
    const crumbs: Array<{ label: string; href?: string }> = [];
    if (showHome !== false) crumbs.push({ label: home, href: "/" });
    for (const c of trail) {
        const label = typeof c?.label === "string" && c.label.trim() ? c.label : "…";
        const href = typeof c?.href === "string" && c.href ? c.href : undefined;
        crumbs.push({ label, href });
    }
    const lastIndex = crumbs.length - 1;

    // JSON-LD BreadcrumbList (rich results). Labels are strings, hrefs are same-origin paths through
    // safeNavHref, and the whole object is JSON-encoded with `<` escaped so it cannot break the script.
    const jsonLd = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: c.label,
            ...(c.href && i !== lastIndex ? { item: safeNavHref(c.href) } : {}),
        })),
    };

    return (
        <nav aria-label="Breadcrumb" className={cx(bc("breadcrumbs"), "wjs-breadcrumbs")} style={css}>
            <ol className="wjs-breadcrumbs__list flex flex-wrap items-center gap-2 list-none m-0 p-0">
                {crumbs.map((c, i) => {
                    const isLast = i === lastIndex;
                    return (
                        <li key={i} className="wjs-breadcrumbs__item inline-flex items-center gap-2">
                            {i > 0 && <span className="wjs-breadcrumbs__sep" aria-hidden="true">{sep}</span>}
                            {isLast || !c.href
                                ? <span className="wjs-breadcrumbs__current" aria-current="page">{c.label}</span>
                                : <a className="wjs-breadcrumbs__link" href={safeNavHref(c.href)}>{c.label}</a>}
                        </li>
                    );
                })}
            </ol>
            <script
                type="application/ld+json"
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
            />
        </nav>
    );
}

/**
 * ── LangSwitcher (Language Switcher) ─────────────────────────────────────────────────────────────────
 *
 * Links to the current page's translations in other languages. It BINDS to the PUBLIC content
 * translation model (post.language + post.translations) — NOT the admin i18n chrome. The resolved
 * shape ({ language, currentHref, items:[{language, href}] }) is built for THIS post in the non-cached
 * post-context pass, so the links land in the SSR HTML. Renders NOTHING when there are no translations,
 * so a monolingual site costs zero. Pure SERVER component: the inline style is a plain list and the
 * "dropdown" style is a CSS-only <details> disclosure — a theme never ships JS.
 *
 * SECURITY: each translation href is re-validated at render (safeNavHref); language labels are TEXT.
 * Emits `.wjs-lang-switcher`; bc('lang-switcher').
 */
function langLabel(code: string, mode: string, displayLocale: string): string {
    const parsed = parseLocale(code);
    const tag = parsed ? parsed.tag : String(code || "");
    if (mode === "tag") return tag.toUpperCase();
    const inLocale = mode === "name" ? (parseLocale(displayLocale)?.tag || "en") : (parsed?.tag || String(code || "").toLowerCase());
    try {
        return new Intl.DisplayNames([inLocale], { type: "language" }).of(parsed?.language || tag) || tag.toUpperCase();
    } catch {
        return tag.toUpperCase();
    }
}

const langDir = (code: string): "rtl" | "ltr" => (isRtlLocale(parseLocale(code)) ? "rtl" : "ltr");

export function LangSwitcherBlock({ resolvedTranslations, style = "inline", labelMode = "native", showCurrent = true, css, isEditing }: any) {
    const data = resolvedTranslations && typeof resolvedTranslations === "object" ? resolvedTranslations : null;
    const currentLang = typeof data?.language === "string" ? data.language : "";
    const currentHref = typeof data?.currentHref === "string" ? data.currentHref : "";
    const items: Array<{ language?: unknown; href?: unknown }> = Array.isArray(data?.items) ? data!.items : [];
    const mode = labelMode === "tag" || labelMode === "name" ? labelMode : "native";
    const styleKind = style === "dropdown" ? "dropdown" : "inline";

    // No translations → nothing on public. A quiet note while editing so the author knows the block is
    // there (it will populate once the page is part of a translation group).
    if (!items.length) {
        if (isEditing) {
            return (
                <div className={cx(bc("lang-switcher", "lang-switcher--empty"), "wjs-lang-switcher")} style={css}>
                    Este bloque mostrará las traducciones de la página. Aún no hay ninguna (sitio monolingüe).
                </div>
            );
        }
        return null;
    }

    type Opt = { code: string; href?: string; current: boolean };
    const opts: Opt[] = [];
    if (showCurrent !== false && currentLang) opts.push({ code: currentLang, href: currentHref || undefined, current: true });
    for (const it of items) {
        const code = typeof it?.language === "string" ? it.language : "";
        const href = typeof it?.href === "string" ? it.href : "";
        if (code && href) opts.push({ code, href, current: false });
    }
    if (!opts.length) return null;

    const renderOption = (o: Opt, idx: number) => {
        const label = langLabel(o.code, mode, currentLang);
        const dir = langDir(o.code);
        return o.current
            ? <span key={idx} className="wjs-lang-switcher__current" lang={o.code} dir={dir} aria-current="true">{label}</span>
            : <a key={idx} className="wjs-lang-switcher__link" lang={o.code} dir={dir} hrefLang={o.code} href={safeNavHref(o.href)}>{label}</a>;
    };

    if (styleKind === "dropdown") {
        const summaryLabel = langLabel(currentLang || opts[0].code, mode, currentLang);
        return (
            <details className={cx(bc("lang-switcher", "lang-switcher--dropdown"), "wjs-lang-switcher relative inline-block")} style={css}>
                <summary className="wjs-lang-switcher__summary cursor-pointer inline-flex items-center gap-2 select-none">
                    <i className="fa-solid fa-language" aria-hidden="true"></i>
                    <span lang={currentLang || undefined}>{summaryLabel}</span>
                </summary>
                <ul className="wjs-lang-switcher__menu absolute z-50 mt-1 min-w-[8rem] flex flex-col gap-1 list-none m-0 p-2 rounded-lg shadow-lg bg-[var(--wjs-bg-surface,white)] border border-[var(--wjs-border-subtle,#e5e7eb)]">
                    {opts.map((o, i) => (
                        <li key={i} className="wjs-lang-switcher__item">{renderOption(o, i)}</li>
                    ))}
                </ul>
            </details>
        );
    }

    return (
        <nav aria-label="Idiomas" className={cx(bc("lang-switcher", "lang-switcher--inline"), "wjs-lang-switcher")} style={css}>
            <ul className="wjs-lang-switcher__list flex flex-wrap items-center gap-3 list-none m-0 p-0">
                {opts.map((o, i) => (
                    <li key={i} className="wjs-lang-switcher__item inline-flex items-center">{renderOption(o, i)}</li>
                ))}
            </ul>
        </nav>
    );
}

/**
 * ── TableOfContents (ToC) ────────────────────────────────────────────────────────────────────────────
 *
 * An in-page index of the page's headings. `resolvedHeadings` (each { id, level, title }) is collected
 * from the content tree by resolveDynamicBlocks — ONLY headings that carry a non-empty elementId (a real
 * anchor). The SERVER SHELL renders the `<nav>` of `#id` links (works with no JS); a tiny client island
 * adds scroll-spy active-state when enabled, so the links themselves never depend on JS. Empty (no
 * eligible headings) → nothing on public, a notice while editing. Emits `.wjs-toc`; bc('toc').
 *
 * SECURITY: each elementId is re-validated as a safe fragment before it becomes an `href="#…"`; heading
 * text renders as TEXT (React-escaped).
 */
const TOC_ID_RE = /^[A-Za-z][\w-]*$/;
const TOC_LEVEL_NUM: Record<string, number> = { H2: 2, H3: 3, H4: 4 };

export function TableOfContentsBlock({ resolvedHeadings, title = "En esta página", minLevel = "H2", maxLevel = "H3", ordered = false, scrollSpy = true, css, isEditing }: any) {
    const lo = Math.min(TOC_LEVEL_NUM[minLevel] || 2, TOC_LEVEL_NUM[maxLevel] || 3);
    const hi = Math.max(TOC_LEVEL_NUM[minLevel] || 2, TOC_LEVEL_NUM[maxLevel] || 3);

    const all: Array<{ id?: unknown; level?: unknown; title?: unknown }> = Array.isArray(resolvedHeadings) ? resolvedHeadings : [];
    const eligible = all
        .map((h) => ({
            id: typeof h?.id === "string" ? h.id.trim() : "",
            title: typeof h?.title === "string" ? h.title : "",
            num: parseInt(String(typeof h?.level === "string" ? h.level : "h2").replace(/[^0-9]/g, ""), 10) || 2,
        }))
        // A ToC entry MUST anchor to a real, safe fragment id, and sit inside the chosen level range.
        .filter((h) => h.id && TOC_ID_RE.test(h.id) && h.num >= lo && h.num <= hi);

    if (!eligible.length) {
        if (isEditing) {
            return (
                <div className={cx(bc("toc", "toc--empty"), "wjs-toc")} style={css}>
                    La tabla de contenidos listará los títulos de esta página que tengan un ID / ancla. Aún no hay ninguno en el rango elegido.
                </div>
            );
        }
        return null;
    }

    const heading = typeof title === "string" && title.trim() ? title : "En esta página";
    const ListTag: any = ordered ? "ol" : "ul";
    const ids = eligible.map((h) => h.id);

    const nav = (
        <nav aria-label={heading} className={cx(bc("toc"), "wjs-toc")} style={css}>
            <p className="wjs-toc__title font-semibold m-0 mb-2">{heading}</p>
            <ListTag className={cx("wjs-toc__list m-0 flex flex-col gap-1", ordered ? "list-decimal ps-5" : "list-none p-0")}>
                {eligible.map((h) => (
                    <li
                        key={h.id}
                        className="wjs-toc__item"
                        data-level={h.num}
                        style={h.num > lo ? { marginInlineStart: `${(h.num - lo) * 12}px` } : undefined}
                    >
                        <a className="wjs-toc__link" data-toc-id={h.id} href={`#${h.id}`}>{h.title}</a>
                    </li>
                ))}
            </ListTag>
        </nav>
    );

    // Scroll-spy is the ONLY interactive part and it is progressive enhancement: the links above are
    // fully server-rendered and work with no JS. The island observes the heading ids and toggles the
    // active link; when scrollSpy is off there is no island at all.
    return scrollSpy !== false ? <TocScrollSpy ids={ids}>{nav}</TocScrollSpy> : nav;
}

// SECURITY: the ONLY allowed element types for a heading. `level` arrives from _puck_data, which is
// author-controlled, and the write-side sanitizer (backend core/sanitize-meta.ts) classifies string
// leaves as HTML-bearing or URL-bearing only — a STRUCTURAL prop like this one passes through
// untouched by design. Using it as the element type therefore let an author pick the tag: `script`
// turned the dangerouslySetInnerHTML below into an executing <script> in the server-rendered public
// HTML (F3 made this a server component, so it lands in the parsed initial document, and F1 then
// caches that HTML for every anonymous visitor), and a void tag like `img` threw during SSR and 500'd
// the page. Untrusted data may fill a slot; it may never choose the structure around it.
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function HeadingBlock({ title, level, elementId, color, size, weight, tracking, css, ...ixp }: any) {
    const tag = HEADING_TAGS.has(String(level)) ? String(level) : 'h2';
    const Tag = tag as any;
    const attrs = {
        id: elementId || undefined,
        className: cx(bc('heading'), `heading-${tag}`),
        style: {
            ...blockVars('heading', {
                color,
                size: unit(size),
                // NOT `weight`: `--wjs-heading-weight` is already a FRAMEWORK token
                // (the theme's global heading weight, declared in wordjs-ui.css's
                // :root). Emitting the block's value under that name would make
                // `var(--wjs-heading-weight, var(--wjs-h2-weight))` resolve from
                // :root for every heading, so the per-level theme weights would
                // never apply. A distinct name keeps both seams working.
                'font-weight': weight,
                tracking: unit(tracking),
            }),
            ...css,
        },
    };
    // `html: true` — este bloque pinta su texto COMO HTML, así que el split se niega en cuanto el
    // título trae `<`, `>` o `&`: repartir markup entre spans lo rompería, y el resto depende de qué
    // saneador haya corrido (sanitize-html en el servidor, DOMPurify en el cliente), lo que podría
    // hacer que servidor y cliente discrepasen en la FORMA del árbol. Sin esos tres caracteres,
    // sanear no cambia un byte y las dos superficies parten idéntico. Fail-open: si no se puede
    // partir, el titular se pinta exactamente como siempre y lo único que se pierde es el
    // movimiento.
    const split = splitForBlock(title, true, ixp);
    if (split) {
        // El nombre accesible del titular es la FRASE ENTERA; los spans van aria-hidden (IxWords).
        return <Tag {...attrs} aria-label={split.label}>{ixWordSpans(split)}</Tag>;
    }
    return (
        <Tag
            {...attrs}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: sanitizeHTML(title || '') }}
        />
    );
}

export function ImageBlock({ src, alt, borderRadius, radius, shadow, width, fit, elementId, css, srcSet, imgWidth, imgHeight }: any) {
    return (
        <img
            id={elementId || undefined}
            src={src}
            // Responsive candidates built from real backend variants at pick
            // time (resolveData). `sizes` is derived from the CURRENT block
            // width so later width edits stay coherent. Legacy pages have no
            // srcSet and render exactly as before.
            srcSet={srcSet || undefined}
            sizes={srcSet ? sizesForWidth(width) : undefined}
            width={imgWidth || undefined}
            height={imgHeight || undefined}
            loading="lazy"
            decoding="async"
            alt={alt}
            style={{
                ...blockVars('image', {
                    // `borderRadius` is the pre-contract prop kept by resolveData's migration;
                    // the new `radius` field wins when both are present.
                    radius: unit(radius) || (borderRadius ? `${borderRadius}px` : undefined),
                    shadow,
                    width: unit(width),
                    fit,
                }),
                ...css,
            }}
            className={bc('image')}
        />
    );
}

export function DividerBlock({ type, color, width, length, gap, css }: any) {
    const vars = {
        ...blockVars('divider', {
            color,
            width: unit(width),
            length: unit(length),
            mt: unit(gap),
            mb: unit(gap),
        }),
        ...css,
    };
    // A gradient rule needs a painted box, a line needs a border — different elements.
    if (type === 'gradient') {
        return <div className={bc('divider', 'divider--gradient')} style={vars} />;
    }
    return <hr className={cx(bc('divider'), bc(`divider--${type === 'dashed' ? 'dashed' : 'solid'}`))} style={vars} />;
}

export function ButtonBlock({ label, href, variant, align, bg, color, radius, padY, padX, size, weight, css, isEditing }: any) {
    return (
        <div
            className={bc('button')}
            style={blockVars('button', { align })}
        >
            <a
                href={href}
                className={cx(bc('button__link'), `button-variant-${variant}`)}
                // Swallow clicks ONLY inside the editor canvas (so selecting the block
                // doesn't navigate). Server renders never pass isEditing, so the ternary
                // resolves to undefined there and no handler crosses the RSC boundary.
                onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}
                style={{
                    ...blockVars('button', {
                        bg,
                        color,
                        radius: unit(radius),
                        'pad-y': unit(padY),
                        'pad-x': unit(padX),
                        size: unit(size),
                        weight,
                    }),
                    ...css,
                }}
            >
                {label}
            </a>
        </div>
    );
}

/**
 * THE CONTAINER WRAPPER — which element a container renders, and what extra classes it carries.
 *
 * Adapted from Shopify, where a section's `{% schema %}` may declare `tag` (chosen from a closed list of
 * six) and `class` (APPENDED to the wrapper class the platform emits). A theme's page template can now
 * say the same things (backend/src/core/template-validate.ts is the authority, frontend/src/lib/
 * templateData.ts mirrors it), which is what lets a theme mark one Section as its hero instead of
 * shipping four identical ones.
 *
 * BOTH CHECKS ARE ENFORCED AGAIN HERE, and that is not belt-and-braces — it is load-bearing. These
 * components are also rendered by ContentRenderer/versoConfig with `{...props}` spread straight out of
 * `_puck_data`, which is AUTHOR-controlled and whose write-side sanitizer only classifies string leaves
 * as HTML- or URL-bearing: a structural prop passes through it untouched. That is precisely the hole
 * that produced the `level: "script"` stored-XSS (see HEADING_TAGS above). So `tag` is resolved through
 * a closed Set with a fallback, and `className` is accepted only in the exact shape the validator
 * allows — anything else is DROPPED rather than repaired, so a rejected value can never become a
 * different-but-valid class.
 *
 * `main` is absent from the set on purpose: the public shell already renders `<main id="main-content">`
 * around all of this, and a nested <main> is an invalid landmark.
 */
const CONTAINER_TAGS = new Set(['article', 'aside', 'div', 'footer', 'header', 'section']);
// `typeof tag === 'string'` BEFORE the Set lookup, not String(tag). Coercing first meant
// `tag: ["header"]` stringified to "header" and sailed through a guard both validators reject —
// harmless in itself, since the result is always a member of the closed Set, but this is the
// fail-closed layer for the _puck_data path, where the value is author-controlled and never went
// through a validator at all. A guard that accepts what its own contract refuses is not a guard.
const containerTag = (tag: any, fallback: 'section' | 'div'): any =>
    typeof tag === 'string' && CONTAINER_TAGS.has(tag) ? tag : fallback;

/** Mirrors CLASS_TOKEN/MAX_CLASS_TOKENS in the validators: ≤3 tokens of `[a-z][a-z0-9-]{0,39}`. */
const CLASS_TOKEN = /^[a-z][a-z0-9-]{0,39}$/;
const extraClass = (value: any): string | undefined => {
    if (typeof value !== 'string' || value === '' || value !== value.trim()) return undefined;
    const tokens = value.split(' '); // single space, so a tab/newline/double-space FAILS the pattern
    if (tokens.length > 3 || !tokens.every((t) => CLASS_TOKEN.test(t))) return undefined;
    return value;
};

/**
 * CONTAINER blocks: the slot arrives as a render function `(className?) => ReactNode` so both
 * surfaces keep their own slot machinery — the editor passes Puck's slot component, the public
 * ContentRenderer passes a plain wrapper div with recursively rendered items (same DOM: Puck's
 * SlotRender emits `<div className>…</div>`).
 *
 * The framework's own classes always come FIRST and are never replaced — a theme appends, so every
 * `.wjs-block-*` / `.wp-block-*` selector, token and stylesheet hook keeps working on a container the
 * theme has named.
 */
/**
 * Cuántas pantallas dura una ESCENA FIJA (C5). Lista cerrada: el valor entra en un `calc()` de la
 * hoja, así que solo puede ser uno de estos números — nunca una cadena del autor.
 */
const SECTION_SCENE_LENGTHS = ['2', '3', '4'] as const;
const sceneLength = (raw: unknown): string | null =>
    typeof raw === 'string' && (SECTION_SCENE_LENGTHS as readonly string[]).includes(raw) ? raw : null;

export function SectionBlock({ maxWidth, pad, bg, stick, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'section');
    const scene = sceneLength(stick);
    const inner = <div className={bc('section__inner')}>{slot()}</div>;
    return (
        <Tag
            className={cx(bc('section'), scene && bc('section--scene'), extraClass(className))}
            style={{
                ...blockVars('section', { pad: unit(pad), bg, 'max-width': maxWidth, scene }),
                ...css,
            }}
        >
            {/* Sin escena NO hay envoltorio: el HTML de una sección de siempre queda idéntico byte a
                byte, que es el contrato de esta capa (una interacción no puede cambiar el marcado). */}
            {scene ? <div className={bc('section__stage')}>{inner}</div> : inner}
        </Tag>
    );
}

export function GridBlock({ columns, gap, columnsTablet, columnsMobile, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'div');
    return (
        <Tag
            className={cx(bc('grid'), extraClass(className))}
            style={{
                ...blockVars('grid', {
                    columns,
                    gap: unit(gap),
                    'columns-tablet': columnsTablet,
                    'columns-mobile': columnsMobile,
                }),
                ...css,
            }}
        >
            {/* The GRID lives on the slot's own wrapper, not on this div. Puck renders a
                slot inside a wrapper element of its own, so a grid declared out here would
                make that single wrapper the only grid item: every child stacked into track
                1 while the other tracks sat empty. Both the editor DropZone and the public
                SlotRender accept a className, so the layout goes where the children are. */}
            {slot(bc('grid__items'))}
        </Tag>
    );
}

export function FlexRowBlock({ justify, align, gap, wrap, direction, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'div');
    return (
        <Tag
            className={cx(bc('flex-row'), extraClass(className))}
            style={{
                ...blockVars('flex', {
                    justify,
                    align,
                    gap: unit(gap),
                    wrap,
                    direction,
                }),
                ...css,
            }}
        >
            {/* Same reason as Grid: the flex row must be the slot's own wrapper, or all
                children become one flex item and justify/align/gap do nothing. */}
            {slot(bc('flex-row__items'))}
        </Tag>
    );
}

export function ColumnsBlock({ distribution, columnStyles, gap, minHeight, bg, radius, elementId, css, slots, tag, className }: any) {
    const Tag = containerTag(tag, 'div');
    const dist = distribution || { columnCount: 2, widths: [50, 50] };
    const columnCount = dist.columnCount || 2;
    const widths = dist.widths || [50, 50];
    const styles = columnStyles || [];

    // The mobile stack used to need a per-instance <style> tag (and a React.useId to keep
    // its class name identical across SSR and hydration). The contract's own media query
    // does it for every Columns block, so the injected stylesheet is gone.
    return (
        <Tag
            id={elementId || undefined}
            className={cx(bc('columns'), extraClass(className))}
            style={{
                ...blockVars('columns', {
                    template: widths.slice(0, columnCount).map((w: number) => `${w}%`).join(' '),
                    gap: unit(gap),
                    'min-height': unit(minHeight),
                    bg,
                    radius: unit(radius),
                }),
                ...css,
            }}
        >
            {Array.from({ length: columnCount }).map((_, i) => {
                const colStyle = styles[i] || {};
                const slot = slots[i];
                const hasBorder = colStyle.borderWidth && colStyle.borderWidth !== '0px';
                return (
                    <div
                        key={i}
                        className={bc('columns__col')}
                        // Per-column overrides only: an untouched column emits nothing and
                        // inherits whatever the theme set for --wjs-col-*.
                        style={blockVars('col', {
                            // '16px' is the resolveData seed; ui.css falls back to
                            // var(--wjs-md) = 16px, so filtering it keeps the render
                            // identical while letting a theme's --wjs-col-pad apply.
                            pad: colStyle.padding !== '16px' ? colStyle.padding : undefined,
                            bg: colStyle.backgroundColor !== 'transparent' ? colStyle.backgroundColor : undefined,
                            'border-width': hasBorder ? colStyle.borderWidth : undefined,
                            'border-color': hasBorder ? colStyle.borderColor : undefined,
                            radius: colStyle.borderRadius !== '0px' ? colStyle.borderRadius : undefined,
                        })}
                    >
                        {slot ? slot() : null}
                    </div>
                );
            })}
        </Tag>
    );
}

export function CardBlock({ title, description, icon, theme, bg, color, borderColor, radius, pad, shadow, iconSize, iconBg, iconColor, titleSize, titleWeight, titleTransform, css }: any) {
    return (
        <div
            className={cx(bc('card'), `card-theme-${theme}`)}
            style={{
                ...blockVars('card', {
                    bg,
                    color,
                    'border-color': borderColor,
                    radius: unit(radius),
                    pad: unit(pad),
                    shadow,
                    'icon-size': unit(iconSize),
                    'icon-bg': iconBg,
                    'icon-color': iconColor,
                    'title-size': unit(titleSize),
                    'title-weight': titleWeight,
                    'title-transform': titleTransform,
                }),
                ...css,
            }}
        >
            {icon && (
                // Legacy class kept alongside the __ one so themes written against
                // `wp-block-card-icon` keep matching.
                <div className={cx(bc('card__icon'), 'wp-block-card-icon')}>
                    <i className={`fa-solid ${icon}`}></i>
                </div>
            )}
            <h3 className={cx(bc('card__title'), 'wp-block-card-title')}>{title}</h3>
            <p className={cx(bc('card__description'), 'wp-block-card-description')}>{description}</p>
        </div>
    );
}

export function QuoteBlock({ text, cite, style, accent, size, color, quoteStyle, css, ...ixp }: any) {
    const vars = {
        ...blockVars('quote', {
            accent,
            size: unit(size),
            color,
            style: quoteStyle,
        }),
        ...css,
    };
    // `html: false` — aquí el texto es un HIJO de React, no HTML: React lo escapa igual en las dos
    // superficies, así que un `<` o un `&` en la cita no obligan a renunciar al split (a diferencia
    // del titular, que sí se pinta como HTML).
    const split = splitForBlock(text, false, ixp);
    // El nombre accesible va en el <blockquote>, que es el elemento que contiene el texto — y cuyo
    // rol admite nombre de autor. Nunca en la <figure>: ahí también viven la comilla decorativa y el
    // pie de cita, y etiquetar el conjunto los borraría del árbol de accesibilidad.
    const body = split ? ixWordSpans(split) : text;
    const bodyLabel = split ? split.label : undefined;
    if (style === "large") {
        return (
            <figure className={bc('quote', 'quote--large')} style={vars}>
                <i className={cx('fa-solid fa-quote-left', bc('quote__mark'))} aria-hidden="true"></i>
                <blockquote className={bc('quote__body')} aria-label={bodyLabel}>{body}</blockquote>
                {cite && <figcaption className={bc('quote__cite')}>— {cite}</figcaption>}
            </figure>
        );
    }
    // El pie de cita va DENTRO del blockquote en esta variante, así que cuando hay `aria-label` se
    // saca a un hermano: un `aria-label` en el contenedor sustituye a TODO su contenido, y la cita
    // desaparecería del árbol de accesibilidad. Sin split, el markup es el de siempre.
    if (split) {
        return (
            <figure className={bc('quote', 'quote--bar')} style={vars}>
                <blockquote className={bc('quote__body')} aria-label={bodyLabel}>{body}</blockquote>
                {cite && <footer className={bc('quote__cite')}>— {cite}</footer>}
            </figure>
        );
    }
    return (
        <figure className={bc('quote', 'quote--bar')} style={vars}>
            <blockquote className={bc('quote__body')}>
                {text}
                {cite && <footer className={bc('quote__cite')}>— {cite}</footer>}
            </blockquote>
        </figure>
    );
}

export function TableBlock({ header, rows, striped, stripeBg, css }: any) {
    const split = (s: string) => String(s || "").split("|").map((c) => c.trim());
    const head = split(header);
    const cols = head.length;
    return (
        <div
            className={cx(bc('table'), striped === "true" && bc('table--striped'))}
            style={{ ...blockVars('table', { 'stripe-bg': stripeBg }), ...css }}
        >
            {/* Bare <table> — the WordJS UI framework styles it with theme tokens. */}
            <table className={bc('table__table')}>
                <thead>
                    <tr>
                        {head.map((h, i) => <th key={i}>{h}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {(rows || []).map((r: any, ri: number) => {
                        const cells = split(r?.cells);
                        return (
                            <tr key={ri}>
                                {Array.from({ length: cols }).map((_, ci) => <td key={ci}>{cells[ci] ?? ""}</td>)}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export function IconListBlock({ items, columns, gap, iconSize, iconBg, iconColor, css }: any) {
    return (
        <div
            className={bc('icon-list')}
            style={{
                ...blockVars('icon-list', {
                    columns: parseInt(columns || "3", 10),
                    gap: unit(gap),
                    'icon-size': unit(iconSize),
                    'icon-bg': iconBg,
                    'icon-color': iconColor,
                }),
                ...css,
            }}
        >
            {(items || []).map((it: any, i: number) => (
                <div key={i} className={bc('icon-list__item')}>
                    <span className={bc('icon-list__icon')}>
                        <i className={`fa-solid ${it.icon || "fa-check"}`}></i>
                    </span>
                    <span>
                        <span className={bc('icon-list__title')}>{it.title}</span>
                        {it.text && <span className={bc('icon-list__text')}>{it.text}</span>}
                    </span>
                </div>
            ))}
        </div>
    );
}

export function SocialLinksBlock({ items, align, size, radius, bg, color, hoverBg, gap, css, isEditing }: any) {
    return (
        <div
            className={bc('social-links')}
            style={{
                ...blockVars('social', {
                    justify: align,
                    size: unit(size),
                    radius: unit(radius),
                    bg,
                    color,
                    'hover-bg': hoverBg,
                    gap: unit(gap),
                }),
                ...css,
            }}
        >
            {(items || []).map((it: any, i: number) => (
                <a
                    key={i}
                    href={it.url || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={it.network}
                    className={bc('social-links__link')}
                    onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}
                >
                    <i className={`fa-brands fa-${it.network || "link"}`}></i>
                </a>
            ))}
        </div>
    );
}

export function StatsBlock({ items, gap, valueSize, valueColor, labelColor, labelTransform, css }: any) {
    return (
        <div
            className={bc('stats')}
            style={{
                ...blockVars('stats', {
                    columns: (items || []).length || 1,
                    gap: unit(gap),
                    'value-size': unit(valueSize),
                    'value-color': valueColor,
                    'label-color': labelColor,
                    'label-transform': labelTransform,
                }),
                ...css,
            }}
        >
            {(items || []).map((it: any, i: number) => (
                <div key={i} className={bc('stats__item')}>
                    <div className={bc('stats__value')}>{it.value}</div>
                    <div className={bc('stats__label')}>{it.label}</div>
                </div>
            ))}
        </div>
    );
}

export function HTMLEmbedBlock({ html, css }: any) {
    return (
        // Double-sanitized: the backend cleans the `html` meta field on save (PUCK_HTML_FIELDS)
        // and sanitizeHTML (DOMPurify allowlist, no scripts/handlers) runs again at render.
        <div
            className={bc('html-embed')}
            style={css}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: sanitizeHTML(html || "") }}
        />
    );
}

export function PricingTableBlock({ plans, accent, bg, pad, radius, gap, priceSize, highlightScale, css, isEditing }: any) {
    return (
        <div
            className={bc('pricing')}
            style={{
                ...blockVars('pricing', {
                    columns: plans?.length || 3,
                    gap: unit(gap),
                    accent,
                    bg,
                    pad: unit(pad),
                    radius: unit(radius),
                    'price-size': unit(priceSize),
                    'highlight-scale': highlightScale,
                }),
                ...css,
            }}
        >
            {plans?.map((plan: any, index: number) => (
                <div
                    key={index}
                    className={cx(bc('pricing__plan'), plan.highlighted === "true" && bc('pricing__plan--highlighted'))}
                >
                    <h3 className={bc('pricing__name')}>{plan.name}</h3>
                    <div className={bc('pricing__price')}>
                        {plan.price}
                        <span className={bc('pricing__period')}>{plan.period}</span>
                    </div>
                    <ul className={bc('pricing__features')}>
                        {plan.features?.split("\n").map((feature: string, i: number) => (
                            <li key={i} className={bc('pricing__feature')}>
                                <i className="fa-solid fa-check"></i>
                                {feature}
                            </li>
                        ))}
                    </ul>
                    <a
                        href={plan.buttonLink}
                        className={bc('pricing__button')}
                        onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}
                    >
                        {plan.buttonText}
                    </a>
                </div>
            ))}
        </div>
    );
}

export function TestimonialBlock({ quote, author, role, avatar, bg, pad, radius, quoteSize, accent, avatarSize, css }: any) {
    return (
        <div
            className={bc('testimonial')}
            style={{
                ...blockVars('testimonial', {
                    bg,
                    pad: unit(pad),
                    radius: unit(radius),
                    'quote-size': unit(quoteSize),
                    'mark-color': accent,
                    'avatar-bg': accent,
                    'avatar-size': unit(avatarSize),
                }),
                ...css,
            }}
        >
            <div className={bc('testimonial__mark')} aria-hidden="true">&quot;</div>
            <p className={bc('testimonial__quote')}>{quote}</p>
            <div className={bc('testimonial__person')}>
                {avatar ? (
                    <img src={avatar} alt={author} className={bc('testimonial__avatar')} />
                ) : (
                    // Initials fallback — the old default pointed at i.pravatar.cc (external
                    // request + random stranger's face on every fresh testimonial).
                    <div aria-hidden className={bc('testimonial__avatar', 'testimonial__avatar--initials')}>
                        {(author || "?").trim().charAt(0).toUpperCase()}
                    </div>
                )}
                <div>
                    <div className={bc('testimonial__author')}>{author}</div>
                    <div className={bc('testimonial__role')}>{role}</div>
                </div>
            </div>
        </div>
    );
}

export function CTABannerBlock({ title, subtitle, buttonText, buttonLink, variant, bg, color, pad, radius, titleSize, buttonBg, buttonColor, css, isEditing }: any) {
    return (
        <div
            className={cx(bc('cta-banner'), `cta-variant-${variant || 'gradient'}`)}
            style={{
                ...blockVars('cta', {
                    bg,
                    color,
                    pad: unit(pad),
                    radius: unit(radius),
                    'title-size': unit(titleSize),
                    'button-bg': buttonBg,
                    'button-color': buttonColor,
                }),
                ...css,
            }}
        >
            <h2 className={bc('cta-banner__title')}>{title}</h2>
            <p className={bc('cta-banner__subtitle')}>{subtitle}</p>
            <a
                href={buttonLink}
                className={bc('cta-banner__button')}
                onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}
            >
                {buttonText}
            </a>
        </div>
    );
}

export function VideoEmbedBlock({ url, poster, aspectRatio, radius, bg, css }: any) {
    const vars = {
        ...blockVars('video', { aspect: aspectRatio, radius: unit(radius), bg }),
        ...css,
    };

    // A file served by THIS site plays inline in a real <video>, with no third party in the request
    // path at all. `sameOriginPath` (lib/sanitize.ts) is what decides that: root-relative only, and
    // it rejects BOTH authority-relative spellings — '//host/x' and '/\host/x' — after stripping the
    // control characters the URL parser drops. The inline test this replaces only knew about '//',
    // so '/\evil.test/v.mp4' was treated as ours and the <video> fetched from evil.test.
    const selfHostedSrc = sameOriginPath(url);
    if (selfHostedSrc) {
        return (
            <SelfHostedVideo
                src={selfHostedSrc}
                poster={sameOriginPath(poster) ?? ''}
                vars={vars}
            />
        );
    }

    // Classify + canonicalize through the SHARED provider table (lib/sanitize.ts), which parses the
    // URL and compares the WHOLE host. The substring version this replaces (`url.includes("youtube.com/watch")`,
    // `url.includes("vimeo.com/")`) accepted `https://youtube.com.evil.test/watch?v=…`: the attacker
    // picked the provider and the id that went into the iframe src. The resolver returns null for
    // anything that is not a video on a provider we embed → placeholder, never an iframe.
    const embedUrl = resolveVideoEmbedUrl(url);

    // Show placeholder if no URL or the URL is not a trusted embed
    if (!url || !embedUrl) {
        return (
            <div className={bc('video-embed')} style={vars}>
                <div className={bc('video-embed__placeholder')}>
                    <div>
                        <i className="fa-solid fa-video" aria-hidden="true"></i>
                        <p>{url ? "Unsupported video URL (use YouTube or Vimeo)" : "Enter a video URL"}</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={bc('video-embed')} style={vars}>
            <iframe
                src={embedUrl}
                sandbox="allow-scripts allow-same-origin allow-presentation"
                allowFullScreen
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                loading="lazy"
            />
        </div>
    );
}

export function HeroBlock({ title, subtitle, bgImage, overlay, overlayColor, height, align, buttons, gradientFrom, gradientTo, gradientAngle, titleSize, titleWeight, titleTracking, subtitleSize, color, pad, measure, elementId, css, isEditing }: any) {
    const dim = parseFloat(overlay || "0") || 0;
    // Flow-relative so the hero mirrors under dir="rtl": "left" author choice → text-align:start
    // and justify-content:flex-start (both resolve to left under LTR — today's render is unchanged).
    // justify stays undefined when the author never picked a side, preserving the ui.css `center`
    // fallback for legacy pages that predate the field.
    const textAlign = align === "center" ? "center" : "start";
    const heroJustify = align ? (align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start") : undefined;
    return (
        <section
            id={elementId || undefined}
            className={bc('hero')}
            style={{
                ...blockVars('hero', {
                    'bg-image': bgImage ? `url(${bgImage})` : undefined,
                    'gradient-from': gradientFrom,
                    'gradient-to': gradientTo,
                    'gradient-angle': gradientAngle ? `${gradientAngle}deg` : undefined,
                    height,
                    pad: unit(pad),
                    justify: heroJustify,
                    'text-align': textAlign,
                    'actions-justify': textAlign === "center" ? "center" : "flex-start",
                    measure: unit(measure),
                    color,
                    overlay: dim > 0 ? dim : undefined,
                    'overlay-color': overlayColor,
                    'title-size': unit(titleSize),
                    'title-weight': titleWeight,
                    'title-tracking': unit(titleTracking),
                    'subtitle-size': unit(subtitleSize),
                }),
                ...css,
            }}
        >
            {dim > 0 && <div className={bc('hero__overlay')} aria-hidden="true" />}
            <div className={bc('hero__inner')}>
                <h1 className={bc('hero__title')}>{title}</h1>
                {subtitle && <p className={bc('hero__subtitle')}>{subtitle}</p>}
                {buttons?.length > 0 && (
                    <div className={bc('hero__actions')}>
                        {buttons.map((b: any, i: number) => (
                            <a
                                key={i}
                                href={b.href || "#"}
                                className={cx(bc('hero__button'), b.variant === "outline" && bc('hero__button--outline'))}
                                onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}
                            >
                                {b.label}
                            </a>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}

// Shared post-date formatter for the dynamic blocks (also used by versoConfig's editor paths).
export const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const fmtPostDate = (raw: string): string => {
    const d = new Date(String(raw).replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? "" : "Z"));
    if (isNaN(d.getTime())) return "";
    return `${d.getUTCDate()} ${MESES_ES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * PostsGrid markup. `posts` arrives ALREADY RESOLVED: server-side via resolveDynamicBlocks on the
 * public site; from the useEditorPosts hook (which stays in versoConfig — client) in the editor.
 * The hook's public branch returns the injected list untouched, so passing it straight through
 * here is the same derivation, not a re-implementation.
 */
export function PostsGridBlock({ posts, columns, gap, bg, borderColor, radius, pad, thumbHeight, css, isEditing }: any) {
    const list: any[] = Array.isArray(posts) ? posts : [];
    if (!list.length) {
        return (
            <div className={bc('posts-grid__empty')} style={css}>
                {isEditing
                    ? "Aquí se listarán tus entradas publicadas. Aún no hay ninguna."
                    : "No hay entradas publicadas todavía."}
            </div>
        );
    }

    return (
        <div
            className={bc('posts-grid')}
            style={{
                ...blockVars('posts', {
                    columns,
                    gap: unit(gap),
                    bg,
                    'border-color': borderColor,
                    radius: unit(radius),
                    pad: unit(pad),
                    'thumb-height': unit(thumbHeight),
                }),
                ...css,
            }}
        >
            {list.map((post) => (
                <article key={post.id} className={bc('posts-grid__card')}>
                    {/* The image travels as a CUSTOM PROPERTY (same bridge HeroBlock uses for its
                        bg-image): a literal inline background-image would beat the stylesheet and
                        lock the treatment, whereas the var lets wordjs-ui.css own the layering —
                        its thumb rule paints var(--wjs-posts-thumb-scrim) ABOVE this image, so a
                        theme can composite a gradient scrim without touching the content's photo. */}
                    <div
                        className={bc('posts-grid__thumb')}
                        aria-hidden="true"
                        style={post.image
                            ? ({ "--wjs-posts-thumb-image": `url(${post.image})` } as React.CSSProperties)
                            : undefined}
                    ></div>
                    {post.date && <div className={bc('posts-grid__date')}>{fmtPostDate(post.date)}</div>}
                    <h3 className={bc('posts-grid__title')}>
                        <a href={post.href} onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}>{post.title}</a>
                    </h3>
                    {post.excerpt && <p className={bc('posts-grid__excerpt')}>{post.excerpt}</p>}
                </article>
            ))}
        </div>
    );
}

export function CategoryPostsBlock({ posts, categorySlug, layout, columns, gap, bg, borderColor, radius, linkColor, headingColor, css, resolvedFiltered, isEditing }: any) {
    const list: any[] = Array.isArray(posts) ? posts : [];
    const vars = {
        ...blockVars('catposts', {
            columns,
            gap: unit(gap),
            bg,
            'border-color': borderColor,
            radius: unit(radius),
            'link-color': linkColor,
            'heading-color': headingColor,
        }),
        ...css,
    };

    const heading = (
        <h3 className={bc('category-posts__heading')}>
            <i className="fa-solid fa-folder" aria-hidden="true"></i> {categorySlug}
            {/* Say it out loud when the category matched nothing and this is really "latest
                posts" — silently showing unrelated entries under a category name is worse
                than showing none. */}
            {isEditing && resolvedFiltered === false && (
                <span className={bc('category-posts__note')}> · sin entradas en esta categoría, mostrando las últimas</span>
            )}
        </h3>
    );

    if (!list.length) {
        return (
            <div className={bc('category-posts')} style={vars}>
                {heading}
                <p className={bc('category-posts__empty')}>
                    {isEditing ? "Aún no hay entradas publicadas para mostrar aquí." : "No hay entradas en esta categoría."}
                </p>
            </div>
        );
    }

    if (layout === "grid") {
        return (
            <div className={bc('category-posts', 'category-posts--grid')} style={vars}>
                {list.map((post) => (
                    <div key={post.id} className={bc('category-posts__card')}>
                        <h4 className={bc('category-posts__card-title')}>
                            <a href={post.href} onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}>{post.title}</a>
                        </h4>
                        {post.excerpt && <p className={bc('category-posts__excerpt')}>{post.excerpt}</p>}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className={bc('category-posts')} style={vars}>
            {heading}
            <ul className={bc('category-posts__list')}>
                {list.map((post) => (
                    <li key={post.id} className={bc('category-posts__item')}>
                        <a
                            href={post.href}
                            className={bc('category-posts__link')}
                            onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}
                        >
                            {post.title}
                        </a>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function SpacerBlock({ height, css }: any) {
    return (
        <div
            className={bc('spacer')}
            style={{ ...blockVars('spacer', { height: unit(height) }), ...css }}
        />
    );
}

export function TextBlock({ content, elementId, color, size, leading, measure, css }: any) {
    return (
        <div
            id={elementId || undefined}
            className={cx(bc('text'), 'prose max-w-none')}
            style={{
                ...blockVars('text', {
                    color,
                    size: unit(size),
                    leading,
                    measure: unit(measure),
                }),
                ...css,
            }}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: sanitizeHTML(content) }}
        />
    );
}
