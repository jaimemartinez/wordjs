/**
 * A hotel's position (2.23.0) from what an administrator pastes — the browser's copy of server/geo.js (a test
 * keeps the two equal), so the hotel form shows at once what the server will store. See the server file.
 */

export type GeoResult = { ok: true; geo: string } | { ok: false; code: 'empty' | 'short_link' | 'no_coords' | 'out_of_range' };

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
const PATTERNS = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|destination|daddr|ll|center|sll)=(?:loc:)?${NUM}(?:,|%2C)\\s*${NUM}`, 'i'),
    new RegExp(`/maps/(?:place|search|dir)/(?:[^/]*/)*?${NUM},\\s*${NUM}`, 'i'),
    new RegExp(`@${NUM},${NUM}`),
    new RegExp(`[?&]mlat=${NUM}&mlon=${NUM}`, 'i'),
    new RegExp(`#map=\\d{1,2}/${NUM}/${NUM}`, 'i'),
    new RegExp(`^geo:${NUM},${NUM}`, 'i'),
    new RegExp(`^${NUM}\\s*[,;\\s]\\s*${NUM}$`),
];
const SHORT_LINK = /^(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\b/i;

export function parseGeo(text: unknown): GeoResult {
    const s = String(text ?? '').trim();
    if (!s) return { ok: false, code: 'empty' };
    if (s.length > 2000) return { ok: false, code: 'no_coords' };
    if (SHORT_LINK.test(s)) return { ok: false, code: 'short_link' };
    let decoded: string;
    try { decoded = decodeURIComponent(s); } catch { decoded = s; }
    for (const re of PATTERNS) {
        const m = decoded.match(re);
        if (!m) continue;
        const lat = Number(m[1]), lng = Number(m[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, code: 'out_of_range' };
        if (lat === 0 && lng === 0) return { ok: false, code: 'no_coords' };
        return { ok: true, geo: `${lat.toFixed(6)},${lng.toFixed(6)}` };
    }
    return { ok: false, code: 'no_coords' };
}

export const GEO_MESSAGES: Record<'short_link' | 'no_coords' | 'out_of_range', string> = {
    short_link: 'Ese es un enlace corto de Google Maps y no trae la posición. Abre el enlace, copia la dirección completa de la barra del navegador (la que tiene @…) o, en Google Maps, haz clic derecho sobre el hotel y copia las coordenadas.',
    no_coords: 'No encontramos coordenadas. Pega el enlace completo de Google Maps (con @…) o las coordenadas, por ejemplo «10.98765, -74.78123».',
    out_of_range: 'Las coordenadas no son válidas: la latitud va de -90 a 90 y la longitud de -180 a 180.',
};

/** Google Maps at a position (opens the app on a phone). */
export const mapsUrl = (geo: string): string => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(geo)}`;
