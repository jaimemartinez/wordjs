/**
 * Presentación del registro de auditoría. Lo que se prueba aquí es sobre todo que NADA de lo que
 * viene del log elige estructura: las etiquetas, los iconos y los tonos salen de listas blancas, y
 * lo desconocido cae en un valor por defecto en vez de colarse en la pantalla.
 */
import { describe, it, expect } from "vitest";
import type { AuditEntry } from "@/lib/api";
import {
    KNOWN_AUDIT_ACTIONS,
    auditActionKey,
    auditActorLabel,
    auditDetailPairs,
    auditDetailSummary,
    auditPageRange,
    auditTargetIcon,
    auditTargetLabel,
    auditTone,
    formatAuditDate,
    isKnownAuditAction,
} from "../auditLogic";

/* ------------------------------------------------------------------ */
/* Acciones: lista blanca.                                             */
/* ------------------------------------------------------------------ */

describe("auditActionKey — lista blanca de acciones", () => {
    it("cada acción conocida tiene su clave i18n", () => {
        for (const action of KNOWN_AUDIT_ACTIONS) {
            expect(auditActionKey(action)).toBe(`audit.action.${action}`);
        }
    });

    it("una acción DESCONOCIDA no inventa clave: devuelve null y la pantalla enseña el crudo", () => {
        expect(auditActionKey("plugin.mio.hizo_algo")).toBeNull();
        expect(auditActionKey("")).toBeNull();
        expect(auditActionKey(null)).toBeNull();
        expect(auditActionKey(42)).toBeNull();
    });

    it("una acción con forma de clave i18n ajena NO se cuela en el diccionario", () => {
        // El peligro concreto: si la clave se construyera sin lista blanca, un `action` escrito por
        // un plugin podría apuntar a CUALQUIER entrada del diccionario.
        expect(isKnownAuditAction("nav.sign.out")).toBe(false);
        expect(auditActionKey("nav.sign.out")).toBeNull();
    });
});

describe("auditTone / auditTargetIcon — mapas cerrados con respaldo", () => {
    it("un borrado de usuario es el tono de peligro", () => {
        expect(auditTone("user.delete")).toBe("danger");
    });

    it("un cambio de rol avisa", () => {
        expect(auditTone("user.role_change")).toBe("warn");
    });

    it("lo desconocido cae en neutral, nunca en una clase arbitraria", () => {
        expect(auditTone("cualquier.cosa")).toBe("neutral");
        expect(auditTone(undefined)).toBe("neutral");
        // Una clave heredada de Object.prototype tampoco se cuela como tono.
        expect(auditTone("constructor")).toBe("neutral");
        expect(auditTone("toString")).toBe("neutral");
    });

    it("el icono sale del mapa, y lo desconocido usa el respaldo", () => {
        expect(auditTargetIcon("user")).toBe("fa-user");
        expect(auditTargetIcon("plugin")).toBe("fa-plug");
        expect(auditTargetIcon("loquesea")).toBe("fa-circle-dot");
        expect(auditTargetIcon("toString")).toBe("fa-circle-dot");
        expect(auditTargetIcon(null)).toBe("fa-circle-dot");
    });
});

/* ------------------------------------------------------------------ */
/* Actor.                                                              */
/* ------------------------------------------------------------------ */

describe("auditActorLabel", () => {
    const names = new Map<number, string>([[7, "Jaime"]]);

    it("actor nulo = acción de SISTEMA, que no es lo mismo que 'no sé quién'", () => {
        expect(auditActorLabel(null, names)).toEqual({ kind: "system", text: "" });
        expect(auditActorLabel(undefined, names)).toEqual({ kind: "system", text: "" });
    });

    it("con nombre conocido lo devuelve", () => {
        expect(auditActorLabel(7, names)).toEqual({ kind: "named", text: "Jaime" });
    });

    it("un usuario ya borrado se queda en el id, que es lo que el log guarda", () => {
        expect(auditActorLabel(99, names)).toEqual({ kind: "unknown", text: "#99" });
    });

    it("sin mapa de nombres (la llamada a /users falló) sigue funcionando", () => {
        expect(auditActorLabel(3)).toEqual({ kind: "unknown", text: "#3" });
    });

    it("el actor 0 no se confunde con «sistema»", () => {
        expect(auditActorLabel(0).kind).toBe("unknown");
    });
});

/* ------------------------------------------------------------------ */
/* Objetivo.                                                           */
/* ------------------------------------------------------------------ */

describe("auditTargetLabel", () => {
    it("un id numérico se presenta con almohadilla", () => {
        expect(auditTargetLabel({ targetType: "user", targetId: "12" })).toBe("user #12");
    });

    it("un slug se presenta tal cual", () => {
        expect(auditTargetLabel({ targetType: "theme", targetId: "twenty" })).toBe("theme twenty");
    });

    it("settings.update no trae id: solo el tipo", () => {
        expect(auditTargetLabel({ targetType: "settings", targetId: "" })).toBe("settings");
    });

    it("una fila sin tipo ni id no revienta", () => {
        expect(auditTargetLabel({ targetType: "", targetId: "" })).toBe("—");
    });
});

