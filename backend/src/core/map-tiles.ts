/**
 * The tile server every map on the site draws from (Settings → General → «Maps»), ZERO CONFIG: the host
 * module `components/map/MapView` used the OpenStreetMap standard tile layer and nothing else, so a site
 * that must not send its visitors' addresses to openstreetmap.org (or that outgrows the OSM tile usage
 * policy) had no way to point its maps at another server. Empty means that default.
 *
 * Both options are PUBLIC (routes/settings PUBLIC_SETTINGS): public pages draw maps too, and the template is
 * no secret — every visitor's browser requests it for each tile. That is also why a template may not carry
 * credentials: whatever is in it is handed to every visitor.
 *
 * Tiles are <img> requests, so an `https:` template is always inside the page CSP's `img-src … https:`; the
 * CSP needs no per-origin change. The frontend's safeTileUrl (components/map/mapUtils) applies the same rules
 * again before Leaflet sees a template, so a value written around this check still cannot reach the page.
 */

const MAP_TILE_URL_OPTION = 'map_tile_url';
const MAP_TILE_ATTRIBUTION_OPTION = 'map_tile_attribution';
const MAX_TILE_URL_LENGTH = 512;
const MAX_TILE_ATTRIBUTION_LENGTH = 200;
/** The placeholders Leaflet fills from the tile coordinates; {s} picks a subdomain, {r} the "@2x" suffix. */
const TILE_PLACEHOLDERS = new Set(['s', 'z', 'x', 'y', 'r']);

/** Why `value` cannot be the site's tile URL template, or null ('' = the OpenStreetMap default). */
function tileUrlProblem(value: unknown): string | null {
    if (value === '' || value === null || value === undefined) return null;
    const bad = `${MAP_TILE_URL_OPTION} must be an https:// URL template with {z}, {x} and {y} (and optionally {s} or {r}), up to ${MAX_TILE_URL_LENGTH} characters, with no user name or password in it.`;
    if (typeof value !== 'string') return bad;
    const v = value.trim();
    if (v.length > MAX_TILE_URL_LENGTH || !/^https:\/\/[^\s"'<>\\`]+$/i.test(v)) return bad;
    const names = [...v.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    if (!names.every((n) => TILE_PLACEHOLDERS.has(n))) return bad;
    if (!['z', 'x', 'y'].every((n) => names.includes(n))) return bad;
    // Stray braces left after the placeholders are taken out ("{{z}", "{z") are not a template.
    const filled = v.replace(/\{(?:s|z|x|y|r)\}/g, '0');
    if (/[{}]/.test(filled)) return bad;
    let url: URL;
    try { url = new URL(filled); } catch { return bad; }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return bad;
    // The host must be what is written after https:// — the URL parser reads "https:///0/0/0" as host "0".
    const authority = filled.slice('https://'.length).split(/[/?#]/)[0];
    if (!authority || authority.toLowerCase() !== url.host) return bad;
    return null;
}

/** Why `value` cannot be the attribution shown on the maps, or null ('' = the OpenStreetMap credit). */
function tileAttributionProblem(value: unknown): string | null {
    if (value === '' || value === null || value === undefined) return null;
    // The map shows it as plain text (mapUtils.attributionHtml escapes it); control characters have no place in it.
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || value.trim().length > MAX_TILE_ATTRIBUTION_LENGTH || /[\u0000-\u001f\u007f]/.test(value.trim())) {
        return `${MAP_TILE_ATTRIBUTION_OPTION} must be one line of text of up to ${MAX_TILE_ATTRIBUTION_LENGTH} characters.`;
    }
    return null;
}

/** The stored form: trimmed text ('' clears the option back to the default). */
function normalizedTileSetting(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
    MAP_TILE_URL_OPTION, MAP_TILE_ATTRIBUTION_OPTION, MAX_TILE_URL_LENGTH, MAX_TILE_ATTRIBUTION_LENGTH,
    tileUrlProblem, tileAttributionProblem, normalizedTileSetting,
};
