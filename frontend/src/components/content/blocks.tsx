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
import { buildMenuTree, type ChromeMenuItem } from "@/lib/chromeData";

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
// / query, or an absolute http(s)/mailto/tel URL; anything else collapses to '#'. The WHATWG-stripped
// controls (tab/LF/CR) are removed FIRST so the validated string is the one the browser will parse.
const NAV_SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
function safeNavHref(raw: unknown): string {
    if (typeof raw !== "string") return "#";
    const value = raw.replace(/[\t\n\r]/g, "").trim();
    if (!value) return "#";
    if (/^\/[/\\]/.test(value)) return "#"; // authority-relative //host or /\host → external
    if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) return value;
    try {
        if (NAV_SAFE_SCHEMES.has(new URL(value).protocol)) return value;
    } catch { /* not absolute, not a recognized relative form */ }
    return "#";
}

// target is author data → whitelist to the two valid values; _blank forces rel so the opened tab
// cannot reach window.opener. Anything else coerces to _self.
function navTargetRel(target: unknown): { target: "_self" | "_blank"; rel?: string } {
    return target === "_blank"
        ? { target: "_blank", rel: "noopener noreferrer" }
        : { target: "_self" };
}

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

    // Horizontal: a CSS-only dropdown (no theme JS). Hidden with visibility until the parent <li> holds
    // focus (keyboard / tap) and, when the trigger is "hover", also on hover. Logical start/ps keep it
    // correct under RTL, exactly like ChromeNav.
    const hoverOpen = submenuTrigger === "hover"
        ? " group-hover:visible group-hover:opacity-100 group-hover:translate-y-0"
        : "";
    const panelPos = depth === 0 ? "top-full start-0 mt-1" : "top-0 start-full ms-1";
    const panel =
        "wjs-chrome-submenu absolute z-50 min-w-[12rem] flex flex-col gap-1 list-none m-0 p-2 rounded-lg shadow-lg "
        + "bg-[var(--wjs-bg-surface,white)] border border-[var(--wjs-border-subtle,#e5e7eb)] "
        + "invisible opacity-0 translate-y-1 transition-all duration-150 "
        + "group-focus-within:visible group-focus-within:opacity-100 group-focus-within:translate-y-0"
        + hoverOpen;
    return (
        <li className="wjs-chrome-nav-item wjs-has-submenu relative group">
            <span className="inline-flex items-center gap-1">
                {link}
                <svg aria-hidden="true" className="w-3 h-3 opacity-70" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
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
        // Reuse the header's hamburger + slide-in drawer; the desktop nav hides below md.
        body = (
            <>
                <div className="hidden md:block">{nav}</div>
                <ChromeNavMobile items={tree} />
            </>
        );
    } else if (orient === "horizontal" && mobileBehavior === "collapse") {
        body = <NavMenuMobile label="Menú">{nav}</NavMenuMobile>;
    }
    // mobileBehavior "none": the nav wraps and stays visible at all widths (no island).

    return (
        <div className={bc("nav-menu")} data-orientation={orient} style={css}>
            {body}
        </div>
    );
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
export function SectionBlock({ maxWidth, pad, bg, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'section');
    return (
        <Tag
            className={cx(bc('section'), extraClass(className))}
            style={{
                ...blockVars('section', { pad: unit(pad), bg, 'max-width': maxWidth }),
                ...css,
            }}
        >
            <div className={bc('section__inner')}>
                {slot()}
            </div>
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
