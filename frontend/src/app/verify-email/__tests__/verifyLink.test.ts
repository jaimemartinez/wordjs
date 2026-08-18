import { describe, it, expect } from "vitest";
import {
    VERIFY_COPY,
    classifyVerifyFailure,
    markVerifiedHere,
    parseVerifyLink,
    verifiedMarkerKey,
    wasVerifiedHere,
    type VerifyStatus,
} from "../verifyLink";

/**
 * /verify-email es el destino de un enlace que llega por correo, o sea: una URL que puede escribir
 * cualquiera. Lo que se prueba aquí es que ese dato hostil no decide nada más allá de pasar o no
 * una lista blanca, que ningún texto del servidor pueda llegar a la pantalla, y que el estado
 * «ya estaba confirmada» exista de verdad — sin él, el segundo intento con un token de un solo uso
 * (modo estricto de React, recarga, pre-carga del cliente de correo) le diría «enlace inválido» a
 * quien acaba de verificar con éxito.
 */

const apiError = (fields: { code?: string; status?: number; message?: string }) =>
    Object.assign(new Error(fields.message ?? "boom"), fields);

/** sessionStorage de mentira, suficiente para las dos operaciones que se usan. */
function fakeStore(): Storage & { failing?: boolean } {
    const map = new Map<string, string>();
    return {
        get length() { return map.size; },
        clear: () => map.clear(),
        getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        removeItem: (k: string) => { map.delete(k); },
        setItem: (k: string, v: string) => { map.set(k, v); },
    } as Storage;
}

const HEX64 = "a".repeat(64);

describe("parseVerifyLink — lista blanca sobre la query", () => {
    it("acepta el enlace que emite el backend (uid numérico + token de 64 hex)", () => {
        expect(parseVerifyLink("42", HEX64)).toEqual({ uid: 42, token: HEX64 });
    });

    it("recorta espacios de un enlace copiado a mano", () => {
        expect(parseVerifyLink(" 42 ", ` ${HEX64} `)).toEqual({ uid: 42, token: HEX64 });
    });

    it("rechaza todo lo que no sea un uid entero positivo", () => {
        for (const uid of ["", "0", "-1", "1.5", "1e3", "abc", "12 34", "007a", null, undefined]) {
            expect(parseVerifyLink(uid as string | null, HEX64), String(uid)).toBeNull();
        }
    });

    it("acepta el 0 a la izquierda solo si sigue siendo un número (y nunca un uid cero)", () => {
        expect(parseVerifyLink("007", HEX64)).toEqual({ uid: 7, token: HEX64 });
        expect(parseVerifyLink("000", HEX64)).toBeNull();
    });

    it("rechaza tokens con caracteres fuera del alfabeto, vacíos o desmesurados", () => {
        for (const token of ["", "corto", "a b".padEnd(20, "c"), `${HEX64}<script>`, "%3Cscript%3E".padEnd(30, "a"), "a".repeat(257), null, undefined]) {
            expect(parseVerifyLink("42", token as string | null), String(token)).toBeNull();
        }
    });

    it("no deja pasar un uid tan grande que deje de ser un entero seguro", () => {
        expect(parseVerifyLink("999999999999999", HEX64)).not.toBeNull(); // 15 dígitos, aún seguro
        expect(parseVerifyLink("9999999999999999", HEX64)).toBeNull();     // 16 dígitos: fuera del regex
    });
});

describe("classifyVerifyFailure", () => {
    it("el 400 del backend es «enlace inválido/caducado/ya usado»", () => {
        expect(classifyVerifyFailure(apiError({ code: "rest_invalid_verification", status: 400 }))).toBe("invalid");
        expect(classifyVerifyFailure(apiError({ status: 400 }))).toBe("invalid");
        expect(classifyVerifyFailure(apiError({ status: 404 }))).toBe("invalid");
    });

    it("el 429 del limitador de /auth se cuenta aparte", () => {
        expect(classifyVerifyFailure(apiError({ status: 429 }))).toBe("throttled");
    });

    it("un 5xx o una red caída NO se pintan como «tu enlace no vale»", () => {
        expect(classifyVerifyFailure(apiError({ status: 500 }))).toBe("error");
        expect(classifyVerifyFailure(apiError({ status: 502 }))).toBe("error");
        expect(classifyVerifyFailure(new Error("Failed to fetch"))).toBe("error");
        expect(classifyVerifyFailure(null)).toBe("error");
    });
});

describe("la marca local de «ya confirmado aquí»", () => {
    it("va y viene por uid", () => {
        const store = fakeStore();
        expect(wasVerifiedHere(7, store)).toBe(false);
        markVerifiedHere(7, store);
        expect(wasVerifiedHere(7, store)).toBe(true);
        expect(wasVerifiedHere(8, store)).toBe(false);
    });

    it("no guarda el token ni ningún otro secreto — solo el id en la clave", () => {
        const store = fakeStore();
        markVerifiedHere(7, store);
        expect(verifiedMarkerKey(7)).toBe("wjs_email_verified:7");
        expect(store.getItem(verifiedMarkerKey(7))).toBe("1");
        expect(JSON.stringify(store.getItem(verifiedMarkerKey(7)))).not.toContain(HEX64);
    });

    it("sin almacenamiento, o con uno que lanza, la pantalla no se rompe", () => {
        const boom = {
            getItem: () => { throw new Error("SecurityError"); },
            setItem: () => { throw new Error("SecurityError"); },
        };
        expect(wasVerifiedHere(7, null)).toBe(false);
        expect(wasVerifiedHere(7, boom)).toBe(false);
        expect(() => markVerifiedHere(7, null)).not.toThrow();
        expect(() => markVerifiedHere(7, boom)).not.toThrow();
    });
});

describe("VERIFY_COPY", () => {
    const ALL: VerifyStatus[] = ["missing", "verifying", "success", "already", "invalid", "throttled", "error"];

    it("todos los estados tienen copia, así que la pantalla no puede quedarse en blanco", () => {
        for (const status of ALL) {
            const copy = VERIFY_COPY[status];
            expect(copy, status).toBeTruthy();
            expect(copy.title.length, status).toBeGreaterThan(0);
            expect(copy.body.length, status).toBeGreaterThan(0);
            expect(copy.icon.length, status).toBeGreaterThan(0);
        }
    });

    it("solo «confirmando» se queda sin botón: en cualquier otro estado hay salida al login", () => {
        expect(VERIFY_COPY.verifying.action).toBeNull();
        for (const status of ALL.filter((s) => s !== "verifying")) {
            expect(VERIFY_COPY[status].action, status).toBeTruthy();
        }
    });

    it("«enlace inválido» nombra las TRES causas que el backend funde en una sola respuesta", () => {
        const body = VERIFY_COPY.invalid.body.toLowerCase();
        expect(body).toMatch(/caducad/);
        expect(body).toMatch(/usado/);
        expect(body).toMatch(/ninguna cuenta/);
    });

    it("«ya confirmada» y «confirmado» son mensajes distintos — si no, el estado no valdría para nada", () => {
        expect(VERIFY_COPY.already.title).not.toBe(VERIFY_COPY.success.title);
        expect(VERIFY_COPY.already.tone).toBe("ok");
    });
});
