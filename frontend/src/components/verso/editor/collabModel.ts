/**
 * Verso — MODELO PURO de la UI de colaboración (F8.4).
 *
 * Todo lo que la barra de presencia y los bordes remotos deciden vive aquí, sin React y sin DOM:
 * la suite del frontend corre en `node` sin jsdom, así que lo que no sea puro no se puede probar
 * — y la accesibilidad de esto (que nada dependa SOLO del color) es exactamente el tipo de regla
 * que hay que poder afirmar con un test, no mirando una captura.
 *
 * REGLAS AA QUE ESTE MÓDULO MATERIALIZA:
 *  · el color de un participante nunca es su ÚNICA identificación: siempre viaja con iniciales
 *    visibles y un texto accesible con el nombre completo (`memberLabel`);
 *  · el estado del canal nunca es solo un punto de color: tiene glifo propio Y texto
 *    (`statusView`), y el texto es el que se anuncia en el `role="status"`;
 *  · el texto sobre el color del avatar se elige por LUMINANCIA (`onColor`), no a ojo, para que el
 *    contraste aguante con los colores que reparta el servidor.
 */

import type { CollabMember, CollabNotice, CollabStatus } from "@/lib/verso/collab";

/* ------------------------------------------------------------------ */
/* Identidad visible de un participante                                */
/* ------------------------------------------------------------------ */

/** Iniciales para el avatar: 2 como mucho, en mayúsculas, tolerando nombres raros o vacíos. */
export function initialsOf(name: string): string {
    const parts = String(name ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length === 0) return "?";
    const first = [...parts[0]][0] ?? "";
    const second = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? "") : "";
    return (first + second).toUpperCase();
}

