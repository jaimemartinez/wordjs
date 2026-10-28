/**
 * Pure helpers behind MapView (no Leaflet, no DOM): coordinate checks, bounds, the HTML of each marker
 * variant and the attribution text. Kept apart so they are unit-tested without a browser and so a caller
 * (a plugin bundle, the portal) can validate data before handing it to the map.
 *
 * Everything that ends up inside Leaflet's innerHTML (marker labels, tooltips, colours, the attribution)
 * passes through here: labels, tooltips and attribution are escaped, colours are allowlisted. A plugin may pass values it
 * got from its users (a team name, an operator-set attribution), so nothing here trusts its input.
 */

export type LatLng = [number, number];

export type MarkerVariant = "pin" | "dot" | "badge" | "vertex" | "pulse";

export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const DEFAULT_TILE_ATTRIBUTION = "© OpenStreetMap";
/** Bogotá — the default view when a map gets neither a center nor points to fit. */
export const DEFAULT_CENTER: LatLng = [4.711, -74.072];
export const DEFAULT_ZOOM = 12;
export const DEFAULT_COLOR = "#2563eb";

/** A finite [lat, lng] inside the valid ranges. */
export function isValidLatLng(p: unknown): p is LatLng {
    return Array.isArray(p) && p.length >= 2
        && typeof p[0] === "number" && typeof p[1] === "number"
        && Number.isFinite(p[0]) && Number.isFinite(p[1])
        && p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180;
}

/** The valid points of a list, in order (anything else is dropped, never thrown on). */
export function validPoints(points: unknown): LatLng[] {
    if (!Array.isArray(points)) return [];
    return points.filter(isValidLatLng).map((p) => [p[0], p[1]] as LatLng);
}

/** [[south, west], [north, east]] of the valid points, or null when there are none. */
export function boundsOf(points: unknown): [LatLng, LatLng] | null {
    const pts = validPoints(points);
    if (!pts.length) return null;
    let s = 90, w = 180, n = -90, e = -180;
    for (const [lat, lng] of pts) {
        if (lat < s) s = lat;
        if (lat > n) n = lat;
        if (lng < w) w = lng;
        if (lng > e) e = lng;
    }
    return [[s, w], [n, e]];
}

export function escapeHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * A marker's tooltip content as Leaflet must receive it. Leaflet's DivOverlay assigns STRING content to
 * innerHTML, and a title is often typed by someone else (a leader's name, a contact's name from a public
 * portal, a place name), so the title is escaped here: the tooltip shows it as literal text and no markup
 * it carries is ever parsed. MapView never hands Leaflet a raw title.
 */
export function tooltipText(title: unknown): string {
    return escapeHtml(title);
}

/**
 * A colour safe to place inside a style attribute: #rgb / #rrggbb / #rrggbbaa, or rgb()/rgba()/hsl()/hsla()
 * with numeric arguments only. Anything else (a `url(`, a `;`, an expression) becomes the fallback.
 */
export function safeColor(c: unknown, fallback: string = DEFAULT_COLOR): string {
    if (typeof c !== "string") return fallback;
    const v = c.trim();
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
    if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/-]+\)$/i.test(v)) return v;
    return fallback;
}

/**
 * The attribution as HTML Leaflet can show: the operator's text escaped (no markup reaches the page), with
 * the usual "(c)" / "&copy;" spellings turned into ©. Empty → the OpenStreetMap credit, which the default
 * tile server's usage policy requires.
 */
export function attributionHtml(text: unknown): string {
    const raw = typeof text === "string" ? text.trim() : "";
    const t = (raw || DEFAULT_TILE_ATTRIBUTION).slice(0, 200).replace(/&copy;|\(c\)/gi, "©");
    return escapeHtml(t);
}

/**
 * Whether `url` is a tile URL template a map may use: https only (the site CSP allows https images), with
 * {z} {x} {y}, optionally {s} and {r} and no other placeholder (Leaflet would fill one from its options), and
 * no user name or password. The same rules as the server's check of the site setting (backend core/map-tiles).
 */
