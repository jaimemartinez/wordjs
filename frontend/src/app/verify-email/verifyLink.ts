/**
 * Confirmación de correo (/verify-email) — la lógica pura de la pantalla.
 *
 * ¿QUÉ ATERRIZA AQUÍ? El correo que `backend/src/routes/auth.ts` envía al registrarse (línea ~296)
 * lleva un enlace `${siteurl}/verify-email?uid=<id>&token=<raw>`. Esta pantalla es el único
 * consumidor de ese enlace: lee los dos parámetros, los manda a POST /auth/verify-email y cuenta
 * qué ha pasado. Hasta que existió, cada correo de verificación caía en un 404 y la cuenta se
 * quedaba para siempre sin poder entrar, porque el login rechaza las cuentas sin verificar.
 *
 * SEGURIDAD — la query es dato hostil:
 *   · `uid` y `token` vienen de la URL, es decir, de quien quiera escribirla. Antes de tocar la red
 *     pasan por una LISTA BLANCA de forma (`parseVerifyLink`). No es que el POST vaya a hacer daño
 *     con basura — el backend contesta lo mismo —, es que así nada que venga de fuera decide qué
 *     mensaje se pinta: el estado siempre sale del conjunto cerrado `VerifyStatus`.
 *   · La copia de cada estado está en este fichero. NUNCA se pinta el `message` del servidor.
 *
 * POR QUÉ EXISTE EL ESTADO 'already': el backend consume el token de un solo uso, así que un
 * segundo intento con el mismo enlace es indistinguible de uno caducado — los dos son un 400
 * `rest_invalid_verification`. Y el segundo intento es el caso COMÚN: React en modo estricto
 * dispara el efecto dos veces, el cliente de correo puede pre-cargar el enlace y la gente recarga.
 * Decirle «tu enlace no vale» a quien acaba de verificar con éxito sería mentir. Por eso la pantalla
 * deja una marca local por `uid` al verificar, y un regreso a ese mismo enlace se cuenta como
 * «ya estaba confirmada» sin volver a llamar. La marca es un booleano por id de usuario: no guarda
 * el token ni ningún otro secreto.
 */

/** El conjunto CERRADO de cosas que la pantalla puede decir. */
export type VerifyStatus =
    | "missing"    // el enlace no traía uid/token utilizables
    | "verifying"  // POST en vuelo
    | "success"    // confirmada ahora mismo
    | "already"    // este navegador ya confirmó esta cuenta con este enlace
    | "invalid"    // caducado, ya usado o inexistente (400 del backend)
    | "throttled"  // 429 del limitador de /auth
    | "error";     // red caída o 5xx

export interface VerifyLink {
    uid: number;
    token: string;
}

/**
 * Lista blanca de forma.
 *  · uid   → solo dígitos, sin signo, y dentro del entero seguro.
 *  · token → `crypto.randomBytes(32).toString('hex')` en el backend, o sea 64 hex. Se acepta el
 *            alfabeto base64url (superconjunto del hex) con un rango de longitud amplio para no
 *            romperse si algún día cambia el tamaño del token, pero jamás espacios ni signos.
 */
const UID_RE = /^[0-9]{1,15}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function parseVerifyLink(uidRaw: string | null | undefined, tokenRaw: string | null | undefined): VerifyLink | null {
    const uidText = String(uidRaw ?? "").trim();
    const token = String(tokenRaw ?? "").trim();
    if (!UID_RE.test(uidText) || !TOKEN_RE.test(token)) return null;
    const uid = Number(uidText);
    if (!Number.isSafeInteger(uid) || uid <= 0) return null;
    return { uid, token };
}

/**
 * Traduce un fallo del POST a uno de los estados. Mira `status`/`code`, nunca el texto remoto.
 * Cualquier 4xx que no sea 429 se cuenta como enlace inválido: el backend contesta a propósito lo
 * mismo para token malo, caducado y ya consumido, y no hay más 4xx en esa ruta.
 */
export function classifyVerifyFailure(err: unknown): "invalid" | "throttled" | "error" {
    const e = (err ?? {}) as { code?: unknown; status?: unknown };
    if (e.code === "rest_invalid_verification") return "invalid";
    const status = typeof e.status === "number" ? e.status : 0;
    if (status === 429) return "throttled";
    if (status >= 400 && status < 500) return "invalid";
    return "error";
}