/** Normaliza el color del servidor a `#rrggbb`; lo que no lo sea cae a un gris legible. */
export function safeColor(color: string | null | undefined): string {
    const v = String(color ?? "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
        const [r, g, b] = [...v.slice(1)];
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return "#6b7280";
}

/**
 * Color de texto legible SOBRE `color`, por luminancia relativa (WCAG). Blanco sobre un amarillo
 * claro es exactamente el fallo de contraste que un avatar de colores aleatorios provoca solo.
 */
export function onColor(color: string): "#ffffff" | "#111827" {
    const hex = safeColor(color);
    const channel = (i: number): number => {
        const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const l = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    // Umbral por contraste real contra blanco (1.05/(L+0.05)) y contra negro ((L+0.05)/0.05).
    return l > 0.179 ? "#111827" : "#ffffff";
}

/** Texto accesible de un avatar: el color no dice nada a quien no lo ve. */
export function memberLabel(member: Pick<CollabMember, "name" | "sel">): string {
    const name = String(member.name || "").trim() || "Alguien";
    return member.sel?.nodeId ? `${name} — editando un bloque` : `${name} — en la página`;
}

/* ------------------------------------------------------------------ */
/* Estado del canal                                                    */
/* ------------------------------------------------------------------ */

export interface StatusView {
    /** Glifo de Material Symbols (todos del subset ya vendorizado). */
    icon: string;
    /** Texto CORTO, visible junto al glifo (nunca solo color). */
    text: string;
    /** Texto largo para `title`/`aria-label` — dice qué implica, no solo cómo se llama. */
    detail: string;
    /** Familia de color: la piel la resuelve con tokens, aquí no hay CSS. */
    tone: "live" | "warn" | "off" | "idle";
    /** true ⇒ merece anunciarse por el `role="status"` (un cambio que el autor debe notar). */
    announce: boolean;
}

const STATUS_VIEWS: Record<CollabStatus, StatusView> = {
    off: {
        icon: "cloud_off",
        text: "Solo tú",
        detail: "La edición colaborativa está desactivada en este editor.",
        tone: "idle",
        announce: false,
    },
    connecting: {
        icon: "sync",
        text: "Conectando",
        detail: "Abriendo la sesión colaborativa…",
        tone: "idle",
        announce: false,
    },
    live: {
        icon: "cloud_done",
        text: "En vivo",
        detail: "Sesión colaborativa activa: los cambios se reparten al instante.",
        tone: "live",
        announce: true,
    },
    degraded: {
        // `info`, no `warning`: el subset de Material Symbols del editor (161 glifos, blueprint §c)
        // no trae `warning`, y un glifo ausente se pinta como una CAJA VACÍA. El tono de alerta lo
        // pone el color + el texto "Limitada", que es lo que además funciona sin ver el color.
        icon: "info",
        text: "Limitada",
        detail:
            "La sesión es muy larga y el registro de cambios se ha llenado: guarda y recarga la página para poder reconectar sin perder nada.",
        tone: "warn",
        announce: true,
    },
    offline: {
        icon: "cloud_off",
        text: "Sin conexión",
        detail: "Se perdió el canal en vivo. Sigues editando en local y tus cambios se guardan al pulsar Guardar.",
        tone: "off",
        announce: true,
    },
};

/**
 * `degraded` NO tiene una sola causa, y el `detail` es lo ÚNICO que queda en pantalla cuando el
 * autor descarta el aviso: si miente, miente para siempre.
 *
 * El cliente pone `degraded` en tres sitios distintos (`collab/client.ts`): el registro de la
 * sesión se llenó (`log-full`), la sala se reinició (`epoch-reset`/`identity-reset`) y —la que
 * destapó esta verificación— se agotaron los reintentos de envío porque el servidor no estaba
 * (`store-failed`, `reintenta()`). Con un único texto fijo, el tercer caso se anunciaba como el
 * primero: «el registro se ha llenado: guarda y RECARGA», cuando recargar es justo lo que pierde
 * los cambios que no se enviaron. El aviso (toast) ya decía la verdad; el chip no.
 *
 * Solo se especializan las causas que cambian QUÉ hacer. Lo demás cae al texto de siempre.
 */
const DEGRADED_DETAIL: Partial<Record<CollabNotice["code"], string>> = {
    "store-failed":
        "Hay cambios tuyos que el servidor no ha aceptado: siguen en esta página y se conservan al pulsar Guardar.",
    "epoch-reset":
        "La sesión colaborativa se reinició: revisa el documento antes de seguir, puede faltar algo que no llegó a enviarse.",
    "identity-reset":
        "La sesión colaborativa se reinició: revisa el documento antes de seguir, puede faltar algo que no llegó a enviarse.",
};

export function statusView(status: CollabStatus, cause?: CollabNotice["code"] | null): StatusView {
    const base = STATUS_VIEWS[status] ?? STATUS_VIEWS.off;
    if (status !== "degraded" || !cause) return base;
    const detail = DEGRADED_DETAIL[cause];
    return detail ? { ...base, detail } : base;
}

/**
 * ¿El aviso obliga a hacer algo (guardar/recargar) o solo informa? Los que obligan se pintan como
 * alerta y no se auto-descartan; los informativos son un apunte.
 */
export function noticeSeverity(notice: Pick<CollabNotice, "code">): "info" | "action" {
    switch (notice.code) {
        case "reconnected":
            return "info";
        case "rate-limited":
            return "info";
        default:
            return "action";
    }
}

/* ------------------------------------------------------------------ */
/* Selecciones remotas sobre el canvas                                 */
/* ------------------------------------------------------------------ */

export interface RemoteBlockSelection {
    siteId: string;
    nodeId: string;
    name: string;
    color: string;
    /** true ⇒ está escribiendo DENTRO del bloque (edición inline), no solo seleccionándolo. */
    editing: boolean;
}

/**
 * Selecciones remotas por bloque, listas para pintar. Dos personas en el mismo bloque salen las
 * dos (el overlay las apila): esconder una sería mentir sobre quién está tocando qué.
 *
 * El orden es ESTABLE (el que trae la lista de miembros, que el servidor ordena por entrada): un
 * orden derivado de un `Map` de iteración cambiante haría bailar las etiquetas en cada frame.
 */
export function remoteSelections(members: readonly CollabMember[]): RemoteBlockSelection[] {
    const out: RemoteBlockSelection[] = [];
    for (const m of members) {
        const nodeId = m?.sel?.nodeId;
        if (typeof nodeId !== "string" || nodeId.length === 0) continue;
        out.push({
            siteId: m.siteId,
            nodeId,
            name: String(m.name || "").trim() || "Alguien",
            color: safeColor(m.color),
            editing: typeof m.sel?.field === "string" && m.sel.field.length > 0,
        });
    }
    return out;
}

/** Agrupa por bloque conservando el orden de llegada. */
export function selectionsByNode(
    selections: readonly RemoteBlockSelection[],
): Map<string, RemoteBlockSelection[]> {
    const map = new Map<string, RemoteBlockSelection[]>();
    for (const sel of selections) {
        const list = map.get(sel.nodeId);
        if (list) list.push(sel);
        else map.set(sel.nodeId, [sel]);
    }
    return map;
}

/**
 * Resumen para el `role="status"` de la barra: quién está y en qué estado va el canal. Es lo que
 * oye un lector de pantalla — de ahí que el estado vaya en TEXTO y no en el color del chip.
 */
export function presenceAnnouncement(status: CollabStatus, members: readonly CollabMember[]): string {
    const view = statusView(status);
    if (members.length === 0) return `${view.text}. Nadie más está editando esta página.`;
    const names = members.map((m) => String(m.name || "").trim() || "Alguien");
    const quienes = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
    return `${view.text}. ${quienes} ${names.length === 1 ? "está editando" : "están editando"} esta página.`;
}
