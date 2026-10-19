/**
 * conference-manager 2.19.0 — «Escarapelas», the screens.
 *
 * The server computes each badge ONCE as a display list (server/badge-layout.js); three things draw it: the PDF
 * (server), the plugin admin (client/admin/BadgeSvg.tsx) and this portal's credential page (badge/BadgeCard.tsx)
 * — core cannot import plugin code, so the two SVG renderers are copies and must stay equal. Pinned here:
 *   - the two renderers produce the same SVG for the same display list;
 *   - the server's QR encoder (server/badge-qr.js) draws the very modules of the admin's (client/lib/qr.ts),
 *     and what the badge draws decodes back to the registration code (jsQR, the meal scanner's reader);
 *   - the layout keeps every item inside the CR80 card, in both orientations, whatever the name;
 *   - the portal's helpers (hasBadges, whatsappUrl) and the plugin's agree;
 *   - the file route serves only the allowlisted type, never cached or sniffed, and a bad ticket is a 410;
 *   - the participant sheet offers «Escarapela» only while badges are on and the inscription is active;
 *   - every new admin text exists in es / en / pt.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import path from "node:path";
import { BadgeCard, ScanQr } from "../../../../../../marketplace/plugins/conference-manager/client/portal/badge/BadgeCard";
import { BadgeSvg } from "../../../../../../marketplace/plugins/conference-manager/client/admin/BadgeSvg";
import { encodeQr, qrRows } from "../../../../../../marketplace/plugins/conference-manager/client/lib/qr";
import jsQR from "../../../../../../marketplace/plugins/conference-manager/client/lib/vendor/jsQR";
import * as pluginBadges from "../../../../../../marketplace/plugins/conference-manager/client/lib/badges";
import { translations } from "../../../../../../marketplace/plugins/conference-manager/client/lib/i18n";
import { hasBadges, waNumber, whatsappUrl } from "../../../../../../marketplace/plugins/conference-manager/client/portal/badges";
import fs from "node:fs";
import ParticipantSheet from "../../../../../../marketplace/plugins/conference-manager/client/portal/ParticipantSheet";
import { parseGeo } from "../../../../../../marketplace/plugins/conference-manager/client/lib/geo";
import { classifyRead, codeFromLink, normalizeCode } from "../../../../../../marketplace/plugins/conference-manager/client/lib/meals";
import { OsmMap, tilesAround } from "../../../../../../marketplace/plugins/conference-manager/client/portal/yo/OsmMap";
import * as places from "../../../../../../marketplace/plugins/conference-manager/client/lib/places";

const require = createRequire(import.meta.url);
const SERVER = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/server");
const layout = require(`${SERVER}/badge-layout.js`);
const serverQr = require(`${SERVER}/badge-qr.js`);

const sample = (over: Record<string, unknown> = {}) => ({
    title: "Congreso Nacional de Jóvenes 2026", name: "María José Ñáñez de la Peña",
    lines: [{ label: "Localidad", value: "Barranquilla Norte" }, { label: null, value: "Hotel Dorado · A3" }], code: "K7M2QX", ...over,
});

describe("one display list, two renderers", () => {
    it("the plugin admin and the portal draw the same SVG", () => {
        for (const design of [{ layout: "horizontal" }, { layout: "vertical", colors: { background: "#0f766e" }, has_logo: true }]) {
            const badge = layout.buildBadge(design, sample());
            const a = renderToStaticMarkup(<BadgeSvg badge={badge} plate="data:image/jpeg;base64,AAAA" title="X" />);
            const b = renderToStaticMarkup(<BadgeCard badge={badge} plate="data:image/jpeg;base64,AAAA" title="X" />);
            expect(a).toBe(b);
            expect(a).toContain("María José");
            expect(a).toContain('shape-rendering="crispEdges"');
        }
    });

    it("the server's QR is the admin's, and what the badge draws reads back as the code (2.22.0)", () => {
        const texts = ["K7M2QX", "EUVWPL73N7", "AB2", "Z9Z9Z9Z9Z9Z9", "https://example.org/portal/conference/badge#t=0123", "María José Ñáñez", "x".repeat(150)];
        for (const text of texts) for (const ecl of ["L", "M", "Q", "H"] as const) {
            let client: ReturnType<typeof encodeQr> | null = null;
            try { client = encodeQr(text, ecl); } catch { /* too long at this level: the server must refuse too */ }
            if (!client) { expect(() => serverQr.encodeQr(text, ecl)).toThrow(); continue; }
            expect(serverQr.qrRows(serverQr.encodeQr(text, ecl))).toEqual(qrRows(client));
            // Rendered with its quiet zone, 4 px a module, jsQR (the scanner's reader) gets the text back.
            const quiet = 4, px = 4, side = (client.size + 2 * quiet) * px;
            const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
            client.modules.forEach((row, y) => row.forEach((dark, x) => {
                if (!dark) return;
                for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) rgba.fill(0, (((y + quiet) * px + dy) * side + (x + quiet) * px + dx) * 4, (((y + quiet) * px + dy) * side + (x + quiet) * px + dx) * 4 + 3);
            }));
            expect(jsQR(rgba, side, side)?.data).toBe(text);
        }
        for (const lay of ["horizontal", "vertical"]) {
            const badge = layout.buildBadge({ layout: lay }, sample({ code: "EUVWPL73N7" }));
            const item = badge.items.find((i: any) => i.t === "qr");
            expect(item.rows).toEqual(qrRows(encodeQr("EUVWPL73N7", "H")));
            expect(item.size).toBe(21);
            // At least half a millimetre a module: a phone reads it from a normal distance.
            expect(item.module).toBeGreaterThanOrEqual(0.5);
            const scan = renderToStaticMarkup(<ScanQr badge={badge} px={8} />);
            expect(scan).toContain('data-scan-qr=""');
            expect(scan).toContain('width="232"');
        }
    });

    it("every item stays inside the card, in both orientations, whatever the name", () => {
        const names = ["Ana", "María José Ñáñez de la Peña Gutiérrez Valderrama Castellanos", "X".repeat(120)];
        for (const lay of ["horizontal", "vertical"]) {
            for (const name of names) {
                const b = layout.buildBadge({ layout: lay }, sample({ name }));
                for (const it of b.items) {
                    expect(it.x).toBeGreaterThanOrEqual(0);
                    expect(it.y).toBeLessThanOrEqual(b.h_mm);
                    if (it.t === "rect") expect(it.x + it.w).toBeLessThanOrEqual(b.w_mm + 0.01);
                    if (it.t === "qr") {
                        expect(it.x + it.size * it.module).toBeLessThanOrEqual(b.w_mm);
                        expect(it.y + it.size * it.module).toBeLessThanOrEqual(b.h_mm);
                        // No text run of the name or the fields starts over the QR.
                        for (const t of b.items.filter((i: any) => i.t === "text" && i.fill !== "#111111")) {
                            const inside = t.x >= it.x - 0.5 && t.x <= it.x + it.size * it.module && t.y >= it.y && t.y <= it.y + it.size * it.module;
                            expect(inside).toBe(false);
                        }
                    }
                }
                // The name: at most 2 lines, inside its zone.
                const z = layout.zonesOf(lay).name;
                const nameRuns = b.items.filter((i: any) => i.t === "text" && i.y > z.y && i.y <= z.y + z.h + 0.01);
                expect(nameRuns.length).toBeGreaterThanOrEqual(1);
                expect(nameRuns.length).toBeLessThanOrEqual(2);
            }
        }
        expect(layout.buildBadge({ layout: "vertical" }, sample()).h_mm).toBeCloseTo(85.6);
        expect(layout.buildBadge({}, sample()).w_mm).toBeCloseTo(85.6);
    });
});