/* ------------------------------------------------------------------ */
/* Detalle.                                                            */
/* ------------------------------------------------------------------ */

describe("auditDetailPairs — todo acaba en TEXTO", () => {
    it("aplana escalares", () => {
        expect(auditDetailPairs({ from: "editor", to: "administrator" })).toEqual([
            { key: "from", value: "editor" },
            { key: "to", value: "administrator" },
        ]);
    });

    it("un array de escalares se une con comas", () => {
        expect(auditDetailPairs({ keys: ["blogname", "siteurl"] })).toEqual([{ key: "keys", value: "blogname, siteurl" }]);
    });

    it("números y booleanos se imprimen, no se pierden", () => {
        expect(auditDetailPairs({ count: 0, ok: false })).toEqual([
            { key: "count", value: "0" },
            { key: "ok", value: "false" },
        ]);
    });

    it("un objeto anidado (una fila vieja o de otra versión) se resume, NO se serializa a ciegas", () => {
        expect(auditDetailPairs({ nested: { a: 1 } })).toEqual([{ key: "nested", value: "(objeto)" }]);
    });

    it("un detalle que no es objeto da una lista vacía", () => {
        expect(auditDetailPairs(null)).toEqual([]);
        expect(auditDetailPairs("texto")).toEqual([]);
        expect(auditDetailPairs([1, 2])).toEqual([]);
    });

    it("los valores largos se recortan, y el recorte se ve", () => {
        const [pair] = auditDetailPairs({ nota: "x".repeat(500) });
        expect(pair.value.length).toBeLessThan(500);
        expect(pair.value.endsWith("…")).toBe(true);
    });

    it("una clave con marcado sale como TEXTO, sin interpretarse (React la escapa al pintarla)", () => {
        expect(auditDetailPairs({ "<img src=x>": "<b>hola</b>" })).toEqual([
            { key: "<img src=x>", value: "<b>hola</b>" },
        ]);
    });
});

describe("auditDetailSummary", () => {
    const detail = { a: 1, b: 2, c: 3, d: 4, e: 5 };

    it("enseña las 3 primeras y cuenta el resto", () => {
        const { pairs, rest } = auditDetailSummary(detail);
        expect(pairs.map((p) => p.key)).toEqual(["a", "b", "c"]);
        expect(rest).toBe(2);
    });

    it("sin sobrantes, rest es 0 (nunca negativo)", () => {
        expect(auditDetailSummary({ a: 1 }).rest).toBe(0);
        expect(auditDetailSummary({}).rest).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/* Fecha y paginación.                                                 */
/* ------------------------------------------------------------------ */

describe("formatAuditDate", () => {
    it("el 'YYYY-MM-DD HH:MM:SS' de la BD se lee como UTC, no como hora local", () => {
        const dbValue = "2026-08-17 10:30:00";
        expect(formatAuditDate(dbValue)).toBe(new Date(Date.UTC(2026, 7, 17, 10, 30, 0)).toLocaleString());
    });

    it("un vacío es una raya, no 'Invalid Date'", () => {
        expect(formatAuditDate(null)).toBe("—");
        expect(formatAuditDate("")).toBe("—");
    });

    it("algo impresentable se devuelve tal cual en vez de mentir con una fecha", () => {
        expect(formatAuditDate("no soy una fecha")).toBe("no soy una fecha");
    });
});

describe("auditPageRange", () => {
    it("primera página completa", () => {
        expect(auditPageRange(1, 50, 213)).toEqual({ from: 1, to: 50 });
    });

    it("última página parcial", () => {
        expect(auditPageRange(5, 50, 213)).toEqual({ from: 201, to: 213 });
    });

    it("sin filas, el rango es 0–0 (y no '1–0 de 0')", () => {
        expect(auditPageRange(1, 50, 0)).toEqual({ from: 0, to: 0 });
    });

    it("una página más allá del total no pinta un 'desde' fuera de rango", () => {
        const { from, to } = auditPageRange(99, 50, 3);
        expect(from).toBeLessThanOrEqual(3);
        expect(to).toBe(3);
    });
});

/* ------------------------------------------------------------------ */
/* El tipo de la API sigue encajando con lo que la pantalla consume.   */
/* ------------------------------------------------------------------ */

describe("contrato con AuditEntry", () => {
    it("una entrada real recorre todas las funciones sin destartalarse", () => {
        const entry: AuditEntry = {
            id: 1,
            actorId: 7,
            action: "user.role_change",
            targetType: "user",
            targetId: "12",
            detail: { from: "editor", to: "administrator" },
            createdAt: "2026-08-17 10:30:00",
        };
        expect(auditActionKey(entry.action)).toBe("audit.action.user.role_change");
        expect(auditTone(entry.action)).toBe("warn");
        expect(auditTargetLabel(entry)).toBe("user #12");
        expect(auditDetailPairs(entry.detail)).toHaveLength(2);
    });
});
