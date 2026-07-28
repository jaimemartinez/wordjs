/**
 * Material Symbols Outlined glyph (ligature-based), per the Stitch editor design.
 *
 * The font is a NAMED-ICON SUBSET self-hosted at /fonts/material-symbols-outlined-subset.woff2
 * (see puck-theme.css). A `name` that is not in the subset renders as an empty box — regenerate
 * the subset (css2 API `icon_names=` param) when introducing a new glyph.
 */
export default function MSym({
    name,
    size = 20,
    fill = false,
    className = "",
}: {
    name: string;
    size?: number;
    fill?: boolean;
    className?: string;
}) {
    return (
        <span
            aria-hidden="true"
            className={`msym ${className}`}
            style={{
                fontSize: size,
                ...(fill ? { fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24" } : {}),
            }}
        >
            {name}
        </span>
    );
}
