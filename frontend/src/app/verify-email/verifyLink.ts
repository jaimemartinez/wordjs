/**
 * Email confirmation (/verify-email) — the screen's pure logic.
 *
 * WHAT LANDS HERE. The mail `backend/src/routes/auth.ts` sends on registration carries
 * `${siteurl}/verify-email?token=<raw>`: the registration has created nothing yet, and following the
 * link is what creates the account (so there is no user id to put in it). Links sent by earlier versions,
 * for accounts that were created unverified, carry `?uid=<id>&token=<raw>` and still work. This screen
 * is the only consumer of either: it reads the parameters, sends them to POST /auth/verify-email and
 * says what happened. Until it existed, every verification mail led to a 404 and the account could never
 * sign in, because login refuses unverified accounts.
 *
 * SECURITY — the query string is hostile data:
 *   · `uid` and `token` come from the URL, that is, from whoever chooses to write it. Before anything
 *     touches the network they go through a shape WHITELIST (`parseVerifyLink`). Not because garbage in
 *     the POST could do harm — the backend answers the same — but so that nothing from outside decides
 *     which message is shown: the state always comes from the closed set `VerifyStatus`.
 *   · The copy for every state lives in this file. The server's `message` is NEVER rendered.
 *
 * WHY THE 'already' STATE EXISTS: the backend consumes the single-use token, so a second attempt with the
 * same link cannot be told apart from an expired one — both are a 400 `rest_invalid_verification`. And
 * the second attempt is the COMMON case: React's strict mode runs the effect twice, a mail client may
 * prefetch the link, and people reload. Telling someone who has just verified that their link is not
 * valid would be a lie. So the screen leaves a local marker when it verifies, and coming back to the same
 * link counts as "already confirmed" without calling again. The marker is a boolean per user id (or per
 * token fingerprint, for a current link): it never stores the token or any other secret.
 */

/** The CLOSED set of things the screen can say. */
export type VerifyStatus =
    | "missing"    // the link carried no usable uid/token
    | "verifying"  // POST in flight
    | "success"    // confirmed just now
    | "already"    // this browser already confirmed this account with this link
    | "invalid"    // expired, already used or nonexistent (400 from the backend)
    | "unavailable" // valid link, but the username or address was taken since (409 from the backend)
    | "throttled"  // 429 from the /auth limiter
    | "error";     // network down or 5xx

export interface VerifyLink {
    /** Only in links sent for accounts created unverified by earlier versions; null in current links. */
    uid: number | null;
    token: string;
}

/**
 * Shape whitelist.
 *  · uid   → digits only, unsigned, and within the safe-integer range.
 *  · token → `crypto.randomBytes(32).toString('hex')` on the backend, i.e. 64 hex characters. The
 *            base64url alphabet (a superset of hex) is accepted with a wide length range so the screen
 *            does not break if the token size ever changes, but never spaces or other signs.
 */
const UID_RE = /^[0-9]{1,15}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function parseVerifyLink(uidRaw: string | null | undefined, tokenRaw: string | null | undefined): VerifyLink | null {
    const uidText = String(uidRaw ?? "").trim();
    const token = String(tokenRaw ?? "").trim();
    if (!TOKEN_RE.test(token)) return null;
    // The current link carries the token alone. A uid, when present, must still pass its whitelist: a
    // malformed one is a damaged link, not a token-only one.
    if (uidText === "") return { uid: null, token };
    if (!UID_RE.test(uidText)) return null;
    const uid = Number(uidText);
    if (!Number.isSafeInteger(uid) || uid <= 0) return null;
    return { uid, token };
}

/**
 * Maps a failed POST to one of the states. It reads `status`/`code`, never the remote text. Any 4xx other
 * than 429 counts as an invalid link: the backend deliberately answers the same for a bad, an expired and
 * an already consumed token, and that route has no other 4xx.
 */
export function classifyVerifyFailure(err: unknown): "invalid" | "unavailable" | "throttled" | "error" {
    const e = (err ?? {}) as { code?: unknown; status?: unknown };
    if (e.code === "rest_invalid_verification") return "invalid";
    // Only the holder of a VALID link gets this: nothing was reserved while the registration waited, and
    // someone else took the username or the address before it was confirmed.
    if (e.code === "rest_registration_unavailable") return "unavailable";
    const status = typeof e.status === "number" ? e.status : 0;
    if (status === 429) return "throttled";
    if (status >= 400 && status < 500) return "invalid";
    return "error";
}

/** What a marker is kept for: a legacy link's user id, or a current (token-only) link. */
export type VerifyMarkerSubject = number | VerifyLink;

/**
 * A short, non-reversible fingerprint of a token (32-bit FNV-1a, hex). A current link has no user id to
 * key the marker by; the marker must still never hold the token itself (and the token is spent anyway
 * once the marker is written).
 */
function tokenFingerprint(token: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/** The local marker's key. Only the id (or a token fingerprint): never the token, nor anything that could verify again. */
export function verifiedMarkerKey(subject: VerifyMarkerSubject): string {
    if (typeof subject === "number") return `wjs_email_verified:${subject}`;
    if (subject.uid !== null) return `wjs_email_verified:${subject.uid}`;
    return `wjs_email_verified:t:${tokenFingerprint(subject.token)}`;
}

/** Has this browser already confirmed this account? An inaccessible `sessionStorage` counts as "no". */
export function wasVerifiedHere(subject: VerifyMarkerSubject, store: Pick<Storage, "getItem"> | null | undefined): boolean {
    if (!store) return false;
    try {
        return store.getItem(verifiedMarkerKey(subject)) === "1";
    } catch {
        return false; // Safari private mode, blocked third-party storage… never break the screen over this.
    }
}

/** Leaves the marker. If storage fails nothing breaks: only the 'already' state is lost. */
export function markVerifiedHere(subject: VerifyMarkerSubject, store: Pick<Storage, "setItem"> | null | undefined): void {
    if (!store) return;
    try {
        store.setItem(verifiedMarkerKey(subject), "1");
    } catch {
        /* storage unavailable — the verification on the server is done either way */
    }
}

export type VerifyTone = "busy" | "ok" | "warn" | "error";

export interface VerifyCopy {
    /** Font Awesome icon, as on /login and /reset-password. */
    icon: string;
    tone: VerifyTone;
    title: string;
    body: string;
    /** Label of the button that leads to login, or `null` when that step makes no sense yet. */
    action: string | null;
}

/**
 * The copy for every state, in one place. The component only picks by key, so there is no branch through
 * which outside text could slip in.
 *
 * 'invalid' names all THREE possible causes (expired / already used / nonexistent) because the backend
 * deliberately merges them into one answer, and pretending to know which one it is would be making it up.
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
    unavailable: {
        icon: "fa-user-slash",
        tone: "warn",
        title: "Ese nombre o correo ya no está libre",
        body: "El enlace era válido, pero mientras esperaba la confirmación otra cuenta ocupó ese nombre de usuario o esa dirección. No se ha creado nada: vuelve a registrarte con otro nombre de usuario.",
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