export function isValidTileUrl(url: unknown): url is string {
    if (typeof url !== "string") return false;
    const v = url.trim();
    if (v.length > 512 || !/^https:\/\/[^\s"'<>\`]+$/i.test(v)) return false;
    const names = Array.from(v.matchAll(/\{([^{}]*)\}/g), (m) => m[1]);
    if (!names.every((n) => ["s", "z", "x", "y", "r"].includes(n))) return false;
    if (!["z", "x", "y"].every((n) => names.includes(n))) return false;
    const filled = v.replace(/\{(?:s|z|x|y|r)\}/g, "0");
    if (/[{}]/.test(filled)) return false;
    let parsed: URL;
    try { parsed = new URL(filled); } catch { return false; }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return false;
    const authority = filled.slice("https://".length).split(/[/?#]/)[0];
    return !!authority && authority.toLowerCase() === parsed.host;
}

/** A tile URL template Leaflet may fetch (isValidTileUrl); anything else falls back to the OpenStreetMap standard tiles. */
export function safeTileUrl(url: unknown): string {
    return isValidTileUrl(url) ? url.trim() : DEFAULT_TILE_URL;
}

export interface MarkerIconSpec {
    html: string;
    size: [number, number];
    anchor: [number, number];
}

function pinSvg(color: string): string {
    return `<svg width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 1C7.3 1 1 7.2 1 14.9 1 25.3 15 39 15 39s14-13.7 14-24.1C29 7.2 22.7 1 15 1z" fill="${color}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="#fff"/></svg>`;
}

/**
 * The divIcon HTML, size and anchor of a marker variant. `label` is shown only by "badge" (max 4 visible
 * characters) and is escaped; the colour is allowlisted. The anchor is where the coordinate sits: the tip
 * for a pin, the centre for the rest.
 */
export function markerIconSpec(variant: MarkerVariant | undefined, color: unknown, label?: unknown): MarkerIconSpec {
    const c = safeColor(color);
    switch (variant) {
        case "dot":
            return { html: `<div class="wjs-map-dot" style="--c:${c}"></div>`, size: [16, 16], anchor: [8, 8] };
        case "vertex":
            // A 28px transparent hit area around a 14px handle: draggable on a phone without a stylus.
            return { html: `<div class="wjs-map-hit"><div class="wjs-map-vertex" style="--c:${c}"></div></div>`, size: [28, 28], anchor: [14, 14] };
        case "pulse":
            return { html: `<div class="wjs-map-hit"><div class="wjs-map-pulse" style="--c:${c}"></div></div>`, size: [28, 28], anchor: [14, 14] };
        case "badge": {
            const text = String(label ?? "").slice(0, 4);
            const w = Math.max(30, 14 + text.length * 8);
            return { html: `<div class="wjs-map-badge" style="--c:${c};min-width:${w}px">${escapeHtml(text)}</div>`, size: [w, 30], anchor: [Math.round(w / 2), 15] };
        }
        case "pin":
        default:
            return { html: `<div class="wjs-map-pin">${pinSvg(c)}</div>`, size: [30, 40], anchor: [15, 39] };
    }
}

/** Styles of the marker variants (scoped class names), appended to the Leaflet stylesheet MapView injects. */
export const MARKER_CSS = `
.wjs-map-root .leaflet-container{font-family:inherit;background:#e5e7eb}
.wjs-map-root.wjs-map-crosshair .leaflet-container{cursor:crosshair}
.wjs-map-root .leaflet-div-icon{background:transparent;border:0}
.wjs-map-hit{width:28px;height:28px;display:flex;align-items:center;justify-content:center}
.wjs-map-dot{width:14px;height:14px;border-radius:50%;background:var(--c);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);box-sizing:content-box}
.wjs-map-vertex{width:12px;height:12px;border-radius:4px;background:#fff;border:3px solid var(--c);box-shadow:0 1px 3px rgba(0,0,0,.3);box-sizing:content-box}
.wjs-map-pulse{width:14px;height:14px;border-radius:50%;background:var(--c);border:3px solid #fff;box-sizing:content-box;animation:wjs-map-pulse 2s ease-out infinite}
@keyframes wjs-map-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--c) 55%,transparent)}70%{box-shadow:0 0 0 14px rgba(0,0,0,0)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}
.wjs-map-badge{height:26px;padding:0 6px;border-radius:999px;background:var(--c);color:#fff;font:800 12px/26px system-ui,-apple-system,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap;box-sizing:content-box}
.wjs-map-pin svg{display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
@media (prefers-reduced-motion: reduce){.wjs-map-pulse{animation:none}}
`;
