/**
 * El modelo de la UI de colaboración (F8.4). Aquí se afirma lo que una captura de pantalla no
 * puede afirmar: que NADA depende solo del color y que el contraste no se elige a ojo.
 */

import { describe, expect, it } from "vitest";
import type { CollabMember } from "@/lib/verso/collab";
import {
    initialsOf,
    memberLabel,
    noticeSeverity,
    onColor,
    presenceAnnouncement,
    remoteSelections,
    safeColor,
    selectionsByNode,
    statusView,
} from "../collabModel";

const member = (over: Partial<CollabMember> = {}): CollabMember => ({
    siteId: "s1",
    userId: 1,
    name: "Ana Pérez",
    color: "#2563eb",
    sel: null,
    at: 0,
    ...over,
});

describe("initialsOf", () => {
    it("toma la primera y la última palabra", () => {
        expect(initialsOf("Ana Pérez")).toBe("AP");
        expect(initialsOf("Ana María Pérez Gil")).toBe("AG");
    });
    it("una sola palabra da una inicial", () => {
        expect(initialsOf("admin")).toBe("A");
    });
    it("nunca deja el avatar mudo", () => {
        expect(initialsOf("")).toBe("?");
        expect(initialsOf("   ")).toBe("?");
    });
    it("no parte los caracteres fuera del plano básico", () => {
        // Con `name[0]` esto devolvería medio par suplente (una caja rota).
        expect(initialsOf("😀lga Ruiz")).toBe("😀R");
    });
});

describe("safeColor / onColor", () => {
    it("acepta #rrggbb y expande #rgb", () => {
        expect(safeColor("#2563EB")).toBe("#2563eb");
        expect(safeColor("#abc")).toBe("#aabbcc");
    });
    it("lo que no es un color cae a un gris legible (nunca a CSS inyectado)", () => {
        expect(safeColor("red; background:url(x)")).toBe("#6b7280");
        expect(safeColor(null)).toBe("#6b7280");
        expect(safeColor(undefined)).toBe("#6b7280");
    });
    it("elige el texto por LUMINANCIA, no por corazonada", () => {
        expect(onColor("#ffffff")).toBe("#111827"); // blanco → texto oscuro
        expect(onColor("#000000")).toBe("#ffffff");
        expect(onColor("#fde047")).toBe("#111827"); // amarillo claro: blanco encima sería ilegible
        expect(onColor("#2563eb")).toBe("#ffffff");
    });
});

describe("statusView", () => {
    it("todo estado trae glifo Y texto (el color nunca es la única señal)", () => {
        for (const status of ["off", "connecting", "live", "degraded", "offline"] as const) {
            const v = statusView(status);
            expect(v.icon.length).toBeGreaterThan(0);
            expect(v.text.length).toBeGreaterThan(0);
            expect(v.detail.length).toBeGreaterThan(0);
        }
    });
    it("`degraded` explica QUÉ hacer, no solo que algo va mal", () => {
        const v = statusView("degraded");
        expect(v.tone).toBe("warn");
        expect(v.detail).toMatch(/guarda y recarga/i);
    });
    it("un estado desconocido no rompe la barra", () => {
        expect(statusView("lo-que-sea" as never).text).toBe(statusView("off").text);
    });
});

describe("noticeSeverity", () => {
    it("lo que obliga a actuar se distingue de lo que solo informa", () => {
        expect(noticeSeverity({ code: "log-full" })).toBe("action");
        expect(noticeSeverity({ code: "epoch-reset" })).toBe("action");
        expect(noticeSeverity({ code: "forbidden" })).toBe("action");
        expect(noticeSeverity({ code: "rejected-ops" })).toBe("action");
        expect(noticeSeverity({ code: "reconnected" })).toBe("info");
        expect(noticeSeverity({ code: "rate-limited" })).toBe("info");
    });
});

describe("remoteSelections", () => {
    it("solo salen los que tienen un bloque seleccionado", () => {
        const out = remoteSelections([
            member({ siteId: "a", sel: { nodeId: "n1" } }),
            member({ siteId: "b", sel: null }),
            member({ siteId: "c", sel: { nodeId: "" } }),
        ]);
        expect(out.map((s) => s.siteId)).toEqual(["a"]);
    });
    it("`editing` distingue escribir DENTRO de solo tenerlo seleccionado", () => {
        const [sel, edit] = remoteSelections([
            member({ siteId: "a", sel: { nodeId: "n1" } }),
            member({ siteId: "b", sel: { nodeId: "n1", field: "content" } }),
        ]);
        expect(sel.editing).toBe(false);
        expect(edit.editing).toBe(true);
    });
    it("el color del servidor pasa por el saneador", () => {
        const [s] = remoteSelections([member({ sel: { nodeId: "n1" }, color: "javascript:alert(1)" })]);
        expect(s.color).toBe("#6b7280");
    });
    it("un participante sin nombre no se pinta como una etiqueta vacía", () => {
        const [s] = remoteSelections([member({ name: "  ", sel: { nodeId: "n1" } })]);
        expect(s.name).toBe("Alguien");
    });
    it("dos personas en el MISMO bloque salen las dos, en orden estable", () => {
        const map = selectionsByNode(
            remoteSelections([
                member({ siteId: "a", name: "Ana", sel: { nodeId: "n1" } }),
                member({ siteId: "b", name: "Beto", sel: { nodeId: "n1" } }),
                member({ siteId: "c", name: "Caro", sel: { nodeId: "n2" } }),
            ]),
        );
        expect(map.get("n1")?.map((p) => p.name)).toEqual(["Ana", "Beto"]);
        expect(map.get("n2")?.map((p) => p.name)).toEqual(["Caro"]);
    });
});

describe("texto accesible", () => {
    it("el avatar se lee en palabras, con su estado", () => {
        expect(memberLabel(member({ sel: null }))).toBe("Ana Pérez — en la página");
        expect(memberLabel(member({ sel: { nodeId: "n1" } }))).toBe("Ana Pérez — editando un bloque");
    });
    it("el anuncio del role=status dice el estado y quién está", () => {
        expect(presenceAnnouncement("live", [])).toBe("En vivo. Nadie más está editando esta página.");
        expect(presenceAnnouncement("live", [member({ name: "Ana" })])).toBe(
            "En vivo. Ana está editando esta página.",
        );
        expect(
            presenceAnnouncement("degraded", [member({ name: "Ana" }), member({ siteId: "s2", name: "Beto" })]),
        ).toBe("Limitada. Ana y Beto están editando esta página.");
    });
});
