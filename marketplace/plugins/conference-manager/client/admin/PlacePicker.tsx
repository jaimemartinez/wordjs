// @ts-nocheck — backend plugin client source; bundled by the plugin loader, not type-checked by the frontend.
"use client";

/**
 * The hotel's place (2.24.0): search it by name or address («Buscar» — OpenStreetMap's Nominatim, see
 * lib/places.ts), pick a result, and fine-tune the pin on the map: drag the map to move around, the buttons (or
 * a double click) to zoom, a click to put the pin there. A Google Maps link or coordinates can still be pasted
 * (lib/geo.ts). The value is the form's `location` text: 'lat,lng' once a point is chosen.
 *
 * The map is OpenStreetMap's tiles drawn as images (no map script, no frame), with their credit.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseGeo, GEO_MESSAGES, mapsUrl } from "../lib/geo";
import { countryFromLocale, MAX_ZOOM, MIN_ZOOM, pixelOf, pointAtPixel, searchPlaces, tilesFor, type LatLng, type Place } from "../lib/places";

const MAP_H = 260;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const geoText = (p: LatLng) => `${round6(p.lat).toFixed(6)},${round6(p.lng).toFixed(6)}`;
const pinOf = (location: string): LatLng | null => {
    const g = parseGeo(location);
    if (!g.ok) return null;
    const [lat, lng] = g.geo.split(',').map(Number);
    return { lat, lng };
};

export function PlacePicker({ location, onLocation, initialQuery, onAddress, tx }: {
    location: string;
    onLocation: (v: string) => void;
    initialQuery: string;
    onAddress?: (address: string) => void;
    tx: (k: string, fb: string) => string;
}) {
    const pin = pinOf(location);
    const country = useMemo(() => countryFromLocale(typeof navigator !== 'undefined' ? navigator.language : ''), []);
    const [query, setQuery] = useState(initialQuery || '');
    const [results, setResults] = useState<Place[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [error, setError] = useState('');
    const [paste, setPaste] = useState(false);
    // The map's view: centred on the pin, else on the country (Colombia when the browser says so), else the world.
    const [view, setView] = useState<{ center: LatLng; zoom: number }>(() => pin ? { center: pin, zoom: 16 }
        : country === 'co' ? { center: { lat: 4.6, lng: -74.1 }, zoom: 5 } : { center: { lat: 15, lng: 0 }, zoom: 3 });
    const boxRef = useRef<HTMLDivElement | null>(null);
    const [w, setW] = useState(400);
    useEffect(() => {
        const el = boxRef.current;
        if (!el) return undefined;
        const measure = () => setW(Math.max(200, Math.round(el.getBoundingClientRect().width)));
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const run = async () => {
        if (searching) return;
        setError(''); setSearching(true);
        try {
            const found = await searchPlaces(query, country);
            setResults(found);
            if (!found.length) setError(tx('hotel.place.none', 'No encontramos ese lugar. Prueba con el nombre del hotel y la ciudad, o pon el punto en el mapa.'));
        } catch (e: any) { setResults(null); setError(e?.message || 'Error'); }
        finally { setSearching(false); }
    };
    const pick = (p: Place) => {
        onLocation(geoText(p));
        setView({ center: { lat: p.lat, lng: p.lng }, zoom: 17 });
        setResults(null);
        if (onAddress && p.subtitle) onAddress(p.subtitle);
    };

    // ── drag to pan, click to pin ──
    const drag = useRef<{ x: number; y: number; center: LatLng; moved: boolean } | null>(null);
    const onDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, center: view.center, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: React.PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 5) return;
        d.moved = true;
        setView((v) => ({ ...v, center: pointAtPixel(w / 2 - dx, MAP_H / 2 - dy, d.center, v.zoom, w, MAP_H) }));
    };
    const onUp = (e: React.PointerEvent) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onLocation(geoText(pointAtPixel(e.clientX - rect.left, e.clientY - rect.top, view.center, view.zoom, w, MAP_H)));
    };
    const zoomBy = (dz: number) => setView((v) => ({ ...v, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom + dz)) }));

    const tiles = tilesFor(view.center, view.zoom, w, MAP_H);
    const pinPx = pin ? pixelOf(pin, view.center, view.zoom, w, MAP_H) : null;
    const g = parseGeo(location);
    const btn = "min-h-[36px] px-3 rounded-xl bg-white border-2 border-gray-100 text-gray-700 hover:border-blue-500 hover:text-blue-600 font-black text-[10px] uppercase tracking-widest";
    return (
        <div className="space-y-2" data-place-picker="">
            <label htmlFor="cm-hotel-search" className="block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1">{tx('hotel.location', 'Ubicación en el mapa')}</label>
            <div className="flex gap-2">
                <input id="cm-hotel-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tx('hotel.place.placeholder', 'Nombre del hotel o dirección y ciudad')}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void run(); } }} autoComplete="off"
                    className="min-w-0 flex-1 border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 outline-none text-gray-900 font-bold text-sm placeholder:text-gray-300" />
                <button type="button" onClick={() => void run()} disabled={searching || query.trim().length < 3} data-place-search=""
                    className="shrink-0 px-4 rounded-2xl bg-gray-900 text-white font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 disabled:opacity-40">
                    {searching ? <i className="fa-solid fa-spinner animate-spin" aria-hidden="true"></i> : <><i className="fa-solid fa-magnifying-glass mr-1.5" aria-hidden="true"></i>{tx('hotel.place.search', 'Buscar')}</>}
                </button>
            </div>
            {error && <p className="text-[11px] font-bold text-amber-700 ml-1" role="alert">{error}</p>}
            {results && results.length > 0 && (
                <ul className="rounded-2xl border border-gray-100 bg-white divide-y divide-gray-100 overflow-hidden" data-place-results="">
                    {results.map((r) => (
                        <li key={r.id}>
                            <button type="button" onClick={() => pick(r)} className="w-full text-left px-4 py-2.5 hover:bg-blue-50">
                                <span className="block text-sm font-black text-gray-900">{r.title}</span>
                                {r.subtitle && <span className="block text-[11px] text-gray-500">{r.subtitle}</span>}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div ref={boxRef} className="relative w-full overflow-hidden rounded-2xl border-2 border-gray-100 bg-gray-100 select-none touch-none cursor-crosshair"
                style={{ height: MAP_H }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { drag.current = null; }}
                onDoubleClick={(e) => { e.preventDefault(); zoomBy(1); }} data-place-map="" role="application"
                aria-label={tx('hotel.place.map', 'Mapa: arrastra para moverte y haz clic para poner el punto del hotel')}>
                {tiles.map((t) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={t.key} src={t.src} alt="" width={256} height={256} draggable={false} referrerPolicy="strict-origin-when-cross-origin"
                        style={{ position: 'absolute', left: t.left, top: t.top, width: 256, height: 256, maxWidth: 'none', pointerEvents: 'none' }} />
                ))}
                {pinPx && (
                    <svg width="30" height="40" viewBox="0 0 34 44" aria-hidden="true" data-place-pin=""
                        style={{ position: 'absolute', left: pinPx.x - 15, top: pinPx.y - 39, pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' }}>
                        <path d="M17 1C8.2 1 1 8 1 16.7 1 28.4 17 43 17 43s16-14.6 16-26.3C33 8 25.8 1 17 1z" fill="#dc2626" stroke="#fff" strokeWidth="2" />
                        <circle cx="17" cy="16.5" r="6" fill="#fff" />
                    </svg>
                )}
                <div className="absolute right-2 top-2 flex flex-col gap-1" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
                    <button type="button" onClick={() => zoomBy(1)} aria-label={tx('hotel.place.zoomin', 'Acercar')} className="w-9 h-9 rounded-lg bg-white shadow border border-gray-200 text-gray-700 font-black">+</button>
                    <button type="button" onClick={() => zoomBy(-1)} aria-label={tx('hotel.place.zoomout', 'Alejar')} className="w-9 h-9 rounded-lg bg-white shadow border border-gray-200 text-gray-700 font-black">−</button>
                </div>
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}
                    className="absolute right-0 bottom-0 bg-white/85 px-1.5 py-0.5 text-[10px] text-gray-700 rounded-tl-md">© OpenStreetMap</a>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {g.ok ? (
                    <>
                        <span className="text-[11px] font-bold text-emerald-700" data-hotel-geo={g.geo}><i className="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>{g.geo.replace(',', ', ')}</span>
                        {pin && <button type="button" className={btn} onClick={() => setView({ center: pin, zoom: Math.max(view.zoom, 16) })}>{tx('hotel.place.center', 'Centrar')}</button>}
                        <a href={mapsUrl(g.geo)} target="_blank" rel="noopener noreferrer" className={`${btn} inline-flex items-center`}>{tx('hotel.location.check', 'Comprobar en Google Maps')}</a>
                        <button type="button" className={btn} onClick={() => onLocation('')}>{tx('hotel.place.clear', 'Quitar punto')}</button>
                    </>
                ) : (
                    <span className="text-[11px] text-gray-500">{tx('hotel.place.help', 'Busca el hotel o haz clic en el mapa para poner el punto. Es el mapa que ve cada huésped.')}</span>
                )}
                <button type="button" className="text-[11px] font-bold text-blue-600 hover:underline ml-auto" onClick={() => setPaste((v) => !v)}>
                    {paste ? tx('hotel.place.paste.hide', 'Ocultar') : tx('hotel.place.paste', 'Pegar enlace o coordenadas')}
                </button>
            </div>
            {paste && (
                <div className="space-y-1">
                    <input id="cm-hotel-location" value={location} onChange={(e) => { onLocation(e.target.value); const p = pinOf(e.target.value); if (p) setView({ center: p, zoom: 16 }); }}
                        placeholder={tx('hotel.location.placeholder', 'Enlace de Google Maps o coordenadas')} autoComplete="off" inputMode="url"
                        className="w-full border-2 border-gray-100 rounded-2xl px-4 py-3 bg-gray-50/50 focus:bg-white focus:border-blue-500 outline-none text-gray-900 font-bold text-sm placeholder:text-gray-300" />
                    {!g.ok && g.code !== 'empty' && <p className="text-[11px] font-bold text-amber-700 ml-1" role="alert">{GEO_MESSAGES[g.code]}</p>}
                </div>
            )}
        </div>
    );
}
