import { describe, it, expect } from "vitest";
import { boolSetting } from "../page";

/**
 * Los interruptores de Ajustes leen su valor de un payload donde una opción que EXISTE pero nunca se
 * ha escrito llega como `null` (la ruta hace `getOption(key)` para toda la lista y mete el resultado
 * tal cual). Con el `!== undefined` que había antes, ese `null` se convertía en la cadena `"null"`:
 * el interruptor se pintaba apagado aunque su defecto fuera encendido, y el primer «Guardar»
 * persistía el literal `"null"`.
 *
 * Es la MISMA familia de defecto que el de esta tanda — un interruptor que miente sobre lo que hay
 * guardado —, así que se fija aquí en vez de dejarlo a la vista.
 */
describe("boolSetting", () => {
    it("un valor ausente cae en su defecto, no en la cadena 'null'", () => {
        for (const missing of [undefined, null, ""]) {
            expect(boolSetting(missing, "1"), String(missing)).toBe("1");
            expect(boolSetting(missing, "0"), String(missing)).toBe("0");
            expect(boolSetting(missing, "0"), String(missing)).not.toBe("null");
        }
    });

    it("respeta lo que sí hay guardado, venga como cadena o como número", () => {
        expect(boolSetting("1", "0")).toBe("1");
        expect(boolSetting("0", "1")).toBe("0");
        // El backend devuelve los enteros de SQLite sin convertir.
        expect(boolSetting(1, "0")).toBe("1");
        expect(boolSetting(0, "1")).toBe("0");
    });

    it("nunca inventa un encendido: cualquier otra cosa se queda tal cual y el interruptor la lee como apagada", () => {
        expect(boolSetting("nonsense", "1")).toBe("nonsense");
        expect(boolSetting("nonsense", "1")).not.toBe("1");
    });
});
