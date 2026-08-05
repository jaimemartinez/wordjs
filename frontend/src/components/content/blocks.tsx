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

export function HeadingBlock({ title, level, elementId, color, size, weight, tracking, css }: any) {
    const Tag = level as any;
    return (
        <Tag
            id={elementId || undefined}
            className={`wp-block-heading heading-${level}`}
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
 * CONTAINER blocks: the slot arrives as a render function `(className?) => ReactNode` so both
 * surfaces keep their own slot machinery — the editor passes Puck's slot component, the public
 * ContentRenderer passes a plain wrapper div with recursively rendered items (same DOM: Puck's
 * SlotRender emits `<div className>…</div>`).
 */
export function SectionBlock({ maxWidth, pad, bg, css, slot }: any) {
    return (
        <section
            className="wp-block-section"
            style={{
                ...blockVars('section', { pad: unit(pad), bg, 'max-width': maxWidth }),
                ...css,
            }}
        >
            <div className="wp-block-section__inner">
                {slot()}
            </div>
        </section>
    );
}

export function GridBlock({ columns, gap, columnsTablet, columnsMobile, css, slot }: any) {
    return (
        <div
            className="wp-block-grid"
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
        </div>
    );
}

export function FlexRowBlock({ justify, align, gap, wrap, direction, css, slot }: any) {
    return (
        <div
            className="wp-block-flex-row"
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
        </div>
    );
}

export function ColumnsBlock({ distribution, columnStyles, gap, minHeight, bg, radius, elementId, css, slots }: any) {
    const dist = distribution || { columnCount: 2, widths: [50, 50] };
    const columnCount = dist.columnCount || 2;
    const widths = dist.widths || [50, 50];
    const styles = columnStyles || [];

    // The mobile stack used to need a per-instance <style> tag (and a React.useId to keep
    // its class name identical across SSR and hydration). The contract's own media query
    // does it for every Columns block, so the injected stylesheet is gone.
    return (
        <div
            id={elementId || undefined}
            className="wp-block-columns"
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
        </div>
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
