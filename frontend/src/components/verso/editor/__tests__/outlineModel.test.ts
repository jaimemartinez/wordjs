/**
 * F3 — modelo del outline ("Estructura", W16/W17): filas en pre-orden con profundidad, label del
 * registry y glifo del catálogo compartido (fallback "widgets").
 */
import { describe, expect, it } from "vitest";
import { createEditor } from "@/lib/verso/store";
import { createBlockRegistry, makeSlotResolver, type BlockDefinition } from "@/lib/verso/registry";
import { outlineRows } from "../outlineModel";

const defs: BlockDefinition[] = [
    {
        type: "Section",
        label: "Sección",
        fields: { children: { type: "slot" } },
        defaultProps: {},
        render: () => null,
    },
    { type: "Heading", label: "Encabezado", fields: {}, defaultProps: {}, render: () => null },
    { type: "MysteryBlock", fields: {}, defaultProps: {}, render: () => null },
];

function makeHandle() {
    const registry = createBlockRegistry();
    registry.register(defs);
    const handle = createEditor({
        initialData: {
            content: [
                {
                    type: "Section",
                    props: {
                        id: "s1",
                        children: [
                            { type: "Heading", props: { id: "h1", title: "A" } },
                            { type: "MysteryBlock", props: { id: "m1" } },
                        ],
                    },
                },
                { type: "Heading", props: { id: "h2", title: "B" } },
            ],
            root: {},
        },
        isSlot: makeSlotResolver(registry),
    });
    return { registry, handle };
}

describe("outlineRows", () => {
    it("pre-orden con profundidad y labels del registry", () => {
        const { registry, handle } = makeHandle();
        const rows = outlineRows(handle.getDoc(), registry);
        expect(rows.map((r) => [r.id, r.depth, r.label])).toEqual([
            ["s1", 0, "Sección"],
            ["h1", 1, "Encabezado"],
            ["m1", 1, "MysteryBlock"], // type desconocido para el catálogo → label = type (fail-soft)
            ["h2", 0, "Encabezado"],
        ]);
    });

    it("glifos: catálogo compartido para tipos conocidos, widgets para el resto", () => {
        const { registry, handle } = makeHandle();
        const rows = outlineRows(handle.getDoc(), registry);
        const byId = Object.fromEntries(rows.map((r) => [r.id, r.ms]));
        expect(byId.s1).toBe("crop_16_9"); // BLOCK_META.Section.ms
        expect(byId.h1).toBe("title"); // BLOCK_META.Heading.ms
        expect(byId.m1).toBe("widgets"); // fallback
    });

    it("se mantiene sincronizado con el documento (insertar/mover cambia las filas)", () => {
        const { registry, handle } = makeHandle();
        handle.transact((tx) => tx.removeNode("h1"));
        const rows = outlineRows(handle.getDoc(), registry);
        expect(rows.map((r) => r.id)).toEqual(["s1", "m1", "h2"]);
    });

    it("documento vacío → sin filas", () => {
        const registry = createBlockRegistry();
        registry.register(defs);
        const handle = createEditor({ initialData: { content: [], root: {} }, isSlot: makeSlotResolver(registry) });
        expect(outlineRows(handle.getDoc(), registry)).toEqual([]);
    });
});
