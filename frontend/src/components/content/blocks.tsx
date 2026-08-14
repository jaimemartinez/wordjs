/**
 * Shared, SERVER-COMPATIBLE render components for the public content blocks (perf F3).
 *
 * Single source of truth: puckConfig's per-block `render` delegates here, and the public
 * ContentRenderer (server) imports these directly — the editor canvas and the live site can never
 * drift. NO "use client", no hooks, no fetching: blocks are purely presentational; anything
 * interactive lives in its own client-island module, not here.
 *
 * Markup contract: identical class names (wp-block-*) and identical blockVars() emission — themes
 * style both surfaces the same way.
 */
import React from "react";
import { blockVars, cx, unit } from "@/components/puck/blockVars";
import { sanitizeHTML } from "@/lib/sanitize";
import { sizesForWidth } from "@/lib/imageSrcset";
import SelfHostedVideo from "./SelfHostedVideo";
import AudioTransport from "./AudioTransport";

export function AudioPlayerBlock({ src, title, bg, borderColor, radius, pad, iconSize, iconBg, iconColor, css }: any) {
    return (
        <div
            className="wp-block-audio-player"
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

// SECURITY: the ONLY allowed element types for a heading. `level` arrives from _puck_data, which is
// author-controlled, and the write-side sanitizer (backend core/sanitize-meta.ts) classifies string
// leaves as HTML-bearing or URL-bearing only — a STRUCTURAL prop like this one passes through
// untouched by design. Using it as the element type therefore let an author pick the tag: `script`
// turned the dangerouslySetInnerHTML below into an executing <script> in the server-rendered public
// HTML (F3 made this a server component, so it lands in the parsed initial document, and F1 then
// caches that HTML for every anonymous visitor), and a void tag like `img` threw during SSR and 500'd
// the page. Untrusted data may fill a slot; it may never choose the structure around it.
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function HeadingBlock({ title, level, elementId, color, size, weight, tracking, css }: any) {
    const tag = HEADING_TAGS.has(String(level)) ? String(level) : 'h2';
    const Tag = tag as any;
    return (
        <Tag
            id={elementId || undefined}
            className={`wp-block-heading heading-${tag}`}
            style={{
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
            }}
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
            className="wp-block-image"
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
        return <div className="wp-block-divider wp-block-divider--gradient" style={vars} />;
    }
    return <hr className={cx('wp-block-divider', `wp-block-divider--${type === 'dashed' ? 'dashed' : 'solid'}`)} style={vars} />;
}

export function ButtonBlock({ label, href, variant, align, bg, color, radius, padY, padX, size, weight, css, isEditing }: any) {
    return (
        <div
            className="wp-block-button"
            style={blockVars('button', { align })}
        >
            <a
                href={href}
                className={cx('wp-block-button__link', `button-variant-${variant}`)}
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
 * components are also rendered by ContentRenderer/puckConfig with `{...props}` spread straight out of
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
 * The framework's own class always comes FIRST and is never replaced — a theme appends, so every
 * `.wp-block-*` selector, token and stylesheet hook keeps working on a container the theme has named.
 */
export function SectionBlock({ maxWidth, pad, bg, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'section');
    return (
        <Tag
            className={cx('wp-block-section', extraClass(className))}
            style={{
                ...blockVars('section', { pad: unit(pad), bg, 'max-width': maxWidth }),
                ...css,
            }}
        >
            <div className="wp-block-section__inner">
                {slot()}
            </div>
        </Tag>
    );
}

export function GridBlock({ columns, gap, columnsTablet, columnsMobile, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'div');
    return (
        <Tag
            className={cx('wp-block-grid', extraClass(className))}
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
            {slot("wp-block-grid__items")}
        </Tag>
    );
}

export function FlexRowBlock({ justify, align, gap, wrap, direction, css, slot, tag, className }: any) {
    const Tag = containerTag(tag, 'div');
    return (
        <Tag
            className={cx('wp-block-flex-row', extraClass(className))}
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
            {slot("wp-block-flex-row__items")}
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
            className={cx('wp-block-columns', extraClass(className))}
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
                        className="wp-block-columns__col"
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
            className={cx('wp-block-card', `card-theme-${theme}`)}
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
                <div className="wp-block-card__icon wp-block-card-icon">
                    <i className={`fa-solid ${icon}`}></i>
                </div>
            )}
            <h3 className="wp-block-card__title wp-block-card-title">{title}</h3>
            <p className="wp-block-card__description wp-block-card-description">{description}</p>
        </div>
    );
}

export function QuoteBlock({ text, cite, style, accent, size, color, quoteStyle, css }: any) {
    const vars = {
        ...blockVars('quote', {
            accent,
            size: unit(size),
            color,
            style: quoteStyle,
        }),
        ...css,
    };
    if (style === "large") {
        return (
            <figure className="wp-block-quote wp-block-quote--large" style={vars}>
                <i className="fa-solid fa-quote-left wp-block-quote__mark" aria-hidden="true"></i>
                <blockquote className="wp-block-quote__body">{text}</blockquote>
                {cite && <figcaption className="wp-block-quote__cite">— {cite}</figcaption>}
            </figure>
        );
    }
    return (
        <figure className="wp-block-quote wp-block-quote--bar" style={vars}>
            <blockquote className="wp-block-quote__body">
                {text}
                {cite && <footer className="wp-block-quote__cite">— {cite}</footer>}
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
            className={cx('wp-block-table', striped === "true" && 'wp-block-table--striped')}
            style={{ ...blockVars('table', { 'stripe-bg': stripeBg }), ...css }}
        >
            {/* Bare <table> — the WordJS UI framework styles it with theme tokens. */}
            <table className="wp-block-table__table">
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
            className="wp-block-icon-list"
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
                <div key={i} className="wp-block-icon-list__item">
                    <span className="wp-block-icon-list__icon">
                        <i className={`fa-solid ${it.icon || "fa-check"}`}></i>
                    </span>
                    <span>
                        <span className="wp-block-icon-list__title">{it.title}</span>
                        {it.text && <span className="wp-block-icon-list__text">{it.text}</span>}
                    </span>
                </div>
            ))}
        </div>
    );
}

