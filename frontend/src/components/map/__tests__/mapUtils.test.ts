/**
 * MapView's pure helpers — the part of the map that decides what reaches Leaflet's innerHTML and which
 * tile server the browser fetches. A plugin hands these values from its own users (team names, an
 * operator-set attribution, a tile URL from settings), so they are pinned here:
 *   - labels, tooltips and attribution are escaped, colours are allowlisted (no markup or CSS injection);
 *   - only https tile templates with {z}/{x}/{y} are fetched, anything else falls back to OSM;
 *   - invalid coordinates are dropped instead of throwing inside Leaflet;
 *   - every marker variant anchors where its coordinate is (the pin's tip, the others' centre).
 */
import { describe, expect, it } from "vitest";
import {
    DEFAULT_COLOR, DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL, attributionHtml, boundsOf, escapeHtml,
    isValidLatLng, markerIconSpec, safeColor, safeTileUrl, tooltipText, validPoints,
} from "../mapUtils";

describe("coordinates", () => {
    it("accepts finite in-range [lat, lng] only", () => {
        expect(isValidLatLng([4.7, -74.07])).toBe(true);
        expect(isValidLatLng([90, 180])).toBe(true);
        expect(isValidLatLng([91, 0])).toBe(false);
        expect(isValidLatLng([0, -181])).toBe(false);
        expect(isValidLatLng([NaN, 0])).toBe(false);
        expect(isValidLatLng(["4", "5"])).toBe(false);
        expect(isValidLatLng([1])).toBe(false);
        expect(isValidLatLng(null)).toBe(false);
    });

    it("drops invalid points and keeps the order of the rest", () => {
        expect(validPoints([[1, 2], [200, 0], null, [3, 4], "x"])).toEqual([[1, 2], [3, 4]]);
        expect(validPoints("nope")).toEqual([]);
    });

    it("computes [[south, west], [north, east]]", () => {
        expect(boundsOf([[4, -74], [5, -75], [4.5, -73]])).toEqual([[4, -75], [5, -73]]);
        expect(boundsOf([[1, 1]])).toEqual([[1, 1], [1, 1]]);
        expect(boundsOf([])).toBeNull();
    });
});

describe("escaping and allowlists", () => {
    it("escapes every HTML-significant character", () => {
        expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
    });

    it("hands Leaflet a tooltip that shows the title as text (Leaflet writes a string tooltip with innerHTML)", () => {
        const title = `<img src=x onerror=alert(1)> Ana & "Beto"`;
        const html = tooltipText(title);
        // Nothing an HTML parser would read as a tag or an attribute boundary survives…
        expect(html).not.toMatch(/[<>"']/);
        expect(html).toBe("&lt;img src=x onerror=alert(1)&gt; Ana &amp; &quot;Beto&quot;");
        // …and decoding the entities gives back exactly the title, so the tooltip reads as typed.
        const decoded = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        expect(decoded).toBe(title);
        expect(tooltipText(undefined)).toBe("");
        expect(tooltipText(42)).toBe("42");
    });

    it("allowlists colours", () => {
        expect(safeColor("#2563eb")).toBe("#2563eb");
        expect(safeColor("#abc")).toBe("#abc");
        expect(safeColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
        expect(safeColor("hsla(10, 50%, 50%, .5)")).toBe("hsla(10, 50%, 50%, .5)");
        expect(safeColor("red;background:url(https://x)")).toBe(DEFAULT_COLOR);
        expect(safeColor("url(javascript:1)")).toBe(DEFAULT_COLOR);
        expect(safeColor(undefined, "#000")).toBe("#000");
    });

    it("renders the attribution as text, with © spellings normalised", () => {
        expect(attributionHtml("<b>Mapa</b> (c) Yo")).toBe("&lt;b&gt;Mapa&lt;/b&gt; © Yo");
        expect(attributionHtml("&copy; OSM")).toBe("© OSM");
        expect(attributionHtml("")).toBe(DEFAULT_TILE_ATTRIBUTION);
        expect(attributionHtml("x".repeat(500)).length).toBe(200);
    });

    it("fetches only https tile templates with {z}/{x}/{y}", () => {
        expect(safeTileUrl("https://{s}.tile.example.org/{z}/{x}/{y}.png")).toBe("https://{s}.tile.example.org/{z}/{x}/{y}.png");
        expect(safeTileUrl("http://tile.example.org/{z}/{x}/{y}.png")).toBe(DEFAULT_TILE_URL);
        expect(safeTileUrl("https://tile.example.org/static.png")).toBe(DEFAULT_TILE_URL);
        expect(safeTileUrl('https://x.org/{z}/{x}/{y}.png" onerror="')).toBe(DEFAULT_TILE_URL);
        expect(safeTileUrl(42)).toBe(DEFAULT_TILE_URL);
    });
});

describe("marker icons", () => {
    it("anchors a pin at its tip and the other variants at their centre", () => {
        expect(markerIconSpec("pin", "#f00").anchor).toEqual([15, 39]);
        expect(markerIconSpec(undefined, "#f00").anchor).toEqual([15, 39]);
        for (const v of ["dot", "vertex", "pulse", "badge"] as const) {
            const spec = markerIconSpec(v, "#f00", "12");
            expect(spec.anchor).toEqual([Math.round(spec.size[0] / 2), Math.round(spec.size[1] / 2)]);
        }
    });

    it("escapes and truncates a badge label and sanitises the colour", () => {
        const spec = markerIconSpec("badge", "x;y", "<b>12345");
        expect(spec.html).toContain("&lt;b&gt;");
        expect(spec.html).not.toContain("<b>");
        expect(spec.html).toContain(`--c:${DEFAULT_COLOR}`);
        expect(spec.html).not.toContain("123");
    });

    it("widens a badge for a longer label", () => {
        expect(markerIconSpec("badge", "#000", "1").size[0]).toBe(30);
        expect(markerIconSpec("badge", "#000", "1234").size[0]).toBe(46);
    });
});
