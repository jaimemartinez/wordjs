/**
 * A hotel's position (conference-manager 2.23.0) from what an administrator pastes: a Google Maps link, an
 * OpenStreetMap link, a `geo:` URI or plain decimal coordinates («10.98765, -74.78123»). The server's copy of
 * client/lib/geo.ts (a test keeps the two equal). No network: a short link (maps.app.goo.gl, goo.gl/maps) does
 * not carry the position — resolving it would need the internet — so it is refused with a hint instead.
 *
 * parseGeo(text) → { ok: true, geo: 'lat,lng' } (6 decimals) | { ok: false, code: 'empty' | 'short_link' |
 * 'no_coords' | 'out_of_range' }.
 */
'use strict';

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';
// Most precise first: a place's pin (!3d…!4d…), then explicit query / destination / ll parameters, then the
// map's centre (@lat,lng), then OpenStreetMap's mlat/mlon and #map=z/lat/lng, then a bare pair or geo: URI.
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

function parseGeo(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return { ok: false, code: 'empty' };
    if (s.length > 2000) return { ok: false, code: 'no_coords' };
    if (SHORT_LINK.test(s)) return { ok: false, code: 'short_link' };
    let decoded;
    try { decoded = decodeURIComponent(s); } catch (e) { decoded = s; }
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

/** A stored 'lat,lng' → { lat, lng } | null. */
function geoPoint(geo) {
    const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(String(geo == null ? '' : geo));
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const GEO_MESSAGES = {
    short_link: 'Ese es un enlace corto de Google Maps y no trae la posición. Abre el enlace, copia la dirección completa de la barra del navegador (la que tiene @…) o, en Google Maps, haz clic derecho sobre el hotel y copia las coordenadas.',
    no_coords: 'No encontramos coordenadas. Pega el enlace completo de Google Maps (con @…) o las coordenadas, por ejemplo «10.98765, -74.78123».',
    out_of_range: 'Las coordenadas no son válidas: la latitud va de -90 a 90 y la longitud de -180 a 180.',
};

module.exports = { parseGeo, geoPoint, GEO_MESSAGES };
