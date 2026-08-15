/**
 * F3 ola 4 — resolución de la plantilla del tema en el canvas Verso (checklist W30): la parte PURA
 * (resolveCanvasTemplate sobre canvasTemplateCandidates) espejo del resolver público — el mismo
 * contrato most-specific-first + hoisting del pick del autor + fail-closed que CanvasThemeTemplate
 * legacy y ThemeTemplate público, verificable en node sin red ni DOM.
 */
import { describe, expect, it, vi } from "vitest";
import { canvasTemplateCandidates } from "@/lib/canvasTemplate";
import { resolveCanvasTemplate, type FetchTemplateRaw } from "../VersoThemeTemplate";

/** Un template mínimo VÁLIDO para el contrato (exactamente un PageContent). */
const VALID = JSON.stringify({ content: [{ type: "PageContent", props: {} }] });
/** Válido y distinguible (una Section alrededor del hueco). */
const VALID_SECTION = JSON.stringify({
    content: [{ type: "Section", props: { items: [{ type: "PageContent", props: {} }] } }],
});

/** Fetcher de mentira: el "tema" trae exactamente los ficheros del mapa. */
function shipping(files: Record<string, string>): FetchTemplateRaw {
    return (name) => Promise.resolve(Object.prototype.hasOwnProperty.call(files, name) ? files[name] : null);
}

describe("canvasTemplateCandidates (las mismas reglas del resolver público)", () => {
    it("page: la cadena es [page]; el pick del autor se iza al frente sin duplicar", () => {
        expect(canvasTemplateCandidates("page")).toEqual(["page"]);
        expect(canvasTemplateCandidates("page", undefined, undefined, "landing")).toEqual(["landing", "page"]);
        expect(canvasTemplateCandidates("page", undefined, undefined, "page")).toEqual(["page"]);
    });

    it("single+post: single-post → single → page; el pick va delante de todo", () => {
        expect(canvasTemplateCandidates("single", undefined, "post")).toEqual(["single-post", "single", "page"]);
        expect(canvasTemplateCandidates("single", undefined, "post", "portada")).toEqual([
            "portada",
            "single-post",
            "single",
            "page",
        ]);
    });

    it("un pick que no pasa TEMPLATE_NAME se DESCARTA (fail-closed), nunca llega a la URL", () => {
        for (const bad of ["../../etc", "Mayúsculas", "con espacio", "a".repeat(41), ""]) {
            expect(canvasTemplateCandidates("page", undefined, undefined, bad)).toEqual(["page"]);
        }
    });
});

describe("resolveCanvasTemplate (primer candidato que el tema trae Y valida)", () => {
    it("gana el más específico que exista: single-post antes que single/page", async () => {
        const fetchRaw = shipping({ "single-post": VALID_SECTION, single: VALID, page: VALID });
        const r = await resolveCanvasTemplate(canvasTemplateCandidates("single", undefined, "post"), fetchRaw);
        expect(r?.name).toBe("single-post");
        expect(r?.tree.content[0].type).toBe("Section");
    });

    it("el pick del autor gana si el tema lo trae; si no, degrada a la jerarquía normal", async () => {
        const files = { landing: VALID_SECTION, page: VALID };
        const withPick = await resolveCanvasTemplate(
            canvasTemplateCandidates("page", undefined, undefined, "landing"),
            shipping(files),
        );
        expect(withPick?.name).toBe("landing");

        const missingPick = await resolveCanvasTemplate(
            canvasTemplateCandidates("page", undefined, undefined, "no-existe"),
            shipping(files),
        );
        expect(missingPick?.name).toBe("page"); // degrada igual que degradará la página pública
    });

    it("un fichero INVÁLIDO (JSON roto / fuera de contrato) es un miss y la cadena sigue", async () => {
        const r = await resolveCanvasTemplate(
            ["roto", "sin-hueco", "page"],
            shipping({
                roto: "{ no es json",
                // válido sintácticamente pero SIN PageContent → parseTemplate lo rechaza (slots !== 1)
                "sin-hueco": JSON.stringify({ content: [{ type: "Spacer", props: {} }] }),
                page: VALID,
            }),
        );
        expect(r?.name).toBe("page");
    });

    it("tema sin plantillas o fetcher que lanza → null (el canvas queda intacto)", async () => {
        expect(await resolveCanvasTemplate(["page"], shipping({}))).toBeNull();
        const throwing = vi.fn<FetchTemplateRaw>(() => Promise.reject(new Error("backend caído")));
        expect(await resolveCanvasTemplate(["landing", "page"], throwing)).toBeNull();
        expect(throwing).toHaveBeenCalledTimes(2); // cada candidato se intenta, ninguno rompe
    });

    it("se detiene en el PRIMER acierto (no fetchea el resto de la cadena)", async () => {
        const calls: string[] = [];
        const fetchRaw: FetchTemplateRaw = (name) => {
            calls.push(name);
            return Promise.resolve(name === "single" ? VALID : null);
        };
        const r = await resolveCanvasTemplate(["single-post", "single", "page"], fetchRaw);
        expect(r?.name).toBe("single");
        expect(calls).toEqual(["single-post", "single"]);
    });
});
