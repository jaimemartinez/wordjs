/**
 * Verso Lab — tests de los fixtures del banco (lab/labFixtures.ts). ENTORNO:
 * node. Verifican el contrato del encargo F2: generación DETERMINISTA del
 * fixture 500 (mismo seed ⇒ mismo doc byte a byte), composición exacta de
 * tipos, profundidad máxima de contenedor = 3, y que el doc de 30 sigue
 * intacto (es el default del lab).
 */
import { describe, expect, it } from "vitest";
import { toNormalized } from "@/lib/verso/normalize";
import type { SlotResolver } from "@/lib/verso/types";
import type { VersoItem } from "@/lib/verso/types";
import {
    FIXTURE_500_COUNTS,
    makeFixture500,
    makeFixtureData,
    makeLabData,
} from "../labFixtures";

const CONTAINER_TYPES = new Set(["Section", "Grid"]);

/** Mismo resolutor que el registry del lab: children es slot en Section/Grid. */
const labIsSlot: SlotResolver = (type, propKey) =>
    CONTAINER_TYPES.has(type) ? propKey === "children" : false;

function walk(items: VersoItem[], visit: (item: VersoItem, containerDepth: number) => void, depth = 0): void {
    for (const item of items) {
        visit(item, depth);
        const children = item.props.children;
        if (Array.isArray(children)) {
            walk(children as VersoItem[], visit, CONTAINER_TYPES.has(item.type) ? depth + 1 : depth);
        }
    }
}

describe("makeFixture500 — determinismo", () => {
    it("mismo seed ⇒ mismo doc byte a byte (JSON.stringify idéntico)", () => {
        expect(JSON.stringify(makeFixture500())).toBe(JSON.stringify(makeFixture500()));
    });

    it("no consume Math.random (determinista aunque Math.random esté saboteado)", () => {
        const original = Math.random;
        const baseline = JSON.stringify(makeFixture500());
        Math.random = () => {
            throw new Error("makeFixture500 no debe usar Math.random");
        };
        try {
            expect(JSON.stringify(makeFixture500())).toBe(baseline);
        } finally {
            Math.random = original;
        }
    });
});

describe("makeFixture500 — composición", () => {
    it("500 bloques exactos con la mezcla 200/125/75/50/50", () => {
        const counts: Record<string, number> = {};
        let total = 0;
        walk(makeFixture500().content, (item) => {
            counts[item.type] = (counts[item.type] ?? 0) + 1;
            total += 1;
        });
        expect(total).toBe(FIXTURE_500_COUNTS.total);
        expect(counts).toEqual({
            Text: FIXTURE_500_COUNTS.Text,
            Heading: FIXTURE_500_COUNTS.Heading,
            Card: FIXTURE_500_COUNTS.Card,
            Section: FIXTURE_500_COUNTS.Section,
            Grid: FIXTURE_500_COUNTS.Grid,
        });
    });

    it("ids únicos y deterministas (f500-<n>)", () => {
        const ids = new Set<string>();
        walk(makeFixture500().content, (item) => {
            expect(item.props.id).toMatch(/^f500-\d+$/);
            ids.add(item.props.id);
        });
        expect(ids.size).toBe(FIXTURE_500_COUNTS.total);
    });

    it("profundidad de contenedor máxima EXACTA 3 (hay nivel 3, no hay nivel 4)", () => {
        let maxContainerDepth = 0;
        walk(makeFixture500().content, (item, depth) => {
            if (CONTAINER_TYPES.has(item.type)) {
                // depth = contenedores por encima; un contenedor a depth 2 es nivel 3.
                maxContainerDepth = Math.max(maxContainerDepth, depth + 1);
            }
        });
        expect(maxContainerDepth).toBe(3);
    });

    it("normaliza limpio: 500 nodos, sin warnings, raíz con contenido", () => {
        const doc = toNormalized(makeFixture500(), labIsSlot);
        expect(Object.keys(doc.nodes).length).toBe(FIXTURE_500_COUNTS.total);
        expect(doc.warnings).toEqual([]);
        expect(doc.rootChildren.length).toBeGreaterThan(0);
    });
});

describe("makeLabData (fixture 30, default)", () => {
    it("sigue siendo el doc histórico (27 bloques reales — el '30' del nombre venía mal contado) y normaliza sin warnings", () => {
        let total = 0;
        walk(makeLabData().content, () => total++);
        expect(total).toBe(27);
        const doc = toNormalized(makeLabData(), labIsSlot);
        expect(Object.keys(doc.nodes).length).toBe(27);
        expect(doc.warnings).toEqual([]);
    });

    it("makeFixtureData despacha por clave: '30' default, '500' el grande", () => {
        expect(JSON.stringify(makeFixtureData("30"))).toBe(JSON.stringify(makeLabData()));
        expect(JSON.stringify(makeFixtureData("500"))).toBe(JSON.stringify(makeFixture500()));
    });
});