/** Clave de la marca local. Solo el id: ni el token ni nada que sirva para volver a verificar. */
export function verifiedMarkerKey(uid: number): string {
    return `wjs_email_verified:${uid}`;
}

/** ¿Este navegador ya confirmó esta cuenta? Un `sessionStorage` inaccesible se cuenta como «no». */
export function wasVerifiedHere(uid: number, store: Pick<Storage, "getItem"> | null | undefined): boolean {
    if (!store) return false;
    try {
        return store.getItem(verifiedMarkerKey(uid)) === "1";
    } catch {
        return false; // Safari en privado, cookies de terceros bloqueadas… nunca romper la pantalla por esto.
    }
}

/** Deja la marca. Si el almacenamiento falla no pasa nada: solo se pierde el estado 'already'. */
export function markVerifiedHere(uid: number, store: Pick<Storage, "setItem"> | null | undefined): void {
    if (!store) return;
    try {
        store.setItem(verifiedMarkerKey(uid), "1");
    } catch {
        /* almacenamiento no disponible — la verificación en el servidor ya está hecha igualmente */
    }
}

export type VerifyTone = "busy" | "ok" | "warn" | "error";

export interface VerifyCopy {
    /** Icono de Font Awesome, igual que en /login y /reset-password. */
    icon: string;
    tone: VerifyTone;
    title: string;
    body: string;
    /** Texto del botón que lleva al login, o `null` cuando ese paso no tiene sentido todavía. */
    action: string | null;
}

/**
 * La copia de cada estado, en un único sitio. El componente solo elige por clave, así que no hay
 * ninguna rama en la que se pueda colar texto de fuera.
 *
 * 'invalid' nombra las TRES causas posibles (caducado / ya usado / inexistente) porque el backend
 * las funde a propósito en una sola respuesta y fingir que sabemos cuál es sería inventárselo.
 */
export const VERIFY_COPY: Record<VerifyStatus, VerifyCopy> = {
    verifying: {
        icon: "fa-spinner fa-spin",
        tone: "busy",
        title: "Confirmando tu correo…",
        body: "Estamos comprobando el enlace. Solo tarda un momento.",
        action: null,
    },
    success: {
        icon: "fa-circle-check",
        tone: "ok",
        title: "Correo confirmado",
        body: "Tu dirección ha quedado verificada y tu cuenta ya está activa. Puedes iniciar sesión.",
        action: "Ir al inicio de sesión",
    },
    already: {
        icon: "fa-circle-check",
        tone: "ok",
        title: "Esta cuenta ya estaba confirmada",
        body: "No hace falta hacer nada más: la dirección ya se había verificado. Puedes iniciar sesión.",
        action: "Ir al inicio de sesión",
    },
    missing: {
        icon: "fa-link-slash",
        tone: "warn",
        title: "Enlace incompleto",
        body: "A esta dirección le faltan datos del enlace de confirmación. Ábrelo directamente desde el correo que recibiste, sin copiarlo a trozos.",
        action: "Ir al inicio de sesión",
    },
    invalid: {
        icon: "fa-triangle-exclamation",
        tone: "warn",
        title: "Este enlace ya no sirve",
        body: "Puede haber caducado (dura 24 horas), haberse usado ya o no corresponder a ninguna cuenta. Si ya confirmaste tu correo antes, prueba a iniciar sesión; si no, pide a la administración del sitio un enlace nuevo.",
        action: "Ir al inicio de sesión",
    },
    throttled: {
        icon: "fa-hourglass-half",
        tone: "warn",
        title: "Demasiados intentos",
        body: "Se han hecho muchas peticiones seguidas desde aquí. Espera unos minutos y vuelve a abrir el enlace del correo.",
        action: "Ir al inicio de sesión",
    },
    error: {
        icon: "fa-plug-circle-exclamation",
        tone: "error",
        title: "No hemos podido confirmarlo",
        body: "No se ha podido contactar con el sitio. Comprueba tu conexión y vuelve a abrir el enlace en unos instantes.",
        action: "Ir al inicio de sesión",
    },
};
