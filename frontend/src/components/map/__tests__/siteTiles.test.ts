/**
 * The site's tile server (Settings → General → «Maps») as every MapView without a `tileUrl` reads it.
 *   - The browser accepts exactly the templates the server accepts (backend core/map-tiles): the same
 *     accept/reject lists as backend/src/tests/map-tiles-setting.test.ts.
 *   - An empty or unusable stored template is OpenStreetMap; a custom one with no credit gets the OSM one.
 *   - A failed read does NOT fall back to OpenStreetMap: a site that moved away from it must not have its
 *     visitors' tile requests sent there because one settings read failed (the map retries instead).
 *   - The settings screen's own check (mapTileProblem) asks for the credit when a server is set.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ settingsApi: { get: api.get } }));

import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL, isValidTileUrl, safeTileUrl } from "../mapUtils";
import { loadSiteTiles, resetSiteTiles, siteTilesFrom } from "../siteTiles";
import { mapTileProblem } from "@/app/admin/settings/MapTileSettings";

const ACCEPTED = [
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://{s}.tile.example.org/{z}/{x}/{y}{r}.png",
    "https://tiles.example.org/styles/basic/{z}/{x}/{y}.png?key=public-browser-key",
    "https://maps.example.org:8443/wmts/{z}/{y}/{x}",
];
const REJECTED: unknown[] = [
    "http://tile.example.org/{z}/{x}/{y}.png",
    "//tile.example.org/{z}/{x}/{y}.png",
    "javascript:alert(1)//{z}/{x}/{y}",
    "data:image/png;base64,{z}{x}{y}",
    "https://tile.example.org/static.png",
    "https://tile.example.org/{z}/{x}.png",
    "https://tile.example.org/{z}/{x}/{y}/{apikey}.png",
    "https://tile.example.org/{{z}/{x}/{y}.png",
    "https://user:secret@tile.example.org/{z}/{x}/{y}.png",
    "https://token@tile.example.org/{z}/{x}/{y}.png",
    'https://tile.example.org/{z}/{x}/{y}.png" onerror="x',
    "https://tile.example.org/{z}/{x}/{y}.png <b>",
    "https:///{z}/{x}/{y}.png",
    "https://tile.example.org/" + "a".repeat(600) + "/{z}/{x}/{y}.png",
    42,
    ["https://tile.example.org/{z}/{x}/{y}.png"],
];

describe("tile template rules (same as the server's)", () => {
    it("accepts the usual template shapes", () => {
        for (const ok of ACCEPTED) {
            expect(isValidTileUrl(ok), ok).toBe(true);
            expect(safeTileUrl("  " + ok + " ")).toBe(ok);
        }
    });
    it("rejects everything else, and safeTileUrl falls back to OpenStreetMap", () => {
        for (const bad of REJECTED) {
            expect(isValidTileUrl(bad), String(bad)).toBe(false);
            expect(safeTileUrl(bad)).toBe(DEFAULT_TILE_URL);
        }
    });
});

describe("siteTilesFrom", () => {
    it("is OpenStreetMap when nothing (or nothing usable) is stored", () => {
        const osm = { url: DEFAULT_TILE_URL, attribution: DEFAULT_TILE_ATTRIBUTION };
        expect(siteTilesFrom({})).toEqual(osm);
        expect(siteTilesFrom(null)).toEqual(osm);
        expect(siteTilesFrom({ map_tile_url: "", map_tile_attribution: "© Mine" })).toEqual(osm);
        expect(siteTilesFrom({ map_tile_url: "http://x.example.org/{z}/{x}/{y}.png", map_tile_attribution: "© Mine" })).toEqual(osm);
    });
    it("uses the stored server with its credit, or the OSM credit when none was typed", () => {
        const url = "https://tiles.example.org/{z}/{x}/{y}.png";
        expect(siteTilesFrom({ map_tile_url: url, map_tile_attribution: " © Example " })).toEqual({ url, attribution: "© Example" });
        expect(siteTilesFrom({ map_tile_url: url, map_tile_attribution: "" })).toEqual({ url, attribution: DEFAULT_TILE_ATTRIBUTION });
    });
});

describe("loadSiteTiles", () => {
    beforeEach(() => { api.get.mockReset(); resetSiteTiles(); });

    it("reads the public settings once and shares the answer", async () => {
        api.get.mockResolvedValue({ map_tile_url: "https://tiles.example.org/{z}/{x}/{y}.png", map_tile_attribution: "© Example" });
        const [a, b] = await Promise.all([loadSiteTiles(), loadSiteTiles()]);
        expect(a).toEqual({ url: "https://tiles.example.org/{z}/{x}/{y}.png", attribution: "© Example" });
        expect(b).toBe(a);
        await loadSiteTiles();
        expect(api.get).toHaveBeenCalledTimes(1);
    });

    it("fails closed: a failed read rejects (no OpenStreetMap fallback) and the next attempt reads again", async () => {
        api.get.mockRejectedValueOnce(new Error("429"));
        await expect(loadSiteTiles()).rejects.toThrow("429");
        api.get.mockResolvedValueOnce({ map_tile_url: "https://tiles.example.org/{z}/{x}/{y}.png", map_tile_attribution: "© Example" });
        await expect(loadSiteTiles()).resolves.toEqual({ url: "https://tiles.example.org/{z}/{x}/{y}.png", attribution: "© Example" });
        expect(api.get).toHaveBeenCalledTimes(2);
    });

    it("takes the saved values right away after Settings saves them", async () => {
        resetSiteTiles({ map_tile_url: "https://saved.example.org/{z}/{x}/{y}.png", map_tile_attribution: "© Saved" });
        await expect(loadSiteTiles()).resolves.toEqual({ url: "https://saved.example.org/{z}/{x}/{y}.png", attribution: "© Saved" });
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe("mapTileProblem (Settings → Maps)", () => {
    it("allows the default, refuses a bad template, and asks for the credit of a custom server", () => {
        expect(mapTileProblem({ map_tile_url: "", map_tile_attribution: "" })).toBeNull();
        expect(mapTileProblem({ map_tile_url: "http://x.example.org/{z}/{x}/{y}.png", map_tile_attribution: "© X" })).toBe("settings.maps.url.invalid");
        expect(mapTileProblem({ map_tile_url: "https://x.example.org/{z}/{x}/{y}.png", map_tile_attribution: "  " })).toBe("settings.maps.attribution.required");
        expect(mapTileProblem({ map_tile_url: "https://x.example.org/{z}/{x}/{y}.png", map_tile_attribution: "© X" })).toBeNull();
    });
});
