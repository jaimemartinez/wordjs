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
import { BadgeCard, ScanQr } from "../badge/BadgeCard";
import { BadgeSvg } from "../../../../../../marketplace/plugins/conference-manager/client/admin/BadgeSvg";
import { encodeQr, qrRows } from "../../../../../../marketplace/plugins/conference-manager/client/lib/qr";
import jsQR from "../../../../../../marketplace/plugins/conference-manager/client/lib/vendor/jsQR";
import * as pluginBadges from "../../../../../../marketplace/plugins/conference-manager/client/lib/badges";
import { translations } from "../../../../../../marketplace/plugins/conference-manager/client/lib/i18n";
import { hasBadges, waNumber, whatsappUrl } from "../badges";
import fs from "node:fs";
import ParticipantSheet from "../ParticipantSheet";
import { parseGeo } from "../../../../../../marketplace/plugins/conference-manager/client/lib/geo";
import { classifyRead, codeFromLink, normalizeCode } from "../../../../../../marketplace/plugins/conference-manager/client/lib/meals";
import { OsmMap, tilesAround } from "../yo/OsmMap";

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

describe("the file route", () => {
    it("answers the PDF bytes with their type, never cached or sniffed; a bad ticket or another type is a 410", async () => {
        vi.resetModules();
        const replies: Record<string, unknown> = {
            ["a".repeat(32)]: { mime: "application/pdf", filename: "Escarapela María.pdf", b64: Buffer.from("%PDF-1.4 x").toString("base64") },
            ["b".repeat(32)]: { mime: "text/html", filename: "x.html", b64: Buffer.from("<script>").toString("base64") },
        };
        vi.doMock("@/lib/server-api", () => ({
            serverFetch: async (endpoint: string) => replies[new URL(`http://x${endpoint}`).searchParams.get("d") || ""] ?? null,
        }));
        const { GET } = await import("../badge/file/route");
        const ok = await GET(new Request(`http://site/portal/conference/badge/file?d=${"a".repeat(32)}`));
        expect(ok.status).toBe(200);
        expect(ok.headers.get("content-type")).toBe("application/pdf");
        expect(ok.headers.get("cache-control")).toBe("no-store");
        expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
        expect(ok.headers.get("content-disposition")).toBe('inline; filename="Escarapela-Mar-a.pdf"');
        expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("%PDF-1.4 x");
        for (const d of ["b".repeat(32), "c".repeat(32), "../etc", ""]) {
            const r = await GET(new Request(`http://site/portal/conference/badge/file?d=${encodeURIComponent(d)}`));
            expect(r.status).toBe(410);
        }
        vi.doUnmock("@/lib/server-api");
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
        const page = read(`${PLUGIN}/admin/BadgesPage.tsx`), actions = read(`${PLUGIN}/admin/BadgeActions.tsx`), portal = read("../PortalBadges.tsx");
        for (const src of [page, actions]) expect(src).not.toMatch(/openBadgeFile\(/);
        expect(page).toContain("openBadgeFileFrom(");
        expect(actions).toContain("openBadgeFileFrom(");
        expect(page).toContain("copyLater(text)");
        expect(portal).toContain("copyLater(text)");
        // The portal's «Ver» and «WhatsApp» are real links once the person's link is known (no window.open after a request).
        expect(portal).not.toContain("window.open(");
        expect(portal).toContain('data-action="badge-open"');
    });
    it("the designer saves the images and plates first and the design last, and locks the form meanwhile", () => {
        const page = read(`${PLUGIN}/admin/BadgesPage.tsx`);
        const save = page.slice(page.indexOf("const save = async"), page.indexOf("// Text contrast"));
        expect(save.indexOf("putAsset(conferenceId, 'plate_print'")).toBeGreaterThan(0);
        expect(save.indexOf("saveConfig(conferenceId, design, policy)")).toBeGreaterThan(save.indexOf("putAsset(conferenceId, 'plate_screen'"));
        expect(page).toContain("const locked = !canManage || saving;");
        expect(page).not.toContain("disabled={!canManage}");
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
        // The designer is hidden, not unmounted, behind «Personas» (an unsaved edit stays).
        expect(page).toContain("style={canLinks && tab === 'people' ? { display: 'none' } : undefined}");
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
        expect(read("../PortalBadges.tsx")).toContain("data-portal-badges-hint");
        const page = read("../page.tsx");
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
