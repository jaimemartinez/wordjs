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
import { Input } from "@/components/ui";
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
                <Input
                    id="settings-map-tile-url"
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    maxLength={512}
                    label={t("settings.maps.url")}
                    help={t("settings.maps.url.help")}
                    error={problem === "settings.maps.url.invalid" ? t(problem) : undefined}
                    value={values.map_tile_url}
                    placeholder={DEFAULT_TILE_URL}
                    onChange={(e) => onChange({ ...values, map_tile_url: e.target.value })}
                    className="font-mono"
                />
                <Input
                    id="settings-map-tile-attribution"
                    maxLength={200}
                    label={t("settings.maps.attribution")}
                    help={t("settings.maps.attribution.help")}
                    error={problem === "settings.maps.attribution.required" ? t(problem) : undefined}
                    value={values.map_tile_attribution}
                    placeholder={DEFAULT_TILE_ATTRIBUTION}
                    onChange={(e) => onChange({ ...values, map_tile_attribution: e.target.value })}
                />
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
