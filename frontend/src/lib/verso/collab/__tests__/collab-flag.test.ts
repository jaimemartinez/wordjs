/**
 * El interruptor de la colaboración (F8.4).
 *
 * Una bandera cuya precedencia no está probada es una bandera que un día no apaga nada. Aquí se
 * fija el orden completo: navegador > despliegue > default.
 */

import { describe, expect, it } from "vitest";
import { COLLAB_DEFAULT_ON, parseFlagValue, resolveCollabEnabled } from "../flag";

describe("parseFlagValue", () => {
    it("entiende las formas habituales de decir sí y no", () => {
        for (const yes of ["1", "on", "true", "yes", "  ON  ", "True"]) expect(parseFlagValue(yes)).toBe(true);
        for (const no of ["0", "off", "false", "no", " OFF "]) expect(parseFlagValue(no)).toBe(false);
    });
    it("lo que no es un sí/no NO opina (y deja decidir al siguiente escalón)", () => {
        expect(parseFlagValue("")).toBeUndefined();
        expect(parseFlagValue("quizá")).toBeUndefined();
        expect(parseFlagValue(null)).toBeUndefined();
        expect(parseFlagValue(undefined)).toBeUndefined();
    });
});

describe("resolveCollabEnabled", () => {
    it("sin nada configurado manda el default del producto", () => {
        expect(resolveCollabEnabled({})).toBe(COLLAB_DEFAULT_ON);
    });

    it("el despliegue pisa el default", () => {
        expect(resolveCollabEnabled({ env: "on", defaultOn: false })).toBe(true);
        expect(resolveCollabEnabled({ env: "off", defaultOn: true })).toBe(false);
    });

    it("el navegador pisa al despliegue — EN LAS DOS DIRECCIONES", () => {
        // Apagar lo que el despliegue encendió: el botón de pánico del autor.
        expect(resolveCollabEnabled({ stored: "off", env: "on", defaultOn: true })).toBe(false);
        // Y encender lo que el despliegue trae apagado: así se prueba hoy, con el default en off.
        expect(resolveCollabEnabled({ stored: "on", env: "off", defaultOn: false })).toBe(true);
    });

    it("un valor guardado ilegible no secuestra la decisión", () => {
        expect(resolveCollabEnabled({ stored: "banana", env: "on", defaultOn: false })).toBe(true);
        expect(resolveCollabEnabled({ stored: "", env: null, defaultOn: true })).toBe(true);
    });

    it("HOY el default es ENCENDIDO (transporte remediado + multinodo + navegador)", () => {
        // Este test es el recordatorio ejecutable de la decisión: la bandera no se mueve sola ni de
        // rebote en un refactor. Cambiarla obliga a cambiar TAMBIÉN la cabecera de flag.ts, que es
        // donde vive el porqué — y donde hay que actualizar qué se verificó y qué no.
        expect(COLLAB_DEFAULT_ON).toBe(true);
        expect(resolveCollabEnabled({})).toBe(true);
    });

    it("apagarla desde el despliegue o desde un navegador sigue ganándole al default", () => {
        // Lo que hace defendible encenderla: se puede apagar sin recompilar, y por eso este par de
        // rutas de escape se comprueba junto a la decisión, no en otro sitio.
        expect(resolveCollabEnabled({ env: "off" })).toBe(false);
        expect(resolveCollabEnabled({ stored: "off", env: "on" })).toBe(false);
    });
});
