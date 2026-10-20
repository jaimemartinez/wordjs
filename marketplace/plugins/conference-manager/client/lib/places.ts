/**
 * Place search and map tiles for the hotel form (2.24.0): find a hotel by name or address and pin it on a map.
 *
 * Search = OpenStreetMap's Nominatim (nominatim.openstreetmap.org), called from the admin's browser (it answers
 * `Access-Control-Allow-Origin: *`; the site's CSP allows https connections). Its usage policy: at most ONE
 * request per second and no search-as-you-type — so the form searches only on an explicit «Buscar» and
 * `searchPlaces` spaces calls ≥ 1.1 s apart page-wide. The browser's Referer identifies the site, as the policy
 * asks; only the text typed is sent. Results come in Spanish, limited to the admin's country when the browser's
 * language names one (es-CO → co).
 *
 * Map = OpenStreetMap's standard tiles (Web Mercator «slippy map» scheme), drawn as images by the picker.
 * Everything except `searchPlaces` is pure, for the tests.
 */

export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
export const NOMINATIM_MIN_GAP_MS = 1100;
export const TILE_SIZE = 256;
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;

export type Place = { id: string; title: string; subtitle: string; label: string; lat: number; lng: number };
export type LatLng = { lat: number; lng: number };

/** The country to limit a search to, from the browser's language («es-CO» → «co»), or '' (anywhere). */
export function countryFromLocale(locale: string | null | undefined): string {
    const m = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return m ? m[1].toLowerCase() : '';
}

export function nominatimUrl(query: string, countryCodes = ''): string {
    const qs = new URLSearchParams({ format: 'jsonv2', limit: '6', q: query, 'accept-language': 'es', addressdetails: '0' });
    if (countryCodes) qs.set('countrycodes', countryCodes);
    return `${NOMINATIM_SEARCH_URL}?${qs.toString()}`;
}

/** A display name as a title and a short subtitle («Hotel El Prado» / «Carrera 54, El Prado, Barranquilla»). */
export function splitPlaceLabel(displayName: string, name?: string | null, country = ''): { title: string; subtitle: string } {
    const parts = String(displayName || '').split(',').map((s) => s.trim()).filter(Boolean)
        .filter((p, i, all) => !(i === all.length - 1 && country) && !/^\d{4,6}$/.test(p));
    const own = String(name || '').trim();
    const title = own || parts[0] || 'Lugar sin nombre';
    const rest = parts.filter((p, i) => !(i === 0 && p === title));
    return { title, subtitle: rest.slice(0, 4).join(', ') };
}

const isLatLng = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Nominatim's JSON → places (bad rows dropped, never thrown on). */
export function parseNominatim(body: unknown, country = ''): Place[] {
    if (!Array.isArray(body)) return [];
    const out: Place[] = [];
    for (const row of body) {
        if (!row || typeof row !== 'object') continue;
        const r = row as { place_id?: unknown; display_name?: unknown; lat?: unknown; lon?: unknown; name?: unknown };
        const lat = Number(r.lat), lng = Number(r.lon);
        if (!isLatLng(lat, lng)) continue;
        const label = typeof r.display_name === 'string' ? r.display_name : '';
        const { title, subtitle } = splitPlaceLabel(label, typeof r.name === 'string' ? r.name : '', country);
        out.push({ id: String(r.place_id ?? `${lat},${lng}`), title, subtitle, label, lat, lng });
    }
    return out;
}

let nextAt = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Search a place (explicit searches only). Calls are spaced ≥ 1.1 s apart; one made sooner waits its turn.
 * Throws an Error whose message is Spanish text for the screen.
 */
export async function searchPlaces(query: string, countryCodes = ''): Promise<Place[]> {
    const q = String(query || '').replace(/\s+/g, ' ').trim();
    if (q.length < 3) throw new Error('Escribe al menos 3 letras del nombre o la dirección del hotel.');
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + NOMINATIM_MIN_GAP_MS;
    if (at > now) await wait(at - now);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    let res: Response;
    try {
        res = await fetch(nominatimUrl(q.slice(0, 200), countryCodes), { signal: ctrl?.signal, credentials: 'omit', headers: { Accept: 'application/json' } });
    } catch {
        throw new Error('No se pudo conectar con el buscador de lugares. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
        if (timer) clearTimeout(timer);
    }
    if (res.status === 429) throw new Error('El buscador de lugares está recibiendo demasiadas búsquedas. Espera un momento e inténtalo de nuevo.');
    if (!res.ok) throw new Error('El buscador de lugares no respondió. Inténtalo de nuevo en un momento.');
    return parseNominatim(await res.json().catch(() => null), countryCodes);
}

// ── map tiles (Web Mercator) ──
/** Fractional tile coordinates of a point. */
export function tileOf(p: LatLng, zoom: number): { x: number; y: number } {
    const n = 2 ** zoom;
    const lat = Math.max(-85.05112878, Math.min(85.05112878, p.lat));
    const r = (lat * Math.PI) / 180;
    return { x: ((p.lng + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
/** The point at fractional tile coordinates (the inverse of tileOf). */
export function pointOf(t: { x: number; y: number }, zoom: number): LatLng {
    const n = 2 ** zoom;
    const lng = (t.x / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n))) * 180) / Math.PI;
    return { lat, lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
}
/** The tiles covering a `w`×`h` px view centred on `center`, each with its top-left position in the view. */
export function tilesFor(center: LatLng, zoom: number, w: number, h: number): { key: string; src: string; left: number; top: number }[] {
    const c = tileOf(center, zoom);
    const n = 2 ** zoom;
    const x0 = Math.floor(c.x - w / 2 / TILE_SIZE), x1 = Math.floor(c.x + w / 2 / TILE_SIZE);
    const y0 = Math.max(0, Math.floor(c.y - h / 2 / TILE_SIZE)), y1 = Math.min(n - 1, Math.floor(c.y + h / 2 / TILE_SIZE));
    const out: { key: string; src: string; left: number; top: number }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const wx = ((x % n) + n) % n;
        out.push({ key: `${zoom}/${x}/${y}`, src: `https://tile.openstreetmap.org/${zoom}/${wx}/${y}.png`, left: Math.round(w / 2 + (x - c.x) * TILE_SIZE), top: Math.round(h / 2 + (y - c.y) * TILE_SIZE) });
    }
    return out;
}
/** Where a point falls in a `w`×`h` view centred on `center` (px). */
export function pixelOf(p: LatLng, center: LatLng, zoom: number, w: number, h: number): { x: number; y: number } {
    const a = tileOf(p, zoom), c = tileOf(center, zoom);
    return { x: w / 2 + (a.x - c.x) * TILE_SIZE, y: h / 2 + (a.y - c.y) * TILE_SIZE };
}
/** The point under a pixel of a `w`×`h` view centred on `center`. */
export function pointAtPixel(px: number, py: number, center: LatLng, zoom: number, w: number, h: number): LatLng {
    const c = tileOf(center, zoom);
    return pointOf({ x: c.x + (px - w / 2) / TILE_SIZE, y: c.y + (py - h / 2) / TILE_SIZE }, zoom);
}
