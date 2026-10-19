/**
 * A small map of one point (conference-manager 2.23.0, «Mi inscripción»): OpenStreetMap tiles drawn as plain
 * images around the point, with a pin on it — no map script, no iframe (the site's security policy allows images
 * from https, not third-party frames). The tiles' credit is shown, as OpenStreetMap's tile policy asks, and the
 * images send only this site's origin as Referer (the page itself sends none).
 */
import React from "react";

const TILE = 256;
const ZOOM = 16;

/** Fractional tile coordinates of a point at a zoom level (Web Mercator, the slippy-map scheme). */
export function tileOf(lat: number, lng: number, zoom = ZOOM): { x: number; y: number } {
    const n = 2 ** zoom;
    const latRad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
    return {
        x: ((lng + 180) / 360) * n,
        y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
    };
}

/** The tiles around a point: 5 columns × 3 rows, each with its offset (px) from the point. */
export function tilesAround(lat: number, lng: number, zoom = ZOOM): { key: string; src: string; dx: number; dy: number }[] {
    const t = tileOf(lat, lng, zoom);
    const ix = Math.floor(t.x), iy = Math.floor(t.y);
    const n = 2 ** zoom;
    const out: { key: string; src: string; dx: number; dy: number }[] = [];
    for (let row = iy - 1; row <= iy + 1; row++) {
        if (row < 0 || row >= n) continue;
        for (let col = ix - 2; col <= ix + 2; col++) {
            const wrapped = ((col % n) + n) % n;
            out.push({
                key: `${col}/${row}`,
                src: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${row}.png`,
                dx: Math.round((col - t.x) * TILE),
                dy: Math.round((row - t.y) * TILE),
            });
        }
    }
    return out;
}

export function OsmMap({ lat, lng, label }: { lat: number; lng: number; label: string }) {
    const tiles = tilesAround(lat, lng);
    return (
        <div className="relative w-full overflow-hidden rounded-2xl bg-gray-100 border border-gray-200" style={{ height: 220 }} role="img" aria-label={label} data-osm-map="">
            {tiles.map((t) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={t.key} src={t.src} alt="" width={TILE} height={TILE} loading="lazy" decoding="async" draggable={false}
                    referrerPolicy="strict-origin-when-cross-origin"
                    style={{ position: "absolute", left: `calc(50% + ${t.dx}px)`, top: `calc(50% + ${t.dy}px)`, width: TILE, height: TILE, maxWidth: "none", userSelect: "none" }} />
            ))}
            {/* The pin: its tip on the point. */}
            <svg width="34" height="44" viewBox="0 0 34 44" aria-hidden="true" style={{ position: "absolute", left: "calc(50% - 17px)", top: "calc(50% - 43px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" }}>
                <path d="M17 1C8.2 1 1 8 1 16.7 1 28.4 17 43 17 43s16-14.6 16-26.3C33 8 25.8 1 17 1z" fill="#dc2626" stroke="#fff" strokeWidth="2" />
                <circle cx="17" cy="16.5" r="6" fill="#fff" />
            </svg>
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer"
                className="absolute right-0 bottom-0 bg-white/85 px-1.5 py-0.5 text-[10px] text-gray-700 rounded-tl-md">© OpenStreetMap</a>
        </div>
    );
}
