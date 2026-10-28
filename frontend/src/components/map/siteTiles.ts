"use client";

/**
 * The site's tile server (Settings → General → «Maps»: the `map_tile_url` and `map_tile_attribution` public
 * options, backend core/map-tiles), for every MapView that does not pass its own `tileUrl`. Read once per page
 * load from the public settings and shared by every map on the page.
 *
 * Null until it arrives: a map draws no tiles before it knows the server, so a site that moved away from
 * OpenStreetMap never sends a visitor's first tile requests there. For the same reason a failed read does
 * NOT fall back to OpenStreetMap — the map stays without tiles and tries again (RETRY_MS) while it is shown.
 */
import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL, isValidTileUrl } from "./mapUtils";

export interface SiteTiles {
    url: string;
    attribution: string;
}

const RETRY_MS = 30_000;

let cached: SiteTiles | null = null;
let pending: Promise<SiteTiles> | null = null;

/** The stored options as a tile source: an empty or unusable template is the OpenStreetMap default. */
export function siteTilesFrom(settings: unknown): SiteTiles {
    const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
    if (!isValidTileUrl(s.map_tile_url)) return { url: DEFAULT_TILE_URL, attribution: DEFAULT_TILE_ATTRIBUTION };
    const attribution = typeof s.map_tile_attribution === "string" ? s.map_tile_attribution.trim() : "";
    // A custom server with no credit typed shows the OpenStreetMap one: most tile servers draw OSM data.
    return { url: s.map_tile_url.trim(), attribution: attribution || DEFAULT_TILE_ATTRIBUTION };
}

/** Exported for the tests; maps go through useSiteTiles. */
export function loadSiteTiles(): Promise<SiteTiles> {
    if (cached) return Promise.resolve(cached);
    pending ??= settingsApi.get()
        .then((s) => (cached = siteTilesFrom(s)))
        .catch((e) => { pending = null; throw e; });
    return pending;
}

/** Forget the cached server (Settings → General calls it after saving, so its preview uses the new one). */
export function resetSiteTiles(settings?: unknown): void {
    cached = settings === undefined ? null : siteTilesFrom(settings);
    pending = null;
}

/** The site's tile server; null while it is being read (or when `skip`: the map has a server of its own). */
export function useSiteTiles(skip = false): SiteTiles | null {
    const [tiles, setTiles] = useState<SiteTiles | null>(skip ? null : cached);
    useEffect(() => {
        if (skip) return;
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const attempt = () => {
            loadSiteTiles().then(
                (v) => { if (active) setTiles(v); },
                () => { if (active) timer = setTimeout(attempt, RETRY_MS); },
            );
        };
        attempt();
        return () => { active = false; if (timer) clearTimeout(timer); };
    }, [skip]);
    return skip ? null : tiles;
}