export function SocialLinksBlock({ items, align, size, radius, bg, color, hoverBg, gap, css, isEditing }: any) {
    return (
        <div
            className="wp-block-social-links"
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
                    className="wp-block-social-links__link"
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
            className="wp-block-stats"
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
                <div key={i} className="wp-block-stats__item">
                    <div className="wp-block-stats__value">{it.value}</div>
                    <div className="wp-block-stats__label">{it.label}</div>
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
            className="wp-block-html-embed"
            style={css}
            suppressHydrationWarning
            dangerouslySetInnerHTML={{ __html: sanitizeHTML(html || "") }}
        />
    );
}

export function PricingTableBlock({ plans, accent, bg, pad, radius, gap, priceSize, highlightScale, css, isEditing }: any) {
    return (
        <div
            className="wp-block-pricing"
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
                    className={cx('wp-block-pricing__plan', plan.highlighted === "true" && 'wp-block-pricing__plan--highlighted')}
                >
                    <h3 className="wp-block-pricing__name">{plan.name}</h3>
                    <div className="wp-block-pricing__price">
                        {plan.price}
                        <span className="wp-block-pricing__period">{plan.period}</span>
                    </div>
                    <ul className="wp-block-pricing__features">
                        {plan.features?.split("\n").map((feature: string, i: number) => (
                            <li key={i} className="wp-block-pricing__feature">
                                <i className="fa-solid fa-check"></i>
                                {feature}
                            </li>
                        ))}
                    </ul>
                    <a
                        href={plan.buttonLink}
                        className="wp-block-pricing__button"
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
            className="wp-block-testimonial"
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
            <div className="wp-block-testimonial__mark" aria-hidden="true">&quot;</div>
            <p className="wp-block-testimonial__quote">{quote}</p>
            <div className="wp-block-testimonial__person">
                {avatar ? (
                    <img src={avatar} alt={author} className="wp-block-testimonial__avatar" />
                ) : (
                    // Initials fallback — the old default pointed at i.pravatar.cc (external
                    // request + random stranger's face on every fresh testimonial).
                    <div aria-hidden className="wp-block-testimonial__avatar wp-block-testimonial__avatar--initials">
                        {(author || "?").trim().charAt(0).toUpperCase()}
                    </div>
                )}
                <div>
                    <div className="wp-block-testimonial__author">{author}</div>
                    <div className="wp-block-testimonial__role">{role}</div>
                </div>
            </div>
        </div>
    );
}

