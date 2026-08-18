/**
 * Registro público (/register) — TODA la lógica que no es pintar, extraída del componente.
 *
 * Por qué vive aquí y no dentro de `page.tsx`: este repo no tiene jsdom ni testing-library, así que
 * lo único que se puede probar de verdad es una función pura. La validación de un formulario que
 * está delante de un endpoint SIN AUTENTICAR no es un detalle de presentación — es la copia
 * cliente de una política del servidor — y una copia que se desvía en silencio es peor que no
 * tenerla. De ahí que las constantes de abajo repitan literalmente lo que hace
 * `backend/src/routes/auth.ts` en POST /auth/register:
 *
 *   · contraseña de 8 a 72 caracteres  (rest_invalid_param en ambos extremos)
 *   · correo con la MISMA forma que `EMAIL_FORMAT_RE` de backend/src/core/mailbox.ts, con el mismo
 *     tope de 254 caracteres (RFC 5321) que allí existe para acotar el coste del regex.
 *
 * REGLA DURA: esto NUNCA relaja la política, solo la adelanta. El servidor sigue siendo la
 * autoridad; si algo se cuela, lo rechaza él y `registerErrorMessage` traduce ese rechazo.
 *
 * SEGURIDAD: `registerErrorMessage` mira EXCLUSIVAMENTE el código estable (`err.code`) y el estado
 * HTTP. Nunca devuelve el `message` del servidor: ese texto es contenido remoto y acabaría pintado
 * en la pantalla de un visitante anónimo. Aquí solo salen cadenas escritas en este fichero.
 */

/** Política de contraseña del backend, palabra por palabra. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;

/** Espejo de `EMAIL_FORMAT_RE` (backend/src/core/mailbox.ts): exactamente una arroba y dominio con punto. */
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Espejo de `MAX_EMAIL_LEN`: 254 = máximo de RFC 5321. Acota además el coste del regex anterior. */
const MAX_EMAIL_LEN = 254;

export interface RegisterDraft {
    username: string;
    email: string;
    password: string;
    confirm: string;
    displayName: string;
}

/** Los campos que pueden llevar un error debajo. `displayName` es opcional y no se valida. */
export type RegisterField = "username" | "email" | "password" | "confirm";
export type RegisterErrors = Partial<Record<RegisterField, string>>;

export const EMPTY_DRAFT: RegisterDraft = { username: "", email: "", password: "", confirm: "", displayName: "" };

/** Misma regla de forma que el validador compartido del backend. */
export function isValidEmailAddress(email: string): boolean {
    const s = String(email ?? "").trim().toLowerCase();
    return s.length > 0 && s.length <= MAX_EMAIL_LEN && EMAIL_FORMAT_RE.test(s);
}

/**
 * Errores por campo, en español. Devuelve `{}` cuando el borrador se puede enviar.
 *
 * El nombre de usuario solo se exige NO VACÍO: el backend no impone ningún juego de caracteres
 * (`User.create` únicamente comprueba que exista y que no esté cogido), así que inventarse aquí una
 * regla más estricta rechazaría nombres que el sitio sí acepta.
 */
export function validateRegisterDraft(draft: RegisterDraft): RegisterErrors {
    const errors: RegisterErrors = {};

    if (!String(draft.username ?? "").trim()) {
        errors.username = "Escribe un nombre de usuario.";
    }

    const email = String(draft.email ?? "").trim();
    if (!email) {
        errors.email = "Escribe tu correo electrónico.";
    } else if (!isValidEmailAddress(email)) {
        errors.email = "Ese correo no tiene un formato válido.";
    }

    const password = String(draft.password ?? "");
    if (!password) {
        errors.password = "Escribe una contraseña.";
    } else if (password.length < PASSWORD_MIN) {
        errors.password = `La contraseña debe tener al menos ${PASSWORD_MIN} caracteres.`;
    } else if (password.length > PASSWORD_MAX) {
        errors.password = `La contraseña no puede superar los ${PASSWORD_MAX} caracteres.`;
    }

    // Solo se comprueba la coincidencia si la contraseña en sí es aceptable: enseñar «no coinciden»
    // encima de «es demasiado corta» son dos errores para un único fallo.
    if (!errors.password && String(draft.confirm ?? "") !== password) {
        errors.confirm = "Las dos contraseñas no coinciden.";
    }

    return errors;
}

