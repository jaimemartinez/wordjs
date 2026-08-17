/**
 * Verso — tests del modelo PURO del editor de elementos de menú (menuItemsModel.ts).
 *
 * Las operaciones de árbol (subir/bajar/anidar/desanidar) se verifican por su SALIDA: la lista
 * mínima de updates {id, {parent?, order?}} que el editor compone sobre el PUT existente. Entorno
 * node puro, sin DOM (contrato de vitest.config.mts).
 */
import { describe, expect, it } from "vitest";
import {
    indentMenuItem,
    moveMenuItem,
    nextMenuOrder,
    normalizeMenuItems,
    outdentMenuItem,
    siblingsOf,
    type FlatMenuItem,
} from "../menuItemsModel";

/** Fixture canónico: 3 raíces, la 2ª con dos hijos. */
function fixture(): FlatMenuItem[] {
    return [
        { id: 1, title: "Inicio", url: "/", target: "_self", parent: 0, order: 0 },
        { id: 2, title: "Blog", url: "/blog", target: "_self", parent: 0, order: 1 },
        { id: 3, title: "Contacto", url: "/contacto", target: "_self", parent: 0, order: 2 },
        { id: 4, title: "Sub1", url: "/s1", target: "_self", parent: 2, order: 0 },
        { id: 5, title: "Sub2", url: "/s2", target: "_self", parent: 2, order: 1 },
    ];
}

describe("normalizeMenuItems — tolerancia con la respuesta cruda", () => {
    it("mapea la forma toJSON del backend y descarta basura", () => {
        const items = normalizeMenuItems([
            { id: "3", title: "x", url: "/x", target: "_blank", parent: "2", order: "1" },
            { id: 0, title: "sin id" },
            null,
            "nope",
            { title: "sin id tampoco" },
        ]);
        expect(items).toEqual([
            { id: 3, title: "x", url: "/x", target: "_blank", parent: 2, order: 1 },
        ]);
    });

    it("defaults defensivos: target fuera de whitelist → _self; parent/order raros → 0", () => {
        const [item] = normalizeMenuItems([
            { id: 7, title: 42, url: null, target: "evil", parent: -1, order: "NaN" },
        ]);
        expect(item).toEqual({ id: 7, title: "", url: "", target: "_self", parent: 0, order: 0 });
    });

    it("entrada no-array → []", () => {
        expect(normalizeMenuItems(undefined)).toEqual([]);
        expect(normalizeMenuItems({})).toEqual([]);
    });
});

describe("siblingsOf / nextMenuOrder", () => {
    it("hermanos en orden visual y el order del próximo alta al final", () => {
        expect(siblingsOf(fixture(), 0).map((it) => it.id)).toEqual([1, 2, 3]);
        expect(siblingsOf(fixture(), 2).map((it) => it.id)).toEqual([4, 5]);
        expect(nextMenuOrder(fixture(), 0)).toBe(3);
        expect(nextMenuOrder(fixture(), 2)).toBe(2);
        expect(nextMenuOrder(fixture(), 999)).toBe(0);
    });
});

describe("moveMenuItem — subir/bajar entre hermanos", () => {
    it("subir un elemento intermedio intercambia con el anterior (updates mínimos)", () => {
        expect(moveMenuItem(fixture(), 3, -1)).toEqual([
            { id: 3, data: { order: 1 } },
            { id: 2, data: { order: 2 } },
        ]);
    });

    it("bajar dentro de un grupo anidado", () => {
        expect(moveMenuItem(fixture(), 4, 1)).toEqual([
            { id: 5, data: { order: 0 } },
            { id: 4, data: { order: 1 } },
        ]);
    });

    it("bordes: primero hacia arriba y último hacia abajo son no-ops explícitos", () => {
        expect(moveMenuItem(fixture(), 1, -1)).toEqual([]);
        expect(moveMenuItem(fixture(), 3, 1)).toEqual([]);
        expect(moveMenuItem(fixture(), 999, 1)).toEqual([]);
    });

    it("orders con huecos (5,7,9) se renumeran contiguos 0..n-1 al mover", () => {
        const gapped: FlatMenuItem[] = [
            { id: 1, title: "a", url: "", target: "_self", parent: 0, order: 5 },
            { id: 2, title: "b", url: "", target: "_self", parent: 0, order: 7 },
            { id: 3, title: "c", url: "", target: "_self", parent: 0, order: 9 },
        ];
        expect(moveMenuItem(gapped, 2, 1)).toEqual([
            { id: 1, data: { order: 0 } },
            { id: 3, data: { order: 1 } },
            { id: 2, data: { order: 2 } },
        ]);
    });
});

describe("indentMenuItem — anidar bajo el hermano anterior", () => {
    it("el primero del grupo no tiene bajo quién anidar → []", () => {
        expect(indentMenuItem(fixture(), 1)).toEqual([]);
        expect(indentMenuItem(fixture(), 4)).toEqual([]);
    });

    it("pasa a ser ÚLTIMO hijo del hermano anterior; el grupo viejo queda contiguo", () => {
        // 3 (raíz, tras 2) → hijo de 2, detrás de sus hijos 4 y 5. Su order viejo (2) coincide con
        // la posición nueva, así que el update mínimo es SOLO el parent — exactamente lo que se
        // quiere mandar a la API.
        expect(indentMenuItem(fixture(), 3)).toEqual([
            { id: 3, data: { parent: 2 } },
        ]);
    });

    it("al anidar un elemento intermedio, los hermanos que quedan se renumeran", () => {
        // 2 se anida bajo 1; 3 (order 2) debe bajar a order 1.
        expect(indentMenuItem(fixture(), 2)).toEqual([
            { id: 2, data: { parent: 1, order: 0 } },
            { id: 3, data: { order: 1 } },
        ]);
    });
});

describe("outdentMenuItem — sacar un nivel, como hermano posterior de su padre", () => {
    it("en la raíz no hay a dónde salir → []", () => {
        expect(outdentMenuItem(fixture(), 2)).toEqual([]);
    });

    it("se inserta justo DETRÁS de su padre y desplaza a los siguientes", () => {
        // 5 sale de 2 → raíz [1, 2, 5, 3]; 4 queda único hijo de 2 con order 0 (sin update).
        expect(outdentMenuItem(fixture(), 5)).toEqual([
            { id: 5, data: { parent: 0, order: 2 } },
            { id: 3, data: { order: 3 } },
        ]);
    });

    it("al salir el primero, el hermano que queda se renumera", () => {
        // 4 sale de 2 → raíz [1, 2, 4, 3]; 5 (order 1) baja a order 0.
        expect(outdentMenuItem(fixture(), 4)).toEqual([
            { id: 4, data: { parent: 0, order: 2 } },
            { id: 3, data: { order: 3 } },
            { id: 5, data: { order: 0 } },
        ]);
    });

    it("cadena malformada (parent inexistente): se promociona al final de la raíz, nunca revienta", () => {
        const items = [...fixture(),
            { id: 9, title: "huérfano", url: "", target: "_self", parent: 99, order: 0 },
        ];
        expect(outdentMenuItem(items, 9)).toEqual([
            { id: 9, data: { parent: 0, order: 3 } },
        ]);
    });
});
