/**
 * F3 — partición de pestañas del panel de propiedades (equivalente explícito del filtrado CSS
 * :has(.wjs-f-*) del editor actual): look → Estilo; anim/hide → Avanzado; resto → Contenido.
 * Verificado también contra las definiciones REALES (withSharedVersoFields) y los root fields.
 */
import { describe, expect, it } from "vitest";
import type { BlockDefinition, VersoField } from "@/lib/verso/registry";
import { withSharedVersoFields } from "@/lib/verso/sharedFields";
import { partitionFieldEntries, tabAvailability, tabOfFieldKey } from "../panelTabs";

const textField = (label: string): VersoField => ({ type: "text", label });

describe("tabOfFieldKey", () => {
    it("mapea las claves compartidas y deja el resto en Contenido", () => {
        expect(tabOfFieldKey("look")).toBe("style");
        expect(tabOfFieldKey("anim")).toBe("advanced");
        expect(tabOfFieldKey("hide")).toBe("advanced");
        expect(tabOfFieldKey("title")).toBe("content");
        expect(tabOfFieldKey("css")).toBe("content"); // el escape hatch css vive en Contenido, como hoy
    });
});

describe("partitionFieldEntries / tabAvailability", () => {
    it("un bloque envuelto por withSharedVersoFields habilita las 3 pestañas", () => {
        const def: BlockDefinition = {
            type: "X",
            fields: { title: textField("Título") },
            defaultProps: { title: "" },
            render: () => null,
        };
        const wrapped = withSharedVersoFields(def);
        const parts = partitionFieldEntries(wrapped.fields);
        expect(parts.content.map(([k]) => k)).toEqual(["title"]);
        expect(parts.style.map(([k]) => k)).toEqual(["look"]);
        expect(parts.advanced.map(([k]) => k)).toEqual(["hide", "anim"]);
        const avail = tabAvailability(wrapped.fields);
        expect(avail).toEqual({ content: true, style: true, advanced: true });
    });

    it("los root fields (sin campos compartidos) deshabilitan Estilo y Avanzado — la vista Página", () => {
        const rootLike: Record<string, VersoField> = {
            title: textField("Title"),
            slug: textField("Slug (Permalink)"),
            _wjs_template: { type: "custom", label: "Theme template", render: () => null },
        };
        const avail = tabAvailability(rootLike);
        expect(avail.style).toBe(false);
        expect(avail.advanced).toBe(false);
        const parts = partitionFieldEntries(rootLike);
        expect(parts.content.length).toBe(3);
        expect(parts.style.length).toBe(0);
        expect(parts.advanced.length).toBe(0);
    });

    it("preserva el orden de declaración dentro de cada pestaña", () => {
        const fields: Record<string, VersoField> = {
            b: textField("B"),
            a: textField("A"),
            look: { type: "custom", render: () => null },
            hide: { type: "custom", render: () => null },
            anim: { type: "custom", render: () => null },
        };
        const parts = partitionFieldEntries(fields);
        expect(parts.content.map(([k]) => k)).toEqual(["b", "a"]);
        expect(parts.advanced.map(([k]) => k)).toEqual(["hide", "anim"]);
    });
});
