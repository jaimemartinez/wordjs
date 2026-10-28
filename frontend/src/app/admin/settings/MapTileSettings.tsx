"use client";

/**
 * Settings → General → «Maps»: the tile server every map on the site draws from (`map_tile_url`) and the
 * credit it requires (`map_tile_attribution`), backend core/map-tiles. Empty = the OpenStreetMap standard
 * tile layer, whose usage policy is linked next to it: it is a shared, donated service that asks heavy users
 * to run or rent their own server. A plugin may still pass a server of its own to its map.
 *
 * Rendered by the settings page, which owns the values and saves them with everything else. The preview is a
 * real MapView with the typed server, so the admin sees the tiles they are about to give every visitor.
 */
import dynamic from "next/dynamic";
import { useI18n } from "@/contexts/I18nContext";
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL, isValidTileUrl } from "@/components/map/mapUtils";

// Leaflet touches `window` when it loads: the preview renders in the browser only.
const MapView = dynamic(() => import("@/components/map/MapView"), { ssr: false });

export const OSM_TILE_POLICY_URL = "https://operations.osmfoundation.org/policies/tiles/";

export interface MapTileValues {
    map_tile_url: string;
    map_tile_attribution: string;
}

/** What is wrong with the typed values, as an i18n key, or null. */
export function mapTileProblem(values: MapTileValues): string | null {
    const url = values.map_tile_url.trim();
    if (!url) return null;
    if (!isValidTileUrl(url)) return "settings.maps.url.invalid";
    if (!values.map_tile_attribution.trim()) return "settings.maps.attribution.required";
    return null;
}

const inputCls = "w-full px-4 py-3.5 bg-gray-50/50 border border-gray-200 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none";

export default function MapTileSettings({ values, onChange }: { values: MapTileValues; onChange: (v: MapTileValues) => void }) {
    const { t } = useI18n();
    const problem = mapTileProblem(values);
    const url = values.map_tile_url.trim();
    const previewUrl = url && isValidTileUrl(url) ? url : DEFAULT_TILE_URL;
    const previewAttribution = url ? values.map_tile_attribution : DEFAULT_TILE_ATTRIBUTION;
    return (
        <div className="bg-white rounded-3xl md:rounded-[40px] shadow-xl shadow-gray-100/50 border-2 border-gray-50 overflow-hidden" data-testid="settings-maps">
            <div className="px-8 py-6 border-b border-gray-50 bg-gray-50/30">
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <i className="fa-solid fa-map-location-dot text-emerald-500" aria-hidden="true"></i> {t("settings.maps.title")}
                </h2>
                <p className="text-xs text-gray-500 mt-1">{t("settings.maps.help")}</p>
            </div>
            <div className="p-8 space-y-6">
                <div className="space-y-2">
                    <label htmlFor="settings-map-tile-url" className="text-sm font-bold text-gray-700">{t("settings.maps.url")}</label>
                    <input
                        id="settings-map-tile-url"
                        type="url"
                        inputMode="url"
                        spellCheck={false}
                        maxLength={512}
                        value={values.map_tile_url}
                        placeholder={DEFAULT_TILE_URL}
                        aria-invalid={problem === "settings.maps.url.invalid" || undefined}
                        aria-describedby="settings-map-tile-url-help"
                        onChange={(e) => onChange({ ...values, map_tile_url: e.target.value })}
                        className={inputCls + " font-mono text-sm"}
                    />
                    <p id="settings-map-tile-url-help" className="text-xs text-gray-500">{t("settings.maps.url.help")}</p>
                </div>
                <div className="space-y-2">
                    <label htmlFor="settings-map-tile-attribution" className="text-sm font-bold text-gray-700">{t("settings.maps.attribution")}</label>
                    <input
                        id="settings-map-tile-attribution"
                        type="text"
                        maxLength={200}
                        value={values.map_tile_attribution}
                        placeholder={DEFAULT_TILE_ATTRIBUTION}
                        aria-invalid={problem === "settings.maps.attribution.required" || undefined}
                        onChange={(e) => onChange({ ...values, map_tile_attribution: e.target.value })}
                        className={inputCls}
                    />
                    <p className="text-xs text-gray-500">{t("settings.maps.attribution.help")}</p>
                </div>
                {problem && (
                    <p role="alert" className="text-sm font-semibold text-rose-600" data-testid="settings-maps-problem">
                        <i className="fa-solid fa-circle-exclamation mr-1.5" aria-hidden="true"></i>{t(problem)}
                    </p>
                )}
                {!url && (
                    <div className="p-4 bg-amber-50/60 rounded-2xl border border-amber-100 text-xs text-amber-900 leading-relaxed" data-testid="settings-maps-osm-note">
                        <i className="fa-solid fa-circle-info mr-1.5" aria-hidden="true"></i>
                        {t("settings.maps.osmNote")}{" "}
                        <a href={OSM_TILE_POLICY_URL} target="_blank" rel="noopener noreferrer" className="font-semibold underline">{t("settings.maps.osmNote.link")}</a>
                    </div>
                )}
                <div className="space-y-2">
                    <h3 className="text-sm font-bold text-gray-700">{t("settings.maps.preview")}</h3>
                    <MapView
                        tileUrl={previewUrl}
                        tileAttribution={previewAttribution}
                        wheelZoom={false}
                        ariaLabel={t("settings.maps.preview")}
                        className="h-64 w-full rounded-2xl overflow-hidden border border-gray-200"
                    />
                </div>
            </div>
        </div>
    );
}
