import { describe, it, expect } from "vitest";
import {
    EMPTY_DRAFT,
    PASSWORD_MAX,
    PASSWORD_MIN,
    REGISTRATION_DISABLED_MESSAGE,
    isRegisterDraftValid,
    isRegistrationDisabledError,
    isValidEmailAddress,
    registerErrorMessage,
    registerOutcome,
    registerPayload,
    registrationEnabled,
    validateRegisterDraft,
    type RegisterDraft,
} from "../registerForm";

/**
 * El formulario de /register está delante de un endpoint SIN AUTENTICAR cuya política vive en el
 * backend. Lo que se prueba aquí no es «el formulario pinta bien», es que la copia cliente de esa
 * política NO SE HAYA RELAJADO: los dos extremos de la contraseña (8 y 72, exactamente los de
 * backend/src/routes/auth.ts), la misma forma de correo que el validador compartido, y que ningún
 * texto del servidor pueda salir por el mensaje de error.
 */

const draft = (over: Partial<RegisterDraft> = {}): RegisterDraft => ({
    ...EMPTY_DRAFT,
    username: "ana",
    email: "ana@ejemplo.com",
    password: "unaclave123",
    confirm: "unaclave123",
    ...over,
});

const apiError = (fields: { code?: string; status?: number; message?: string }) =>
    Object.assign(new Error(fields.message ?? "boom"), fields);

describe("validateRegisterDraft — la política de contraseña, en sus dos extremos exactos", () => {
    it("acepta un borrador correcto", () => {
        expect(validateRegisterDraft(draft())).toEqual({});
        expect(isRegisterDraftValid(draft())).toBe(true);
    });

    it("rechaza justo por debajo del mínimo y acepta justo en el mínimo", () => {
        const short = "a".repeat(PASSWORD_MIN - 1);
        expect(validateRegisterDraft(draft({ password: short, confirm: short })).password).toBeTruthy();

        const exact = "a".repeat(PASSWORD_MIN);
        expect(validateRegisterDraft(draft({ password: exact, confirm: exact })).password).toBeUndefined();
    });

    it("acepta justo en el máximo y rechaza justo por encima", () => {
        const exact = "a".repeat(PASSWORD_MAX);
        expect(validateRegisterDraft(draft({ password: exact, confirm: exact })).password).toBeUndefined();

        const long = "a".repeat(PASSWORD_MAX + 1);
        expect(validateRegisterDraft(draft({ password: long, confirm: long })).password).toBeTruthy();
    });

    it("exige nombre de usuario y no lo da por bueno solo con espacios", () => {
        expect(validateRegisterDraft(draft({ username: "" })).username).toBeTruthy();
        expect(validateRegisterDraft(draft({ username: "   " })).username).toBeTruthy();
    });

    it("señala que las contraseñas no coinciden — pero solo un error por fallo", () => {
        expect(validateRegisterDraft(draft({ confirm: "otracosa" })).confirm).toBeTruthy();
        // Con una contraseña ya inválida, «no coinciden» sobra: sería un segundo error del mismo fallo.
        const errs = validateRegisterDraft(draft({ password: "corta", confirm: "" }));
        expect(errs.password).toBeTruthy();
        expect(errs.confirm).toBeUndefined();
    });

    it("un borrador vacío señala los tres campos obligatorios y no el opcional", () => {
        const errs = validateRegisterDraft(EMPTY_DRAFT);
        expect(Object.keys(errs).sort()).toEqual(["email", "password", "username"]);
    });
});

describe("isValidEmailAddress — misma forma que EMAIL_FORMAT_RE del backend", () => {
    it("acepta direcciones normales", () => {
        for (const ok of ["a@b.co", "ana.perez@sub.ejemplo.com", "ANA@EJEMPLO.COM"]) {
            expect(isValidEmailAddress(ok), ok).toBe(true);
        }
    });

    it("rechaza lo que el backend rechaza: sin arroba, dos arrobas, sin punto, con espacios", () => {
        for (const bad of ["ana", "ana@ejemplo", "a@gmail.com@acme.example", "an a@ejemplo.com", "@ejemplo.com", "ana@.com"]) {
            expect(isValidEmailAddress(bad), bad).toBe(false);
        }
    });

    it("respeta el tope de 254 caracteres de RFC 5321 (la cota que acota el coste del regex)", () => {
        const local = "a".repeat(254 - "@ejemplo.com".length);
        expect(isValidEmailAddress(`${local}@ejemplo.com`)).toBe(true);
        expect(isValidEmailAddress(`${local}a@ejemplo.com`)).toBe(false);
    });
});

