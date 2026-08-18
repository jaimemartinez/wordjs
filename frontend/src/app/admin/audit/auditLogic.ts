/**
 * Lógica PURA del visor del registro de auditoría (/admin/audit).
 *
 * Igual que en /admin/tags: el repo no tiene jsdom, así que lo que decide algo se declara aquí y se
 * prueba en node. Aquí «decidir» es sobre todo PRESENTAR SIN CONFIAR: la fila del log la escribió el
 * backend, pero `action`, `targetType`, `targetId` y las claves de `detail` salen de rutas distintas
 * y, en el caso de `detail`, de datos que un usuario tecleó (un `username`, por ejemplo).
 *
 * REGLAS DE SEGURIDAD DE ESTE MÓDULO:
 *  1. Nada de lo que hay aquí produce marcado. Todo sale como TEXTO, que React escapa al pintarlo.
 *  2. La etiqueta legible de una acción sale de una LISTA BLANCA. Una acción desconocida (un plugin
 *     que audite lo suyo mañana) NO inventa traducción: se enseña el identificador crudo como texto.
 *  3. El icono y el color de una fila también salen de mapas cerrados con un valor por defecto — un
 *     `targetType` inesperado jamás elige clases de CSS ni estructura.
 */

import type { AuditEntry } from "@/lib/api";

/* ------------------------------------------------------------------ */
/* Fecha.                                                              */
/* ------------------------------------------------------------------ */

/**
 * `created_at` llega como el "YYYY-MM-DD HH:MM:SS" de la BD (UTC, sin marca de zona). Se normaliza
 * para que el navegador NO lo lea como hora local; cualquier otra cosa (ISO) se parsea tal cual.
 * Mismo criterio que /admin/forms.
 */
