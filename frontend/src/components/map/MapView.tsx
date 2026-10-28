"use client";

/**
 * MapView — a generic, declarative slippy map (Leaflet 1.9, OpenStreetMap raster tiles by default).
 *
 * Exposed to plugin bundles as the host module 'components/map/MapView' (pluginBundleLoader.ts +
 * HOST_MODULES in backend/scripts/build-plugin.js), so a plugin draws maps with the host's one copy of
 * Leaflet instead of bundling its own. The props ARE the contract plugins code against — extend them,
 * never change the meaning of an existing one.
 *
 * - Leaflet is imported on mount (`import('leaflet')`): it touches `window` at import time, so a static
 *   import would break server rendering of any page that renders a MapView.
 * - Its stylesheet is injected once as <style data-wjs-leaflet> (leafletCss.ts): no global CSS import, so
 *   the same module styles itself in the admin, in a blob-loaded plugin bundle and on a public page.
 * - Markers and lines are diffed BY ID: a poll that hands a new array with the same ids moves markers and
 *   updates lines in place (no flicker, no lost drag). Event callbacks are read from a ref, so a parent
 *   that passes a fresh closure on every render never makes the map re-bind or re-create anything.
 * - Everything that reaches Leaflet's innerHTML (labels, colours, the attribution, marker tooltips) goes
 *   through mapUtils.ts: escaped or allowlisted. Leaflet writes a string tooltip with innerHTML, so a
 *   marker title is bound only as tooltipText(title) — titles are often typed by other people (a portal
 *   user's name, a place name) and must show as text, never run as markup.
 * - Tiles are <img> requests to the tile server (CSP img-src allows https:). A map with no `tileUrl` uses
 *   the SITE's server (Settings → General → «Maps», siteTiles.ts) and draws no tile until that is known;
 *   with none set it is the OpenStreetMap standard tile layer, whose usage policy requires the attribution.
 *   A `tileUrl` prop still wins, for a plugin that needs a server of its own.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import { LEAFLET_CSS } from "./leafletCss";
import { useSiteTiles } from "./siteTiles";
import * as U from "./mapUtils";
import {
    MARKER_CSS, attributionHtml, boundsOf, isValidLatLng, markerIconSpec, safeColor, safeTileUrl, tooltipText, validPoints,
    type LatLng, type MarkerVariant,
} from "./mapUtils";

export type { LatLng, MarkerVariant } from "./mapUtils";
// Declared here (not `export { … } from`): build-plugin.js builds a plugin's view of a host module from the
// names the module DECLARES, so a re-export would be invisible to plugin bundles ("No matching export").
export const DEFAULT_TILE_URL: string = U.DEFAULT_TILE_URL;
export const DEFAULT_TILE_ATTRIBUTION: string = U.DEFAULT_TILE_ATTRIBUTION;
export const DEFAULT_CENTER: LatLng = U.DEFAULT_CENTER;
export const DEFAULT_ZOOM: number = U.DEFAULT_ZOOM;

export interface MapMarker {
    id: string;
    position: LatLng;
    /** pin (default) = drop pin; dot = small circle; badge = rounded label (≤ 4 chars); vertex = editable
     *  route handle; pulse = live position. */
    variant?: MarkerVariant;
    color?: string;
    label?: string;
    /** Tooltip on hover/long-press and the marker's accessible name. */
    title?: string;
    draggable?: boolean;
    zIndex?: number;
    /** Metres: draws a translucent accuracy circle around the marker. */
    accuracy?: number;
    onClick?: () => void;
    onDragEnd?: (pos: LatLng) => void;
}

export interface MapLine {
    id: string;
    points: LatLng[];
    color: string;
    weight?: number;
    opacity?: number;
    dashed?: boolean;
    /** When set the line is clickable (e.g. to insert a vertex) and the click does not reach onMapClick. */
    onClick?: (pos: LatLng) => void;
}

export interface MapViewHandle {
    fitTo(points: LatLng[], opts?: { padding?: number; maxZoom?: number }): void;
    setView(center: LatLng, zoom?: number): void;
    getCenter(): LatLng | null;
    getZoom(): number | null;
    invalidateSize(): void;
}