export function isRegisterDraftValid(draft: RegisterDraft): boolean {
    return Object.keys(validateRegisterDraft(draft)).length === 0;
}

/**
 * El cuerpo exacto que espera `authApi.register`. La contraseña NO se recorta (un espacio final es
 * parte de la contraseña y recortarlo cambiaría la que el usuario cree haber puesto); el correo sí
 * se normaliza igual que hace el modelo al guardarlo, y `displayName` se omite si está vacío para
 * que el backend aplique su propio valor por defecto (el nombre de usuario).
 */
export function registerPayload(draft: RegisterDraft): { username: string; email: string; password: string; displayName?: string } {
    const displayName = String(draft.displayName ?? "").trim();
    return {
        username: String(draft.username ?? "").trim(),
        email: String(draft.email ?? "").trim().toLowerCase(),
        password: String(draft.password ?? ""),
        ...(displayName ? { displayName } : {}),
    };
}

/** ¿El ajuste PÚBLICO `users_can_register` está encendido en la carga de ajustes recibida? */
export function registrationEnabled(settings: Record<string, string> | null | undefined): boolean {
    return String((settings && settings.users_can_register) ?? "") === "1";
}

const GENERIC_ERROR = "No se ha podido crear la cuenta. Inténtalo de nuevo en unos instantes.";
const THROTTLED_ERROR = "Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.";
export const REGISTRATION_DISABLED_MESSAGE =
    "El registro de cuentas está desactivado en este sitio. Ponte en contacto con la administración si necesitas una.";
const INVALID_PARAM_MESSAGE = "Alguno de los datos no es válido. Revisa el correo y la contraseña.";

/**
 * Códigos estables del backend → copia nuestra. Un `Map` y no un objeto: la clave viene de una
 * respuesta remota y un objeto literal contestaría a `__proto__`/`constructor` con algo que no es
 * copia nuestra.
 */
const REGISTER_ERROR_COPY = new Map<string, string>([
    ["rest_cannot_register", REGISTRATION_DISABLED_MESSAGE],
    ["rest_user_exists", "Ya existe una cuenta con ese nombre de usuario o ese correo."],
    ["rest_missing_param", "Faltan datos: hacen falta nombre de usuario, correo y contraseña."],
    ["rest_invalid_param", INVALID_PARAM_MESSAGE],
    ["rest_reserved_mail_domain", "Esa dirección pertenece al dominio de correo del propio sitio y solo puede asignarla la administración. Usa otra dirección."],
]);

/** True cuando el fallo es «el sitio tiene el registro apagado», no «has escrito algo mal». */
export function isRegistrationDisabledError(err: unknown): boolean {
    const e = (err ?? {}) as { code?: unknown };
    return e.code === "rest_cannot_register";
}

/** Mensaje en español para un fallo del POST. Solo mira `code` y `status`; jamás el `message` remoto. */
export function registerErrorMessage(err: unknown): string {
    const e = (err ?? {}) as { code?: unknown; status?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    const known = REGISTER_ERROR_COPY.get(code);
    if (known) return known;

    const status = typeof e.status === "number" ? e.status : 0;
    if (status === 429) return THROTTLED_ERROR;
    if (status === 403) return REGISTRATION_DISABLED_MESSAGE;
    if (status === 400) return INVALID_PARAM_MESSAGE;
    return GENERIC_ERROR;
}

/**
 * Las DOS salidas del registro, que no se pueden confundir (lo advierte el propio `authApi.register`):
 *   · 'verify'    → `verificationRequired: true`, NO hay cookie de sesión. Ir al panel aterrizaría en
 *                   una redirección a login, así que hay que enseñar el aviso de «revisa tu correo».
 *   · 'signed-in' → el backend ya ha puesto la cookie: la cuenta está activa y la sesión abierta.
 */
export type RegisterOutcome = "verify" | "signed-in";
export function registerOutcome(res: { verificationRequired?: boolean } | null | undefined): RegisterOutcome {
    return res && res.verificationRequired === true ? "verify" : "signed-in";
}