export function formatAuditDate(value: string | null | undefined): string {
    if (!value) return "—";
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

/* ------------------------------------------------------------------ */
/* Acción.                                                             */
/* ------------------------------------------------------------------ */

/**
 * Las acciones que HOY escribe el backend (grep de `recordAudit(` en backend/src): esta es la lista
 * blanca. La clave i18n solo se usa cuando la acción está aquí.
 */
export const KNOWN_AUDIT_ACTIONS = [
    "user.create",
    "user.role_change",
    "user.delete",
    "settings.update",
    "plugin.activate",
    "plugin.deactivate",
    "theme.activate",
    "theme.mods.import",
] as const;

export type KnownAuditAction = (typeof KNOWN_AUDIT_ACTIONS)[number];

const KNOWN_ACTION_SET: ReadonlySet<string> = new Set(KNOWN_AUDIT_ACTIONS);

/** ¿Tenemos etiqueta propia para esta acción? */
export function isKnownAuditAction(action: unknown): action is KnownAuditAction {
    return typeof action === "string" && KNOWN_ACTION_SET.has(action);
}

/**
 * La clave i18n de una acción, o `null` si no está en la lista blanca (quien llama enseña entonces
 * el identificador crudo, como texto).
 */
export function auditActionKey(action: unknown): string | null {
    return isKnownAuditAction(action) ? `audit.action.${action}` : null;
}

/**
 * El «tono» de la fila. Mapa CERRADO: un prefijo desconocido cae en `neutral`, nunca en una clase
 * arbitraria. Se devuelve un token nuestro, no CSS — la traducción a clases vive en la pantalla.
 */
export type AuditTone = "danger" | "warn" | "info" | "neutral";

/**
 * Mapas como `Map`, NO como objeto literal: con un objeto, `ACTION_TONE["constructor"]` devuelve algo
 * de Object.prototype — un valor truthy que se saltaría el respaldo y acabaría en un `className`.
 * Un `Map` solo conoce lo que se le ha metido.
 */
const ACTION_TONE: ReadonlyMap<string, AuditTone> = new Map<string, AuditTone>([
    ["user.delete", "danger"],
    ["user.role_change", "warn"],
    ["user.create", "info"],
    ["settings.update", "info"],
    ["plugin.activate", "info"],
    ["plugin.deactivate", "warn"],
    ["theme.activate", "info"],
    ["theme.mods.import", "info"],
]);

export function auditTone(action: unknown): AuditTone {
    return (typeof action === "string" && ACTION_TONE.get(action)) || "neutral";
}

/** Icono FontAwesome por tipo de objetivo. Mapa CERRADO con respaldo (mismo motivo que arriba). */
const TARGET_ICON: ReadonlyMap<string, string> = new Map([
    ["user", "fa-user"],
    ["settings", "fa-gear"],
    ["plugin", "fa-plug"],
    ["theme", "fa-palette"],
]);

export function auditTargetIcon(targetType: unknown): string {
    return (typeof targetType === "string" && TARGET_ICON.get(targetType)) || "fa-circle-dot";
}

/* ------------------------------------------------------------------ */
/* Actor.                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cómo se nombra al actor. `actorId === null` es una acción de SISTEMA (o no autenticada), y no debe
 * confundirse con «no sé quién es»: quien llama distingue por el `kind`.
 *
 * `names` es el mapa id → nombre que la pantalla saca de /users; cuando el usuario ya no existe (o
 * la lista no se pudo cargar) queda solo el id, que es exactamente lo que el log guarda.
 */
export function auditActorLabel(
    actorId: number | null | undefined,
    names: ReadonlyMap<number, string> = new Map(),
): { kind: "system" | "named" | "unknown"; text: string } {
    if (actorId === null || actorId === undefined) return { kind: "system", text: "" };
    const name = names.get(actorId);
    if (name) return { kind: "named", text: name };
    return { kind: "unknown", text: `#${actorId}` };
}

/* ------------------------------------------------------------------ */
/* Objetivo y detalle.                                                 */
/* ------------------------------------------------------------------ */

/** El objetivo como texto corto: "user #12", "theme twenty", "settings". Nunca marcado. */
export function auditTargetLabel(entry: Pick<AuditEntry, "targetType" | "targetId">): string {
    const type = String(entry.targetType ?? "").trim();
    const id = String(entry.targetId ?? "").trim();
    if (!type) return id || "—";
    if (!id) return type;
    return /^\d+$/.test(id) ? `${type} #${id}` : `${type} ${id}`;
}

/** Un par clave/valor del detalle, ya reducido a texto. */
export interface AuditDetailPair {
    key: string;
    value: string;
}

const DETAIL_VALUE_MAX = 120;

/** Recorta preservando el sentido: el log es para leerlo de un vistazo. */
function clamp(text: string, max = DETAIL_VALUE_MAX): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * `detail` → pares imprimibles.
 *
 * El backend ya lo saneó (sin secretos, solo escalares o arrays de escalares), pero eso es una
 * garantía sobre el CONTENIDO, no sobre el TIPO: una fila vieja, o escrita por otra versión, puede
 * traer cualquier cosa. Aquí se aplana a texto sin excepciones — un objeto anidado se resume como
 * su tipo, jamás se serializa a ciegas ni se interpreta.
 */
export function auditDetailPairs(detail: unknown): AuditDetailPair[] {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
    return Object.entries(detail as Record<string, unknown>).map(([key, raw]) => ({
        key: clamp(String(key), 48),
        value: clamp(stringifyDetailValue(raw)),
    }));
}

function stringifyDetailValue(raw: unknown): string {
    if (raw === null || raw === undefined) return "—";
    if (typeof raw === "string") return raw || "—";
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
    if (Array.isArray(raw)) {
        const parts = raw.filter((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
        return parts.length ? parts.map((v) => String(v)).join(", ") : `(${raw.length})`;
    }
    return "(objeto)";
}

/** Resumen de una línea para la columna compacta: las N primeras claves, con un "+k" si sobran. */
export function auditDetailSummary(detail: unknown, maxPairs = 3): { pairs: AuditDetailPair[]; rest: number } {
    const pairs = auditDetailPairs(detail);
    return { pairs: pairs.slice(0, maxPairs), rest: Math.max(0, pairs.length - maxPairs) };
}

/* ------------------------------------------------------------------ */
/* Paginación.                                                         */
/* ------------------------------------------------------------------ */

/** Rango humano de la página actual ("1–50 de 213"), a partir de los totales que manda el backend. */
export function auditPageRange(page: number, perPage: number, total: number): { from: number; to: number } {
    if (total <= 0) return { from: 0, to: 0 };
    const from = (Math.max(1, page) - 1) * perPage + 1;
    const to = Math.min(total, Math.max(1, page) * perPage);
    return { from: Math.min(from, total), to };
}