export interface MapViewProps {
    /** Initial view (later changes are ignored — use the handle or fitKey to move the map). */
    center?: LatLng;
    zoom?: number;
    markers?: MapMarker[];
    lines?: MapLine[];
    onMapClick?: (pos: LatLng) => void;
    /** A tile server of the map's own (https template with {z}/{x}/{y}). Unset = the site's server. */
    tileUrl?: string;
    /** The credit shown for the tiles. Unset = the site's (or, with `tileUrl`, the OpenStreetMap one). */
    tileAttribution?: string;
    maxZoom?: number;
    className?: string;
    style?: React.CSSProperties;
    ariaLabel?: string;
    /** Crosshair cursor (an editing mode). */
    crosshair?: boolean;
    zoomControl?: boolean;
    /** Mouse-wheel zoom (default true). Turn it off for a map inside a scrolling page. */
    wheelZoom?: boolean;
    /** Fit these points whenever `fitKey` changes (and once on mount when given). */
    fitPoints?: LatLng[];
    fitKey?: string | number;
    /** Padding in px around fitted points (default 32) — e.g. room for a card drawn over the map. */
    fitPadding?: number;
    /** false = a static preview: no dragging, zoom, keyboard or clicks (default true). Fixed at mount. */
    interactive?: boolean;
    onReady?: (handle: MapViewHandle) => void;
}

type LeafletModule = typeof Leaflet;

let leafletPromise: Promise<LeafletModule> | null = null;
function loadLeaflet(): Promise<LeafletModule> {
    if (!leafletPromise) {
        leafletPromise = import("leaflet").then((m) => ((m as unknown as { default?: LeafletModule }).default ?? m) as LeafletModule);
        // A failed chunk load must not poison every later map on the page.
        leafletPromise.catch(() => { leafletPromise = null; });
    }
    return leafletPromise;
}

function ensureStylesheet(): void {
    if (typeof document === "undefined" || document.querySelector("style[data-wjs-leaflet]")) return;
    const el = document.createElement("style");
    el.setAttribute("data-wjs-leaflet", "");
    el.textContent = LEAFLET_CSS + MARKER_CSS;
    document.head.appendChild(el);
}

interface MarkerEntry { marker: Leaflet.Marker; circle: Leaflet.Circle | null; sig: string; dragging: boolean }
interface LineEntry { line: Leaflet.Polyline; sig: string; points: LatLng[] }

const markerSig = (m: MapMarker) => JSON.stringify([m.variant || "pin", safeColor(m.color), m.label ?? "", m.title ?? "", !!m.draggable, m.zIndex ?? 0]);
const lineSig = (l: MapLine) => JSON.stringify([safeColor(l.color), l.weight ?? 4, l.opacity ?? 0.9, !!l.dashed, !!l.onClick]);