describe("the portal's helpers", () => {
    it("hasBadges reads the plugin's flag; whatsappUrl adds 57 to a 10-digit mobile, like the admin's", () => {
        expect(hasBadges({ features: { badges: 1, fee_payments: 1 } })).toBe(true);
        expect(hasBadges({ features: { fee_payments: 1 } })).toBe(false);
        expect(hasBadges(null)).toBe(false);
        const phones = ["300 123 4567", "+57 300 1234567", "0057 300 123 4567", "300 1234567 / 310 7654321", "300-123-4567 y 310 765 4321", "", null, "12", "1".repeat(20)];
        for (const phone of phones) {
            expect(whatsappUrl(phone, "Hola: x")).toBe(pluginBadges.whatsappUrl(phone, "Hola: x"));
            expect(waNumber(phone, "57")).toBe(pluginBadges.waNumber(phone, "57"));
        }
        // A list or an «00» prefix gives the first number, with the country code; junk gives no number.
        expect(waNumber("0057 300 123 4567")).toBe("573001234567");
        expect(waNumber("300 1234567 / 310 7654321")).toBe("573001234567");
        expect(waNumber("300 1234567", "593")).toBe("5933001234567");
        expect(waNumber("1".repeat(20))).toBe(null);
        expect(waNumber("12")).toBe(null);
        expect(whatsappUrl("300 123 4567", "a b")).toBe("https://wa.me/573001234567?text=a%20b");
        expect(whatsappUrl("", "a")).toBe("https://wa.me/?text=a");
    });
});