describe("registerPayload", () => {
    it("recorta usuario y correo, normaliza el correo y NO toca la contraseña", () => {
        const body = registerPayload(draft({ username: "  ana  ", email: "  ANA@Ejemplo.COM ", password: " clave con espacio ", confirm: " clave con espacio " }));
        expect(body.username).toBe("ana");
        expect(body.email).toBe("ana@ejemplo.com");
        // Recortar la contraseña cambiaría la que el usuario cree haber escrito.
        expect(body.password).toBe(" clave con espacio ");
    });

    it("omite displayName cuando está vacío para que mande el valor por defecto del backend", () => {
        expect(registerPayload(draft({ displayName: "   " })).displayName).toBeUndefined();
        expect(registerPayload(draft({ displayName: " Ana Pérez " })).displayName).toBe("Ana Pérez");
    });
});

describe("registrationEnabled", () => {
    it("solo la cadena '1' cuenta como encendido", () => {
        expect(registrationEnabled({ users_can_register: "1" })).toBe(true);
        expect(registrationEnabled({ users_can_register: "0" })).toBe(false);
        expect(registrationEnabled({})).toBe(false);
        expect(registrationEnabled(null)).toBe(false);
    });
});

describe("registerErrorMessage — traduce por código, nunca repite al servidor", () => {
    it("mapea los códigos estables que puede devolver POST /auth/register", () => {
        expect(registerErrorMessage(apiError({ code: "rest_cannot_register", status: 403 }))).toBe(REGISTRATION_DISABLED_MESSAGE);
        expect(registerErrorMessage(apiError({ code: "rest_user_exists", status: 400 }))).toMatch(/ya existe/i);
        expect(registerErrorMessage(apiError({ code: "rest_reserved_mail_domain", status: 403 }))).toMatch(/dominio de correo/i);
        expect(registerErrorMessage(apiError({ code: "rest_missing_param", status: 400 }))).toMatch(/faltan datos/i);
    });

    it("cae al estado HTTP cuando no hay código", () => {
        expect(registerErrorMessage(apiError({ status: 429 }))).toMatch(/demasiados intentos/i);
        expect(registerErrorMessage(apiError({ status: 403 }))).toBe(REGISTRATION_DISABLED_MESSAGE);
        expect(registerErrorMessage(apiError({ status: 400 }))).toMatch(/no es válido/i);
        expect(registerErrorMessage(apiError({ status: 500 }))).toMatch(/no se ha podido crear/i);
    });

    it("SEGURIDAD: jamás devuelve el texto que mandó el servidor", () => {
        const hostile = apiError({ status: 400, code: "desconocido", message: "<img src=x onerror=alert(1)> filtrado interno" });
        const shown = registerErrorMessage(hostile);
        expect(shown).not.toContain("<img");
        expect(shown).not.toContain("filtrado interno");
        expect(shown).toMatch(/no es válido/i);
    });

    it("no se le puede sacar copia con una clave del prototipo", () => {
        for (const code of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
            expect(typeof registerErrorMessage(apiError({ code, status: 500 })), code).toBe("string");
            expect(registerErrorMessage(apiError({ code, status: 500 })), code).toMatch(/no se ha podido crear/i);
        }
    });

    it("aguanta un fallo que no es un Error", () => {
        expect(registerErrorMessage(null)).toMatch(/no se ha podido crear/i);
        expect(registerErrorMessage(undefined)).toMatch(/no se ha podido crear/i);
        expect(registerErrorMessage("cadena suelta")).toMatch(/no se ha podido crear/i);
    });
});

describe("isRegistrationDisabledError", () => {
    it("solo el 403 con su código propio manda a la pantalla de «registro cerrado»", () => {
        expect(isRegistrationDisabledError(apiError({ code: "rest_cannot_register", status: 403 }))).toBe(true);
        expect(isRegistrationDisabledError(apiError({ code: "rest_reserved_mail_domain", status: 403 }))).toBe(false);
        expect(isRegistrationDisabledError(apiError({ status: 403 }))).toBe(false);
        expect(isRegistrationDisabledError(null)).toBe(false);
    });
});

describe("registerOutcome — las dos salidas no se pueden confundir", () => {
    it("verificationRequired true ⇒ aviso de correo, porque NO hay cookie de sesión", () => {
        expect(registerOutcome({ verificationRequired: true })).toBe("verify");
    });

    it("cualquier otra respuesta ⇒ sesión abierta", () => {
        expect(registerOutcome({ verificationRequired: false })).toBe("signed-in");
        expect(registerOutcome({})).toBe("signed-in");
        expect(registerOutcome(null)).toBe("signed-in");
    });

    it("un valor que solo es «parecido a true» NO cuenta como verificación pendiente", () => {
        // Si esto se relajase a truthy, un backend que devolviera "0"/"false" mandaría al aviso de
        // correo a alguien que ya tiene la sesión abierta.
        expect(registerOutcome({ verificationRequired: "1" as unknown as boolean })).toBe("signed-in");
    });
});