const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(props, ref) {
    // center / zoom / fitPoints / onReady are read once at creation through propsRef (they set the initial
    // view; later changes move nothing), so they are not destructured here.
    const {
        markers, lines, tileUrl, tileAttribution, maxZoom = 19, className, style, ariaLabel,
        crosshair, zoomControl = true, wheelZoom = true, fitKey,
    } = props;
    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<Leaflet.Map | null>(null);
    const LRef = useRef<LeafletModule | null>(null);
    const tileRef = useRef<Leaflet.TileLayer | null>(null);
    const markersRef = useRef<Map<string, MarkerEntry>>(new Map());
    const linesRef = useRef<Map<string, LineEntry>>(new Map());
    // Latest props for event handlers bound once.
    const propsRef = useRef(props);
    propsRef.current = props;
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    const siteTiles = useSiteTiles(tileUrl !== undefined);

    const handle: MapViewHandle = {
        fitTo(points, opts) {
            const map = mapRef.current;
            const b = boundsOf(points);
            if (!map || !b) return;
            const max = opts?.maxZoom ?? 17;
            const pad = opts?.padding ?? propsRef.current.fitPadding ?? 32;
            if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) map.setView(b[0], Math.min(max, 16));
            else map.fitBounds(b, { padding: [pad, pad], maxZoom: max });
        },
        setView(c, z) {
            const map = mapRef.current;
            if (map && isValidLatLng(c)) map.setView(c, z ?? map.getZoom());
        },
        getCenter() {
            const c = mapRef.current?.getCenter();
            return c ? [c.lat, c.lng] : null;
        },
        getZoom() { return mapRef.current ? mapRef.current.getZoom() : null; },
        invalidateSize() { mapRef.current?.invalidateSize(); },
    };
    const handleRef = useRef(handle);
    handleRef.current = handle;
    useImperativeHandle(ref, () => handleRef.current, []);

    // Create the map once (and destroy it on unmount — React strict mode mounts twice in development).
    useEffect(() => {
        let cancelled = false;
        let observer: ResizeObserver | null = null;
        const markerStore = markersRef.current;
        const lineStore = linesRef.current;
        ensureStylesheet();
        loadLeaflet().then((L) => {
            const el = containerRef.current;
            if (cancelled || !el) return;
            LRef.current = L;
            const initial = propsRef.current;
            const still = initial.interactive === false;
            const map = L.map(el, {
                zoomControl: !still && (initial.zoomControl ?? true),
                scrollWheelZoom: !still && (initial.wheelZoom ?? true),
                dragging: !still, touchZoom: !still, doubleClickZoom: !still, boxZoom: !still, keyboard: !still,
                attributionControl: true,
                maxZoom: initial.maxZoom ?? 19,
            });
            map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>');
            const pts = validPoints(initial.fitPoints);
            const b = boundsOf(pts);
            const pad = initial.fitPadding ?? 32;
            if (b && (b[0][0] !== b[1][0] || b[0][1] !== b[1][1])) map.fitBounds(b, { padding: [pad, pad], maxZoom: 17 });
            else if (b) map.setView(b[0], 16);
            else map.setView(isValidLatLng(initial.center) ? initial.center : DEFAULT_CENTER, initial.zoom ?? DEFAULT_ZOOM);
            map.on("click", (e: Leaflet.LeafletMouseEvent) => {
                if (propsRef.current.interactive === false) return;
                propsRef.current.onMapClick?.([e.latlng.lat, e.latlng.lng]);
            });
            mapRef.current = map;
            // Until the user pans or zooms, a size change re-applies the fit: a map created while its box was
            // still 0 px tall (a card animating in, a hidden tab) fitted its points to nothing and showed them
            // as a speck in a city-wide view.
            let touched = false;
            const touch = () => { touched = true; };
            el.addEventListener("pointerdown", touch, { passive: true });
            el.addEventListener("wheel", touch, { passive: true });
            el.addEventListener("keydown", touch);
            if (typeof ResizeObserver !== "undefined") {
                observer = new ResizeObserver(() => {
                    const m = mapRef.current;
                    if (!m) return;
                    m.invalidateSize();
                    const pts = validPoints(propsRef.current.fitPoints);
                    if (!touched && pts.length && el.clientWidth > 0 && el.clientHeight > 0) handleRef.current.fitTo(pts);
                });
                observer.observe(el);
            }
            setReady(true);
            propsRef.current.onReady?.(handleRef.current);
        }).catch(() => { if (!cancelled) setFailed(true); });
        return () => {
            cancelled = true;
            observer?.disconnect();
            markerStore.clear();
            lineStore.clear();
            tileRef.current = null;
            if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
            setReady(false);
        };
    }, []);

    // The tile layer: created once the server is known (the prop, or the site's), replaced when it changes.
    const tileSource = tileUrl !== undefined
        ? { url: tileUrl, attribution: tileAttribution ?? DEFAULT_TILE_ATTRIBUTION }
        : siteTiles && { url: siteTiles.url, attribution: tileAttribution ?? siteTiles.attribution };
    const sourceUrl = tileSource ? tileSource.url : null;
    const sourceAttribution = tileSource ? tileSource.attribution : null;
    useEffect(() => {
        const map = mapRef.current, L = LRef.current, tile = tileRef.current;
        if (!ready || !map || !L || sourceUrl === null) return;
        const url = safeTileUrl(sourceUrl);
        const attribution = attributionHtml(sourceAttribution);
        if (!tile) {
            tileRef.current = L.tileLayer(url, { maxZoom, attribution }).addTo(map);
            tileRef.current.bringToBack();
        } else if (tile.options.attribution !== attribution) {
            map.removeLayer(tile);
            tileRef.current = L.tileLayer(url, { maxZoom, attribution }).addTo(map);
            tileRef.current.bringToBack();
        } else {
            tile.setUrl(url);
        }
    }, [ready, sourceUrl, sourceAttribution, maxZoom]);

    // Markers, diffed by id.
    useEffect(() => {
        const map = mapRef.current, L = LRef.current;
        if (!ready || !map || !L) return;
        const store = markersRef.current;
        const seen = new Set<string>();
        for (const m of markers || []) {
            if (!m || typeof m.id !== "string" || !isValidLatLng(m.position) || seen.has(m.id)) continue;
            seen.add(m.id);
            const sig = markerSig(m);
            const spec = markerIconSpec(m.variant, m.color, m.label);
            const icon = L.divIcon({ html: spec.html, className: "", iconSize: spec.size, iconAnchor: spec.anchor });
            let entry = store.get(m.id);
            if (!entry) {
                const id = m.id;
                const marker = L.marker(m.position, {
                    icon, draggable: !!m.draggable, zIndexOffset: m.zIndex ?? 0, keyboard: !!m.title || !!m.onClick,
                    title: m.title || "", alt: m.title || "", riseOnHover: true, autoPanOnFocus: false,
                });
                marker.on("click", () => {
                    const cur = (propsRef.current.markers || []).find((x) => x && x.id === id);
                    cur?.onClick?.();
                });
                marker.on("dragstart", () => { const en = store.get(id); if (en) en.dragging = true; });
                marker.on("dragend", () => {
                    const en = store.get(id);
                    if (en) en.dragging = false;
                    const ll = marker.getLatLng();
                    const cur = (propsRef.current.markers || []).find((x) => x && x.id === id);
                    cur?.onDragEnd?.([ll.lat, ll.lng]);
                });
                if (m.title) marker.bindTooltip(tooltipText(m.title), { direction: "top", offset: [0, -spec.anchor[1]] });
                marker.addTo(map);
                entry = { marker, circle: null, sig, dragging: false };
                store.set(id, entry);
            } else {
                if (entry.sig !== sig) {
                    entry.marker.setIcon(icon);
                    entry.marker.setZIndexOffset(m.zIndex ?? 0);
                    if (m.draggable) entry.marker.dragging?.enable(); else entry.marker.dragging?.disable();
                    entry.marker.unbindTooltip();
                    if (m.title) entry.marker.bindTooltip(tooltipText(m.title), { direction: "top", offset: [0, -spec.anchor[1]] });
                    entry.sig = sig;
                }
                if (!entry.dragging) {
                    const ll = entry.marker.getLatLng();
                    if (ll.lat !== m.position[0] || ll.lng !== m.position[1]) entry.marker.setLatLng(m.position);
                }
            }
            const acc = typeof m.accuracy === "number" && Number.isFinite(m.accuracy) && m.accuracy > 0 ? Math.min(m.accuracy, 5000) : 0;
            if (acc) {
                const color = safeColor(m.color);
                if (!entry.circle) {
                    entry.circle = L.circle(m.position, { radius: acc, color, weight: 1, opacity: 0.5, fillColor: color, fillOpacity: 0.12, interactive: false }).addTo(map);
                } else {
                    entry.circle.setLatLng(m.position);
                    entry.circle.setRadius(acc);
                    entry.circle.setStyle({ color, fillColor: color });
                }
            } else if (entry.circle) {
                map.removeLayer(entry.circle);
                entry.circle = null;
            }
        }
        for (const [id, entry] of store) {
            if (seen.has(id)) continue;
            map.removeLayer(entry.marker);
            if (entry.circle) map.removeLayer(entry.circle);
            store.delete(id);
        }
    }, [ready, markers]);

    // Lines, diffed by id.
    useEffect(() => {
        const map = mapRef.current, L = LRef.current;
        if (!ready || !map || !L) return;
        const store = linesRef.current;
        const seen = new Set<string>();
        for (const l of lines || []) {
            if (!l || typeof l.id !== "string" || seen.has(l.id)) continue;
            const known = store.get(l.id);
            // Same array object as last time → nothing moved: skip revalidating and redrawing it (a live
            // monitor hands every trail again on each poll; most of them did not change).
            if (known && known.points === l.points && known.sig === lineSig(l)) { seen.add(l.id); continue; }
            const pts = validPoints(l.points);
            if (pts.length < 2) continue;
            seen.add(l.id);
            const sig = lineSig(l);
            const opts: Leaflet.PolylineOptions = {
                color: safeColor(l.color), weight: l.weight ?? 4, opacity: l.opacity ?? 0.9,
                dashArray: l.dashed ? "8 8" : undefined, lineCap: "round", lineJoin: "round",
                interactive: !!l.onClick, bubblingMouseEvents: !l.onClick,
            };
            const entry = store.get(l.id);
            if (!entry || entry.sig !== sig) {
                // interactive/bubbling cannot change on a live layer: rebuild it.
                if (entry) map.removeLayer(entry.line);
                const id = l.id;
                const line = L.polyline(pts, opts);
                line.on("click", (e: Leaflet.LeafletMouseEvent) => {
                    const cur = (propsRef.current.lines || []).find((x) => x && x.id === id);
                    cur?.onClick?.([e.latlng.lat, e.latlng.lng]);
                });
                line.addTo(map);
                store.set(id, { line, sig, points: l.points });
            } else {
                entry.line.setLatLngs(pts);
                entry.points = l.points;
            }
        }
        for (const [id, entry] of store) {
            if (seen.has(id)) continue;
            map.removeLayer(entry.line);
            store.delete(id);
        }
    }, [ready, lines]);

    // Re-fit when fitKey changes (the initial fit happens at creation).
    const firstFit = useRef(true);
    useEffect(() => {
        if (!ready) return;
        if (firstFit.current) { firstFit.current = false; return; }
        if (fitKey === undefined) return;
        handleRef.current.fitTo(validPoints(propsRef.current.fitPoints));
    }, [ready, fitKey]);

    // Zoom control / wheel zoom toggles.
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map || propsRef.current.interactive === false) return;
        if (wheelZoom) map.scrollWheelZoom.enable(); else map.scrollWheelZoom.disable();
    }, [ready, wheelZoom]);
    useEffect(() => {
        const map = mapRef.current;
        if (!ready || !map || propsRef.current.interactive === false) return;
        if (zoomControl && !map.zoomControl) {
            const L = LRef.current;
            if (L) { map.zoomControl = L.control.zoom(); map.zoomControl.addTo(map); }
        } else if (!zoomControl && map.zoomControl) {
            map.zoomControl.remove();
            (map as unknown as { zoomControl: Leaflet.Control.Zoom | undefined }).zoomControl = undefined;
        }
    }, [ready, zoomControl]);

    return (
        <div
            className={["wjs-map-root", crosshair ? "wjs-map-crosshair" : "", className || ""].filter(Boolean).join(" ")}
            style={{ position: "relative", minHeight: 160, ...style }}
        >
            <div ref={containerRef} role="region" aria-label={ariaLabel || "Mapa"} style={{ position: "absolute", inset: 0, zIndex: 0 }} />
            {!ready && !failed && (
                <div aria-hidden="true" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#f3f4f6", color: "#9ca3af", fontSize: 13, fontWeight: 600 }}>
                    <i className="fa-solid fa-map-location-dot" style={{ marginRight: 8 }} /> Cargando mapa…
                </div>
            )}
            {failed && (
                <div role="alert" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#fef2f2", color: "#b91c1c", fontSize: 13, fontWeight: 600, padding: 16, textAlign: "center" }}>
                    No se pudo cargar el mapa. Revisa tu conexión y recarga la página.
                </div>
            )}
        </div>
    );
});

export default MapView;