describe("the badge PDF goes through the core's portal file route", () => {
    it("the portal declares the plugin's ticket route, and the pages open /portal/conference/file", () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../../../marketplace/plugins/conference-manager/client/portal/../../manifest.json`), "utf8"));
        expect(manifest.frontend.portalPage.file).toBe("/public/badge/file");
        for (const f of ["badges.ts", "yo/MyRegistration.tsx"]) {
            const src = fs.readFileSync(path.resolve(__dirname, `../../../../../../marketplace/plugins/conference-manager/client/portal/${f}`), "utf8");
            expect(src, f).toContain("/portal/conference/file?d=");
            expect(src, f).not.toContain("/badge/file");
        }
    });
});

describe("the participant sheet", () => {
    const fields = [{ name: "first_name", label: "Nombre" }, { name: "telefono", label: "Teléfono", type: "tel" }] as any;
    const person = (cancelled = 0) => ({ id: 7, first_name: "Ana", telefono: "3001234567", cancelled, amount_paid: 0, total_due: 0 }) as any;
    const sheet = (p: any, badges: any) => renderToStaticMarkup(
        <ParticipantSheet person={p} fields={fields} onClose={() => { }} feesOn={false} canRecord={false} onPay={() => { }} badges={badges} />);
    it("offers «Escarapela» only while badges are on and the inscription is active", () => {
        const on = { authHeaders: () => ({}), conferenceName: "Congreso" };
        expect(sheet(person(), on)).toContain('data-sheet-section="escarapela"');
        expect(sheet(person(), null)).not.toContain('data-sheet-section="escarapela"');
        expect(sheet(person(1), on)).not.toContain('data-sheet-section="escarapela"');
    });
});

describe("the review fixes, in the sources", () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
    const PLUGIN = "../../../../../../marketplace/plugins/conference-manager/client";
    it("PDFs open in a new tab (the admin keeps its page and any unsaved edit), copies start inside the click", () => {
        const page = read(`${PLUGIN}/admin/BadgesPage.tsx`), actions = read(`${PLUGIN}/admin/BadgeActions.tsx`), portal = read("../../../../../../marketplace/plugins/conference-manager/client/portal/PortalBadges.tsx");
        for (const src of [page, actions]) expect(src).not.toMatch(/openBadgeFile\(/);
        expect(page).toContain("openBadgeFileFrom(");
        expect(actions).toContain("openBadgeFileFrom(");
        expect(page).toContain("copyLater(text)");
        expect(portal).toContain("copyLater(text)");
        // The portal's «Ver» and «WhatsApp» are real links once the person's link is known (no window.open after a request).
        expect(portal).not.toContain("window.open(");
        expect(portal).toContain('data-action="badge-open"');
    });
    it("the designer (2.29.0) saves the design with the policy, its images already uploaded, and locks the form meanwhile", () => {
        const page = read(`${PLUGIN}/admin/BadgesPage.tsx`);
        const save = page.slice(page.indexOf("const save = async"), page.indexOf("if (loading) return"));
        expect(save).toContain("saveConfig(conferenceId, design, policy)");
        expect(page).toContain("const locked = !canManage || saving;");
        expect(page).not.toContain("disabled={!canManage}");
        // An image goes to the gallery when it is picked (badgesApi.putImage), so a saved design never points at a missing one.
        expect(read(`${PLUGIN}/admin/BadgeEditor.tsx`)).toContain("badgesApi.putImage(conferenceId, img.url, img.w, img.h)");
    });
});

describe("each person's badge, in the admin and the portal", () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
    const PLUGIN = "../../../../../../marketplace/plugins/conference-manager/client";
    it("«Escarapelas › Personas» lists every person with view / copy / WhatsApp, and the bulk tools say they act on everyone", () => {
        const page = read(`${PLUGIN}/admin/BadgesPage.tsx`);
        expect(page).toContain("function PeopleView(");
        expect(page).toContain('data-badges-tab="people"');
        for (const act of ["view", "copy", "whatsapp"]) expect(page).toContain(`data-badge-row="${act}"`);
        // One person's copy starts inside the tap (a promise of the link), and a revoked link is not shown again.
        expect(page).toContain("copyLater(url)");
        expect(page).toContain("badgesApi.existingLinks(conferenceId)");
        expect(page).toContain("tx('badges.bulk.copy', 'Copiar todos los enlaces')");
        // The designer is hidden, not unmounted, behind the other tabs (an unsaved edit and its undo history stay).
        expect(page).toContain("style={tab === 'design' ? undefined : { display: 'none' }}");
        // A never-saved design can be saved as it is (coordinators only see a saved one).
        expect(page).toContain("disabled={saving || (cfg.configured && !dirty)}");
        // The list's location filter is the bulk tools' (the location column), and the bulk names are read when clicked.
        expect(page).toContain("String(rawLocationId(x.r)) === loc");
        expect(page).toMatch(/const roster = async \(\) => \{\s+const \[rows, f\] = await Promise\.all\(\[conferenceApi\.getInscriptions/);
        // A slow first load of the links never undoes a regenerate or a revoke made meanwhile.
        expect(page).toContain("if (seq !== linkSeq.current) return;");
    });
    it("counters agree in number (1 persona, Abierta 1 vez)", () => {
        for (const lang of ["es", "en", "pt"] as const) for (const k of ["badges.people.count.one", "badges.people.opened.one", "badges.people.more.one", "badges.person.views.one"]) {
            expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
            expect((translations as any)[lang][k]).not.toContain("{n}");
        }
        expect((translations as any).es["badges.people.opened.one"]).toBe("Abierta 1 vez");
    });
    it("the portal says how to reach one person's badge, and re-reads its flags when the coordinator comes back", () => {
        expect(read("../../../../../../marketplace/plugins/conference-manager/client/portal/PortalBadges.tsx")).toContain("data-portal-badges-hint");
        const page = read("../../../../../../marketplace/plugins/conference-manager/client/portal/CoordinatorPortal.tsx");
        expect(page).toMatch(/refreshMyLocation\(\);[\s\S]{0,120}addEventListener\('visibilitychange'/);
        // A portal that never leaves the screen still learns it: focus, back-forward restore, and once a minute.
        for (const ev of ["focus", "pageshow"]) expect(page).toContain(`window.addEventListener('${ev}', reread)`);
        expect(page).toContain("window.setInterval(reread, 60000)");
    });
});

describe("the admin's texts", () => {
    it("every «Escarapelas» text exists in es / en / pt", () => {
        const keys = Object.keys(translations.es).filter((k) => k.startsWith("badges.") || k.startsWith("staff.section.badges"));
        expect(keys.length).toBeGreaterThanOrEqual(70);
        for (const lang of ["en", "pt"] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

// ── «Mi inscripción» (2.23.0) ──
describe("«Mi inscripción»: the QR link, the hotel position, the map", () => {
    const serverGeo = require(`${SERVER}/geo.js`);
    it("the hotel form reads a position exactly like the server", () => {
        const inputs = [
            "https://www.google.com/maps/place/Hotel/@11.0004337,-74.8084564,17z/data=!3m1!4b1!8m2!3d11.0004284!4d-74.8058815!16s",
            "https://www.google.com/maps/@10.9878,-74.7889,15z", "https://www.google.com/maps?q=10.98765,-74.78123",
            "https://www.google.com/maps/search/?api=1&query=10.98765%2C-74.78123", "https://www.openstreetmap.org/#map=17/10.98780/-74.78890",
            "10.98765, -74.78123", "geo:10.98,-74.78", "https://maps.app.goo.gl/AbC", "Calle 2 # 50", "95, 10", "",
        ];
        for (const s of inputs) expect(parseGeo(s), s).toEqual(serverGeo.parseGeo(s));
        expect(parseGeo(inputs[0])).toEqual({ ok: true, geo: "11.000428,-74.805881" });   // the place's pin, not the map's centre
        expect(parseGeo("https://maps.app.goo.gl/AbC")).toEqual({ ok: false, code: "short_link" });
    });

    it("the kitchen's scanner takes the code out of the badge link", () => {
        const link = "https://iglesiabaq.org/portal/conference/yo#c=EUVWPL73N7";
        expect(codeFromLink(link)).toBe("EUVWPL73N7");
        expect(normalizeCode(link)).toBe("EUVWPL73N7");
        expect(classifyRead(link, "qr_code")).toEqual({ kind: "reg", code: "EUVWPL73N7", format: "qr_code" });
        expect(classifyRead("EUVWPL73N7", "qr_code")).toEqual({ kind: "reg", code: "EUVWPL73N7", format: "qr_code" });
        expect(classifyRead("https://example.org/?c=SHORT", "qr_code")).toMatchObject({ kind: "other" });
    });

    it("a badge carrying a long link still prints a QR a phone reads (both orientations)", () => {
        // A real domain, and a very long one (a test tunnel's): the module shrinks with the link's length.
        const cases = [["https://iglesiabaq.org/portal/conference/yo#c=EUVWPL73N7", 0.5], ["https://united-with-replication-algorithms.trycloudflare.com/portal/conference/yo#c=EUVWPL73N7", 0.4]] as const;
        for (const [link, minModule] of cases) for (const lay of ["horizontal", "vertical"]) {
            const b = layout.buildBadge({ layout: lay }, { ...sample({ code: "EUVWPL73N7" }), qr: link });
            const item = b.items.find((i: any) => i.t === "qr");
            expect(item.rows).toEqual(qrRows(encodeQr(link, "M")));
            expect(item.module, `${lay} ${link}`).toBeGreaterThanOrEqual(minModule);   // mm a module
            const quiet = 4, px = 4, side = (item.size + 2 * quiet) * px;
            const rgba = new Uint8ClampedArray(side * side * 4).fill(255);
            item.rows.forEach((row: string, y: number) => [...row].forEach((c, x) => {
                if (c !== "1") return;
                for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) { const k = (((y + quiet) * px + dy) * side + (x + quiet) * px + dx) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = 0; }
            }));
            expect(jsQR(rgba, side, side)?.data).toBe(link);
            // The printed code under / beside it is still the bare code.
            expect(b.items.some((i: any) => i.t === "text" && i.text === "EUVWPL73N7")).toBe(true);
        }
    });

    it("the map puts the point at the centre and credits OpenStreetMap", () => {
        const tiles = tilesAround(10.9878, -74.7889);
        expect(tiles).toHaveLength(15);
        // The tile holding the point starts at most one tile up / left of it.
        const home = tiles.filter((t) => t.dx <= 0 && t.dx > -256 && t.dy <= 0 && t.dy > -256);
        expect(home).toHaveLength(1);
        expect(home[0].src).toMatch(/^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/);
        const html = renderToStaticMarkup(<OsmMap lat={10.9878} lng={-74.7889} label="Mapa" />);
        expect(html).toContain("© OpenStreetMap");
        expect(html.toLowerCase()).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    });
});

describe("the hotel's place picker (2.24.0): search results and map arithmetic", () => {
    it("reads Nominatim's answer and asks it politely", () => {
        const url = new URL(places.nominatimUrl("Hotel El Prado Barranquilla", "co"));
        expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ format: "jsonv2", q: "Hotel El Prado Barranquilla", countrycodes: "co", "accept-language": "es" });
        expect(places.countryFromLocale("es-CO")).toBe("co");
        expect(places.countryFromLocale("es")).toBe("");
        const rows = places.parseNominatim([
            { place_id: 1, name: "Hotel El Prado", display_name: "Hotel El Prado, Carrera 54, El Prado, Barranquilla, Atlántico, 080001, Colombia", lat: "11.0045821", lon: "-74.8072334" },
            { place_id: 2, display_name: "nowhere", lat: "x", lon: "1" },
            null,
        ], "co");
        expect(rows).toEqual([{ id: "1", title: "Hotel El Prado", subtitle: "Carrera 54, El Prado, Barranquilla, Atlántico", label: expect.any(String), lat: 11.0045821, lng: -74.8072334 }]);
        expect(places.parseNominatim({ error: "x" })).toEqual([]);
    });

    it("a click lands where it was made, and the pin is drawn where it is", () => {
        const center = { lat: 11.0045, lng: -74.8072 };
        for (const zoom of [5, 12, 17]) {
            const p = places.pointAtPixel(310, 40, center, zoom, 400, 260);
            const px = places.pixelOf(p, center, zoom, 400, 260);
            expect(px.x).toBeCloseTo(310, 6);
            expect(px.y).toBeCloseTo(40, 6);
            const back = places.pointOf(places.tileOf(center, zoom), zoom);
            expect(back.lat).toBeCloseTo(center.lat, 9);
            expect(back.lng).toBeCloseTo(center.lng, 9);
        }
        // The centre pixel is the centre, and the tiles cover the whole view.
        const c = places.pixelOf(center, center, 16, 400, 260);
        expect([c.x, c.y]).toEqual([200, 130]);
        const tiles = places.tilesFor(center, 16, 400, 260);
        expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
        expect(Math.max(...tiles.map((t) => t.left + 256))).toBeGreaterThanOrEqual(400);
        expect(Math.min(...tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
        expect(Math.max(...tiles.map((t) => t.top + 256))).toBeGreaterThanOrEqual(260);
        expect(tiles.every((t) => /^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/.test(t.src))).toBe(true);
    });
});

// ── Bus notices (2.27.0) ──
describe("«Mi inscripción»: the bus, its boarding state and the notices", () => {
    const bus = (status: "scheduled" | "boarding" | "departed", notices: any[] = []) => ({
        id: 7, name: "Bus Norte", origin: "Medellín", destination: "Cartagena", departure: "2026-11-02T05:30", status,
        boarding_at: status !== "scheduled" ? "2026-11-02T10:05:00.000Z" : null, departed_at: status === "departed" ? "2026-11-02T10:40:00.000Z" : null, notices,
    });
    const post = async () => ({ status: 200, body: {} });
    it("shows each state, the team's messages, and the switch (server render: before the browser is asked)", async () => {
        const { BusAlerts } = await import("../../../../../../marketplace/plugins/conference-manager/client/portal/yo/BusAlerts");
        const scheduled = renderToStaticMarkup(<BusAlerts session={"a".repeat(32)} initial={[bus("scheduled")]} pushKey="BKEY" post={post} />);
        expect(scheduled).toContain('data-bus-status="scheduled"');
        expect(scheduled).toContain("Programado");
        expect(scheduled).toContain("Medellín → Cartagena");
        const boarding = renderToStaticMarkup(<BusAlerts session={"a".repeat(32)} initial={[bus("boarding", [{ kind: "message", text: "Puerta 3", at: "2026-11-02T10:06:00.000Z" }, { kind: "boarding", text: null, at: null }])]} pushKey="BKEY" post={post} />);
        expect(boarding).toContain('data-bus-status="boarding"');
        expect(boarding).toContain("Tu bus está embarcando");
        expect(boarding).toContain("Puerta 3");
        expect(boarding.match(/data-bus-message=/g)?.length).toBe(1);
        const departed = renderToStaticMarkup(<BusAlerts session={"a".repeat(32)} initial={[bus("departed")]} pushKey="BKEY" post={post} />);
        expect(departed).toContain("El bus salió");
        expect(renderToStaticMarkup(<BusAlerts session={"a".repeat(32)} initial={[]} pushKey="BKEY" post={post} />)).toBe("");
    });
    it("the service worker shows the notice and opens the page; the page is installable for iPhone", () => {
        const root = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/client/portal");
        const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
        expect(sw).toContain("showNotification");
        expect(sw).toContain("notificationclick");
        expect(sw).toMatch(/openWindow\(PAGE\)/);
        expect(sw).toContain("const PAGE = '/portal/conference/yo';");
        // The portal page declares the worker (served at /portal/conference/sw.js) and «Mi inscripción» as an
        // installable, private sub-page (its web app manifest: /portal/conference/app.webmanifest?page=yo).
        const portal = JSON.parse(fs.readFileSync(path.join(root, "../../manifest.json"), "utf8")).frontend.portalPage;
        expect(portal.slug).toBe("conference");
        expect(portal.serviceWorker).toBe("client/portal/sw.js");
        expect(portal.pages.yo.private).toBe(true);
        expect(portal.pages.yo.app.name).toBe("Mi inscripción");
        const alerts = fs.readFileSync(path.join(root, "yo/BusAlerts.tsx"), "utf8");
        expect(alerts).toContain('const SW_URL = "/portal/conference/sw.js";');
        expect(alerts).toContain('const SW_SCOPE = "/portal/conference/yo";');
    });
    it("every bus-notice text of the admin exists in es / en / pt", () => {
        const keys = Object.keys(translations.es).filter((k) => k.startsWith("transport.notice."));
        expect(keys.length).toBeGreaterThanOrEqual(25);
        for (const lang of ["en", "pt"] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});

describe("a shared badge link (2.28.0)", () => {
    it("goes to «Mi inscripción» when the plugin says so — only to that page, never to an address it is handed", () => {
        const src = fs.readFileSync(path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/client/portal/badge/BadgePage.tsx"), "utf8");
        expect(src).toContain("window.location.replace(body.self)");
        expect(src).toContain("SELF.test(body.self)");
        expect(src).toContain("conference\\/yo#c=[A-Z0-9]{10}$/;");
        expect(src, "the link page draws no badge any more").not.toContain("BadgeCard");
    });
});

// ── The free-form designer (2.29.0) ──
describe("the badge designer", () => {
    const req = createRequire(import.meta.url);
    const SERVER = path.resolve(__dirname, "../../../../../../marketplace/plugins/conference-manager/server");
    const designLib = req(path.join(SERVER, "badge-design.js"));
    const fontLib = req(path.join(SERVER, "badge-font.js"));
    const metrics = fontLib.createMetrics(() => null);
    it("every template is a valid design with its one QR, and lays out with the server's code", async () => {
        const { TEMPLATES } = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/badgeEditor");
        expect(TEMPLATES.length).toBeGreaterThanOrEqual(6);
        for (const t of TEMPLATES) {
            const d = designLib.normalizeDesignV2(t.make());
            expect(d.elements.filter((e: any) => e.type === "qr").length, t.id).toBe(1);
            expect(d.elements.length, t.id).toBe(t.make().elements.length);
            const qr = d.elements.find((e: any) => e.type === "qr");
            const card = designLib.cardOf(d.layout);
            expect(qr.x >= 0 && qr.y >= 0 && qr.x + qr.w <= card.w && qr.y + qr.h <= card.h, `${t.id}: the QR is on the card`).toBe(true);
            const badge = designLib.layoutDesign(d, { data: { "@name": "Ana", "@code": "ABCD2345EF", "@conference": "Congreso" }, qr: "ABCD2345EF", metrics, images: {} });
            expect(badge.items.some((i: any) => i.t === "qr")).toBe(true);
            expect(badge.items.some((i: any) => i.t === "text" && i.text.includes("Ana"))).toBe(true);
        }
    });
    it("a pre-2.29 design opens converted: its title, name, fields and code in place, the QR where it was", async () => {
        const { fromLegacy } = await import("../../../../../../marketplace/plugins/conference-manager/client/lib/badgeEditor");
        const zonesOf = req(path.join(SERVER, "badge-layout.js")).zonesOf;
        for (const layout of ["horizontal", "vertical"]) {
            const old = { layout, title: "", colors: { background: "#0f766e", text: "#ffffff", label: "#bfdbfe", accent: "#fbbf24" }, panel: "dark", fields: [{ key: "@location", show_label: true }] };
            const d = fromLegacy(old, { horizontal: zonesOf("horizontal"), vertical: zonesOf("vertical") }, { bg: { id: "a".repeat(16) }, logo: null }, () => "Localidad", 3);
            expect(d.version).toBe(2);
            expect(d.layout).toBe(layout);
            expect(d.background).toBe("#0f766e");
            expect(d.elements[0]).toMatchObject({ type: "image", asset: "a".repeat(16), x: 0, y: 0 });
            const texts = d.elements.filter((e: any) => e.type === "text").map((e: any) => e.text);
            expect(texts).toEqual(expect.arrayContaining(["{{@conference}}", "{{@name}}", "LOCALIDAD  {{@location}}", "{{@code}}"]));
            expect(d.elements.filter((e: any) => e.type === "qr").length).toBe(1);
        }
    });
    it("the admin and the portal draw a free-form badge alike: shapes, rotation, opacity, images and faces", () => {
        const d = designLib.normalizeDesignV2({ version: 2, layout: "horizontal", background: "#0f172a", elements: [
            { type: "shape", shape: "ellipse", x: 60, y: 2, w: 20, h: 8, fill: null, stroke: "#ffffff", sw: 0.5, op: 0.6 },
            { type: "image", asset: "b".repeat(16), x: 3, y: 2, w: 8, h: 8, mask: "circle" },
            { type: "text", x: 4, y: 16, w: 50, h: 14, text: "{{@name}}", font: "montserrat", bold: true, size: 20, color: "#ffffff", rot: 10, ls: 0.5 },
            { type: "line", x: 4, y: 30, w: 50, h: 1, stroke: "#f59e0b", sw: 0.4 },
        ] });
        const badge = designLib.layoutDesign(d, { data: { "@name": "María José" }, qr: "ABCD2345EF", metrics, images: { ["b".repeat(16)]: { w: 4, h: 2 } } });
        const images = { ["b".repeat(16)]: "data:image/png;base64,AAAA" };
        const a = renderToStaticMarkup(<BadgeSvg badge={badge} images={images} title="X" />);
        const b = renderToStaticMarkup(<BadgeCard badge={badge} images={images} title="X" />);
        expect(a).toBe(b);
        expect(a).toContain("<ellipse");
        expect(a).toContain('opacity="0.6"');
        expect(a).toContain("rotate(10 ");
        expect(a).toContain("clip-path=");
        expect(a).toContain("cmb-montserrat-700");
        expect(a).toContain("María José");
    });
    it("every designer text exists in es / en / pt", () => {
        const keys = Object.keys(translations.es).filter((k) => k.startsWith("badges.ed."));
        expect(keys.length).toBeGreaterThanOrEqual(100);
        for (const lang of ["en", "pt"] as const) for (const k of keys) expect((translations as any)[lang][k], `${lang} ${k}`).toBeTruthy();
    });
});