export function CTABannerBlock({ title, subtitle, buttonText, buttonLink, variant, bg, color, pad, radius, titleSize, buttonBg, buttonColor, css, isEditing }: any) {
    return (
        <div
            className={cx('wp-block-cta-banner', `cta-variant-${variant || 'gradient'}`)}
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
            <h2 className="wp-block-cta-banner__title">{title}</h2>
            <p className="wp-block-cta-banner__subtitle">{subtitle}</p>
            <a
                href={buttonLink}
                className="wp-block-cta-banner__button"
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

    // A file served by THIS site plays inline in a real <video>, with no third party in
    // the request path at all. Restricted to a root-relative path: that is same-origin by
    // construction and safe to evaluate during SSR, where there is no window.location to
    // compare an absolute URL against. '//host/x' is protocol-relative (i.e. remote) and
    // is deliberately excluded.
    const isSelfHosted = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
    if (isSelfHosted) {
        return (
            <SelfHostedVideo
                src={url}
                poster={poster && poster.startsWith('/') && !poster.startsWith('//') ? poster : ''}
                vars={vars}
            />
        );
    }

    // Convert regular YouTube URLs to embed format
    let embedUrl = url;

    if (url?.includes("youtube.com/watch")) {
        const videoId = url.split("v=")[1]?.split("&")[0];
        embedUrl = `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`;
    } else if (url?.includes("youtu.be/")) {
        const videoId = url.split("youtu.be/")[1]?.split("?")[0];
        embedUrl = `https://www.youtube.com/embed/${videoId}?rel=0&modestbranding=1`;
    } else if (url?.includes("youtube.com/embed/")) {
        // Already an embed URL. Canonicalize the host to https://www.youtube.com so host
        // variants (bare youtube.com, m.youtube.com, http://) still pass the allowlist
        // below, preserving the existing embed UX, and add params if not present.
        const path = url.split("youtube.com/embed/")[1] || "";
        const hasQuery = path.includes("?");
        embedUrl = `https://www.youtube.com/embed/${hasQuery ? path : `${path}?rel=0&modestbranding=1`}`;
    } else if (url?.includes("vimeo.com/") && !url?.includes("player.vimeo.com")) {
        const videoId = url.split("vimeo.com/")[1]?.split("?")[0];
        embedUrl = `https://player.vimeo.com/video/${videoId}`;
    }

    // Validate the resolved embed URL against an allowlist of trusted embed
    // providers (mirrors lib/sanitize.ts isAllowedIframeSrc): require https and a
    // hostname in {www.youtube.com, player.vimeo.com}. Anything else (arbitrary src,
    // javascript:/data: schemes, non-embed hosts) renders a placeholder, never an iframe.
    const ALLOWED_EMBED_HOSTS = ["www.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "player.vimeo.com"];
    let isAllowedEmbed = false;
    try {
        const parsed = new URL(embedUrl);
        isAllowedEmbed = parsed.protocol === "https:" && ALLOWED_EMBED_HOSTS.includes(parsed.hostname.toLowerCase());
    } catch {
        isAllowedEmbed = false;
    }

    // Show placeholder if no URL or the URL is not a trusted embed
    if (!url || !isAllowedEmbed) {
        return (
            <div className="wp-block-video-embed" style={vars}>
                <div className="wp-block-video-embed__placeholder">
                    <div>
                        <i className="fa-solid fa-video" aria-hidden="true"></i>
                        <p>{url ? "Unsupported video URL (use YouTube or Vimeo)" : "Enter a video URL"}</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="wp-block-video-embed" style={vars}>
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
    const textAlign = align === "center" ? "center" : "left";
    return (
        <section
            id={elementId || undefined}
            className="wp-block-hero"
            style={{
                ...blockVars('hero', {
                    'bg-image': bgImage ? `url(${bgImage})` : undefined,
                    'gradient-from': gradientFrom,
                    'gradient-to': gradientTo,
                    'gradient-angle': gradientAngle ? `${gradientAngle}deg` : undefined,
                    height,
                    pad: unit(pad),
                    justify: align,
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
            {dim > 0 && <div className="wp-block-hero__overlay" aria-hidden="true" />}
            <div className="wp-block-hero__inner">
                <h1 className="wp-block-hero__title">{title}</h1>
                {subtitle && <p className="wp-block-hero__subtitle">{subtitle}</p>}
                {buttons?.length > 0 && (
                    <div className="wp-block-hero__actions">
                        {buttons.map((b: any, i: number) => (
                            <a
                                key={i}
                                href={b.href || "#"}
                                className={cx('wp-block-hero__button', b.variant === "outline" && 'wp-block-hero__button--outline')}
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

// Shared post-date formatter for the dynamic blocks (also used by puckConfig's editor paths).
export const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const fmtPostDate = (raw: string): string => {
    const d = new Date(String(raw).replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(raw) ? "" : "Z"));
    if (isNaN(d.getTime())) return "";
    return `${d.getUTCDate()} ${MESES_ES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * PostsGrid markup. `posts` arrives ALREADY RESOLVED: server-side via resolveDynamicBlocks on the
 * public site; from the useEditorPosts hook (which stays in puckConfig — client) in the editor.
 * The hook's public branch returns the injected list untouched, so passing it straight through
 * here is the same derivation, not a re-implementation.
 */
export function PostsGridBlock({ posts, columns, gap, bg, borderColor, radius, pad, thumbHeight, css, isEditing }: any) {
    const list: any[] = Array.isArray(posts) ? posts : [];
    if (!list.length) {
        return (
            <div className="wp-block-posts-grid__empty" style={css}>
                {isEditing
                    ? "Aquí se listarán tus entradas publicadas. Aún no hay ninguna."
                    : "No hay entradas publicadas todavía."}
            </div>
        );
    }

    return (
        <div
            className="wp-block-posts-grid"
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
                <article key={post.id} className="wp-block-posts-grid__card">
                    <div
                        className="wp-block-posts-grid__thumb"
                        aria-hidden="true"
                        style={post.image ? { backgroundImage: `url(${post.image})` } : undefined}
                    ></div>
                    {post.date && <div className="wp-block-posts-grid__date">{fmtPostDate(post.date)}</div>}
                    <h3 className="wp-block-posts-grid__title">
                        <a href={post.href} onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}>{post.title}</a>
                    </h3>
                    {post.excerpt && <p className="wp-block-posts-grid__excerpt">{post.excerpt}</p>}
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
        <h3 className="wp-block-category-posts__heading">
            <i className="fa-solid fa-folder" aria-hidden="true"></i> {categorySlug}
            {/* Say it out loud when the category matched nothing and this is really "latest
                posts" — silently showing unrelated entries under a category name is worse
                than showing none. */}
            {isEditing && resolvedFiltered === false && (
                <span className="wp-block-category-posts__note"> · sin entradas en esta categoría, mostrando las últimas</span>
            )}
        </h3>
    );

    if (!list.length) {
        return (
            <div className="wp-block-category-posts" style={vars}>
                {heading}
                <p className="wp-block-category-posts__empty">
                    {isEditing ? "Aún no hay entradas publicadas para mostrar aquí." : "No hay entradas en esta categoría."}
                </p>
            </div>
        );
    }

    if (layout === "grid") {
        return (
            <div className="wp-block-category-posts wp-block-category-posts--grid" style={vars}>
                {list.map((post) => (
                    <div key={post.id} className="wp-block-category-posts__card">
                        <h4 className="wp-block-category-posts__card-title">
                            <a href={post.href} onClick={isEditing ? (e: React.MouseEvent) => e.preventDefault() : undefined}>{post.title}</a>
                        </h4>
                        {post.excerpt && <p className="wp-block-category-posts__excerpt">{post.excerpt}</p>}
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="wp-block-category-posts" style={vars}>
            {heading}
            <ul className="wp-block-category-posts__list">
                {list.map((post) => (
                    <li key={post.id} className="wp-block-category-posts__item">
                        <a
                            href={post.href}
                            className="wp-block-category-posts__link"
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
            className="wp-block-spacer"
            style={{ ...blockVars('spacer', { height: unit(height) }), ...css }}
        />
    );
}

export function TextBlock({ content, elementId, color, size, leading, measure, css }: any) {
    return (
        <div
            id={elementId || undefined}
            className="wp-block-text prose max-w-none"
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
